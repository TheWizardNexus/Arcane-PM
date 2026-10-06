import {CoreError, serializeCoreError} from 'arcane-os/core/contracts';
import CodexAppServer from './CodexAppServer.mjs';

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
        const {cursor: requestedCursor, ...filters} = parameters;
        const threads = [];
        const pages = [];
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
                for (const thread of page.data) threads.push(thread);
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
            status: complete ? 'available' : 'partial', threads, pages,
            coverage: {complete, scope: 'accessible-threads', archived: parameters.archived === true, nextCursor: cursor ?? null},
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
            coverage: {...listing.coverage, scope: 'observed-thread-working-directories'},
            original: listing,
            observedAt: listing.observedAt
        };
    }

    async function readThread({threadId}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const original = await codex.request('thread/read', {threadId, includeTurns: false}, {signal});
        return {status: 'available', threadId, thread: original.thread, original, observedAt: new Date().toISOString()};
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

    async function ensureResumed(threadId, signal) {
        // Resume belongs to this send, including its cancellation. Native state
        // can change independently between sends, so no loaded-state cache is used.
        await codex.request('thread/resume', {threadId, excludeTurns: true}, {signal, mutation: true});
        signal?.throwIfAborted();
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
        const {content, input: originalInput, ...turnParameters} = parameters;
        await ensureResumed(parameters.threadId, signal);
        const result = await codex.request('turn/start', {...turnParameters, input}, {signal, mutation: true});
        return acceptedTurn(parameters.threadId, result);
    }

    function sendHandoff(parameters, context) {
        return continueTask(parameters, context);
    }

    async function archiveThread({threadId}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const acknowledgment = await codex.request('thread/archive', {threadId}, {signal, mutation: true});
        return {
            status: 'archived', threadId, acknowledgment,
            scope: {rootThreadId: threadId, descendants: 'attempted-by-codex', descendantOutcomes: 'thread/archived-notifications'},
            observedAt: new Date().toISOString()
        };
    }

    async function restoreThread({threadId}, {signal} = {}) {
        if (codex.state !== 'connected') return unavailable();
        const acknowledgment = await codex.request('thread/unarchive', {threadId}, {signal, mutation: true});
        return {status: 'restored', threadId, thread: acknowledgment.thread, acknowledgment, observedAt: new Date().toISOString()};
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
            'pm.codex.readConversation': readConversation,
            'pm.codex.readThread': readThread,
            'pm.codex.resumeThread': resumeThread,
            'pm.codex.createTask': createTask,
            'pm.codex.continueTask': continueTask,
            'pm.codex.sendHandoff': sendHandoff,
            'pm.codex.archiveThread': archiveThread,
            'pm.codex.restoreThread': restoreThread,
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
