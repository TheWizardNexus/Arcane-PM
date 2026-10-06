/** Connection and association workflow; shared shell owns its layout and theme. */
export function mountConnectionsView(container, {bridge, pmData, projectId, onNavigate, onStatus, signal} = {}) {
    const lifetime = new AbortController();
    const pageSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let closed = false;
    let listing = false;
    const root = document.createElement('section');
    root.className = 'pm-connections';
    const heading = document.createElement('h1');
    heading.textContent = 'Connections';
    const description = document.createElement('p');
    description.textContent = 'Connect your Codex work and keep preparing locally between sessions.';
    const state = document.createElement('p');
    state.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'pm-actions';
    const connectButton = button('Connect Codex', connect);
    const refreshButton = button('Refresh connection', refresh);
    const disconnectButton = button('Disconnect', disconnect);
    actions.append(connectButton, refreshButton, disconnectButton);
    const account = document.createElement('p');
    const coverage = document.createElement('p');
    coverage.textContent = 'Working folders are observed from accessible Codex tasks. Saved projects without accessible tasks may be absent.';
    const archiveLabel = document.createElement('label');
    const archived = document.createElement('input');
    archived.type = 'checkbox';
    archiveLabel.append(archived, document.createTextNode(' Show archived Codex tasks'));
    const discoverButton = button('Find Codex tasks', discover);
    const results = document.createElement('div');
    const operationStatus = document.createElement('p');
    operationStatus.setAttribute('role', 'status');
    root.append(heading, description, state, actions, account, coverage, archiveLabel, discoverButton, operationStatus, results);
    container.replaceChildren(root);

    function button(text, action) {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = text;
        element.addEventListener('click', async function runConnectionAction() {
            element.disabled = true;
            try { await action(); }
            catch (error) { reportFailure(error); }
            finally {
                element.disabled = false;
                renderState(bridge.status());
            }
        }, {signal: pageSignal});
        return element;
    }

    function showOperation(message) {
        if (closed || pageSignal.aborted) return;
        operationStatus.textContent = message;
        onStatus?.(message);
    }

    function reportFailure(error) {
        if (closed || pageSignal.aborted || error.name === 'AbortError') return;
        console.error('Arcane PM connection operation failed', error);
        showOperation('The connection operation could not finish. Your local work is still available.');
    }

    function renderState(value) {
        if (closed || pageSignal.aborted) return;
        state.textContent = value.message;
        connectButton.disabled = value.state === 'connecting' || value.connected || !value.available;
        disconnectButton.disabled = !value.connected;
        discoverButton.disabled = listing || !value.capabilities?.listThreads;
        account.textContent = value.account?.account?.email
            ? `Codex account: ${value.account.account.email}`
            : value.connected ? 'Codex owns the active account connection.' : 'Local PM records remain independent of the Codex account.';
    }

    async function refresh() {
        showOperation('Reading the connection state…');
        await bridge.refreshStatus({signal: pageSignal});
        showOperation('Connection state updated.');
    }

    async function connect() {
        showOperation('Connecting to Codex…');
        const result = await bridge.connect({signal: pageSignal});
        showOperation(result.connected ? 'Codex connection is ready.' : result.message);
    }

    async function disconnect() {
        showOperation('Closing this connection…');
        const result = await bridge.disconnect({signal: pageSignal});
        showOperation(result.message);
    }

    async function discover() {
        listing = true;
        renderState(bridge.status());
        showOperation('Finding accessible Codex tasks…');
        try {
            const result = await bridge.listThreads({archived: archived.checked, signal: pageSignal});
            pageSignal.throwIfAborted();
            if (result.status === 'unavailable') {
                showOperation(result.message);
                return;
            }
            results.replaceChildren();
            for (const thread of result.threads) renderThread(thread, result.observedAt);
            showOperation(result.coverage.complete
                ? `${result.threads.length} accessible Codex tasks found.`
                : `${result.threads.length} Codex tasks retrieved. Some tasks remain unavailable.`);
        } finally {
            listing = false;
            renderState(bridge.status());
        }
    }

    function renderThread(thread, observedAt) {
        const article = document.createElement('article');
        const title = document.createElement('h2');
        title.textContent = thread.name || thread.id;
        const folder = document.createElement('p');
        folder.textContent = thread.cwd || 'Working folder not supplied by Codex';
        const nativeState = document.createElement('p');
        nativeState.textContent = `Codex state: ${thread.status?.type ?? 'unknown'}`;
        const open = document.createElement('a');
        open.href = bridge.getThreadUrl(thread.id);
        open.textContent = 'Open in Codex';
        article.append(title, folder, nativeState, open);
        if (pmData) article.append(button('Add to this PM workspace', async function importTask() {
            showOperation('Saving the task association…');
            const existing = await pmData.listTasks({signal: pageSignal});
            pageSignal.throwIfAborted();
            const match = existing.find(function sameNativeThread(task) {
                return task.origin?.provider === 'codex' && task.origin.threadId === thread.id;
            });
            if (match) {
                showOperation('This Codex task is already in PM.');
                onNavigate?.('task', {projectId: match.projectId, taskId: match.id});
                return;
            }
            let selectedProjectId = projectId ?? null;
            if (!selectedProjectId && thread.cwd) {
                const projects = await pmData.listProjects({signal: pageSignal});
                pageSignal.throwIfAborted();
                const associated = projects.find(function sameWorkingFolder(project) { return project.workFolder === thread.cwd; });
                if (associated) selectedProjectId = associated.id;
                else {
                    const project = await pmData.createProject({
                        name: thread.cwd, workFolder: thread.cwd,
                        origin: {provider: 'codex', projectId: thread.projectId ?? null}
                    });
                    selectedProjectId = project.id;
                }
            }
            pageSignal.throwIfAborted();
            const task = await pmData.createTask({
                title: thread.name || thread.id, projectId: selectedProjectId,
                workFolder: thread.cwd || null, status: thread.status?.type ?? 'unknown',
                origin: {provider: 'codex', projectId: thread.projectId ?? null, threadId: thread.id, url: bridge.getThreadUrl(thread.id)},
                observedEvidence: [{message: `Codex reported task state ${thread.status?.type ?? 'unknown'}.`, observedAt}]
            });
            showOperation('Task association saved locally.');
            if (!pageSignal.aborted) onNavigate?.('task', {projectId: task.projectId, taskId: task.id});
        }));
        results.append(article);
    }

    const stop = bridge.subscribe(renderState, {signal: pageSignal});
    refresh().catch(reportFailure);
    function dispose() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        stop();
    }
    return {refresh, dispose};
}
