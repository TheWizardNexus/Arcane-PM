import {join} from 'node:path';
import {CoreError, serializeCoreError} from 'arcane-os/core/contracts';
import CodexAppServer from './CodexAppServer.mjs';
import {readProjectCatalog} from './project-catalog.mjs';

const SOURCE_KINDS = [
    'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
    'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'
];

/** PM task operations composed by the published Arcane Core runtime. */
export function createCodexService(options = {}) {
    const codex = new CodexAppServer(options);

    function status() {
        codex.emit('pm.codex.state', codex.current());
        codex.replayRequests();
        return codex.current();
    }

    function unavailable() {
        return {
            status: 'unavailable', accepted: false, reason: 'codex-disconnected',
            message: 'Connect Codex to use this operation.'
        };
    }

    async function listThreads(parameters = {}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const connectionId = codex.connection;
        const originIdentity = codex.identity();
        const accountRevision = codex.accountRevision;
        const {cursor: requestedCursor, ...filters} = parameters;
        const threads = [];
        const pages = [];
        const archiveObservations = [];
        let cursor = requestedCursor;
        let complete = false;
        let failure = null;
        try {
            do {
                signal?.throwIfAborted();
                const request = {
                    ...filters,
                    sourceKinds: SOURCE_KINDS,
                    modelProviders: [],
                    useStateDbOnly: true,
                    ...(cursor === undefined ? {} : {cursor})
                };
                const page = await codex.request('thread/list', request, {signal});
                pages.push(page);
                if (!Array.isArray(page.data)) {
                    throw new CoreError({code: 'PM_CODEX_THREAD_PAGE_INVALID', message: 'Codex returned an incomplete thread page.'});
                }
                const observedAt = new Date().toISOString();
                for (const thread of page.data) {
                    threads.push(thread);
                    archiveObservations.push({threadId: thread.id, archived: parameters.archived === true, observedAt});
                }
                cursor = page.nextCursor ?? null;
            } while (cursor !== null);
            complete = requestedCursor === undefined || requestedCursor === null;
        } catch (error) {
            if (signal?.aborted) throw error;
            if (!pages.length) throw error;
            failure = serializeCoreError(error);
            codex.diagnostic('listThreads', error);
        }
        return {
            status: complete ? 'available' : 'partial', threads, pages, archiveObservations,
            identity: readIdentity(connectionId, originIdentity, accountRevision),
            coverage: {complete, scope: 'state-database-threads', archived: parameters.archived === true, nextCursor: cursor ?? null},
            ...(failure ? {diagnostic: failure} : {}),
            observedAt: new Date().toISOString()
        };
    }

    async function listProjects(parameters, context) {
        const listing = await listThreads(parameters, context);
        if (listing.status === 'unavailable') return listing;
        const associations = new Map();
        for (const thread of listing.threads) {
            if (!thread.cwd) continue;
            let project = associations.get(thread.cwd);
            if (!project) {
                project = {cwd: thread.cwd, directory: thread.cwd, threadIds: [], nativeProjectIds: []};
                associations.set(thread.cwd, project);
            }
            project.threadIds.push(thread.id);
            if (thread.projectId && !project.nativeProjectIds.includes(thread.projectId)) project.nativeProjectIds.push(thread.projectId);
        }
        return {
            status: listing.status,
            projects: [...associations.values()],
            nativeRegistryAvailable: false,
            identity: listing.identity,
            coverage: {...listing.coverage, scope: 'observed-thread-working-directories'},
            original: listing,
            observedAt: listing.observedAt
        };
    }

    async function discoverWorkspace(parameters = {}, context = {}) {
        const accountRevision = codex.accountRevision;
        const {threadId, ...listParameters} = parameters;
        const completeInventory = threadId === undefined && !Object.hasOwn(listParameters, 'archived')
            && listParameters.cursor == null;
        const unfilteredInventory = completeInventory && ['cwd', 'searchTerm', 'sectionId', 'originators'].every(
            function noDiscoveryFilter(key) { return !Object.hasOwn(listParameters, key); }
        );
        const [threads, projectCatalog] = await Promise.all([
            threadId !== undefined ? readThread({threadId}, context)
                : completeInventory ? listTaskInventory(listParameters, context) : listThreads(listParameters, context),
            readProjectCatalog(codex, {signal: context.signal})
        ]);
        context.signal?.throwIfAborted();
        if (unfilteredInventory && threads.status !== 'unavailable') {
            await readMissingProjectTasks(threads, projectCatalog, context);
        }
        if (accountRevision !== codex.accountRevision
            || (threads.identity && !codex.matchIdentity(threads.identity))) threads.identity = null;
        return {threads, projectCatalog};
    }

    async function listTaskInventory(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const connectionId = codex.connection;
        const originIdentity = codex.identity();
        const accountRevision = codex.accountRevision;
        const archiveStates = [false, true];
        const results = await Promise.allSettled(archiveStates.map(function readArchivePartition(archived) {
            return listThreads({...parameters, archived}, {signal});
        }));
        signal?.throwIfAborted();
        const threads = [];
        const pages = [];
        const archiveObservations = [];
        const partitions = [];
        for (const [index, result] of results.entries()) {
            const archived = archiveStates[index];
            if (result.status === 'rejected') {
                codex.diagnostic('task-inventory', result.reason, {archived});
                partitions.push({archived, status: 'unavailable', coverage: {complete: false}, diagnostic: serializeCoreError(result.reason)});
                continue;
            }
            const listing = result.value;
            for (const thread of listing.threads || []) threads.push(thread);
            for (const page of listing.pages || []) pages.push(page);
            for (const observation of listing.archiveObservations || []) archiveObservations.push(observation);
            const {threads: partitionThreads, pages: partitionPages, archiveObservations: observations, ...partition} = listing;
            partitions.push({archived, ...partition});
        }
        const complete = partitions.every(function completePartition(partition) { return partition.coverage?.complete; });
        const identity = readIdentity(connectionId, originIdentity, accountRevision);
        const sameIdentity = partitions.every(function partitionIdentity(partition) {
            return partition.status === 'unavailable' || sameReadIdentity(partition.identity, identity);
        });
        return {
            status: complete ? 'available' : 'partial', threads, pages, archiveObservations, partitions,
            identity: sameIdentity ? identity : null,
            coverage: {complete, scope: 'state-database-threads', archived: 'all', atomic: false},
            observedAt: new Date().toISOString()
        };
    }

    async function readMissingProjectTasks(listing, projectCatalog, {signal} = {}) {
        const assignments = projectCatalog.desktop?.threadAssignments;
        const known = new Set(listing.threads.map(function listedThreadId(thread) { return thread.id; }));
        const missing = assignments && typeof assignments === 'object' && !Array.isArray(assignments)
            ? Object.keys(assignments).filter(function unlistedAssignedThread(threadId) { return !known.has(threadId); }) : [];
        const results = new Array(missing.length);
        let position = 0;
        async function readAssignedThread() {
            while (position < missing.length) {
                signal?.throwIfAborted();
                const index = position++;
                const threadId = missing[index];
                try {
                    const result = await readThread({threadId}, {signal});
                    results[index] = {threadId, ...result};
                } catch (error) {
                    if (signal?.aborted) throw error;
                    codex.diagnostic('assigned-thread-read', error, {threadId});
                    results[index] = {threadId, status: 'unavailable', diagnostic: serializeCoreError(error)};
                }
            }
        }
        const workers = Array.from({length: Math.min(4, missing.length)}, readAssignedThread);
        await Promise.all(workers);
        signal?.throwIfAborted();
        for (const result of results) {
            if (result.thread) listing.threads.push(result.thread);
            if (result.thread && !sameReadIdentity(result.identity, listing.identity)) listing.identity = null;
        }
        const complete = projectCatalog.desktop?.coverage?.complete === true
            && results.every(function assignmentReadComplete(result) { return result.status === 'available'; });
        listing.assignmentReads = results;
        listing.coverage = {...listing.coverage, assignmentsComplete: complete};
        if (!complete) {
            listing.coverage.complete = false;
            listing.status = 'partial';
        }
        // Assignment reads retain their own observed identities. Retire the
        // combined mapping if any connection/account changed while they ran.
        const selected = listing.identity;
        if (selected && !codex.matchIdentity(selected)) listing.identity = null;
    }

    async function readThread({threadId}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const connectionId = codex.connection;
        const originIdentity = codex.identity();
        const accountRevision = codex.accountRevision;
        const original = await codex.request('thread/read', {threadId, includeTurns: false}, {signal});
        return {
            status: 'available', threadId, thread: original.thread, original,
            identity: readIdentity(connectionId, originIdentity, accountRevision),
            observedAt: new Date().toISOString()
        };
    }

    function readIdentity(connectionId, originIdentity, accountRevision) {
        const current = codex.identity();
        if (!originIdentity || !current || connectionId !== codex.connection || accountRevision !== codex.accountRevision
            || originIdentity.accountId !== current.accountId
            || originIdentity.hostId !== current.hostId) return null;
        return {connectionId, originIdentity};
    }

    function sameReadIdentity(left, right) {
        return Boolean(left && right && left.connectionId === right.connectionId
            && left.originIdentity?.provider === right.originIdentity?.provider
            && left.originIdentity?.accountId === right.originIdentity?.accountId
            && left.originIdentity?.hostId === right.originIdentity?.hostId);
    }

    async function readDirectory(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const original = await codex.request('fs/readDirectory', parameters, {signal});
        // Codex returns child names. PM's native host supplies routing paths on
        // the same platform as its owned Codex process; originals stay intact.
        const children = original.entries.map(function childRoutingPath({fileName}) {
            return {fileName, path: join(parameters.path, fileName)};
        });
        return {status: 'available', path: parameters.path, original, children, observedAt: new Date().toISOString()};
    }

    async function readFile(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const original = await codex.request('fs/readFile', parameters, {signal});
        return {status: 'available', path: parameters.path, original, observedAt: new Date().toISOString()};
    }

    async function getFileMetadata(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const original = await codex.request('fs/getMetadata', parameters, {signal});
        return {status: 'available', path: parameters.path, original, observedAt: new Date().toISOString()};
    }

    async function readConversation({threadId}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const turns = [];
        const pages = [];
        const failures = [];
        let cursor;
        let thread = null;
        let metadata = null;
        let pagesComplete = false;
        let allItemsFull = true;
        const historyRead = readTurnPages();
        const metadataRead = readMetadata();
        await Promise.all([historyRead, metadataRead]);

        async function readTurnPages() {
            try {
                do {
                    signal?.throwIfAborted();
                    const page = await codex.request('thread/turns/list', {
                        threadId, itemsView: 'full', sortDirection: 'asc',
                        ...(cursor === undefined ? {} : {cursor})
                    }, {signal});
                    pages.push(page);
                    if (!Array.isArray(page.data)) {
                        throw new CoreError({code: 'PM_CODEX_TURN_PAGE_INVALID', message: 'Codex returned an incomplete conversation page.'});
                    }
                    for (const turn of page.data) {
                        turns.push(turn);
                        // Codex 0.160.0 declares omitted itemsView as full.
                        if (!Array.isArray(turn.items) || (turn.itemsView !== undefined && turn.itemsView !== 'full')) allItemsFull = false;
                    }
                    cursor = page.nextCursor ?? null;
                } while (cursor !== null);
                pagesComplete = true;
            } catch (error) {
                if (signal?.aborted) throw error;
                failures.push(serializeCoreError(error));
                codex.diagnostic('readConversation', error);
            }
        }

        async function readMetadata() {
            try {
                signal?.throwIfAborted();
                metadata = await codex.request('thread/read', {threadId, includeTurns: false}, {signal});
                thread = metadata.thread;
            } catch (error) {
                if (signal?.aborted) throw error;
                failures.push(serializeCoreError(error));
                codex.diagnostic('readConversation-metadata', error);
            }
        }
        const complete = pagesComplete && allItemsFull && thread !== null && thread !== undefined;
        return {
            status: complete ? 'available' : pages.length ? 'partial' : 'unavailable',
            threadId,
            original: {thread, turns, pages, metadata},
            coverage: {
                complete, scope: 'accessible-history', pagesComplete, allItemsFull,
                nextCursor: cursor ?? null,
                reason: complete ? null : allItemsFull ? 'history-unavailable' : 'full-items-unavailable'
            },
            ...(failures.length ? {diagnostics: failures} : {}),
            observedAt: new Date().toISOString()
        };
    }

    async function resumeThread(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const result = await codex.request('thread/resume', {...parameters, excludeTurns: true}, {signal, mutation: true});
        return {status: 'available', threadId: result.thread.id, thread: result.thread, acknowledgment: result, observedAt: new Date().toISOString()};
    }

    async function createTask(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const input = taskInput(parameters);
        const {content, input: originalInput, effort, ...threadParameters} = parameters;
        const selectedEffort = effort ?? threadParameters.config?.model_reasoning_effort ?? 'ultra';
        const started = await codex.request('thread/start', {
            ...threadParameters,
            model: threadParameters.model ?? 'gpt-6-astra',
            config: {...threadParameters.config, model_reasoning_effort: selectedEffort}
        }, {signal, mutation: true});
        const threadId = started.thread?.id;
        if (!threadId) throw incompleteAcknowledgment('thread/start', started);
        try {
            signal?.throwIfAborted();
            const result = await codex.request('turn/start', {threadId, input}, {signal, mutation: true});
            return {...acceptedTurn(threadId, result), thread: started.thread, creationAcknowledgment: started};
        } catch (error) {
            throw new CoreError({...serializeCoreError(error), createdThreadId: threadId, creationAcknowledgment: started});
        }
    }

    async function continueTask(parameters, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const input = taskInput(parameters);
        const {content, input: originalInput, identity, ...turnParameters} = parameters;
        const target = identity === undefined ? null : codex.matchIdentity(identity);
        if (identity !== undefined && !target) return targetChanged();
        let resumeAcknowledgment;
        try {
            // Resume belongs to this send. Both queued writes use the same
            // selected destination; native loaded state is never cached.
            resumeAcknowledgment = await codex.request('thread/resume', {
                threadId: parameters.threadId, excludeTurns: true
            }, {signal, mutation: true, selectedIdentity: target});
            const result = await codex.request('turn/start', {...turnParameters, input}, {
                signal, mutation: true, selectedIdentity: target
            });
            return {
                ...acceptedTurn(parameters.threadId, result), resumeAcknowledgment,
                ...(target ? {identity: target} : {})
            };
        } catch (error) {
            if (error.code === 'PM_CODEX_TARGET_CHANGED' && resumeAcknowledgment === undefined) return targetChanged();
            throw new CoreError({
                ...serializeCoreError(error), threadId: parameters.threadId,
                ...(target ? {identity: target} : {}),
                ...(resumeAcknowledgment === undefined ? {} : {resumeAcknowledgment})
            });
        }
    }

    function sendHandoff(parameters, context) {
        if (!parameters.identity) return targetChanged();
        return continueTask(parameters, context);
    }

    function targetChanged() {
        return {
            status: 'unavailable', accepted: false, reason: 'target-changed',
            message: 'The selected Codex connection changed. Review the task before continuing.'
        };
    }

    async function archiveThread({threadId, identity}, {signal} = {}) {
        const target = codex.matchIdentity(identity);
        if (!target) return targetChanged();
        try {
            const acknowledgment = await codex.request('thread/archive', {threadId}, {signal, mutation: true, selectedIdentity: target});
            return {
                status: 'archived', threadId, acknowledgment, identity: target,
                scope: {rootThreadId: threadId, descendants: 'attempted-by-codex', descendantOutcomes: 'thread/archived-notifications'},
                observedAt: new Date().toISOString()
            };
        } catch (error) {
            if (error.code === 'PM_CODEX_TARGET_CHANGED') return targetChanged();
            throw error;
        }
    }

    async function restoreThread({threadId, identity}, {signal} = {}) {
        const target = codex.matchIdentity(identity);
        if (!target) return targetChanged();
        try {
            const acknowledgment = await codex.request('thread/unarchive', {threadId}, {signal, mutation: true, selectedIdentity: target});
            return {status: 'restored', threadId, thread: acknowledgment.thread, acknowledgment, identity: target, observedAt: new Date().toISOString()};
        } catch (error) {
            if (error.code === 'PM_CODEX_TARGET_CHANGED') return targetChanged();
            throw error;
        }
    }

    async function deleteThread({threadId, identity}, {signal} = {}) {
        const target = codex.matchIdentity(identity);
        if (!target) return targetChanged();
        try {
            const acknowledgment = await codex.request('thread/delete', {threadId}, {signal, mutation: true, selectedIdentity: target});
            return {
                status: 'deleted', threadId, acknowledgment, identity: target,
                scope: {rootThreadId: threadId, descendants: 'attempted-by-codex', descendantOutcomes: 'thread/deleted-notifications'},
                observedAt: new Date().toISOString()
            };
        } catch (error) {
            if (error.code === 'PM_CODEX_TARGET_CHANGED') return targetChanged();
            throw error;
        }
    }

    async function cancelTurn({threadId, turnId}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const acknowledgment = await codex.request('turn/interrupt', {threadId, turnId}, {signal, mutation: true});
        return {status: 'interruption-requested', threadId, turnId, acknowledgment, observedAt: new Date().toISOString()};
    }

    function respondToRequest(parameters, context) {
        if (codex.state !== 'connected') return unavailable();
        return codex.respond(parameters, context);
    }

    function start({emit}) {
        codex.setEmitter(emit);
        codex.emit('pm.codex.state', codex.current());
    }

    function connect() { return codex.connect(); }
    function disconnect() { return codex.disconnect(); }
    function dispose() { return codex.disconnect(); }

    return {
        name: 'pm.codex',
        start,
        methods: {
            'pm.codex.status': status,
            'pm.codex.connect': {lifetime: 'service', handle: connect},
            'pm.codex.disconnect': {lifetime: 'service', handle: disconnect},
            'pm.codex.listThreads': listThreads,
            'pm.codex.listProjects': listProjects,
            'pm.codex.discoverWorkspace': discoverWorkspace,
            'pm.codex.readConversation': readConversation,
            'pm.codex.readThread': readThread,
            'pm.codex.readDirectory': readDirectory,
            'pm.codex.readFile': readFile,
            'pm.codex.getFileMetadata': getFileMetadata,
            'pm.codex.resumeThread': resumeThread,
            'pm.codex.createTask': createTask,
            'pm.codex.continueTask': continueTask,
            'pm.codex.sendHandoff': sendHandoff,
            'pm.codex.archiveThread': archiveThread,
            'pm.codex.restoreThread': restoreThread,
            'pm.codex.deleteThread': deleteThread,
            'pm.codex.cancelTurn': cancelTurn,
            'pm.codex.respondToRequest': respondToRequest
        },
        dispose
    };
}

function taskInput(parameters) {
    if (Object.hasOwn(parameters, 'input')) {
        if (Object.hasOwn(parameters, 'content')) throw new TypeError('Supply input or content, not both.');
        if (!Array.isArray(parameters.input)) throw new TypeError('Native input must be an array.');
        return parameters.input;
    }
    if (typeof parameters.content !== 'string') throw new TypeError('Task content must be the complete prepared string.');
    return [{type: 'text', text: parameters.content}];
}

function acceptedTurn(threadId, acknowledgment) {
    if (!acknowledgment.turn?.id) throw incompleteAcknowledgment('turn/start', acknowledgment);
    return {
        accepted: true, status: 'accepted', threadId,
        turnId: acknowledgment.turn.id, acknowledgment,
        acceptedAt: new Date().toISOString()
    };
}

function incompleteAcknowledgment(method, acknowledgment) {
    return new CoreError({
        code: 'PM_CODEX_ACKNOWLEDGMENT_INCOMPLETE',
        message: 'Codex returned an incomplete acknowledgment. Inspect the destination before sending again.',
        method, outcome: 'unknown', acknowledgment
    });
}

export default createCodexService;
