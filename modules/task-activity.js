import {createArcaneEventSource} from 'arcane-os/event-manager';

function sameOrigin(left, right) {
    return left?.provider === 'codex' && right?.provider === 'codex'
        && left.accountId === right.accountId && left.hostId === right.hostId
        && left.threadId === right.threadId;
}

function completeOrigin(origin) {
    return origin?.provider === 'codex'
        && ['accountId', 'hostId', 'threadId'].every(function hasIdentity(field) {
            return typeof origin[field] === 'string' && origin[field].trim();
        });
}

/** Compose native observations with existing PM associations for one page lifetime. */
export function createTaskActivity({pmData, bridge, signal, onError}) {
    const owner = {};
    const events = createArcaneEventSource(owner, {
        source: 'arcane-pm.task-activity', eventTypes: ['arcane-pm.task-activity.changed']
    });
    const lifetime = new AbortController();
    const associations = new Map();
    const byThread = new Map();
    const rowsByThread = new Map();
    const observations = new Map();
    const changedDuringScan = new Set();
    let snapshot = null;
    let observer;
    let indexed = false;
    let disposed = false;

    function publish(taskId = null) {
        if (!disposed) events.dispatch('arcane-pm.task-activity.changed', {taskId});
    }

    function report(error) {
        if (disposed || lifetime.signal.aborted) return;
        console.error('Arcane PM native task activity could not be retained.', error);
        onError?.('Native task activity is unavailable. Saved task details remain available.');
    }

    function setAssociation(taskId, origin) {
        const previous = associations.get(taskId);
        const next = completeOrigin(origin) ? origin : null;
        if ((!previous && !next) || sameOrigin(previous, next)) return false;
        if (previous) {
            const members = byThread.get(previous.threadId);
            members.delete(taskId);
            if (!members.size) byThread.delete(previous.threadId);
        }
        associations.delete(taskId);
        observations.delete(taskId);
        if (next) {
            associations.set(taskId, next);
            if (!byThread.has(next.threadId)) byThread.set(next.threadId, new Set());
            byThread.get(next.threadId).add(taskId);
        }
        publish(taskId);
        return true;
    }

    function selectThreads() {
        if (!indexed || !observer || disposed) return;
        const identity = snapshot?.connection.originIdentity;
        const selected = new Set();
        if (identity) {
            for (const origin of associations.values()) {
                if (origin.accountId === identity.accountId && origin.hostId === identity.hostId) {
                    selected.add(origin.threadId);
                }
            }
        }
        observer.setThreadIds([...selected]);
    }

    function taskChanged(change) {
        if (change.recordType !== 'task') return;
        if (!indexed) changedDuringScan.add(change.id);
        if (!setAssociation(change.id, change.record?.origin)) return;
        selectThreads();
        const origin = associations.get(change.id);
        const row = rowsByThread.get(origin?.threadId);
        if (row) retainTaskRow(change.id, row);
    }

    async function indexAssociations() {
        const initial = await pmData.listNativeTaskAssociations({signal: lifetime.signal});
        if (disposed) return;
        for (const association of initial) {
            if (!changedDuringScan.has(association.taskId)) {
                setAssociation(association.taskId, association.origin);
            }
        }
        indexed = true;
        changedDuringScan.clear();
        selectThreads();
        for (const row of snapshot?.threads || []) retainRow(row);
    }

    function receiveSnapshot(next) {
        if (disposed) return;
        const previous = snapshot;
        snapshot = next;
        if (previous && previous.observerId !== next.observerId) observations.clear();
        const connectionChanged = !previous || previous.observerId !== next.observerId
            || previous.connection.connected !== next.connection.connected
            || previous.connection.connectionId !== next.connection.connectionId
            || previous.connection.accountKnown !== next.connection.accountKnown
            || previous.connection.originIdentity?.provider !== next.connection.originIdentity?.provider
            || previous.connection.originIdentity?.accountId !== next.connection.originIdentity?.accountId
            || previous.connection.originIdentity?.hostId !== next.connection.originIdentity?.hostId;
        rowsByThread.clear();
        // Loss rows retain their own origin even after the connection switches account.
        for (const row of next.threads) {
            rowsByThread.set(row.threadId, row);
            retainRow(row);
        }
        if (connectionChanged) {
            publish();
            selectThreads();
        }
    }

    function retainRow(row) {
        for (const taskId of byThread.get(row.threadId) || []) {
            retainTaskRow(taskId, row);
        }
    }

    function retainTaskRow(taskId, row) {
        const origin = associations.get(taskId);
        if (!sameOrigin(origin, row.origin)) return;
        let work = observations.get(taskId);
        if (!work) {
            work = {taskId, origin, latest: null, pending: null, confirmed: null, running: false};
            observations.set(taskId, work);
        }
        const previous = work.latest;
        if (previous?.observerId === snapshot.observerId
            && previous.row.observationId === row.observationId
            && previous.row.observationRevision === row.observationRevision) return;
        const latest = {row, observerId: snapshot.observerId};
        work.latest = latest;
        // An awaiting-status placeholder has no native observation timestamp to save.
        work.pending = row.observedAt ? latest : null;
        if (!work.pending) return;
        if (!work.running) drain(work);
    }

    async function drain(work) {
        work.running = true;
        try {
            while (!disposed && work.pending && observations.get(work.taskId) === work) {
                const expected = work.pending;
                work.pending = null;
                function isCurrent() {
                    return !disposed && work.latest === expected
                        && observations.get(work.taskId) === work
                        && snapshot?.observerId === expected.observerId
                        && sameOrigin(associations.get(work.taskId), expected.row.origin);
                }
                try {
                    const result = await pmData.applyNativeTaskObservation(work.taskId, expected.row, {
                        signal: lifetime.signal, isCurrent
                    });
                    if (isCurrent() && (result.applied || result.reason === 'unchanged')) {
                        work.confirmed = {observation: expected, activity: result.task.nativeActivity};
                        publish(work.taskId);
                    }
                } catch (error) {
                    report(error);
                }
            }
        } finally {
            work.running = false;
        }
    }

    function current(taskId) {
        const work = observations.get(taskId);
        const confirmed = work?.confirmed;
        const connection = snapshot?.connection;
        const identity = connection?.originIdentity;
        if (!confirmed || !connection?.connected || !identity) return null;
        const row = confirmed.observation.row;
        if (confirmed.observation !== work.latest || row.availability !== 'observed' || !row.coverage.live) return null;
        if (row.origin.accountId !== identity.accountId || row.origin.hostId !== identity.hostId) return null;
        return confirmed.activity;
    }

    function subscribe(listener, {signal: subscriptionSignal, emitCurrent = true} = {}) {
        const stop = events.on('arcane-pm.task-activity.changed', function forwardActivity(occurrence) {
            listener(occurrence.detail);
        }, {signal: subscriptionSignal});
        if (emitCurrent && !subscriptionSignal?.aborted) listener({taskId: null});
        return stop;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        observer?.dispose();
        observer = null;
        snapshot = null;
        observations.clear();
        associations.clear();
        byThread.clear();
        rowsByThread.clear();
        events.dispose();
        signal?.removeEventListener('abort', dispose);
    }

    pmData.subscribe(taskChanged, {signal: lifetime.signal});
    observer = bridge.observeTaskActivity(receiveSnapshot, {signal: lifetime.signal, emitCurrent: true});
    const ready = indexAssociations();
    ready.catch(report);
    signal?.addEventListener('abort', dispose, {once: true});
    if (signal?.aborted) dispose();
    return {current, subscribe, ready, dispose};
}
