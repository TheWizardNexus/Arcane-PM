import {subscribeCoreClient} from 'arcane-os/core/client';
import {CoreError} from 'arcane-os/core/contracts';
import {createArcaneEventSource} from 'arcane-os/event-manager';
import {observeCodexTaskActivity} from './activity.js';

export {mountConnectionsView} from './view.js';

/** PM owns connection meaning; the installed SDK owns Core transport/lifetime. */
export function createCodexBridge({coreClient, openURL} = {}) {
    const owner = {};
    const events = createArcaneEventSource(owner, {
        source: 'arcane-pm.codex',
        eventTypes: ['arcane-pm.codex.state', 'arcane-pm.codex.notification', 'arcane-pm.codex.request']
    });
    let client = null;
    let state = unavailableState();
    let subscriptions = [];
    let clientLifetime = null;
    let stopInstallation = null;
    let disposed = false;
    const bridgeLifetime = new AbortController();

    function unavailableState(message = 'Codex connection needs the Arcane PM host. Local work remains available.') {
        return {
            state: 'unavailable', connected: false, available: false, message,
            capabilities: {
                listProjects: false, listThreads: false, readThread: false,
                readConversation: false, resumeThread: false, createTask: false,
                continueTask: false, sendHandoff: false, archiveThread: false,
                restoreThread: false, cancelTurn: false, respondToRequest: false,
                deleteThread: false, savedProjectRegistry: false, openThread: true,
                readDirectory: false, readFile: false, getFileMetadata: false
            },
            observedAt: null
        };
    }

    function publishState(next) {
        if (disposed) return;
        state = next;
        events.dispatch('arcane-pm.codex.state', state);
    }

    function releaseSubscriptions() {
        for (const stop of subscriptions) stop();
        subscriptions = [];
        clientLifetime?.abort();
        clientLifetime = null;
    }

    function isCurrent(active) {
        return !disposed && active !== null && active === client;
    }

    function observeInstallation({client: next, reason, error}) {
        if (error) console.error('Arcane PM Core transport failed', error);
        attachClient(next, reason);
    }

    function attachClient(next, reason = 'current') {
        if (disposed) return null;
        if (next === client) return client;
        releaseSubscriptions();
        client = next;
        if (!client) {
            const message = reason === 'closed' || reason === 'transport-failed'
                ? 'The Arcane PM host connection closed. Reopen the page to reconnect. Local work remains available.'
                : undefined;
            publishState(unavailableState(message));
            return null;
        }

        publishState(unavailableState('Checking the Arcane PM host. Local work remains available.'));
        const lifetime = new AbortController();
        clientLifetime = lifetime;
        subscriptions.push(
            next.events.on(
                'pm.codex.state',
                function observeConnection(value) {
                    if (isCurrent(next)) publishState(value);
                }
            ),
            next.events.on(
                'pm.codex.notification',
                function observeNotification(value) {
                    if (isCurrent(next)) events.dispatch('arcane-pm.codex.notification', value);
                }
            ),
            next.events.on(
                'pm.codex.request',
                function observeRequest(value) {
                    if (isCurrent(next)) events.dispatch('arcane-pm.codex.request', value);
                }
            ),
            next.events.on(
                'pm.codex.diagnostic',
                function observeDiagnostic(value) {
                    if (isCurrent(next)) console.error('Arcane PM Codex diagnostics', value);
                }
            ),
            next.events.on(
                'core.state',
                function observeCore(value) {
                    if (isCurrent(next) && value.state === 'closed') {
                        publishState(unavailableState('The Arcane PM host connection closed. Local work remains available.'));
                    }
                }
            ),
            next.events.on(
                'core.service.state',
                function observeCodexService(value) {
                    if (!isCurrent(next) || value.name !== 'pm.codex') return;
                    if (value.state === 'failed' || value.state === 'draining' || value.state === 'closed') {
                        if (value.error) console.error('Arcane PM Codex service unavailable', value.error);
                        publishState(unavailableState('The Codex connection service is unavailable. Local work remains available.'));
                    }
                }
            ),
            next.events.when(
                'core.ready',
                function dispatcherReady() {
                    if (!isCurrent(next)) return;
                    // Core waits only for this service. Installation is not
                    // native readiness, and a retired client's reply is stale.
                    refreshStatus({signal: lifetime.signal}, next).catch(
                        function initialStatusFailed(error) {
                            if (!isCurrent(next) || lifetime.signal.aborted) return;
                            console.error('Arcane PM Codex status could not be read', error);
                            publishState(unavailableState('The Codex connection service could not be opened. Local work remains available.'));
                        }
                    );
                }
            )
        );
        return client;
    }

    function unavailableResult() {
        return {status: 'unavailable', accepted: false, reason: 'host-unavailable', message: state.message};
    }

    async function invoke(operation, parameters = {}, active = client) {
        const {signal, ...payload} = parameters;
        signal?.throwIfAborted();
        if (!isCurrent(active)) return unavailableResult();
        try {
            return await active.invoke(`pm.codex.${operation}`, payload, {signal, timeoutMs: 0});
        } catch (error) {
            if (error.code === 'METHOD_NOT_ALLOWED' || error.code === 'ARCANE_TRANSPORT_UNAVAILABLE') {
                console.error('Arcane PM Codex host capability unavailable', error);
                if (isCurrent(active)) publishState(unavailableState('This Arcane host does not provide the Codex connection. Local work remains available.'));
                if (error.code === 'ARCANE_TRANSPORT_UNAVAILABLE') throwIfMutationOutcomeUnknown(operation, error);
                return unavailableResult();
            }
            throwIfMutationOutcomeUnknown(operation, error);
            throw error;
        }
    }

    function throwIfMutationOutcomeUnknown(operation, error) {
        const mutatesCodex = [
            'resumeThread', 'createTask', 'continueTask', 'sendHandoff',
            'archiveThread', 'restoreThread', 'cancelTurn', 'respondToRequest'
        ].includes(operation);
        // Core may settle cancellation or transport loss before the host reply.
        // A real native response or PM-owned outcome already provides evidence.
        const hostOutcome = typeof error.code === 'string' && error.code.startsWith('PM_CODEX_');
        if (mutatesCodex && !error.response && !hostOutcome) {
            throw new CoreError({
                code: 'PM_CODEX_OUTCOME_UNKNOWN', outcome: 'unknown', operation,
                message: 'The Codex result is unconfirmed. Inspect the destination before sending again.',
                cause: error
            });
        }
    }

    function status() { return state; }

    async function refreshStatus(parameters = {}, active = client) {
        const result = await invoke('status', parameters, active);
        if (isCurrent(active) && result.status !== 'unavailable') publishState(result);
        return state;
    }

    async function connect(parameters = {}) {
        parameters.signal?.throwIfAborted();
        const active = client;
        if (!isCurrent(active)) return unavailableResult();
        publishState({...state, state: 'connecting', message: 'Connecting to Codex…'});
        try {
            const result = await invoke('connect', parameters, active);
            if (isCurrent(active) && result.status !== 'unavailable') publishState(result);
            return result;
        } catch (error) {
            if (isCurrent(active)) {
                publishState({...unavailableState(), available: true, state: 'error', message: 'Codex could not connect. Review the connection details or retry.'});
            }
            throw error;
        }
    }

    async function disconnect(parameters = {}) {
        const active = client;
        const result = await invoke('disconnect', parameters, active);
        if (isCurrent(active) && result.status !== 'unavailable') publishState(result);
        return result;
    }

    function subscribe(listener, {signal, emitCurrent = true} = {}) {
        const stop = events.on('arcane-pm.codex.state', function relayState(event) { listener(event.detail); }, {signal});
        if (emitCurrent && !signal?.aborted) listener(state);
        return stop;
    }

    function observeNotifications(listener, {signal} = {}) {
        return events.on('arcane-pm.codex.notification', function relayNotification(event) { listener(event.detail); }, {signal});
    }

    function observeRequests(listener, {signal} = {}) {
        return events.on('arcane-pm.codex.request', function relayRequest(event) { listener(event.detail); }, {signal});
    }

    function getThreadUrl(threadId) {
        if (typeof threadId !== 'string' || !threadId.trim()) throw new TypeError('A Codex thread ID is required.');
        return `codex://threads/${encodeURIComponent(threadId)}`;
    }

    function openThread({threadId}) {
        const url = getThreadUrl(threadId);
        if (openURL) openURL(url);
        else if (globalThis.location?.assign) globalThis.location.assign(url);
        else return {status: 'unavailable', url, reason: 'navigation-unavailable'};
        return {status: 'requested', url};
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        bridgeLifetime.abort();
        stopInstallation?.();
        releaseSubscriptions();
        events.dispose();
        client = null;
    }

    if (coreClient) attachClient(coreClient);
    else stopInstallation = subscribeCoreClient(observeInstallation);
    const bridge = {
        status, refreshStatus, connect, disconnect, subscribe, observeNotifications, observeRequests,
        getThreadUrl, openThread, dispose,
        observeTaskActivity: function observeTaskActivity(listener, options = {}) {
            const signal = options.signal
                ? AbortSignal.any([bridgeLifetime.signal, options.signal])
                : bridgeLifetime.signal;
            return observeCodexTaskActivity(bridge, listener, {...options, signal});
        },
        listProjects: function listProjects(parameters) { return invoke('listProjects', parameters); },
        listThreads: function listThreads(parameters) { return invoke('listThreads', parameters); },
        readThread: function readThread(parameters) { return invoke('readThread', parameters); },
        readConversation: function readConversation(parameters) { return invoke('readConversation', parameters); },
        readDirectory: function readDirectory(parameters) { return invoke('readDirectory', parameters); },
        readFile: function readFile(parameters) { return invoke('readFile', parameters); },
        getFileMetadata: function getFileMetadata(parameters) { return invoke('getFileMetadata', parameters); },
        resumeThread: function resumeThread(parameters) { return invoke('resumeThread', parameters); },
        createTask: function createTask(parameters) { return invoke('createTask', parameters); },
        continueTask: function continueTask(parameters) { return invoke('continueTask', parameters); },
        sendHandoff: function sendHandoff(parameters) { return invoke('sendHandoff', parameters); },
        archiveThread: function archiveThread(parameters) { return invoke('archiveThread', parameters); },
        restoreThread: function restoreThread(parameters) { return invoke('restoreThread', parameters); },
        cancelTurn: function cancelTurn(parameters) { return invoke('cancelTurn', parameters); },
        respondToRequest: function respondToRequest(parameters) { return invoke('respondToRequest', parameters); }
    };
    return bridge;
}
