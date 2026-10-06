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

function taskColumn(task) {
    if (task.attention || ['blocked', 'attention', 'needs-input', 'waiting-for-input', 'waiting', 'stalled'].includes(task.status)) return 'attention';
    if (['working', 'running', 'in-progress', 'preparing'].includes(task.status)) return 'working';
    if (['completed', 'complete', 'done'].includes(task.status)) return 'completed';
    return 'ready';
}

function statusText(task) {
    if (task.attention) return 'Needs your input';
    return task.status === 'idle' ? 'Ready for an assignment' : task.status.replaceAll('-', ' ');
}

function createTaskPortrait(face, modelsReady, signal) {
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
            if (!disposed && !reading.signal.aborted) console.error('Arcane PM task face is unavailable.', error);
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
    const {pmData, projectId, onNavigate, onStatus, signal, modelsReady, workflowsReady} = options;
    const heading = element('div', 'pm-page-heading');
    const titleBlock = element('div', '');
    titleBlock.append(element('p', 'pm-eyebrow', 'Your workspace'), element('h1', '', 'Your project team'), element('p', '', 'A familiar face for every task.'));
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
        const open = action('Open task →', openTask, true);
        open.classList.add('pm-task-link');
        card.append(face, title, state, description, open);
        const portrait = createTaskPortrait(face, modelsReady, signal);
        return {node: card, update, dispose: portrait.dispose};

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
            portrait.update(nextTask.faceRef);
        }
    }

    async function refresh() {
        const currentRevision = ++revision;
        try {
            const tasks = await pmData.listTasks({projectId: projectId || undefined, archived: false, signal});
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            notice.hidden = true;
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
                if (!card) {
                    card = renderCard(task);
                    cards.set(task.id, card);
                }
                card.update(task);
                const column = columns.get(taskColumn(task));
                if (card.node.parentElement !== column.list) column.list.insertBefore(card.node, column.empty);
            }
            for (const [id, column] of columns) {
                const group = tasks.filter(function belongsInColumn(task) { return taskColumn(task) === id; });
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
        } catch (error) {
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            console.error('Arcane PM task records could not be opened.', error);
            notice.hidden = false;
        }
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
    const unsubscribe = pmData.subscribe(refresh, {signal});
    refresh();
    function dispose() {
        disposed = true;
        unsubscribe();
        guideView?.dispose();
        for (const card of cards.values()) card.dispose();
        cards.clear();
    }
    return {refresh, dispose};
}

export function mountTaskView(container, {pmData, projectId, taskId, onNavigate, onStatus, signal, modelsReady}) {
    let disposed = false;
    let revision = 0;
    let currentTask;
    let presentation;
    let portrait;
    container.replaceChildren(element('p', 'pm-notice', 'Opening task…'));
    const unsubscribe = pmData.subscribe(taskChanged, {signal});
    refresh();

    function taskChanged(change) {
        if (change.recordType === 'task' && change.id === taskId) refresh();
    }

    async function refresh() {
        const currentRevision = ++revision;
        try {
            const task = await pmData.getTask(taskId);
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            if (!task) {
                if (presentation) {
                    presentation.notice.textContent = 'This PM record could not be found. Your entered text is still here.';
                    presentation.notice.hidden = false;
                    portrait.update(null);
                } else {
                    container.replaceChildren(element('h1', '', 'Task unavailable'), element('p', '', 'This PM record could not be found.'));
                }
                return;
            }
            currentTask = task;
            if (!presentation) openTask(task);
            presentation.notice.hidden = true;
            const nextState = statusText(task);
            const nextDescription = task.attention?.message || task.nextAction || task.assignment;
            if (presentation.title.textContent !== task.title) presentation.title.textContent = task.title;
            if (presentation.state.textContent !== nextState) presentation.state.textContent = nextState;
            if (presentation.description.textContent !== nextDescription) presentation.description.textContent = nextDescription;
            presentation.description.hidden = !nextDescription;
            portrait.update(task.faceRef);
        } catch (error) {
            if (revision === currentRevision) failed(error);
        }
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
        const notice = element('p', 'pm-notice');
        notice.hidden = true;
        summary.append(element('p', 'pm-eyebrow', 'Local task record'), title, state, description, notice);
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
        presentation = {title, state, description, notice};
        portrait = createTaskPortrait(face, modelsReady, signal);

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

        function openHandoff() { onNavigate('handoffs', {projectId: currentTask.projectId, taskId}); }
        function openFaces() { onNavigate('local-ai', {projectId: currentTask.projectId, taskId}); }
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
        portrait?.dispose();
    }
    return {refresh, dispose};
}
