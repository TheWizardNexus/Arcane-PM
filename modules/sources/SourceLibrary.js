import DBOPFSDocumentLibrary from 'arcane-os/dbopfs-document-library';

const TABLES = {
    records: 'pm_sources',
    originals: 'pm_source_originals',
    text: 'pm_source_text',
    preferences: 'pm_source_preferences'
};

function assertActive(signal) {
    signal?.throwIfAborted();
}

function sourceError(message, code = 'PM_SOURCE_UNAVAILABLE') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function reportProgress(callback, state) {
    try {
        callback?.(state);
    } catch (error) {
        console.error('Source progress observer failed.', error);
    }
}

function sourceDocument(source, body) {
    return {
        id: source.id,
        kind: source.kind,
        title: source.title,
        path: source.id,
        sourcePath: source.location || '',
        body,
        mediaType: 'text/plain',
        searchTerms: (source.searchTerms || []).filter(
            function searchableMetadata(value) {
                return typeof value === 'string' && value.trim();
            }
        ),
        tags: source.archivedAt ? ['archived'] : []
    };
}

/** PM associations and original retention on the data owner's shared store. */
export function createSourceLibrary({getStorage, pmData, bridge} = {}) {
    let initialization;
    let mutation = Promise.resolve();
    let corpusReady = false;
    const staleTasks = new Set();
    const taskRevisions = new Map();
    const refreshedSources = new Set();
    const conversationRefreshes = new Map();

    const unsubscribe = pmData?.subscribe(
        function observeTaskChange(change) {
            if (change.recordType === 'task') {
                staleTasks.add(change.id);
                taskRevisions.set(change.id, change.record?.updatedAt ?? null);
            }
        }
    );

    function storage() {
        if (!initialization) {
            initialization = initializeStorage();
        }
        return initialization;
    }

    async function initializeStorage() {
        try {
            const db = await getStorage();
            const library = new DBOPFSDocumentLibrary(
                {
                    db,
                    schema: {id: 'arcane-pm-sources', version: '1', table: 'pm_source_documents'},
                    concurrency: 4
                }
            );
            return {db, library};
        } catch (error) {
            initialization = null;
            throw error;
        }
    }

    function mutate(operation) {
        const next = mutation.then(operation, operation);
        mutation = next.catch(
            function retainMutationFailure(error) {
                console.error('PM source operation failed; originals remain with their owner.', error);
            }
        );
        return next;
    }

    async function list({projectId, indexed, signal} = {}) {
        assertActive(signal);
        const {db} = await storage();
        const keys = (await db.getAllKeys(TABLES.records)).sort();
        const records = [];
        const failures = [];
        for (let start = 0; start < keys.length; start += 4) {
            assertActive(signal);
            const batch = keys.slice(start, start + 4);
            const results = await Promise.allSettled(
                batch.map(
                    function readSourceRecord(key) {
                        return db.get(TABLES.records, key, true);
                    }
                )
            );
            assertActive(signal);
            results.forEach(
                function collectSourceRecord(result, position) {
                    if (result.status === 'rejected' || !result.value?.id) {
                        failures.push({key: batch[position], error: result.reason || sourceError('Source metadata is unavailable.')});
                        return;
                    }
                    const source = structuredClone(result.value);
                    if (projectId !== undefined && source.projectId !== projectId) return;
                    if (indexed !== undefined && source.indexed !== indexed) return;
                    if (source.freshness === 'current' && !refreshedSources.has(source.id)) source.freshness = 'snapshot';
                    if (staleTasks.has(source.taskId)) source.freshness = 'stale';
                    records.push(source);
                }
            );
        }
        if (failures.length) {
            const error = sourceError('Some retained source records could not be read.', 'PM_SOURCE_READ_PARTIAL');
            error.sources = records;
            error.failures = failures;
            throw error;
        }
        return records;
    }

    async function rebuild({signal, onProgress} = {}) {
        const {db, library} = await storage();
        const records = await list({indexed: true, signal});
        const descriptors = records.map(
            function describeSource(source) {
                const document = sourceDocument(source, undefined);
                delete document.body;
                return document;
            }
        );
        const byId = new Map(
            records.map(
                function mapSource(source) {
                    return [source.id, source];
                }
            )
        );
        const result = await library.bootstrap(
            {
                files: descriptors,
                signal,
                onProgress,
                async read(document) {
                    const source = byId.get(document.id);
                    if (!source.textKey) return '';
                    return readText(db, source.textKey);
                }
            }
        );
        corpusReady = result.completed === true;
        return result;
    }

    async function readText(db, key) {
        if (key.endsWith('.json')) {
            const record = await db.get(TABLES.text, key, true);
            if (typeof record?.content !== 'string') {
                throw sourceError('Retained source text is unavailable.');
            }
            return record.content;
        }
        const file = await db.readFile(TABLES.text, key);
        const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
        return decoder.decode(await file.arrayBuffer());
    }

    function importSources(records, options = {}) {
        return mutate(
            function retainImportedSources() {
                return retainSources(records, options);
            }
        );
    }

    // The caller owns the corpus queue through lookup, revision writes and indexing.
    async function retainSources(records, options) {
        assertActive(options.signal);
        const {db} = await storage();
        const sources = [];
        const failures = [];
        if (records.length) corpusReady = false;
        reportProgress(options.onProgress, {phase: 'retaining', completed: 0, total: records.length});
        for (const input of records) {
            assertActive(options.signal);
            try {
                if (typeof input.title !== 'string' || !input.title.trim()) {
                    throw sourceError('A source title is required.', 'PM_SOURCE_INPUT');
                }
                if (input.content !== null && input.content !== undefined && typeof input.content !== 'string') {
                    throw sourceError('Source content must be complete text or null.', 'PM_SOURCE_INPUT');
                }
                const id = input.id || crypto.randomUUID();
                const previous = await db.get(TABLES.records, `${id}.json`, true);
                const now = new Date().toISOString();
                // Each retained revision has its own original keys; metadata commits last.
                const revision = crypto.randomUUID();
                const textKey = typeof input.content === 'string' ? `${id}-${revision}.json` : null;
                const originalKey = input.originalFile ? `${id}-${revision}.original` : null;
                if (textKey) await db.set(TABLES.text, textKey, {content: input.content});
                if (originalKey) await db.writeFile(TABLES.originals, originalKey, input.originalFile);
                const source = {
                    id,
                    kind: input.kind || 'note',
                    title: input.title,
                    projectId: input.projectId !== undefined ? input.projectId : previous?.projectId ?? null,
                    taskId: input.taskId !== undefined ? input.taskId : previous?.taskId ?? null,
                    accountId: input.accountId ?? input.origin?.accountId ?? null,
                    origin: input.origin ?? null,
                    location: input.location ?? null,
                    importedAt: previous?.importedAt || now,
                    refreshedAt: now,
                    archivedAt: input.archivedAt ?? null,
                    indexed: input.indexed ?? previous?.indexed ?? true,
                    freshness: input.freshness || 'snapshot',
                    searchTerms: input.searchTerms || [],
                    textKey,
                    originalKey,
                    originalName: input.originalFile?.name || null,
                    originalType: input.originalFile?.type || null,
                    externalKey: input.externalKey ?? null,
                    message: input.message ?? null
                };
                assertActive(options.signal);
                await db.set(TABLES.records, `${id}.json`, source);
                refreshedSources.add(id);
                sources.push(source);
            } catch (error) {
                if (options.signal?.aborted) throw error;
                failures.push({id: input.id || null, title: input.title, error});
            }
            reportProgress(options.onProgress, {phase: 'retaining', completed: sources.length + failures.length, total: records.length});
        }
        if (sources.length) {
            try {
                const index = await rebuild(options);
                failures.push(...(index.readCoverage?.failures || []));
            } catch (error) {
                if (options.signal?.aborted) throw error;
                failures.push({phase: 'index', error});
            }
        }
        return {sources, failures};
    }

    async function importFiles(files, options = {}) {
        const inputs = [];
        const failures = [];
        const selected = Array.from(files);
        for (let start = 0; start < selected.length; start += 4) {
            assertActive(options.signal);
            const results = await Promise.allSettled(
                selected.slice(start, start + 4).map(
                    async function readSelectedFile(file) {
                        let content = null;
                        if (file.type.startsWith('text/') || /\.(txt|md|json|jsonl|js|css|html|csv|log|xml|yaml|yml)$/i.test(file.name)) {
                            try {
                                const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
                                content = decoder.decode(await file.arrayBuffer());
                            } catch (error) {
                                if (error instanceof TypeError) {
                                    failures.push({title: file.name, phase: 'text-decoding', error});
                                } else {
                                    throw error;
                                }
                            }
                        }
                        return {
                            id: options.sourceId,
                            kind: 'file',
                            title: file.name,
                            content,
                            originalFile: file,
                            location: file.webkitRelativePath || file.name,
                            projectId: options.projectId ?? null,
                            taskId: options.taskId ?? null,
                            freshness: 'snapshot'
                        };
                    }
                )
            );
            for (const result of results) {
                if (result.status === 'fulfilled') inputs.push(result.value);
                else failures.push({phase: 'file-read', error: result.reason});
            }
        }
        assertActive(options.signal);
        const retained = await importSources(inputs, options);
        return {sources: retained.sources, failures: [...failures, ...retained.failures]};
    }

    function importTasks(options = {}) {
        return mutate(async function retainCurrentTasks() {
            assertActive(options.signal);
            const task = options.taskId ? await pmData.getTask(options.taskId) : null;
            if (options.taskId && !task) throw sourceError('The related task is unavailable. Its retained snapshot remains available.');
            const tasks = task ? [task] : await pmData.listTasks({projectId: options.projectId, signal: options.signal});
            const existing = await list({signal: options.signal});
            const byTask = new Map();
            for (const source of existing) {
                if (source.kind === 'task') byTask.set(source.taskId, source);
            }
            const changedTasks = tasks.filter(
                function taskChanged(task) {
                    return byTask.get(task.id)?.externalKey !== task.updatedAt;
                }
            );
            const inputs = changedTasks.map(
                function mapTask(task) {
                    return {
                        id: byTask.get(task.id)?.id,
                        kind: 'task',
                        title: task.title,
                        content: task.assignment,
                        taskId: task.id,
                        projectId: task.projectId,
                        origin: task.origin,
                        location: task.workFolder || null,
                        archivedAt: task.archivedAt,
                        externalKey: task.updatedAt,
                        searchTerms: [...task.decisions, ...task.openQuestions, task.nextAction, task.status],
                        freshness: 'current'
                    };
                }
            );
            const result = await retainSources(inputs, options);
            for (const source of result.sources) {
                if (!taskRevisions.has(source.taskId) || taskRevisions.get(source.taskId) === source.externalKey) {
                    staleTasks.delete(source.taskId);
                }
            }
            return result;
        });
    }

    function importConversation(taskId, options = {}) {
        // Same-task snapshots retain read order without holding the corpus during native I/O.
        const previous = conversationRefreshes.get(taskId) || Promise.resolve();
        const current = previous.then(readAndRetainConversation, readAndRetainConversation);
        conversationRefreshes.set(taskId, current);
        function releaseConversationRefresh() {
            if (conversationRefreshes.get(taskId) === current) conversationRefreshes.delete(taskId);
        }
        current.then(releaseConversationRefresh, releaseConversationRefresh);
        return current;

        async function readAndRetainConversation() {
            assertActive(options.signal);
            const task = await pmData.getTask(taskId);
            assertActive(options.signal);
            if (!task?.origin?.threadId || !bridge?.readConversation) {
                throw sourceError('Connect this task to an accessible Codex conversation before importing its complete history.');
            }
            const result = await bridge.readConversation({threadId: task.origin.threadId, signal: options.signal});
            assertActive(options.signal);
            if (result.coverage?.complete !== true || !Array.isArray(result.original?.turns)) {
                throw sourceError('The connection has not supplied complete accessible history. Retained originals remain available.', 'PM_SOURCE_HISTORY_UNAVAILABLE');
            }
            return mutate(async function retainConversationSnapshot() {
                assertActive(options.signal);
                const currentTask = await pmData.getTask(taskId) || task;
                const existing = await list({signal: options.signal});
                const previousByKey = new Map();
                for (const source of existing) {
                    if (source.kind === 'conversation' && source.taskId === taskId
                        && source.accountId === (task.origin.accountId ?? null)
                        && source.origin?.provider === task.origin.provider
                        && source.origin?.hostId === task.origin.hostId
                        && source.origin?.threadId === task.origin.threadId) {
                        previousByKey.set(source.externalKey, source);
                    }
                }
                const inputs = [];
                const unavailableAttachments = [];
                for (const turn of result.original.turns) {
                    for (const item of turn.items) {
                        const texts = [];
                        if (item.type === 'agentMessage') texts.push({content: item.text, role: 'assistant', partIndex: null});
                        if (item.type === 'userMessage') {
                            for (const [partIndex, part] of item.content.entries()) {
                                if (part.type === 'text') texts.push({content: part.text, role: 'user', partIndex});
                                else unavailableAttachments.push({turnId: turn.id, itemId: item.id, partIndex, kind: part.type});
                            }
                        }
                        for (const text of texts) {
                            // Native source coordinates are metadata; content is never joined or labelled.
                            const externalKey = JSON.stringify([turn.id, item.id, text.partIndex]);
                            const previous = previousByKey.get(externalKey);
                            inputs.push(
                                {
                                    id: previous?.id,
                                    kind: 'conversation',
                                    title: currentTask.title,
                                    content: text.content,
                                    projectId: currentTask.projectId,
                                    taskId,
                                    origin: task.origin,
                                    location: task.origin.url,
                                    archivedAt: currentTask.archivedAt,
                                    freshness: 'snapshot',
                                    externalKey,
                                    message: {
                                        role: text.role,
                                        nativeItemId: item.id,
                                        nativeTurnId: turn.id,
                                        partIndex: text.partIndex,
                                        turnStartedAt: turn.startedAt ?? null,
                                        turnCompletedAt: turn.completedAt ?? null
                                    }
                                }
                            );
                        }
                    }
                }
                const retained = await retainSources(inputs, options);
                return {
                    ...retained,
                    failures: [
                        ...retained.failures,
                        ...unavailableAttachments.map(
                            function reportUnretainedAttachment(attachment) {
                                return {phase: 'attachment', ...attachment, error: sourceError('An attached source remains available only through its original conversation.')};
                            }
                        )
                    ],
                    coverage: {complete: retained.failures.length === 0 && unavailableAttachments.length === 0, scope: 'visible-text', unavailableAttachments}
                };
            });
        }
    }

    async function read(id, {signal} = {}) {
        assertActive(signal);
        const {db} = await storage();
        const saved = await db.get(TABLES.records, `${id}.json`, true);
        if (!saved) return {source: {id}, content: null, originalFile: null, availability: 'unavailable', freshness: 'stale'};
        const source = structuredClone(saved);
        const freshness = staleTasks.has(source.taskId)
            ? 'stale'
            : source.freshness === 'current' && !refreshedSources.has(id)
                ? 'snapshot'
                : source.freshness;
        const results = await Promise.allSettled(
            [
                source.textKey ? readText(db, source.textKey) : null,
                source.originalKey ? db.readFile(TABLES.originals, source.originalKey) : null
            ]
        );
        const content = results[0].status === 'fulfilled' ? results[0].value : null;
        const file = results[1].status === 'fulfilled' ? results[1].value : null;
        const originalFile = file ? new File([file], source.originalName, {type: source.originalType || ''}) : null;
        const failures = [];
        for (const [position, result] of results.entries()) {
            if (result.status === 'rejected') {
                failures.push({representation: position === 0 ? 'text' : 'original-file', error: result.reason});
                console.error('Retained source representation could not be read.', {id, error: result.reason});
            }
        }
        const available = source.originalKey ? originalFile !== null : content !== null;
        const availability = available ? 'retained' : 'unavailable';
        assertActive(signal);
        return {source, content, originalFile, availability, freshness, failures};
    }

    async function refresh(id, options = {}) {
        const {source} = await read(id, options);
        if (source.kind === 'task') return importTasks({...options, taskId: source.taskId});
        if (source.kind === 'conversation') return importConversation(source.taskId, options);
        if (source.kind === 'file' && options.file) {
            return importFiles([options.file], {...options, sourceId: id, projectId: source.projectId, taskId: source.taskId});
        }
        throw sourceError('Select the working file again to retain its current original. The saved snapshot is still available.');
    }

    function query(text, options = {}) {
        assertActive(options.signal);
        reportProgress(options.onProgress, {phase: 'searching', completed: 0});
        // The SDK replaces and cleans corpus generations; a read must finish before replacement.
        return mutate(
            async function searchCorpus() {
                assertActive(options.signal);
                if (!corpusReady) await rebuild(options);
                const {db, library} = await storage();
                assertActive(options.signal);
                const queryKey = `${options.projectId ?? 'all'}.json`;
                await db.set(TABLES.preferences, `query-${queryKey}`, {query: text});
                const records = await list({projectId: options.projectId, indexed: true, signal: options.signal});
                const byId = new Map(records.map(function identifySource(source) { return [source.id, source]; }));
                const result = await library.search(text, {signal: options.signal, kinds: options.kind ? [options.kind] : undefined});
                assertActive(options.signal);
                const matches = [];
                for (const match of result.matches) {
                    const source = byId.get(match.id);
                    if (source) matches.push({source, body: match.body, score: match.score, matchedFields: match.matchedFields});
                }
                reportProgress(options.onProgress, {phase: 'complete', completed: records.length, total: records.length});
                return {query: text, matches, failures: result.failures, total: records.length};
            }
        );
    }

    async function getQuery(projectId) {
        const {db} = await storage();
        return (await db.get(TABLES.preferences, `query-${projectId ?? 'all'}.json`, true))?.query || '';
    }

    async function getSelectedIds() {
        const {db} = await storage();
        return [...((await db.get(TABLES.preferences, 'selection.json', true))?.ids || [])];
    }

    function select(id, selected = true) {
        return mutate(
            async function updateSelection() {
                const {db} = await storage();
                const ids = new Set(await getSelectedIds());
                if (selected) ids.add(id);
                else ids.delete(id);
                await db.set(TABLES.preferences, 'selection.json', {ids: [...ids]});
                return [...ids];
            }
        );
    }

    async function getSelection(options = {}) {
        const ids = await getSelectedIds();
        const sources = [];
        for (const id of ids) sources.push(await read(id, options));
        const unavailableIds = sources.filter(function unavailable(source) { return source.availability === 'unavailable'; }).map(function sourceId(source) { return source.source.id; });
        return {sources, unavailableIds, complete: unavailableIds.length === 0};
    }

    function setIndexed(id, indexed) {
        return mutate(
            async function updateIndexMembership() {
                const {db} = await storage();
                const source = await db.get(TABLES.records, `${id}.json`, true);
                if (!source) throw sourceError('The selected source record is unavailable.');
                const updated = {...source, indexed};
                await db.set(TABLES.records, `${id}.json`, updated);
                corpusReady = false;
                const index = await rebuild();
                if (index.readCoverage?.failures.length) {
                    const error = sourceError('Search membership was saved; some retained sources could not be indexed.', 'PM_SOURCE_INDEX_PARTIAL');
                    error.failures = index.readCoverage.failures;
                    throw error;
                }
                return updated;
            }
        );
    }

    return {
        importSources,
        importFiles,
        importTasks,
        importConversation,
        list,
        read,
        refresh,
        query,
        getQuery,
        select,
        getSelectedIds,
        getSelection,
        removeFromIndex(id) { return setIndexed(id, false); },
        restoreToIndex(id) { return setIndexed(id, true); },
        dispose() { unsubscribe?.(); }
    };
}
