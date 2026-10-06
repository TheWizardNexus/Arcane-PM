import DBOPFSDocumentLibrary from 'arcane-os/dbopfs-document-library';
import {createArcaneEventSource} from 'arcane-os/event-manager';

const SOURCES_CHANGED_EVENT = 'arcane-pm.sources.changed';

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

function supportsFileText(file) {
    return file.type.startsWith('text/') || /\.(txt|md|json|jsonl|js|css|html|csv|log|xml|yaml|yml)$/i.test(file.name);
}

function folderAssociation(rootPath, entryPath, projectId, taskId, origin) {
    return JSON.stringify([
        rootPath, entryPath, projectId, taskId,
        origin?.provider ?? null, origin?.accountId ?? null,
        origin?.projectId ?? null, origin?.threadId ?? null,
        origin?.hostId ?? null, origin?.url ?? null
    ]);
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
    const folderRefreshes = new Map();
    const events = createArcaneEventSource(
        {},
        {source: 'arcane-pm.sources', eventTypes: [SOURCES_CHANGED_EVENT]}
    );

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

    async function list({projectId, taskId, kind, indexed, signal} = {}) {
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
                    if (taskId !== undefined && source.taskId !== taskId) return;
                    if (kind !== undefined && source.kind !== kind) return;
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

    async function describeChange(previous, source, content) {
        let contentChanged = !previous;
        if (previous) {
            try {
                const {db} = await storage();
                const previousContent = previous.textKey ? await readText(db, previous.textKey) : null;
                contentChanged = previousContent !== (typeof content === 'string' ? content : null);
            } catch (error) {
                // A prior unreadable representation cannot establish unchanged content.
                console.error(
                    'Previous source content could not be compared.',
                    {id: source.id, error}
                );
                contentChanged = null;
            }
        }
        return {
            id: source.id,
            taskId: source.taskId,
            previousTaskId: previous?.taskId ?? null,
            projectId: source.projectId,
            previousProjectId: previous?.projectId ?? null,
            kind: source.kind,
            operation: previous ? 'updated' : 'created',
            contentChanged,
            associationChanged: !previous || previous.taskId !== source.taskId || previous.projectId !== source.projectId,
            originalChanged: (previous?.originalKey ?? null) !== source.originalKey
        };
    }

    function publishChanges(changes) {
        if (changes.length && !events.disposed) {
            events.dispatch(
                SOURCES_CHANGED_EVENT,
                {changes}
            );
        }
    }

    function subscribe(handler, options = {}) {
        return events.on(
            SOURCES_CHANGED_EVENT,
            function sourceRecordsChanged(event) {
                handler(event.detail);
            },
            options
        );
    }

    // Original revisions are independent files; committing metadata makes one current.
    async function prepareSource(input, previous, {signal} = {}) {
        assertActive(signal);
        if (typeof input.title !== 'string' || (!input.title.trim() && input.kind !== 'file')) {
            throw sourceError('A source title is required.', 'PM_SOURCE_INPUT');
        }
        if (input.content !== null && input.content !== undefined && typeof input.content !== 'string') {
            throw sourceError('Source content must be complete text or null.', 'PM_SOURCE_INPUT');
        }
        const {db} = await storage();
        const id = input.id || previous?.id || crypto.randomUUID();
        const now = new Date().toISOString();
        const revision = crypto.randomUUID();
        const textKey = typeof input.content === 'string' ? `${id}-${revision}.json` : null;
        const originalKey = input.originalFile ? `${id}-${revision}.original` : null;
        if (textKey) await db.set(TABLES.text, textKey, {content: input.content});
        assertActive(signal);
        if (originalKey) await db.writeFile(TABLES.originals, originalKey, input.originalFile);
        assertActive(signal);
        const origin = input.origin !== undefined ? input.origin : previous?.origin ?? null;
        return {
            id,
            kind: input.kind || 'note',
            title: input.title,
            projectId: input.projectId !== undefined ? input.projectId : previous?.projectId ?? null,
            taskId: input.taskId !== undefined ? input.taskId : previous?.taskId ?? null,
            accountId: input.accountId !== undefined ? input.accountId : origin?.accountId ?? null,
            origin,
            location: input.location !== undefined ? input.location : previous?.location ?? null,
            importedAt: previous?.importedAt || now,
            refreshedAt: now,
            archivedAt: input.archivedAt !== undefined ? input.archivedAt : previous?.archivedAt ?? null,
            indexed: input.indexed ?? previous?.indexed ?? true,
            freshness: input.freshness || 'snapshot',
            searchTerms: input.searchTerms ?? previous?.searchTerms ?? [],
            textKey,
            originalKey,
            originalName: input.originalFile?.name || null,
            originalType: input.originalFile?.type || null,
            originalLastModified: input.originalLastModified !== undefined
                ? input.originalLastModified : input.originalFile?.lastModified ?? null,
            folder: input.folder !== undefined ? input.folder : previous?.folder ?? null,
            nativeMetadata: input.nativeMetadata ?? null,
            externalKey: input.externalKey !== undefined ? input.externalKey : previous?.externalKey ?? null,
            message: input.message ?? null
        };
    }

    // The caller owns the corpus queue through lookup, revision writes and indexing.
    async function retainSources(records, options) {
        assertActive(options.signal);
        const {db} = await storage();
        const sources = [];
        const failures = [];
        const changes = [];
        if (records.length) corpusReady = false;
        reportProgress(options.onProgress, {phase: 'retaining', completed: 0, total: records.length});
        try {
            for (const input of records) {
                assertActive(options.signal);
                try {
                    const previous = input.id ? await db.get(TABLES.records, `${input.id}.json`, true) : null;
                    const source = await prepareSource(input, previous, options);
                    const change = await describeChange(previous, source, input.content);
                    assertActive(options.signal);
                    await db.set(TABLES.records, `${source.id}.json`, source);
                    changes.push(change);
                    refreshedSources.add(source.id);
                    sources.push(source);
                } catch (error) {
                    if (options.signal?.aborted) throw error;
                    failures.push({id: input.id || null, title: input.title, error});
                }
                reportProgress(options.onProgress, {phase: 'retaining', completed: sources.length + failures.length, total: records.length});
            }
        } finally {
            publishChanges(changes);
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
                        if (supportsFileText(file)) {
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
                            location: options.sourceId ? undefined : file.webkitRelativePath || file.name,
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

    function orderFolderRefresh(path, origin, operation) {
        const rootKey = folderAssociation(path, null, null, null, origin);
        const prior = folderRefreshes.get(rootKey) || Promise.resolve();
        const current = prior.then(operation, operation);
        folderRefreshes.set(rootKey, current);
        function releaseFolderRefresh() {
            if (folderRefreshes.get(rootKey) === current) folderRefreshes.delete(rootKey);
        }
        current.then(releaseFolderRefresh, releaseFolderRefresh);
        return current;
    }

    function importFolder(path, options = {}) {
        if (typeof path !== 'string' || !path.trim()) {
            throw sourceError('Choose a working folder to retain.', 'PM_SOURCE_INPUT');
        }
        const projectId = options.projectId ?? null;
        const taskId = options.taskId ?? null;
        const origin = options.origin == null ? null : structuredClone(options.origin);
        return orderFolderRefresh(path, origin, retainFolder);

        async function retainFolder() {
            const sources = [];
            const failures = [];
            const coverage = {
                scope: 'selected-directory', rootPath: path, status: 'partial',
                complete: false, cancelled: false, enumerationComplete: false,
                originalsComplete: false, textComplete: false, indexComplete: false,
                filesSeen: 0, retained: 0, read: 0, staged: 0, discoveredEntries: 0,
                untraversed: [], unsupportedText: [], missing: []
            };
            const associations = new Map();
            const seenPaths = new Set();
            const prepared = [];
            let enumeratedRoot = false;
            let enumerationFailed = false;

            function progress(phase, entryPath) {
                reportProgress(options.onProgress, {
                    phase, path: entryPath, rootPath: path,
                    filesSeen: coverage.filesSeen, read: coverage.read,
                    staged: coverage.staged, retained: coverage.retained,
                    discoveredEntries: coverage.discoveredEntries
                });
            }

            function failed(entryPath, phase, error, extra = {}) {
                failures.push({path: entryPath, phase, error, ...extra});
            }

            async function nativeRead(operation, entryPath) {
                assertActive(options.signal);
                if (typeof bridge?.[operation] !== 'function') {
                    throw sourceError('Connect the working-folder host before refreshing this folder.');
                }
                const result = await bridge[operation]({path: entryPath, signal: options.signal});
                assertActive(options.signal);
                if (result?.status !== 'available') {
                    const error = sourceError('The working-folder host could not supply this entry.');
                    error.nativeResult = result;
                    throw error;
                }
                return result;
            }

            async function retainEntry(entry, childPath) {
                let phase = 'metadata';
                try {
                    const metadata = await nativeRead('getFileMetadata', childPath);
                    if (metadata.original.isDirectory) {
                        if (metadata.original.isSymlink) {
                            enumerationFailed = true;
                            coverage.untraversed.push({path: childPath, reason: 'linked-directory'});
                            failed(childPath, 'traversal', sourceError('This linked directory needs a native resolved-target traversal contract.'));
                        } else {
                            directories.push(childPath);
                        }
                        return;
                    }
                    if (!metadata.original.isFile) {
                        coverage.untraversed.push({path: childPath, reason: 'unsupported-entry'});
                        failed(childPath, 'entry-type', sourceError('This entry is neither a readable file nor a directory.'));
                        return;
                    }
                    coverage.filesSeen++;
                    phase = 'file-read';
                    progress('reading', childPath);
                    const original = await nativeRead('readFile', childPath);
                    if (typeof original.original?.dataBase64 !== 'string') {
                        throw sourceError('The host did not return complete file content.');
                    }
                    // Base64 decoding belongs only to the native transport boundary.
                    const data = Uint8Array.from(atob(original.original.dataBase64), function decodeCharacter(character) {
                        return character.charCodeAt(0);
                    });
                    coverage.read++;
                    const timestamp = metadata.original.modifiedAtMs;
                    const lastModified = Number.isFinite(timestamp) && timestamp !== 0 ? timestamp : null;
                    const file = new File([data], entry.fileName, {lastModified: lastModified ?? 0});
                    let content = null;
                    if (supportsFileText(file)) {
                        try {
                            content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(data);
                        } catch (error) {
                            coverage.unsupportedText.push({path: childPath, reason: 'encoding'});
                            failed(childPath, 'text-decoding', error);
                        }
                    } else {
                        coverage.unsupportedText.push({path: childPath, reason: 'format'});
                    }
                    phase = 'retention';
                    const key = folderAssociation(path, childPath, projectId, taskId, origin);
                    const previous = associations.get(key);
                    const source = await prepareSource({
                        id: previous?.id, kind: 'file', title: entry.fileName, content,
                        originalFile: file, originalLastModified: lastModified,
                        projectId, taskId, origin, location: childPath,
                        folder: {rootPath: path, entryPath: childPath},
                        nativeMetadata: {original: metadata.original, observedAt: metadata.observedAt},
                        freshness: 'snapshot'
                    }, previous, options);
                    prepared.push({key, source});
                    associations.set(key, source);
                    coverage.staged++;
                    progress('retaining', childPath);
                } catch (error) {
                    if (options.signal?.aborted) throw error;
                    if (phase === 'metadata') enumerationFailed = true;
                    failed(childPath, phase, error);
                }
            }

            const directories = [path];
            try {
                assertActive(options.signal);
                progress('enumerating', path);
                // Load the retained associations once, before any native reads for this refresh.
                const records = await mutate(function readFolderAssociations() {
                    return list({signal: options.signal});
                });
                for (const source of records) {
                    if (source.kind !== 'file' || source.folder?.rootPath !== path) continue;
                    const key = folderAssociation(path, source.folder.entryPath, source.projectId, source.taskId, source.origin);
                    if (key === folderAssociation(path, source.folder.entryPath, projectId, taskId, origin)) {
                        associations.set(key, source);
                    }
                }
                const root = await nativeRead('getFileMetadata', path);
                if (!root.original.isDirectory) throw sourceError('The selected working-folder path is not a directory.');
                // The explicitly chosen root may itself be a link; descendant links are reported.
                while (directories.length) {
                    assertActive(options.signal);
                    const directoryPath = directories.shift();
                    let listing;
                    try {
                        progress('enumerating', directoryPath);
                        listing = await nativeRead('readDirectory', directoryPath);
                        if (!Array.isArray(listing.original?.entries) || !Array.isArray(listing.children)) {
                            throw sourceError('The host did not return the directory entries and their routing paths.');
                        }
                        if (directoryPath === path) enumeratedRoot = true;
                    } catch (error) {
                        if (options.signal?.aborted) throw error;
                        enumerationFailed = true;
                        failed(directoryPath, 'enumeration', error);
                        continue;
                    }
                    const childPaths = new Map(listing.children.map(function nativeChild(child) {
                        return [child.fileName, child.path];
                    }));
                    const entries = listing.original.entries;
                    coverage.discoveredEntries += entries.length;
                    for (let position = 0; position < entries.length; position += 4) {
                        assertActive(options.signal);
                        const settled = await Promise.allSettled(entries.slice(position, position + 4).map(
                            async function readDirectoryEntry(entry) {
                                const childPath = childPaths.get(entry.fileName);
                                if (typeof childPath !== 'string' || !childPath) {
                                    enumerationFailed = true;
                                    failed(directoryPath, 'entry-path', sourceError('The host did not supply this entry path.'), {entryName: entry.fileName});
                                    return;
                                }
                                seenPaths.add(childPath);
                                await retainEntry(entry, childPath);
                            }
                        ));
                        assertActive(options.signal);
                        for (const result of settled) {
                            if (result.status === 'rejected') throw result.reason;
                        }
                    }
                }
                coverage.enumerationComplete = enumeratedRoot && !enumerationFailed;
                if (coverage.enumerationComplete) {
                    for (const source of records) {
                        if (!source.folder || seenPaths.has(source.folder.entryPath)) continue;
                        const key = folderAssociation(source.folder.rootPath, source.folder.entryPath, source.projectId, source.taskId, source.origin);
                        if (!associations.has(key)) continue;
                        const missing = {path: source.folder.entryPath, sourceId: source.id};
                        coverage.missing.push(missing);
                        failed(missing.path, 'missing', sourceError('The entry is absent from the refreshed folder; its retained original remains available.'), {sourceId: source.id});
                    }
                }
                if (enumeratedRoot) await mutate(async function publishFolderRefresh() {
                    const {db} = await storage();
                    const changes = [];
                    try {
                        for (const preparedSource of prepared) {
                            assertActive(options.signal);
                            const source = preparedSource.source;
                            try {
                                const latest = await db.get(TABLES.records, `${source.id}.json`, true);
                                if (latest && folderAssociation(latest.folder?.rootPath, latest.folder?.entryPath,
                                    latest.projectId, latest.taskId, latest.origin) !== preparedSource.key) {
                                    failed(source.folder.entryPath, 'association', sourceError('This source association changed during the refresh; its current original was preserved.'), {sourceId: source.id});
                                    continue;
                                }
                                const currentSource = latest ? {
                                    ...source, indexed: latest.indexed, archivedAt: latest.archivedAt,
                                    importedAt: latest.importedAt, searchTerms: latest.searchTerms
                                } : source;
                                const content = latest && source.textKey ? await readText(db, source.textKey) : null;
                                const change = await describeChange(latest, currentSource, content);
                                assertActive(options.signal);
                                corpusReady = false;
                                await db.set(TABLES.records, `${source.id}.json`, currentSource);
                                changes.push(change);
                                sources.push(currentSource);
                                refreshedSources.add(source.id);
                                coverage.retained++;
                            } catch (error) {
                                if (options.signal?.aborted) throw error;
                                failed(source.folder.entryPath, 'retention', error, {sourceId: source.id});
                            }
                        }
                    } finally {
                        publishChanges(changes);
                    }
                    assertActive(options.signal);
                    progress('indexing', path);
                    try {
                        const index = await rebuild({
                            signal: options.signal,
                            onProgress: function reportFolderIndex(state) {
                                reportProgress(options.onProgress, {...state, phase: 'indexing', corpusPhase: state.phase, rootPath: path});
                            }
                        });
                        coverage.indexComplete = index.completed === true;
                        for (const failure of index.readCoverage?.failures || []) {
                            const source = await db.get(TABLES.records, `${failure.key}.json`, true);
                            failed(source?.folder?.entryPath ?? source?.location ?? null, 'index', failure, {sourceId: failure.key});
                        }
                    } catch (error) {
                        if (options.signal?.aborted) throw error;
                        failed(path, 'index', error);
                    }
                });
            } catch (error) {
                if (options.signal?.aborted || error?.name === 'AbortError') coverage.cancelled = true;
                else failed(path, 'folder', error);
            }
            coverage.originalsComplete = coverage.enumerationComplete && !coverage.cancelled
                && coverage.retained === coverage.filesSeen && !coverage.untraversed.length && !coverage.missing.length;
            coverage.textComplete = coverage.originalsComplete && !coverage.unsupportedText.length;
            coverage.complete = coverage.originalsComplete && coverage.textComplete && coverage.indexComplete;
            coverage.status = coverage.cancelled ? 'cancelled' : coverage.complete ? 'complete' : 'partial';
            progress(coverage.status, path);
            return {sources, failures, coverage};
        }
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
                for (const [turnIndex, turn] of result.original.turns.entries()) {
                    for (const [itemIndex, item] of turn.items.entries()) {
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
                                        turnIndex,
                                        itemIndex,
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
        return readSnapshot(saved, {signal});
    }

    async function readSnapshot(saved, {signal} = {}) {
        assertActive(signal);
        const {db} = await storage();
        const source = structuredClone(saved);
        const results = await Promise.allSettled(
            [
                source.textKey ? readText(db, source.textKey) : null,
                source.originalKey ? db.readFile(TABLES.originals, source.originalKey) : null
            ]
        );
        const content = results[0].status === 'fulfilled' ? results[0].value : null;
        const file = results[1].status === 'fulfilled' ? results[1].value : null;
        const originalFile = file ? new File([file], source.originalName, {
            type: source.originalType || '', lastModified: source.originalLastModified ?? 0
        }) : null;
        const failures = [];
        for (const [position, result] of results.entries()) {
            if (result.status === 'rejected') {
                failures.push({representation: position === 0 ? 'text' : 'original-file', error: result.reason});
                console.error('Retained source representation could not be read.', {id: source.id, error: result.reason});
            }
        }
        const available = source.originalKey ? originalFile !== null : content !== null;
        const availability = available ? 'retained' : 'unavailable';
        assertActive(signal);
        const changedTaskRevision = source.kind === 'task' && taskRevisions.has(source.taskId)
            && taskRevisions.get(source.taskId) !== source.externalKey;
        const freshness = staleTasks.has(source.taskId) || changedTaskRevision
            ? 'stale'
            : source.freshness === 'current' && !refreshedSources.has(source.id)
                ? 'snapshot'
                : source.freshness;
        return {source, content, originalFile, availability, freshness, failures};
    }

    async function readTaskSources(taskId, options = {}) {
        if (typeof taskId !== 'string' || !taskId.trim()) {
            throw sourceError('Select a task before reading its retained sources.', 'PM_SOURCE_INPUT');
        }
        assertActive(options.signal);
        let records;
        const failures = [];
        try {
            records = await mutate(
                function snapshotTaskSources() {
                    return list(
                        {taskId, kind: options.kind, signal: options.signal}
                    );
                }
            );
        } catch (error) {
            if (options.signal?.aborted || !Array.isArray(error.sources)) throw error;
            records = error.sources;
            failures.push(...error.failures);
        }
        records.sort(compareTaskSources);
        const sources = [];
        const unavailableIds = [];
        // Originals are retained revisions; only the metadata snapshot needs the mutation queue.
        for (let start = 0; start < records.length; start += 4) {
            assertActive(options.signal);
            const batch = records.slice(start, start + 4);
            const results = await Promise.allSettled(
                batch.map(
                    function readTaskOriginal(source) {
                        return readSnapshot(source, options);
                    }
                )
            );
            assertActive(options.signal);
            for (const [position, result] of results.entries()) {
                const source = batch[position];
                if (result.status === 'rejected') {
                    unavailableIds.push(source.id);
                    failures.push(
                        {id: source.id, phase: 'read', error: result.reason}
                    );
                    continue;
                }
                sources.push(result.value);
                if (result.value.availability === 'unavailable') unavailableIds.push(source.id);
                for (const failure of result.value.failures || []) {
                    failures.push(
                        {id: source.id, ...failure}
                    );
                }
            }
        }
        assertActive(options.signal);
        const complete = !failures.length && !unavailableIds.length;
        const ordered = records.every(
            function hasConversationOrder(source) {
                return source.kind !== 'conversation'
                    || (Number.isInteger(source.message?.turnIndex) && Number.isInteger(source.message?.itemIndex));
            }
        );
        return {
            sources, unavailableIds, failures, complete,
            coverage: {scope: 'retained-task-sources', complete, ordered}
        };
    }

    function compareTaskSources(left, right) {
        const kindOrder = left.kind.localeCompare(right.kind);
        if (kindOrder) return kindOrder;
        if (left.kind === 'conversation' && right.kind === 'conversation') {
            const leftOrigin = JSON.stringify([left.origin?.provider, left.accountId, left.origin?.hostId, left.origin?.threadId]);
            const rightOrigin = JSON.stringify([right.origin?.provider, right.accountId, right.origin?.hostId, right.origin?.threadId]);
            const originOrder = leftOrigin.localeCompare(rightOrigin);
            if (originOrder) return originOrder;
            const leftOrdered = Number.isInteger(left.message?.turnIndex) && Number.isInteger(left.message?.itemIndex);
            const rightOrdered = Number.isInteger(right.message?.turnIndex) && Number.isInteger(right.message?.itemIndex);
            if (leftOrdered !== rightOrdered) return leftOrdered ? -1 : 1;
            if (leftOrdered) {
                return left.message.turnIndex - right.message.turnIndex
                    || left.message.itemIndex - right.message.itemIndex
                    || (left.message.partIndex ?? 0) - (right.message.partIndex ?? 0)
                    || left.id.localeCompare(right.id);
            }
        }
        return left.importedAt.localeCompare(right.importedAt) || left.id.localeCompare(right.id);
    }

    async function refresh(id, options = {}) {
        const {source} = await read(id, options);
        if (source.kind === 'task') return importTasks({...options, taskId: source.taskId});
        if (source.kind === 'conversation') return importConversation(source.taskId, options);
        if (source.kind === 'file' && options.file) {
            if (source.folder) return orderFolderRefresh(source.folder.rootPath, source.origin,
                async function reselectFolderFile() {
                    assertActive(options.signal);
                    const {db} = await storage();
                    const current = await db.get(TABLES.records, `${id}.json`, true);
                    if (!current) throw sourceError('The selected source record is unavailable.');
                    return importFiles([options.file], {
                        ...options, sourceId: id, projectId: current.projectId, taskId: current.taskId
                    });
                }
            );
            return importFiles([options.file], {...options, sourceId: id, projectId: source.projectId, taskId: source.taskId});
        }
        if (source.kind === 'file' && source.folder) {
            return importFolder(source.folder.rootPath, {
                ...options, projectId: source.projectId, taskId: source.taskId, origin: source.origin
            });
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
        importFolder,
        importTasks,
        importConversation,
        list,
        read,
        readTaskSources,
        subscribe,
        refresh,
        query,
        getQuery,
        select,
        getSelectedIds,
        getSelection,
        removeFromIndex(id) { return setIndexed(id, false); },
        restoreToIndex(id) { return setIndexed(id, true); },
        dispose() {
            unsubscribe?.();
            events.dispose();
        }
    };
}
