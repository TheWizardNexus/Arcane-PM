const HANDOFF_TABLE = 'pm_handoffs';
const ORIGINAL_TABLE = 'pm_handoff_originals';
const pendingEdits = new Map();
const ORIGINALS_LOCK = 'arcane-pm:handoff-originals';

export function createHandoffService(options) {
    return new HandoffService(options);
}

class HandoffService {
    #pmData;
    #getStorage;
    #sourceLibrary;
    #bridge;
    #localAI;
    disposableResources;

    constructor({pmData, getStorage, sourceLibrary, bridge, localAI}) {
        this.#pmData = pmData;
        this.#getStorage = getStorage;
        this.#sourceLibrary = sourceLibrary;
        this.#bridge = bridge;
        this.#localAI = localAI;
        const service = this;
        this.disposableResources = {
            list: function listHandoffResources(options) {
                return editDomain(ORIGINALS_LOCK, function readResourceInventory() {
                    return service.#listResources(options);
                });
            },
            dispose: function disposeHandoffResource(id, options) {
                return editDomain(ORIGINALS_LOCK, function removeUnusedOriginal() {
                    return service.#disposeResource(id, options);
                });
            }
        };
    }

    async createDraft(input) {
        const project = await this.#pmData.getProject(input.projectId);
        if (!project) throw handoffInputError('Choose an existing project for this handoff.');
        const now = new Date().toISOString();
        const record = {
            id: crypto.randomUUID(),
            projectId: project.id,
            fromTaskId: input.fromTaskId || null,
            toTaskId: input.toTaskId || null,
            assignment: input.assignment ?? '',
            decisions: input.decisions ?? '',
            openQuestions: input.openQuestions ?? '',
            preparedNote: input.preparedNote ?? '',
            sourceIds: input.sourceIds ? [...input.sourceIds] : [],
            originals: [],
            retainedFiles: [],
            selectionPrepared: !input.sourceIds?.length,
            status: 'preparing',
            attempts: [],
            observations: [],
            previousHandoffId: input.previousHandoffId || null,
            createdAt: now,
            updatedAt: now
        };
        await this.#checkTasks(record);
        await this.#save(record);
        return record;
    }

    async get(id) {
        const db = await this.#getStorage();
        const record = await db.get(HANDOFF_TABLE, `${id}.json`, true);
        return record ? structuredClone(record) : null;
    }

    async list({projectId, signal} = {}) {
        signal?.throwIfAborted();
        const db = await this.#getStorage();
        const keys = await db.getAllKeys(HANDOFF_TABLE);
        const records = [];
        const failures = [];
        for (let start = 0; start < keys.length; start += 4) {
            signal?.throwIfAborted();
            const reads = [];
            for (let position = start; position < Math.min(start + 4, keys.length); position += 1) {
                reads.push(db.get(HANDOFF_TABLE, keys[position], true));
            }
            const outcomes = await Promise.allSettled(reads);
            for (const outcome of outcomes) {
                if (outcome.status === 'fulfilled') {
                    const record = outcome.value;
                    if (record && (!projectId || record.projectId === projectId)) records.push(structuredClone(record));
                } else {
                    failures.push(outcome.reason);
                }
            }
        }
        if (failures.length) {
            const error = new AggregateError(failures, 'Some saved handoffs could not be read.');
            error.records = records;
            throw error;
        }
        return records.sort(
            function newestHandoffFirst(left, right) {
                return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
            }
        );
    }

    updateDraft(id, changes) {
        const service = this;
        return this.#change(
            id,
            async function updateHandoffDraft(record) {
                requireEditable(record);
                for (const field of ['fromTaskId', 'toTaskId', 'assignment', 'decisions', 'openQuestions', 'preparedNote']) {
                    if (Object.hasOwn(changes, field)) record[field] = changes[field];
                }
                if (Object.hasOwn(changes, 'sourceIds')) {
                    record.sourceIds = [...changes.sourceIds];
                    record.selectionPrepared = false;
                }
                record.status = 'preparing';
                await service.#checkTasks(record);
                return record;
            }
        );
    }

    prepare(id, {selection, signal} = {}) {
        const service = this;
        return editDomain(ORIGINALS_LOCK, function retainOriginalsTogether() {
            return service.#change(
                id,
                async function retainSelectedOriginals(record) {
                    requireEditable(record);
                    signal?.throwIfAborted();
                    const db = await service.#getStorage();
                    let selected = selection;
                    if (!selected) {
                        const sources = [];
                        const unavailableIds = [];
                        for (let start = 0; start < record.sourceIds.length; start += 4) {
                            signal?.throwIfAborted();
                            const reads = [];
                            const ids = [];
                            for (let position = start; position < Math.min(start + 4, record.sourceIds.length); position += 1) {
                                const sourceId = record.sourceIds[position];
                                if (!service.#sourceLibrary?.read) {
                                    unavailableIds.push(sourceId);
                                    continue;
                                }
                                ids.push(sourceId);
                                reads.push(service.#sourceLibrary.read(sourceId, {signal}));
                            }
                            const outcomes = await Promise.allSettled(reads);
                            signal?.throwIfAborted();
                            for (const [position, outcome] of outcomes.entries()) {
                                if (outcome.status === 'fulfilled') {
                                    sources.push(outcome.value);
                                    if (outcome.value.availability !== 'retained') unavailableIds.push(ids[position]);
                                } else {
                                    unavailableIds.push(ids[position]);
                                    console.error('Selected handoff source could not be read.', ids[position], outcome.reason);
                                }
                            }
                        }
                        selected = {sources, unavailableIds, complete: unavailableIds.length === 0};
                    }
                    const originals = [];
                    for (const selectedSource of selected.sources) {
                        signal?.throwIfAborted();
                        const original = {
                            source: structuredClone(selectedSource.source),
                            content: selectedSource.content,
                            availability: selectedSource.availability,
                            freshness: selectedSource.freshness,
                            originalFileRef: null
                        };
                        if (selectedSource.originalFile) {
                            const file = selectedSource.originalFile;
                            const key = `${record.id}-${crypto.randomUUID()}`;
                            original.originalFileRef = {
                                table: ORIGINAL_TABLE,
                                key,
                                name: file.name,
                                type: file.type,
                                lastModified: file.lastModified
                            };
                            record.retainedFiles ||= [];
                            record.retainedFiles.push(structuredClone(original.originalFileRef));
                            // Register ownership before writing, including an interrupted preparation.
                            await service.#save(record);
                            await db.writeFile(ORIGINAL_TABLE, key, file);
                        }
                        originals.push(original);
                    }
                    signal?.throwIfAborted();
                    record.originals = originals;
                    const retainedIds = selected.sources.map(
                        function selectedSourceId(item) {
                            return item.source.id;
                        }
                    );
                    record.sourceIds = [...new Set([...retainedIds, ...selected.unavailableIds])];
                    record.unavailableSourceIds = [...selected.unavailableIds];
                    record.selectionPrepared = selected.complete;
                    record.preparedAt = new Date().toISOString();
                    record.status = 'preparing';
                    return record;
                }
            );
        });
    }

    markReady(id) {
        return this.#change(
            id,
            async function markHandoffReady(record) {
                requireEditable(record);
                if (typeof record.assignment !== 'string' || !record.assignment.trim()) {
                    throw handoffInputError('Add the assignment before marking this handoff ready.');
                }
                if (!record.selectionPrepared) {
                    throw handoffInputError('Prepare the selected original sources before marking this handoff ready.');
                }
                record.status = 'ready';
                return record;
            }
        );
    }

    reopen(id) {
        const service = this;
        return editDomain(ORIGINALS_LOCK, function reopenWithRetainedOriginals() {
            return service.#reopen(id);
        });
    }

    async #reopen(id) {
        const original = await this.get(id);
        if (!original) throw handoffInputError('The selected handoff is unavailable.');
        if (original.status === 'preparing' || original.status === 'ready') {
            return this.updateDraft(id, {});
        }
        const record = structuredClone(original);
        const now = new Date().toISOString();
        record.id = crypto.randomUUID();
        record.previousHandoffId = original.id;
        record.status = 'preparing';
        record.attempts = [];
        record.observations = [];
        record.retainedFiles = [];
        record.createdAt = now;
        record.updatedAt = now;
        await this.#save(record);
        return record;
    }

    readOriginal(handoffId, sourceId) {
        const service = this;
        return editDomain(ORIGINALS_LOCK, function readRetainedOriginal() {
            return service.#readOriginal(handoffId, sourceId);
        });
    }

    async #readOriginal(handoffId, sourceId) {
        const handoff = await this.get(handoffId);
        const original = handoff?.originals.find(
            function findHandoffOriginal(item) {
                return item.source.id === sourceId;
            }
        );
        if (!original) throw handoffInputError('This source is not retained in the selected handoff.');
        if (!original.originalFileRef) return {...original, originalFile: null};
        const ref = original.originalFileRef;
        const db = await this.#getStorage();
        const file = await db.readFile(ref.table, ref.key);
        const originalFile = new File([file], ref.name, {type: ref.type, lastModified: ref.lastModified});
        return {...original, originalFile};
    }

    async prepareNote(id, {signal, onChunk} = {}) {
        const record = await this.get(id);
        if (!record) throw handoffInputError('The selected handoff is unavailable.');
        if (!this.#localAI?.prepare) {
            return {status: 'unavailable', message: 'Local preparation is unavailable. You can write and save the note here.'};
        }
        if (!record.selectionPrepared) {
            return {status: 'unavailable', message: 'Prepare the selected original sources before requesting a note.'};
        }
        const messages = [
            {
                role: 'system',
                content: 'Prepare a useful handoff note for the assigned work using the complete supplied material. The next four messages contain the assignment, decisions, open questions, and any existing authored note, in that order. Remaining messages contain complete selected original sources. Preserve unresolved questions. Distinguish recorded facts, decisions, and proposed next actions. Do not claim a handoff was sent, accepted, started, or completed.'
            },
            {role: 'user', content: record.assignment},
            {role: 'user', content: record.decisions},
            {role: 'user', content: record.openQuestions},
            {role: 'user', content: record.preparedNote}
        ];
        for (const original of record.originals) {
            if (original.content === null && original.originalFileRef) {
                return {status: 'unavailable', message: 'A selected file needs a supported model input. You can prepare the note manually with the complete file available below.'};
            }
            if (typeof original.content === 'string') {
                messages.push({role: 'user', content: original.content});
            }
        }
        signal?.throwIfAborted();
        return this.#localAI.prepare(
            {
                taskId: record.fromTaskId,
                messages,
                persist: false,
                signal,
                onChunk
            }
        );
    }

    async deliveryAvailability(id) {
        const record = await this.get(id);
        if (!record?.toTaskId) return {available: false, message: 'Choose the receiving task.'};
        const task = await this.#pmData.getTask(record.toTaskId);
        if (task?.origin?.provider !== 'codex' || !task.origin.threadId) {
            return {available: false, message: 'The receiving task needs a connected Codex conversation.'};
        }
        const connection = this.#bridge?.status();
        if (!this.#bridge?.sendHandoff || !this.#bridge.readThread
            || !connection?.capabilities?.sendHandoff || !connection.capabilities.readThread) {
            return {available: false, message: 'Handoff delivery is unavailable through this connection. Local preparation remains available.'};
        }
        if (!task.origin.hostId) {
            return {available: false, message: 'Associate this receiving conversation with its Codex host in Connections before sending.'};
        }
        if (!connection.connected || connection.connectionId === undefined || connection.connectionId === null
            || !connection.originIdentity?.accountId
            || !sameHandoffHost(task.origin, connection.originIdentity)) {
            return {available: false, message: 'Connect to Codex on the receiving task’s recorded host before sending.'};
        }
        if (record.originals.some(hasBinaryOriginal)) {
            return {available: false, message: 'This connection cannot carry the selected original files. Their complete local copies remain available.'};
        }
        return {available: true, message: 'Review the complete handoff before sending.'};
    }

    deliver(id, {signal} = {}) {
        const service = this;
        return this.#change(
            id,
            async function deliverPreparedHandoff(record) {
                if (record.status !== 'ready') throw handoffInputError('Mark this handoff ready before sending.');
                const availability = await service.deliveryAvailability(id);
                if (!availability.available) return record;
                signal?.throwIfAborted();
                const destination = await service.#pmData.getTask(record.toTaskId);
                signal?.throwIfAborted();
                if (!destination?.origin?.threadId) throw handoffInputError('The receiving conversation is unavailable.');
                const selected = await service.#bridge.readThread(
                    {threadId: destination.origin.threadId, signal}
                );
                signal?.throwIfAborted();
                const connection = service.#bridge.status();
                if (selected?.status !== 'available'
                    || selected.threadId !== destination.origin.threadId
                    || selected.thread?.id !== destination.origin.threadId
                    || !connection.connected
                    || !sameHandoffHost(destination.origin, selected.identity?.originIdentity)
                    || !sameHandoffIdentity(
                        selected.identity,
                        {connectionId: connection.connectionId, originIdentity: connection.originIdentity}
                    )) {
                    throw handoffInputError('The receiving conversation or connection changed. Review its association in Connections before sending.');
                }
                const attempt = {
                    id: crypto.randomUUID(),
                    status: 'sending',
                    requestedAt: new Date().toISOString(),
                    destination: structuredClone(destination.origin),
                    identity: structuredClone(selected.identity),
                    message: 'Delivery requested.'
                };
                record.attempts.push(attempt);
                record.status = 'unconfirmed';
                // Save before the external call so an interrupted page cannot silently resend.
                await service.#save(record);
                try {
                    signal?.throwIfAborted();
                    const result = await service.#bridge.sendHandoff(
                        {
                            threadId: destination.origin.threadId,
                            input: deliveryInput(record),
                            identity: attempt.identity,
                            signal
                        }
                    );
                    if (result?.accepted === true && result.status === 'accepted' && result.turnId
                        && result.threadId === destination.origin.threadId
                        && sameHandoffIdentity(result.identity, attempt.identity)) {
                        attempt.status = 'accepted';
                        attempt.confirmedAt = result.acceptedAt;
                        attempt.turnId = result.turnId;
                        attempt.message = result.message || 'The destination confirmed acceptance.';
                        record.status = 'accepted';
                    } else {
                        attempt.status = result?.status === 'unavailable' && result.accepted === false ? 'unavailable' : 'unconfirmed';
                        attempt.message = result?.message || 'The destination has not confirmed acceptance. Check the receiving task before another send.';
                        if (attempt.status === 'unavailable') record.status = 'ready';
                    }
                } catch (error) {
                    console.error('Arcane PM handoff delivery did not return confirmation.', error);
                    attempt.status = 'unconfirmed';
                    attempt.message = 'Delivery could not be confirmed. Check the receiving task before another send.';
                }
                return record;
            }
        );
    }

    recordProgress(id, observation) {
        return this.#change(
            id,
            async function recordReceivingTaskProgress(record) {
                if (!['accepted', 'started', 'completed'].includes(record.status)) {
                    throw handoffInputError('Destination acceptance is required before recording receiving-task progress.');
                }
                if (!['started', 'completed'].includes(observation.state) || !observation.message || !observation.observedAt || !observation.actor) {
                    throw handoffInputError('Record the observed state, evidence, time, and actor.');
                }
                record.observations.push(structuredClone(observation));
                record.status = observation.state;
                return record;
            }
        );
    }

    async #checkTasks(record) {
        for (const taskId of [record.fromTaskId, record.toTaskId]) {
            if (!taskId) continue;
            const task = await this.#pmData.getTask(taskId);
            if (!task || task.projectId !== record.projectId) {
                throw handoffInputError('Choose a task from this handoff’s project.');
            }
        }
    }

    async #save(record) {
        const db = await this.#getStorage();
        record.updatedAt = new Date().toISOString();
        await db.set(HANDOFF_TABLE, `${record.id}.json`, record);
    }

    async #listResources({projectId, signal} = {}) {
        const records = await this.list({signal});
        const uses = new Map();
        for (const record of records) {
            for (const original of record.originals) {
                const key = original.originalFileRef?.key;
                if (!key) continue;
                if (!uses.has(key)) uses.set(key, []);
                uses.get(key).push(record.id);
            }
        }
        const resources = [];
        for (const record of records) {
            if (projectId !== undefined && record.projectId !== projectId) continue;
            for (const ref of record.retainedFiles || []) {
                const usedBy = uses.get(ref.key) || [];
                resources.push({
                    id: ref.key,
                    projectId: record.projectId,
                    handoffId: record.id,
                    title: ref.name,
                    owner: 'Arcane PM handoffs',
                    purpose: 'A complete file snapshot retained during handoff preparation.',
                    location: 'Local handoff storage',
                    appOwned: true,
                    lifecycle: usedBy.length ? 'retained' : 'disposable',
                    usedBy
                });
            }
        }
        return resources;
    }

    async #disposeResource(id, {signal} = {}) {
        const resources = await this.#listResources({signal});
        const resource = resources.find(function findOwnedOriginal(candidate) {
            return candidate.id === id;
        });
        if (!resource || resource.usedBy.length) return {id, disposed: false};
        signal?.throwIfAborted();
        const service = this;
        await this.#change(resource.handoffId, async function removeRegisteredOriginal(record) {
            const db = await service.#getStorage();
            signal?.throwIfAborted();
            await db.delete(ORIGINAL_TABLE, id);
            record.retainedFiles = record.retainedFiles.filter(function keepOtherOriginal(ref) {
                return ref.key !== id;
            });
            return record;
        });
        return {id, disposed: true};
    }

    #change(id, operation) {
        const service = this;
        return editDomain(
            `arcane-pm:handoff:${id}`,
            async function mutateOneHandoff() {
                const record = await service.get(id);
                if (!record) throw handoffInputError('The selected handoff is unavailable.');
                const changed = await operation(record);
                try {
                    await service.#save(changed);
                } catch (error) {
                    error.handoffOutcome = structuredClone(changed);
                    throw error;
                }
                return structuredClone(changed);
            }
        );
    }
}

function editDomain(key, operation) {
    if (globalThis.navigator?.locks?.request) return navigator.locks.request(key, operation);
    const previous = pendingEdits.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    pendingEdits.set(key, current);
    function releaseDomainEdit() {
        if (pendingEdits.get(key) === current) pendingEdits.delete(key);
    }
    current.then(releaseDomainEdit, releaseDomainEdit);
    return current;
}

function hasBinaryOriginal(original) {
    return Boolean(original.originalFileRef);
}

function sameHandoffHost(left, right) {
    return left?.provider === 'codex' && right?.provider === 'codex'
        && Boolean(left.hostId) && left.hostId === right.hostId;
}

function sameHandoffOrigin(left, right) {
    return sameHandoffHost(left, right)
        && Boolean(left.accountId) && left.accountId === right.accountId;
}

function sameHandoffIdentity(left, right) {
    return left?.connectionId !== undefined && left?.connectionId !== null
        && left.connectionId === right?.connectionId
        && sameHandoffOrigin(left.originIdentity, right.originIdentity);
}

function deliveryInput(record) {
    const input = [
        {
            type: 'text',
            text: `Arcane PM handoff ${record.id}. The next four separate inputs are the assignment, decisions, open questions, and prepared note, in that order. Each following source has a separate metadata input immediately before its unchanged original content.`,
            text_elements: []
        }
    ];
    for (const text of [record.assignment, record.decisions, record.openQuestions, record.preparedNote]) {
        input.push({type: 'text', text, text_elements: []});
    }
    for (const original of record.originals) {
        const source = original.source;
        input.push(
            {
                type: 'text',
                text: `Source reference: ${source.id}\nTitle: ${source.title}\nLocation: ${source.location || ''}`,
                text_elements: []
            }
        );
        if (typeof original.content === 'string') {
            input.push({type: 'text', text: original.content, text_elements: []});
        }
    }
    return input;
}

function requireEditable(record) {
    if (!['preparing', 'ready'].includes(record.status)) {
        throw handoffInputError('Reopen this handoff as a new draft to preserve the delivery record.');
    }
}

function handoffInputError(message) {
    const error = new Error(message);
    error.code = 'PM_HANDOFF_INPUT';
    return error;
}
