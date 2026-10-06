/** A project guide records local plans and attributed evidence without starting external work. */
export function mountGuideView(container, {workflows, pmData, projectId, taskId, onNavigate, onStatus, signal}) {
    const lifetime = new AbortController();
    const drafts = new Map();
    const root = document.createElement('section');
    root.className = 'pm-guide';
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./guide.css', import.meta.url).href;
    const heading = element('h2', 'arcane-view-heading', 'Project guide');
    const status = element('p', 'pm-guide-status', 'Opening project workflow…');
    status.setAttribute('role', 'status');
    const refreshButton = button('Refresh', 'secondary');
    const headingRow = element('div', 'pm-guide-heading');
    headingRow.append(heading, refreshButton);
    const content = element('div', 'pm-guide-content');
    root.append(stylesheet, headingRow, status, content);
    container.append(root);
    let overview;
    let selectedTaskId = taskId || null;
    let disposed = false;
    let busy = false;
    let revision = 0;
    let guideDraft;
    let renderLifetime = new AbortController();

    function showStatus(message) {
        if (disposed) return;
        status.textContent = message;
        onStatus?.(message);
    }

    function reportFailure(error) {
        if (error?.name === 'AbortError' || disposed) return;
        console.error('Arcane PM project guide operation failed.', error);
        if (error.code === 'PM_WORKFLOW_INPUT') {
            showStatus(error.message);
        } else if (error.code === 'PM_WORKFLOW_TASK_UPDATE') {
            showStatus('The workflow entry is saved. Its task update could not be saved. Refresh and review the history before trying again.');
        } else {
            showStatus('The project guide could not complete that operation. Your entered text remains here. Try again when local storage is available.');
        }
    }

    async function refresh() {
        const currentRevision = ++revision;
        if (disposed) return;
        if (!projectId) {
            content.replaceChildren(element('p', 'arcane-state', 'Select a project to organize its work.'));
            showStatus('Choose a project in the workspace.');
            return;
        }
        showStatus('Reading project workflow…');
        try {
            const result = await workflows.getProjectOverview(projectId, {signal: lifetime.signal});
            if (disposed || currentRevision !== revision) return;
            overview = result;
            if (!selectedTaskId || !result.tasks.some(isSelectedTask)) {
                selectedTaskId = result.tasks.find(isActiveTask)?.task.id || result.tasks[0]?.task.id || null;
            }
            render();
            showStatus('Project workflow is available. Plans and observations are saved locally.');
            return true;
        } catch (error) {
            reportFailure(error);
            if (!overview && !disposed) {
                content.replaceChildren(element('p', 'arcane-state', 'Project records are unavailable. Use Refresh to read them again.'));
            }
            return false;
        }
    }

    function isSelectedTask(entry) {
        return entry.task.id === selectedTaskId;
    }

    function isActiveTask(entry) {
        return !entry.task.archivedAt;
    }

    function render() {
        renderLifetime.abort();
        renderLifetime = new AbortController();
        content.replaceChildren();
        heading.textContent = `${overview.project.name} · Project guide`;
        content.append(renderGuideAssociation());
        if (!overview.tasks.length) {
            const empty = element('div', 'arcane-state', 'This project has no tasks yet.');
            const openTeam = button('Open project team', 'secondary');
            openTeam.addEventListener('click', openProjectTeam, {signal: renderLifetime.signal});
            empty.append(openTeam);
            content.append(empty);
            return;
        }

        const selector = field('Task', 'select');
        for (const entry of overview.tasks) {
            const option = element('option', '', `${entry.task.title}${entry.task.archivedAt ? ' · Archived' : ''}`);
            option.value = entry.task.id;
            selector.control.append(option);
        }
        selector.control.value = selectedTaskId;
        selector.control.addEventListener('change', selectTask, {signal: renderLifetime.signal});
        content.append(selector.wrapper);
        const entry = overview.tasks.find(isSelectedTask);
        if (!entry) return;
        content.append(renderTask(entry));
    }

    function openProjectTeam() {
        onNavigate?.('team', {projectId});
    }

    function selectTask(event) {
        selectedTaskId = event.target.value;
        render();
    }

    function renderGuideAssociation() {
        const card = element('section', 'arcane-card pm-guide-card');
        card.append(element('h3', 'arcane-section-heading', 'This project’s guide'));
        const form = element('form', 'pm-guide-form');
        const name = field('Guide name', 'input');
        name.control.required = true;
        const task = field('Associated task', 'select');
        const local = element('option', '', 'Local project guide');
        local.value = '';
        task.control.append(local);
        for (const entry of overview.tasks) {
            const option = element('option', '', entry.task.title);
            option.value = entry.task.id;
            task.control.append(option);
        }
        if (!guideDraft) guideDraft = {name: overview.guide?.name || '', taskId: overview.guide?.taskId || ''};
        if (guideDraft.taskId && !overview.tasks.some(isAssociatedGuideTask)) {
            const missing = element('option', '', 'Associated task unavailable');
            missing.value = guideDraft.taskId;
            task.control.append(missing);
        }
        name.control.value = guideDraft.name;
        task.control.value = guideDraft.taskId;
        name.control.addEventListener('input', rememberGuideName, {signal: renderLifetime.signal});
        task.control.addEventListener('change', rememberGuideTask, {signal: renderLifetime.signal});
        const row = element('div', 'arcane-form-grid');
        row.append(name.wrapper, task.wrapper);
        const save = button('Save project guide');
        save.type = 'submit';
        form.append(row, save);
        form.addEventListener('submit', saveGuide, {signal: renderLifetime.signal});
        card.append(form);
        return card;

        function isAssociatedGuideTask(entry) {
            return entry.task.id === guideDraft.taskId;
        }

        function rememberGuideName() {
            guideDraft.name = name.control.value;
        }

        function rememberGuideTask() {
            guideDraft.taskId = task.control.value;
        }

        function saveGuide(event) {
            event.preventDefault();
            runAction(form, 'Saving this project’s guide…', persistGuide, 'Project guide saved.');
        }

        async function persistGuide() {
            return workflows.setGuide(
                projectId,
                {name: name.control.value, taskId: task.control.value || null},
                {signal: lifetime.signal}
            );
        }
    }

    function renderTask(entry) {
        const {task, workflow} = entry;
        const section = element('section', 'pm-guide-task');
        const titleRow = element('div', 'pm-guide-heading');
        const title = element('h3', 'arcane-section-heading', task.title);
        const state = element('span', 'arcane-badge', task.status);
        titleRow.append(title, state);
        section.append(titleRow);
        const links = element('div', 'pm-guide-actions');
        const open = button('Open task', 'tertiary');
        const handoff = button('Prepare a handoff', 'tertiary');
        open.addEventListener('click', openTask, {signal: renderLifetime.signal});
        handoff.addEventListener('click', openHandoffs, {signal: renderLifetime.signal});
        links.append(open, handoff);
        section.append(links);

        if (!drafts.has(task.id)) {
            drafts.set(
                task.id,
                {
                    dirty: new Set(),
                    assignment: task.assignment,
                    nextAction: task.nextAction,
                    state: 'working',
                    message: '',
                    actor: '',
                    observedAt: '',
                    source: 'local-pm',
                    sourceRef: '',
                    blockingEvidence: '',
                    observationNextAction: '',
                    attention: '',
                    attentionNextAction: '',
                    attentionActor: ''
                }
            );
        }
        const draft = drafts.get(task.id);
        if (!draft.dirty.has('assignment')) draft.assignment = task.assignment;
        if (!draft.dirty.has('nextAction')) draft.nextAction = task.nextAction;
        const work = element('div', 'pm-guide-columns');
        work.append(renderAssignment(task, draft), renderObservation(task, draft));
        section.append(work, renderAttention(task, workflow, draft), renderHistory(task, workflow));
        return section;

        function openTask() {
            onNavigate?.('task', {projectId, taskId: task.id});
        }

        function openHandoffs() {
            onNavigate?.('handoffs', {projectId, taskId: task.id});
        }
    }

    function renderAssignment(task, draft) {
        const card = element('section', 'arcane-card pm-guide-card');
        card.append(element('h4', 'arcane-section-heading', 'Assignment and next action'));
        const form = element('form', 'pm-guide-form');
        const assignment = draftField('Assignment', 'textarea', draft, 'assignment');
        const next = draftField('Next action', 'textarea', draft, 'nextAction');
        const save = button('Save plan');
        save.type = 'submit';
        form.append(assignment.wrapper, next.wrapper, save);
        form.addEventListener('submit', savePlan, {signal: renderLifetime.signal});
        card.append(form);
        return card;

        function savePlan(event) {
            event.preventDefault();
            runAction(form, 'Saving assignment and next action…', persistPlan, 'Plan saved locally. Execution state stays as observed.');
        }

        async function persistPlan() {
            const results = await Promise.allSettled(
                [
                    workflows.assign(task.id, draft.assignment, {signal: lifetime.signal}),
                    workflows.setNextAction(task.id, draft.nextAction, {signal: lifetime.signal})
                ]
            );
            const failures = results.filter(isRejected).map(reasonOf);
            if (failures.length) throw new AggregateError(failures, 'Some plan fields could not be saved.');
            draft.dirty.delete('assignment');
            draft.dirty.delete('nextAction');
        }
    }

    function renderObservation(task, draft) {
        const card = element('section', 'arcane-card pm-guide-card');
        card.append(element('h4', 'arcane-section-heading', 'Record an observation'));
        const form = element('form', 'pm-guide-form');
        const state = draftField('Observed state', 'select', draft, 'state');
        for (const value of ['idle', 'working', 'ready', 'waiting', 'stalled', 'completed']) {
            const option = element('option', '', value);
            option.value = value;
            state.control.append(option);
        }
        state.control.value = draft.state;
        const message = draftField('What was observed', 'textarea', draft, 'message');
        message.control.required = true;
        const actor = draftField('Observed by', 'input', draft, 'actor');
        actor.control.required = true;
        const observedAt = draftField('Observed at', 'input', draft, 'observedAt');
        observedAt.control.type = 'datetime-local';
        observedAt.control.required = true;
        const source = draftField('Evidence source', 'select', draft, 'source');
        const local = element('option', '', 'Local PM observation');
        local.value = 'local-pm';
        const connected = element('option', '', 'Connected-task evidence');
        connected.value = 'connected-task';
        source.control.append(local, connected);
        source.control.value = draft.source;
        const reference = draftField('Source reference', 'input', draft, 'sourceRef');
        const blocking = draftField('Concrete blocking evidence', 'textarea', draft, 'blockingEvidence');
        const next = draftField('Next action from this observation', 'textarea', draft, 'observationNextAction');
        const row = element('div', 'arcane-form-grid');
        row.append(state.wrapper, actor.wrapper, observedAt.wrapper, source.wrapper);
        form.append(row, message.wrapper, reference.wrapper, blocking.wrapper, next.wrapper);
        const save = button('Save observation');
        save.type = 'submit';
        form.append(save);
        state.control.addEventListener('change', updateEvidenceFields, {signal: renderLifetime.signal});
        source.control.addEventListener('change', updateEvidenceFields, {signal: renderLifetime.signal});
        form.addEventListener('submit', saveObservation, {signal: renderLifetime.signal});
        updateEvidenceFields();
        card.append(form);
        return card;

        function updateEvidenceFields() {
            const stalled = state.control.value === 'stalled';
            blocking.control.required = stalled;
            next.control.required = stalled;
            reference.control.required = source.control.value === 'connected-task';
        }

        function saveObservation(event) {
            event.preventDefault();
            runAction(form, 'Saving observed evidence…', persistObservation, 'Observation and task state saved.');
        }

        async function persistObservation() {
            const result = await workflows.recordObservation(
                task.id,
                {
                    state: draft.state,
                    message: draft.message,
                    actor: draft.actor,
                    observedAt: new Date(draft.observedAt).toISOString(),
                    source: draft.source,
                    sourceRef: draft.sourceRef || null,
                    blockingEvidence: draft.blockingEvidence,
                    nextAction: draft.observationNextAction
                },
                {signal: lifetime.signal}
            );
            draft.message = '';
            draft.blockingEvidence = '';
            draft.observationNextAction = '';
            return result;
        }
    }

    function renderAttention(task, workflow, draft) {
        const card = element('section', 'arcane-card pm-guide-card');
        card.append(element('h4', 'arcane-section-heading', 'Attention requests'));
        if (task.attention) {
            const current = element('div', 'pm-guide-current-attention');
            current.append(element('strong', '', 'Current task request'), element('p', 'pm-guide-verbatim', task.attention.message));
            card.append(current);
        }
        for (const entry of workflow.attentionRequests) {
            if (!entry.resolution) card.append(renderOpenAttention(task, entry.request));
        }
        const form = element('form', 'pm-guide-form');
        const message = draftField('Request attention', 'textarea', draft, 'attention');
        const next = draftField('Action needed', 'textarea', draft, 'attentionNextAction');
        const actor = draftField('Requested by', 'input', draft, 'attentionActor');
        message.control.required = true;
        next.control.required = true;
        actor.control.required = true;
        const save = button('Save attention request');
        save.type = 'submit';
        form.append(message.wrapper, next.wrapper, actor.wrapper, save);
        form.addEventListener('submit', saveRequest, {signal: renderLifetime.signal});
        card.append(form);
        return card;

        function saveRequest(event) {
            event.preventDefault();
            runAction(form, 'Saving attention request…', persistRequest, 'Attention request saved in PM.');
        }

        async function persistRequest() {
            const result = await workflows.requestAttention(
                task.id,
                {message: draft.attention, nextAction: draft.attentionNextAction, actor: draft.attentionActor},
                {signal: lifetime.signal}
            );
            draft.attention = '';
            draft.attentionNextAction = '';
            return result;
        }
    }

    function renderOpenAttention(task, request) {
        const article = element('article', 'pm-guide-attention');
        article.append(
            element('p', 'pm-guide-verbatim', request.message),
            element('p', 'arcane-help', `Requested by ${request.actor} · ${displayTime(request.requestedAt)}`),
            element('p', 'pm-guide-verbatim', request.nextAction)
        );
        const form = element('form', 'pm-guide-form');
        const key = `${task.id}:${request.id}`;
        if (!drafts.has(key)) drafts.set(key, {message: '', actor: ''});
        const draft = drafts.get(key);
        const message = draftField('Resolution', 'textarea', draft, 'message');
        const actor = draftField('Answered by', 'input', draft, 'actor');
        message.control.required = true;
        actor.control.required = true;
        const save = button('Resolve request', 'secondary');
        save.type = 'submit';
        form.append(message.wrapper, actor.wrapper, save);
        form.addEventListener('submit', resolveRequest, {signal: renderLifetime.signal});
        article.append(form);
        return article;

        function resolveRequest(event) {
            event.preventDefault();
            runAction(form, 'Saving the answer…', persistResolution, 'Resolution saved. Any newer task attention request is retained.');
        }

        async function persistResolution() {
            return workflows.resolveAttention(
                task.id,
                request.id,
                {message: draft.message, actor: draft.actor},
                {signal: lifetime.signal}
            );
        }
    }

    function renderHistory(task, workflow) {
        const section = element('section', 'pm-guide-history');
        section.append(element('h4', 'arcane-section-heading', 'Recorded history'));
        if (!workflow.history.length && !task.observedEvidence.length) {
            section.append(element('p', 'arcane-help', 'No observations have been recorded for this task.'));
        }
        for (const record of workflow.history) {
            const article = element('article', 'pm-guide-history-entry');
            const label = record.kind === 'observation'
                ? `${record.state} · ${record.source === 'connected-task' ? 'Connected-task evidence' : 'Local PM observation'}`
                : record.kind === 'attention-requested' ? 'Attention requested' : 'Attention resolved';
            article.append(
                element('h5', '', label),
                element('p', 'arcane-help', `${record.actor} · ${displayTime(record.observedAt || record.requestedAt || record.resolvedAt)}`),
                element('p', 'pm-guide-verbatim', record.message)
            );
            if (record.blockingEvidence) article.append(element('strong', '', 'Blocking evidence'), element('p', 'pm-guide-verbatim', record.blockingEvidence));
            if (record.nextAction) article.append(element('strong', '', 'Next action'), element('p', 'pm-guide-verbatim', record.nextAction));
            if (record.sourceRef) article.append(element('strong', '', 'Source reference'), element('p', 'pm-guide-verbatim', record.sourceRef));
            section.append(article);
        }
        const taskEvidence = element('details', 'pm-guide-task-evidence');
        taskEvidence.append(element('summary', '', 'Task record evidence'));
        for (const evidence of task.observedEvidence) {
            const article = element('article', 'pm-guide-history-entry');
            article.append(
                element('h5', '', 'Task record evidence'),
                element('p', 'arcane-help', displayTime(evidence.observedAt)),
                element('p', 'pm-guide-verbatim', evidence.message)
            );
            if (evidence.sourceRef) article.append(element('p', 'pm-guide-verbatim', evidence.sourceRef));
            taskEvidence.append(article);
        }
        if (task.observedEvidence.length) section.append(taskEvidence);
        return section;
    }

    async function runAction(form, pending, operation, completed) {
        if (busy || disposed) return;
        busy = true;
        const controls = [...form.querySelectorAll('input, select, textarea, button')];
        for (const control of controls) control.disabled = true;
        showStatus(pending);
        try {
            await operation();
            if (disposed) return;
            const refreshed = await refresh();
            showStatus(refreshed ? completed : `${completed} Refresh to reload the saved records.`);
        } catch (error) {
            reportFailure(error);
        } finally {
            busy = false;
            if (!disposed) {
                for (const control of controls) control.disabled = false;
            }
        }
    }

    function draftField(label, kind, draft, key) {
        const result = field(label, kind);
        result.control.value = draft[key];
        result.control.addEventListener('input', rememberField, {signal: renderLifetime.signal});
        result.control.addEventListener('change', rememberField, {signal: renderLifetime.signal});
        return result;

        function rememberField() {
            draft[key] = result.control.value;
            draft.dirty?.add(key);
        }
    }

    function refreshOnClick() {
        if (!busy) refresh();
    }

    function recordsChanged(change) {
        if (busy || disposed) return;
        if (change.projectId === projectId || change.record?.projectId === projectId || change.id === projectId) {
            showStatus('Project records changed. Refresh to read the latest saved state; entered text stays available.');
        }
    }

    const unsubscribeWorkflow = workflows.subscribe(recordsChanged, {signal: lifetime.signal});
    const unsubscribeData = pmData.subscribe(recordsChanged, {signal: lifetime.signal});
    refreshButton.addEventListener('click', refreshOnClick, {signal: lifetime.signal});
    signal?.addEventListener('abort', dispose, {once: true});
    if (signal?.aborted) dispose();
    else refresh();

    function dispose() {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        renderLifetime.abort();
        unsubscribeWorkflow();
        unsubscribeData();
        signal?.removeEventListener('abort', dispose);
        root.remove();
        drafts.clear();
    }

    return {refresh, dispose};
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function field(label, kind) {
    const wrapper = element('div', 'arcane-field');
    const control = document.createElement(kind);
    const id = `pm-guide-${crypto.randomUUID()}`;
    const caption = element('label', '', label);
    caption.htmlFor = id;
    control.id = id;
    if (kind === 'input') control.type = 'text';
    if (kind === 'textarea') control.rows = 3;
    wrapper.append(caption, control);
    return {wrapper, control};
}

function button(label, variant = 'action') {
    const control = element('button', `arcane-button arcane-button--${variant}`, label);
    control.type = 'button';
    return control;
}

function displayTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function isRejected(result) {
    return result.status === 'rejected';
}

function reasonOf(result) {
    return result.reason;
}
