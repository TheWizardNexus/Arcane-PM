function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function guideIcon(pathData) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'pm-guide-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
    return icon;
}

function action(label, handler, secondary = false) {
    const button = element('button', `arcane-button${secondary ? ' arcane-button--secondary' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
}

function field(form, label, name, value = '', multiline = false) {
    const group = element('label', 'arcane-field');
    group.append(element('span', 'arcane-field__label', label));
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.name = name;
    input.value = value;
    if (multiline) input.rows = 5;
    group.append(input);
    form.append(group);
    return input;
}

function taskColumn(task, activity) {
    if (task.attention || ['blocked', 'attention', 'needs-input', 'waiting-for-input', 'waiting', 'stalled'].includes(task.status)) return 'attention';
    if (activity) {
        if (['needs-input', 'needs-approval', 'error'].includes(activity.state)) return 'attention';
        if (activity.state === 'working') return 'working';
        if (activity.state === 'idle') return ['completed', 'complete', 'done'].includes(task.status) ? 'completed' : 'ready';
    }
    if (['completed', 'complete', 'done'].includes(task.status)) return 'completed';
    // Keep explicit PM statuses separate from historical native observations.
    if (['working', 'running', 'in-progress', 'preparing'].includes(task.status)) return 'working';
    if (['idle', 'ready'].includes(task.status)) return 'ready';
    return 'unobserved';
}

function statusText(task) {
    const status = task.status === 'idle' ? 'Idle' : task.status === 'unknown' ? 'Unknown' : task.status.replaceAll('-', ' ');
    return `${status}${task.attention ? ' · Needs your input' : ''}`;
}

function nativeStateText(state) {
    const labels = {
        working: 'Working',
        'needs-input': 'Needs your input',
        'needs-approval': 'Needs your approval',
        idle: 'Idle',
        error: 'Needs attention',
        unknown: 'Unknown'
    };
    return labels[state] || labels.unknown;
}

function taskStateText(task, current) {
    if (current) return nativeStateText(current.state);
    return task.origin?.provider === 'codex' ? 'Activity unconfirmed' : statusText(task);
}

function createTaskActivityPresentation() {
    const node = element('section', 'pm-task-activity');
    const heading = element('strong', '');
    const currentState = element('p', 'pm-muted');
    const recordedState = element('p', 'pm-muted');
    const message = element('p', '');
    const timestamp = element('time', '');
    const lastHeading = element('strong', '');
    const lastMessage = element('p', '');
    const lastTimestamp = element('time', '');
    node.append(heading, currentState, recordedState, message, timestamp, lastHeading, lastMessage, lastTimestamp);
    node.hidden = true;

    function setText(target, value) {
        if (target.textContent !== value) target.textContent = value;
        target.hidden = !value;
    }

    function showTime(target, value) {
        target.hidden = !value;
        if (!value) return;
        target.dateTime = value;
        setText(target, `Observed ${new Date(value).toLocaleString()}`);
    }

    function update(task, current) {
        const activity = current || task?.nativeActivity;
        node.hidden = !activity && task?.origin?.provider !== 'codex';
        if (node.hidden) return;
        node.dataset.current = String(Boolean(current));
        if (current) {
            setText(heading, `Current Codex activity: ${nativeStateText(current.state)}`);
        } else if (activity?.availability === 'observed') {
            setText(heading, `Saved Codex observation: ${nativeStateText(activity.state)}`);
        } else if (activity) {
            setText(heading, activity.availability === 'disconnected' ? 'Saved Codex observation: Disconnected' : 'Saved Codex observation: Unobserved');
        } else {
            setText(heading, 'Current Codex activity is unconfirmed');
        }
        setText(currentState, !current && activity ? 'Current activity is unconfirmed.' : '');
        setText(recordedState, task ? `PM work state: ${statusText(task)}` : '');
        setText(message, activity?.message || '');
        showTime(timestamp, activity?.observedAt);
        const last = !current && activity?.availability !== 'observed' ? activity?.lastObserved : null;
        setText(lastHeading, last ? `Last observed activity: ${nativeStateText(last.state)}` : '');
        setText(lastMessage, last?.message || '');
        showTime(lastTimestamp, last?.observedAt);
    }

    return {node, update};
}

function createAvatarPresentation(modelsReady, {signal, onStatus}) {
    const entries = new Map();
    const statuses = new Map();
    const requested = new Set();
    const labels = {
        pending: 'Waiting', Thinking: 'Thinking', generating: 'Generating',
        saving: 'Saving', ready: 'Ready', error: 'Error', cancelled: 'Cancelled'
    };
    let service;
    let unsubscribe;
    let closed = false;
    let disposed = Boolean(signal?.aborted);
    modelsReady?.then(connect).catch(unavailable);

    function connect(models) {
        if (disposed || signal?.aborted) return;
        service = models.initialAvatars;
        unsubscribe = service.subscribe(receive, {signal});
        for (const entry of entries.values()) ensure(entry);
    }

    function receive(snapshot) {
        if (disposed || signal?.aborted) return;
        const incremental = snapshot.incremental === true;
        const closedChanged = closed !== snapshot.closed;
        closed = snapshot.closed;
        if (!incremental) statuses.clear();
        for (const status of snapshot.statuses) {
            const key = `${status.subjectType}:${status.subjectId}`;
            statuses.set(key, status);
            if (incremental && !closedChanged) entries.get(key)?.render();
        }
        if (!incremental || closedChanged) {
            for (const entry of entries.values()) entry.render();
        }
    }

    function ensure(entry, retry = false) {
        if (disposed || signal?.aborted || closed || !service || !entry.record) return;
        if (entry.record.faceRef !== null && entry.record.faceRef !== undefined) return;
        if (!retry && requested.has(entry.key)) return;
        requested.add(entry.key);
        try {
            // Preparation belongs to the app; only this view's subscription ends on navigation.
            const result = entry.subjectType === 'project'
                ? service.ensureProject(entry.subjectId, {retry})
                : service.ensureTask(entry.subjectId, {retry});
            result.catch(preparationFailed);
        } catch (error) {
            preparationFailed(error);
        }
    }

    function preparationFailed(error) {
        if (disposed || signal?.aborted || error?.name === 'AbortError') return;
        console.error('Arcane PM avatar preparation could not finish.', error);
        onStatus('The avatar could not be prepared. Review Local preparation, then retry the avatar.');
    }

    function unavailable(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM avatar preparation is unavailable.', error);
        onStatus('Avatar preparation is unavailable. Saved task details remain available.');
    }

    function add(subjectType, subjectId) {
        const key = `${subjectType}:${subjectId}`;
        const node = element('div', 'pm-avatar-status');
        const label = element('strong', '');
        const message = element('p', '');
        const retry = action('Retry avatar', retryAvatar, true);
        retry.hidden = true;
        node.hidden = true;
        node.append(label, message, retry);
        const entry = {key, subjectType, subjectId, record: null, render};
        entries.set(key, entry);

        function render() {
            const state = statuses.get(key);
            node.hidden = !entry.record || !state;
            if (node.hidden) return;
            const text = `Avatar: ${labels[state.status] || state.status}`;
            if (label.textContent !== text) label.textContent = text;
            if (message.textContent !== state.message) message.textContent = state.message;
            message.hidden = !state.message;
            retry.hidden = closed || !['error', 'cancelled'].includes(state.status)
                || (entry.record.faceRef !== null && entry.record.faceRef !== undefined);
        }

        function retryAvatar() {
            ensure(entry, true);
        }

        function update(record) {
            entry.record = record;
            // A saved choice completes automatic preparation for this view, even if later cleared.
            if (record?.faceRef !== null && record?.faceRef !== undefined) requested.add(key);
            render();
            ensure(entry);
        }

        function remove() {
            if (entries.get(key) === entry) entries.delete(key);
        }

        return {node, update, dispose: remove};
    }

    function dispose() {
        disposed = true;
        unsubscribe?.();
        entries.clear();
        statuses.clear();
        requested.clear();
    }

    return {add, dispose};
}

function createSavedPortrait(face, modelsReady, signal) {
    let disposed = Boolean(signal?.aborted);
    let faceRef = null;
    let imageUrl;
    let request;
    signal?.addEventListener('abort', dispose, {once: true});

    function releaseImage() {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = undefined;
    }

    function update(nextFaceRef) {
        if (disposed || nextFaceRef === faceRef) return;
        faceRef = nextFaceRef;
        request?.abort();
        releaseImage();
        face.textContent = '◇';
        if (!faceRef || !modelsReady) return;
        const reading = new AbortController();
        const selectedFaceRef = faceRef;
        request = reading;
        modelsReady.then(attachFace).catch(reportFaceFailure);

        async function attachFace(models) {
            if (disposed || reading.signal.aborted || !models?.faces?.read) return;
            const resolved = await models.faces.read(selectedFaceRef, {signal: reading.signal});
            if (disposed || reading.signal.aborted || !resolved?.blob) return;
            const image = element('img', '');
            imageUrl = URL.createObjectURL(resolved.blob);
            image.src = imageUrl;
            image.alt = '';
            face.replaceChildren(image);
        }

        function reportFaceFailure(error) {
            if (!disposed && !reading.signal.aborted) console.error('Arcane PM saved face is unavailable.', error);
        }
    }

    function dispose() {
        disposed = true;
        signal?.removeEventListener('abort', dispose);
        request?.abort();
        releaseImage();
    }

    return {update, dispose};
}

/** PM task presentation; the data and face owners retain their records and assets. */
export function mountTeamView(container, options) {
    const {pmData, projectId, onNavigate, onStatus, signal, modelsReady, workflowsReady, taskActivityReady, getHandoffs} = options;
    const heading = element('div', 'pm-page-heading pm-team-heading');
    const titleBlock = element('div', 'pm-team-heading-copy');
    const projectFace = element('div', 'pm-task-face pm-project-avatar', '◇');
    projectFace.setAttribute('aria-hidden', 'true');
    projectFace.hidden = true;
    const titleCopy = element('div', 'pm-task-presentation');
    const subtitle = element('p', 'pm-team-subtitle');
    subtitle.append(element('strong', '', 'A familiar face for every task.'), document.createTextNode(' Local plans and connected Codex tasks.'));
    titleCopy.append(element('h1', '', 'Your project team'), subtitle);
    const projectContext = element('div', 'pm-team-project');
    const projectLabel = element('p', 'pm-eyebrow');
    projectContext.hidden = !projectId;
    projectContext.append(projectFace, projectLabel);
    titleBlock.append(titleCopy, projectContext);
    const actions = element('div', 'pm-actions');
    const addTask = action('Add a task', openTaskForm);
    addTask.classList.add('pm-add-task');
    const addProject = action('Add existing project', openProjectForm);
    addProject.className = 'arcane-button arcane-button--tertiary pm-add-project';
    actions.append(addTask, addProject);
    heading.append(titleBlock, actions);
    const editor = element('section', 'pm-editor');
    const attentionStrip = element('section', 'pm-attention-strip');
    attentionStrip.setAttribute('aria-label', 'Tasks needing attention');
    attentionStrip.hidden = true;
    const attentionIcon = element('span', 'pm-attention-icon', '!');
    attentionIcon.setAttribute('aria-hidden', 'true');
    const attentionText = element('p', '');
    const attentionAction = action('Take a look →', openAttentionTask);
    attentionAction.className = 'arcane-button arcane-button--tertiary pm-attention-action';
    const dismissAttention = action('×', dismissAttentionStrip);
    dismissAttention.className = 'arcane-icon-button pm-attention-dismiss';
    dismissAttention.setAttribute('aria-label', 'Dismiss attention summary');
    attentionStrip.append(attentionIcon, attentionText, attentionAction, dismissAttention);
    const overview = element('div', 'pm-team-layout');
    const board = element('div', 'pm-board');
    const guide = element('aside', 'pm-team-guide arcane-card');
    const guidePortrait = element('div', 'pm-task-face pm-guide-portrait', '◇');
    guidePortrait.setAttribute('aria-hidden', 'true');
    const guideSummary = element('ul', 'pm-guide-summary');
    const guideAttention = element('li', '');
    const guideAttentionText = element('span', 'pm-guide-summary-text', 'Opening task records…');
    guideAttention.append(guideIcon('M6 3h12v18H6z M9 11l2 2 4-4'), guideAttentionText);
    const guideReady = element('li', '');
    const guideReadyText = element('span', 'pm-guide-summary-text');
    guideReady.append(guideIcon('M7 3h7l4 4v14H7z M14 3v5h4'), guideReadyText);
    guideReady.hidden = true;
    const guideUnobserved = element('li', '');
    guideUnobserved.hidden = true;
    const showUnobserved = action('Unobserved tasks', openUnobserved);
    showUnobserved.className = 'arcane-button arcane-button--tertiary pm-guide-unobserved';
    showUnobserved.setAttribute('aria-controls', 'pm-unobserved-tasks');
    guideUnobserved.append(guideIcon('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 3l18 18'), showUnobserved);
    guideSummary.append(guideAttention, guideReady, guideUnobserved);
    const guideButton = action('Talk to your guide', openGuide);
    guideButton.classList.add('pm-guide-open');
    guideButton.prepend(guideIcon('M21 11c0 4.4-4 8-9 8-1.2 0-2.4-.2-3.5-.6L3 21l1.5-5C3.5 14.6 3 12.9 3 11c0-4.4 4-8 9-8s9 3.6 9 8z'));
    guideButton.disabled = true;
    const guideAvailability = element('p', 'pm-guide-availability', projectId ? 'Opening project guide…' : 'Select a project to open its guide.');
    const preparation = action('Prepare locally', openLocalPreparation);
    preparation.className = 'arcane-button arcane-button--tertiary pm-guide-preparation';
    const guideDivider = element('hr', 'pm-guide-divider');
    guide.append(element('h2', '', 'Project guide'), element('p', 'pm-guide-subtitle', 'Coordinator · Local'), guidePortrait, element('h3', '', 'Let’s keep things moving.'), guideSummary, guideDivider, guideButton, guideAvailability, preparation);
    overview.append(board, guide);
    const completed = element('div', 'pm-completed-tasks');
    completed.hidden = true;
    const unobserved = element('div', 'pm-unobserved-tasks');
    unobserved.id = 'pm-unobserved-tasks';
    unobserved.hidden = true;
    const recentHandoffs = element('section', 'pm-recent-handoffs arcane-card');
    const handoffHeading = element('div', 'pm-recent-handoffs-heading');
    const viewHandoffs = action('View all handoffs →', openHandoffs);
    viewHandoffs.className = 'arcane-button arcane-button--tertiary';
    handoffHeading.append(element('h2', '', 'Recent handoffs'), viewHandoffs);
    const handoffStatus = element('p', 'pm-recent-handoffs-status', 'Opening saved handoffs…');
    handoffStatus.setAttribute('role', 'status');
    const handoffList = element('ol', 'pm-recent-handoff-list');
    recentHandoffs.append(handoffHeading, handoffStatus, handoffList);
    const guideDialog = element('dialog', 'pm-guide-dialog');
    guideDialog.setAttribute('aria-labelledby', 'pm-guide-dialog-title');
    const dialogHeading = element('div', 'pm-guide-dialog-heading');
    const dialogTitle = element('h2', '', 'Project guide');
    dialogTitle.id = 'pm-guide-dialog-title';
    const closeGuideButton = action('Close', closeGuide, true);
    closeGuideButton.autofocus = true;
    dialogHeading.append(dialogTitle, closeGuideButton);
    const guideBody = element('div', 'pm-guide-dialog-body');
    guideDialog.append(dialogHeading, guideBody);
    guideDialog.addEventListener('close', restoreGuideFocus);
    container.replaceChildren(heading, editor, attentionStrip, overview, recentHandoffs, completed, unobserved, guideDialog);
    let disposed = false;
    let revision = 0;
    let guideView;
    let guideService;
    let dismissedAttentionIds = new Set();
    let tasksLoaded = false;
    let taskReadFailed = false;
    let records = new Map();
    let pendingScan;
    let taskActivity;
    let unsubscribeActivity;
    let projectRevision = 0;
    const handoffLifetime = new AbortController();
    const handoffSignal = signal ? AbortSignal.any([signal, handoffLifetime.signal]) : handoffLifetime.signal;
    const handoffPortraits = new Set();
    const handoffTasks = new Map();
    const avatars = createAvatarPresentation(modelsReady, {signal, onStatus});
    const projectAvatar = projectId ? avatars.add('project', projectId) : null;
    const projectPortrait = projectId ? createSavedPortrait(projectFace, modelsReady, signal) : null;
    const guideSavedPortrait = projectId ? createSavedPortrait(guidePortrait, modelsReady, signal) : null;
    if (projectAvatar) projectContext.append(projectAvatar.node);
    const cards = new Map();
    const columns = new Map();
    const pageSize = 2;
    const orderedTaskIds = [];
    const taskIndex = new Map();
    const changedTaskIds = new Set();
    const changedColumns = new Set();
    let replaceTaskIndex = true;
    let regroupTasks = false;
    let summaryChanged = true;
    let renderFrame = null;
    const notice = element('p', 'pm-notice', 'Local records are unavailable. Use a browser with local storage support, then reopen this page.');
    notice.hidden = true;
    const definitions = [
        {id: 'working', title: 'Working'},
        {id: 'attention', title: 'Needs you'},
        {id: 'ready', title: 'Ready next'},
        {id: 'unobserved', title: 'Unobserved'},
        {id: 'completed', title: 'Completed'}
    ];
    for (const definition of definitions) {
        const column = element('section', 'pm-column');
        column.dataset.state = definition.id;
        column.hidden = true;
        const header = element('header', '');
        const count = element('p', 'pm-muted');
        const columnTitle = element('h2', '', definition.title);
        columnTitle.tabIndex = -1;
        header.append(columnTitle, count);
        const list = element('div', 'pm-task-list');
        const columnEmpty = element('p', 'pm-column-empty', 'No tasks here.');
        list.append(columnEmpty);
        column.append(header, list);
        if (definition.id === 'unobserved') {
            header.append(element('p', 'pm-muted', 'Current activity is unconfirmed. Open a task for its saved details.'));
        }
        const pagination = element('nav', 'pm-column-pagination');
        pagination.setAttribute('aria-label', `${definition.title} task pages`);
        pagination.hidden = true;
        const previous = action('Previous', previousPage, true);
        previous.setAttribute('aria-label', `Previous ${definition.title} page`);
        const indicator = element('span', 'pm-page-indicator');
        indicator.setAttribute('role', 'status');
        const next = action('Next', nextPage, true);
        next.setAttribute('aria-label', `Next ${definition.title} page`);
        pagination.append(previous, indicator, next);
        column.append(pagination);
        const group = {
            column, title: columnTitle, count, list, empty: columnEmpty, pagination, previous, indicator, next,
            taskIds: [], visibleIds: new Set(), page: 0
        };
        columns.set(definition.id, group);
        changedColumns.add(definition.id);
        const region = definition.id === 'completed' ? completed : definition.id === 'unobserved' ? unobserved : board;
        region.append(column);

        function previousPage() {
            if (group.page > 0) changePage(group.page - 1);
        }

        function nextPage() {
            if ((group.page + 1) * pageSize < group.taskIds.length) changePage(group.page + 1);
        }

        function changePage(page) {
            group.page = page;
            changedColumns.add(definition.id);
            scheduleBoard();
        }
    }
    board.append(notice);

    async function openSelectedProject() {
        if (!projectId) return;
        const currentRevision = ++projectRevision;
        try {
            const project = await pmData.getProject(projectId);
            if (disposed || signal?.aborted || projectRevision !== currentRevision) return;
            presentProject(project);
        } catch (error) {
            if (disposed || signal?.aborted || projectRevision !== currentRevision) return;
            console.error('Arcane PM selected project could not be opened.', error);
            onStatus('The selected project could not be opened. Your task details remain available.');
        }
    }

    function presentProject(project) {
        projectFace.hidden = !project;
        projectLabel.textContent = project ? project.name : 'Selected project unavailable';
        projectPortrait.update(project?.faceRef ?? null);
        guideSavedPortrait.update(project?.faceRef ?? null);
        projectAvatar.update(project);
    }

    function openLocalPreparation() {
        onNavigate('local-ai', {projectId});
    }

    function openUnobserved() {
        if (disposed || signal?.aborted || unobserved.hidden) return;
        unobserved.scrollIntoView(
            {block: 'start'}
        );
        columns.get('unobserved').title.focus(
            {preventScroll: true}
        );
    }

    function openHandoffs() {
        onNavigate('handoffs', {projectId});
    }

    async function openRecentHandoffs() {
        if (!getHandoffs) {
            handoffStatus.textContent = 'Open Handoffs to review your saved records.';
            return;
        }
        let saved = [];
        let incomplete = false;
        try {
            const {handoffs} = await getHandoffs();
            if (disposed || handoffSignal.aborted) return;
            saved = await handoffs.list({projectId: projectId || undefined, signal: handoffSignal});
        } catch (error) {
            if (disposed || handoffSignal.aborted) return;
            console.error('Arcane PM recent handoffs could not all be opened.', error);
            incomplete = true;
            saved = error.records || [];
        }
        if (disposed || handoffSignal.aborted) return;
        for (const record of saved) renderRecentHandoff(record);
        handoffStatus.textContent = incomplete
            ? 'Some saved handoffs could not be read. Open Handoffs to try again.'
            : saved.length ? '' : 'No saved handoffs yet.';
        handoffStatus.hidden = !handoffStatus.textContent;
        await Promise.all([...handoffTasks].map(openHandoffTask));
    }

    function renderRecentHandoff(record) {
        const row = element('li', 'pm-recent-handoff');
        const from = handoffTask(record.fromTaskId);
        const to = handoffTask(record.toTaskId);
        const portraits = element('div', 'pm-handoff-portraits');
        const portraitArrow = element('span', 'pm-handoff-arrow', '→');
        portraitArrow.setAttribute('aria-hidden', 'true');
        portraits.append(from.face, portraitArrow, to.face);
        const copy = element('div', 'pm-handoff-copy');
        const route = element('p', 'pm-handoff-route');
        const routeArrow = element('span', 'pm-handoff-arrow', '→');
        routeArrow.setAttribute('role', 'img');
        routeArrow.setAttribute('aria-label', 'to');
        route.append(from.name, routeArrow, to.name);
        const metadata = element('div', 'pm-handoff-metadata');
        const status = element('span', 'pm-handoff-status', record.status);
        const updated = element('time', 'pm-handoff-updated', record.updatedAt);
        updated.dateTime = record.updatedAt;
        metadata.append(status, updated);
        copy.append(route, metadata);
        const open = action('Open →', openSavedHandoff);
        open.className = 'arcane-button arcane-button--tertiary pm-handoff-open';
        open.setAttribute('aria-label', 'Open handoff');
        row.append(portraits, copy, open);
        handoffList.append(row);

        function openSavedHandoff() {
            onNavigate(
                'handoffs',
                {projectId: record.projectId, handoffId: record.id}
            );
        }
    }

    function handoffTask(id) {
        const face = element('div', 'pm-task-face pm-handoff-face', '◇');
        face.setAttribute('aria-hidden', 'true');
        const name = element('span', 'pm-handoff-title', id ? 'Opening task…' : 'Task not selected');
        if (id) {
            const portrait = createSavedPortrait(face, modelsReady, handoffSignal);
            handoffPortraits.add(portrait);
            if (!handoffTasks.has(id)) handoffTasks.set(id, []);
            handoffTasks.get(id).push({name, portrait});
        }
        return {face, name};
    }

    async function openHandoffTask([id, presentations]) {
        let task;
        try {
            task = records.get(id) || await pmData.getTask(id);
        } catch (error) {
            if (disposed || handoffSignal.aborted) return;
            console.error('Arcane PM handoff task could not be opened.', id, error);
            handoffStatus.hidden = false;
            handoffStatus.textContent = 'Some saved handoff details could not be read. Open Handoffs to try again.';
        }
        if (disposed || handoffSignal.aborted) return;
        for (const {name, portrait} of presentations) {
            name.textContent = task ? task.title : 'Task record unavailable';
            portrait.update(task?.faceRef ?? null);
        }
    }

    function openAttentionTask() {
        const task = records.get(columns.get('attention').taskIds[0]);
        if (task) onNavigate('task', {projectId: task.projectId, taskId: task.id});
    }

    function dismissAttentionStrip() {
        dismissedAttentionIds = new Set(columns.get('attention').taskIds);
        attentionStrip.hidden = true;
    }

    function isDismissedAttention(id) {
        return dismissedAttentionIds.has(id);
    }

    function openGuide() {
        if (disposed || signal?.aborted || !projectId || !guideService) return;
        try {
            if (!guideView) {
                // Keep one mounted guide so closing the dialog preserves its entered drafts.
                guideView = guideService.mountGuideView(
                    guideBody,
                    {workflows: guideService.workflows, pmData, projectId, onNavigate, onStatus, signal}
                );
            }
            guideDialog.showModal();
        } catch (error) {
            console.error('Arcane PM project guide could not be opened.', error);
            onStatus('The project guide could not be opened. Try opening it again.');
        }
    }

    function closeGuide() {
        guideDialog.close();
    }

    function restoreGuideFocus() {
        if (!disposed && !signal?.aborted && guideButton.isConnected) guideButton.focus();
    }

    function reportFailure(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM team operation failed.', error);
        onStatus('The local record could not be saved. Your entered text is still here.');
    }

    function showForm(title, save, build) {
        const form = element('form', 'pm-form arcane-card');
        form.append(element('h2', '', title));
        build(form);
        const controls = element('div', 'pm-actions');
        const submit = element('button', 'arcane-button', 'Save locally');
        submit.type = 'submit';
        controls.append(submit, action('Cancel', closeForm, true));
        form.append(controls);
        form.addEventListener('submit', submitForm);
        editor.replaceChildren(form);
        form.querySelector('input, textarea')?.focus();

        function closeForm() {
            editor.replaceChildren();
        }

        async function submitForm(event) {
            event.preventDefault();
            submit.disabled = true;
            onStatus('Saving your local record…');
            try {
                const record = await save(new FormData(form));
                if (disposed || signal?.aborted) return;
                if (editor.firstElementChild !== form) {
                    onStatus('Saved locally.');
                    return;
                }
                closeForm();
                onStatus('Saved locally.');
                if (record.name) onNavigate('team', {projectId: record.id});
            } catch (error) {
                reportFailure(error);
            } finally {
                submit.disabled = false;
            }
        }
    }

    function openProjectForm() {
        showForm('Add an existing project', saveProject, buildProjectForm);
    }

    function buildProjectForm(form) {
        field(form, 'Project name', 'name').required = true;
        field(form, 'Existing working folder', 'workFolder').required = true;
        field(form, 'Description', 'description', '', true);
        form.append(element('p', 'pm-muted', 'This saves a reference to your existing folder. Your files stay where they are.'));
    }

    function saveProject(values) {
        return pmData.createProject(
            {
                name: values.get('name'),
                workFolder: values.get('workFolder'),
                description: values.get('description')
            }
        );
    }

    function openTaskForm() {
        showForm('Add a local task', saveTask, buildTaskForm);
    }

    function buildTaskForm(form) {
        field(form, 'Task title', 'title').required = true;
        field(form, 'Assignment', 'assignment', '', true);
        form.append(element('p', 'pm-muted', 'This records preparation in Arcane PM. Sending work to Codex is a separate action.'));
    }

    function saveTask(values) {
        return pmData.createTask(
            {
                projectId: projectId || null,
                title: values.get('title'),
                assignment: values.get('assignment')
            }
        );
    }

    function renderCard(task) {
        let currentTask = task;
        const card = element('article', 'pm-task-card arcane-card');
        const face = element('div', 'pm-task-face', '◇');
        face.setAttribute('aria-hidden', 'true');
        const title = element('h3', 'pm-task-title', task.title);
        const state = element('p', 'pm-task-state');
        const description = element('p', 'pm-task-description');
        const activity = createTaskActivityPresentation();
        const avatar = avatars.add('task', task.id);
        const preparation = element('details', 'pm-task-extra');
        const preparationSummary = element('summary', '');
        preparationSummary.append(avatar.node.firstElementChild);
        preparation.append(preparationSummary, avatar.node);
        const observation = element('details', 'pm-task-extra');
        const observationSummary = element('summary', '');
        observationSummary.append(activity.node.firstElementChild);
        observation.append(observationSummary, activity.node);
        const open = action('Open task →', openTask, true);
        open.classList.add('pm-task-link');
        card.append(face, title, state, description, preparation, observation, open);
        const portrait = createSavedPortrait(face, modelsReady, signal);
        return {node: card, update, dispose};

        function openTask() {
            onNavigate('task', {projectId: currentTask.projectId, taskId: currentTask.id});
        }

        function update(nextTask) {
            currentTask = nextTask;
            const currentActivity = taskActivity?.current(nextTask.id);
            const nextState = taskStateText(nextTask, currentActivity);
            const nextDescription = nextTask.attention?.message || nextTask.nextAction || '';
            if (title.textContent !== nextTask.title) title.textContent = nextTask.title;
            if (state.textContent !== nextState) state.textContent = nextState;
            if (description.textContent !== nextDescription) description.textContent = nextDescription;
            description.hidden = !nextDescription;
            activity.update(nextTask, currentActivity);
            portrait.update(nextTask.faceRef);
            avatar.update(nextTask);
        }

        function dispose() {
            portrait.dispose();
            avatar.dispose();
        }
    }

    function retainRecord(target, id, record) {
        if (record && !record.archivedAt && (!projectId || record.projectId === projectId)) target.set(id, record);
        else target.delete(id);
    }

    function recordChanged(change) {
        if (disposed || signal?.aborted) return;
        if (projectId && change.recordType === 'project' && change.id === projectId) {
            projectRevision++;
            presentProject(change.record);
            return;
        }
        if (change.recordType !== 'task') return;
        pendingScan?.set(change.id, change.record);
        retainRecord(records, change.id, change.record);
        changedTaskIds.add(change.id);
        scheduleBoard();
    }

    function scheduleBoard() {
        if (disposed || signal?.aborted || renderFrame !== null) return;
        renderFrame = requestAnimationFrame(renderBoard);
    }

    function compareTasks(leftId, rightId) {
        const leftCreated = taskIndex.get(leftId)?.createdAt ?? records.get(leftId)?.createdAt;
        const rightCreated = taskIndex.get(rightId)?.createdAt ?? records.get(rightId)?.createdAt;
        const created = String(leftCreated).localeCompare(String(rightCreated));
        return created || leftId.localeCompare(rightId);
    }

    function insertTaskId(ids, id) {
        let lower = 0;
        let upper = ids.length;
        while (lower < upper) {
            const middle = Math.floor((lower + upper) / 2);
            if (compareTasks(ids[middle], id) < 0) lower = middle + 1;
            else upper = middle;
        }
        ids.splice(lower, 0, id);
    }

    function removeTaskId(ids, id) {
        const position = ids.indexOf(id);
        if (position !== -1) ids.splice(position, 1);
    }

    function discardCard(id) {
        const card = cards.get(id);
        if (!card) return;
        card.dispose();
        card.node.remove();
        cards.delete(id);
    }

    function updateTaskIndex(id) {
        const task = records.get(id);
        const previous = taskIndex.get(id);
        const groupId = task ? taskColumn(task, taskActivity?.current(id)) : null;
        const orderChanged = previous && previous.createdAt !== task?.createdAt;
        if (previous && (!task || orderChanged)) removeTaskId(orderedTaskIds, id);
        if (task) taskIndex.set(
            id,
            {groupId, createdAt: task.createdAt}
        );
        if (task && (!previous || orderChanged)) insertTaskId(orderedTaskIds, id);
        if (regroupTasks) {
            // A coverage-wide update rebuilds groups once after record ordering is current.
            if (!task) {
                taskIndex.delete(id);
                discardCard(id);
            }
            return;
        }
        if (previous && (!task || previous.groupId !== groupId || orderChanged)) {
            removeTaskId(columns.get(previous.groupId).taskIds, id);
            changedColumns.add(previous.groupId);
            summaryChanged = true;
        }
        if (!task) {
            taskIndex.delete(id);
            discardCard(id);
            return;
        }
        if (!previous || previous.groupId !== groupId || orderChanged) {
            insertTaskId(columns.get(groupId).taskIds, id);
            summaryChanged = true;
        }
        changedColumns.add(groupId);
    }

    function rebuildGroups() {
        taskIndex.clear();
        for (const [id, column] of columns) {
            column.taskIds.length = 0;
            changedColumns.add(id);
        }
        // The ordered index is reused when connection coverage changes for all tasks.
        for (const id of orderedTaskIds) {
            const task = records.get(id);
            const groupId = taskColumn(task, taskActivity?.current(id));
            columns.get(groupId).taskIds.push(id);
            taskIndex.set(
                id,
                {groupId, createdAt: task.createdAt}
            );
        }
        summaryChanged = true;
    }

    function renderColumn(id, column) {
        const total = column.taskIds.length;
        const pages = Math.max(1, Math.ceil(total / pageSize));
        column.page = Math.min(column.page, pages - 1);
        const start = column.page * pageSize;
        const end = Math.min(start + pageSize, total);
        const visibleIds = new Set();
        for (let index = start; index < end; index++) visibleIds.add(column.taskIds[index]);
        for (const taskId of column.visibleIds) {
            if (visibleIds.has(taskId)) continue;
            const card = cards.get(taskId);
            if (card?.node.parentElement === column.list) card.node.remove();
        }
        let position = 0;
        for (const taskId of visibleIds) {
            const task = records.get(taskId);
            let card = cards.get(taskId);
            if (!card) {
                card = renderCard(task);
                cards.set(taskId, card);
            }
            card.update(task);
            // Keep already-visible DOM and expanded disclosures in place.
            const current = column.list.children[position++];
            if (current !== card.node) column.list.insertBefore(card.node, current || null);
        }
        column.visibleIds = visibleIds;
        column.column.hidden = (id === 'completed' || id === 'unobserved') && !total;
        const countText = `${total} ${total === 1 ? 'task' : 'tasks'}`;
        const readingText = taskReadFailed ? 'Other records unavailable' : 'Opening records…';
        column.count.textContent = tasksLoaded ? countText : total ? `${countText} loaded · ${readingText}` : taskReadFailed ? 'Unavailable' : 'Opening tasks…';
        column.empty.hidden = !tasksLoaded || Boolean(total);
        column.pagination.hidden = pages === 1;
        column.previous.disabled = column.page === 0;
        column.next.disabled = column.page + 1 >= pages;
        column.indicator.textContent = total ? `${start + 1}–${end} of ${total}${tasksLoaded ? '' : ' loaded'} · Page ${column.page + 1} of ${pages}` : '';
        if (id === 'completed') completed.hidden = !total;
        if (id === 'unobserved') unobserved.hidden = !total;
    }

    function renderSummary() {
        const attentionIds = columns.get('attention').taskIds;
        const attentionCount = attentionIds.length;
        const readyCount = columns.get('ready').taskIds.length;
        const unobservedCount = columns.get('unobserved').taskIds.length;
        if (tasksLoaded) {
            attentionText.textContent = `${attentionCount} ${attentionCount === 1 ? 'task needs' : 'tasks need'} your attention.`;
            guideAttentionText.textContent = `${attentionCount} ${attentionCount === 1 ? 'task needs' : 'tasks need'} attention`;
            guideReadyText.textContent = `${readyCount} ${readyCount === 1 ? 'task' : 'tasks'} ready next`;
            guideReady.hidden = false;
            showUnobserved.textContent = `${unobservedCount} ${unobservedCount === 1 ? 'task' : 'tasks'} unobserved`;
        }
        guideUnobserved.hidden = !tasksLoaded || !unobservedCount;
        attentionStrip.hidden = !tasksLoaded || !attentionCount || (dismissedAttentionIds.size === attentionCount && attentionIds.every(isDismissedAttention));
    }

    function renderBoard() {
        renderFrame = null;
        if (disposed || signal?.aborted) return;
        if (replaceTaskIndex) {
            taskIndex.clear();
            orderedTaskIds.length = 0;
            for (const id of records.keys()) orderedTaskIds.push(id);
            orderedTaskIds.sort(compareTasks);
            for (const id of cards.keys()) {
                if (!records.has(id)) discardCard(id);
            }
            rebuildGroups();
        } else {
            for (const id of changedTaskIds) updateTaskIndex(id);
            if (regroupTasks) rebuildGroups();
        }
        replaceTaskIndex = false;
        regroupTasks = false;
        changedTaskIds.clear();
        const columnsToRender = [...changedColumns];
        changedColumns.clear();
        for (const id of columnsToRender) renderColumn(id, columns.get(id));
        if (summaryChanged) {
            summaryChanged = false;
            renderSummary();
        }
    }

    async function refresh() {
        const currentRevision = ++revision;
        taskReadFailed = false;
        const changes = new Map();
        pendingScan = changes;
        try {
            const tasks = await pmData.listTasks({projectId: projectId || undefined, archived: false, signal});
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            const next = new Map();
            for (const task of tasks) retainRecord(next, task.id, task);
            for (const [id, record] of changes) retainRecord(next, id, record);
            records = next;
            tasksLoaded = true;
            notice.hidden = true;
            replaceTaskIndex = true;
            scheduleBoard();
        } catch (error) {
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            console.error('Arcane PM task records could not be opened.', error);
            taskReadFailed = true;
            notice.hidden = false;
            for (const id of columns.keys()) changedColumns.add(id);
            scheduleBoard();
            if (!tasksLoaded) guideAttentionText.textContent = 'Task records are unavailable.';
        } finally {
            if (pendingScan === changes) pendingScan = null;
        }
    }

    function connectActivity(service) {
        if (disposed || signal?.aborted) return;
        taskActivity = service;
        unsubscribeActivity = service.subscribe(activityChanged, {signal, emitCurrent: true});
    }

    function activityChanged({taskId}) {
        if (disposed || signal?.aborted) return;
        if (taskId === null) regroupTasks = true;
        else if (records.has(taskId)) changedTaskIds.add(taskId);
        else return;
        scheduleBoard();
    }

    function activityFailed(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM current task activity is unavailable.', error);
        onStatus('Current Codex activity is unavailable. Saved task details remain available.');
    }

    function mountGuide(service) {
        if (disposed || signal?.aborted) return;
        if (projectId && service?.mountGuideView) {
            guideService = service;
            guideButton.disabled = false;
            guideAvailability.hidden = true;
        }
    }

    function guideFailed(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM project guide is unavailable.', error);
        guideAvailability.textContent = 'Project guide is unavailable. Your task details remain available.';
        guideAvailability.hidden = false;
    }

    workflowsReady?.then(mountGuide).catch(guideFailed);
    taskActivityReady?.then(connectActivity).catch(activityFailed);
    const unsubscribe = pmData.subscribe(recordChanged, {signal});
    scheduleBoard();
    refresh();
    openSelectedProject();
    openRecentHandoffs().catch(function recentHandoffsFailed(error) {
        if (disposed || handoffSignal.aborted) return;
        console.error('Arcane PM recent handoff presentation failed.', error);
        handoffStatus.hidden = false;
        handoffStatus.textContent = 'Saved handoffs could not be displayed. Open Handoffs to try again.';
    });
    function dispose() {
        disposed = true;
        if (renderFrame !== null) cancelAnimationFrame(renderFrame);
        renderFrame = null;
        handoffLifetime.abort();
        unsubscribe();
        unsubscribeActivity?.();
        avatars.dispose();
        projectPortrait?.dispose();
        guideSavedPortrait?.dispose();
        if (guideDialog.open) guideDialog.close();
        guideDialog.removeEventListener('close', restoreGuideFocus);
        guideView?.dispose();
        for (const portrait of handoffPortraits) portrait.dispose();
        handoffPortraits.clear();
        handoffTasks.clear();
        for (const card of cards.values()) card.dispose();
        cards.clear();
        orderedTaskIds.length = 0;
        taskIndex.clear();
        changedTaskIds.clear();
        changedColumns.clear();
    }
    return {refresh, dispose};
}

export function mountTaskView(container, {pmData, projectId, taskId, onNavigate, onStatus, signal, modelsReady, taskActivityReady}) {
    let disposed = false;
    let revision = 0;
    let currentTask;
    let presentation;
    let portrait;
    let taskActivity;
    let unsubscribeActivity;
    const avatars = createAvatarPresentation(modelsReady, {signal, onStatus});
    container.replaceChildren(element('p', 'pm-notice', 'Opening task…'));
    const unsubscribe = pmData.subscribe(taskChanged, {signal});
    taskActivityReady?.then(connectActivity).catch(activityFailed);
    refresh();

    function taskChanged(change) {
        if (disposed || signal?.aborted || change.recordType !== 'task' || change.id !== taskId) return;
        revision++;
        presentTask(change.record);
    }

    async function refresh() {
        const currentRevision = ++revision;
        try {
            const task = await pmData.getTask(taskId);
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            presentTask(task);
        } catch (error) {
            if (revision === currentRevision) failed(error);
        }
    }

    function presentTask(task) {
        currentTask = task;
        if (!task) {
            if (presentation) {
                presentation.notice.textContent = 'This PM record could not be found. Your entered text is still here.';
                presentation.notice.hidden = false;
                presentation.activity.update(null, null);
                presentation.avatar.update(null);
                portrait.update(null);
            } else {
                container.replaceChildren(element('h1', '', 'Task unavailable'), element('p', '', 'This PM record could not be found.'));
            }
            return;
        }
        if (!presentation) openTask(task);
        presentation.notice.hidden = true;
        const currentActivity = taskActivity?.current(taskId);
        const nextState = taskStateText(task, currentActivity);
        const nextDescription = task.attention?.message || task.nextAction || task.assignment;
        if (presentation.title.textContent !== task.title) presentation.title.textContent = task.title;
        if (presentation.state.textContent !== nextState) presentation.state.textContent = nextState;
        if (presentation.description.textContent !== nextDescription) presentation.description.textContent = nextDescription;
        presentation.description.hidden = !nextDescription;
        presentation.activity.update(task, currentActivity);
        portrait.update(task.faceRef);
        presentation.avatar.update(task);
    }

    function connectActivity(service) {
        if (disposed || signal?.aborted) return;
        taskActivity = service;
        unsubscribeActivity = service.subscribe(activityChanged, {signal, emitCurrent: true});
    }

    function activityChanged(change) {
        if (disposed || signal?.aborted || !currentTask) return;
        if (change.taskId === null || change.taskId === taskId) presentTask(currentTask);
    }

    function activityFailed(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM current task activity is unavailable.', error);
        onStatus('Current Codex activity is unavailable. Saved task details remain available.');
    }

    function openTask(task) {
        const heading = element('div', 'pm-page-heading');
        const header = element('div', 'pm-detail-header');
        const face = element('div', 'pm-task-face', '◇');
        face.setAttribute('aria-hidden', 'true');
        const summary = element('div', 'pm-task-presentation');
        const title = element('h1', '', task.title);
        const state = element('p', 'pm-task-state');
        const description = element('p', 'pm-task-description');
        const activity = createTaskActivityPresentation();
        const avatar = avatars.add('task', taskId);
        const notice = element('p', 'pm-notice');
        notice.hidden = true;
        summary.append(element('p', 'pm-eyebrow', 'Local task record'), title, state, avatar.node, activity.node, description, notice);
        header.append(face, summary);
        heading.append(header, action('Back to team', backToTeam, true));
        const form = element('form', 'pm-form arcane-card');
        field(form, 'Task title', 'title', task.title).required = true;
        field(form, 'Assignment', 'assignment', task.assignment, true);
        field(form, 'Next action', 'nextAction', task.nextAction, true);
        field(form, 'Decisions', 'decisions', task.decisions.join('\n'), true);
        field(form, 'Open questions', 'openQuestions', task.openQuestions.join('\n'), true);
        const actions = element('div', 'pm-actions');
        const save = element('button', 'arcane-button', 'Save changes');
        save.type = 'submit';
        actions.append(save, action('Prepare handoff', openHandoff, true), action('Choose task face', openFaces, true));
        if (task.origin?.url) {
            const original = element('a', 'arcane-button arcane-button--secondary', 'Original conversation');
            original.href = task.origin.url;
            actions.append(original);
        }
        form.append(actions);
        form.addEventListener('submit', saveTask);
        container.replaceChildren(heading, form);
        presentation = {title, state, description, notice, activity, avatar};
        portrait = createSavedPortrait(face, modelsReady, signal);

        async function saveTask(event) {
            event.preventDefault();
            save.disabled = true;
            onStatus('Saving task…');
            const values = new FormData(form);
            try {
                await pmData.updateTask(task.id,
                    {
                        title: values.get('title'),
                        assignment: values.get('assignment'),
                        nextAction: values.get('nextAction'),
                        decisions: values.get('decisions') === task.decisions.join('\n') ? task.decisions : [values.get('decisions')],
                        openQuestions: values.get('openQuestions') === task.openQuestions.join('\n') ? task.openQuestions : [values.get('openQuestions')]
                    }
                );
                if (!disposed && !signal?.aborted) onStatus('Task saved locally.');
            } catch (error) {
                failed(error);
            } finally {
                save.disabled = false;
            }
        }

        function openHandoff() { onNavigate('handoffs', {projectId: currentTask ? currentTask.projectId : task.projectId, taskId}); }
        function openFaces() { onNavigate('local-ai', {projectId: currentTask ? currentTask.projectId : task.projectId, taskId}); }
    }

    function backToTeam() { onNavigate('team', {projectId}); }
    function failed(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM task operation failed.', error);
        onStatus('The task could not be opened or saved. Your entered text is preserved.');
    }
    function dispose() {
        disposed = true;
        unsubscribe();
        unsubscribeActivity?.();
        avatars.dispose();
        portrait?.dispose();
    }
    return {refresh, dispose};
}
