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
    const faceCleanups = [];

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
        const card = element('article', 'pm-task-card arcane-card');
        const face = element('div', 'pm-task-face', '◇');
        face.setAttribute('aria-hidden', 'true');
        const title = element('h3', 'pm-task-title', task.title);
        const state = element('p', 'pm-task-state', statusText(task));
        const description = element('p', 'pm-task-description', task.attention?.message || task.nextAction || task.assignment || 'Choose the next step for this task.');
        const open = action('Open task →', openTask, true);
        open.classList.add('pm-task-link');
        card.append(face, title, state, description, open);
        modelsReady?.then(attachFace).catch(reportFaceFailure);
        return card;

        function openTask() {
            onNavigate('task', {projectId: task.projectId, taskId: task.id});
        }

        async function attachFace(models) {
            if (disposed || signal?.aborted || !face.isConnected || !task.faceRef || !models?.faces?.read) return;
            const resolved = await models.faces.read(task.faceRef, {signal});
            if (disposed || signal?.aborted || !face.isConnected) {
                return;
            }
            if (resolved?.blob) {
                const url = URL.createObjectURL(resolved.blob);
                const image = element('img', '', '');
                image.src = url;
                image.alt = '';
                face.replaceChildren(image);
                faceCleanups.push(function releaseTaskFace() { URL.revokeObjectURL(url); });
            }
        }

        function reportFaceFailure(error) {
            if (!signal?.aborted) console.error('Arcane PM task face is unavailable.', error);
        }
    }

    async function refresh() {
        const currentRevision = ++revision;
        try {
            const tasks = await pmData.listTasks({projectId: projectId || undefined, archived: false, signal});
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            for (const cleanup of faceCleanups.splice(0)) cleanup();
            board.replaceChildren();
            if (!tasks.length) {
                const empty = element('section', 'pm-empty arcane-card');
                empty.append(element('h2', '', 'Make room for your next idea'), element('p', '', 'Add an existing project and a task to begin organizing your work. You can prepare locally while your Codex connection is unavailable.'));
                board.append(empty);
                return;
            }
            const columns = [
                {id: 'working', title: 'Working'},
                {id: 'attention', title: 'Needs you'},
                {id: 'ready', title: 'Ready next'}
            ];
            if (tasks.some(isCompleted)) columns.push({id: 'completed', title: 'Completed'});
            for (const definition of columns) {
                const group = tasks.filter(function belongsInColumn(task) { return taskColumn(task) === definition.id; });
                const column = element('section', 'pm-column');
                column.dataset.state = definition.id;
                const header = element('header', '');
                header.append(element('h2', '', definition.title), element('p', 'pm-muted', `${group.length} ${group.length === 1 ? 'task' : 'tasks'}`));
                const list = element('div', 'pm-task-list');
                for (const task of group) list.append(renderCard(task));
                if (!group.length) list.append(element('p', 'pm-column-empty', 'No tasks here.'));
                column.append(header, list);
                board.append(column);
            }
        } catch (error) {
            if (disposed || signal?.aborted || revision !== currentRevision) return;
            console.error('Arcane PM task records could not be opened.', error);
            board.replaceChildren(element('p', 'pm-notice', 'Local records are unavailable. Use a browser with local storage support, then reopen this page.'));
        }
    }

    function isCompleted(task) {
        return taskColumn(task) === 'completed';
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
        for (const cleanup of faceCleanups.splice(0)) cleanup();
    }
    return {refresh, dispose};
}

export function mountTaskView(container, {pmData, projectId, taskId, onNavigate, onStatus, signal}) {
    let disposed = false;
    container.replaceChildren(element('p', 'pm-notice', 'Opening task…'));
    openTask().catch(failed);

    async function openTask() {
        const task = await pmData.getTask(taskId);
        if (disposed || signal?.aborted) return;
        if (!task) {
            container.replaceChildren(element('h1', '', 'Task unavailable'), element('p', '', 'This PM record could not be found.'));
            return;
        }
        const heading = element('div', 'pm-page-heading');
        const title = element('div', '');
        title.append(element('p', 'pm-eyebrow', 'Local task record'), element('h1', '', task.title));
        heading.append(title, action('Back to team', backToTeam, true));
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

        function openHandoff() { onNavigate('handoffs', {projectId: task.projectId, taskId}); }
        function openFaces() { onNavigate('local-ai', {projectId: task.projectId, taskId}); }
    }

    function backToTeam() { onNavigate('team', {projectId}); }
    function failed(error) {
        if (disposed || signal?.aborted) return;
        console.error('Arcane PM task operation failed.', error);
        onStatus('The task could not be opened or saved. Your entered text is preserved.');
    }
    function dispose() { disposed = true; }
    return {dispose};
}
