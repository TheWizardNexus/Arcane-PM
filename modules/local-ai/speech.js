import {createArcaneEventSource} from 'arcane-os/event-manager';
import {createBrowserKokoroProvider, createDbopfsSpeechArtifactStore} from 'arcane-os/ai/browser-speech';

const PROVIDER_ID = 'arcane-pm-kokoro';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';
const STATE_EVENT = 'arcane-pm.speech.changed';

function speechError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function cancelled(error, signal) {
    return error?.name === 'AbortError' || error?.code === 'ARCANE_AI_REQUEST_ABORTED'
        || error?.code === 'ARCANE_AI_OPERATION_SUPERSEDED' || (signal?.aborted && error === signal.reason);
}

function report(error) {
    if (!cancelled(error)) console.error('Arcane PM local speech failed.', error);
}

/** PM selects the voice; the published SDK owns resources, synthesis and cleanup. */
export function createPMSpeechController({getStorage, signal} = {}) {
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any(
        [signal, lifetime.signal]
    ) : lifetime.signal;
    const events = createArcaneEventSource(
        {},
        {source: 'arcane-pm.speech', eventTypes: [STATE_EVENT]}
    );
    let provider = null;
    let loading = null;
    let active = null;
    let releasing = null;
    let closing = null;
    let closed = false;
    let eventsDisposed = false;
    let progress = null;
    let error = null;
    let status = 'idle';
    let message = 'Load the local voice to prepare speech.';

    function current() {
        const model = provider?.status();
        let state = model?.state ?? (error ? 'error' : 'unloaded');
        if (loading) state = 'loading';
        if (releasing) state = 'unloading';
        if (closed) state = status === 'disposed' ? 'disposed' : error ? 'error' : 'disposing';
        return {
            providerId: PROVIDER_ID,
            modelId: MODEL_ID,
            localOnly: true,
            state,
            loaded: !closed && !releasing && model?.state === 'ready' && model.loaded === true,
            busy: Boolean(loading || active || releasing || status === 'closing' || model?.busy),
            status,
            message,
            progress,
            execution: model?.execution ?? {
                requestedDevice: 'wasm', selectedDevice: null, maxConcurrentRequests: 1, activeRequestCount: 0
            },
            defaultVoice: DEFAULT_VOICE,
            voices: provider?.catalog()[0]?.voices ?? [],
            provider: model ?? null,
            error,
            closed
        };
    }

    function publish() {
        if (!eventsDisposed) events.dispatch(STATE_EVENT, current());
    }

    function subscribe(listener, {signal: subscriptionSignal} = {}) {
        const stop = eventsDisposed ? function alreadyDisposed() {} : events.on(
            STATE_EVENT,
            function changed(event) { listener(event.detail); },
            {signal: subscriptionSignal}
        );
        try {
            if (!subscriptionSignal?.aborted) listener(current());
        } catch (failure) {
            stop();
            throw failure;
        }
        return stop;
    }

    function assertOpen() {
        lifetimeSignal.throwIfAborted();
        if (closed) throw speechError('PM_SPEECH_CLOSED', 'Local speech is closed.');
    }

    function operationSignal(controller, requestSignal) {
        return AbortSignal.any(
            [lifetimeSignal, controller.signal, ...(requestSignal ? [requestSignal] : [])]
        );
    }

    function awaitStorage(storage, requestSignal) {
        return new Promise(observeStorage);

        function observeStorage(resolve, reject) {
            function abort() { reject(requestSignal.reason); }
            requestSignal.addEventListener(
                'abort', abort,
                {once: true}
            );
            Promise.resolve(storage).then(
                function ready(value) {
                    requestSignal.removeEventListener('abort', abort);
                    resolve(value);
                },
                function failed(failure) {
                    requestSignal.removeEventListener('abort', abort);
                    reject(failure);
                }
            );
            if (requestSignal.aborted) abort();
        }
    }

    function load({signal: requestSignal} = {}) {
        assertOpen();
        requestSignal?.throwIfAborted();
        if (loading || releasing) throw speechError('PM_SPEECH_LOADING', 'The local voice is already changing.');
        if (current().loaded) return Promise.resolve(current());
        const controller = new AbortController();
        const operation = {controller, signal: operationSignal(controller, requestSignal), task: null};
        loading = operation;
        progress = null;
        error = null;
        if (!active) {
            status = 'Thinking';
            message = 'Preparing the local voice.';
        }
        operation.task = Promise.resolve().then(loadLocalVoice);
        operation.task.catch(reportLoadFailure);
        publish();
        return operation.task;

        function reportLoadFailure(failure) {
            if (!cancelled(failure, operation.signal)) report(failure);
        }

        async function loadLocalVoice() {
            try {
                operation.signal.throwIfAborted();
                if (!provider) {
                    const dbopfs = await awaitStorage(getStorage(), operation.signal);
                    operation.signal.throwIfAborted();
                    const store = createDbopfsSpeechArtifactStore(
                        {dbopfs}
                    );
                    provider = createBrowserKokoroProvider(
                        {
                            id: PROVIDER_ID,
                            model: {
                                id: MODEL_ID,
                                repository: MODEL_ID,
                                revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
                                dtype: 'fp32',
                                defaultVoice: DEFAULT_VOICE
                            },
                            runtime: {
                                adapter: 'kokoro-js',
                                version: '1.2.1',
                                revision: '664c76a704021239ba59c84dcbaa4d3dece01fe9',
                                entry: 'kokoro.web.js',
                                wasmPaths: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/',
                                files: [
                                    {
                                        path: 'kokoro.web.js',
                                        url: 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
                                        mediaType: 'text/javascript'
                                    }
                                ]
                            },
                            store,
                            execution: {device: 'wasm', maxConcurrentRequests: 1}
                        }
                    );
                }
                await provider.load(
                    {
                        role: 'tts',
                        selection: {providerId: PROVIDER_ID, modelId: MODEL_ID, localOnly: true},
                        signal: operation.signal,
                        progress: function voiceLoadProgress(value) {
                            if (loading !== operation || operation.signal.aborted || closed) return;
                            progress = value;
                            publish();
                        }
                    }
                );
                operation.signal.throwIfAborted();
                if (!active) {
                    status = 'ready';
                    message = 'Local voice ready.';
                }
            } catch (failure) {
                if (!closed && !releasing) {
                    error = cancelled(failure, operation.signal) ? null : failure;
                    if (!active) {
                        status = cancelled(failure, operation.signal) ? 'cancelled' : 'error';
                        message = cancelled(failure, operation.signal) ? 'Voice preparation cancelled.' : 'The local voice could not load. Try Load again.';
                    }
                }
                throw failure;
            } finally {
                if (loading === operation) loading = null;
                progress = null;
                publish();
            }
            return current();
        }
    }

    function waitForVoice(operation) {
        return new Promise(observeVoice);

        function observeVoice(resolve, reject) {
            let started = false;
            function abort() { reject(operation.signal.reason); }
            operation.signal.addEventListener(
                'abort', abort,
                {once: true}
            );
            function voiceChanged(snapshot) {
                if (operation.signal.aborted) return;
                if (snapshot.closed || snapshot.state === 'unloading' || (started && !snapshot.loaded)) {
                    operation.controller.abort(new DOMException('The local voice was unloaded.', 'AbortError'));
                    return;
                }
                if (snapshot.loaded && !started) {
                    started = true;
                    resolve();
                } else if (snapshot.state === 'error') {
                    reject(error ?? speechError('PM_SPEECH_NOT_READY', 'The local voice is unavailable.'));
                }
            }
            const stop = subscribe(voiceChanged);
            operation.stopModel = function stopVoiceObservation() {
                stop();
                operation.signal.removeEventListener('abort', abort);
            };
            if (operation.signal.aborted) abort();
        }
    }

    function synthesize({text, voice = DEFAULT_VOICE, speed = 1, signal: requestSignal} = {}) {
        assertOpen();
        if (active || releasing) throw speechError('PM_SPEECH_BUSY', 'Local speech is already preparing audio.');
        const controller = new AbortController();
        const operation = {
            controller, signal: operationSignal(controller, requestSignal), task: null, stopModel: null,
            input: {text, voice, speed}
        };
        active = operation;
        status = 'Thinking';
        message = 'Preparing speech.';
        if (current().loaded) error = null;
        operation.task = Promise.resolve().then(synthesizeLocalSpeech);
        operation.task.catch(reportSynthesisFailure);
        publish();
        return operation.task;

        function reportSynthesisFailure(failure) {
            if (!cancelled(failure, operation.signal)) report(failure);
        }

        async function synthesizeLocalSpeech() {
            try {
                operation.signal.throwIfAborted();
                await waitForVoice(operation);
                operation.signal.throwIfAborted();
                const result = await provider.request(
                    {
                        role: 'tts',
                        operation: 'synthesize',
                        signal: operation.signal,
                        payload: {
                            model: MODEL_ID,
                            input: operation.input.text,
                            textFormat: 'plain',
                            responseFormat: 'wav',
                            voice: operation.input.voice,
                            speed: operation.input.speed
                        }
                    }
                );
                operation.signal.throwIfAborted();
                if (!current().loaded) throw speechError('PM_SPEECH_NOT_READY', 'The local voice is unavailable.');
                const audio = new Blob(
                    [result.audio],
                    {type: result.contentType}
                );
                status = 'complete';
                message = 'Speech ready.';
                return audio;
            } catch (failure) {
                if (!closed && !releasing) {
                    error = cancelled(failure, operation.signal) ? null : failure;
                    status = cancelled(failure, operation.signal) ? 'cancelled' : 'error';
                    message = cancelled(failure, operation.signal) ? 'Speech preparation cancelled.' : 'Speech could not be prepared. Try again.';
                }
                throw failure;
            } finally {
                operation.input = null;
                operation.stopModel?.();
                operation.stopModel = null;
                if (active === operation) active = null;
                publish();
            }
        }
    }

    function cancel() {
        active?.controller.abort();
        loading?.controller.abort();
    }

    function unload({signal: requestSignal} = {}) {
        assertOpen();
        requestSignal?.throwIfAborted();
        if (releasing) return releasing;
        const pending = [loading?.task, active?.task];
        const selected = provider;
        status = 'unloading';
        message = 'Releasing the local voice.';
        releasing = Promise.resolve().then(unloadLocalVoice);
        cancel();
        releasing.catch(report);
        publish();
        return releasing;

        async function unloadLocalVoice() {
            try {
                const outcomes = await Promise.allSettled(
                    [selected?.unload(), ...pending]
                );
                if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
                if (!closed) {
                    error = null;
                    status = 'idle';
                    message = 'Load the local voice to prepare speech.';
                }
            } catch (failure) {
                if (!closed) {
                    error = failure;
                    status = 'error';
                    message = 'The local voice could not finish closing. Try Unload again.';
                }
                throw failure;
            } finally {
                releasing = null;
                progress = null;
                publish();
            }
            return current();
        }
    }

    function dispose() {
        if (closing) return closing;
        closed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        const pending = [loading?.task, active?.task, releasing];
        const selected = provider;
        lifetime.abort();
        status = 'closing';
        message = 'Closing local speech.';
        closing = Promise.resolve().then(closeLocalSpeech);
        closing.catch(report);
        publish();
        return closing;

        async function closeLocalSpeech() {
            const outcomes = await Promise.allSettled(
                [selected?.dispose(), ...pending]
            );
            const failure = outcomes[0].status === 'rejected' ? outcomes[0].reason : null;
            if (!failure) provider = null;
            progress = null;
            error = failure;
            status = failure ? 'error' : 'disposed';
            message = failure ? 'Local speech could not finish closing.' : 'Local speech is closed.';
            publish();
            events.dispose();
            eventsDisposed = true;
            if (failure) throw failure;
        }
    }

    lifetimeSignal.addEventListener(
        'abort', dispose,
        {once: true}
    );
    if (lifetimeSignal.aborted) dispose();
    return {current, subscribe, load, synthesize, cancel, unload, dispose};
}
