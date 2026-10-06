import {arcaneEvents, createArcaneEventSource} from 'arcane-os/event-manager';

export const WORKFLOW_CHANGED_EVENT = 'arcane-pm.workflows.changed';

/** PM guide associations and attributed observations; shared I/O stays in DBOPFS. */
export function createWorkflowService({pmData, getStorage}) {
    const owner = {};
    let disposed = false;
    const events = createArcaneEventSource(
        owner,
        {source: 'arcane-pm.workflows', eventTypes: [WORKFLOW_CHANGED_EVENT]}
    );

    async function getProjectOverview(projectId, {signal} = {}) {
        requireText(projectId, 'Project', true);
        signal?.throwIfAborted();
        const [project, tasks, storage] = await Promise.all(
            [pmData.getProject(projectId), pmData.listTasks({projectId, signal}), getStorage()]
        );
        signal?.throwIfAborted();
        if (!project) throw workflowError('PM_WORKFLOW_NOT_FOUND', 'This project is no longer available.');

        const taskIds = new Set(tasks.map(taskIdOf));
        const [guide, keys] = await Promise.all(
            [storage.get('pm_project_guides', fileKey(projectId), true), storage.getAllKeys('pm_workflow_events')]
        );
        const selectedKeys = keys.filter(
            function belongsToSelectedTask(key) {
                return taskIds.has(key.split('.')[0]);
            }
        );
        const records = [];
        const failures = [];
        let position = 0;

        async function readWorkflowRows() {
            while (position < selectedKeys.length) {
                signal?.throwIfAborted();
                const key = selectedKeys[position++];
                try {
                    const record = await storage.get('pm_workflow_events', key, true);
                    if (record) records.push(structuredClone(record));
                } catch (error) {
                    failures.push({key, error});
                }
            }
        }

        const readers = [];
        for (let index = 0; index < Math.min(4, selectedKeys.length); index++) {
            readers.push(readWorkflowRows());
        }
        await Promise.all(readers);
        signal?.throwIfAborted();
        if (failures.length) {
            const error = new AggregateError(failures.map(errorOf), 'Some project workflow records could not be read.');
            error.code = 'PM_WORKFLOW_READ';
            error.records = records;
            error.failures = failures;
            throw error;
        }

        records.sort(orderRecordedEvents);
        const byTask = new Map();
        for (const record of records) {
            if (!byTask.has(record.taskId)) byTask.set(record.taskId, []);
            byTask.get(record.taskId).push(record);
        }

        return {
            project,
            guide: guide ? structuredClone(guide) : null,
            tasks: tasks.map(
                function includeTaskWorkflow(task) {
                    const history = byTask.get(task.id) || [];
                    const observations = history.filter(isObservation);
                    const resolutions = new Map();
                    for (const record of history) {
                        if (record.kind === 'attention-resolved') resolutions.set(record.attentionId, record);
                    }
                    const attentionRequests = history.filter(isAttentionRequest).map(
                        function includeAttentionResolution(request) {
                            return {request, resolution: resolutions.get(request.id) || null};
                        }
                    );
                    return {
                        task,
                        workflow: {
                            history,
                            observations,
                            attentionRequests,
                            latestObservation: observations.at(-1) || null
                        }
                    };
                }
            )
        };
    }

    async function assign(taskId, assignment, {signal} = {}) {
        signal?.throwIfAborted();
        requireText(assignment, 'Assignment');
        const task = await pmData.updateTask(taskId, {assignment});
        changed(task.projectId, taskId, 'assignment');
        return task;
    }

    async function setNextAction(taskId, nextAction, {signal} = {}) {
        signal?.throwIfAborted();
        requireText(nextAction, 'Next action');
        const task = await pmData.updateTask(taskId, {nextAction});
        changed(task.projectId, taskId, 'next-action');
        return task;
    }

    async function recordObservation(taskId, observation, {signal} = {}) {
        const input = {
            state: requireText(observation.state, 'Observed state', true),
            message: requireText(observation.message, 'Observed evidence', true),
            actor: requireText(observation.actor, 'Observer', true),
            observedAt: requireText(observation.observedAt, 'Observation time', true),
            source: observation.source || 'local-pm',
            sourceRef: observation.sourceRef ?? null,
            blockingEvidence: observation.blockingEvidence ?? '',
            nextAction: observation.nextAction ?? ''
        };
        if (!['local-pm', 'connected-task'].includes(input.source)) {
            throw workflowError('PM_WORKFLOW_INPUT', 'Choose local PM evidence or connected-task evidence.');
        }
        if (input.sourceRef !== null) requireText(input.sourceRef, 'Source reference');
        requireText(input.blockingEvidence, 'Blocking evidence');
        requireText(input.nextAction, 'Next action');
        if (input.source === 'connected-task') requireText(input.sourceRef, 'Connected-task reference', true);
        if (input.state === 'stalled') {
            requireText(input.blockingEvidence, 'Concrete blocking evidence', true);
            requireText(input.nextAction, 'Next action for the stalled task', true);
        }

        const record = await saveEvent(taskId, 'observation', input, signal);
        const task = await applyTaskRecord(
            taskId,
            function appendObservedEvidence(current) {
                const changes = {
                    status: input.state,
                    observedEvidence: current.observedEvidence.concat(
                        {message: input.message, observedAt: input.observedAt, sourceRef: input.sourceRef}
                    )
                };
                if (input.nextAction) changes.nextAction = input.nextAction;
                return changes;
            },
            record
        );
        changed(task.projectId, taskId, 'observation');
        return {task, observation: record};
    }

    async function requestAttention(taskId, request, {signal} = {}) {
        const input = {
            message: requireText(request.message, 'Attention request', true),
            nextAction: requireText(request.nextAction, 'Next action', true),
            actor: requireText(request.actor, 'Requester', true),
            sourceRef: request.sourceRef ?? null,
            requestedAt: request.requestedAt || new Date().toISOString()
        };
        if (input.sourceRef !== null) requireText(input.sourceRef, 'Source reference');
        requireText(input.requestedAt, 'Request time', true);
        const record = await saveEvent(taskId, 'attention-requested', input, signal);
        const task = await applyTaskRecord(
            taskId,
            {
                attention: {message: input.message, requestedAt: input.requestedAt, sourceRef: input.sourceRef},
                nextAction: input.nextAction
            },
            record
        );
        changed(task.projectId, taskId, 'attention-requested');
        return {task, request: record};
    }

    async function resolveAttention(taskId, attentionId, resolution, {signal} = {}) {
        signal?.throwIfAborted();
        const storage = await getStorage();
        signal?.throwIfAborted();
        const request = await storage.get('pm_workflow_events', eventKey(taskId, attentionId), true);
        if (!request || request.kind !== 'attention-requested') {
            throw workflowError('PM_WORKFLOW_NOT_FOUND', 'This attention request is unavailable. Refresh its history.');
        }
        const record = await saveEvent(
            taskId,
            'attention-resolved',
            {
                attentionId,
                message: requireText(resolution.message, 'Resolution', true),
                actor: requireText(resolution.actor, 'Responder', true),
                resolvedAt: requireText(resolution.resolvedAt || new Date().toISOString(), 'Resolution time', true)
            },
            signal
        );
        let attentionCleared = false;
        const task = await applyTaskRecord(
            taskId,
            function resolveOnlyTheSelectedAttention(current) {
                const attention = current.attention;
                if (attention?.message === request.message
                    && attention?.requestedAt === request.requestedAt
                    && attention?.sourceRef === request.sourceRef) {
                    attentionCleared = true;
                    return {attention: null};
                }
                return {};
            },
            record
        );
        changed(task.projectId, taskId, 'attention-resolved');
        return {task, resolution: record, attentionCleared};
    }

    async function setGuide(projectId, {name, taskId = null}, {signal} = {}) {
        signal?.throwIfAborted();
        requireText(name, 'Guide name', true);
        const project = await pmData.getProject(projectId);
        if (!project) throw workflowError('PM_WORKFLOW_NOT_FOUND', 'This project is no longer available.');
        if (taskId !== null) {
            const task = await pmData.getTask(taskId);
            if (!task || task.projectId !== projectId) {
                throw workflowError('PM_WORKFLOW_INPUT', 'Choose a guide task from this project.');
            }
        }
        const storage = await getStorage();
        const existing = await storage.get('pm_project_guides', fileKey(projectId), true);
        const now = new Date().toISOString();
        const guide = {projectId, name, taskId, createdAt: existing?.createdAt || now, updatedAt: now};
        signal?.throwIfAborted();
        await storage.set('pm_project_guides', fileKey(projectId), guide);
        changed(projectId, taskId, 'guide');
        return structuredClone(guide);
    }

    async function saveEvent(taskId, kind, fields, signal) {
        signal?.throwIfAborted();
        const task = await pmData.getTask(taskId);
        signal?.throwIfAborted();
        if (!task) throw workflowError('PM_WORKFLOW_NOT_FOUND', 'This task is no longer available.');
        const record = Object.assign(
            {id: crypto.randomUUID(), taskId, projectId: task.projectId, kind, recordedAt: new Date().toISOString()},
            fields
        );
        const storage = await getStorage();
        signal?.throwIfAborted();
        // The entry and its task update finish once this first durable write starts.
        await storage.set('pm_workflow_events', eventKey(taskId, record.id), record);
        changed(task.projectId, taskId, kind);
        return structuredClone(record);
    }

    async function applyTaskRecord(taskId, changes, savedRecord) {
        try {
            return await pmData.updateTask(taskId, changes);
        } catch (cause) {
            const error = new Error('The workflow entry was saved, and its task update failed.', {cause});
            error.code = 'PM_WORKFLOW_TASK_UPDATE';
            error.savedRecord = savedRecord;
            throw error;
        }
    }

    function changed(projectId, taskId, action) {
        if (disposed) return;
        events.dispatch(WORKFLOW_CHANGED_EVENT, {projectId, taskId, action});
    }

    function subscribe(handler, options = {}) {
        return arcaneEvents.subscribe(
            WORKFLOW_CHANGED_EVENT,
            function forwardWorkflowChange(occurrence) {
                handler(occurrence.detail);
            },
            options
        );
    }

    function dispose() {
        disposed = true;
        events.dispose();
    }

    return {getProjectOverview, assign, recordObservation, requestAttention, resolveAttention, setNextAction, setGuide, subscribe, dispose};
}

function requireText(value, label, nonblank = false) {
    if (typeof value !== 'string' || (nonblank && !value.trim())) {
        throw workflowError('PM_WORKFLOW_INPUT', `${label} must be ${nonblank ? 'nonblank ' : ''}text.`);
    }
    return value;
}

function workflowError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function fileKey(id) {
    requireText(id, 'Record identifier', true);
    return `${encodeURIComponent(id)}.json`;
}

function eventKey(taskId, eventId) {
    return `${encodeURIComponent(taskId)}.${encodeURIComponent(eventId)}.json`;
}

function taskIdOf(task) {
    return encodeURIComponent(task.id);
}

function errorOf(failure) {
    return failure.error;
}

function orderRecordedEvents(left, right) {
    return left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id);
}

function isObservation(record) {
    return record.kind === 'observation';
}

function isAttentionRequest(record) {
    return record.kind === 'attention-requested';
}
