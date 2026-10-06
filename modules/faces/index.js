import {createArcaneEventSource} from 'arcane-os/event-manager';

const FACE_RECORDS = 'pm_faces';
const FACE_IMAGES = 'pm_face_images';

/** PM owns candidate choice; the injected SDK runtime owns image execution. */
export function createTaskFaceController(
    {imageRuntime, data, getStorage = data?.getStorage, signal} = {}
) {
    const events = createArcaneEventSource(
        {},
        {
            source: 'arcane-pm.faces',
            eventTypes: ['arcane-pm.faces.state']
        }
    );
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any(
        [signal, lifetime.signal]
    ) : lifetime.signal;
    const candidates = new Map();
    const pending = new Set();
    const choices = new Map();
    let modelState = imageRuntime?.current() ?? {
        state: 'unavailable', selectedModel: null, loaded: false, available: false
    };
    let active = null;
    let disposed = false;
    let disposal = null;
    let status = 'idle';
    let message = 'Generate a candidate, then choose the face you want to keep.';
    let progress = null;

    function current() {
        return {
            status,
            message,
            progress,
            operation: active?.operation ?? null,
            taskId: active?.taskId ?? null,
            model: {
                id: modelState.id ?? null,
                selectedModel: modelState.selectedModel ?? null,
                state: modelState.state,
                loaded: modelState.loaded === true,
                available: modelState.available === true
            },
            candidates: Array.from(
                candidates.values(),
                publicCandidate
            ),
            choosingTaskIds: Array.from(
                choices.keys()
            ),
            disposed
        };
    }

    function publicCandidate(candidate) {
        return {
            id: candidate.id,
            taskId: candidate.taskId,
            operation: candidate.operation,
            model: candidate.model,
            prompt: candidate.prompt,
            parameters: candidate.parameters,
            strength: candidate.strength,
            blob: candidate.image.blob,
            mediaType: candidate.image.mediaType,
            name: candidate.image.name ?? null,
            width: candidate.image.width,
            height: candidate.image.height,
            createdAt: candidate.createdAt,
            chosen: candidate.chosen
        };
    }

    function publish() {
        if (!disposed) {
            events.dispatch(
                'arcane-pm.faces.state',
                current()
            );
        }
    }

    function setStatus(nextStatus, nextMessage) {
        status = nextStatus;
        message = nextMessage;
        publish();
    }

    function abortReason(reason) {
        return new DOMException(reason, 'AbortError');
    }

    function requireOpen() {
        if (disposed) throw abortReason('The task-face controller is closed.');
        lifetimeSignal.throwIfAborted();
    }

    function checkRequest(request) {
        request.signal.throwIfAborted();
        if (disposed || active !== request) throw abortReason('The face request was superseded.');
    }

    function observeModel(snapshot) {
        modelState = snapshot;
        const request = active;
        if (request) {
            if (snapshot.selectedModel && snapshot.selectedModel !== request.modelId) {
                request.controller.abort(
                    abortReason('The selected image model changed.')
                );
            } else if (
                request.ready && (
                    !snapshot.loaded
                    || ['unloading', 'unloaded', 'closing', 'closed', 'cancelling', 'error', 'unavailable'].includes(snapshot.state)
                )
            ) {
                request.controller.abort(
                    abortReason('The selected image model is no longer ready.')
                );
            }
            request.resume?.();
        }
        publish();
    }

    const stopModel = imageRuntime?.subscribe(
        observeModel,
        {replay: true, signal: lifetimeSignal}
    ) ?? function noImageRuntimeSubscription() {};

    function waitForModel(request) {
        return new Promise(
            function waitForSelectedImageModel(resolve, reject) {
                function finish(error) {
                    request.signal.removeEventListener('abort', aborted);
                    request.resume = null;
                    if (error) reject(error);
                    else resolve();
                }
                function aborted() {
                    finish(
                        request.signal.reason ?? abortReason('The face request was cancelled.')
                    );
                }
                function ready() {
                    try {
                        checkRequest(request);
                        if (modelState.state === 'error') {
                            const error = new Error(
                                'The image model could not become ready.',
                                {cause: modelState.error}
                            );
                            error.code = 'PM_FACE_MODEL_ERROR';
                            throw error;
                        }
                        if (
                            ['unavailable', 'closed', 'closing'].includes(modelState.state)
                        ) {
                            const error = new Error('Local image generation requires an available image runtime.');
                            error.code = 'PM_FACE_MODEL_UNAVAILABLE';
                            throw error;
                        }
                        if (modelState.selectedModel && modelState.selectedModel !== request.modelId) {
                            throw abortReason('The selected image model changed.');
                        }
                        if (modelState.selectedModel === request.modelId
                            && modelState.loaded === true && modelState.state === 'ready') {
                            request.ready = true;
                            finish();
                        }
                    } catch (error) {
                        finish(error);
                    }
                }
                request.resume = ready;
                request.signal.addEventListener(
                    'abort',
                    aborted,
                    {once: true}
                );
                ready();
            }
        );
    }

    function track(task) {
        pending.add(task);
        function settled() {
            pending.delete(task);
        }
        task.then(settled, settled);
        return task;
    }

    function begin(operation, input) {
        requireOpen();
        cancel();
        const controller = new AbortController();
        const request = {
            operation,
            taskId: input.taskId,
            modelId: typeof input.model === 'string' ? input.model : input.model?.id,
            controller,
            signal: AbortSignal.any(
                [
                    lifetimeSignal,
                    controller.signal,
                    ...(
                        input.signal ? [input.signal] : []
                    )
                ]
            ),
            ready: false,
            resume: null
        };
        active = request;
        progress = null;
        setStatus('Thinking', 'Thinking');
        return track(
            execute(request, input)
        );
    }

    async function execute(request, input) {
        try {
            checkRequest(request);
            if (
                typeof request.modelId !== 'string' || !request.modelId.trim()
            ) {
                throw new TypeError('Choose an image model before requesting a task face.');
            }
            if (typeof input.prompt !== 'string') throw new TypeError('The face prompt must be a string.');
            if (request.operation === 'edit' && input.strength === undefined) {
                throw new TypeError('Image editing requires an explicit strength.');
            }
            if (typeof data?.getTask !== 'function') throw new Error('The PM task data owner is unavailable.');
            const task = await data.getTask(input.taskId);
            checkRequest(request);
            if (!task) throw new Error('The selected PM task is no longer available.');
            do {
                await waitForModel(request);
                checkRequest(request);
            } while (modelState.state !== 'ready');
            const options = {
                model: input.model,
                prompt: input.prompt,
                parameters: input.parameters,
                signal: request.signal,
                onProgress: function imageProgress(value) {
                    if (active === request && !request.signal.aborted && !disposed) {
                        progress = value;
                        publish();
                    }
                }
            };
            const result = request.operation === 'edit'
                ? await imageRuntime.edit(
                    {...options, image: input.image, strength: input.strength}
                )
                : await imageRuntime.generate(options);
            checkRequest(request);
            const created = result.images.map(
                function faceCandidate(image) {
                    return {
                        id: globalThis.crypto.randomUUID(),
                        taskId: input.taskId,
                        operation: request.operation,
                        model: input.model,
                        prompt: input.prompt,
                        parameters: input.parameters,
                        strength: request.operation === 'edit' ? input.strength : null,
                        original: request.operation === 'edit' ? input.image : null,
                        image,
                        createdAt: new Date().toISOString(),
                        chosen: false
                    };
                }
            );
            for (const candidate of created) candidates.set(candidate.id, candidate);
            active = null;
            progress = null;
            setStatus('ready', created.length ? 'Choose a candidate to save it as this task’s face.' : 'The model returned no images.');
            return {
                result,
                candidates: created.map(publicCandidate)
            };
        } catch (error) {
            if (active === request) {
                active = null;
                progress = null;
                const cancelled = request.signal.aborted || error.name === 'AbortError';
                setStatus(
                    cancelled ? 'cancelled' : 'error',
                    cancelled
                        ? 'Face request cancelled. Your saved face is unchanged.'
                        : 'The face request could not finish. Review the selected model and try again.'
                );
            }
            if (!request.signal.aborted && error.name !== 'AbortError') {
                globalThis.console?.error('Arcane PM task-face request failed.', error);
            }
            throw error;
        }
    }

    function generate(input) {
        return begin('generate', input);
    }

    function edit(input) {
        return begin('edit', input);
    }

    function importCandidate(
        {taskId, image, prompt = '', signal: importSignal} = {}
    ) {
        requireOpen();
        const operationSignal = importSignal ? AbortSignal.any(
            [lifetimeSignal, importSignal]
        ) : lifetimeSignal;
        return track(
            acceptImportedImage()
        );

        async function acceptImportedImage() {
            operationSignal.throwIfAborted();
            if (!(image instanceof Blob)) throw new TypeError('Choose a complete image Blob or File.');
            if (typeof prompt !== 'string') throw new TypeError('The face prompt must be a string.');
            if (typeof data?.getTask !== 'function') throw new Error('The PM task data owner is unavailable.');
            const task = await data.getTask(taskId);
            operationSignal.throwIfAborted();
            if (!task) throw new Error('The selected PM task is no longer available.');
            const candidate = {
                id: globalThis.crypto.randomUUID(),
                taskId,
                operation: 'import',
                model: null,
                prompt,
                parameters: undefined,
                strength: null,
                original: null,
                image: {blob: image, mediaType: image.type, name: image.name ?? null, width: null, height: null},
                createdAt: new Date().toISOString(),
                chosen: false
            };
            candidates.set(candidate.id, candidate);
            publish();
            return publicCandidate(candidate);
        }
    }

    function choose(
        candidateId,
        {signal: selectionSignal} = {}
    ) {
        requireOpen();
        const candidate = candidates.get(candidateId);
        if (!candidate) throw new Error('That face candidate is no longer available.');
        if (
            choices.has(candidate.taskId)
        ) {
            throw new Error('A face selection is already being saved for this task.');
        }
        const choice = {
            candidate,
            signal: selectionSignal ? AbortSignal.any(
                [lifetimeSignal, selectionSignal]
            ) : lifetimeSignal
        };
        choices.set(candidate.taskId, choice);
        publish();
        return track(
            saveChoice(choice)
        );
    }

    async function saveChoice(choice) {
        const candidate = choice.candidate;
        try {
            choice.signal.throwIfAborted();
            if (typeof getStorage !== 'function' || typeof data?.setTaskFace !== 'function') {
                throw new Error('The PM face storage owner is unavailable.');
            }
            const storage = await getStorage();
            choice.signal.throwIfAborted();
            const imageFile = `${candidate.id}.${candidate.operation === 'import' ? 'image' : 'png'}`;
            const originalFile = candidate.original ? `${candidate.id}-original.png` : null;
            const metadata = {
                id: candidate.id,
                taskId: candidate.taskId,
                operation: candidate.operation,
                model: candidate.model,
                prompt: candidate.prompt,
                parameters: candidate.parameters ?? null,
                strength: candidate.strength,
                imageFile,
                originalFile,
                mediaType: candidate.image.mediaType,
                name: candidate.image.name ?? null,
                width: candidate.image.width,
                height: candidate.image.height,
                createdAt: candidate.createdAt
            };
            await storage.writeFile(FACE_IMAGES, imageFile, candidate.image.blob);
            choice.signal.throwIfAborted();
            if (originalFile) {
                await storage.writeFile(FACE_IMAGES, originalFile, candidate.original);
                choice.signal.throwIfAborted();
            }
            await storage.set(FACE_RECORDS, `${candidate.id}.json`, metadata);
            choice.signal.throwIfAborted();
            // Once this data-owner write is accepted, report its actual outcome.
            const task = await data.setTaskFace(candidate.taskId, candidate.id);
            candidate.chosen = true;
            return {faceId: candidate.id, metadata, task};
        } catch (error) {
            if (!choice.signal.aborted && error.name !== 'AbortError') {
                globalThis.console?.error('Arcane PM task-face selection failed.', error);
            }
            throw error;
        } finally {
            choices.delete(candidate.taskId);
            publish();
        }
    }

    function read(
        faceId,
        {signal: readSignal} = {}
    ) {
        requireOpen();
        const operationSignal = readSignal ? AbortSignal.any(
            [lifetimeSignal, readSignal]
        ) : lifetimeSignal;
        return track(
            readSavedFace(faceId, operationSignal)
        );
    }

    async function readSavedFace(faceId, operationSignal) {
        operationSignal.throwIfAborted();
        if (typeof getStorage !== 'function') throw new Error('The PM face storage owner is unavailable.');
        const storage = await getStorage();
        operationSignal.throwIfAborted();
        const metadata = await storage.get(FACE_RECORDS, `${faceId}.json`);
        operationSignal.throwIfAborted();
        if (!metadata) return null;
        const file = await storage.readFile(FACE_IMAGES, metadata.imageFile);
        operationSignal.throwIfAborted();
        const originalBlob = metadata.originalFile ? await storage.readFile(FACE_IMAGES, metadata.originalFile) : null;
        operationSignal.throwIfAborted();
        const blob = new Blob(
            [file],
            {type: metadata.mediaType}
        );
        return {
            blob,
            metadata: structuredClone(metadata),
            originalBlob
        };
    }

    function subscribe(
        listener,
        {signal: subscriptionSignal} = {}
    ) {
        if (typeof listener !== 'function') throw new TypeError('A face-state listener must be a function.');
        if (subscriptionSignal?.aborted) return function inactiveFaceSubscription() {};
        if (disposed) {
            notifyListener(
                listener,
                current()
            );
            return function disposedFaceSubscription() {};
        }
        const stop = events.on(
            'arcane-pm.faces.state',
            function faceStateChanged(event) {
                notifyListener(listener, event.detail);
            },
            {signal: subscriptionSignal}
        );
        try {
            notifyListener(
                listener,
                current()
            );
        } catch (error) {
            stop();
            throw error;
        }
        return stop;
    }

    function notifyListener(listener, snapshot) {
        const result = listener(snapshot);
        if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(
                function faceObserverFailed(error) {
                    globalThis.console?.error('Arcane PM task-face observer failed.', error);
                }
            );
        }
    }

    function cancel() {
        if (!active) return;
        active.controller.abort(
            abortReason('The face request was cancelled.')
        );
    }

    function dispose() {
        if (disposal) return disposal;
        disposed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        lifetime.abort(
            abortReason('The task-face controller is closed.')
        );
        stopModel();
        events.dispose();
        disposal = Promise.allSettled(
            Array.from(pending)
        ).then(
            function faceWorkDisposed() {
                candidates.clear();
                active = null;
                progress = null;
                status = 'disposed';
                message = 'Task-face controls are closed.';
            }
        );
        return disposal;
    }

    lifetimeSignal.addEventListener(
        'abort',
        dispose,
        {once: true}
    );
    if (lifetimeSignal.aborted) dispose();

    return {generate, edit, importCandidate, choose, read, current, subscribe, cancel, dispose};
}
