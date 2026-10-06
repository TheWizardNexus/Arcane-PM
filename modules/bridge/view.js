import {mountCodexRequests} from './requests.js';

/** Connection and association workflow; shared shell owns its layout and theme. */
export function mountConnectionsView(container, {bridge, pmData, projectId, onNavigate, onStatus, signal} = {}) {
    const lifetime = new AbortController();
    const pageSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let closed = false;
    let listing = false;
    let finding = false;
    let discoveryRevision = 0;
    let operationOwner = null;
    const root = document.createElement('section');
    root.className = 'pm-connections';
    const header = document.createElement('header');
    header.className = 'pm-page-heading';
    const headingContent = document.createElement('div');
    const heading = document.createElement('h1');
    heading.textContent = 'Connections';
    const description = document.createElement('p');
    description.textContent = 'Connect your Codex work and keep preparing locally between sessions.';
    headingContent.append(heading, description);
    header.append(headingContent);
    const connection = document.createElement('section');
    connection.className = 'pm-panel';
    const state = document.createElement('p');
    state.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'pm-actions';
    const connectButton = button('Connect Codex', connect);
    const refreshButton = button('Refresh connection', refresh);
    refreshButton.classList.add('arcane-button--secondary');
    const disconnectButton = button('Disconnect', disconnect);
    disconnectButton.classList.add('arcane-button--secondary');
    actions.append(connectButton, refreshButton, disconnectButton);
    const account = document.createElement('p');
    const coverage = document.createElement('p');
    coverage.textContent = 'Working folders are observed from accessible Codex tasks. Saved projects without accessible tasks may be absent.';
    const taskLabel = document.createElement('label');
    const taskId = document.createElement('input');
    taskId.type = 'text';
    taskId.className = 'arcane-input';
    taskLabel.append(document.createTextNode('Codex task ID'), taskId);
    const findButton = button('Find this task', findTask);
    const lookup = document.createElement('div');
    lookup.className = 'pm-actions';
    lookup.append(taskLabel, findButton);
    const archiveLabel = document.createElement('label');
    const archived = document.createElement('input');
    archived.type = 'checkbox';
    archiveLabel.append(archived, document.createTextNode(' Show archived Codex tasks'));
    const discoverButton = button('Find Codex tasks', discover);
    const discovery = document.createElement('div');
    discovery.className = 'pm-actions';
    discovery.append(archiveLabel, discoverButton);
    const results = document.createElement('div');
    const operationStatus = document.createElement('p');
    operationStatus.setAttribute('role', 'status');
    connection.append(state, actions, account, lookup, coverage, discovery, operationStatus);
    const requestsContainer = document.createElement('div');
    root.append(header, connection, requestsContainer, results);
    container.replaceChildren(root);
    const requests = mountCodexRequests(requestsContainer, {bridge, signal: pageSignal, onStatus});

    function button(text, action) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'arcane-button';
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

    function showOperation(message, owner = null) {
        if (closed || pageSignal.aborted) return;
        operationOwner = owner;
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
        connectButton.disabled = value.state === 'connecting' || value.connected || value.closing || !value.available;
        disconnectButton.disabled = value.closing || (!value.connected && value.state !== 'connecting');
        discoverButton.disabled = listing || !value.capabilities?.listThreads;
        findButton.disabled = finding || !value.capabilities?.readThread;
        account.textContent = value.account?.account?.email
            ? `Codex account: ${value.account.account.email}`
            : value.connected ? 'Codex owns the active account connection.' : 'Local PM records remain independent of the Codex account.';
        if (operationOwner === 'connect' && value.state !== 'connecting') {
            showOperation(value.connected ? 'Codex connection is ready.' : value.message);
        }
    }

    async function refresh() {
        showOperation('Reading the connection state…');
        await bridge.refreshStatus({signal: pageSignal});
        showOperation('Connection state updated.');
    }

    async function connect() {
        showOperation('Connecting to Codex…', 'connect');
        await bridge.connect({signal: pageSignal});
        if (operationOwner === 'connect') renderState(bridge.status());
    }

    async function disconnect() {
        showOperation('Closing this connection…');
        const result = await bridge.disconnect({signal: pageSignal});
        showOperation(result.message);
    }

    async function discover() {
        const revision = ++discoveryRevision;
        listing = true;
        renderState(bridge.status());
        showOperation('Finding accessible Codex tasks…');
        try {
            const result = await bridge.listThreads({archived: archived.checked, signal: pageSignal});
            pageSignal.throwIfAborted();
            if (revision !== discoveryRevision) return;
            if (result.status === 'unavailable') {
                showOperation(result.message);
                return;
            }
            results.replaceChildren();
            for (const thread of result.threads) renderThread(thread, result.observedAt, result.identity);
            showOperation(result.coverage.complete
                ? `${result.threads.length} accessible Codex tasks found.`
                : `${result.threads.length} Codex tasks retrieved. Some tasks remain unavailable.`);
        } finally {
            listing = false;
            renderState(bridge.status());
        }
    }

    async function findTask() {
        const threadId = taskId.value;
        if (threadId === '') {
            showOperation('Enter a Codex task ID.');
            return;
        }
        const revision = ++discoveryRevision;
        finding = true;
        renderState(bridge.status());
        showOperation('Finding this Codex task…');
        try {
            const result = await bridge.readThread({threadId, signal: pageSignal});
            pageSignal.throwIfAborted();
            if (revision !== discoveryRevision) return;
            if (result.status === 'unavailable') {
                showOperation(result.message);
                return;
            }
            results.replaceChildren();
            renderThread(result.thread, result.observedAt, result.identity);
            showOperation('Codex task found.');
        } finally {
            finding = false;
            renderState(bridge.status());
        }
    }

    function renderThread(thread, observedAt, identity) {
        const article = document.createElement('article');
        article.className = 'pm-panel';
        const title = document.createElement('h2');
        title.textContent = thread.name || thread.id;
        const folder = document.createElement('p');
        folder.textContent = thread.cwd || 'Working folder not supplied by Codex';
        const nativeState = document.createElement('p');
        const statusMessage = thread.status?.type === 'notLoaded'
            ? 'Live activity is not observed by this Codex connection.'
            : `This Codex connection reported task state ${thread.status?.type ?? 'unknown'}.`;
        nativeState.textContent = statusMessage;
        const open = document.createElement('a');
        open.href = bridge.getThreadUrl(thread.id);
        open.textContent = 'Open in Codex';
        article.append(title, folder, nativeState, open);
        if (pmData) {
            const associationAction = button('Add to this PM workspace', async function importTask() {
                showOperation('Saving the task association…');
                const existing = await pmData.listTasks({signal: pageSignal});
                pageSignal.throwIfAborted();
                const originIdentity = currentIdentity();
                if (identity?.originIdentity && !originIdentity) {
                    showOperation('The connection changed. Find this task again before associating it.');
                    return;
                }
                const match = existing.find(function sameNativeThread(task) {
                    return task.origin?.provider === 'codex' && task.origin.threadId === thread.id
                        && (task.origin.accountId ?? null) === (originIdentity?.accountId ?? null)
                        && (task.origin.hostId ?? null) === (originIdentity?.hostId ?? null);
                });
                if (match) {
                    showOperation('This Codex task is already in PM.');
                    onNavigate?.('task', {projectId: match.projectId, taskId: match.id});
                    return;
                }
                const unassociated = existing.find(function missingNativeIdentity(task) {
                    return task.origin?.provider === 'codex' && task.origin.threadId === thread.id
                        && (!task.origin.accountId || !task.origin.hostId);
                });
                if (unassociated && originIdentity) {
                    showOperation('This task has a saved association without its account and host. Associate it with this connection to observe available activity.');
                    const associate = button('Associate saved task with this connection', async function associateSavedTask() {
                        const selectedIdentity = currentIdentity();
                        if (!selectedIdentity) {
                            showOperation('Find this task again to capture the current connection identity.');
                            return;
                        }
                        const current = await pmData.getTask(unassociated.id, {signal: pageSignal});
                        pageSignal.throwIfAborted();
                        if (!current || current.origin?.provider !== 'codex'
                            || current.origin.threadId !== thread.id
                            || (current.origin.accountId && current.origin.hostId)) {
                            showOperation('The saved association changed. Find this task again.');
                            return;
                        }
                        if (!currentIdentity()) {
                            showOperation('Find this task again to capture the current connection identity.');
                            return;
                        }
                        const task = await pmData.updateTask(current.id, {
                            origin: {...current.origin, ...selectedIdentity}
                        });
                        showOperation('Task connection associated locally.');
                        if (!pageSignal.aborted) onNavigate?.('task', {projectId: task.projectId, taskId: task.id});
                    });
                    associationAction.replaceWith(associate);
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
                            origin: {provider: 'codex', ...originIdentity, projectId: thread.projectId ?? null}
                        });
                        selectedProjectId = project.id;
                    }
                }
                pageSignal.throwIfAborted();
                const task = await pmData.createTask({
                    title: thread.name || thread.id, projectId: selectedProjectId,
                    workFolder: thread.cwd || null,
                    status: thread.status?.type === 'notLoaded' ? 'unknown' : thread.status?.type ?? 'unknown',
                    origin: {provider: 'codex', ...originIdentity, projectId: thread.projectId ?? null, threadId: thread.id, url: bridge.getThreadUrl(thread.id)},
                    observedEvidence: [{message: statusMessage, observedAt}]
                });
                showOperation('Task association saved locally.');
                if (!pageSignal.aborted) onNavigate?.('task', {projectId: task.projectId, taskId: task.id});
            });
            article.append(associationAction);
        }
        results.append(article);

        function currentIdentity() {
            const current = bridge.status();
            if (!identity?.originIdentity || !current.connected
                || current.connectionId !== identity.connectionId
                || current.originIdentity?.accountId !== identity.originIdentity.accountId
                || current.originIdentity?.hostId !== identity.originIdentity.hostId) return null;
            return identity.originIdentity;
        }
    }

    const stop = bridge.subscribe(renderState, {signal: pageSignal});
    refresh().catch(reportFailure);
    function dispose() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        stop();
        requests.dispose();
    }
    return {refresh, dispose};
}
