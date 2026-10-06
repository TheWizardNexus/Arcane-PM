import {getInstalledCoreClient} from 'arcane-os/core/client';
import {CoreError} from 'arcane-os/core/contracts';
import {createArcaneEventSource} from 'arcane-os/event-manager';

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
    let disposed = false;

    function unavailableState(message = 'Codex connection needs the Arcane PM host. Local work remains available.') {
        return {
            state: 'unavailable', connected: false, available: false, message,
            capabilities: {
                listProjects: false, listThreads: false, readThread: false,
                readConversation: false, resumeThread: false, createTask: false,
                continueTask: false, sendHandoff: false, archiveThread: false,
                restoreThread: false, cancelTurn: false, respondToRequest: false,
                deleteThread: false, savedProjectRegistry: false, openThread: true
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
    }

    function attachClient() {
        if (disposed) return null;
        const next = coreClient ?? getInstalledCoreClient();
        if (next === client) return client;
        releaseSubscriptions();
        client = next;
        if (!client) {
            publishState(unavailableState());
            return null;
        }
        subscriptions.push(client.events.on('pm.codex.state', function observeConnection(value) {
            publishState(value);
        }));
        subscriptions.push(client.events.on('pm.codex.notification', function observeNotification(value) {
            events.dispatch('arcane-pm.codex.notification', value);
        }));
        subscriptions.push(client.events.on('pm.codex.request', function observeRequest(value) {
            events.dispatch('arcane-pm.codex.request', value);
        }));
        subscriptions.push(client.events.on('pm.codex.diagnostic', function observeDiagnostic(value) {
            console.error('Arcane PM Codex diagnostics', value);
        }));
        subscriptions.push(client.events.on('core.state', function observeCore(value) {
            if (value.state === 'closed') publishState(unavailableState('The Arcane PM host connection closed. Local work remains available.'));
        }));
        return client;
    }

    function unavailableResult() {
        return {status: 'unavailable', accepted: false, reason: 'host-unavailable', message: state.message};
    }

    async function invoke(operation, parameters = {}) {
        const {signal, ...payload} = parameters;
        signal?.throwIfAborted();
        const active = attachClient();
        if (!active) return unavailableResult();
        try {
            return await active.invoke(`pm.codex.${operation}`, payload, {signal, timeoutMs: 0});
        } catch (error) {
            if (error.code === 'METHOD_NOT_ALLOWED' || error.code === 'ARCANE_TRANSPORT_UNAVAILABLE') {
                console.error('Arcane PM Codex host capability unavailable', error);
                publishState(unavailableState('This Arcane host does not provide the Codex connection. Local work remains available.'));
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

    async function refreshStatus(parameters = {}) {
        const result = await invoke('status', parameters);
        if (result.status !== 'unavailable') publishState(result);
        return state;
    }

    async function connect(parameters = {}) {
        parameters.signal?.throwIfAborted();
        if (!attachClient()) return unavailableResult();
        publishState({...state, state: 'connecting', message: 'Connecting to Codex…'});
        try {
            const result = await invoke('connect', parameters);
            if (result.status !== 'unavailable') publishState(result);
            return result;
        } catch (error) {
            publishState({...unavailableState(), available: true, state: 'error', message: 'Codex could not connect. Review the connection details or retry.'});
            throw error;
        }
    }

    async function disconnect(parameters = {}) {
        const result = await invoke('disconnect', parameters);
        if (result.status !== 'unavailable') publishState(result);
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
        releaseSubscriptions();
        events.dispose();
        client = null;
    }

    attachClient();
    return {
        status, refreshStatus, connect, disconnect, subscribe, observeNotifications, observeRequests,
        getThreadUrl, openThread, dispose,
        listProjects: function listProjects(parameters) { return invoke('listProjects', parameters); },
        listThreads: function listThreads(parameters) { return invoke('listThreads', parameters); },
        readThread: function readThread(parameters) { return invoke('readThread', parameters); },
        readConversation: function readConversation(parameters) { return invoke('readConversation', parameters); },
        resumeThread: function resumeThread(parameters) { return invoke('resumeThread', parameters); },
        createTask: function createTask(parameters) { return invoke('createTask', parameters); },
        continueTask: function continueTask(parameters) { return invoke('continueTask', parameters); },
        sendHandoff: function sendHandoff(parameters) { return invoke('sendHandoff', parameters); },
        archiveThread: function archiveThread(parameters) { return invoke('archiveThread', parameters); },
        restoreThread: function restoreThread(parameters) { return invoke('restoreThread', parameters); },
        cancelTurn: function cancelTurn(parameters) { return invoke('cancelTurn', parameters); },
        respondToRequest: function respondToRequest(parameters) { return invoke('respondToRequest', parameters); }
    };
}
