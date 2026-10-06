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
    const initialRequests = new Map();
    const initialStates = new Map();
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
        const choosingTaskIds = [];
        const choosingProjectIds = [];
        for (const choice of choices.values()) {
            if (choice.candidate.subjectType === 'project') {
                choosingProjectIds.push(choice.candidate.projectId);
            } else {
                choosingTaskIds.push(choice.candidate.taskId);
            }
        }
        return {
            status,
            message,
            progress,
            operation: active?.operation ?? null,
            taskId: active?.taskId ?? null,
            subjectType: active ? 'task' : null,
            subjectId: active?.taskId ?? null,
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
            choosingTaskIds,
            choosingProjectIds,
            initialFaces: Array.from(
                initialStates.values(),
                function initialFaceState(value) {
                    return {...value};
                }
            ),
            disposed
        };
    }

    function publicCandidate(candidate) {
        return {
            id: candidate.id,
            taskId: candidate.taskId,
            subjectType: candidate.subjectType ?? 'task',
            subjectId: candidate.subjectId ?? candidate.taskId,
            operation: candidate.operation,
            model: candidate.model,
            prompt: candidate.prompt,
            parameters: candidate.parameters,
            source: candidate.source ?? null,
            projectId: candidate.projectId ?? null,
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
        const selected = request.operation === 'initial'
            ? initialRequests.get(request.key) : active;
        if (disposed || selected !== request) throw abortReason('The face request was superseded.');
    }

    function observeModel(snapshot) {
        modelState = snapshot;
        const requests = Array.from(initialRequests.values());
        if (active) requests.push(active);
        for (const request of requests) {
            if (snapshot.selectedModel && snapshot.selectedModel !== request.modelId) {
                request.controller.abort(
                    abortReason('The selected image model changed.')
                );
            } else if (
                request.ready && (
                    snapshot.selectedModel !== request.modelId
                    || !snapshot.loaded
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
                    return createCandidate(request, input, image);
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

    function createCandidate(request, input, image) {
        const candidate = {
            id: globalThis.crypto.randomUUID(),
            taskId: request.subjectType === 'project' ? null : input.taskId,
            projectId: input.projectId,
            subjectType: request.subjectType ?? 'task',
            subjectId: request.subjectId ?? input.taskId,
            operation: request.operation,
            model: input.model,
            parameters: input.parameters,
            strength: request.operation === 'edit' ? input.strength : null,
            original: request.operation === 'edit' ? input.image : null,
            image,
            createdAt: new Date().toISOString(),
            chosen: false
        };
        if (request.operation !== 'initial') {
            candidate.prompt = input.prompt;
            candidate.source = input.source;
        }
        return candidate;
    }

    function setInitialState(request, nextStatus, nextMessage, faceId = null) {
        if (initialRequests.get(request.key) !== request) return;
        initialStates.set(
            request.key,
            {
                taskId: request.taskId,
                projectId: request.input.projectId,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                status: nextStatus,
                message: nextMessage,
                progress: request.progress,
                faceId
            }
        );
        publish();
    }

    function initialSubjectIsCurrent(request, subject) {
        if (disposed || request.signal.aborted
            || initialRequests.get(request.key) !== request
            || choices.has(request.key) || subject?.id !== request.subjectId) return false;
        if (request.subjectType === 'project') {
            return (subject.name ?? '') === request.input.source.name
                && (subject.description ?? '') === request.input.source.description;
        }
        return (subject.projectId ?? null) === (request.input.projectId ?? null)
            && (subject.title ?? '') === request.input.source.title
            && (subject.assignment ?? '') === request.input.source.assignment;
    }

    function ensureInitialFace(input = {}) {
        return ensureInitialAvatar('task', input);
    }

    function ensureInitialProjectFace(input = {}) {
        return ensureInitialAvatar('project', input);
    }

    function ensureInitialAvatar(subjectType, input) {
        requireOpen();
        const subjectId = subjectType === 'project' ? input.projectId : input.taskId;
        const key = `${subjectType}:${subjectId}`;
        const modelId = typeof input.model === 'string' ? input.model : input.model?.id;
        const source = subjectType === 'project' ? {
            name: input.source?.name,
            description: input.source?.description
        } : {
            title: input.source?.title,
            assignment: input.source?.assignment,
            projectPurpose: input.source?.projectPurpose
        };
        const previous = initialRequests.get(key);
        const sameSource = previous && Object.keys(source).every(
            function sameSourceField(field) {
                return previous.input.source[field] === source[field];
            }
        );
        if (previous && !previous.signal.aborted
            && previous.modelId === modelId
            && previous.input.projectId === input.projectId
            && sameSource) {
            return previous.task;
        }
        const controller = new AbortController();
        const request = {
            operation: 'initial',
            key,
            subjectType,
            subjectId,
            taskId: subjectType === 'task' ? input.taskId : null,
            modelId,
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
            input: {...input, source},
            ready: false,
            resume: null,
            progress: null,
            task: null
        };
        initialRequests.set(key, request);
        request.task = track(
            Promise.resolve().then(
                function startInitialFace() {
                    return executeInitialFace(request);
                }
            )
        );
        if (previous && !previous.signal.aborted) {
            previous.controller.abort(
                abortReason('The initial avatar request was superseded.')
            );
        }
        setInitialState(request, 'Thinking', 'Thinking');
        return request.task;
    }

    async function readInitialSubject(request) {
        const subject = request.subjectType === 'project'
            ? await data.getProject(request.subjectId) : await data.getTask(request.subjectId);
        checkRequest(request);
        let reason = null;
        if (!subject) reason = `${request.subjectType}-missing`;
        else if (subject.faceRef !== null && subject.faceRef !== undefined) reason = 'face-present';
        else if (!initialSubjectIsCurrent(request, subject)) reason = 'request-stale';
        if (!reason) return null;
        return request.subjectType === 'project'
            ? {applied: false, reason, project: subject}
            : {applied: false, reason, task: subject};
    }

    function initialOutcome(request, outcome, detail = {}) {
        const faceId = (outcome.project ?? outcome.task)?.faceRef ?? null;
        request.progress = null;
        setInitialState(
            request,
            faceId ? 'ready' : 'cancelled',
            outcome.applied ? 'Avatar saved.'
                : faceId ? 'Using the saved avatar.'
                    : 'The work changed. This avatar request was cancelled.',
            faceId
        );
        return {...detail, ...outcome, faceId};
    }

    async function executeInitialFace(request) {
        const input = request.input;
        try {
            checkRequest(request);
            const project = request.subjectType === 'project';
            if (typeof data?.[project ? 'getProject' : 'getTask'] !== 'function'
                || typeof data?.[project ? 'setProjectFaceIfEmpty' : 'setTaskFaceIfEmpty'] !== 'function') {
                throw new Error('The PM initial-avatar data owner is unavailable.');
            }
            const existing = await readInitialSubject(request);
            if (existing) return initialOutcome(request, existing);
            if (typeof request.modelId !== 'string' || !request.modelId.trim()) {
                throw new TypeError('Choose an image model before requesting an avatar.');
            }
            if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
                throw new TypeError('The avatar requires its complete image description.');
            }
            for (const field of Object.keys(input.source)) {
                if (typeof input.source[field] !== 'string') {
                    throw new TypeError(`The avatar source requires complete ${field} text.`);
                }
            }
            do {
                await waitForModel(request);
                checkRequest(request);
            } while (modelState.state !== 'ready');
            const beforeGeneration = await readInitialSubject(request);
            if (beforeGeneration) return initialOutcome(request, beforeGeneration);
            const result = await imageRuntime.generate(
                {
                    model: input.model,
                    prompt: input.prompt,
                    parameters: input.parameters,
                    signal: request.signal,
                    onProgress: function initialImageProgress(value) {
                        if (initialRequests.get(request.key) === request
                            && !request.signal.aborted && !disposed) {
                            request.progress = value;
                            setInitialState(request, 'Thinking', 'Creating the avatar.');
                        }
                    }
                }
            );
            checkRequest(request);
            const beforeSave = await readInitialSubject(request);
            if (beforeSave) {
                return initialOutcome(
                    request,
                    beforeSave,
                    {result}
                );
            }
            const created = result.images.map(
                function initialFaceCandidate(image) {
                    return createCandidate(request, input, image);
                }
            );
            if (!created.length) throw new Error('The image model returned no avatar.');
            for (const candidate of created) candidates.set(candidate.id, candidate);
            const candidate = created[0];
            request.progress = null;
            setInitialState(request, 'saving', 'Saving the avatar.');
            checkRequest(request);
            const metadata = await persistCandidate(candidate, request.signal);
            checkRequest(request);
            const associationOptions = {
                signal: request.signal,
                isCurrent: function sameInitialSubject(subject) {
                    return initialSubjectIsCurrent(request, subject);
                }
            };
            const outcome = project
                ? await data.setProjectFaceIfEmpty(request.subjectId, candidate.id, associationOptions)
                : await data.setTaskFaceIfEmpty(request.subjectId, candidate.id, associationOptions);
            candidate.chosen = outcome.applied;
            // Report a write already accepted by the data owner even after cancellation.
            return initialOutcome(
                request,
                outcome,
                {metadata, result, candidates: created.map(publicCandidate)}
            );
        } catch (error) {
            request.progress = null;
            const cancelled = request.signal.aborted || error.name === 'AbortError';
            setInitialState(
                request,
                cancelled ? 'cancelled' : 'error',
                cancelled ? 'Avatar generation cancelled.'
                    : 'The avatar could not be created. Review the image model and try again.'
            );
            if (!cancelled) globalThis.console?.error('Arcane PM initial avatar failed.', error);
            throw error;
        } finally {
            if (initialRequests.get(request.key) === request) {
                initialRequests.delete(request.key);
            }
            request.input = null;
        }
    }

    function cancelInitialFace(taskId) {
        cancelInitialAvatar(`task:${taskId}`);
    }

    function cancelInitialProjectFace(projectId) {
        cancelInitialAvatar(`project:${projectId}`);
    }

    function cancelInitialAvatar(key) {
        const request = initialRequests.get(key);
        if (!request || request.signal.aborted) return;
        request.controller.abort(
            abortReason('The initial avatar was cancelled.')
        );
        request.progress = null;
        setInitialState(request, 'cancelled', 'Avatar generation cancelled.');
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
                subjectType: 'task',
                subjectId: taskId,
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
        const key = `${candidate.subjectType ?? 'task'}:${candidate.subjectId ?? candidate.taskId}`;
        if (
            choices.has(key)
        ) {
            throw new Error('A face selection is already being saved for this work.');
        }
        const choice = {
            key,
            candidate,
            signal: selectionSignal ? AbortSignal.any(
                [lifetimeSignal, selectionSignal]
            ) : lifetimeSignal
        };
        choices.set(key, choice);
        const task = track(
            Promise.resolve().then(
                function saveSelectedFace() {
                    return saveChoice(choice);
                }
            )
        );
        cancelInitialAvatar(key);
        publish();
        return task;
    }

    async function saveChoice(choice) {
        const candidate = choice.candidate;
        try {
            choice.signal.throwIfAborted();
            const project = candidate.subjectType === 'project';
            if (typeof getStorage !== 'function'
                || typeof data?.[project ? 'setProjectFace' : 'setTaskFace'] !== 'function') {
                throw new Error('The PM face storage owner is unavailable.');
            }
            const metadata = await persistCandidate(candidate, choice.signal);
            choice.signal.throwIfAborted();
            // Once this data-owner write is accepted, report its actual outcome.
            const subject = project
                ? await data.setProjectFace(candidate.projectId, candidate.id)
                : await data.setTaskFace(candidate.taskId, candidate.id);
            candidate.chosen = true;
            return project ? {faceId: candidate.id, metadata, project: subject}
                : {faceId: candidate.id, metadata, task: subject};
        } catch (error) {
            if (!choice.signal.aborted && error.name !== 'AbortError') {
                globalThis.console?.error('Arcane PM task-face selection failed.', error);
            }
            throw error;
        } finally {
            choices.delete(choice.key);
            publish();
        }
    }

    async function persistCandidate(candidate, operationSignal) {
        operationSignal.throwIfAborted();
        if (typeof getStorage !== 'function') throw new Error('The PM face storage owner is unavailable.');
        const storage = await getStorage();
        operationSignal.throwIfAborted();
        const imageFile = `${candidate.id}.${candidate.operation === 'import' ? 'image' : 'png'}`;
        const originalFile = candidate.original ? `${candidate.id}-original.png` : null;
        const metadata = {
            id: candidate.id,
            taskId: candidate.taskId,
            subjectType: candidate.subjectType ?? 'task',
            subjectId: candidate.subjectId ?? candidate.taskId,
            operation: candidate.operation,
            model: candidate.model,
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
        if (candidate.operation === 'initial') {
            metadata.projectId = candidate.projectId;
        } else {
            metadata.prompt = candidate.prompt;
        }
        await storage.writeFile(FACE_IMAGES, imageFile, candidate.image.blob);
        operationSignal.throwIfAborted();
        if (originalFile) {
            await storage.writeFile(FACE_IMAGES, originalFile, candidate.original);
            operationSignal.throwIfAborted();
        }
        await storage.set(FACE_RECORDS, `${candidate.id}.json`, metadata);
        operationSignal.throwIfAborted();
        return metadata;
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
                initialRequests.clear();
                initialStates.clear();
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

    return {
        generate, edit, ensureInitialFace, cancelInitialFace,
        ensureInitialProjectFace, cancelInitialProjectFace,
        importCandidate, choose, read, current, subscribe, cancel, dispose
    };
}
