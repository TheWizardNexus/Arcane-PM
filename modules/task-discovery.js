/** Keep native discovery at the application lifetime, independent of page rendering. */
export function createTaskDiscovery({pmData, bridge, signal, onStatus} = {}) {
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const operations = new Map();
    let connection = null;
    let connectionLifetime = null;
    let connecting = null;
    let connectIntent = null;
    let closed = lifetimeSignal.aborted;

    function sameConnection(left, right) {
        return left?.connectionId === right?.connectionId
            && left?.originIdentity?.provider === right?.originIdentity?.provider
            && left?.originIdentity?.accountId === right?.originIdentity?.accountId
            && left?.originIdentity?.hostId === right?.originIdentity?.hostId;
    }

    function currentIdentity(state) {
        const origin = state.originIdentity;
        if (!state.connected || !state.accountKnown || !state.connectionId
            || !origin?.accountId || !origin?.hostId) return null;
        return {connectionId: state.connectionId, originIdentity: {...origin}};
    }

    function observeConnection(state) {
        if (closed || lifetimeSignal.aborted) return;
        const next = currentIdentity(state);
        if (!next) {
            connectionLifetime?.abort();
            connectionLifetime = null;
            connection = null;
            operations.clear();
            if (state.state !== 'connecting' && state.state !== 'connected') connectIntent = null;
            return;
        }
        if (!connection || !sameConnection(next, connection)) {
            connectionLifetime?.abort();
            operations.clear();
            connection = next;
            connectionLifetime = new AbortController();
        }
        if (connectIntent && state.state === 'connected') {
            connectIntent = null;
            discoverTasks().catch(reportAutomaticFailure);
        }
    }

    function connectCodex({signal: callerSignal} = {}) {
        lifetimeSignal.throwIfAborted();
        callerSignal?.throwIfAborted();
        if (!connecting) {
            const intent = {};
            connectIntent = intent;
            const task = connectWorkspace(intent);
            connecting = task;
            task.then(releaseConnection, releaseConnection);
            function releaseConnection() {
                if (connecting === task) connecting = null;
            }
        }
        return waitForOperation(connecting, callerSignal);
    }

    async function connectWorkspace(intent) {
        try {
            // Connect returns while native startup continues. This document's
            // intent waits for the observed account/host identity, even if its
            // Connections view closes. Other documents observe without scanning.
            const result = await bridge.connect(
                {signal: lifetimeSignal}
            );
            lifetimeSignal.throwIfAborted();
            if (result.status === 'unavailable' && connectIntent === intent) connectIntent = null;
            return result;
        } catch (error) {
            if (connectIntent === intent) connectIntent = null;
            throw error;
        }
    }

    function reportAutomaticFailure(error) {
        if (closed || lifetimeSignal.aborted || error?.name === 'AbortError') return;
        console.error('Arcane PM native discovery could not finish.', error);
        onStatus?.('Codex discovery could not finish. Use Find Codex tasks in Connections to retry.');
    }

    function discoverTasks({archived = false, signal: callerSignal} = {}) {
        lifetimeSignal.throwIfAborted();
        callerSignal?.throwIfAborted();
        if (closed) throw new DOMException('Task discovery is closed.', 'AbortError');
        if (!connection) return Promise.resolve({
            status: 'unavailable', reason: 'codex-disconnected',
            message: 'Connect Codex to find its tasks.'
        });
        let operation = operations.get(archived);
        if (!operation) {
            const identity = connection;
            const operationSignal = AbortSignal.any([lifetimeSignal, connectionLifetime.signal]);
            operation = {identity, signal: operationSignal, task: null};
            operations.set(archived, operation);
            operation.task = discoverWorkspace(operation, archived);
            operation.task.then(releaseOperation, releaseOperation);
            function releaseOperation() {
                if (operations.get(archived) === operation) operations.delete(archived);
            }
        }
        return waitForOperation(operation.task, callerSignal);
    }

    async function discoverWorkspace(operation, archived) {
        const {signal: operationSignal, identity} = operation;
        onStatus?.('Finding Codex projects and tasks…');
        const result = await bridge.discoverWorkspace({archived, signal: operationSignal});
        operationSignal.throwIfAborted();
        if (result.status === 'unavailable' || result.threads?.status === 'unavailable') {
            onStatus?.(result.message || result.threads.message);
            return result;
        }
        if (!isCurrent()) throw new DOMException('The Codex connection changed.', 'AbortError');
        const mapping = await pmData.syncNativeDiscovery(result, {
            signal: operationSignal, isCurrent, onProgress: showProgress
        });
        operationSignal.throwIfAborted();
        if (!isCurrent()) throw new DOMException('The Codex connection changed.', 'AbortError');
        if (mapping.status === 'unavailable' || mapping.status === 'unassociated') {
            console.info('Arcane PM native discovery could not be associated.', mapping);
            onStatus?.('Codex discovery needs a current account and project association. Review Connections, then retry.');
        } else if (mapping.status !== 'complete') {
            console.info('Arcane PM native discovery has unresolved records.', mapping);
            onStatus?.('The available work has been added. Some projects or tasks remain unresolved in Connections.');
        } else onStatus?.('Codex projects and tasks are available in your team.');
        return result;

        function isCurrent() {
            return !closed && !operationSignal.aborted && connection === identity
                && sameConnection(currentIdentity(bridge.status()), identity)
                && sameConnection(result.threads?.identity, identity);
        }

        function showProgress(progress) {
            if (!isCurrent()) return;
            onStatus?.(`Reading discovered work: ${progress.completed} records processed, ${progress.createdProjects} projects and ${progress.createdTasks} tasks added.`);
        }
    }

    function waitForOperation(task, callerSignal) {
        if (!callerSignal) return task;
        callerSignal.throwIfAborted();
        return new Promise(function observeDiscovery(resolve, reject) {
            function cancelled() {
                reject(callerSignal.reason);
            }
            callerSignal.addEventListener('abort', cancelled, {once: true});
            task.then(function finished(value) {
                callerSignal.removeEventListener('abort', cancelled);
                resolve(value);
            }, function failed(error) {
                callerSignal.removeEventListener('abort', cancelled);
                reject(error);
            });
        });
    }

    function dispose() {
        if (closed) return;
        closed = true;
        connectIntent = null;
        lifetime.abort();
        connectionLifetime?.abort();
        stop();
        operations.clear();
    }

    const stop = bridge.subscribe(observeConnection, {signal: lifetimeSignal, emitCurrent: true});
    return {connectCodex, discoverTasks, dispose};
}
