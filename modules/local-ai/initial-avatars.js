import {createArcaneEventSource} from 'arcane-os/event-manager';
import {createLocalPreparationController} from './preparation.js';

/** Derive a first avatar from real work through the selected local model owners. */
export function createInitialAvatarPreparation(
    {modelServices, faces, data, getStorage, getSources, getWorkflows, acquireRequest, signal} = {}
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
    const workPreparations = [];
    let activeWorkPreparations = 0;
    let sourcesOpening = null;
    let stopSources = null;
    let workflowsOpening = null;
    let stopWorkflows = null;
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

    function publish(state) {
        if (!closed) events.dispatch(
            'arcane-pm.initial-avatars.state',
            {statuses: [publicState(state)], closed, incremental: true}
        );
    }

    function setStatus(job, status, message, faceId = null) {
        const state = {...job.state, status, message, faceId};
        if (jobs.get(job.key) === job) {
            job.state = state;
            states.set(job.key, state);
            publish(state);
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
                subjectType, subjectId, projectId: subjectType === 'project' ? subjectId : previous?.projectId ?? null,
                authoredFieldRevisions: previous?.authoredFieldRevisions,
                projectDescriptionRevision: previous?.projectDescriptionRevision,
                workTaskIds: previous?.workTaskIds,
                revision, status: 'Thinking', message: 'Thinking', faceId: null
            },
            source: null,
            sourceOrigin: null,
            work: null,
            acquiringSources: false,
            releaseWorkPreparation: null,
            preparation: null,
            descriptionPending: true,
            imageRequested: false,
            stopImage: null,
            stopText: null,
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
        publish(job.state);
        return job.task;
    }

    async function readSubject(job) {
        return job.state.subjectType === 'project'
            ? data.getProject(job.state.subjectId) : data.getTask(job.state.subjectId);
    }

    function authoredRevisions(subjectType, record) {
        if (!record) return null;
        const fields = record.authoredFieldRevisions;
        return subjectType === 'project'
            ? {name: fields?.name ?? 0, description: fields?.description ?? 0}
            : {title: fields?.title ?? 0, assignment: fields?.assignment ?? 0, projectId: fields?.projectId ?? 0};
    }

    function retainMetadata(state, metadata) {
        const key = `${state.subjectType}:${state.subjectId}`;
        const next = {...state, ...metadata};
        const job = jobs.get(key);
        if (job) job.state = next;
        states.set(key, next);
        return next;
    }

    async function prepareAvatar(job) {
        try {
            assertCurrent(job);
            const revisionsBeforeRead = job.state.authoredFieldRevisions;
            const subject = await readSubject(job);
            assertCurrent(job);
            const subjectRevisions = authoredRevisions(job.state.subjectType, subject);
            const observedRevisions = job.state.authoredFieldRevisions;
            if (observedRevisions !== revisionsBeforeRead
                && (observedRevisions === null || Object.keys(observedRevisions).some(
                    function readPredatesAuthoredChange(field) {
                        return observedRevisions[field] > (subjectRevisions?.[field] ?? 0);
                    }
                ))) {
                invalidate(job.state, observedRevisions === null);
                assertCurrent(job);
            }
            retainMetadata(job.state, {
                authoredFieldRevisions: subjectRevisions,
                projectId: job.state.subjectType === 'task' ? subject?.projectId ?? null : job.state.projectId
            });
            if (!subject) {
                return setStatus(job, 'cancelled', 'The work is no longer available.');
            }
            if (subject.faceRef !== null && subject.faceRef !== undefined) {
                return setStatus(job, 'ready', 'Using the saved avatar.', subject.faceRef);
            }
            if (job.state.subjectType === 'project') {
                job.source = {name: subject.name ?? '', description: subject.description ?? ''};
            } else {
                job.sourceOrigin = {
                    provider: subject.origin?.provider ?? null,
                    accountId: subject.origin?.accountId ?? null,
                    hostId: subject.origin?.hostId ?? null,
                    threadId: subject.origin?.threadId ?? null
                };
                job.state = {...job.state, sourceOrigin: job.sourceOrigin};
                states.set(job.key, job.state);
                const descriptionRevisionBeforeRead = job.state.projectDescriptionRevision;
                const project = subject.projectId ? await data.getProject(subject.projectId) : null;
                assertCurrent(job);
                const descriptionRevision = project ? project.authoredFieldRevisions?.description ?? 0 : null;
                const observedDescriptionRevision = job.state.projectDescriptionRevision;
                if (observedDescriptionRevision !== descriptionRevisionBeforeRead
                    && (observedDescriptionRevision === null
                        || observedDescriptionRevision > (descriptionRevision ?? -1))) {
                    invalidate(job.state, false);
                    assertCurrent(job);
                }
                retainMetadata(job.state, {projectDescriptionRevision: descriptionRevision});
                job.source = {
                    title: subject.title ?? '',
                    assignment: subject.assignment ?? '',
                    projectPurpose: project?.description ?? ''
                };
            }
            setStatus(job, 'pending', 'Preparing the local avatar models.');
            assertCurrent(job);
            await modelServices.prepareAvatarModels(
                {signal: job.signal}
            );
            assertCurrent(job);
            const selected = await waitForModels(job);
            assertCurrent(job);
            job.releaseWorkPreparation = await acquireWorkPreparation(job);
            assertCurrent(job);
            await readWorkContext(job);
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
            job.descriptionPending = false;
            for (const entry of job.work.tasks) {
                entry.sources = [];
                entry.history = [];
            }
            job.work.projectSources = [];
            job.releaseWorkPreparation?.();
            job.releaseWorkPreparation = null;
            job.stopText?.();
            job.stopText = null;
            if (typeof description.content !== 'string' || !description.content.trim()) {
                throw new Error('The local text model returned no image description.');
            }
            job.imageRequested = true;
            setStatus(job, 'Thinking', 'Waiting to create the avatar.');
            const parameters = {
                negative_prompt: 'photograph, photorealistic, realistic skin texture, glossy plastic surfaces, text, lettering, captions, labels, watermark, color swatches, palette chart, collage, full-body pose, waist-up composition, half-body portrait, long torso, visible hands, garden scene, floral scenery, decorative frame, oversized crown, floral wreath, monochrome engraving, etching, crosshatching'
            };
            const outcome = job.state.subjectType === 'project'
                ? await faces.ensureInitialProjectFace(
                    {
                        projectId: job.state.subjectId, model: selected.imageModel,
                        prompt: description.content, parameters, source: job.source, signal: job.signal
                    }
                ) : await faces.ensureInitialFace(
                    {
                        taskId: job.state.subjectId, projectId: job.state.projectId,
                        model: selected.imageModel, prompt: description.content, parameters,
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
                    : error?.code === 'PM_AVATAR_NATIVE_ASSOCIATION_UNAVAILABLE'
                        ? 'Reconnect the task conversations before preparing this avatar.'
                        : error?.code === 'PM_AVATAR_SOURCES_UNAVAILABLE'
                            ? 'The complete work sources could not be read. Refresh the sources and try again.'
                            : 'The avatar could not be prepared. Review Local preparation and try again.'
            );
            throw error;
        } finally {
            const preparation = job.preparation;
            job.preparation = null;
            job.source = null;
            job.sourceOrigin = null;
            job.work = null;
            job.releaseWorkPreparation?.();
            job.releaseWorkPreparation = null;
            job.stopImage?.();
            job.stopImage = null;
            job.stopText?.();
            job.stopText = null;
            try {
                await preparation?.dispose();
            } finally {
                if (jobs.get(job.key) === job) jobs.delete(job.key);
            }
        }
    }

    function acquireWorkPreparation(job) {
        setStatus(job, 'pending', 'Waiting to prepare the avatar.');
        assertCurrent(job);
        return new Promise(
            function queueWorkPreparation(resolve, reject) {
                const entry = {job, resolve, aborted};
                function aborted() {
                    const index = workPreparations.indexOf(entry);
                    if (index !== -1) workPreparations.splice(index, 1);
                    job.signal.removeEventListener('abort', aborted);
                    reject(job.signal.reason);
                }
                workPreparations.push(entry);
                job.signal.addEventListener('abort', aborted, {once: true});
                if (job.signal.aborted) aborted();
                startWorkPreparations();
            }
        );
    }

    function startWorkPreparations() {
        while (!closed && activeWorkPreparations < 4 && workPreparations.length) {
            const entry = workPreparations.shift();
            entry.job.signal.removeEventListener('abort', entry.aborted);
            activeWorkPreparations += 1;
            let released = false;
            entry.resolve(
                function releaseWorkPreparation() {
                    if (released) return;
                    released = true;
                    activeWorkPreparations -= 1;
                    startWorkPreparations();
                }
            );
        }
    }

    function resolveSources(job) {
        if (!sourcesOpening) {
            sourcesOpening = Promise.resolve().then(
                function openTaskSources() {
                    lifetimeSignal.throwIfAborted();
                    return getSources();
                }
            ).then(
                function observeTaskSources(sources) {
                    lifetimeSignal.throwIfAborted();
                    stopSources = sources.subscribe(sourcesChanged, {signal: lifetimeSignal});
                    return sources;
                }
            ).catch(
                function sourceOwnerFailed(error) {
                    sourcesOpening = null;
                    if (error?.name !== 'AbortError') {
                        console.error('Arcane PM task source initialization failed.', error);
                    }
                    throw error;
                }
            );
        }
        return new Promise(
            function awaitTaskSourceOwner(resolve, reject) {
                function aborted() {
                    job.signal.removeEventListener('abort', aborted);
                    reject(job.signal.reason);
                }
                job.signal.addEventListener('abort', aborted, {once: true});
                if (job.signal.aborted) aborted();
                sourcesOpening.then(
                    function sourceOwnerReady(sources) {
                        job.signal.removeEventListener('abort', aborted);
                        resolve(sources);
                    },
                    function sourceOwnerUnavailable(error) {
                        job.signal.removeEventListener('abort', aborted);
                        reject(error);
                    }
                );
            }
        );
    }

    function resolveWorkflows(job) {
        if (!workflowsOpening) {
            workflowsOpening = Promise.resolve().then(
                function openAvatarWorkflows() {
                    lifetimeSignal.throwIfAborted();
                    return getWorkflows();
                }
            ).then(
                function observeAvatarWorkflows(workflows) {
                    lifetimeSignal.throwIfAborted();
                    stopWorkflows = workflows.subscribe(
                        workflowsChanged, {signal: lifetimeSignal}
                    );
                    return workflows;
                }
            ).catch(
                function workflowOwnerFailed(error) {
                    workflowsOpening = null;
                    throw error;
                }
            );
        }
        return new Promise(
            function awaitAvatarWorkflowOwner(resolve, reject) {
                function aborted() {
                    job.signal.removeEventListener('abort', aborted);
                    reject(job.signal.reason);
                }
                job.signal.addEventListener('abort', aborted, {once: true});
                if (job.signal.aborted) aborted();
                workflowsOpening.then(
                    function workflowOwnerReady(workflows) {
                        job.signal.removeEventListener('abort', aborted);
                        resolve(workflows);
                    },
                    function workflowOwnerUnavailable(error) {
                        job.signal.removeEventListener('abort', aborted);
                        reject(error);
                    }
                );
            }
        );
    }

    async function readWorkContext(job) {
        setStatus(job, 'pending', 'Reading the complete work and retained sources.');
        try {
            assertCurrent(job);
            job.acquiringSources = true;
            const [sources, workflows] = await Promise.all(
                [resolveSources(job), resolveWorkflows(job)]
            );
            assertCurrent(job);
            const importedOrigins = new Map();
            let revision;
            do {
                revision = job.state.revision;
                try {
                    const options = {signal: job.signal};
                    const taskEntries = job.state.subjectType === 'project'
                        ? (await workflows.getProjectOverview(job.state.subjectId, options)).tasks
                        : [await workflows.getTaskOverview(job.state.subjectId, options)];
                    assertCurrent(job);
                    if (taskEntries.some(function missingTask(entry) { return !entry.task; })
                        || (job.state.subjectType === 'task' && !taskEntries.length)) {
                        throw cancellation('The task is no longer part of this work.');
                    }
                    job.work = {
                        tasks: taskEntries.map(
                            function taskWork(entry) {
                                return {task: entry.task, history: entry.workflow.history, sources: []};
                            }
                        ),
                        projectSources: []
                    };
                    retainMetadata(
                        job.state,
                        {workTaskIds: job.work.tasks.map(function taskIdentity(entry) { return entry.task.id; })}
                    );
                    for (let start = 0; start < job.work.tasks.length; start += 4) {
                        const outcomes = await Promise.allSettled(
                            job.work.tasks.slice(start, start + 4).map(
                                function readMemberWork(entry) {
                                    return readTaskWorkSources(job, sources, entry, importedOrigins);
                                }
                            )
                        );
                        assertCurrent(job);
                        const failures = outcomes.filter(
                            function failedMember(outcome) { return outcome.status === 'rejected'; }
                        ).map(
                            function memberError(outcome) { return outcome.reason; }
                        );
                        if (failures.length) {
                            const error = new AggregateError(failures, 'Some task work sources could not be read.');
                            if (failures.some(
                                function missingNativeAssociation(failure) {
                                    return failure.code === 'PM_AVATAR_NATIVE_ASSOCIATION_UNAVAILABLE';
                                }
                            )) error.code = 'PM_AVATAR_NATIVE_ASSOCIATION_UNAVAILABLE';
                            throw error;
                        }
                    }
                    if (job.state.subjectType === 'project') {
                        const records = await sources.list(
                            {projectId: job.state.subjectId, taskId: null, signal: job.signal}
                        );
                        assertCurrent(job);
                        for (const source of records) {
                            const entry = await sources.read(source.id, options);
                            assertCurrent(job);
                            requireCompleteSources(
                                {sources: [entry], complete: entry.availability === 'retained'}
                            );
                            job.work.projectSources.push(entry);
                        }
                    }
                } catch (error) {
                    assertCurrent(job);
                    if (revision === job.state.revision) throw error;
                    console.error('A superseded avatar work snapshot could not be read completely.', error);
                }
            } while (revision !== job.state.revision);
        } catch (error) {
            if (job.signal.aborted || error?.name === 'AbortError') throw error;
            const failure = new Error('The avatar work and source operation failed.', {cause: error});
            failure.code = error?.code === 'PM_AVATAR_NATIVE_ASSOCIATION_UNAVAILABLE'
                ? error.code : 'PM_AVATAR_SOURCES_UNAVAILABLE';
            throw failure;
        } finally {
            job.acquiringSources = false;
        }
    }

    async function readTaskWorkSources(job, sources, entry, importedOrigins) {
        const origin = entry.task.origin;
        if (origin?.provider === 'codex') {
            const associated = ['accountId', 'hostId', 'threadId'].every(
                function nativeAssociationField(field) {
                    return typeof origin[field] === 'string' && origin[field].trim();
                }
            );
            if (!associated) {
                const error = new Error('The native task association requires its account, host and thread.');
                error.code = 'PM_AVATAR_NATIVE_ASSOCIATION_UNAVAILABLE';
                error.diagnostics = {origin};
                throw error;
            }
            const previous = importedOrigins.get(entry.task.id);
            if (!previous || ['provider', 'accountId', 'hostId', 'threadId'].some(
                function changedOrigin(field) {
                    return previous[field] !== origin[field];
                }
            )) {
                const imported = await sources.importConversation(
                    entry.task.id, {signal: job.signal}
                );
                assertCurrent(job);
                if (imported.coverage?.textComplete !== true) {
                    const error = new Error('The native task conversation text could not be retained completely.');
                    error.diagnostics = {failures: imported.failures, coverage: imported.coverage};
                    throw error;
                }
                if (imported.coverage.complete !== true) {
                    // The description uses retained text; attachment references stay in diagnostics.
                    console.info(
                        'Some conversation attachments remain in their original conversation.',
                        {taskId: entry.task.id, failures: imported.failures, coverage: imported.coverage}
                    );
                }
                importedOrigins.set(entry.task.id, origin);
            }
        }
        const result = await sources.readTaskSources(
            entry.task.id, {signal: job.signal}
        );
        assertCurrent(job);
        requireCompleteSources(result);
        if (result.coverage?.ordered === false) {
            console.info(
                'Retained conversation order is unspecified; preserving the source owner\'s returned order.',
                {taskId: entry.task.id, coverage: result.coverage}
            );
        }
        entry.sources = result.sources;
    }

    function requireCompleteSources(result) {
        const unavailableText = result.sources.filter(
            function sourceTextUnavailable(entry) {
                return typeof entry.content !== 'string' || entry.failures?.length;
            }
        );
        if (!result.complete || unavailableText.length) {
            const error = new Error('The complete retained source text is unavailable to the text model.');
            error.diagnostics = {result, unavailableText};
            throw error;
        }
    }

    function descriptionMessages(job) {
        let messages;
        if (job.state.subjectType === 'project') {
            messages = [
                {
                    role: 'system',
                    content: 'Write one original, concrete image description for an illustrated adult human guide representing this project. The next two user messages contain the complete project name and project description, in that order. Following messages supply complete member-task work, workflow history and retained sources; separate system messages identify their fields. Retained conversation messages preserve their original roles, content and order. Describe only the finished visible picture in concise, concrete prose suitable as an image-generation prompt. Make an individual face with a specific face shape, complexion, eye and nose shapes, hair color and texture, and a relaxed friendly expression. Let the work inspire one small distinctive accessory near the face or collar. Keep attention on that face and accessory. Use warm character illustration with simplified shapes and soft matte dimensional shading. Center the viewer-facing face and complete hairstyle with a small margin; show only the shoulder tops and a simple deep teal collar with restrained muted gold detail. Use a plain pale mint or lavender background. Exclude biography, explanations of symbolism, body poses, hands, scenery, text and labels. Return only the image description.'
                },
                {role: 'user', content: job.source.name},
                {role: 'user', content: job.source.description}
            ];
        } else {
            messages = [
                {
                    role: 'system',
                    content: 'Write one original, concrete image description for an illustrated adult human worker representing this task. The next three user messages contain the complete task title, assignment and project purpose, in that order. Following messages supply complete task work, workflow history and retained sources; separate system messages identify their fields. Retained conversation messages preserve their original roles, content and order. Describe only the finished visible picture in concise, concrete prose suitable as an image-generation prompt. Make an individual face with a specific face shape, complexion, eye and nose shapes, hair color and texture, and a relaxed friendly expression. Let the work inspire one small distinctive accessory near the face or collar. Keep attention on that face and accessory. Use warm character illustration with simplified shapes and soft matte dimensional shading. Center the viewer-facing face and complete hairstyle with a small margin; show only the shoulder tops and a simple deep teal collar with restrained muted gold detail. Use a plain pale mint or lavender background. Exclude biography, explanations of symbolism, body poses, hands, scenery, text and labels. Return only the image description.'
                },
                {role: 'user', content: job.source.title},
                {role: 'user', content: job.source.assignment},
                {role: 'user', content: job.source.projectPurpose}
            ];
        }
        for (const [index, entry] of job.work.tasks.entries()) {
            messages.push(
                {role: 'system', content: `The following work belongs to member task ${index + 1}.`}
            );
            const task = entry.task;
            if (job.state.subjectType === 'project') {
                appendWorkField(messages, 'task title', task.title);
                appendWorkField(messages, 'task assignment', task.assignment ?? '');
            }
            appendWorkField(messages, 'task next action', task.nextAction ?? '');
            for (const decision of task.decisions ?? []) appendWorkField(messages, 'task decision', decision);
            for (const question of task.openQuestions ?? []) appendWorkField(messages, 'task open question', question);
            for (const evidence of task.observedEvidence ?? []) {
                appendWorkField(messages, 'task observed evidence', evidence.message);
                appendWorkField(messages, 'evidence observation time', evidence.observedAt);
            }
            if (task.attention) appendWorkField(messages, 'task attention request', task.attention.message);
            for (const record of entry.history) {
                messages.push(
                    {role: 'system', content: `The following fields belong to one ${record.kind} workflow entry.`}
                );
                for (const field of ['state', 'message', 'actor', 'observedAt', 'blockingEvidence', 'nextAction', 'requestedAt', 'resolvedAt']) {
                    if (typeof record[field] === 'string') appendWorkField(messages, `workflow ${field}`, record[field]);
                }
            }
            appendSourceMessages(messages, entry.sources);
        }
        if (job.work.projectSources.length) {
            messages.push(
                {role: 'system', content: 'The following retained sources belong directly to the project.'}
            );
            appendSourceMessages(messages, job.work.projectSources);
        }
        return messages;
    }

    function appendWorkField(messages, field, content) {
        messages.push(
            {role: 'system', content: `The next user message contains the complete ${field}.`},
            {role: 'user', content}
        );
    }

    function appendSourceMessages(messages, sources) {
        for (const entry of sources) {
            messages.push(
                {role: 'system', content: `The next message contains one complete retained ${entry.source.kind} source.`},
                {role: entry.source.message?.role ?? 'user', content: entry.content}
            );
        }
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
                    if (error) stopText?.();
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
                            const text = modelServices.current().model;
                            if (job.descriptionPending && (text?.providerId !== selected.textModel.providerId
                                || text?.modelId !== selected.textModel.modelId || text?.localOnly !== true
                                || text?.state !== 'ready' || text?.loaded !== true)) {
                                job.controller.abort(cancellation('The selected local text model is no longer ready.'));
                                return;
                            }
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
                        if (selected) job.controller.abort(error);
                        else finish(error);
                    }
                }
                job.signal.addEventListener('abort', aborted, {once: true});
                job.stopImage = imageRuntime.subscribe(observeModels, {replay: true, signal: job.signal});
                if (finished && !selected) return;
                stopText = modelServices.subscribe(observeModels);
                job.stopText = stopText;
                if (job.signal.aborted) stopText();
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

    function sourcesChanged({changes}) {
        if (closed) return;
        const taskIds = new Set();
        const projectIds = new Set();
        for (const change of changes) {
            if (change.contentChanged !== true && change.contentChanged !== null
                && change.associationChanged !== true && change.originalChanged !== true) continue;
            if (change.contentChanged === null) {
                console.info('Retained source content comparison is unavailable after a committed import.', change);
            }
            if (change.taskId !== null && change.taskId !== undefined) taskIds.add(change.taskId);
            if (change.previousTaskId !== null && change.previousTaskId !== undefined) {
                taskIds.add(change.previousTaskId);
            }
            if (change.projectId !== null && change.projectId !== undefined) projectIds.add(change.projectId);
            if (change.previousProjectId !== null && change.previousProjectId !== undefined) {
                projectIds.add(change.previousProjectId);
            }
        }
        for (const state of Array.from(states.values())) {
            const relevant = state.subjectType === 'task' ? taskIds.has(state.subjectId)
                : projectIds.has(state.subjectId) || state.workTaskIds?.some(
                    function changedMember(taskId) { return taskIds.has(taskId); }
                );
            if (relevant) invalidateWork(state);
        }
    }

    function workflowsChanged(change) {
        if (closed || change.action === 'guide') return;
        for (const state of Array.from(states.values())) {
            const relevant = state.subjectType === 'task' ? state.subjectId === change.taskId
                : state.subjectId === change.projectId || state.workTaskIds?.includes(change.taskId);
            if (relevant) invalidateWork(state);
        }
    }

    function invalidateWork(state) {
        if (state.faceId !== null && state.faceId !== undefined) return;
        const key = `${state.subjectType}:${state.subjectId}`;
        const job = jobs.get(key);
        if (job?.acquiringSources) {
            const revision = (revisions.get(key) ?? 0) + 1;
            revisions.set(key, revision);
            job.state = {...job.state, revision};
            states.set(key, job.state);
        } else {
            invalidate(state, false);
        }
    }

    function sameWorkValue(left, right) {
        if (left === right) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        const keys = Object.keys(left);
        return keys.length === Object.keys(right).length && keys.every(
            function sameWorkMember(key) {
                return Object.hasOwn(right, key) && sameWorkValue(left[key], right[key]);
            }
        );
    }

    function taskWorkChanged(change) {
        const extraFields = ['nextAction', 'decisions', 'openQuestions', 'observedEvidence', 'attention'];
        const projectFields = ['title', 'assignment', 'projectId', 'origin', ...extraFields];
        for (const state of Array.from(states.values())) {
            if (state.faceId !== null && state.faceId !== undefined) continue;
            const key = `${state.subjectType}:${state.subjectId}`;
            const job = jobs.get(key);
            const project = state.subjectType === 'project';
            const membershipUnknown = project && job?.acquiringSources
                && (!change.record || change.changedFields?.includes('projectId'));
            const relevant = project
                ? state.subjectId === change.record?.projectId || state.workTaskIds?.includes(change.id) || membershipUnknown
                : state.subjectId === change.id;
            if (!relevant) continue;
            const entry = job?.work?.tasks.find(
                function currentTaskWork(value) { return value.task.id === change.id; }
            );
            const fields = project ? projectFields : extraFields;
            const changed = entry && change.record ? fields.some(
                function changedWorkField(field) {
                    return !sameWorkValue(entry.task[field], change.record[field]);
                }
            ) : project && (!change.record || change.action === 'created' || membershipUnknown)
                || change.changedFields?.some(
                    function suppliedWorkField(field) { return fields.includes(field); }
                );
            if (changed) invalidateWork(state);
        }
    }

    function dataChanged(change) {
        const key = `${change.recordType}:${change.id}`;
        let state = states.get(key);
        const record = change.record;
        const removed = change.action === 'removed' || (change.action === 'refreshed' && record === null);
        const active = jobs.get(key);
        const previousRevisions = state?.authoredFieldRevisions;
        const nextRevisions = authoredRevisions(change.recordType, record);
        const authoredSourceChanged = state && previousRevisions !== undefined
            && (previousRevisions === null || nextRevisions === null
                ? previousRevisions !== nextRevisions
                : Object.keys(nextRevisions).some(function authoredFieldChanged(field) {
                    return previousRevisions[field] !== nextRevisions[field];
                }));
        const settledTaskProjectChanged = state && !jobs.has(key) && change.recordType === 'task'
            && record && state.projectId !== (record.projectId ?? null);
        const activeSourceChanged = active?.source && record && (change.recordType === 'project'
            ? active.source.name !== (record.name ?? '') || active.source.description !== (record.description ?? '')
            : active.source.title !== (record.title ?? '') || active.source.assignment !== (record.assignment ?? '')
                || active.state.projectId !== (record.projectId ?? null));
        if (state) {
            const metadata = {authoredFieldRevisions: nextRevisions};
            if (change.recordType === 'task' && record) {
                metadata.projectId = record.projectId ?? null;
                if (state.projectId !== metadata.projectId) metadata.projectDescriptionRevision = undefined;
            }
            state = retainMetadata(state, metadata);
        }
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
                const next = {
                    ...state, projectId: change.recordType === 'task' ? record.projectId ?? null : state.projectId,
                    status: 'ready', message: 'Using the saved avatar.', faceId: record.faceRef
                };
                states.set(key, next);
                publish(next);
            }
        } else if (state?.faceId !== null && state?.faceId !== undefined && record) {
            state = {
                ...state, projectId: change.recordType === 'task' ? record.projectId ?? null : state.projectId,
                status: 'cancelled', message: 'The avatar selection was cleared.', faceId: null
            };
            states.set(key, state);
            publish(state);
        }
        const changed = change.changedFields ?? [];
        const originChanged = record && state?.sourceOrigin && change.recordType === 'task'
            && ['provider', 'accountId', 'hostId', 'threadId'].some(
                function conversationAssociationChanged(field) {
                    return state.sourceOrigin[field] !== (record?.origin?.[field] ?? null);
                }
            );
        const directSourceChange = (removed && previousRevisions !== null)
            || authoredSourceChanged || activeSourceChanged || originChanged || settledTaskProjectChanged
            || (change.recordType === 'task' && changed.includes('origin') && !state?.sourceOrigin);
        if (state && !facePresent && directSourceChange) invalidate(state, removed);
        if (change.recordType === 'project') {
            for (const taskState of Array.from(states.values())) {
                if (taskState.subjectType !== 'task' || taskState.projectId !== change.id) continue;
                const taskJob = jobs.get(`task:${taskState.subjectId}`);
                const descriptionRevision = record ? record.authoredFieldRevisions?.description ?? 0 : null;
                const purposeChanged = (taskState.projectDescriptionRevision !== undefined
                    && taskState.projectDescriptionRevision !== descriptionRevision)
                    || (taskJob?.source && taskJob.source.projectPurpose !== (record?.description ?? ''));
                const next = retainMetadata(taskState, {projectDescriptionRevision: descriptionRevision});
                if (purposeChanged) invalidate(next, false);
            }
        }
        if (change.recordType === 'task') taskWorkChanged(change);
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
            const next = {
                ...state, revision, status: 'cancelled', message: 'The work is no longer available.', faceId: null
            };
            states.set(key, next);
            publish(next);
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
        stopSources?.();
        stopSources = null;
        stopWorkflows?.();
        stopWorkflows = null;
        closing = Promise.allSettled(Array.from(pending)).then(
            function initialAvatarPreparationDisposed() {
                jobs.clear();
                states.clear();
                revisions.clear();
                sourcesOpening = null;
                workflowsOpening = null;
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
