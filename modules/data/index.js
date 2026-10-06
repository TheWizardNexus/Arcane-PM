import {arcaneEvents, createArcaneEventSource} from 'arcane-os/event-manager';

export const DATA_CHANGED_EVENT = 'arcane-pm.data.changed';

const tables = {project: 'pm_projects', task: 'pm_tasks'};
const pendingEdits = new Map();
let storagePromise;
const events = createArcaneEventSource(tables, {
    source: 'arcane-pm.data',
    eventTypes: [DATA_CHANGED_EVENT]
});

function dataError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** Reuse the published SDK's one app-scoped connection, without blocking imports. */
export function getStorage() {
    if (!storagePromise) {
        storagePromise = openStorage();
        storagePromise.catch(function releaseFailedStorageAttempt() {
            storagePromise = undefined;
        });
    }
    return storagePromise;
}

async function openStorage() {
    if (!globalThis.navigator?.storage?.getDirectory || !globalThis.window) {
        throw dataError('PM_DATA_STORAGE_UNAVAILABLE', 'Local application storage is unavailable in this browser.');
    }
    await import('arcane-os/modules/DBOPFS.js');
    const db = globalThis.window.dbopfs;
    if (!db) {
        throw dataError('PM_DATA_STORAGE_UNAVAILABLE', 'Arcane application storage did not open.');
    }
    await db.readyPromise;
    if (db.applicationId !== 'arcane-pm') {
        throw dataError('PM_DATA_STORAGE_UNAVAILABLE', 'The open storage connection belongs to a different application.');
    }
    return db;
}

function requireRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw dataError('PM_DATA_INPUT', `${label} must be a record.`);
    }
    return value;
}

function requireFields(value, fields, label) {
    requireRecord(value, label);
    for (const key of Object.keys(value)) {
        if (!fields.includes(key)) {
            throw dataError('PM_DATA_INPUT', `${label}.${key} is not a supported field.`);
        }
    }
    return value;
}

function text(value, label, nonblank = false) {
    if (typeof value !== 'string' || (nonblank && !value.trim())) {
        throw dataError('PM_DATA_INPUT', `${label} must be ${nonblank ? 'a nonblank' : 'a'} string.`);
    }
    return value;
}

function optionalText(value, label) {
    return value === null ? null : text(value, label);
}

function textList(value, label) {
    if (!Array.isArray(value)) {
        throw dataError('PM_DATA_INPUT', `${label} must be an array of strings.`);
    }
    return value.map(function copyCompleteText(item, index) {
        return text(item, `${label}[${index}]`);
    });
}

function originReference(value) {
    if (value === null) return null;
    const fields = ['provider', 'accountId', 'projectId', 'threadId', 'hostId', 'url'];
    requireFields(value, fields, 'origin');
    const result = {provider: text(value.provider, 'origin.provider', true)};
    for (const key of fields) {
        if (key !== 'provider') result[key] = optionalText(value[key] ?? null, `origin.${key}`);
    }
    return result;
}

function assigneeReference(value) {
    if (value === null) return null;
    requireFields(value, ['kind', 'id', 'name'], 'assignee');
    return {
        kind: text(value.kind, 'assignee.kind', true),
        id: text(value.id, 'assignee.id'),
        name: text(value.name, 'assignee.name')
    };
}

function observedEvidence(value) {
    if (!Array.isArray(value)) {
        throw dataError('PM_DATA_INPUT', 'observedEvidence must be an array.');
    }
    return value.map(function copyObservation(item) {
        requireFields(item, ['message', 'observedAt', 'sourceRef'], 'observedEvidence');
        return {
            message: text(item.message, 'observedEvidence.message'),
            observedAt: text(item.observedAt, 'observedEvidence.observedAt', true),
            sourceRef: optionalText(item.sourceRef ?? null, 'observedEvidence.sourceRef')
        };
    });
}

function attentionRecord(value) {
    if (value === null) return null;
    requireFields(value, ['message', 'requestedAt', 'sourceRef'], 'attention');
    return {
        message: text(value.message, 'attention.message', true),
        requestedAt: text(value.requestedAt, 'attention.requestedAt', true),
        sourceRef: optionalText(value.sourceRef ?? null, 'attention.sourceRef')
    };
}

function projectChanges(input) {
    requireFields(input, ['name', 'description', 'workFolder', 'origin'], 'project');
    const changes = {};
    for (const [field, value] of Object.entries(input)) {
        switch (field) {
            case 'name': changes.name = text(value, field, true); break;
            case 'description': changes.description = text(value, field); break;
            case 'workFolder': changes.workFolder = optionalText(value, field); break;
            case 'origin': changes.origin = originReference(value); break;
        }
    }
    return changes;
}

function taskChanges(input) {
    requireFields(input, [
        'title', 'projectId', 'assignment', 'workFolder', 'origin', 'assignee',
        'status', 'observedEvidence', 'sourceRefs', 'resultRefs', 'faceRef',
        'decisions', 'openQuestions', 'attention', 'nextAction'
    ], 'task');
    const changes = {};
    for (const [field, value] of Object.entries(input)) {
        switch (field) {
            case 'title':
            case 'status': changes[field] = text(value, field, true); break;
            case 'assignment':
            case 'nextAction': changes[field] = text(value, field); break;
            case 'projectId':
            case 'workFolder':
            case 'faceRef': changes[field] = optionalText(value, field); break;
            case 'origin': changes.origin = originReference(value); break;
            case 'assignee': changes.assignee = assigneeReference(value); break;
            case 'observedEvidence': changes.observedEvidence = observedEvidence(value); break;
            case 'sourceRefs':
            case 'resultRefs':
            case 'decisions':
            case 'openQuestions': changes[field] = textList(value, field); break;
            case 'attention': changes.attention = attentionRecord(value); break;
        }
    }
    return changes;
}

function fileName(id) {
    text(id, 'id', true);
    // Filename encoding is transport-local; the record keeps its original ID.
    return `${encodeURIComponent(id)}.json`;
}

function checkCancellation(signal) {
    if (signal?.aborted) throw new DOMException('The record operation was cancelled.', 'AbortError');
}

function recordIncludesQuery(value, query) {
    if (typeof value === 'string') return value.toLocaleLowerCase().includes(query);
    if (value && typeof value === 'object') {
        return Object.values(value).some(function fieldIncludesQuery(field) {
            return recordIncludesQuery(field, query);
        });
    }
    return false;
}

/** A mutation serializes only the read/write pair for the same PM record. */
function editRecord(recordType, id, operation) {
    const key = `arcane-pm:${tables[recordType]}:${fileName(id)}`;
    if (globalThis.navigator?.locks?.request) {
        return navigator.locks.request(key, operation);
    }
    const previous = pendingEdits.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    pendingEdits.set(key, current);
    function releaseRecordEdit() {
        if (pendingEdits.get(key) === current) pendingEdits.delete(key);
    }
    current.then(releaseRecordEdit, releaseRecordEdit);
    return current;
}

function readStoredRecord(value, recordType, id) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== id) {
        throw dataError('PM_DATA_RECORD_UNREADABLE', `The saved ${recordType} record ${id} could not be read.`);
    }
    return structuredClone(value);
}

async function readRecord(recordType, id) {
    const key = fileName(id);
    const db = await getStorage();
    return readStoredRecord(await db.get(tables[recordType], key, true), recordType, id);
}

function publishChange(recordType, action, id, record) {
    events.dispatch(DATA_CHANGED_EVENT, {
        recordType, action, id, record: record === null ? null : structuredClone(record)
    });
}

async function saveNew(recordType, record) {
    const db = await getStorage();
    await db.set(tables[recordType], fileName(record.id), record);
    publishChange(recordType, 'created', record.id, record);
    return structuredClone(record);
}

function updateRecord(recordType, id, changes, action = 'updated') {
    return editRecord(recordType, id, async function saveSelectedRecordChange() {
        const record = await readRecord(recordType, id);
        if (record === null) {
            throw dataError('PM_DATA_NOT_FOUND', `The ${recordType} record ${id} is unavailable.`);
        }
        const selectedChanges = typeof changes === 'function'
            ? changes(structuredClone(record))
            : changes;
        Object.assign(record, selectedChanges, {updatedAt: new Date().toISOString()});
        const db = await getStorage();
        await db.set(tables[recordType], fileName(id), record);
        publishChange(recordType, action, id, record);
        return structuredClone(record);
    });
}

function removeRecord(recordType, id) {
    return editRecord(recordType, id, async function removeSelectedPMRecord() {
        const db = await getStorage();
        const value = await db.get(tables[recordType], fileName(id), true);
        if (value === null) return {removed: false, recordType, id};
        await db.delete(tables[recordType], fileName(id));
        publishChange(recordType, 'removed', id, null);
        return {removed: true, recordType, id};
    });
}

async function listRecords(recordType, options) {
    const allowed = recordType === 'task'
        ? ['archived', 'query', 'signal', 'projectId', 'status']
        : ['archived', 'query', 'signal'];
    requireFields(options, allowed, 'list');
    if (options.archived !== undefined && typeof options.archived !== 'boolean') {
        throw dataError('PM_DATA_INPUT', 'archived must be a boolean when supplied.');
    }
    if (options.projectId !== undefined) optionalText(options.projectId, 'projectId');
    if (options.status !== undefined) text(options.status, 'status');
    const query = options.query === undefined ? '' : text(options.query, 'query').toLocaleLowerCase();
    checkCancellation(options.signal);
    const db = await getStorage();
    checkCancellation(options.signal);
    const keys = await db.getAllKeys(tables[recordType]);
    const records = [];
    const failures = [];
    let position = 0;
    async function readNextPMRecord() {
        while (position < keys.length) {
            checkCancellation(options.signal);
            const key = keys[position++];
            try {
                const id = decodeURIComponent(key.replace(/\.json$/, ''));
                const record = readStoredRecord(await db.get(tables[recordType], key, true), recordType, id);
                if (record === null) continue;
                if (options.archived !== undefined && Boolean(record.archivedAt) !== options.archived) continue;
                if (options.projectId !== undefined && record.projectId !== options.projectId) continue;
                if (options.status !== undefined && record.status !== options.status) continue;
                if (query && !recordIncludesQuery(record, query)) continue;
                records.push(record);
            } catch (error) {
                failures.push({key, error});
            }
        }
    }
    // Four active OPFS reads keep large lists responsive without launching a job per row.
    const readers = [];
    for (let index = 0; index < Math.min(4, keys.length); index++) readers.push(readNextPMRecord());
    await Promise.all(readers);
    checkCancellation(options.signal);
    records.sort(function orderPMRecords(left, right) {
        const created = String(left.createdAt).localeCompare(String(right.createdAt));
        return created || left.id.localeCompare(right.id);
    });
    if (failures.length) {
        const error = new AggregateError(failures.map(function recordFailure(failure) {
            return failure.error;
        }), `Some saved ${recordType} records could not be read.`);
        error.code = 'PM_DATA_RECORD_UNREADABLE';
        error.records = records;
        error.failures = failures;
        throw error;
    }
    return records;
}

export async function createProject(input) {
    const changes = projectChanges(input);
    text(changes.name, 'name', true);
    const now = new Date().toISOString();
    const record = {
        id: crypto.randomUUID(), name: changes.name, description: '', workFolder: null,
        origin: null, createdAt: now, updatedAt: now, archivedAt: null
    };
    Object.assign(record, changes);
    return saveNew('project', record);
}

export function getProject(id) { return readRecord('project', id); }
export async function updateProject(id, changes) { return updateRecord('project', id, projectChanges(changes)); }
export function listProjects(options = {}) { return listRecords('project', options); }
export async function archiveProject(id) { return updateRecord('project', id, {archivedAt: new Date().toISOString()}, 'archived'); }
export async function restoreProject(id) { return updateRecord('project', id, {archivedAt: null}, 'restored'); }
export async function removeProjectRecord(id) { return removeRecord('project', id); }

export async function createTask(input) {
    const changes = taskChanges(input);
    text(changes.title, 'title', true);
    const now = new Date().toISOString();
    const record = {
        id: crypto.randomUUID(), title: changes.title, projectId: null, assignment: '',
        workFolder: null, origin: null, assignee: null, status: 'idle', observedEvidence: [],
        sourceRefs: [], resultRefs: [], faceRef: null, decisions: [], openQuestions: [],
        attention: null, nextAction: '', createdAt: now, updatedAt: now, archivedAt: null
    };
    Object.assign(record, changes);
    return saveNew('task', record);
}

export function getTask(id) { return readRecord('task', id); }
export async function updateTask(id, changes) {
    if (typeof changes !== 'function') return updateRecord('task', id, taskChanges(changes));
    return updateRecord('task', id, function changesFromCurrentTask(record) {
        const selected = changes(record);
        if (selected && typeof selected.then === 'function') {
            Promise.resolve(selected).catch(function observeUnsupportedAsyncUpdater(error) {
                console.error('The asynchronous task updater rejected after returning unsupported input.', error);
            });
            throw dataError('PM_DATA_INPUT', 'The task updater must return its changes synchronously.');
        }
        return taskChanges(selected);
    });
}
export function listTasks(options = {}) { return listRecords('task', options); }
export async function archiveTask(id) { return updateRecord('task', id, {archivedAt: new Date().toISOString()}, 'archived'); }
export async function restoreTask(id) { return updateRecord('task', id, {archivedAt: null}, 'restored'); }
export async function removeTaskRecord(id) { return removeRecord('task', id); }
export async function setTaskFace(id, faceRef) { return updateTask(id, {faceRef}); }

/** Attach a completed first-face candidate only while its task and request still match. */
export async function setTaskFaceIfEmpty(id, faceRef, {isCurrent, signal} = {}) {
    text(faceRef, 'faceRef', true);
    if (isCurrent !== undefined && typeof isCurrent !== 'function') {
        throw dataError('PM_DATA_INPUT', 'isCurrent must be a synchronous task predicate.');
    }
    checkCancellation(signal);
    return editRecord('task', id, async function associateFirstTaskFace() {
        checkCancellation(signal);
        const db = await getStorage();
        const record = readStoredRecord(await db.get(tables.task, fileName(id), true), 'task', id);
        checkCancellation(signal);
        if (record === null) return {applied: false, reason: 'task-missing', task: null};
        if (record.faceRef !== null && record.faceRef !== undefined) {
            return {applied: false, reason: 'face-present', task: record};
        }
        if (isCurrent) {
            const current = isCurrent(structuredClone(record));
            if (current && typeof current.then === 'function') {
                Promise.resolve(current).catch(function observeUnsupportedAsyncFacePredicate(error) {
                    console.error('The asynchronous task-face predicate rejected after returning unsupported input.', error);
                });
            }
            if (typeof current !== 'boolean') {
                throw dataError('PM_DATA_INPUT', 'isCurrent must return a boolean synchronously.');
            }
            if (!current) return {applied: false, reason: 'request-stale', task: record};
        }
        checkCancellation(signal);
        record.faceRef = faceRef;
        record.updatedAt = new Date().toISOString();
        await db.set(tables.task, fileName(id), record);
        publishChange('task', 'updated', id, record);
        return {applied: true, reason: 'assigned', task: structuredClone(record)};
    });
}

export function subscribe(handler, options = {}) {
    if (typeof handler !== 'function') throw dataError('PM_DATA_INPUT', 'subscribe requires a handler.');
    return arcaneEvents.subscribe(DATA_CHANGED_EVENT, function forwardPMRecordChange(occurrence) {
        handler(occurrence.detail);
    }, options);
}

export const pmData = {
    getStorage, createProject, getProject, updateProject, listProjects,
    archiveProject, restoreProject, removeProjectRecord,
    createTask, getTask, updateTask, listTasks, archiveTask, restoreTask,
    removeTaskRecord, setTaskFace, setTaskFaceIfEmpty, subscribe
};

export default pmData;
