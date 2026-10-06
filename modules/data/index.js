import {arcaneEvents, createArcaneEventSource} from 'arcane-os/event-manager';

export const DATA_CHANGED_EVENT = 'arcane-pm.data.changed';

const tables = {project: 'pm_projects', task: 'pm_tasks'};
const pendingEdits = new Map();
const knownRecords = {project: new Set(), task: new Set()};
const pendingRefreshes = new Map();
let activeRefreshes = 0;
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
    const lifetime = new AbortController();
    db.subscribeChanges(storageRecordChanged, {signal: lifetime.signal});
    globalThis.addEventListener('pagehide', function closeRecordNotifications(event) {
        pendingRefreshes.clear();
        if (event.persisted) return;
        lifetime.abort();
        knownRecords.project.clear();
        knownRecords.task.clear();
    }, {signal: lifetime.signal});
    return db;
}

function storageRecordChanged(occurrence) {
    const change = occurrence.detail;
    const recordType = Object.keys(tables).find(function matchingPMTable(type) {
        return tables[type] === change.tableName;
    });
    if (!recordType) return;
    if (change.action === 'table-delete') {
        for (const id of knownRecords[recordType]) queueRecordRefresh(recordType, id);
        return;
    }
    if (!change.fileName?.endsWith('.json')) return;
    const id = decodeURIComponent(change.fileName.replace(/\.json$/, ''));
    if (change.remote) queueRecordRefresh(recordType, id);
    // Local PM writers publish the precise domain event after their SDK write.
    else pendingRefreshes.delete(`${recordType}:${id}`);
}

function queueRecordRefresh(recordType, id) {
    knownRecords[recordType].add(id);
    const key = `${recordType}:${id}`;
    const pending = pendingRefreshes.get(key);
    if (pending) pending.revision++;
    else pendingRefreshes.set(key, {key, recordType, id, revision: 0, reading: false});
    refreshChangedRecords();
}

function refreshChangedRecords() {
    for (const pending of pendingRefreshes.values()) {
        if (activeRefreshes >= 4) return;
        if (pending.reading) continue;
        pending.reading = true;
        activeRefreshes++;
        refreshChangedRecord(pending).finally(function releaseRecordRefresh() {
            activeRefreshes--;
            refreshChangedRecords();
        }).catch(function reportRecordRefreshFailure(error) {
            console.error('Arcane PM could not refresh a changed saved record.', error);
        });
    }
}

async function refreshChangedRecord(pending) {
    while (pendingRefreshes.get(pending.key) === pending) {
        const revision = pending.revision;
        let record;
        try {
            record = await readRecord(pending.recordType, pending.id);
        } catch (error) {
            if (pendingRefreshes.get(pending.key) === pending) {
                if (pending.revision !== revision) {
                    console.error('Arcane PM could not read an earlier changed saved record.', error);
                    continue;
                }
                pendingRefreshes.delete(pending.key);
            }
            throw error;
        }
        if (pendingRefreshes.get(pending.key) !== pending) return;
        if (pending.revision !== revision) continue;
        pendingRefreshes.delete(pending.key);
        publishChange(pending.recordType, record === null ? 'removed' : 'refreshed', pending.id, record);
    }
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
    requireFields(input, ['name', 'description', 'workFolder', 'origin', 'faceRef'], 'project');
    const changes = {};
    for (const [field, value] of Object.entries(input)) {
        switch (field) {
            case 'name': changes.name = text(value, field, true); break;
            case 'description': changes.description = text(value, field); break;
            case 'workFolder':
            case 'faceRef': changes[field] = optionalText(value, field); break;
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
    return serializeDataEdit(key, operation);
}

function serializeDataEdit(key, operation) {
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
    knownRecords[recordType].add(id);
    return readStoredRecord(await db.get(tables[recordType], key, true), recordType, id);
}

function publishChange(recordType, action, id, record, changedFields = null) {
    pendingRefreshes.delete(`${recordType}:${id}`);
    if (record === null) knownRecords[recordType].delete(id);
    else knownRecords[recordType].add(id);
    events.dispatch(DATA_CHANGED_EVENT, {
        recordType, action, id, record: record === null ? null : structuredClone(record),
        changedFields: changedFields === null ? null : [...changedFields]
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
        const contentFields = recordType === 'project'
            ? ['name', 'description']
            : ['title', 'assignment', 'projectId'];
        const changedFields = Object.keys(selectedChanges).filter(function changedAuthoredField(field) {
            return !contentFields.includes(field) || selectedChanges[field] !== record[field];
        });
        Object.assign(record, selectedChanges, {updatedAt: new Date().toISOString()});
        const db = await getStorage();
        await db.set(tables[recordType], fileName(id), record);
        publishChange(recordType, action, id, record, changedFields);
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
    // DBOPFS enumerates files; this domain stores records with a terminal .json suffix.
    const keys = (await db.getAllKeys(tables[recordType])).filter(function isPMRecord(key) {
        return key.endsWith('.json');
    });
    const records = [];
    const failures = [];
    let position = 0;
    async function readNextPMRecord() {
        while (position < keys.length) {
            checkCancellation(options.signal);
            const key = keys[position++];
            try {
                const id = decodeURIComponent(key.replace(/\.json$/, ''));
                knownRecords[recordType].add(id);
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
    return saveNew('project', newProjectRecord(changes));
}

function newProjectRecord(changes) {
    const now = new Date().toISOString();
    const record = {
        id: crypto.randomUUID(), name: changes.name, description: '', workFolder: null,
        origin: null, faceRef: null, createdAt: now, updatedAt: now, archivedAt: null
    };
    Object.assign(record, changes);
    return record;
}

export function getProject(id) { return readRecord('project', id); }
export async function updateProject(id, changes) { return updateRecord('project', id, projectChanges(changes)); }
export function listProjects(options = {}) { return listRecords('project', options); }
export async function archiveProject(id) { return updateRecord('project', id, {archivedAt: new Date().toISOString()}, 'archived'); }
export async function restoreProject(id) { return updateRecord('project', id, {archivedAt: null}, 'restored'); }
export async function removeProjectRecord(id) { return removeRecord('project', id); }
export async function setProjectFace(id, faceRef) { return updateProject(id, {faceRef}); }
export async function setProjectFaceIfEmpty(id, faceRef, options = {}) {
    return setRecordFaceIfEmpty('project', id, faceRef, options);
}

export async function createTask(input) {
    const changes = taskChanges(input);
    text(changes.title, 'title', true);
    return saveNew('task', newTaskRecord(changes));
}

function newTaskRecord(changes) {
    const now = new Date().toISOString();
    const record = {
        id: crypto.randomUUID(), title: changes.title, projectId: null, assignment: '',
        workFolder: null, origin: null, assignee: null, status: 'idle', observedEvidence: [],
        sourceRefs: [], resultRefs: [], faceRef: null, decisions: [], openQuestions: [],
        attention: null, nextAction: '', nativeActivity: null,
        createdAt: now, updatedAt: now, archivedAt: null
    };
    Object.assign(record, changes);
    return record;
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

export async function setTaskFaceIfEmpty(id, faceRef, options = {}) {
    return setRecordFaceIfEmpty('task', id, faceRef, options);
}

/** Attach a completed first-face candidate only while its subject and request still match. */
async function setRecordFaceIfEmpty(recordType, id, faceRef, {isCurrent, signal} = {}) {
    text(faceRef, 'faceRef', true);
    if (isCurrent !== undefined && typeof isCurrent !== 'function') {
        throw dataError('PM_DATA_INPUT', `isCurrent must be a synchronous ${recordType} predicate.`);
    }
    checkCancellation(signal);
    return editRecord(recordType, id, async function associateFirstRecordFace() {
        checkCancellation(signal);
        const db = await getStorage();
        const record = readStoredRecord(await db.get(tables[recordType], fileName(id), true), recordType, id);
        checkCancellation(signal);
        if (record === null) return {applied: false, reason: `${recordType}-missing`, [recordType]: null};
        if (record.faceRef !== null && record.faceRef !== undefined) {
            return {applied: false, reason: 'face-present', [recordType]: record};
        }
        if (isCurrent) {
            const current = isCurrent(structuredClone(record));
            if (current && typeof current.then === 'function') {
                Promise.resolve(current).catch(function observeUnsupportedAsyncFacePredicate(error) {
                    console.error(`The asynchronous ${recordType}-face predicate rejected after returning unsupported input.`, error);
                });
            }
            if (typeof current !== 'boolean') {
                throw dataError('PM_DATA_INPUT', 'isCurrent must return a boolean synchronously.');
            }
            if (!current) return {applied: false, reason: 'request-stale', [recordType]: record};
        }
        checkCancellation(signal);
        record.faceRef = faceRef;
        record.updatedAt = new Date().toISOString();
        await db.set(tables[recordType], fileName(id), record);
        publishChange(recordType, 'updated', id, record, ['faceRef']);
        return {applied: true, reason: 'assigned', [recordType]: structuredClone(record)};
    });
}

function sameNativeTask(left, right) {
    return left?.provider === 'codex' && right?.provider === 'codex'
        && hasNativeText(left.hostId) && left.hostId === right.hostId
        && hasNativeText(left.threadId) && left.threadId === right.threadId;
}

function sameNativeOrigin(left, right) {
    return left?.provider === 'codex' && right?.provider === 'codex'
        && left.accountId === right.accountId && left.hostId === right.hostId
        && left.threadId === right.threadId;
}

function hasNativeText(value) {
    return typeof value === 'string' && Boolean(value.trim());
}

/** Keep the two observed project catalogs separate until an explicit ID map joins them. */
function discoveryProjectCatalog(catalog, hostId) {
    const projects = new Map();
    const legacyIds = new Map();
    if (!catalog || catalog.hostId !== hostId) return {projects, legacyIds};
    for (const project of catalog.native?.projects || []) {
        const id = text(project.id, 'native project.id', true);
        projects.set(`native:${id}`, {
            provider: 'codex', hostId, kind: 'native', projectId: id,
            name: text(project.name, 'native project.name'),
            rootPaths: textList(project.roots.map(function nativeRoot(root) {
                return root.path;
            }), 'native project roots'),
            source: 'codex-app-server', createdAt: project.createdAt, updatedAt: project.updatedAt,
            nativeId: id, desktopProjects: []
        });
    }
    const desktop = catalog.desktop;
    for (const [legacyId, nativeId] of Object.entries(desktop?.nativeProjectIdsByLegacyId || {})) {
        if (hasNativeText(nativeId)) legacyIds.set(legacyId, nativeId);
    }
    for (const project of Object.values(desktop?.localProjects || {})) {
        const legacyId = text(project.id, 'desktop project.id', true);
        const nativeId = legacyIds.get(legacyId);
        const kind = nativeId ? 'native' : 'desktop-local';
        const id = nativeId || legacyId;
        const key = `${kind}:${id}`;
        const desktopProject = {
            id: legacyId, name: text(project.name, 'desktop project.name'),
            rootPaths: textList(project.rootPaths, 'desktop project.rootPaths'),
            createdAt: project.createdAt, updatedAt: project.updatedAt
        };
        if (projects.has(key)) {
            projects.get(key).desktopProjects.push(desktopProject);
            continue;
        }
        projects.set(key, {
            provider: 'codex', hostId, kind, projectId: id,
            name: text(project.name, 'desktop project.name'),
            rootPaths: textList(project.rootPaths, 'desktop project.rootPaths'),
            source: 'codex-desktop-state', createdAt: project.createdAt, updatedAt: project.updatedAt,
            nativeId: nativeId || null, desktopProjects: [desktopProject]
        });
    }
    return {projects, legacyIds};
}

/** Import only local PM metadata from a completed native read; never mutate native state. */
export async function syncNativeDiscovery(discovery, {isCurrent, signal, onProgress, projectId} = {}) {
    requireRecord(discovery, 'native discovery');
    if (typeof isCurrent !== 'function') {
        throw dataError('PM_DATA_INPUT', 'Native discovery requires its current connection predicate.');
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
        throw dataError('PM_DATA_INPUT', 'onProgress must be a function when supplied.');
    }
    const listing = structuredClone(Array.isArray(discovery.threads) || discovery.thread || discovery.status
        ? discovery : discovery.threads);
    requireRecord(listing, 'native thread discovery');
    const selectedThread = Boolean(listing.thread);
    if (projectId !== undefined) {
        optionalText(projectId, 'projectId');
        if (!selectedThread) throw dataError('PM_DATA_INPUT', 'A project override requires one explicitly selected thread.');
    }
    const rows = selectedThread ? [listing.thread] : listing.threads || [];
    const catalog = discovery.projectCatalog ? structuredClone(discovery.projectCatalog) : null;
    const coverage = {
        threads: selectedThread ? {complete: listing.status === 'available', scope: 'selected-thread'}
            : structuredClone(listing.coverage || {complete: false, scope: 'accessible-threads'}),
        projects: structuredClone(catalog?.native?.coverage || {complete: false}),
        assignments: structuredClone(catalog?.desktop?.coverage || {complete: false})
    };
    const result = {
        status: 'partial', projects: [], tasks: [], associations: [],
        createdProjectIds: [], createdTaskIds: [], unassociated: [], failures: [], coverage
    };
    let cancellation;
    if (listing.status === 'unavailable') return {...result, status: 'unavailable', reason: listing.reason};
    const identity = listing.identity?.originIdentity;
    if (identity?.provider !== 'codex' || !hasNativeText(identity.accountId) || !hasNativeText(identity.hostId)) {
        return {...result, status: 'unassociated', reason: 'native-identity-unavailable'};
    }
    if (catalog && catalog.hostId !== identity.hostId) {
        return {...result, status: 'unassociated', reason: 'project-catalog-host-mismatch'};
    }
    function currentDiscovery() {
        if (cancellation) throw cancellation;
        checkCancellation(signal);
        const current = isCurrent();
        if (current && typeof current.then === 'function') {
            Promise.resolve(current).catch(function observeUnsupportedDiscoveryPredicate(error) {
                console.error('The asynchronous discovery predicate rejected after returning unsupported input.', error);
            });
        }
        if (typeof current !== 'boolean') throw dataError('PM_DATA_INPUT', 'isCurrent must return a boolean synchronously.');
        if (!current) result.reason = 'discovery-stale';
        return current;
    }
    if (!currentDiscovery()) return result;
    const savedCatalog = discoveryProjectCatalog(catalog, identity.hostId);
    // This membership decision is shared by accounts on one host, after native I/O finishes.
    return serializeDataEdit(`arcane-pm:discovery:${identity.hostId}`, async function importObservedWorkspace() {
        if (!currentDiscovery()) return result;
        const [projects, tasks, db] = await Promise.all([listProjects({signal}), listTasks({signal}), getStorage()]);
        if (!currentDiscovery()) return result;
        const projectsById = new Map();
        const projectsByOrigin = new Map();
        const tasksByThread = new Map();
        const projectRequests = new Map();
        const returnedProjects = new Map();
        const catalogKeysById = new Map();
        const conflictingProjects = new Map();
        let completed = 0;
        function indexCatalogId(id, key) {
            const keys = catalogKeysById.get(id) || new Set();
            keys.add(key);
            catalogKeysById.set(id, keys);
        }
        for (const [key, saved] of savedCatalog.projects) {
            indexCatalogId(saved.projectId, key);
            for (const desktop of saved.desktopProjects) indexCatalogId(desktop.id, key);
        }
        function projectOriginKeys(project) {
            const keys = new Set();
            const saved = project.nativeProject;
            if (saved?.provider === 'codex' && saved.hostId === identity.hostId) {
                keys.add(`${saved.kind}:${saved.projectId}`);
                if (saved.nativeId) keys.add(`native:${saved.nativeId}`);
                const legacyProjects = saved.desktopProjects || [];
                for (const legacy of legacyProjects) {
                    keys.add(`desktop-local:${legacy.id}`);
                    const nativeId = savedCatalog.legacyIds.get(legacy.id);
                    if (nativeId && (!saved.nativeId || saved.nativeId === nativeId)) keys.add(`native:${nativeId}`);
                }
                if (saved.kind === 'desktop-local') {
                    const nativeId = savedCatalog.legacyIds.get(saved.projectId);
                    if (nativeId && (!saved.nativeId || saved.nativeId === nativeId)) keys.add(`native:${nativeId}`);
                }
            } else if (project.nativeFolder?.provider === 'codex' && project.nativeFolder.hostId === identity.hostId) {
                keys.add(`folder:${project.nativeFolder.cwd}`);
            } else if (project.origin?.provider === 'codex' && project.origin.hostId === identity.hostId
                && hasNativeText(project.origin.projectId)) {
                for (const key of catalogKeysById.get(project.origin.projectId) || []) keys.add(key);
            }
            return keys;
        }
        for (const project of projects) {
            projectsById.set(project.id, project);
            const saved = project.nativeProject;
            if (saved?.hostId === identity.hostId && saved.nativeId) {
                for (const desktop of saved.desktopProjects || []) {
                    const mappedId = savedCatalog.legacyIds.get(desktop.id);
                    if (mappedId && mappedId !== saved.nativeId) {
                        const key = `native:${mappedId}`;
                        const conflicts = conflictingProjects.get(key) || [];
                        conflicts.push(project.id);
                        conflictingProjects.set(key, conflicts);
                    }
                }
            }
            for (const key of projectOriginKeys(project)) {
                const matches = projectsByOrigin.get(key) || [];
                matches.push(project);
                projectsByOrigin.set(key, matches);
            }
        }
        for (const task of tasks) {
            if (task.origin?.provider !== 'codex' || !hasNativeText(task.origin.threadId)) continue;
            const matches = tasksByThread.get(task.origin.threadId) || [];
            matches.push(task);
            tasksByThread.set(task.origin.threadId, matches);
        }
        if (projectId !== undefined && projectId !== null && !projectsById.has(projectId)) {
            throw dataError('PM_DATA_NOT_FOUND', `The selected project record ${projectId} is unavailable.`);
        }
        function includeProject(project) {
            if (!project) return;
            const index = returnedProjects.get(project.id);
            if (index !== undefined) result.projects[index] = structuredClone(project);
            else {
                returnedProjects.set(project.id, result.projects.length);
                result.projects.push(structuredClone(project));
            }
        }
        async function saveDiscoveredRecord(recordType, record) {
            if (!currentDiscovery()) return null;
            await db.set(tables[recordType], fileName(record.id), record);
            publishChange(recordType, 'created', record.id, record);
            return record;
        }
        function projectFor(key, saved, cwd) {
            if (projectRequests.has(key)) return projectRequests.get(key);
            const request = resolveProject();
            projectRequests.set(key, request);
            return request;
            async function resolveProject() {
                if (conflictingProjects.has(key)) {
                    return {reason: 'conflicting-project-mapping', projectIds: [...conflictingProjects.get(key)]};
                }
                const matches = projectsByOrigin.get(key) || [];
                if (matches.length > 1) {
                    return {reason: 'ambiguous-project-association', projectIds: matches.map(function projectIdentity(project) { return project.id; })};
                }
                if (matches.length === 1) {
                    return editRecord('project', matches[0].id, async function reuseCurrentProject() {
                        const project = await readRecord('project', matches[0].id);
                        if (!currentDiscovery()) return {reason: 'discovery-stale'};
                        const keys = project ? projectOriginKeys(project) : new Set();
                        if (!keys.has(key)) return {reason: 'project-association-changed', projectIds: [matches[0].id]};
                        if (!project.nativeProject && !project.nativeFolder && keys.size > 1) {
                            return {reason: 'ambiguous-project-association', projectIds: [project.id]};
                        }
                        if (saved) {
                            const previous = project.nativeProject;
                            const desktopProjects = previous?.desktopProjects || [];
                            const additions = saved.desktopProjects.filter(function newDesktopIdentity(candidate) {
                                return !desktopProjects.some(function retainedDesktopIdentity(known) { return known.id === candidate.id; });
                            });
                            if (!previous || (!previous.nativeId && saved.nativeId) || additions.length) {
                                project.nativeProject = previous ? {
                                    ...previous, nativeId: previous.nativeId || saved.nativeId,
                                    desktopProjects: [...desktopProjects, ...structuredClone(additions)]
                                } : structuredClone(saved);
                                project.updatedAt = new Date().toISOString();
                                if (!currentDiscovery()) return {reason: 'discovery-stale'};
                                await db.set(tables.project, fileName(project.id), project);
                                publishChange('project', 'updated', project.id, project, ['nativeProject']);
                            }
                        }
                        projectsById.set(project.id, project);
                        includeProject(project);
                        return {project};
                    });
                }
                const separator = cwd && (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')) ? /[\\/]/ : /\//;
                const name = saved ? saved.name : cwd.split(separator).filter(Boolean).pop() || cwd;
                const project = newProjectRecord({
                    name: hasNativeText(name) ? name : saved.projectId,
                    workFolder: saved ? saved.rootPaths.length === 1 ? saved.rootPaths[0] : null : cwd,
                    origin: {provider: 'codex', accountId: null, projectId: saved?.projectId || null, threadId: null, hostId: identity.hostId, url: null}
                });
                if (saved) project.nativeProject = structuredClone(saved);
                else project.nativeFolder = {provider: 'codex', hostId: identity.hostId, cwd};
                if (!await saveDiscoveredRecord('project', project)) return {reason: 'discovery-stale'};
                projectsById.set(project.id, project);
                projectsByOrigin.set(key, [project]);
                result.createdProjectIds.push(project.id);
                includeProject(project);
                return {project};
            }
        }
        async function runItems(items, operation, stage) {
            let position = 0;
            async function nextDiscoveryItem() {
                while (position < items.length && currentDiscovery()) {
                    const item = items[position++];
                    try {
                        await operation(item);
                    } catch (error) {
                        if (error.name === 'AbortError') {
                            cancellation = error;
                            throw error;
                        }
                        result.failures.push({stage, id: item.id ?? item[0] ?? null, error});
                    }
                    if (!currentDiscovery()) return;
                    completed++;
                    if (onProgress) {
                        try {
                            const notice = onProgress({stage, completed, createdProjects: result.createdProjectIds.length, createdTasks: result.createdTaskIds.length});
                            if (notice && typeof notice.then === 'function') {
                                Promise.resolve(notice).catch(function observeProgressFailure(error) {
                                    console.error('The native discovery progress observer rejected.', error);
                                });
                            }
                        } catch (error) {
                            console.error('The native discovery progress observer failed.', error);
                        }
                    }
                }
            }
            const workers = [];
            for (let index = 0; index < Math.min(4, items.length); index++) workers.push(nextDiscoveryItem());
            const outcomes = await Promise.allSettled(workers);
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected') {
                    outcome.reason.discoveryResult = result;
                    throw outcome.reason;
                }
            }
        }
        const projectWork = runItems([...savedCatalog.projects], async function importSavedProject([key, saved]) {
            const outcome = await projectFor(key, saved);
            if (outcome.reason) result.unassociated.push({nativeProjectId: saved.projectId, ...outcome});
        }, 'projects');
        const uniqueThreads = new Map();
        for (const row of rows) {
            try {
                uniqueThreads.set(text(row.id, 'native thread.id', true), row);
            } catch (error) {
                result.failures.push({stage: 'threads', id: row?.id ?? null, error});
            }
        }
        const taskWork = runItems([...uniqueThreads.values()], async function importNativeThread(thread) {
            const origin = {provider: 'codex', accountId: identity.accountId, hostId: identity.hostId, threadId: thread.id};
            const candidates = tasksByThread.get(thread.id) || [];
            const matched = candidates.filter(function exactTask(task) { return sameNativeTask(task.origin, origin); });
            if (matched.length) {
                for (const candidate of matched) {
                    await editRecord('task', candidate.id, async function reuseCurrentTask() {
                        const task = await readRecord('task', candidate.id);
                        if (!currentDiscovery()) return;
                        if (!task || !sameNativeTask(task.origin, origin)) {
                            result.unassociated.push({threadId: thread.id, reason: 'task-association-changed', taskIds: [candidate.id]});
                            return;
                        }
                        result.tasks.push(structuredClone(task));
                        result.associations.push({threadId: thread.id, taskId: task.id, projectId: task.projectId, created: false});
                        includeProject(projectsById.get(task.projectId));
                    });
                }
                return;
            }
            const incomplete = candidates.filter(function missingTaskIdentity(task) {
                return !hasNativeText(task.origin.hostId);
            });
            if (incomplete.length) {
                result.unassociated.push({threadId: thread.id, reason: 'association-required', taskIds: incomplete.map(function taskIdentity(task) { return task.id; })});
                return;
            }
            let selectedProjectId = projectId;
            let nativeProjectId = hasNativeText(thread.projectId) ? thread.projectId : null;
            if (selectedProjectId === undefined) {
                let projectKey = nativeProjectId ? `native:${nativeProjectId}` : null;
                const assignment = catalog?.desktop?.threadAssignments?.[thread.id];
                if (!projectKey && assignment) {
                    if (assignment.projectKind !== 'local' || !hasNativeText(assignment.projectId)) {
                        result.unassociated.push({threadId: thread.id, reason: 'unsupported-project-assignment'});
                        return;
                    }
                    nativeProjectId = savedCatalog.legacyIds.get(assignment.projectId) || assignment.projectId;
                    projectKey = savedCatalog.legacyIds.has(assignment.projectId)
                        ? `native:${nativeProjectId}` : `desktop-local:${nativeProjectId}`;
                }
                let outcome;
                if (projectKey) {
                    const saved = savedCatalog.projects.get(projectKey);
                    if (!saved) {
                        result.unassociated.push({threadId: thread.id, nativeProjectId, reason: 'assigned-project-unavailable'});
                        return;
                    }
                    outcome = await projectFor(projectKey, saved);
                } else if (catalog && catalog.desktop?.coverage?.complete !== true) {
                    result.unassociated.push({threadId: thread.id, reason: 'project-assignments-unavailable'});
                    return;
                } else if (hasNativeText(thread.cwd)) {
                    outcome = await projectFor(`folder:${thread.cwd}`, null, thread.cwd);
                }
                if (outcome?.reason) {
                    result.unassociated.push({threadId: thread.id, ...outcome});
                    return;
                }
                selectedProjectId = outcome?.project?.id || null;
            }
            const task = newTaskRecord({
                title: hasNativeText(thread.name) ? thread.name : thread.id,
                projectId: selectedProjectId,
                workFolder: hasNativeText(thread.cwd) ? thread.cwd : null,
                origin: {...origin, projectId: nativeProjectId, url: `codex://threads/${encodeURIComponent(thread.id)}`},
                status: 'unknown'
            });
            if (!selectedThread && listing.coverage?.archived === true) task.archivedAt = task.createdAt;
            if (!await saveDiscoveredRecord('task', task)) return;
            tasksByThread.set(thread.id, [task]);
            result.createdTaskIds.push(task.id);
            result.tasks.push(structuredClone(task));
            result.associations.push({threadId: thread.id, taskId: task.id, projectId: task.projectId, created: true});
            includeProject(projectsById.get(task.projectId));
        }, 'threads');
        const batches = await Promise.allSettled([projectWork, taskWork]);
        for (const batch of batches) {
            if (batch.status === 'rejected') throw batch.reason;
        }
        if (currentDiscovery() && !result.failures.length && !result.unassociated.length
            && coverage.threads.complete && (!catalog || catalog.coverage?.complete === true)) result.status = 'complete';
        return result;
    }).catch(function retainPartialDiscovery(error) {
        error.discoveryResult = result;
        throw error;
    });
}

function nativeActivityOrigin(value) {
    requireRecord(value, 'native activity origin');
    if (value.provider !== 'codex') {
        throw dataError('PM_DATA_INPUT', 'Native task activity requires a Codex origin.');
    }
    return {
        provider: 'codex', accountId: text(value.accountId, 'origin.accountId', true),
        hostId: text(value.hostId, 'origin.hostId', true),
        threadId: text(value.threadId, 'origin.threadId', true)
    };
}

/** Enumerate existing explicit associations once; no task is imported or reassigned. */
export async function listNativeTaskAssociations({accountId, hostId, signal} = {}) {
    if (accountId !== undefined) text(accountId, 'accountId', true);
    if (hostId !== undefined) text(hostId, 'hostId', true);
    const tasks = await listTasks({signal});
    const associations = [];
    for (const task of tasks) {
        const origin = task.origin;
        if (origin?.provider !== 'codex') continue;
        if (typeof origin.hostId !== 'string' || !origin.hostId.trim()) continue;
        if (typeof origin.threadId !== 'string' || !origin.threadId.trim()) continue;
        if (accountId !== undefined && origin.accountId !== accountId) continue;
        if (hostId !== undefined && origin.hostId !== hostId) continue;
        associations.push({taskId: task.id, origin: {
            provider: 'codex', accountId: origin.accountId ?? null,
            hostId: origin.hostId, threadId: origin.threadId
        }});
    }
    return associations;
}

function projectNativeActivity(observation) {
    requireRecord(observation, 'native activity observation');
    const origin = nativeActivityOrigin(observation.origin);
    if (observation.threadId !== origin.threadId) {
        throw dataError('PM_DATA_INPUT', 'The observation and origin must identify the same native thread.');
    }
    const {availability, observedAt, coverage} = observation;
    if (!['observed', 'unobserved', 'disconnected'].includes(availability)) {
        throw dataError('PM_DATA_INPUT', 'Native activity availability is not supported.');
    }
    text(observedAt, 'observedAt', true);
    if (!Number.isFinite(Date.parse(observedAt))) {
        throw dataError('PM_DATA_INPUT', 'Native activity requires its actual observation timestamp.');
    }
    requireRecord(coverage, 'native activity coverage');
    if (coverage.scope !== 'connected-server' || typeof coverage.live !== 'boolean') {
        throw dataError('PM_DATA_INPUT', 'Native activity requires connected-server coverage.');
    }
    let state = 'unknown';
    if (availability === 'observed') {
        const nativeStatus = observation.status;
        const flags = nativeStatus?.activeFlags || [];
        const requests = observation.pendingRequests || [];
        if (flags.includes('waitingOnUserInput') || requests.some(function awaitsNativeInput(request) { return request.kind === 'input'; })) {
            state = 'needs-input';
        } else if (flags.includes('waitingOnApproval') || requests.some(function awaitsNativeApproval(request) { return request.kind === 'approval'; })) {
            state = 'needs-approval';
        } else if (nativeStatus?.type === 'active') state = 'working';
        else if (nativeStatus?.type === 'idle') state = 'idle';
        else if (nativeStatus?.type === 'systemError') state = 'error';
    }
    return {
        origin, availability, state, message: text(observation.message, 'message'), observedAt,
        coverage: {
            scope: 'connected-server', live: availability === 'observed' && coverage.live,
            reason: optionalText(coverage.reason ?? null, 'coverage.reason')
        }
    };
}

function sameNativeActivity(left, right) {
    return left && sameNativeOrigin(left.origin, right.origin)
        && left.availability === right.availability && left.state === right.state
        && left.message === right.message && left.observedAt === right.observedAt
        && left.coverage?.scope === right.coverage.scope
        && left.coverage?.live === right.coverage.live
        && left.coverage?.reason === right.coverage.reason;
}

/** Save a narrow PM observation for one existing, exactly associated task. */
export async function applyNativeTaskObservation(id, observation, {isCurrent, signal} = {}) {
    const activity = projectNativeActivity(observation);
    if (typeof isCurrent !== 'function') {
        throw dataError('PM_DATA_INPUT', 'Native activity requires its current observer predicate.');
    }
    checkCancellation(signal);
    return editRecord('task', id, async function saveNativeTaskObservation() {
        checkCancellation(signal);
        const db = await getStorage();
        const record = readStoredRecord(await db.get(tables.task, fileName(id), true), 'task', id);
        checkCancellation(signal);
        if (record === null) return {applied: false, reason: 'task-missing', task: null};
        if (!sameNativeTask(record.origin, activity.origin)) {
            return {applied: false, reason: 'origin-mismatch', task: record};
        }
        const current = isCurrent();
        if (current && typeof current.then === 'function') {
            Promise.resolve(current).catch(function observeUnsupportedAsyncActivityPredicate(error) {
                console.error('The asynchronous activity predicate rejected after returning unsupported input.', error);
            });
        }
        if (typeof current !== 'boolean') {
            throw dataError('PM_DATA_INPUT', 'The activity predicate must return a boolean synchronously.');
        }
        if (!current) return {applied: false, reason: 'observation-stale', task: record};
        const previous = sameNativeTask(record.nativeActivity?.origin, activity.origin) ? record.nativeActivity : null;
        if (previous && Date.parse(previous.observedAt) > Date.parse(activity.observedAt)) {
            return {applied: false, reason: 'older-observation', task: record};
        }
        if (sameNativeActivity(previous, activity)) {
            return {applied: false, reason: 'unchanged', task: record};
        }
        const lastObserved = previous?.lastObserved;
        activity.lastObserved = activity.availability === 'observed' && activity.state !== 'unknown'
            ? {state: activity.state, message: activity.message, observedAt: activity.observedAt}
            : lastObserved ? {state: lastObserved.state, message: lastObserved.message, observedAt: lastObserved.observedAt} : null;
        checkCancellation(signal);
        record.nativeActivity = activity;
        record.updatedAt = new Date().toISOString();
        await db.set(tables.task, fileName(id), record);
        publishChange('task', 'updated', id, record, ['nativeActivity']);
        return {applied: true, reason: 'observed', task: structuredClone(record)};
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
    archiveProject, restoreProject, removeProjectRecord, setProjectFace, setProjectFaceIfEmpty,
    createTask, getTask, updateTask, listTasks, archiveTask, restoreTask,
    removeTaskRecord, setTaskFace, setTaskFaceIfEmpty,
    listNativeTaskAssociations, applyNativeTaskObservation, syncNativeDiscovery, subscribe
};

export default pmData;
