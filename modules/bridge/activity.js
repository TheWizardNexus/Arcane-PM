/** Observe selected tasks on this Codex server; saved history is not live state. */
export function observeCodexTaskActivity(bridge, listener, {threadIds = [], signal, emitCurrent = true} = {}) {
    const observerId = crypto.randomUUID();
    const lifetime = new AbortController();
    const subscriptions = [];
    let connectionLifetime = new AbortController();
    let connection = describeConnection({});
    let records = new Map();
    let revision = 0;
    let disposed = Boolean(signal?.aborted);
    let initializing = true;

    function describeConnection(state) {
        const identity = state.originIdentity;
        return {
            connected: state.connected === true,
            state: state.state ?? 'unavailable',
            connectionId: state.connectionId ?? null,
            originIdentity: identity ? {
                provider: identity.provider,
                accountId: identity.accountId,
                hostId: identity.hostId
            } : null,
            accountKnown: state.accountKnown === true,
            host: state.host ? {name: state.host.name, processId: state.host.processId} : null
        };
    }

    function sameIdentity(left, right) {
        return left?.provider === right?.provider
            && left?.accountId === right?.accountId
            && left?.hostId === right?.hostId;
    }

    function canObserve() {
        return connection.connected && connection.accountKnown
            && connection.originIdentity?.accountId != null;
    }

    function originFor(threadId) {
        return {
            provider: 'codex',
            accountId: connection.originIdentity?.accountId ?? null,
            hostId: connection.originIdentity?.hostId ?? null,
            threadId
        };
    }

    function newRecord(threadId) {
        return {
            observationId: crypto.randomUUID(),
            threadId, origin: originFor(threadId), status: null, turn: null,
            pending: new Map(), observedAt: null, live: false,
            reason: connection.connected ? 'account-unknown' : 'disconnected',
            version: 0, seeded: false, lifetime: new AbortController()
        };
    }

    function messageFor(record, availability) {
        if (availability === 'disconnected') return 'The Codex connection is unavailable.';
        if (availability === 'unobserved') {
            switch (record.reason) {
                case 'account-unknown': return 'The connected Codex account is not identified.';
                case 'identity-unavailable': return 'This task could not be matched to the current Codex connection.';
                case 'thread-not-loaded': return 'This task is not loaded on the connected Codex server.';
                case 'thread-archived': return 'Codex reported this task archived; live activity is unavailable.';
                case 'thread-deleted': return 'Codex reported this task deleted; live activity is unavailable.';
                case 'read-failed': return 'This task’s current activity could not be read.';
                case 'read-unavailable': return 'This connection cannot read the task’s current activity.';
                case 'connection-changed': return 'This task’s previous Codex connection is no longer observed.';
                default: return 'Waiting for this task’s current activity on the connected Codex server.';
            }
        }
        const pending = Array.from(record.pending.values());
        if (pending.some(function needsApproval(request) { return request.kind === 'approval'; })) {
            return 'This task has a pending approval on the connected Codex server.';
        }
        if (pending.some(function needsInput(request) { return request.kind === 'input'; })) {
            return 'This task has a pending input request on the connected Codex server.';
        }
        if (pending.length) return 'This task has a pending request on the connected Codex server.';
        if (record.status?.type === 'idle') return 'Codex reports this task idle on the connected server.';
        if (record.status?.type === 'systemError') return 'Codex reports an error for this task on the connected server.';
        if (record.status?.type === 'active') {
            if (record.status.activeFlags?.includes('waitingOnApproval')) return 'Codex reports this task waiting for approval.';
            if (record.status.activeFlags?.includes('waitingOnUserInput')) return 'Codex reports this task waiting for input.';
            return 'Codex reports this task active on the connected server.';
        }
        return 'Task activity was observed on this connection; its current native status is unavailable.';
    }

    function publish() {
        if (disposed || (initializing && !emitCurrent)) return;
        const threads = [];
        for (const record of records.values()) {
            const availability = !connection.connected ? 'disconnected' : record.live ? 'observed' : 'unobserved';
            threads.push({
                observationId: record.observationId, observationRevision: record.version,
                origin: {...record.origin}, threadId: record.threadId, availability,
                status: record.status === null ? null : structuredClone(record.status),
                turn: record.turn ? {...record.turn} : null,
                pendingRequests: Array.from(record.pending.values(), function copyRequest(request) { return {...request}; }),
                observedAt: record.observedAt,
                message: messageFor(record, availability),
                coverage: {scope: 'connected-server', live: availability === 'observed', reason: record.reason}
            });
        }
        const snapshot = {
            observerId, revision: ++revision, observedAt: new Date().toISOString(),
            connection: structuredClone(connection), threads
        };
        try {
            listener(snapshot);
        } catch (error) {
            console.error('Arcane PM Codex task activity listener failed', error);
        }
    }

    function requestKind(method) {
        switch (method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
            case 'item/permissions/requestApproval':
            case 'applyPatchApproval':
            case 'execCommandApproval': return 'approval';
            case 'item/tool/requestUserInput':
            case 'mcpServer/elicitation/request': return 'input';
            default: return 'other';
        }
    }

    function markLive(record) {
        if (record.status?.type === 'notLoaded') record.status = null;
        record.live = true;
        record.reason = record.status === null ? 'status-unavailable' : null;
    }

    function reconcilePending(pendingRequests, selectedRecords = records.values()) {
        if (!canObserve()) return;
        const receivedAt = new Date().toISOString();
        const updates = new Map();
        const requestOwners = new Map();
        for (const record of selectedRecords) {
            const update = {record, pending: new Map()};
            updates.set(record.threadId, update);
            for (const requestId of record.pending.keys()) requestOwners.set(requestId, update);
        }
        for (const request of pendingRequests ?? []) {
            const update = request.threadId == null ? requestOwners.get(request.requestId) : updates.get(request.threadId);
            if (!update) continue;
            update.pending.set(request.requestId, {
                requestId: request.requestId, method: request.method, kind: requestKind(request.method)
            });
        }
        for (const {record, pending} of updates.values()) {
            const changed = pending.size !== record.pending.size || Array.from(pending.values()).some(
                function requestChanged(request) { return record.pending.get(request.requestId)?.method !== request.method; }
            );
            if (!changed) continue;
            record.pending = pending;
            record.observedAt = receivedAt;
            record.version++;
            if (pending.size) markLive(record);
        }
    }

    function observeConnection(state) {
        if (disposed) return;
        const next = describeConnection(state);
        const changed = next.connected !== connection.connected
            || next.connectionId !== connection.connectionId
            || next.accountKnown !== connection.accountKnown
            || !sameIdentity(next.originIdentity, connection.originIdentity);
        const previousIdentity = connection.originIdentity;
        connection = next;
        if (changed) {
            connectionLifetime.abort();
            connectionLifetime = new AbortController();
            const observedAt = state.observedAt ?? new Date().toISOString();
            for (const record of records.values()) {
                record.version++;
                record.seeded = false;
                record.status = null;
                record.turn = null;
                record.pending.clear();
                record.live = false;
                record.observedAt = observedAt;
                record.reason = !connection.connected ? 'disconnected'
                    : canObserve() ? 'connection-changed' : 'account-unknown';
            }
            // Consumers must retire the old association before a new identity owns a row.
            if (previousIdentity?.accountId != null && canObserve()) publish();
            if (disposed || connection !== next) return;
            if (canObserve()) {
                for (const record of records.values()) {
                    record.version++;
                    record.origin = originFor(record.threadId);
                    record.observedAt = null;
                    record.reason = 'awaiting-status';
                }
            }
        }
        reconcilePending(state.pendingRequests);
        publish();
        if (disposed || connection !== next || !canObserve()) return;
        for (const record of records.values()) seed(record);
    }

    async function seed(record) {
        if (disposed || record.seeded || records.get(record.threadId) !== record || !canObserve()) return;
        record.seeded = true;
        const version = record.version;
        const identity = {connectionId: connection.connectionId, originIdentity: {...connection.originIdentity}};
        const readSignal = AbortSignal.any([lifetime.signal, connectionLifetime.signal, record.lifetime.signal]);
        function isCurrentRead() {
            return !disposed && !readSignal.aborted && records.get(record.threadId) === record
                && record.version === version && connection.connectionId === identity.connectionId
                && sameIdentity(connection.originIdentity, identity.originIdentity);
        }
        try {
            const result = await bridge.readThread({threadId: record.threadId, signal: readSignal});
            if (!isCurrentRead()) return;
            const observedAt = result.observedAt ?? new Date().toISOString();
            if (!result.identity || result.identity.connectionId !== identity.connectionId
                || !sameIdentity(result.identity.originIdentity, identity.originIdentity)) {
                record.reason = 'identity-unavailable';
                record.live = false;
                record.observedAt = observedAt;
                record.version++;
            } else if (result.status !== 'available' || result.thread?.id !== record.threadId || !result.thread.status) {
                record.reason = 'read-unavailable';
                record.live = false;
                record.observedAt = observedAt;
                record.version++;
            } else {
                applyStatus(record, result.thread.status, observedAt);
            }
            publish();
        } catch (error) {
            if (readSignal.aborted) return;
            console.error('Arcane PM Codex task activity could not be read', {threadId: record.threadId, identity, error});
            if (!isCurrentRead()) return;
            record.reason = 'read-failed';
            record.live = false;
            record.observedAt = new Date().toISOString();
            record.version++;
            publish();
        }
    }

    function applyStatus(record, status, observedAt) {
        record.status = structuredClone(status);
        record.observedAt = observedAt;
        record.version++;
        record.live = status.type !== 'notLoaded';
        record.reason = record.live ? null : 'thread-not-loaded';
        if (!record.live) record.turn = null;
    }

    function observeNotification(frame) {
        if (disposed || !canObserve()) return;
        const params = frame.params;
        const threadId = frame.method === 'thread/started' ? params?.thread?.id : params?.threadId;
        const record = records.get(threadId);
        if (!record) return;
        const receivedAt = new Date().toISOString();
        switch (frame.method) {
            case 'thread/started':
                applyStatus(record, params.thread.status, receivedAt);
                break;
            case 'thread/status/changed':
                applyStatus(record, params.status, receivedAt);
                break;
            case 'thread/closed':
                applyStatus(record, {type: 'notLoaded'}, receivedAt);
                break;
            case 'thread/archived':
            case 'thread/deleted':
                record.status = null;
                record.turn = null;
                record.live = false;
                record.reason = frame.method === 'thread/archived' ? 'thread-archived' : 'thread-deleted';
                record.observedAt = receivedAt;
                record.version++;
                break;
            case 'turn/started':
            case 'turn/completed':
                record.turn = {id: params.turn.id, status: params.turn.status};
                record.observedAt = receivedAt;
                record.version++;
                markLive(record);
                break;
            case 'serverRequest/resolved':
                if (!record.pending.delete(params.requestId)) return;
                record.observedAt = receivedAt;
                record.version++;
                break;
            default: return;
        }
        publish();
    }

    function observeRequest(frame) {
        if (disposed || !canObserve()) return;
        const record = records.get(frame.params?.threadId ?? frame.params?.conversationId);
        if (!record || record.pending.get(frame.id)?.method === frame.method) return;
        record.pending.set(frame.id, {requestId: frame.id, method: frame.method, kind: requestKind(frame.method)});
        record.observedAt = new Date().toISOString();
        record.version++;
        markLive(record);
        publish();
    }

    function setThreadIds(ids) {
        if (disposed) return;
        const selected = new Set(ids);
        const unchanged = selected.size === records.size
            && Array.from(selected).every(function isSelected(threadId) { return records.has(threadId); });
        if (unchanged) return;
        const next = new Map();
        const added = [];
        for (const threadId of selected) {
            const record = records.get(threadId) ?? newRecord(threadId);
            next.set(threadId, record);
            if (!records.has(threadId)) {
                if (canObserve()) record.reason = 'awaiting-status';
                added.push(record);
            }
        }
        for (const record of records.values()) {
            if (!next.has(record.threadId)) record.lifetime.abort();
        }
        records = next;
        reconcilePending(bridge.status().pendingRequests, added);
        publish();
        for (const record of added) seed(record);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        signal?.removeEventListener('abort', dispose);
        lifetime.abort();
        connectionLifetime.abort();
        for (const record of records.values()) record.lifetime.abort();
        for (const stop of subscriptions) stop();
        records.clear();
    }

    if (!disposed) {
        for (const threadId of new Set(threadIds)) records.set(threadId, newRecord(threadId));
        signal?.addEventListener('abort', dispose, {once: true});
        subscriptions.push(bridge.observeNotifications(observeNotification, {signal: lifetime.signal}));
        subscriptions.push(bridge.observeRequests(observeRequest, {signal: lifetime.signal}));
        subscriptions.push(bridge.subscribe(observeConnection, {signal: lifetime.signal, emitCurrent: false}));
        observeConnection(bridge.status());
        initializing = false;
    }
    return {setThreadIds, dispose};
}
