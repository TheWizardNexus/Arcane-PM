export function mountCleanupView(container, {cleanup, pmData, projectId = null, taskActivityReady, onNavigate, onStatus, signal} = {}) {
    const document = container.ownerDocument;
    const lifetime = new AbortController();
    const root = document.createElement('section');
    root.className = 'pm-cleanup';
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./cleanup.css', import.meta.url).href;
    const heading = document.createElement('h1');
    heading.className = 'arcane-view-heading';
    heading.textContent = 'A little room to think.';
    const introduction = document.createElement('p');
    introduction.textContent = 'Put work away, restore a task, or review one specific removal.';
    const navigation = document.createElement('nav');
    navigation.className = 'pm-cleanup-tabs';
    navigation.setAttribute('aria-label', 'Tidy-up views');
    const content = document.createElement('div');
    content.className = 'pm-cleanup-content';
    const inventory = document.createElement('section');
    inventory.className = 'pm-cleanup-inventory';
    const reviewPanel = document.createElement('section');
    reviewPanel.className = 'arcane-card pm-cleanup-review';
    reviewPanel.setAttribute('aria-label', 'Selected action');
    const status = document.createElement('p');
    status.className = 'pm-cleanup-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'arcane-button arcane-button--secondary';
    refreshButton.textContent = 'Refresh';
    const toolbar = document.createElement('div');
    toolbar.className = 'pm-cleanup-toolbar';
    toolbar.append(status, refreshButton);
    content.append(inventory, reviewPanel);
    root.append(stylesheet, heading, introduction, navigation, toolbar, content);
    container.replaceChildren(root);

    let activeView = 'tasks';
    let snapshot = null;
    let selectedReview = null;
    let nativeOutcome = null;
    let nativeConnection = null;
    let nativeConnectionRevision = 0;
    let nativeReviewInvalidated = false;
    let pendingAction = false;
    let refreshRevision = 0;
    let reviewRevision = 0;
    let inventoryLifetime = new AbortController();
    let reviewLifetime = new AbortController();
    let stopNative = null;
    let stopData = null;
    let stopActivity = null;
    let taskActivity = null;
    let taskRecords = new Map();
    let taskIds = [];
    let folderTaskIds = [];
    let changesDuringRefresh = null;
    let inventoryFrame = null;
    let inventoryChanged = false;
    const taskRows = new Map();
    const visibleTaskIds = new Set();
    const changedTaskIds = new Set();
    const pages = {tasks: 0, resources: 0, 'working-files': 0};
    const pageLength = 2;
    const workStateLabels = {
        idle: 'Idle', unknown: 'Unknown', notLoaded: 'Not loaded', working: 'Working',
        'needs-input': 'Needs your input', 'needs-approval': 'Needs your approval', error: 'Needs attention'
    };

    for (const [view, label] of [['tasks', 'Tasks'], ['resources', 'App files'], ['working-files', 'Working files']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arcane-button arcane-button--secondary';
        button.textContent = label;
        button.dataset.view = view;
        button.setAttribute('aria-pressed', String(view === activeView));
        button.addEventListener(
            'click',
            selectView,
            {signal: lifetime.signal}
        );
        navigation.append(button);
    }

    function showStatus(message) {
        if (lifetime.signal.aborted) {
            return;
        }
        status.textContent = message;
        if (onStatus) {
            try {
                onStatus(message);
            } catch (error) {
                console.error('Arcane PM tidy-up status observer failed.', error);
            }
        }
    }

    function reportFailure(error, message) {
        if (error?.name === 'AbortError' || lifetime.signal.aborted) {
            return;
        }
        console.error('Arcane PM tidy-up operation failed.', error);
        showStatus(message);
    }

    function selectView(event) {
        activeView = event.currentTarget.dataset.view;
        for (const button of navigation.children) {
            button.setAttribute('aria-pressed', String(button.dataset.view === activeView));
        }
        renderInventory();
    }

    function appendText(parent, tag, text, className) {
        const element = document.createElement(tag);
        element.textContent = text;
        if (className) {
            element.className = className;
        }
        parent.append(element);
        return element;
    }

    function renderInventory() {
        inventoryLifetime.abort();
        inventoryLifetime = new AbortController();
        inventory.replaceChildren();
        visibleTaskIds.clear();
        if (!snapshot) {
            appendText(inventory, 'p', 'Loading tasks and files…', 'arcane-state');
            return;
        }

        if (activeView === 'resources') {
            appendText(inventory, 'h2', 'App files to review', 'arcane-section-heading');
            if (snapshot.resourcesError) {
                appendText(inventory, 'p', 'The app-resource owner could not load its inventory. Refresh to try again.', 'arcane-state arcane-state--error');
                return;
            }
            if (!snapshot.resourcesAvailable) {
                appendText(inventory, 'p', 'No disposable app-resource owner is connected. Working folders are managed separately.', 'arcane-state');
                return;
            }
            if (!snapshot.resources.length) {
                appendText(inventory, 'p', 'The app-resource owner has no files to review for this project.', 'arcane-state');
            }
            const resources = pageItems(snapshot.resources);
            for (const resource of resources.items) {
                const row = document.createElement('article');
                row.className = 'arcane-card pm-cleanup-row';
                appendText(row, 'h3', resource.title);
                appendText(row, 'p', resource.purpose || 'Purpose is unavailable.');
                appendText(row, 'p', `Owner: ${resource.owner} · State: ${resource.lifecycle}`, 'arcane-help');
                if (resource.location) {
                    appendText(row, 'p', resource.location, 'pm-cleanup-original');
                }
                if (resource.usedBy?.length) {
                    appendText(row, 'p', `In use by: ${resource.usedBy.join(', ')}`, 'arcane-help');
                }
                appendReviewButton(row, 'dispose-resource', resource.id, 'Review resource', resource.projectId);
                inventory.append(row);
            }
            appendPagination(resources, 'files');
            return;
        }

        if (activeView === 'working-files') {
            appendText(inventory, 'h2', 'Working files stay with their project', 'arcane-section-heading');
            appendText(inventory, 'p', 'Task archival and PM-record removal leave these folders in place. App-file cleanup does not scan or remove working files.');
            if (snapshot.projectError) {
                appendText(inventory, 'p', 'The project folder could not be read. Refresh to try again.', 'arcane-state arcane-state--error');
            } else if (snapshot.project?.workFolder) {
                appendText(inventory, 'p', snapshot.project.workFolder, 'pm-cleanup-original');
            } else if (projectId) {
                appendText(inventory, 'p', 'No project working folder is recorded.', 'arcane-state');
            } else {
                appendText(inventory, 'p', 'Choose a project to view its working folder. All recorded task folders are listed below.', 'arcane-help');
            }
            const folders = pageItems(folderTaskIds);
            for (const taskId of folders.items) {
                const task = taskRecords.get(taskId);
                const row = document.createElement('article');
                row.className = 'arcane-card pm-cleanup-row';
                appendText(row, 'h3', task.title);
                appendText(row, 'p', task.workFolder, 'pm-cleanup-original');
                appendText(row, 'p', task.archivedAt ? 'Archived PM task; working files stay with their owner.' : 'Associated with an unarchived PM task.', 'arcane-help');
                appendTaskLink(row, task, inventoryLifetime.signal);
                inventory.append(row);
            }
            appendPagination(folders, 'task folders');
            if (snapshot.tasksError) {
                appendText(inventory, 'p', 'Some task folder associations could not be loaded. Refresh to try again.', 'arcane-state arcane-state--error');
            }
            return;
        }

        appendText(inventory, 'h2', projectId ? 'Project tasks' : 'All tasks', 'arcane-section-heading');
        if (snapshot.tasksError) {
            appendText(inventory, 'p', 'The task list could not be loaded completely. Refresh to try again.', 'arcane-state arcane-state--error');
        }
        if (!taskIds.length && !snapshot.tasksError) {
            appendText(inventory, 'p', projectId ? 'This project has no PM tasks to tidy up.' : 'There are no PM tasks to tidy up.', 'arcane-state');
        }
        const tasks = pageItems(taskIds);
        for (const taskId of tasks.items) {
            visibleTaskIds.add(taskId);
            const entry = taskRows.get(taskId) || createTaskRow(taskId);
            updateTaskRow(entry);
            inventory.append(entry.row);
        }
        appendPagination(tasks, snapshot.tasksError ? 'loaded tasks' : 'tasks');
    }

    function pageItems(items) {
        const total = items.length;
        const pageCount = Math.max(1, Math.ceil(total / pageLength));
        pages[activeView] = Math.min(pages[activeView], pageCount - 1);
        const start = pages[activeView] * pageLength;
        const end = Math.min(start + pageLength, total);
        const selected = [];
        for (let index = start; index < end; index++) selected.push(items[index]);
        return {items: selected, total, pageCount, start, end};
    }

    function appendPagination(page, label) {
        const navigation = document.createElement('nav');
        navigation.className = 'pm-cleanup-pagination';
        navigation.setAttribute('aria-label', `${label} pages`);
        const previous = document.createElement('button');
        previous.type = 'button';
        previous.className = 'arcane-button arcane-button--secondary';
        previous.textContent = 'Previous';
        previous.disabled = pages[activeView] === 0;
        previous.addEventListener(
            'click', previousPage,
            {signal: inventoryLifetime.signal}
        );
        const indicator = document.createElement('span');
        indicator.className = 'pm-cleanup-page-indicator';
        indicator.setAttribute('role', 'status');
        indicator.textContent = page.total
            ? `${page.start + 1}–${page.end} of ${page.total} ${label} · Page ${pages[activeView] + 1} of ${page.pageCount}`
            : `0 ${label}`;
        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'arcane-button arcane-button--secondary';
        next.textContent = 'Next';
        next.disabled = pages[activeView] + 1 === page.pageCount;
        next.addEventListener(
            'click', nextPage,
            {signal: inventoryLifetime.signal}
        );
        navigation.append(previous, indicator, next);
        inventory.append(navigation);
    }

    function previousPage() {
        pages[activeView] -= 1;
        renderInventory();
        focusInventory();
    }

    function nextPage() {
        pages[activeView] += 1;
        renderInventory();
        focusInventory();
    }

    function focusInventory() {
        const title = inventory.querySelector('h2');
        title.tabIndex = -1;
        title.focus(
            {preventScroll: true}
        );
        title.scrollIntoView(
            {block: 'nearest'}
        );
    }

    function appendTaskLink(parent, task, eventSignal) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arcane-button arcane-button--secondary';
        button.textContent = 'Open task';
        button.disabled = !onNavigate;
        button.addEventListener(
            'click',
            function openTask() {
                const current = taskRecords.get(task.id);
                if (current) onNavigate(
                    'task',
                    {projectId: current.projectId, taskId: current.id}
                );
            },
            {signal: eventSignal}
        );
        parent.append(button);
    }

    function createTaskRow(taskId) {
        const rowLifetime = new AbortController();
        const row = document.createElement('article');
        row.className = 'arcane-card pm-cleanup-row pm-cleanup-task-row';
        const title = appendText(row, 'h3', '');
        const pmArchive = appendText(row, 'p', '', 'arcane-badge');
        const workState = appendText(row, 'p', '', 'arcane-help');
        const activity = appendText(row, 'p', '', 'pm-cleanup-activity');
        const activityMessage = appendText(row, 'p', '', 'pm-cleanup-original arcane-help');
        const nativeArchive = appendText(row, 'p', '', 'arcane-help');
        const assignment = document.createElement('details');
        assignment.className = 'pm-cleanup-assignment';
        appendText(assignment, 'summary', 'Assignment');
        const assignmentText = appendText(assignment, 'p', '', 'pm-cleanup-original');
        row.append(assignment);
        const actions = document.createElement('div');
        actions.className = 'pm-cleanup-actions';
        appendTaskLink(actions, taskRecords.get(taskId), rowLifetime.signal);
        const reviewButton = document.createElement('button');
        reviewButton.type = 'button';
        reviewButton.className = 'arcane-button arcane-button--secondary';
        reviewButton.textContent = 'Review actions';
        reviewButton.addEventListener(
            'click',
            function reviewTask() {
                const task = taskRecords.get(taskId);
                if (task) void selectTarget(task.archivedAt ? 'restore-task' : 'archive-task', task.id, task.projectId);
            },
            {signal: rowLifetime.signal}
        );
        actions.append(reviewButton);
        row.append(actions);
        const entry = {taskId, row, rowLifetime, title, pmArchive, workState, activity, activityMessage, nativeArchive, assignment, assignmentText, reviewButton};
        taskRows.set(taskId, entry);
        return entry;
    }

    function updateText(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }

    function workStateText(state) {
        return workStateLabels[state] || state || 'Unknown';
    }

    function matchesNativeTask(observation, task) {
        const origin = task.origin;
        const saved = observation?.origin;
        return origin?.provider === 'codex' && saved?.provider === 'codex'
            && Boolean(origin.hostId && origin.threadId)
            && saved.hostId === origin.hostId && saved.threadId === origin.threadId;
    }

    function updateTaskRow(entry) {
        const task = taskRecords.get(entry.taskId);
        if (!task) return;
        updateText(entry.title, task.title);
        updateText(entry.pmArchive, task.archivedAt ? 'Archived in PM' : 'Not archived in PM');
        updateText(entry.workState, `Recorded work state: ${workStateText(task.status)}`);
        const current = taskActivity?.current(task.id);
        const saved = matchesNativeTask(task.nativeActivity, task) ? task.nativeActivity : null;
        const linked = task.origin?.provider === 'codex';
        entry.activity.hidden = !linked && !saved && !current;
        const message = (current ? current.message : saved?.message) || '';
        entry.activityMessage.hidden = !message;
        updateText(entry.activity, current
            ? `Current Codex activity: ${workStateText(current.state)}`
            : saved
                ? `Current activity unconfirmed. Saved observation: ${saved.availability === 'observed' ? workStateText(saved.state) : saved.availability}${saved.observedAt ? ` · ${saved.observedAt}` : ''}`
                : 'Current Codex activity is unconfirmed.');
        updateText(entry.activityMessage, message);
        const archive = matchesNativeTask(task.nativeArchiveObservation, task) ? task.nativeArchiveObservation : null;
        entry.nativeArchive.hidden = !linked && !archive;
        const archiveLabel = archive?.archived === true ? 'Archived' : archive?.archived === false ? 'Not archived' : archive ? 'Uncertain' : 'Unobserved';
        updateText(entry.nativeArchive, `Last Codex archive observation: ${archiveLabel}${archive?.observedAt ? ` · ${archive.observedAt}` : ''}`);
        entry.assignment.hidden = !task.assignment;
        updateText(entry.assignmentText, task.assignment || '');
        entry.reviewButton.disabled = pendingAction;
    }

    function appendReviewButton(parent, action, targetId, label, targetProjectId) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arcane-button arcane-button--secondary';
        button.textContent = label;
        button.disabled = pendingAction;
        button.addEventListener(
            'click',
            function requestTargetReview() {
                void selectTarget(action, targetId, targetProjectId);
            },
            {signal: inventoryLifetime.signal}
        );
        parent.append(button);
    }

    async function selectTarget(action, targetId, targetProjectId) {
        if (pendingAction || lifetime.signal.aborted) {
            return;
        }
        const revision = ++reviewRevision;
        const connectionRevision = nativeConnectionRevision;
        selectedReview = null;
        nativeOutcome = null;
        nativeReviewInvalidated = false;
        renderReview();
        showStatus('Preparing the selected action for review…');
        try {
            const reviewed = await cleanup.review(
                {action, targetId, projectId: targetProjectId},
                {signal: lifetime.signal}
            );
            if (lifetime.signal.aborted || revision !== reviewRevision) {
                return;
            }
            selectedReview = reviewed;
            nativeReviewInvalidated = Boolean(reviewed.native && connectionRevision !== nativeConnectionRevision);
            renderReview();
            showStatus(nativeReviewInvalidated ? 'The Codex connection changed during review. Review the intended target again.' : 'Review the selected target and its effect.');
        } catch (error) {
            if (revision === reviewRevision) {
                reportFailure(error, 'The selected target could not be loaded. Refresh and review it again.');
            }
        }
    }

    function renderReview() {
        reviewLifetime.abort();
        reviewLifetime = new AbortController();
        reviewPanel.replaceChildren();
        appendText(reviewPanel, 'h2', 'Selected action', 'arcane-section-heading');
        if (!selectedReview) {
            appendText(reviewPanel, 'p', 'Choose a task or app resource to see the exact effect before acting.');
            return;
        }

        appendText(reviewPanel, 'h3', selectedReview.title);
        appendText(reviewPanel, 'p', `Owner: ${selectedReview.owner || 'Unavailable'}`, 'arcane-help');
        appendText(reviewPanel, 'p', `Record: ${selectedReview.targetId}`, 'pm-cleanup-original arcane-help');
        if (selectedReview.action !== 'dispose-resource' && selectedReview.target) {
            const field = document.createElement('label');
            field.className = 'arcane-field';
            appendText(field, 'span', 'Action');
            const select = document.createElement('select');
            const lifecycleAction = selectedReview.target.archivedAt ? 'restore-task' : 'archive-task';
            const choices = [
                [lifecycleAction, selectedReview.target.archivedAt ? 'Restore PM task' : 'Archive PM task'],
                ['remove-task-record', 'Remove PM task record'],
                ['archive-native-task', 'Archive Codex conversation'],
                ['restore-native-task', 'Restore Codex conversation'],
                ['delete-native-task', 'Delete Codex conversation']
            ];
            for (const [value, label] of choices) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                select.append(option);
            }
            select.value = selectedReview.action;
            select.disabled = pendingAction;
            select.addEventListener(
                'change',
                function changeReviewedAction() {
                    void selectTarget(select.value, selectedReview.targetId, selectedReview.projectId);
                },
                {signal: reviewLifetime.signal}
            );
            field.append(select);
            reviewPanel.append(field);
        }
        appendText(reviewPanel, 'p', selectedReview.effect);
        if (selectedReview.native) {
            renderNativeTarget(selectedReview.native);
        }
        if (selectedReview.target?.location) {
            appendText(reviewPanel, 'p', selectedReview.target.location, 'pm-cleanup-original');
        }
        appendText(reviewPanel, 'h3', 'Stays with its owner');
        const retained = document.createElement('ul');
        for (const item of selectedReview.retained) {
            appendText(retained, 'li', item);
        }
        reviewPanel.append(retained);
        if (selectedReview.message) {
            appendText(reviewPanel, 'p', selectedReview.message, 'arcane-form-note');
        }
        if (selectedReview.native && selectedReview.nativeUrl) {
            const link = document.createElement('a');
            link.href = selectedReview.nativeUrl;
            link.textContent = 'Open original conversation';
            link.className = 'arcane-button arcane-button--secondary';
            reviewPanel.append(link);
        }
        if (nativeOutcome) {
            const outcome = document.createElement('section');
            outcome.className = 'pm-cleanup-outcome';
            outcome.setAttribute('aria-label', 'Native action result');
            appendText(outcome, 'h3', 'Native action result');
            appendText(outcome, 'p', nativeOutcome.message, 'pm-cleanup-original');
            if (nativeOutcome.observedAt) {
                appendText(outcome, 'p', `Observed: ${nativeOutcome.observedAt}`, 'arcane-help pm-cleanup-original');
            }
            appendText(outcome, 'p', 'Review the target again before selecting another native operation.', 'arcane-help');
            reviewPanel.append(outcome);
        }
        if (nativeReviewInvalidated && !pendingAction && !nativeOutcome) {
            appendText(reviewPanel, 'p', 'The Codex connection changed after this review. Review the intended conversation again before acting.', 'arcane-form-note');
        }
        if (selectedReview.native && !pendingAction && (nativeReviewInvalidated || nativeOutcome || !selectedReview.available)) {
            const reviewAgainButton = document.createElement('button');
            reviewAgainButton.type = 'button';
            reviewAgainButton.className = 'arcane-button arcane-button--secondary';
            reviewAgainButton.textContent = 'Review this native action again';
            reviewAgainButton.addEventListener(
                'click',
                function reviewNativeActionAgain() {
                    void selectTarget(selectedReview.action, selectedReview.targetId, selectedReview.projectId);
                },
                {signal: reviewLifetime.signal}
            );
            reviewPanel.append(reviewAgainButton);
        }
        const executeButton = document.createElement('button');
        executeButton.type = 'button';
        executeButton.className = 'arcane-button';
        executeButton.textContent = pendingAction ? 'Applying selected action…' : selectedReview.buttonLabel || 'Unavailable';
        executeButton.disabled = pendingAction || nativeReviewInvalidated || Boolean(nativeOutcome) || !selectedReview.available;
        executeButton.addEventListener(
            'click',
            applySelectedAction,
            {signal: reviewLifetime.signal}
        );
        reviewPanel.append(executeButton);
    }

    function renderNativeTarget(native) {
        appendText(reviewPanel, 'h3', 'Original Codex destination');
        const target = document.createElement('dl');
        target.className = 'pm-cleanup-identity';
        appendIdentityValue(target, 'Conversation', native.threadId);
        appendIdentityValue(target, 'Provider', native.origin?.provider);
        appendIdentityValue(target, 'Account', native.origin?.accountId);
        appendIdentityValue(target, 'Host', native.origin?.hostId);
        reviewPanel.append(target);

        appendText(reviewPanel, 'h3', 'Connection at review');
        const connection = document.createElement('dl');
        connection.className = 'pm-cleanup-identity';
        const reviewedIdentity = native.identity || native.connectedIdentity;
        appendIdentityValue(connection, 'Connection', reviewedIdentity?.connectionId);
        appendIdentityValue(connection, 'Provider', reviewedIdentity?.originIdentity?.provider);
        appendIdentityValue(connection, 'Account', reviewedIdentity?.originIdentity?.accountId);
        appendIdentityValue(connection, 'Host', reviewedIdentity?.originIdentity?.hostId);
        reviewPanel.append(connection);

        if (nativeReviewInvalidated && !pendingAction && !nativeOutcome) {
            appendText(reviewPanel, 'h3', 'Current connection');
            const current = document.createElement('dl');
            current.className = 'pm-cleanup-identity';
            appendIdentityValue(current, 'State', nativeConnection?.connected ? 'Connected' : 'Disconnected');
            appendIdentityValue(current, 'Connection', nativeConnection?.connectionId);
            appendIdentityValue(current, 'Provider', nativeConnection?.originIdentity?.provider);
            appendIdentityValue(current, 'Account', nativeConnection?.originIdentity?.accountId);
            appendIdentityValue(current, 'Host', nativeConnection?.originIdentity?.hostId);
            reviewPanel.append(current);
        }
        appendText(reviewPanel, 'p', native.descendants, 'pm-cleanup-original');
    }

    function appendIdentityValue(parent, label, value) {
        appendText(parent, 'dt', label);
        appendText(parent, 'dd', value === null || value === undefined || value === '' ? 'Unavailable' : String(value), 'pm-cleanup-original');
    }

    function observeNativeConnection(next) {
        const changed = Boolean(nativeConnection?.connected) !== Boolean(next?.connected)
            || nativeConnection?.connectionId !== next?.connectionId
            || nativeConnection?.originIdentity?.provider !== next?.originIdentity?.provider
            || nativeConnection?.originIdentity?.accountId !== next?.originIdentity?.accountId
            || nativeConnection?.originIdentity?.hostId !== next?.originIdentity?.hostId;
        nativeConnection = next;
        if (!changed || lifetime.signal.aborted) {
            return;
        }
        nativeConnectionRevision += 1;
        if (selectedReview?.native && !pendingAction && !nativeOutcome) {
            nativeReviewInvalidated = true;
            renderReview();
            showStatus('The Codex connection changed. Review the intended native target again.');
        }
    }

    async function applySelectedAction() {
        if (pendingAction || nativeReviewInvalidated || nativeOutcome || !selectedReview?.available) {
            return;
        }
        const reviewToExecute = selectedReview;
        pendingAction = true;
        renderReview();
        renderInventory();
        refreshButton.disabled = true;
        showStatus('Applying the selected action through its owner…');
        try {
            const result = await cleanup.execute(
                reviewToExecute,
                {signal: lifetime.signal}
            );
            if (result.error) {
                console.error('Arcane PM native tidy-up operation failed.', result.error);
            }
            if (lifetime.signal.aborted) {
                return;
            }
            if (reviewToExecute.native) {
                nativeOutcome = result;
                selectedReview = {...reviewToExecute, available: false};
                nativeReviewInvalidated = false;
            } else if (result.status === 'completed' || result.status === 'unchanged') {
                selectedReview = null;
                await refresh();
            } else if (result.review) {
                selectedReview = result.review;
            } else {
                selectedReview = {
                    ...reviewToExecute,
                    available: false,
                    message: result.message
                };
            }
            showStatus(result.message);
        } catch (error) {
            reportFailure(error, 'The owner did not return a confirmed result. Refresh and review the current target before trying again.');
            if (!lifetime.signal.aborted) {
                if (reviewToExecute.native) {
                    nativeOutcome = {
                        status: 'unconfirmed',
                        error,
                        message: 'The native outcome is unconfirmed. Inspect the original conversation and its descendants before another action.'
                    };
                }
                selectedReview = {
                    ...reviewToExecute,
                    available: false,
                    message: reviewToExecute.native ? '' : 'The result is unconfirmed. Refresh to inspect the current state before another action.'
                };
            }
        } finally {
            pendingAction = false;
            if (!lifetime.signal.aborted) {
                refreshButton.disabled = false;
                renderInventory();
                renderReview();
            }
        }
    }

    function belongsToView(task) {
        return task && (projectId === null || task.projectId === projectId);
    }

    function compareTasks(leftId, rightId) {
        const left = taskRecords.get(leftId);
        const right = taskRecords.get(rightId);
        return String(left.createdAt).localeCompare(String(right.createdAt)) || leftId.localeCompare(rightId);
    }

    function insertTaskId(ids, taskId) {
        let start = 0;
        let end = ids.length;
        while (start < end) {
            const middle = Math.floor((start + end) / 2);
            if (compareTasks(ids[middle], taskId) < 0) start = middle + 1;
            else end = middle;
        }
        ids.splice(start, 0, taskId);
    }

    function removeTaskId(ids, taskId) {
        const index = ids.indexOf(taskId);
        if (index !== -1) ids.splice(index, 1);
    }

    function retainTaskChange(taskId, record) {
        const previous = taskRecords.get(taskId);
        if (!belongsToView(record)) {
            if (!previous) return;
            removeTaskId(taskIds, taskId);
            removeTaskId(folderTaskIds, taskId);
            taskRecords.delete(taskId);
            taskRows.get(taskId)?.rowLifetime.abort();
            taskRows.delete(taskId);
            inventoryChanged = true;
            return;
        }
        taskRecords.set(taskId, record);
        if (!previous) {
            insertTaskId(taskIds, taskId);
            inventoryChanged = true;
        }
        if (Boolean(previous?.workFolder) !== Boolean(record.workFolder)) {
            if (record.workFolder) insertTaskId(folderTaskIds, taskId);
            else removeTaskId(folderTaskIds, taskId);
            if (activeView === 'working-files') inventoryChanged = true;
        }
        if (activeView === 'working-files' && previous
            && (previous.title !== record.title || previous.workFolder !== record.workFolder || previous.archivedAt !== record.archivedAt)) {
            inventoryChanged = true;
        }
        changedTaskIds.add(taskId);
    }

    function recordChanged(change) {
        if (lifetime.signal.aborted) return;
        if (change.recordType === 'project') {
            if (snapshot && change.id === projectId) {
                snapshot.project = change.record;
                if (activeView === 'working-files') {
                    inventoryChanged = true;
                    scheduleInventoryUpdate();
                }
            }
            return;
        }
        if (change.recordType !== 'task') return;
        changesDuringRefresh?.set(change.id, change.record);
        retainTaskChange(change.id, change.record);
        scheduleInventoryUpdate();
    }

    function activityChanged({taskId}) {
        if (lifetime.signal.aborted) return;
        if (taskId === null) {
            for (const visibleId of visibleTaskIds) changedTaskIds.add(visibleId);
        } else if (visibleTaskIds.has(taskId)) changedTaskIds.add(taskId);
        else return;
        scheduleInventoryUpdate();
    }

    function scheduleInventoryUpdate() {
        if (inventoryFrame === null) inventoryFrame = requestAnimationFrame(updateInventory);
    }

    function updateInventory() {
        inventoryFrame = null;
        if (lifetime.signal.aborted) return;
        if (inventoryChanged) {
            inventoryChanged = false;
            renderInventory();
        } else {
            for (const taskId of changedTaskIds) {
                if (visibleTaskIds.has(taskId)) updateTaskRow(taskRows.get(taskId));
            }
        }
        changedTaskIds.clear();
    }

    function connectActivity(service) {
        if (lifetime.signal.aborted) return;
        taskActivity = service;
        stopActivity = service.subscribe(
            activityChanged,
            {signal: lifetime.signal, emitCurrent: true}
        );
    }

    function activityFailed(error) {
        reportFailure(error, 'Current Codex activity is unavailable. Saved tasks and cleanup controls remain available.');
    }

    async function refresh() {
        const revision = ++refreshRevision;
        const changes = new Map();
        changesDuringRefresh = changes;
        if (!pendingAction && !nativeOutcome) {
            showStatus('Loading tasks and files…');
        }
        try {
            const loaded = await cleanup.listProjectTargets(
                projectId,
                {signal: lifetime.signal}
            );
            if (lifetime.signal.aborted || revision !== refreshRevision) {
                return;
            }
            snapshot = loaded;
            const records = new Map();
            for (const task of loaded.tasks) {
                if (belongsToView(task)) records.set(task.id, task);
            }
            for (const [taskId, task] of changes) {
                if (belongsToView(task)) records.set(taskId, task);
                else records.delete(taskId);
            }
            taskRecords = records;
            taskIds = [...records.keys()].sort(compareTasks);
            folderTaskIds = taskIds.filter(
                function hasWorkingFolder(taskId) {
                    return Boolean(records.get(taskId).workFolder);
                }
            );
            for (const taskId of taskRows.keys()) {
                if (!records.has(taskId)) {
                    taskRows.get(taskId).rowLifetime.abort();
                    taskRows.delete(taskId);
                }
            }
            for (const error of [loaded.projectError, loaded.tasksError, loaded.resourcesError]) {
                if (error) {
                    console.error('Arcane PM tidy-up inventory failed.', error);
                }
            }
            renderInventory();
            if (!pendingAction && !nativeOutcome) {
                showStatus(loaded.tasksError || loaded.resourcesError || loaded.projectError ? 'Some project information could not be loaded. Use Refresh to try again.' : 'Project information loaded.');
            }
        } catch (error) {
            reportFailure(error, 'Project information could not be loaded. Use Refresh to try again.');
        } finally {
            if (changesDuringRefresh === changes) changesDuringRefresh = null;
        }
    }

    function refreshFromButton() {
        if (pendingAction) {
            return;
        }
        if (!nativeOutcome) {
            selectedReview = null;
            reviewRevision += 1;
            nativeReviewInvalidated = false;
        }
        renderReview();
        void refresh();
    }

    function dispose() {
        lifetime.abort();
        inventoryLifetime.abort();
        reviewLifetime.abort();
        stopNative?.();
        stopData?.();
        stopActivity?.();
        if (inventoryFrame !== null) cancelAnimationFrame(inventoryFrame);
        for (const entry of taskRows.values()) entry.rowLifetime.abort();
        taskRows.clear();
        taskRecords.clear();
        signal?.removeEventListener('abort', dispose);
        root.remove();
    }

    refreshButton.addEventListener(
        'click',
        refreshFromButton,
        {signal: lifetime.signal}
    );
    signal?.addEventListener(
        'abort',
        dispose,
        {once: true}
    );
    renderInventory();
    renderReview();
    if (signal?.aborted) {
        dispose();
    } else {
        stopNative = cleanup.subscribeNative(
            observeNativeConnection,
            {signal: lifetime.signal, emitCurrent: true}
        );
        stopData = pmData.subscribe(
            recordChanged,
            {signal: lifetime.signal}
        );
        taskActivityReady?.then(connectActivity).catch(activityFailed);
        void refresh();
    }

    return {refresh, dispose};
}
