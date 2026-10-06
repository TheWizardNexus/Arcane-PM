function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
    if (['working', 'running', 'in-progress', 'preparing'].includes(task.status)) return 'working';
    if (['completed', 'complete', 'done'].includes(task.status)) return 'completed';
    return 'ready';
}

function statusText(task) {
    const status = task.status === 'idle' ? 'Ready for an assignment' : task.status.replaceAll('-', ' ');
    return `PM status: ${status}${task.attention ? ' · Needs your input' : ''}`;
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

function createTaskActivityPresentation() {
    const node = element('section', 'pm-task-activity');
    const heading = element('strong', '');
    const currentState = element('p', 'pm-muted');
    const message = element('p', '');
    const timestamp = element('time', '');
    const lastHeading = element('strong', '');
    const lastMessage = element('p', '');
    const lastTimestamp = element('time', '');
    node.append(heading, currentState, message, timestamp, lastHeading, lastMessage, lastTimestamp);
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
    const {pmData, projectId, onNavigate, onStatus, signal, modelsReady, workflowsReady, taskActivityReady} = options;
    const heading = element('div', 'pm-page-heading');
    const titleBlock = element('div', 'pm-detail-header');
    const projectFace = element('div', 'pm-task-face pm-project-avatar', '◇');
    projectFace.setAttribute('aria-hidden', 'true');
    projectFace.hidden = true;
    const titleCopy = element('div', 'pm-task-presentation');
    const projectLabel = element('p', 'pm-eyebrow', 'Your workspace');
    titleCopy.append(projectLabel, element('h1', '', 'Your project team'), element('p', '', 'A familiar face for every task.'));
    titleBlock.append(projectFace, titleCopy);
    const actions = element('div', 'pm-actions');
    actions.append(action('Add existing project', openProjectForm, true), action('Add a task', openTaskForm));
    heading.append(titleBlock, actions);
    const editor = element('section', 'pm-editor');
    const overview = element('div', 'pm-team-layout');
    const board = element('div', 'pm-board');
    const guide = element('aside', 'pm-team-guide arcane-card');
    const guideImage = element('img', 'pm-guide-face');
    guideImage.src = './assets/project-guide.png';
    guideImage.alt = '';
    guide.append(element('h2', '', 'Project guide'), guideImage, element('p', '', 'Keep assignments, decisions and the next step together.'), action('Prepare locally', openLocalPreparation, true));
    overview.append(board, guide);
    container.replaceChildren(heading, editor, overview);
    let disposed = false;
    let revision = 0;
    let guideView;
    let records = new Map();
    let pendingScan;
    let taskActivity;
    let unsubscribeActivity;
    let projectRevision = 0;
    const avatars = createAvatarPresentation(modelsReady, {signal, onStatus});
    const projectAvatar = projectId ? avatars.add('project', projectId) : null;
    const projectPortrait = projectId ? createSavedPortrait(projectFace, modelsReady, signal) : null;
    if (projectAvatar) titleCopy.append(projectAvatar.node);
    const cards = new Map();
    const columns = new Map();
    const empty = element('section', 'pm-empty arcane-card');
    empty.append(element('h2', '', 'Make room for your next idea'), element('p', '', 'Add an existing project and a task to begin organizing your work. You can prepare locally while your Codex connection is unavailable.'));
    empty.hidden = true;
    const notice = element('p', 'pm-notice', 'Local records are unavailable. Use a browser with local storage support, then reopen this page.');
    notice.hidden = true;
    const definitions = [
        {id: 'working', title: 'Working'},
        {id: 'attention', title: 'Needs you'},
        {id: 'ready', title: 'Ready next'},
        {id: 'completed', title: 'Completed'}
    ];
    for (const definition of definitions) {
        const column = element('section', 'pm-column');
        column.dataset.state = definition.id;
        column.hidden = true;
        const header = element('header', '');
        const count = element('p', 'pm-muted');
        header.append(element('h2', '', definition.title), count);
        const list = element('div', 'pm-task-list');
        const columnEmpty = element('p', 'pm-column-empty', 'No tasks here.');
        list.append(columnEmpty);
        column.append(header, list);
        columns.set(definition.id, {column, count, list, empty: columnEmpty});
        board.append(column);
    }
    board.append(empty, notice);

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
        projectAvatar.update(project);
    }

    function openLocalPreparation() {
        onNavigate('local-ai', {projectId});
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
        const state = element('p', 'pm-task-state', statusText(task));
        const description = element('p', 'pm-task-description', task.attention?.message || task.nextAction || task.assignment || 'Choose the next step for this task.');
        const activity = createTaskActivityPresentation();
        const avatar = avatars.add('task', task.id);
        const open = action('Open task →', openTask, true);
        open.classList.add('pm-task-link');
        card.append(face, title, state, avatar.node, activity.node, description, open);
        const portrait = createSavedPortrait(face, modelsReady, signal);
        return {node: card, update, dispose};

        function openTask() {
            onNavigate('task', {projectId: currentTask.projectId, taskId: currentTask.id});
        }

        function update(nextTask) {
            currentTask = nextTask;
            const nextState = statusText(nextTask);
            const nextDescription = nextTask.attention?.message || nextTask.nextAction || nextTask.assignment || 'Choose the next step for this task.';
            if (title.textContent !== nextTask.title) title.textContent = nextTask.title;
            if (state.textContent !== nextState) state.textContent = nextState;
            if (description.textContent !== nextDescription) description.textContent = nextDescription;
            activity.update(nextTask, taskActivity?.current(nextTask.id));
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
        renderBoard(change.id);
    }

    function renderBoard(changedTaskId = null) {
        if (disposed || signal?.aborted) return;
        const tasks = [...records.values()].sort(function orderTasks(left, right) {
            const created = String(left.createdAt).localeCompare(String(right.createdAt));
            return created || left.id.localeCompare(right.id);
        });
        empty.hidden = Boolean(tasks.length);
        const taskIds = new Set();
        for (const task of tasks) taskIds.add(task.id);
        for (const [id, card] of cards) {
            if (taskIds.has(id)) continue;
            card.dispose();
            card.node.remove();
            cards.delete(id);
        }
        for (const task of tasks) {
            let card = cards.get(task.id);
            const created = !card;
            if (created) {
                card = renderCard(task);
                cards.set(task.id, card);
            }
            if (created || changedTaskId === null || changedTaskId === task.id) card.update(task);
            const column = columns.get(taskColumn(task, taskActivity?.current(task.id)));
            if (card.node.parentElement !== column.list) column.list.insertBefore(card.node, column.empty);
        }
        for (const [id, column] of columns) {
            const group = tasks.filter(function belongsInColumn(task) { return taskColumn(task, taskActivity?.current(task.id)) === id; });
            column.column.hidden = !tasks.length || (id === 'completed' && !group.length);
            column.count.textContent = `${group.length} ${group.length === 1 ? 'task' : 'tasks'}`;
            column.empty.hidden = Boolean(group.length);
            for (const [index, task] of group.entries()) {
                const card = cards.get(task.id);
                // Stable task ordering leaves unchanged cards and their focused controls in place.
                const position = column.list.children[index];
                if (position !== card.node) column.list.insertBefore(card.node, position || null);
            }
        }
    }

    async function refresh() {
        const currentRevision = ++revision;
        const changes = new Map();
        pendingScan = changes;
        try {
            const tasks = await pmData.listTasks({projectId: projectId || undefined, archived: false, signal});
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            const next = new Map();
            for (const task of tasks) retainRecord(next, task.id, task);
            for (const [id, record] of changes) retainRecord(next, id, record);
            records = next;
            notice.hidden = true;
            renderBoard();
        } catch (error) {
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            console.error('Arcane PM task records could not be opened.', error);
            notice.hidden = false;
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
        if (taskId === null || records.has(taskId)) renderBoard(taskId);
    }

    function activityFailed(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM current task activity is unavailable.', error);
        onStatus('Current Codex activity is unavailable. Saved task details remain available.');
    }

    function mountGuide(service) {
        if (disposed || signal?.aborted) return;
        if (projectId && service?.mountGuideView) {
            guide.replaceChildren();
            guide.className = 'pm-guide-region';
            guideView = service.mountGuideView(guide, {workflows: service.workflows, pmData, projectId, onNavigate, onStatus, signal});
        }
    }

    function guideFailed(error) {
        if (!signal?.aborted) console.error('Arcane PM project guide is unavailable.', error);
    }

    workflowsReady?.then(mountGuide).catch(guideFailed);
    taskActivityReady?.then(connectActivity).catch(activityFailed);
    const unsubscribe = pmData.subscribe(recordChanged, {signal});
    refresh();
    openSelectedProject();
    function dispose() {
        disposed = true;
        unsubscribe();
        unsubscribeActivity?.();
        avatars.dispose();
        projectPortrait?.dispose();
        guideView?.dispose();
        for (const card of cards.values()) card.dispose();
        cards.clear();
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
        const nextState = statusText(task);
        const nextDescription = task.attention?.message || task.nextAction || task.assignment;
        if (presentation.title.textContent !== task.title) presentation.title.textContent = task.title;
        if (presentation.state.textContent !== nextState) presentation.state.textContent = nextState;
        if (presentation.description.textContent !== nextDescription) presentation.description.textContent = nextDescription;
        presentation.description.hidden = !nextDescription;
        presentation.activity.update(task, taskActivity?.current(taskId));
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
