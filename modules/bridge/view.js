import {mountCodexRequests} from './requests.js';

/** Connection and association workflow; shared shell owns its layout and theme. */
export function mountConnectionsView(container, {bridge, pmData, projectId, taskDiscovery, connectCodex, discoverTasks, onNavigate, onStatus, signal} = {}) {
    const lifetime = new AbortController();
    const pageSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let closed = false;
    let listing = false;
    let finding = false;
    let discoveryRevision = 0;
    let operationOwner = null;
    let discoveryState = null;
    let reportedMapping = null;
    let reportedFailure = null;
    const discoveryLookups = new Set();
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
    coverage.textContent = 'Discovery reads accessible Codex tasks, saved projects and their recorded assignments. Working folders supply a fallback when a task has no saved project.';
    const taskLabel = document.createElement('label');
    taskLabel.className = 'arcane-field';
    const taskLabelText = document.createElement('span');
    taskLabelText.className = 'arcane-field__label';
    taskLabelText.textContent = 'Codex task ID';
    const taskId = document.createElement('input');
    taskId.type = 'text';
    taskId.className = 'arcane-input';
    taskLabel.append(taskLabelText, taskId);
    const findButton = button('Find this task', findTask);
    const lookup = document.createElement('div');
    lookup.className = 'pm-actions';
    lookup.append(taskLabel, findButton);
    const archiveLabel = document.createElement('label');
    archiveLabel.className = 'arcane-field';
    const archiveLabelText = document.createElement('span');
    archiveLabelText.className = 'arcane-field__label';
    archiveLabelText.textContent = 'Codex task inventory';
    const archived = document.createElement('select');
    archived.className = 'arcane-input';
    for (const [value, title] of [['all', 'All tasks'], ['active', 'Unarchived tasks'], ['archived', 'Archived tasks']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = title;
        archived.append(option);
    }
    archiveLabel.append(archiveLabelText, archived);
    const discoverButton = button('Find Codex tasks', discover);
    const discovery = document.createElement('div');
    discovery.className = 'pm-actions';
    discovery.append(archiveLabel, discoverButton);
    const results = document.createElement('div');
    const mappingResults = document.createElement('section');
    mappingResults.className = 'pm-panel';
    mappingResults.hidden = true;
    const operationStatus = document.createElement('p');
    operationStatus.setAttribute('role', 'status');
    connection.append(state, actions, account, lookup, coverage, discovery, operationStatus);
    const requestsContainer = document.createElement('div');
    root.append(header, connection, mappingResults, requestsContainer, results);
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

    function showOperation(message, owner = null, publish = true) {
        if (closed || pageSignal.aborted) return;
        operationOwner = owner;
        operationStatus.textContent = message;
        if (publish) onStatus?.(message);
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
        for (const control of discoveryLookups) {
            control.disabled = finding || !discoveryState?.latest?.current || !value.capabilities?.readThread;
        }
        account.textContent = value.account?.account?.email
            ? `Codex account: ${value.account.account.email}`
            : value.connected ? 'Codex owns the active account connection.' : 'Local PM records remain independent of the Codex account.';
        if (operationOwner === 'connect' && value.state !== 'connecting') {
            showOperation(value.connected ? 'Codex connection is ready.' : value.message);
        }
    }

    function renderDiscovery(value) {
        if (closed || pageSignal.aborted) return;
        discoveryState = value;
        discoveryLookups.clear();
        mappingResults.replaceChildren();
        mappingResults.hidden = !value.latest && !value.failure && !value.running;
        if (mappingResults.hidden) return;
        appendText(mappingResults, 'h2', 'Codex discovery');
        if (value.running) appendText(mappingResults, 'p', value.latest
            ? 'Finding Codex projects and tasks… The previous result remains below.'
            : 'Finding Codex projects and tasks…');
        const latest = value.latest;
        if (latest) {
            const mapped = latest.result;
            if (mapped !== reportedMapping) {
                reportedMapping = mapped;
                if (latest.error || mapped.failures.length) {
                    console.error('Arcane PM retained discovery mapping diagnostics', latest.error, mapped);
                }
            }
            appendText(mappingResults, 'p', latest.current
                ? 'Latest result for the current connection.'
                : 'This result belongs to a previous connection. Saved PM records remain available.');
            appendText(mappingResults, 'p', latest.archived === undefined ? 'Scope: all accessible tasks.'
                : latest.archived ? 'Scope: archived tasks.' : 'Scope: unarchived tasks.');
            appendText(mappingResults, 'p', `${mapped.projects.length} projects and ${mapped.tasks.length} tasks associated; ${mapped.createdProjectIds.length} projects and ${mapped.createdTaskIds.length} tasks newly added.`);
            appendText(mappingResults, 'p', mapped.status === 'complete'
                ? 'Discovery completed for this scope.'
                : mappingReason(mapped.reason));
            const coverageList = document.createElement('ul');
            for (const [key, label] of [['threads', 'Task information'], ['projects', 'Public project information'], ['assignments', 'Saved project assignments']]) {
                appendText(coverageList, 'li', `${label}: ${mapped.coverage[key]?.complete ? 'complete for this discovery' : 'incomplete'}.`);
            }
            mappingResults.append(coverageList);
            const unresolved = document.createElement('ul');
            unresolved.className = 'pm-record-list';
            const tasksById = new Map(mapped.tasks.map(function knownTask(task) { return [task.id, task]; }));
            const projectsById = new Map(mapped.projects.map(function knownProject(project) { return [project.id, project]; }));
            const listing = latest.workspace?.threads ?? latest.workspace;
            const nativeTasks = new Map();
            for (const thread of listing?.threads ?? (listing?.thread ? [listing.thread] : [])) {
                if (thread?.id) nativeTasks.set(thread.id, thread);
            }
            const nativeProjects = new Map();
            for (const project of latest.workspace?.projectCatalog?.native?.projects ?? []) {
                if (project?.id) indexProject(`native:${project.id}`, {label: 'Public project', project});
            }
            const desktop = latest.workspace?.projectCatalog?.desktop;
            for (const project of Object.values(desktop?.localProjects ?? {})) {
                if (!project?.id) continue;
                const source = {label: 'Desktop project', project};
                indexProject(`desktop-local:${project.id}`, source);
                const nativeId = desktop.nativeProjectIdsByLegacyId?.[project.id];
                if (typeof nativeId === 'string' && nativeId) indexProject(`native:${nativeId}`, source);
            }
            for (const item of mapped.unassociated) {
                const row = document.createElement('li');
                appendText(row, 'h3', 'Association unresolved');
                appendNativeTask(row, item.threadId);
                if (item.nativeProjectId !== undefined && item.nativeProjectId !== null) {
                    appendIdentity(row, 'Codex project', item.nativeProjectId);
                    appendProjectNames(row, [`native:${item.nativeProjectId}`, `desktop-local:${item.nativeProjectId}`]);
                }
                appendText(row, 'p', mappingReason(item.reason));
                for (const id of item.taskIds ?? []) {
                    const task = tasksById.get(id);
                    appendIdentity(row, task?.title ? `PM task “${task.title}”` : 'PM task', id);
                }
                for (const id of item.projectIds ?? []) {
                    const project = projectsById.get(id);
                    appendIdentity(row, project?.name ? `PM project “${project.name}”` : 'PM project', id);
                }
                appendTaskLookup(row, item.threadId, latest);
                unresolved.append(row);
            }
            for (const failure of mapped.failures) {
                const row = document.createElement('li');
                appendText(row, 'h3', 'Record unavailable');
                if (failure.stage === 'saved-inventory') {
                    appendIdentity(row, `Saved ${failure.recordType ?? 'PM'} record`, failure.key);
                    appendText(row, 'p', 'This saved record could not be read. Discovery could not establish its existing associations.');
                } else if (failure.stage === 'projects') {
                    appendIdentity(row, 'Codex project reference', failure.id);
                    appendProjectNames(row, [failure.id]);
                    appendText(row, 'p', 'The project association could not be completed.');
                } else {
                    const threadId = failure.threadId ?? failure.id;
                    appendNativeTask(row, threadId);
                    if (failure.threadId) appendIdentity(row, 'PM task', failure.id);
                    appendText(row, 'p', failure.stage === 'archive-observations'
                        ? 'The Codex archive information could not be recorded.'
                        : 'The task association could not be completed.');
                    appendTaskLookup(row, threadId, latest);
                }
                unresolved.append(row);
            }
            for (const conflict of mapped.archiveConflicts) {
                const row = document.createElement('li');
                appendText(row, 'h3', 'Codex archive state is uncertain');
                appendNativeTask(row, conflict.threadId);
                appendIdentity(row, 'PM task', conflict.taskId);
                appendText(row, 'p', 'Codex returned different archive states for this task. Its PM archive choice is unchanged.');
                appendTaskLookup(row, conflict.threadId, latest);
                unresolved.append(row);
            }
            if (unresolved.childElementCount) mappingResults.append(unresolved);
            if (mapped.status !== 'complete') {
                appendText(mappingResults, 'p', 'Use Find Codex tasks above to refresh discovery. Review a task to use its existing association actions.');
            }
            if (latest.error && !value.failure) {
                appendText(mappingResults, 'p', 'Discovery stopped before finishing. This result retains the work already accepted.');
            }

            function appendNativeTask(parent, threadId) {
                const thread = nativeTasks.get(threadId);
                if (thread?.name) appendText(parent, 'p', thread.name);
                appendIdentity(parent, 'Codex task', threadId);
            }

            function indexProject(reference, source) {
                const sources = nativeProjects.get(reference) ?? [];
                sources.push(source);
                nativeProjects.set(reference, sources);
            }

            function appendProjectNames(parent, references) {
                const shown = new Set();
                for (const reference of references) {
                    for (const source of nativeProjects.get(reference) ?? []) {
                        if (shown.has(source)) continue;
                        shown.add(source);
                        if (source.project.name) appendIdentity(parent, `${source.label} “${source.project.name}”`, source.project.id);
                    }
                }
            }
        }
        if (value.failure) {
            const diagnostic = value.failure.error ?? value.failure.workspace;
            if (diagnostic && diagnostic !== reportedFailure) {
                reportedFailure = diagnostic;
                console.error('Arcane PM retained discovery attempt diagnostics', value.failure.error, value.failure.workspace);
            }
            appendText(mappingResults, 'p', value.failure.current
                ? 'The latest discovery attempt could not finish. Use Find Codex tasks to retry.'
                : 'A discovery attempt on a previous connection could not finish.');
            if (latest) appendText(mappingResults, 'p', 'The retained mapping result is shown above.');
        }
        renderState(bridge.status());
    }

    function appendText(parent, tag, text) {
        const element = document.createElement(tag);
        element.textContent = text;
        parent.append(element);
        return element;
    }

    function appendIdentity(parent, label, value) {
        if (value !== undefined && value !== null) appendText(parent, 'p', `${label}: ${value}`);
    }

    function appendTaskLookup(parent, threadId, latest) {
        if (typeof threadId !== 'string' || !threadId) return;
        const lookup = button('Review this task', async function reviewUnresolvedTask() {
            if (discoveryState?.latest !== latest || !latest.current) {
                showOperation('Find Codex tasks again to review the current connection.');
                return;
            }
            taskId.value = threadId;
            await findTask();
        });
        lookup.classList.add('arcane-button--secondary');
        discoveryLookups.add(lookup);
        parent.append(lookup);
    }

    function mappingReason(reason) {
        switch (reason) {
            case 'native-identity-unavailable': return 'The Codex account and host could not be identified. Refresh the connection before finding tasks again.';
            case 'project-catalog-host-mismatch': return 'The project and task results came from different hosts. Refresh the connection before finding tasks again.';
            case 'discovery-stale': return 'The connection changed before discovery finished. Find Codex tasks again on the current connection.';
            case 'saved-inventory-unreadable': return 'Some saved PM records could not be read, so their existing associations remain unresolved.';
            case 'conflicting-project-mapping': return 'The saved project identities disagree about which Codex project they refer to.';
            case 'ambiguous-project-association': return 'The saved PM project association is ambiguous. Discovery has not selected a project.';
            case 'project-association-changed': return 'The PM project association changed while discovery was running.';
            case 'task-association-changed': return 'The PM task association changed while discovery was running.';
            case 'association-required': return 'A saved PM task is missing its connection host. Review this task to associate the existing record.';
            case 'unsupported-project-assignment': return 'This Codex project assignment is not supported by PM.';
            case 'assigned-project-unavailable': return 'The Codex project assigned to this task was unavailable in the project results.';
            case 'project-assignments-unavailable': return 'Saved project assignments are incomplete, so this task’s project could not be determined.';
            default: return 'Some discovery information or associations remain unresolved.';
        }
    }

    async function refresh() {
        showOperation('Reading the connection state…');
        await bridge.refreshStatus({signal: pageSignal});
        showOperation('Connection state updated.');
    }

    async function connect() {
        showOperation('Connecting to Codex…', 'connect');
        if (connectCodex) await connectCodex({signal: pageSignal});
        else await bridge.connect({signal: pageSignal});
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
            const parameters = {signal: pageSignal};
            if (archived.value !== 'all') parameters.archived = archived.value === 'archived';
            const workspace = discoverTasks
                ? await discoverTasks(parameters)
                : await bridge.discoverWorkspace(parameters);
            pageSignal.throwIfAborted();
            if (revision !== discoveryRevision) return;
            const result = workspace.threads ?? workspace;
            if (result.status === 'unavailable') {
                showOperation(result.message);
                return;
            }
            results.replaceChildren();
            const rendered = new Set();
            for (const thread of result.threads) {
                if (rendered.has(thread.id)) continue;
                rendered.add(thread.id);
                renderThread(thread, workspace);
            }
            showOperation(result.coverage.complete && workspace.projectCatalog?.coverage.complete
                ? `${rendered.size} accessible Codex tasks found.`
                : `${rendered.size} Codex tasks retrieved. Some task or project information remains unavailable.`, null, !discoverTasks);
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
            const workspace = await bridge.discoverWorkspace({threadId, signal: pageSignal});
            pageSignal.throwIfAborted();
            if (revision !== discoveryRevision) return;
            const result = workspace.threads ?? workspace;
            if (result.status === 'unavailable') {
                showOperation(result.message);
                return;
            }
            results.replaceChildren();
            renderThread(result.thread, workspace);
            showOperation('Codex task found.');
        } finally {
            finding = false;
            renderState(bridge.status());
        }
    }

    function renderThread(thread, workspace) {
        const {identity} = workspace.threads ?? workspace;
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
                if (!originIdentity) {
                    showOperation('Find this task with an identified Codex account and host before associating it.');
                    return;
                }
                const matches = existing.filter(sameNativeThread);
                if (matches.length) {
                    await offerSavedTasks(matches, 'This Codex task is already in PM.');
                    return;
                }
                const unassociated = existing.filter(function missingNativeIdentity(task) {
                    return task.origin?.provider === 'codex' && task.origin.threadId === thread.id
                        && (typeof task.origin.hostId !== 'string' || task.origin.hostId.trim() === '');
                });
                if (unassociated.length) {
                    showOperation('This task has a saved association without its host. Associate it with this host to observe available activity.');
                    const choices = document.createElement('div');
                    choices.className = 'pm-actions';
                    for (const saved of unassociated) {
                        const label = unassociated.length === 1
                            ? 'Associate saved task with this connection'
                            : `Associate ${saved.title || saved.id} (${saved.id}) with this connection`;
                        const associate = button(label, async function associateSavedTask() {
                            const selectedIdentity = currentIdentity();
                            if (!selectedIdentity) {
                                showOperation('Find this task again to capture the current connection identity.');
                                return;
                            }
                            const current = await pmData.getTask(saved.id, {signal: pageSignal});
                            pageSignal.throwIfAborted();
                            if (!current || current.origin?.provider !== 'codex'
                                || current.origin.threadId !== thread.id
                                || (typeof current.origin.hostId === 'string' && current.origin.hostId.trim() !== '')) {
                                showOperation('The saved association changed. Find this task again.');
                                return;
                            }
                            if (!currentIdentity()) {
                                showOperation('Find this task again to capture the current connection identity.');
                                return;
                            }
                            const task = await pmData.updateTask(current.id, {
                                origin: {...current.origin, hostId: selectedIdentity.hostId}
                            });
                            showOperation('Task connection associated locally.');
                            if (!pageSignal.aborted) onNavigate?.('task', {projectId: task.projectId, taskId: task.id});
                        });
                        choices.append(associate);
                    }
                    associationAction.replaceWith(choices);
                    return;
                }
                const selectedWorkspace = workspace.threads?.thread
                    ? workspace
                    : await bridge.discoverWorkspace({threadId: thread.id, signal: pageSignal});
                pageSignal.throwIfAborted();
                if (selectedWorkspace.threads?.status === 'unavailable'
                    || !currentIdentity()
                    || selectedWorkspace.threads?.identity?.connectionId !== identity.connectionId
                    || selectedWorkspace.threads?.identity?.originIdentity?.accountId !== originIdentity.accountId
                    || selectedWorkspace.threads?.identity?.originIdentity?.hostId !== originIdentity.hostId) {
                    showOperation('Find this task again to read its current connection and project assignment.');
                    return;
                }
                const mapped = await pmData.syncNativeDiscovery(selectedWorkspace, {
                    signal: pageSignal,
                    isCurrent: function associationStillCurrent() { return Boolean(currentIdentity()); },
                    ...(workspace.threads?.thread && projectId ? {projectId} : {})
                });
                pageSignal.throwIfAborted();
                const associations = mapped.associations?.filter(function selectedAssociation(value) {
                    return value.threadId === thread.id;
                }) ?? [];
                if (!associations.length) {
                    console.info('Arcane PM task discovery association result', mapped);
                    showOperation('The task association is incomplete. Refresh discovery to read its current account and project assignment.');
                    return;
                }
                const mappedTasks = new Map((mapped.tasks ?? []).map(task => [task.id, task]));
                await offerSavedTasks(associations.map(function associatedTask(association) {
                    return {id: association.taskId, title: mappedTasks.get(association.taskId)?.title};
                }), 'Task association saved locally.');
            });
            article.append(associationAction);

            function sameNativeThread(task) {
                return task.origin?.provider === 'codex' && task.origin.threadId === thread.id
                    && typeof thread.id === 'string' && thread.id.trim() !== ''
                    && typeof task.origin.hostId === 'string' && task.origin.hostId.trim() !== ''
                    && task.origin.hostId === identity?.originIdentity?.hostId;
            }

            async function openSavedTask(saved, message) {
                const current = await pmData.getTask(saved.id, {signal: pageSignal});
                pageSignal.throwIfAborted();
                if (!current || !sameNativeThread(current)) {
                    showOperation('The saved association changed. Find this task again.');
                    return;
                }
                showOperation(message);
                onNavigate?.('task', {projectId: current.projectId, taskId: current.id});
            }

            async function offerSavedTasks(tasks, message) {
                if (tasks.length === 1) {
                    await openSavedTask(tasks[0], message);
                    return;
                }
                showOperation('This Codex task has several saved PM records. Choose the record to open.');
                const choices = document.createElement('div');
                choices.className = 'pm-actions';
                for (const saved of tasks) {
                    choices.append(button(`Open ${saved.title || saved.id} (${saved.id})`, async function openSelectedTask() {
                        await openSavedTask(saved, message);
                    }));
                }
                associationAction.replaceWith(choices);
            }
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
    const stopDiscovery = taskDiscovery?.subscribe(renderDiscovery, {signal: pageSignal, emitCurrent: true});
    refresh().catch(reportFailure);
    function dispose() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        stop();
        stopDiscovery?.();
        discoveryLookups.clear();
        requests.dispose();
    }
    return {refresh, dispose};
}
