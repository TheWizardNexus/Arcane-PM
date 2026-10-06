/**
 * PM source selection and navigation. The injected library owns persistence,
 * indexing and source access; the shell owns the surrounding page and theme.
 * Mount returns immediately. Disposal cancels this view's pending operations.
 */
function mountSourcesView(container, options = {}) {
    const {sources, projectId, sourceId, taskId, handoffId, onNavigate, onSelection, onStatus, signal} = options;
    const queryProjectId = projectId ?? undefined;
    const document = container.ownerDocument;
    const lifetime = new AbortController();
    const operations = new Set();
    const selectedIds = new Set();
    const selectionWrites = new Map();
    const root = document.createElement('section');
    let queryOperation = null;
    let readerOperation = null;
    let currentSource = null;
    let originalUrl = null;
    let mutationPending = false;
    let initialized = false;
    let queryEdited = false;
    let selectionRevision = 0;

    root.className = 'pm-sources';
    root.setAttribute('aria-label', 'Project sources');
    root.innerHTML = `
        <header class="pm-sources-heading pm-page-heading">
            <div>
                <h1>Sources</h1>
                <p>Find retained tasks, conversations, and working files. Open the complete original or select it for a handoff.</p>
            </div>
        </header>
        <form class="pm-sources-search" role="search">
            <label class="pm-sources-query-label">Words or phrase
                <input type="search" name="query" autocomplete="off" placeholder="Search local sources">
            </label>
            <label>Source type
                <select name="kind">
                    <option value="">All sources</option>
                    <option value="task">Tasks</option>
                    <option value="conversation">Conversations</option>
                    <option value="file">Working files</option>
                    <option value="note">Notes</option>
                </select>
            </label>
            <button type="submit">Search</button>
        </form>
        <div class="pm-sources-tools">
            <label class="pm-sources-file-label">Add working files
                <input type="file" name="files" multiple>
            </label>
            <button type="button" data-action="refresh-tasks">Refresh task sources</button>
            <div class="pm-sources-selection">
                <span data-selection-count>Loading selections…</span>
                <button type="button" data-action="handoff" disabled>Prepare handoff</button>
            </div>
        </div>
        <div class="pm-sources-status-row">
            <p class="pm-sources-status" role="status" aria-live="polite">Loading retained sources…</p>
            <button type="button" data-action="cancel" hidden>Cancel</button>
        </div>
        <section class="pm-sources-folder-coverage" aria-label="Folder import coverage" hidden>
            <h2>Folder import</h2>
            <p data-folder-coverage-summary></p>
            <ul data-folder-coverage-details></ul>
        </section>
        <div class="pm-sources-content">
            <section class="pm-sources-results" aria-label="Search results">
                <p class="pm-sources-result-count">Loading…</p>
                <ul class="pm-sources-result-list"></ul>
            </section>
            <section class="pm-sources-reader" aria-label="Complete original" hidden>
                <div class="pm-sources-reader-heading">
                    <h3 tabindex="-1"></h3>
                    <button type="button" data-action="close-reader">Close original</button>
                </div>
                <dl class="pm-sources-metadata"></dl>
                <p class="pm-sources-reader-status" role="status"></p>
                <div class="pm-sources-reader-actions">
                    <label class="pm-sources-checkbox"><input type="checkbox" data-reader-selection> Select for handoff</label>
                    <button type="button" data-action="refresh-source">Refresh source</button>
                    <label class="pm-sources-file-label" data-file-refresh hidden>Choose the current working file
                        <input type="file" name="refresh-file">
                    </label>
                    <button type="button" data-action="import-conversation" hidden>Retain conversation</button>
                    <button type="button" data-action="import-folder" hidden>Retain working folder</button>
                    <button type="button" data-action="open-task" hidden>Open related task</button>
                    <button type="button" data-action="index-source">Remove from search</button>
                    <a data-original-file hidden>Save original file</a>
                </div>
                <pre class="pm-sources-original" tabindex="0"></pre>
            </section>
        </div>
        <details class="pm-sources-folder">
            <summary>Add a working folder</summary>
            <form class="pm-sources-folder-form">
                <label>Folder path<input type="text" name="path" required autocomplete="off" placeholder="Absolute path on the connected computer"></label>
                <p>Reads the selected folder through your Codex connection. Working files stay in place.</p>
                <button type="submit">Retain folder</button>
            </form>
        </details>
        <details class="pm-sources-note">
            <summary>Add a local note</summary>
            <form class="pm-sources-note-form">
                <label>Title<input type="text" name="title" required></label>
                <label>Complete note<textarea name="content" rows="6" required></textarea></label>
                <button type="submit">Save note</button>
            </form>
        </details>
        <details class="pm-sources-excluded">
            <summary>Sources removed from search</summary>
            <p>Retained originals remain available here.</p>
            <button type="button" data-action="refresh-excluded">Refresh list</button>
            <ul class="pm-sources-excluded-list"></ul>
        </details>
    `;

    const searchForm = root.querySelector('.pm-sources-search');
    const queryInput = searchForm.elements.query;
    const kindInput = searchForm.elements.kind;
    const fileInput = root.querySelector('input[name="files"]');
    const taskRefreshButton = root.querySelector('[data-action="refresh-tasks"]');
    const handoffButton = root.querySelector('[data-action="handoff"]');
    const selectionCount = root.querySelector('[data-selection-count]');
    const status = root.querySelector('.pm-sources-status');
    const cancelButton = root.querySelector('[data-action="cancel"]');
    const resultCount = root.querySelector('.pm-sources-result-count');
    const resultList = root.querySelector('.pm-sources-result-list');
    const reader = root.querySelector('.pm-sources-reader');
    const readerTitle = reader.querySelector('h3');
    const readerMetadata = reader.querySelector('dl');
    const readerStatus = reader.querySelector('.pm-sources-reader-status');
    const readerSelection = reader.querySelector('[data-reader-selection]');
    const readerRefresh = reader.querySelector('[data-action="refresh-source"]');
    const fileRefreshLabel = reader.querySelector('[data-file-refresh]');
    const fileRefreshInput = reader.querySelector('input[name="refresh-file"]');
    const conversationButton = reader.querySelector('[data-action="import-conversation"]');
    const folderButton = reader.querySelector('[data-action="import-folder"]');
    const readerActions = reader.querySelector('.pm-sources-reader-actions');
    const relatedTaskButton = reader.querySelector('[data-action="open-task"]');
    const indexButton = reader.querySelector('[data-action="index-source"]');
    const originalLink = reader.querySelector('[data-original-file]');
    const originalText = reader.querySelector('pre');
    const noteForm = root.querySelector('.pm-sources-note-form');
    const folderForm = root.querySelector('.pm-sources-folder-form');
    const folderCoverage = root.querySelector('.pm-sources-folder-coverage');
    const folderCoverageSummary = root.querySelector('[data-folder-coverage-summary]');
    const folderCoverageDetails = root.querySelector('[data-folder-coverage-details]');
    const excluded = root.querySelector('.pm-sources-excluded');
    const excludedList = root.querySelector('.pm-sources-excluded-list');

    container.replaceChildren(root);
    const listenerOptions = {signal: lifetime.signal};
    root.addEventListener('click', handleAction, listenerOptions);
    root.addEventListener('change', handleSelectionChange, listenerOptions);
    searchForm.addEventListener('submit', handleSearch, listenerOptions);
    queryInput.addEventListener('input', handleQueryEdit, listenerOptions);
    fileInput.addEventListener('change', handleFileImport, listenerOptions);
    fileRefreshInput.addEventListener('change', handleFileRefresh, listenerOptions);
    noteForm.addEventListener('submit', handleNoteImport, listenerOptions);
    folderForm.addEventListener('submit', handleFolderImport, listenerOptions);
    excluded.addEventListener('toggle', handleExcludedToggle, listenerOptions);
    signal?.addEventListener(
        'abort', dispose,
        {once: true}
    );

    if (signal?.aborted) {
        dispose();
    } else if (!sources) {
        announce('Source storage is unavailable. Reopen Sources after the connection is ready.', 'error');
        searchForm.querySelector('button').disabled = true;
        fileInput.disabled = true;
        taskRefreshButton.disabled = true;
        noteForm.querySelector('button').disabled = true;
        folderForm.querySelector('button').disabled = true;
        resultCount.textContent = 'Sources unavailable';
    } else {
        announce('Loading retained sources…');
        observe(
            initialize()
        );
    }

    return {dispose};

    function observe(promise) {
        promise.catch(reportUnexpectedFailure);
    }

    function reportUnexpectedFailure(error) {
        console.error('Arcane PM source view failed.', error);
        if (!lifetime.signal.aborted) {
            announce('This source action could not finish. Your input remains available; try again.', 'error');
        }
    }

    function announce(message, state = 'status') {
        if (lifetime.signal.aborted) return;
        status.textContent = message;
        status.dataset.state = state;
        try {
            onStatus?.(message);
        } catch (error) {
            console.error('Arcane PM source status callback failed.', error);
        }
    }

    function startOperation(message) {
        const controller = new AbortController();
        lifetime.signal.addEventListener(
            'abort', abortOperation,
            {once: true}
        );
        const operation = {controller, signal: controller.signal, finish, progress};
        operations.add(operation);
        cancelButton.hidden = false;
        announce(message);
        return operation;

        function abortOperation() {
            controller.abort();
        }

        function finish() {
            lifetime.signal.removeEventListener('abort', abortOperation);
            operations.delete(operation);
            cancelButton.hidden = operations.size === 0;
        }

        function progress(state) {
            if (!controller.signal.aborted && operations.has(operation)) reportProgress(state);
        }
    }

    function reportProgress(progress) {
        if (lifetime.signal.aborted) return;
        const phase = progress.phase === 'searching' ? 'Searching' : 'Preparing sources';
        if (Number.isFinite(progress.completed) && Number.isFinite(progress.total)) {
            announce(`${phase}: ${progress.completed} of ${progress.total}.`);
        }
    }

    function reportFailure(error, message, operation) {
        if (lifetime.signal.aborted || operation?.signal.aborted || error?.name === 'AbortError') return;
        console.error('Arcane PM source operation failed.', error);
        announce(message, 'error');
    }

    async function initialize() {
        const operation = startOperation('Refreshing retained task sources…');
        const taskImport = sources.importTasks(
            {projectId: queryProjectId, signal: operation.signal, onProgress: operation.progress}
        );
        const outcomes = await Promise.allSettled(
            [sources.getQuery(projectId), sources.getSelectedIds(), taskImport]
        );
        operation.finish();
        if (lifetime.signal.aborted) return;
        if (outcomes[0].status === 'fulfilled') {
            if (!queryEdited) queryInput.value = outcomes[0].value;
        } else {
            console.error('Arcane PM saved source query could not be read.', outcomes[0].reason);
        }
        if (outcomes[1].status === 'fulfilled') {
            for (const id of outcomes[1].value) selectedIds.add(id);
        } else {
            console.error('Arcane PM source selection could not be read.', outcomes[1].reason);
        }
        if (outcomes[2].status === 'rejected') {
            console.error('Arcane PM task sources could not be refreshed.', outcomes[2].reason);
        } else if (outcomes[2].value.failures.length) {
            console.error('Arcane PM task refresh was incomplete.', outcomes[2].value.failures);
        }
        initialized = true;
        updateSelectionControls();
        if (!queryOperation && !operation.signal.aborted) await runQuery();
        if (operation.signal.aborted) return;
        if (sourceId) await openSource(sourceId, false);
        if (outcomes.some(isRejected)) {
            announce('Some saved sources or preferences could not be refreshed. Retained results remain available; try Refresh task sources or reopen Sources.', 'error');
        } else if (outcomes[2].value.failures.length) {
            announce('Some tasks could not be refreshed. Retained sources remain searchable; try Refresh task sources again.', 'error');
        }
    }

    function isRejected(outcome) {
        return outcome.status === 'rejected';
    }

    function handleSearch(event) {
        event.preventDefault();
        queryEdited = true;
        observe(
            runQuery()
        );
    }

    function handleQueryEdit() {
        queryEdited = true;
    }

    async function runQuery() {
        if (lifetime.signal.aborted) return;
        queryOperation?.controller.abort();
        const operation = startOperation('Searching retained sources…');
        queryOperation = operation;
        resultList.setAttribute('aria-busy', 'true');
        try {
            const result = await sources.query(
                queryInput.value,
                {
                    projectId: queryProjectId,
                    kind: kindInput.value || undefined,
                    signal: operation.signal,
                    onProgress: operation.progress
                }
            );
            if (operation.signal.aborted || queryOperation !== operation) return;
            renderResults(result.matches);
            const count = result.matches.length;
            resultCount.textContent = `${count} ${count === 1 ? 'source' : 'sources'} found`;
            if (result.failures.length) {
                console.error('Arcane PM source search had unavailable records.', result.failures);
                announce(`${count} sources found. Some retained sources could not be searched; refresh and try again.`, 'error');
            } else if (!count) {
                announce(result.total ? 'No sources match. Try other words or another source type.' : 'No sources are included in search. Add working files, save a note, refresh task sources, or restore a removed source.');
            } else {
                announce(`${count} ${count === 1 ? 'source is' : 'sources are'} available to open in full.`);
            }
        } catch (error) {
            if (!operation.signal.aborted) resultCount.textContent = 'Previous search results';
            reportFailure(error, 'Search could not finish. Your query is still here; try Search again.', operation);
        } finally {
            if (queryOperation === operation) resultList.removeAttribute('aria-busy');
            operation.finish();
        }
    }

    function renderResults(matches) {
        const fragment = document.createDocumentFragment();
        for (const match of matches) {
            const source = match.source;
            const item = document.createElement('li');
            item.className = 'pm-sources-result';
            const choice = document.createElement('label');
            choice.className = 'pm-sources-checkbox';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.sourceSelection = source.id;
            checkbox.checked = selectedIds.has(source.id);
            checkbox.disabled = selectionWrites.has(source.id) || !initialized;
            choice.append(checkbox, ' Select for handoff');
            const title = document.createElement('button');
            title.type = 'button';
            title.className = 'pm-sources-result-title';
            title.dataset.action = 'read';
            title.dataset.sourceId = source.id;
            title.textContent = source.title;
            const metadata = document.createElement('p');
            metadata.className = 'pm-sources-result-meta';
            metadata.textContent = describeSource(source);
            item.append(title, metadata, choice);
            fragment.append(item);
        }
        resultList.replaceChildren(fragment);
    }

    function describeSource(source) {
        const details = [source.kind, source.freshness];
        if (source.archivedAt) details.push('Archived');
        if (source.location) details.push(source.location);
        return details.filter(Boolean).join(' · ');
    }

    async function openSource(id, focus = true) {
        if (lifetime.signal.aborted) return;
        readerOperation?.controller.abort();
        const operation = startOperation('Opening complete original…');
        readerOperation = operation;
        currentSource = null;
        clearOriginalUrl();
        readerTitle.textContent = 'Opening source…';
        readerMetadata.replaceChildren();
        originalText.textContent = '';
        readerActions.hidden = true;
        reader.hidden = false;
        readerStatus.textContent = 'Opening complete original…';
        reader.setAttribute('aria-busy', 'true');
        try {
            const result = await sources.read(
                id,
                {signal: operation.signal}
            );
            if (operation.signal.aborted || readerOperation !== operation) return;
            currentSource = result.source;
            clearOriginalUrl();
            readerTitle.textContent = currentSource.title || 'Unavailable source';
            renderMetadata(currentSource, result.freshness);
            originalText.textContent = result.content ?? '';
            originalText.hidden = result.content === null;
            originalLink.hidden = !result.originalFile;
            if (result.originalFile) {
                originalUrl = URL.createObjectURL(result.originalFile);
                originalLink.href = originalUrl;
                originalLink.download = result.originalFile.name;
            }
            readerSelection.dataset.sourceSelection = id;
            readerActions.hidden = false;
            readerRefresh.hidden = !currentSource.folder && (currentSource.kind === 'file' || currentSource.kind === 'note');
            readerRefresh.textContent = currentSource.folder ? 'Refresh folder' : 'Refresh source';
            fileRefreshLabel.hidden = currentSource.kind !== 'file' || Boolean(currentSource.folder);
            fileRefreshInput.value = '';
            conversationButton.hidden = currentSource.kind !== 'task' || !currentSource.taskId || !currentSource.origin?.threadId;
            folderButton.hidden = currentSource.kind !== 'task' || !currentSource.location;
            relatedTaskButton.hidden = !currentSource.taskId;
            indexButton.textContent = currentSource.indexed === false ? 'Restore to search' : 'Remove from search';
            readerRefresh.disabled = mutationPending;
            updateSelectionControls();
            if (result.availability === 'unavailable') {
                readerStatus.textContent = 'The original is unavailable. Refresh its source or choose the working file again.';
            } else if (result.content === null) {
                readerStatus.textContent = result.failures?.length
                    ? 'The complete file is retained. Its searchable text is unavailable; save the file to open it or choose the working file again.'
                    : 'The complete file is retained. Save it to open with its usual application.';
            } else if (currentSource.kind === 'note') {
                readerStatus.textContent = 'Complete retained note';
            } else if (result.freshness === 'stale') {
                readerStatus.textContent = 'This is a retained original. Its source has changed; refresh to retrieve the current version.';
            } else if (result.freshness === 'snapshot') {
                readerStatus.textContent = 'Retained snapshot. Changes to the working file or conversation require a refresh.';
            } else {
                readerStatus.textContent = result.content === '' ? 'The complete original is empty.' : 'Complete original';
            }
            announce(result.availability === 'unavailable' ? 'Original unavailable. Its source reference remains available.' : 'Complete retained original opened.');
            if (focus) readerTitle.focus();
        } catch (error) {
            if (!operation.signal.aborted) readerStatus.textContent = 'The original could not be opened. Select its result to try again.';
            reportFailure(error, 'The original could not be opened. Select its result to try again.', operation);
        } finally {
            if (readerOperation === operation) reader.removeAttribute('aria-busy');
            operation.finish();
        }
    }

    function renderMetadata(source, freshness) {
        const fields = [
            ['Source', source.kind],
            ['Location', source.location],
            ['Working folder', source.folder?.rootPath],
            ['Freshness', freshness],
            ['Message author', source.message?.role],
            ['Message part', source.message?.partIndex === null || source.message?.partIndex === undefined ? null : source.message.partIndex + 1],
            ['Turn started', source.message?.turnStartedAt],
            ['Turn completed', source.message?.turnCompletedAt],
            ['Account', source.accountId],
            ['Retained', source.refreshedAt || source.importedAt],
            ['Archive', source.archivedAt ? `Archived ${source.archivedAt}` : null],
            ['Search', source.indexed === false ? 'Removed from search; original retained' : null]
        ];
        const fragment = document.createDocumentFragment();
        for (const [label, value] of fields) {
            if (value === null || value === undefined || value === '') continue;
            const term = document.createElement('dt');
            const detail = document.createElement('dd');
            term.textContent = label;
            detail.textContent = value;
            fragment.append(term, detail);
        }
        readerMetadata.replaceChildren(fragment);
    }

    function handleSelectionChange(event) {
        const checkbox = event.target.closest('[data-source-selection]');
        if (!checkbox || !root.contains(checkbox) || !initialized) return;
        observe(
            changeSelection(checkbox.dataset.sourceSelection, checkbox.checked)
        );
    }

    async function changeSelection(id, selected) {
        if (selectionWrites.has(id) || lifetime.signal.aborted) return;
        announce('Saving source selection…');
        const operation = sources.select(id, selected);
        let saved = false;
        selectionWrites.set(id, operation);
        updateSelectionControls();
        try {
            await operation;
            saved = true;
            if (lifetime.signal.aborted) return;
            if (selected) selectedIds.add(id);
            else selectedIds.delete(id);
            await publishSelection();
            announce(selected ? 'Complete source selected for handoff.' : 'Source removed from the handoff selection.');
        } catch (error) {
            reportFailure(
                error,
                saved ? 'Selection saved. Its handoff preview could not refresh; use Prepare handoff to retry.' : 'Selection could not be saved. Try selecting the source again.'
            );
        } finally {
            selectionWrites.delete(id);
            if (!lifetime.signal.aborted) updateSelectionControls();
        }
    }

    function updateSelectionControls() {
        const count = selectedIds.size;
        selectionCount.textContent = `${count} selected for handoff across projects`;
        handoffButton.disabled = !count || selectionWrites.size > 0;
        for (const checkbox of root.querySelectorAll('[data-source-selection]')) {
            const id = checkbox.dataset.sourceSelection;
            checkbox.checked = selectedIds.has(id);
            checkbox.disabled = selectionWrites.has(id) || !initialized;
        }
    }

    async function publishSelection() {
        if (!onSelection || lifetime.signal.aborted) return;
        const revision = ++selectionRevision;
        const selection = await sources.getSelection(
            {signal: lifetime.signal}
        );
        if (!lifetime.signal.aborted && revision === selectionRevision) await onSelection(selection);
    }

    async function prepareHandoff() {
        const operation = startOperation('Preparing selected originals…');
        try {
            const selection = await sources.getSelection(
                {signal: operation.signal}
            );
            if (operation.signal.aborted) return;
            await onSelection?.(selection);
            if (operation.signal.aborted) return;
            if (!selection.complete) {
                announce('Some selected originals are unavailable. Open them and refresh before preparing the handoff.', 'error');
                return;
            }
            onNavigate?.(
                'handoffs',
                {projectId, taskId, handoffId}
            );
        } catch (error) {
            reportFailure(error, 'Selected originals could not be prepared. Your selection remains available; try again.', operation);
        } finally {
            operation.finish();
        }
    }

    function setMutationPending(pending) {
        mutationPending = pending;
        fileInput.disabled = pending;
        taskRefreshButton.disabled = pending;
        noteForm.querySelector('button').disabled = pending;
        folderForm.querySelector('button').disabled = pending;
        readerRefresh.disabled = pending;
        fileRefreshInput.disabled = pending;
        conversationButton.disabled = pending;
        folderButton.disabled = pending;
        indexButton.disabled = pending;
        for (const button of excludedList.querySelectorAll('button[data-action="restore"]')) button.disabled = pending;
    }

    async function mutateSources(action, message, failureMessage = 'Sources could not be refreshed. Your originals and input remain available; try again.') {
        if (mutationPending || lifetime.signal.aborted) return;
        const operation = startOperation(message);
        setMutationPending(true);
        try {
            const result = await action(operation.signal, operation.progress);
            if (result?.coverage?.scope === 'selected-directory' && !lifetime.signal.aborted) renderFolderCoverage(result);
            if (operation.signal.aborted) return;
            await runQuery();
            if (operation.signal.aborted) return;
            if (excluded.open) await loadExcluded();
            if (operation.signal.aborted) return;
            if (result?.failures?.length) {
                console.error('Arcane PM source import had incomplete results.', result.failures);
                const message = result.coverage?.scope === 'selected-directory' && !result.sources.length
                    ? 'No new folder originals were retained. Review the folder coverage and refresh.'
                    : 'Readable sources were retained. Some sources could not be refreshed; try those again.';
                announce(message, 'error');
            }
        } catch (error) {
            reportFailure(error, failureMessage, operation);
        } finally {
            operation.finish();
            if (!lifetime.signal.aborted) setMutationPending(false);
        }
    }

    function renderFolderCoverage(result) {
        const coverage = result.coverage;
        folderCoverage.hidden = false;
        const state = coverage.cancelled ? 'Refresh cancelled.' : coverage.complete ? 'Folder originals retained.' : 'Folder coverage is incomplete.';
        folderCoverageSummary.textContent = `${state} ${coverage.retained} of ${coverage.filesSeen} discovered files retained from ${coverage.rootPath}.`;
        const fragment = document.createDocumentFragment();
        const recoveryByPhase = {
            enumeration: 'This directory could not be fully listed. Confirm access and refresh.',
            'directory-read': 'This directory could not be fully listed. Confirm access and refresh.',
            'file-read': 'The file could not be read. Any previously retained original remains available.',
            metadata: 'File information could not be read. Confirm access and refresh.',
            'text-decoding': 'This file could not be decoded as UTF-8 text for search.',
            retention: 'This original could not be saved. Try refreshing the folder.',
            index: 'Search could not finish updating. Retained originals remain available.',
            folder: 'The folder could not be read. Connect to Codex, confirm the folder path, and refresh.',
            association: 'This source association changed during the refresh. Its current original remains available; refresh again.'
        };
        for (const failure of result.failures || []) {
            if (['traversal', 'entry-type', 'missing'].includes(failure.phase)) continue;
            const item = document.createElement('li');
            const path = failure.path || failure.location || coverage.rootPath;
            item.textContent = `${path}: ${recoveryByPhase[failure.phase] || 'This entry could not be fully imported. Review its source and refresh.'}`;
            fragment.append(item);
        }
        for (const entry of coverage.untraversed || []) {
            const item = document.createElement('li');
            const explanation = entry.reason === 'unsupported-entry'
                ? 'This entry could not be read as a file or directory.'
                : 'Directory link was not traversed. Choose its target explicitly to import it.';
            item.textContent = `${typeof entry === 'string' ? entry : entry.path}: ${explanation}`;
            fragment.append(item);
        }
        for (const entry of coverage.unsupportedText || []) {
            if (entry.reason === 'encoding') continue;
            const item = document.createElement('li');
            const path = typeof entry === 'string' ? entry : entry.path;
            const retained = result.sources.some(function hasRetainedOriginal(source) { return source.location === path && source.originalKey; });
            item.textContent = `${path}: ${retained ? 'Complete file retained; this format is searchable by its name.' : 'This format has no searchable text.'}`;
            fragment.append(item);
        }
        for (const entry of coverage.missing || []) {
            const item = document.createElement('li');
            item.textContent = `${typeof entry === 'string' ? entry : entry.path}: Absent from this refresh. Its previously retained original remains available.`;
            fragment.append(item);
        }
        folderCoverageDetails.replaceChildren(fragment);
    }

    function handleFolderImport(event) {
        event.preventDefault();
        const path = folderForm.elements.path.value;
        observe(
            mutateSources(
                importSelectedFolder,
                'Reading the selected working folder…',
                'The folder could not be read. Connect to Codex, confirm the folder path, and try again.'
            )
        );

        function importSelectedFolder(operationSignal, onProgress) {
            return sources.importFolder(path, {projectId, taskId, signal: operationSignal, onProgress});
        }
    }

    function handleFileImport() {
        if (!fileInput.files.length) return;
        const files = Array.from(fileInput.files);
        observe(
            mutateSources(importWorkingFiles, 'Retaining selected working files…')
        );

        async function importWorkingFiles(operationSignal, onProgress) {
            const result = await sources.importFiles(
                files,
                {projectId, signal: operationSignal, onProgress}
            );
            if (!operationSignal.aborted && !result.failures.length) fileInput.value = '';
            return result;
        }
    }

    function handleNoteImport(event) {
        event.preventDefault();
        const title = noteForm.elements.title.value;
        const content = noteForm.elements.content.value;
        observe(
            mutateSources(importLocalNote, 'Saving the complete local note…')
        );

        async function importLocalNote(operationSignal, onProgress) {
            const result = await sources.importSources(
                [{kind: 'note', title, content, projectId}],
                {signal: operationSignal, onProgress}
            );
            if (!operationSignal.aborted && !result.failures.length
                && noteForm.elements.title.value === title
                && noteForm.elements.content.value === content) {
                noteForm.reset();
            }
            return result;
        }
    }

    function handleFileRefresh() {
        const file = fileRefreshInput.files[0];
        const source = currentSource;
        if (!file || !source) return;
        observe(
            mutateSources(refreshWorkingFile, 'Retaining the selected current file…')
        );

        async function refreshWorkingFile(operationSignal, onProgress) {
            const result = await sources.refresh(
                source.id,
                {file, signal: operationSignal, onProgress}
            );
            if (!operationSignal.aborted) await openSource(source.id, false);
            return result;
        }
    }

    function handleAction(event) {
        const button = event.target.closest('button[data-action]');
        if (!button || !root.contains(button) || button.disabled) return;
        const id = button.dataset.sourceId;
        switch (button.dataset.action) {
            case 'read':
                observe(
                    openSource(id)
                );
                break;
            case 'refresh-tasks':
                observe(
                    mutateSources(importTaskSources, 'Refreshing retained task sources…')
                );
                break;
            case 'refresh-source':
                if (currentSource) {
                    observe(
                        mutateSources(refreshCurrentSource, 'Refreshing the selected source…')
                    );
                }
                break;
            case 'import-conversation':
                if (currentSource?.taskId) {
                    observe(
                        mutateSources(importRelatedConversation, 'Retrieving accessible conversation messages…')
                    );
                }
                break;
            case 'import-folder':
                if (currentSource?.location) {
                    observe(
                        mutateSources(
                            importRelatedFolder,
                            'Reading the task working folder…',
                            'The working folder could not be read. Connect to Codex, confirm the task folder, and try again.'
                        )
                    );
                }
                break;
            case 'index-source':
                if (currentSource) {
                    observe(
                        mutateSources(changeCurrentIndex, 'Updating source search membership…')
                    );
                }
                break;
            case 'restore':
                observe(
                    mutateSources(restoreSource, 'Restoring the source to search…')
                );
                break;
            case 'open-task':
                onNavigate?.(
                    'task',
                    {projectId: currentSource.projectId, taskId: currentSource.taskId}
                );
                break;
            case 'handoff':
                observe(
                    prepareHandoff()
                );
                break;
            case 'cancel':
                for (const operation of operations) operation.controller.abort();
                announce('Cancelled. You can retry the operation.');
                break;
            case 'close-reader':
                readerOperation?.controller.abort();
                reader.hidden = true;
                currentSource = null;
                clearOriginalUrl();
                break;
            case 'refresh-excluded':
                observe(
                    loadExcluded()
                );
                break;
        }

        async function restoreSource() {
            await sources.restoreToIndex(id);
            if (currentSource?.id === id && !lifetime.signal.aborted) await openSource(id, false);
        }
    }

    async function importTaskSources(operationSignal, onProgress) {
        return sources.importTasks(
            {projectId: queryProjectId, signal: operationSignal, onProgress}
        );
    }

    async function importRelatedConversation(operationSignal, onProgress) {
        return sources.importConversation(
            currentSource.taskId,
            {signal: operationSignal, onProgress}
        );
    }

    function importRelatedFolder(operationSignal, onProgress) {
        const source = currentSource;
        return sources.importFolder(
            source.location,
            {projectId: source.projectId, taskId: source.taskId, origin: source.origin, signal: operationSignal, onProgress}
        );
    }

    async function refreshCurrentSource(operationSignal, onProgress) {
        const source = currentSource;
        const result = await sources.refresh(
            source.id,
            {signal: operationSignal, onProgress}
        );
        if (!operationSignal.aborted) await openSource(source.id, false);
        return result;
    }

    async function changeCurrentIndex(operationSignal) {
        const source = currentSource;
        if (source.indexed === false) await sources.restoreToIndex(source.id);
        else await sources.removeFromIndex(source.id);
        if (!operationSignal.aborted) await openSource(source.id, false);
    }

    function handleExcludedToggle() {
        if (excluded.open && sources) {
            observe(
                loadExcluded()
            );
        }
    }

    async function loadExcluded() {
        if (lifetime.signal.aborted) return;
        try {
            const records = await sources.list(
                {projectId: queryProjectId, indexed: false, signal: lifetime.signal}
            );
            if (lifetime.signal.aborted) return;
            const fragment = document.createDocumentFragment();
            for (const source of records) {
                const item = document.createElement('li');
                const open = document.createElement('button');
                open.type = 'button';
                open.dataset.action = 'read';
                open.dataset.sourceId = source.id;
                open.textContent = source.title;
                const restore = document.createElement('button');
                restore.type = 'button';
                restore.dataset.action = 'restore';
                restore.dataset.sourceId = source.id;
                restore.disabled = mutationPending;
                restore.textContent = 'Restore to search';
                item.append(open, restore);
                fragment.append(item);
            }
            if (!records.length) {
                const empty = document.createElement('li');
                empty.textContent = 'No sources have been removed from search.';
                fragment.append(empty);
            }
            excludedList.replaceChildren(fragment);
        } catch (error) {
            reportFailure(error, 'Removed sources could not be listed. Try Refresh list again.');
        }
    }

    function clearOriginalUrl() {
        if (originalUrl) URL.revokeObjectURL(originalUrl);
        originalUrl = null;
        originalLink.removeAttribute('href');
    }

    function dispose() {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        signal?.removeEventListener('abort', dispose);
        clearOriginalUrl();
        root.remove();
    }
}

export {mountSourcesView};
export default mountSourcesView;
