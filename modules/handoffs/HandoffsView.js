const STATE_LABELS = {
    preparing: 'Preparing locally',
    ready: 'Ready · not sent',
    unconfirmed: 'Delivery unconfirmed',
    accepted: 'Destination accepted',
    started: 'Receiving task started',
    completed: 'Receiving task completed'
};

export function mountHandoffsView(container, options) {
    const {handoffs, pmData, sourceLibrary, projectId, onNavigate, onStatus} = options;
    const lifetime = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
    const objectUrls = new Set();
    const root = document.createElement('section');
    root.className = 'pm-handoffs';
    root.innerHTML = `
        <link rel="stylesheet" href="${new URL('./handoffs.css', import.meta.url).href}">
        <header class="pm-handoff-heading">
            <div><h1>Handoffs</h1><p>Bring the assignment and complete original sources together.</p></div>
            <button type="button" class="arcane-button" data-action="new">New handoff</button>
        </header>
        <p class="pm-handoff-status" role="status" aria-live="polite">Opening local handoffs…</p>
        <label class="arcane-field pm-handoff-picker">Saved handoffs<select data-field="saved"><option value="">Choose a handoff</option></select></label>
        <div data-area="editor"></div>`;
    container.replaceChildren(root);
    const status = root.querySelector('[role="status"]');
    const saved = root.querySelector('[data-field="saved"]');
    const editor = root.querySelector('[data-area="editor"]');
    let tasks = [];
    let records = [];
    let selectedId = options.handoffId || null;
    let record = null;
    let busy = false;
    let dirty = false;
    let revision = 0;
    let noteRequest = null;

    function showStatus(message) {
        if (signal.aborted) return;
        status.textContent = message;
        try {
            onStatus?.(message);
        } catch (error) {
            console.error('PM handoff status observer failed.', error);
        }
    }

    function taskName(id) {
        const task = tasks.find(
            function findNamedTask(item) {
                return item.id === id;
            }
        );
        return task?.title || (id ? 'Task record unavailable' : 'Choose a task');
    }

    async function refresh() {
        const currentRevision = ++revision;
        showStatus('Opening local handoffs…');
        if (!projectId) {
            editor.textContent = 'Choose a project to prepare its handoffs.';
            saved.disabled = true;
            root.querySelector('[data-action="new"]').disabled = true;
            showStatus('Choose a project.');
            return;
        }
        try {
            const results = await Promise.all(
                [pmData.listTasks({projectId, signal}), handoffs.list({projectId, signal})]
            );
            if (signal.aborted || currentRevision !== revision) return;
            [tasks, records] = results;
            renderPicker();
            if (selectedId) record = await handoffs.get(selectedId);
            if (signal.aborted || currentRevision !== revision) return;
            renderEditor();
            showStatus(record ? STATE_LABELS[record.status] : 'Prepare locally. Sending is a separate action.');
        } catch (error) {
            reportFailure(error, 'Saved handoffs could not be opened. Your records remain in local storage; try opening this page again.');
        }
    }

    function renderPicker() {
        saved.replaceChildren(new Option('New handoff', ''));
        for (const item of records) {
            const label = `${taskName(item.fromTaskId)} → ${taskName(item.toTaskId)} · ${STATE_LABELS[item.status] || item.status}`;
            saved.append(new Option(label, item.id));
        }
        saved.value = selectedId || '';
    }

    function renderEditor() {
        const editable = !record || ['preparing', 'ready'].includes(record.status);
        dirty = false;
        editor.innerHTML = `
            <form class="pm-handoff-layout">
                <section class="arcane-card pm-handoff-fields">
                    <h2>${record ? 'Assignment and context' : 'Prepare a handoff'}</h2>
                    <div class="pm-handoff-task-pair">
                        <label class="arcane-field">From task<select name="fromTaskId"></select></label>
                        <label class="arcane-field">Receiving task<select name="toTaskId"></select></label>
                    </div>
                    <label class="arcane-field">Assignment<textarea name="assignment" rows="4" required></textarea></label>
                    <label class="arcane-field">Decisions already made<textarea name="decisions" rows="3"></textarea></label>
                    <label class="arcane-field">Open questions<textarea name="openQuestions" rows="3"></textarea></label>
                    <label class="arcane-field">A note for the next task<textarea name="preparedNote" rows="5"></textarea></label>
                    <div class="pm-handoff-actions">
                        <button type="submit" class="arcane-button">Save draft</button>
                        <button type="button" class="arcane-button arcane-button--secondary" data-action="note">Prepare note locally</button>
                        <button type="button" class="arcane-button arcane-button--secondary" data-action="cancel-note" hidden>Stop preparation</button>
                    </div>
                </section>
                <aside class="arcane-card pm-handoff-review">
                    <h2>Carry the originals forward</h2>
                    <p data-value="state"></p>
                    <div class="pm-handoff-actions">
                        <button type="button" class="arcane-button arcane-button--secondary" data-action="sources">Choose sources</button>
                        <button type="button" class="arcane-button arcane-button--secondary" data-action="include">Include selected sources</button>
                    </div>
                    <div data-area="originals"></div>
                    <div class="pm-handoff-actions">
                        <button type="button" class="arcane-button" data-action="ready">Mark ready</button>
                        <button type="button" class="arcane-button" data-action="send">Send handoff</button>
                        <button type="button" class="arcane-button arcane-button--secondary" data-action="reopen">Reopen as draft</button>
                    </div>
                    <p data-value="delivery"></p>
                    <div data-area="attempts"></div>
                </aside>
            </form>
            <section class="arcane-card pm-handoff-progress" data-area="progress" hidden>
                <h2>Receiving-task progress</h2>
                <p>Record a result you observed in the receiving task.</p>
                <form data-form="progress">
                    <label class="arcane-field">Observed state<select name="state"><option value="started">Started</option><option value="completed">Completed</option></select></label>
                    <label class="arcane-field">Complete observation<textarea name="message" rows="3" required></textarea></label>
                    <label class="arcane-field">Observed by<input name="actor" required></label>
                    <button type="submit" class="arcane-button arcane-button--secondary">Record observation</button>
                </form>
                <div data-area="observations"></div>
            </section>`;
        const form = editor.querySelector('form');
        for (const name of ['fromTaskId', 'toTaskId']) {
            const select = form.elements[name];
            select.append(new Option(name === 'fromTaskId' ? 'No source task selected' : 'Choose receiving task', ''));
            for (const task of tasks) select.append(new Option(task.title, task.id));
            select.value = record?.[name] || (name === 'fromTaskId' ? options.taskId || '' : '');
        }
        for (const name of ['assignment', 'decisions', 'openQuestions', 'preparedNote']) {
            form.elements[name].value = record?.[name] ?? '';
        }
        for (const control of form.elements) {
            if (control.name) control.disabled = !editable;
        }
        form.querySelector('[type="submit"]').disabled = !editable;
        for (const action of ['note', 'include', 'ready']) {
            form.querySelector(`[data-action="${action}"]`).disabled = !editable;
        }
        form.querySelector('[data-action="include"]').disabled = !editable || !sourceLibrary;
        form.querySelector('[data-action="reopen"]').hidden = !record || editable;
        form.querySelector('[data-action="send"]').disabled = true;
        form.querySelector('[data-value="state"]').textContent = record ? STATE_LABELS[record.status] : 'Preparing locally';
        renderOriginals();
        renderAttempts();
        renderProgress();
        observeDeliveryAvailability();
    }

    function renderOriginals() {
        const list = editor.querySelector('[data-area="originals"]');
        if (!record?.originals.length) {
            list.textContent = 'No original sources included yet.';
            return;
        }
        for (const original of record.originals) {
            const details = document.createElement('details');
            details.className = 'pm-handoff-original';
            const summary = document.createElement('summary');
            summary.textContent = original.source.title || original.source.id;
            const location = document.createElement('p');
            location.textContent = `${original.availability} · ${original.freshness}${original.source.location ? ` · ${original.source.location}` : ''}`;
            details.append(summary, location);
            if (typeof original.content === 'string') {
                const content = document.createElement('pre');
                content.textContent = original.content;
                details.append(content);
            }
            if (original.originalFileRef) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'arcane-button arcane-button--secondary';
                button.textContent = 'Open retained file';
                button.dataset.action = 'file';
                button.dataset.sourceId = original.source.id;
                details.append(button);
            }
            list.append(details);
        }
        if (!record.selectionPrepared) {
            const message = document.createElement('p');
            message.textContent = 'Some selected originals are unavailable. Reopen Sources and prepare the complete selection.';
            list.append(message);
        }
    }

    function renderAttempts() {
        const list = editor.querySelector('[data-area="attempts"]');
        for (const attempt of record?.attempts || []) {
            const paragraph = document.createElement('p');
            paragraph.className = 'pm-handoff-preserve-text';
            paragraph.textContent = `${attempt.requestedAt} · ${attempt.status}\n${attempt.message}`;
            list.append(paragraph);
        }
    }

    function renderProgress() {
        if (!record || !['accepted', 'started', 'completed'].includes(record.status)) return;
        const section = editor.querySelector('[data-area="progress"]');
        section.hidden = false;
        const list = section.querySelector('[data-area="observations"]');
        for (const observation of record.observations) {
            const paragraph = document.createElement('p');
            paragraph.className = 'pm-handoff-preserve-text';
            paragraph.textContent = `${observation.state} · ${observation.actor} · ${observation.observedAt}\n${observation.message}`;
            list.append(paragraph);
        }
    }

    async function observeDeliveryAvailability() {
        const currentId = record?.id;
        const currentRevision = revision;
        const message = editor.querySelector('[data-value="delivery"]');
        if (!currentId) {
            message.textContent = 'Save the draft to retain it on this computer.';
            return;
        }
        try {
            const availability = await handoffs.deliveryAvailability(currentId);
            if (signal.aborted || record?.id !== currentId || currentRevision !== revision) return;
            message.textContent = availability.message;
            editor.querySelector('[data-action="send"]').disabled = busy || dirty || record.status !== 'ready' || !availability.available;
        } catch (error) {
            reportFailure(error, 'Delivery availability could not be read. Your local handoff remains available.');
        }
    }

    async function saveDraft() {
        const form = editor.querySelector('form');
        const changes = {
            fromTaskId: form.elements.fromTaskId.value || null,
            toTaskId: form.elements.toTaskId.value || null,
            assignment: form.elements.assignment.value,
            decisions: form.elements.decisions.value,
            openQuestions: form.elements.openQuestions.value,
            preparedNote: form.elements.preparedNote.value
        };
        record = record
            ? await handoffs.updateDraft(record.id, changes)
            : await handoffs.createDraft({...changes, projectId});
        selectedId = record.id;
        dirty = false;
        return record;
    }

    async function runAction(action, target) {
        if (busy) return;
        busy = true;
        const controls = [...root.querySelectorAll('button, select, input, textarea')];
        const disabled = controls.map(
            function priorDisabledState(control) {
                return control.disabled;
            }
        );
        controls.forEach(
            function disableDuringAction(control) {
                control.disabled = true;
            }
        );
        showStatus(action === 'note' ? 'Thinking' : 'Saving your preparation…');
        let rerender = true;
        try {
            if (action === 'save') {
                await saveDraft();
            } else if (action === 'include') {
                await saveDraft();
                const selection = await sourceLibrary.getSelection({signal});
                record = await handoffs.prepare(record.id, {selection, signal});
            } else if (action === 'ready') {
                await saveDraft();
                record = await handoffs.markReady(record.id);
            } else if (action === 'send') {
                if (dirty) {
                    showStatus('Save the current edits and mark the handoff ready before sending.');
                    return;
                }
                showStatus('Sending the prepared handoff…');
                record = await handoffs.deliver(record.id, {signal});
            } else if (action === 'reopen') {
                record = await handoffs.reopen(record.id);
                selectedId = record.id;
            } else if (action === 'note') {
                await saveDraft();
                const field = editor.querySelector('[name="preparedNote"]');
                const priorNote = field.value;
                noteRequest = new AbortController();
                const noteSignal = AbortSignal.any([signal, noteRequest.signal]);
                const cancel = editor.querySelector('[data-action="cancel-note"]');
                cancel.hidden = false;
                cancel.disabled = false;
                let streamed = '';
                try {
                    const result = await handoffs.prepareNote(
                        record.id,
                        {
                            signal: noteSignal,
                            onChunk: function renderRealNoteChunk(chunk) {
                                if (noteSignal.aborted) return;
                                streamed += chunk;
                                field.value = streamed;
                                showStatus('Preparing your note…');
                            }
                        }
                    );
                    const content = result.content ?? streamed;
                    if (result.status === 'unavailable') {
                        field.value = priorNote;
                        showStatus(result.message);
                    } else if (!content.trim()) {
                        field.value = priorNote;
                        showStatus('The model returned no note. Your previous note is preserved.');
                    } else {
                        field.value = content;
                        dirty = true;
                        showStatus('Note prepared. Save the draft to keep it.');
                    }
                } catch (error) {
                    field.value = priorNote;
                    throw error;
                } finally {
                    noteRequest = null;
                    cancel.hidden = true;
                }
                rerender = false;
            } else if (action === 'file') {
                const original = await handoffs.readOriginal(record.id, target.dataset.sourceId);
                signal.throwIfAborted();
                const url = URL.createObjectURL(original.originalFile);
                objectUrls.add(url);
                const link = document.createElement('a');
                link.href = url;
                link.download = original.originalFile.name;
                link.className = 'arcane-button arcane-button--secondary';
                link.textContent = `Download ${original.originalFile.name}`;
                target.replaceWith(link);
                showStatus('The complete retained file is ready to download.');
                rerender = false;
            } else if (action === 'sources') {
                if (!record || dirty) await saveDraft();
                onNavigate?.('sources', {projectId, handoffId: record?.id});
                rerender = false;
            } else if (action === 'new' || action === 'select') {
                if (dirty) await saveDraft();
                selectedId = action === 'new' ? null : target;
                record = null;
            } else if (action === 'progress') {
                const form = editor.querySelector('[data-form="progress"]');
                record = await handoffs.recordProgress(
                    record.id,
                    {
                        state: form.elements.state.value,
                        message: form.elements.message.value,
                        actor: form.elements.actor.value,
                        observedAt: new Date().toISOString()
                    }
                );
            }
            if (signal.aborted) return;
            if (rerender) await refresh();
        } catch (error) {
            reportFailure(error, 'This step could not finish. Your saved handoff and current form text remain available; review the selection and try again.');
        } finally {
            busy = false;
            controls.forEach(
                function restoreActionControl(control, index) {
                    if (control.isConnected) control.disabled = disabled[index];
                }
            );
            if (!signal.aborted && rerender) observeDeliveryAvailability();
        }
    }

    function reportFailure(error, message) {
        if (signal.aborted) return;
        if (error?.name === 'AbortError') {
            showStatus('Preparation stopped. The saved handoff is preserved.');
            return;
        }
        console.error('Arcane PM handoff operation failed.', error);
        if (error.handoffOutcome?.status === 'accepted') {
            showStatus('Codex accepted the handoff, and saving its delivery record failed. Check the receiving task before another send.');
            return;
        }
        showStatus(error?.code === 'PM_HANDOFF_INPUT' ? error.message : message);
    }

    function handleClick(event) {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        if (action === 'cancel-note') {
            noteRequest?.abort();
            return;
        }
        if (busy) return;
        runAction(action, button);
    }

    function handleSubmit(event) {
        event.preventDefault();
        runAction(event.target.dataset.form === 'progress' ? 'progress' : 'save');
    }

    function handleSelectedHandoff() {
        runAction('select', saved.value || null);
    }

    function markDraftChanged(event) {
        if (!event.target.name || event.target.form?.dataset.form === 'progress') return;
        dirty = true;
        editor.querySelector('[data-action="send"]').disabled = true;
        showStatus('Unsaved changes. Save the draft to retain them locally.');
    }

    function dispose() {
        lifetime.abort();
        noteRequest?.abort();
        for (const url of objectUrls) URL.revokeObjectURL(url);
        objectUrls.clear();
        root.remove();
    }

    root.addEventListener('click', handleClick, {signal});
    editor.addEventListener('submit', handleSubmit, {signal});
    editor.addEventListener('input', markDraftChanged, {signal});
    saved.addEventListener('change', handleSelectedHandoff, {signal});
    signal.addEventListener('abort', dispose, {once: true});
    if (signal.aborted) dispose();
    else refresh();
    return {refresh, dispose};
}
