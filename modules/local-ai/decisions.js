import {createArcaneEventSource} from 'arcane-os/event-manager';
import {subscribeCoreClient} from 'arcane-os/core/client';

const LAYA_SOURCE = {
    id: 'onnx-community/laya-typed-decisions-ONNX',
    files: [
        {name: 'onnx/model.onnx', url: 'https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/resolve/main/onnx/model.onnx'},
        {name: 'onnx/model.onnx_data', url: 'https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/resolve/main/onnx/model.onnx_data'},
        {name: 'tokenizer.json', url: 'https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/resolve/main/tokenizer.json'},
        {name: 'tokenizer_config.json', url: 'https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/resolve/main/tokenizer_config.json'}
    ]
};

function decisionError(code, message, cause) {
    const error = new Error(message, cause === undefined ? undefined : {cause});
    error.code = code;
    return error;
}

function report(error) {
    console.error('Arcane PM local decision operation failed.', error);
}

/** PM selects Laya and owns preparation; the SDK owns inference and transport. */
export function createPMDecisionController({modelServices, signal, client} = {}) {
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const events = createArcaneEventSource({}, {
        source: 'arcane-pm.decisions', eventTypes: ['arcane-pm.decisions.changed']
    });
    let binding = null;
    let stopInstallation = null;
    let model = null;
    let discoveryError = null;
    let active = null;
    let loading = null;
    let releasing = null;
    let closing = null;
    let closed = false;
    let eventsDisposed = false;
    let loadState = {status: 'idle', busy: false, progress: null, error: null};
    let state = {
        status: 'idle', phase: 'idle', message: 'Compare next steps with the local decision model.',
        taskId: null, requestId: null
    };

    function current() {
        return {
            ...state, model, load: {...loadState},
            available: Boolean(binding) && !discoveryError && !closed, closed
        };
    }

    function publish(changes) {
        if (changes) state = {...state, ...changes};
        if (!eventsDisposed) events.dispatch('arcane-pm.decisions.changed', current());
    }

    function subscribe(listener, {signal: subscriptionSignal} = {}) {
        const stop = events.on('arcane-pm.decisions.changed', function changed(event) {
            listener(event.detail);
        }, {signal: subscriptionSignal});
        try { if (!subscriptionSignal?.aborted) listener(current()); }
        catch (error) { stop(); throw error; }
        return stop;
    }

    function assertOpen() {
        lifetimeSignal.throwIfAborted();
        if (closed) throw decisionError('PM_DECISIONS_CLOSED', 'Local decision preparation is closed.');
    }

    function requireBinding() {
        assertOpen();
        if (!binding) throw decisionError('PM_DECISION_CORE_UNAVAILABLE', 'Connect Arcane Core to compare next steps locally.');
        return binding;
    }

    function matchesSelection(snapshot) {
        return snapshot?.family === 'laya' && snapshot.model === LAYA_SOURCE.id
            && snapshot.revision === 'main' && snapshot.dtype === 'fp32';
    }

    function ready(snapshot) {
        return matchesSelection(snapshot) && snapshot.state === 'ready' && snapshot.loaded === true;
    }

    function acceptModel(selected, snapshot) {
        if (closed || selected !== binding) return;
        selected.revision += 1;
        model = snapshot;
        discoveryError = null;
        publish();
    }

    function acceptCore({client: nextClient, error = null}) {
        if (closed || binding?.client === nextClient) return;
        const previous = binding;
        previous?.controller.abort(error ?? new DOMException('The Arcane Core connection changed.', 'AbortError'));
        previous?.stopState();
        binding = null;
        model = null;
        discoveryError = error;
        if (!nextClient) { publish(); return; }
        const controller = new AbortController();
        const selected = {
            client: nextClient, controller, revision: 0, ownsActivation: false,
            signal: AbortSignal.any([lifetimeSignal, controller.signal]), stopState: null, discovery: null
        };
        binding = selected;
        selected.stopState = nextClient.events.on('pm.decisions.state', function nativeState(snapshot) {
            acceptModel(selected, snapshot);
        });
        selected.discovery = discover(selected);
        selected.discovery.catch(function discoveryFailed(failure) {
            if (selected.signal.aborted || selected !== binding || closed) return;
            discoveryError = failure;
            publish();
            report(failure);
        });
        publish();
    }

    async function discover(selected) {
        await new Promise(function waitForCore(resolve, reject) {
            let stopReady;
            function cleanup() {
                stopReady?.();
                selected.signal.removeEventListener('abort', cancelled);
            }
            function coreReady() { cleanup(); resolve(); }
            function cancelled() { cleanup(); reject(selected.signal.reason); }
            selected.signal.addEventListener('abort', cancelled, {once: true});
            stopReady = selected.client.events.when('core.ready', coreReady);
            if (selected.signal.aborted) cancelled();
        });
        selected.signal.throwIfAborted();
        const revision = selected.revision;
        const snapshot = await selected.client.invoke('pm.decisions.status', {}, {signal: selected.signal, timeoutMs: 0});
        selected.signal.throwIfAborted();
        if (selected === binding && revision === selected.revision) acceptModel(selected, snapshot);
        return snapshot;
    }

    function load({offline = true, signal: requestSignal} = {}) {
        const selected = requireBinding();
        if (loading || releasing) throw decisionError('PM_DECISION_LOADING', 'The decision model is already changing.');
        requestSignal?.throwIfAborted();
        if (ready(model)) return Promise.resolve(model);
        const controller = new AbortController();
        const operation = {
            controller, signal: AbortSignal.any([selected.signal, controller.signal, ...(requestSignal ? [requestSignal] : [])]),
            task: null
        };
        loading = operation;
        loadState = {status: 'preparing', busy: true, progress: null, error: null};
        operation.task = Promise.resolve().then(async function prepareSelectedModel() {
            let projection;
            let failure;
            let result;
            try {
                await new Promise(function awaitDiscovery(resolve, reject) {
                    function cancelled() { reject(operation.signal.reason); }
                    operation.signal.addEventListener('abort', cancelled, {once: true});
                    selected.discovery.then(function discovered(value) {
                        operation.signal.removeEventListener('abort', cancelled);
                        resolve(value);
                    }, function discoveryFailed(error) {
                        operation.signal.removeEventListener('abort', cancelled);
                        reject(error);
                    });
                    if (operation.signal.aborted) cancelled();
                });
                operation.signal.throwIfAborted();
                projection = await modelServices.prepareModelAssets({
                    source: LAYA_SOURCE, workingDirectory: '.arcane/model-working', offline, signal: operation.signal,
                    onProgress(progress) {
                        if (operation.signal.aborted || closed) return;
                        loadState = {...loadState, progress};
                        publish();
                    }
                });
                operation.signal.throwIfAborted();
                loadState = {...loadState, status: 'loading'};
                publish();
                selected.ownsActivation = true;
                result = await selected.client.invoke('pm.decisions.load', {assetProjectionId: projection.id}, {
                    signal: operation.signal, timeoutMs: 0
                });
                operation.signal.throwIfAborted();
                acceptModel(selected, result);
                operation.signal.throwIfAborted();
                if (!ready(result)) throw decisionError('PM_DECISION_NOT_READY', 'The selected decision model did not become ready.');
            } catch (error) {
                failure = error;
            } finally {
                if (projection) {
                    try { await modelServices.releaseModelAssets(projection); }
                    catch (error) {
                        failure = failure ? new AggregateError([failure, error], 'Decision preparation and cleanup failed.') : error;
                    }
                }
                if (!failure && operation.signal.aborted) failure = operation.signal.reason;
                loading = null;
                loadState = {
                    status: failure ? operation.signal.aborted ? 'cancelled' : 'error' : 'ready',
                    busy: false, progress: null, error: failure ?? null
                };
                publish();
            }
            if (failure) throw failure;
            return result;
        });
        operation.task.catch(function loadFailed(error) {
            if (!operation.signal.aborted || error?.name !== 'AbortError') report(error);
        });
        publish();
        return operation.task;
    }

    function cancel() { active?.controller.abort(); }

    function unload({signal: requestSignal} = {}) {
        const selected = requireBinding();
        requestSignal?.throwIfAborted();
        if (releasing) return releasing;
        const acceptedEvaluation = active?.task;
        cancel();
        loading?.controller.abort();
        const acceptedLoad = loading?.task;
        releasing = Promise.resolve().then(async function releaseSelectedModel() {
            // Cleanup is application-owned once accepted, even when a view detaches.
            const outcomes = await Promise.allSettled([
                selected.client.invoke('pm.decisions.unload', {}, {timeoutMs: 0}), acceptedLoad, acceptedEvaluation
            ]);
            const failures = [];
            if (outcomes[0].status === 'fulfilled') {
                selected.ownsActivation = false;
                acceptModel(selected, outcomes[0].value);
            } else failures.push(outcomes[0].reason);
            if (outcomes[1].status === 'rejected' && outcomes[1].reason?.name !== 'AbortError') {
                failures.push(outcomes[1].reason);
            }
            if (failures.length) throw new AggregateError(failures, 'Decision model cleanup could not finish.');
            loadState = {status: 'idle', busy: false, progress: null, error: null};
            publish();
            return outcomes[0].value;
        });
        function released() { releasing = null; }
        releasing.then(released, released);
        releasing.catch(report);
        return releasing;
    }

    function evaluate({taskId = null, rows, runOptions, signal: requestSignal, onDiagnostic} = {}) {
        assertOpen();
        if (active) throw decisionError('PM_DECISION_BUSY', 'A next-step comparison is already running.');
        const controller = new AbortController();
        const selected = binding;
        const operation = {
            id: crypto.randomUUID(), controller, task: null, stopModel: null,
            signal: AbortSignal.any([lifetimeSignal, controller.signal, ...(selected ? [selected.signal] : []), ...(requestSignal ? [requestSignal] : [])])
        };
        active = operation;
        operation.task = Promise.resolve().then(async function compareNextSteps() {
            try {
                assertCurrent();
                if (!selected) throw decisionError('PM_DECISION_CORE_UNAVAILABLE', 'Connect Arcane Core to compare next steps locally.');
                await waitForModel();
                assertCurrent();
                publish({phase: 'evaluating', message: 'Thinking'});
                diagnostic({type: 'request', rows, ...(runOptions === undefined ? {} : {runOptions})});
                assertCurrent();
                const result = await selected.client.invoke('pm.decisions.evaluate', {
                    rows, ...(runOptions === undefined ? {} : {runOptions})
                }, {signal: operation.signal, timeoutMs: 0});
                assertCurrent();
                diagnostic({type: 'response', response: result});
                assertCurrent();
                publish({status: 'complete', phase: 'complete', message: 'Next-step comparison ready.'});
                assertCurrent();
                return result;
            } catch (error) {
                diagnostic({type: 'error', error});
                if (!closed && active === operation) publish({
                    status: operation.signal.aborted ? 'cancelled' : 'error',
                    phase: operation.signal.aborted ? 'cancelled' : 'error',
                    message: operation.signal.aborted ? 'Next-step comparison cancelled.'
                        : 'The comparison could not finish. Your state, question and choices remain available.'
                });
                throw error;
            } finally {
                operation.stopModel?.();
                operation.stopModel = null;
                if (active === operation) active = null;
            }
        });
        // Register ownership without retaining rows or results in UI state.
        operation.task.catch(function reportComparisonFailure(error) {
            if (!operation.signal.aborted || error?.name !== 'AbortError') report(error);
        });
        publish({status: 'Thinking', phase: 'waiting', message: 'Thinking', taskId, requestId: operation.id});
        return operation.task;

        function assertCurrent() {
            operation.signal.throwIfAborted();
            if (closed || active !== operation || selected !== binding) throw new DOMException('The comparison was cancelled.', 'AbortError');
        }

        function diagnostic(value) {
            if (typeof onDiagnostic !== 'function') return;
            try {
                const result = onDiagnostic(value);
                if (result?.catch) result.catch(report);
            } catch (error) { report(error); }
        }

        function waitForModel() {
            return new Promise(function observeSelectedModel(resolve, reject) {
                let started = false;
                function cancelled() { reject(operation.signal.reason); }
                operation.signal.addEventListener('abort', cancelled, {once: true});
                const stop = subscribe(function modelChanged(snapshot) {
                    if (operation.signal.aborted) return;
                    const selectedModel = snapshot.model;
                    if (discoveryError) { reject(discoveryError); return; }
                    if (!snapshot.available) { controller.abort(); return; }
                    if (!selectedModel) return;
                    if (selectedModel.state === 'error') {
                        const error = decisionError('PM_DECISION_MODEL_ERROR', 'The local decision model is unavailable.', selectedModel.error);
                        diagnostic({type: 'model-error', error, model: selectedModel});
                        if (started) controller.abort(error);
                        else reject(error);
                        return;
                    }
                    if (!matchesSelection(selectedModel) || ['unloading', 'disposing', 'disposed'].includes(selectedModel.state)
                        || (started && !ready(selectedModel))) { controller.abort(); return; }
                    if (ready(selectedModel) && !started) { started = true; resolve(); }
                });
                operation.stopModel = function stopModelObservation() {
                    stop();
                    operation.signal.removeEventListener('abort', cancelled);
                };
                if (operation.signal.aborted) cancelled();
            });
        }
    }

    function dispose() {
        if (closing) return closing;
        closed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        const selected = binding;
        const acceptedRelease = releasing;
        const pending = [active?.task, loading?.task, acceptedRelease, selected?.discovery];
        lifetime.abort();
        stopInstallation?.();
        selected?.stopState();
        closing = Promise.resolve().then(async function closeDecisions() {
            const failures = [];
            if (selected?.ownsActivation && !acceptedRelease) {
                try { await selected.client.invoke('pm.decisions.unload', {}, {timeoutMs: 0}); }
                catch (error) { failures.push(error); }
            }
            const outcomes = await Promise.allSettled(pending);
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected' && outcome.reason?.name !== 'AbortError') failures.push(outcome.reason);
            }
            model = null;
            binding = null;
            loadState = {status: 'idle', busy: false, progress: null, error: null};
            publish({status: 'disposed', phase: 'disposed', message: 'Local decision preparation is closed.', taskId: null, requestId: null});
            events.dispose();
            eventsDisposed = true;
            if (failures.length) throw new AggregateError(failures, 'Local decision cleanup could not finish.');
        });
        closing.catch(report);
        return closing;
    }

    if (client) acceptCore({client});
    else stopInstallation = subscribeCoreClient(acceptCore, {signal: lifetimeSignal, emitCurrent: true});
    lifetimeSignal.addEventListener('abort', dispose, {once: true});
    if (lifetimeSignal.aborted) dispose();
    return {current, subscribe, load, unload, evaluate, cancel, dispose};
}
