import {createArcaneEventSource} from 'arcane-os/event-manager';
import {createLocalPreparationController} from './preparation.js';

/** Derive a first avatar from real work through the selected local model owners. */
export function createInitialAvatarPreparation(
    {modelServices, faces, data, getStorage, acquireRequest, signal} = {}
) {
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const imageRuntime = modelServices.getImageRuntime();
    const events = createArcaneEventSource(
        {},
        {source: 'arcane-pm.initial-avatars', eventTypes: ['arcane-pm.initial-avatars.state']}
    );
    const jobs = new Map();
    const states = new Map();
    const revisions = new Map();
    const pending = new Set();
    let closed = false;
    let closing = null;

    function publicState(state) {
        return {
            subjectType: state.subjectType,
            subjectId: state.subjectId,
            status: state.status,
            message: state.message,
            faceId: state.faceId
        };
    }

    function current() {
        return {statuses: Array.from(states.values(), publicState), closed};
    }

    function publish() {
        if (!closed) events.dispatch('arcane-pm.initial-avatars.state', current());
    }

    function setStatus(job, status, message, faceId = null) {
        const state = {...job.state, status, message, faceId};
        if (jobs.get(job.key) === job) {
            job.state = state;
            states.set(job.key, state);
            publish();
        }
        return publicState(state);
    }

    function subscribe(listener, {signal: subscriptionSignal} = {}) {
        const stop = events.on(
            'arcane-pm.initial-avatars.state',
            function initialAvatarStateChanged(event) {
                listener(event.detail);
            },
            {signal: subscriptionSignal}
        );
        if (!subscriptionSignal?.aborted) {
            try {
                listener(current());
            } catch (error) {
                stop();
                throw error;
            }
        }
        return stop;
    }

    function cancellation(message) {
        return new DOMException(message, 'AbortError');
    }

    function assertCurrent(job) {
        job.signal.throwIfAborted();
        if (closed || jobs.get(job.key) !== job) {
            throw cancellation('This avatar preparation was replaced.');
        }
    }

    function ensureTask(taskId, options) {
        return ensure('task', taskId, options);
    }

    function ensureProject(projectId, options) {
        return ensure('project', projectId, options);
    }

    function ensure(subjectType, subjectId, {signal: requestSignal, retry = false} = {}) {
        lifetimeSignal.throwIfAborted();
        requestSignal?.throwIfAborted();
        if (closed) throw cancellation('Initial avatar preparation is closed.');
        const key = `${subjectType}:${subjectId}`;
        const revision = revisions.get(key) ?? 0;
        const existing = jobs.get(key);
        if (existing && existing.state.revision === revision && !retry) {
            return existing.task;
        }
        const previous = states.get(key);
        if (!existing && previous?.revision === revision && !retry) {
            return Promise.resolve(publicState(previous));
        }
        existing?.controller.abort(cancellation('The avatar source changed.'));
        const controller = new AbortController();
        const job = {
            key,
            controller,
            signal: AbortSignal.any(
                [lifetimeSignal, controller.signal, ...(requestSignal ? [requestSignal] : [])]
            ),
            state: {
                subjectType, subjectId, projectId: subjectType === 'project' ? subjectId : null,
                revision, status: 'Thinking', message: 'Thinking', faceId: null
            },
            source: null,
            preparation: null,
            imageRequested: false,
            stopImage: null,
            task: null
        };
        jobs.set(key, job);
        states.set(key, job.state);
        job.task = Promise.resolve().then(
            function beginInitialAvatar() {
                return prepareAvatar(job);
            }
        );
        pending.add(job.task);
        job.task.then(
            function avatarSettled() {
                pending.delete(job.task);
            },
            function avatarFailed(error) {
                pending.delete(job.task);
                if (!job.signal.aborted && error?.name !== 'AbortError') {
                    console.error('Arcane PM initial avatar preparation failed.', error);
                }
            }
        );
        publish();
        return job.task;
    }

    async function readSubject(job) {
        return job.state.subjectType === 'project'
            ? data.getProject(job.state.subjectId) : data.getTask(job.state.subjectId);
    }

    async function prepareAvatar(job) {
        try {
            assertCurrent(job);
            const subject = await readSubject(job);
            assertCurrent(job);
            if (!subject) {
                return setStatus(job, 'cancelled', 'The work is no longer available.');
            }
            if (job.state.subjectType === 'task') job.state.projectId = subject.projectId ?? null;
            if (subject.faceRef !== null && subject.faceRef !== undefined) {
                return setStatus(job, 'ready', 'Using the saved avatar.', subject.faceRef);
            }
            if (job.state.subjectType === 'project') {
                job.source = {name: subject.name ?? '', description: subject.description ?? ''};
            } else {
                const project = subject.projectId ? await data.getProject(subject.projectId) : null;
                assertCurrent(job);
                job.source = {
                    title: subject.title ?? '',
                    assignment: subject.assignment ?? '',
                    projectPurpose: project?.description ?? ''
                };
            }
            const selected = await waitForModels(job);
            assertCurrent(job);
            job.preparation = createLocalPreparationController(
                {
                    modelServices, getStorage, tools: [], acquireRequest,
                    requestPriority: 'background', signal: job.signal
                }
            );
            setStatus(job, 'Thinking', 'Preparing an avatar description.');
            const description = await job.preparation.prepare(
                {
                    taskId: job.state.subjectType === 'task' ? job.state.subjectId : null,
                    messages: descriptionMessages(job), persist: false, signal: job.signal,
                    expectedSelection: selected.textModel
                }
            );
            assertCurrent(job);
            if (typeof description.content !== 'string' || !description.content.trim()) {
                throw new Error('The local text model returned no image description.');
            }
            job.imageRequested = true;
            const outcome = job.state.subjectType === 'project'
                ? await faces.ensureInitialProjectFace(
                    {
                        projectId: job.state.subjectId, model: selected.imageModel,
                        prompt: description.content, source: job.source, signal: job.signal
                    }
                ) : await faces.ensureInitialFace(
                    {
                        taskId: job.state.subjectId, projectId: job.state.projectId,
                        model: selected.imageModel, prompt: description.content,
                        source: job.source, signal: job.signal
                    }
                );
            // The data owner reports an accepted association even if cancellation
            // arrives during its write. Keep that real outcome visible.
            if (outcome.faceId !== null && outcome.faceId !== undefined) {
                return setStatus(
                    job, 'ready', outcome.applied ? 'Avatar saved.' : 'Using the saved avatar.', outcome.faceId
                );
            }
            return setStatus(job, 'cancelled', 'The work changed before its avatar was saved.');
        } catch (error) {
            const subject = await readSubject(job).catch(
                function reportAvatarOutcomeRead(readError) {
                    console.error('Arcane PM avatar outcome could not be read.', readError);
                    return null;
                }
            );
            if (subject?.faceRef !== null && subject?.faceRef !== undefined) {
                return setStatus(job, 'ready', 'Using the saved avatar.', subject.faceRef);
            }
            const cancelled = job.signal.aborted || error?.name === 'AbortError';
            setStatus(
                job, cancelled ? 'cancelled' : 'error',
                cancelled ? 'Avatar preparation stopped.'
                    : 'The avatar could not be prepared. Review the selected models and try again.'
            );
            throw error;
        } finally {
            const preparation = job.preparation;
            job.preparation = null;
            job.source = null;
            job.stopImage?.();
            job.stopImage = null;
            try {
                await preparation?.dispose();
            } finally {
                if (jobs.get(job.key) === job) jobs.delete(job.key);
            }
        }
    }

    function descriptionMessages(job) {
        if (job.state.subjectType === 'project') {
            return [
                {
                    role: 'system',
                    content: 'Write one complete, concrete, unique visual description for an image representing this project\'s actual purpose. The next two user messages contain the complete project name and project description, in that order. Ground the scene in that work. Use a warm adult editorial illustration with soft rounded forms, deep teal, ivory, muted gold and restrained lavender. Keep the composition sparse and readable at card size. Avoid interchangeable employee portraits and include no labels or copy. Return only the complete visual description for the image model.'
                },
                {role: 'user', content: job.source.name},
                {role: 'user', content: job.source.description}
            ];
        }
        return [
            {
                role: 'system',
                content: 'Write one complete, concrete, unique visual description for an image representing this task\'s actual work. The next three user messages contain the complete task title, assignment and project purpose, in that order. Ground the scene in that work. Use a warm adult editorial illustration with soft rounded forms, deep teal, ivory, muted gold and restrained lavender. Keep the composition sparse and readable at card size. Avoid interchangeable employee portraits and include no labels or copy. Return only the complete visual description for the image model.'
            },
            {role: 'user', content: job.source.title},
            {role: 'user', content: job.source.assignment},
            {role: 'user', content: job.source.projectPurpose}
        ];
    }

    function waitForModels(job) {
        return new Promise(
            function awaitSelectedAvatarModels(resolve, reject) {
                let stopText = null;
                let finished = false;
                let selected = null;
                function finish(error, selected) {
                    if (finished) return;
                    finished = true;
                    stopText?.();
                    job.signal.removeEventListener('abort', aborted);
                    if (error) reject(error);
                    else resolve(selected);
                }
                function aborted() {
                    finish(job.signal.reason);
                }
                function observeModels() {
                    try {
                        if (selected) {
                            if (job.signal.aborted || job.state.faceId !== null) return;
                            const image = imageRuntime.current();
                            if (image.selectedModel !== selected.imageModel || image.loaded !== true
                                || !['ready', 'generating'].includes(image.state)) {
                                job.controller.abort(cancellation('The selected image model is no longer ready.'));
                            }
                            return;
                        }
                        assertCurrent(job);
                        const text = modelServices.current().model;
                        const image = imageRuntime.current();
                        if (text?.localOnly === true && text.providerId && text.modelId
                            && text.state === 'ready' && text.loaded === true
                            && image.selectedModel && image.state === 'ready' && image.loaded === true) {
                            selected = {
                                imageModel: image.selectedModel,
                                textModel: {
                                    providerId: text.providerId, modelId: text.modelId, localOnly: true
                                }
                            };
                            finish(null, selected);
                        } else {
                            setStatus(job, 'pending', 'Waiting for the selected local text and image models.');
                        }
                    } catch (error) {
                        finish(error);
                    }
                }
                job.signal.addEventListener('abort', aborted, {once: true});
                job.stopImage = imageRuntime.subscribe(observeModels, {replay: true, signal: job.signal});
                if (finished) return;
                stopText = modelServices.subscribe(observeModels);
                if (finished) stopText();
            }
        );
    }

    function cancelTask(taskId) {
        cancel('task', taskId);
    }

    function cancelProject(projectId) {
        cancel('project', projectId);
    }

    function cancel(subjectType, subjectId) {
        const job = jobs.get(`${subjectType}:${subjectId}`);
        if (!job || job.signal.aborted) return;
        job.controller.abort(cancellation('The initial avatar was cancelled.'));
        if (job.state.faceId === null) setStatus(job, 'cancelled', 'Avatar preparation stopped.');
    }

    function faceStateChanged(snapshot) {
        for (const face of snapshot.initialFaces) {
            const job = jobs.get(`${face.subjectType}:${face.subjectId}`);
            if (!job?.imageRequested || job.signal.aborted || job.state.faceId !== null
                || !['generating', 'saving'].includes(face.status)) continue;
            if (job.state.status !== face.status || job.state.message !== face.message) {
                setStatus(job, face.status, face.message);
            }
        }
    }

    function dataChanged(change) {
        const key = `${change.recordType}:${change.id}`;
        let state = states.get(key);
        const record = change.record;
        const facePresent = record?.faceRef !== null && record?.faceRef !== undefined;
        if (state && facePresent) {
            const job = jobs.get(key);
            if (job) {
                if (change.recordType === 'task') job.state.projectId = record.projectId ?? null;
                setStatus(job, 'ready', 'Using the saved avatar.', record.faceRef);
                const faceState = faces.current().initialFaces.find(
                    function matchingFaceState(value) {
                        return value.subjectType === state.subjectType && value.subjectId === state.subjectId;
                    }
                );
                if (faceState?.status !== 'saving') {
                    job.controller.abort(cancellation('The work already has an avatar.'));
                }
            } else {
                states.set(
                    key,
                    {
                        ...state, projectId: change.recordType === 'task' ? record.projectId ?? null : state.projectId,
                        status: 'ready', message: 'Using the saved avatar.', faceId: record.faceRef
                    }
                );
                publish();
            }
        } else if (state?.faceId !== null && state?.faceId !== undefined && record) {
            state = {
                ...state, projectId: change.recordType === 'task' ? record.projectId ?? null : state.projectId,
                status: 'cancelled', message: 'The avatar selection was cleared.', faceId: null
            };
            states.set(key, state);
            publish();
        }
        const changed = change.changedFields ?? [];
        const active = jobs.get(key);
        const activeSourceChanged = active?.source && record && (change.recordType === 'project'
            ? active.source.name !== (record.name ?? '') || active.source.description !== (record.description ?? '')
            : active.source.title !== (record.title ?? '') || active.source.assignment !== (record.assignment ?? '')
                || active.state.projectId !== (record.projectId ?? null));
        const directSourceChange = change.action === 'removed'
            || activeSourceChanged
            || (change.recordType === 'task'
                ? changed.some(function taskSourceChanged(field) {
                    return ['title', 'assignment', 'projectId'].includes(field);
                }) : changed.some(function projectSourceChanged(field) {
                    return ['name', 'description'].includes(field);
                }));
        if (state && !facePresent && directSourceChange) invalidate(state, change.action === 'removed');
        if (change.recordType === 'project') {
            for (const taskState of Array.from(states.values())) {
                const taskJob = jobs.get(`task:${taskState.subjectId}`);
                const purposeChanged = change.action === 'removed' || changed.includes('description')
                    || (taskJob?.source && taskJob.source.projectPurpose !== (record?.description ?? ''));
                if (taskState.subjectType === 'task' && taskState.projectId === change.id && purposeChanged) {
                    invalidate(taskState, false);
                }
            }
        }
    }

    function invalidate(state, removed) {
        const key = `${state.subjectType}:${state.subjectId}`;
        const revision = (revisions.get(key) ?? 0) + 1;
        revisions.set(key, revision);
        const job = jobs.get(key);
        if (!removed && state.faceId !== null && state.faceId !== undefined) {
            states.set(key, {...state, revision});
            return;
        }
        job?.controller.abort(cancellation('The avatar source changed.'));
        if (removed) {
            if (job) job.state = {...state, revision};
            states.set(
                key,
                {...state, revision, status: 'cancelled', message: 'The work is no longer available.', faceId: null}
            );
            publish();
        } else if (!closed) {
            ensure(state.subjectType, state.subjectId);
        }
    }

    function dispose() {
        if (closing) return closing;
        closed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        lifetime.abort(cancellation('Initial avatar preparation is closed.'));
        stopData();
        stopFaces();
        closing = Promise.allSettled(Array.from(pending)).then(
            function initialAvatarPreparationDisposed() {
                jobs.clear();
                states.clear();
                revisions.clear();
                events.dispose();
            }
        );
        return closing;
    }

    const stopData = data.subscribe(dataChanged, {signal: lifetimeSignal});
    const stopFaces = faces.subscribe(faceStateChanged, {signal: lifetimeSignal});
    lifetimeSignal.addEventListener('abort', dispose, {once: true});
    if (lifetimeSignal.aborted) dispose();
    return {ensureTask, ensureProject, current, subscribe, cancelTask, cancelProject, dispose};
}
