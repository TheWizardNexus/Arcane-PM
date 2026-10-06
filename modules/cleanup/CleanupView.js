export function mountCleanupView(container, {cleanup, pmData, projectId = null, onNavigate, onStatus, signal} = {}) {
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
    let pendingAction = false;
    let refreshRevision = 0;
    let reviewRevision = 0;

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
        inventory.replaceChildren();
        if (!snapshot) {
            appendText(inventory, 'p', 'Loading the selected project…', 'arcane-state');
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
            for (const resource of snapshot.resources) {
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
                appendReviewButton(row, 'dispose-resource', resource.id, 'Review resource');
                inventory.append(row);
            }
            return;
        }

        if (activeView === 'working-files') {
            appendText(inventory, 'h2', 'Working files stay with their project', 'arcane-section-heading');
            appendText(inventory, 'p', 'Task archival and PM-record removal leave these folders in place. App-file cleanup does not scan or remove working files.');
            if (snapshot.projectError) {
                appendText(inventory, 'p', 'The project folder could not be read. Refresh to try again.', 'arcane-state arcane-state--error');
            } else if (snapshot.project?.workFolder) {
                appendText(inventory, 'p', snapshot.project.workFolder, 'pm-cleanup-original');
            } else {
                appendText(inventory, 'p', 'No project working folder is recorded.', 'arcane-state');
            }
            for (const task of snapshot.tasks) {
                if (task.workFolder) {
                    const row = document.createElement('article');
                    row.className = 'arcane-card pm-cleanup-row';
                    appendText(row, 'h3', task.title);
                    appendText(row, 'p', task.workFolder, 'pm-cleanup-original');
                    appendText(row, 'p', task.archivedAt ? 'Archived PM task; working files stay with their owner.' : 'Associated with an active PM task.', 'arcane-help');
                    inventory.append(row);
                }
            }
            if (snapshot.tasksError) {
                appendText(inventory, 'p', 'Some task folder associations could not be loaded. Refresh to try again.', 'arcane-state arcane-state--error');
            }
            return;
        }

        appendText(inventory, 'h2', 'Project tasks', 'arcane-section-heading');
        if (snapshot.tasksError) {
            appendText(inventory, 'p', 'The task list could not be loaded completely. Refresh to try again.', 'arcane-state arcane-state--error');
        }
        if (!snapshot.tasks.length && !snapshot.tasksError) {
            appendText(inventory, 'p', 'This project has no PM tasks to tidy up.', 'arcane-state');
        }
        for (const task of snapshot.tasks) {
            const row = document.createElement('article');
            row.className = 'arcane-card pm-cleanup-row';
            appendText(row, 'h3', task.title);
            appendText(row, 'p', task.archivedAt ? 'Archived in PM' : 'Active in PM', 'arcane-badge');
            appendText(row, 'p', `Recorded work state: ${task.status}`, 'arcane-help');
            if (task.assignment) {
                appendText(row, 'p', task.assignment, 'pm-cleanup-original');
            }
            appendReviewButton(row, task.archivedAt ? 'restore-task' : 'archive-task', task.id, 'Review actions');
            inventory.append(row);
        }
    }

    function appendReviewButton(parent, action, targetId, label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arcane-button arcane-button--secondary';
        button.textContent = label;
        button.disabled = pendingAction;
        button.addEventListener(
            'click',
            function requestTargetReview() {
                void selectTarget(action, targetId);
            },
            {signal: lifetime.signal}
        );
        parent.append(button);
    }

    async function selectTarget(action, targetId) {
        const revision = ++reviewRevision;
        selectedReview = null;
        renderReview();
        showStatus('Preparing the selected action for review…');
        try {
            const reviewed = await cleanup.review(
                {action, targetId, projectId},
                {signal: lifetime.signal}
            );
            if (lifetime.signal.aborted || revision !== reviewRevision) {
                return;
            }
            selectedReview = reviewed;
            renderReview();
            showStatus('Review the selected target and its effect.');
        } catch (error) {
            if (revision === reviewRevision) {
                reportFailure(error, 'The selected target could not be loaded. Refresh and review it again.');
            }
        }
    }

    function renderReview() {
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
                ['delete-native-task', 'Native Codex conversation deletion']
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
                    void selectTarget(select.value, selectedReview.targetId);
                },
                {signal: lifetime.signal}
            );
            field.append(select);
            reviewPanel.append(field);
        }
        appendText(reviewPanel, 'p', selectedReview.effect);
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
        if (selectedReview.action === 'delete-native-task' && selectedReview.nativeUrl) {
            const link = document.createElement('a');
            link.href = selectedReview.nativeUrl;
            link.textContent = 'Open original conversation';
            link.className = 'arcane-button arcane-button--secondary';
            reviewPanel.append(link);
        }
        const executeButton = document.createElement('button');
        executeButton.type = 'button';
        executeButton.className = 'arcane-button';
        executeButton.textContent = pendingAction ? 'Applying selected action…' : selectedReview.buttonLabel || 'Unavailable';
        executeButton.disabled = pendingAction || !selectedReview.available;
        executeButton.addEventListener(
            'click',
            applySelectedAction,
            {signal: lifetime.signal}
        );
        reviewPanel.append(executeButton);
    }

    async function applySelectedAction() {
        if (pendingAction || !selectedReview?.available) {
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
            if (lifetime.signal.aborted) {
                return;
            }
            if (result.status === 'completed' || result.status === 'unchanged') {
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
                selectedReview = {
                    ...reviewToExecute,
                    available: false,
                    message: 'The result is unconfirmed. Refresh to inspect the current state before another action.'
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

    async function refresh() {
        const revision = ++refreshRevision;
        showStatus('Loading the selected project…');
        try {
            const loaded = await cleanup.listProjectTargets(
                projectId,
                {signal: lifetime.signal}
            );
            if (lifetime.signal.aborted || revision !== refreshRevision) {
                return;
            }
            snapshot = loaded;
            for (const error of [loaded.projectError, loaded.tasksError, loaded.resourcesError]) {
                if (error) {
                    console.error('Arcane PM tidy-up inventory failed.', error);
                }
            }
            renderInventory();
            showStatus(loaded.tasksError || loaded.resourcesError || loaded.projectError ? 'Some project information could not be loaded. Use Refresh to try again.' : 'Project information loaded.');
        } catch (error) {
            reportFailure(error, 'Project information could not be loaded. Use Refresh to try again.');
        }
    }

    function refreshFromButton() {
        selectedReview = null;
        reviewRevision += 1;
        renderReview();
        void refresh();
    }

    function dispose() {
        lifetime.abort();
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
        void refresh();
    }

    return {refresh, dispose};
}
