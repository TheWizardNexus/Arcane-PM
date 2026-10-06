/** PM preparation and deliberate task-face selection, using injected domain owners. */
export function mountLocalAIView(container, {
    localAI, faces, modelServices, pmData, projectId = null, taskId = null,
    onNavigate, onStatus, signal
} = {}) {
    const page = new AbortController();
    const pageSignal = signal ? AbortSignal.any([signal, page.signal]) : page.signal;
    const subscriptions = [];
    const previews = new Map();
    const candidates = new Map();
    const root = document.createElement('section');
    root.className = 'pm-local-ai';
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./view.css', import.meta.url).href;
    root.append(stylesheet);
    const content = document.createElement('div');
    content.innerHTML = `
        <header class="pm-page-heading">
            <div><p class="pm-eyebrow">Local preparation</p><h1>Prepare the next step</h1>
            <p>Work on a note and choose a familiar face for your task.</p></div>
        </header>
        <div class="pm-ai-task-row">
            <label class="arcane-field"><span class="arcane-field__label">Task</span>
                <select data-control="task"><option value="">Loading tasks…</option></select></label>
            <button type="button" class="arcane-button arcane-button--secondary" data-control="open-task">Open task</button>
            <p class="pm-ai-status" data-control="task-status" role="status"></p>
        </div>
        <div class="pm-ai-layout">
            <section class="pm-panel pm-ai-preparation">
                <h2>Preparation note</h2>
                <form data-control="prepare-form">
                    <label class="arcane-field"><span class="arcane-field__label">What would you like help preparing?</span>
                        <textarea data-control="prompt" rows="5" placeholder="Describe the next step you want to prepare."></textarea></label>
                    <div class="pm-actions">
                        <button class="arcane-button" data-control="prepare">Prepare with model</button>
                        <button type="button" class="arcane-button arcane-button--secondary" data-control="cancel-prepare" disabled>Cancel</button>
                    </div>
                </form>
                <p class="pm-ai-status" role="status" aria-live="polite" data-control="prepare-status">Write a note below, or select a model to help.</p>
                <div data-control="response-region" hidden>
                    <h3>Model response</h3>
                    <pre data-control="response"></pre>
                    <button type="button" class="arcane-button arcane-button--secondary" data-control="use-response" disabled>Use response in note</button>
                </div>
                <div data-control="tool-results" class="pm-ai-tool-results"></div>
                <label class="arcane-field"><span class="arcane-field__label">Your note</span>
                    <textarea data-control="note" rows="12" placeholder="You can write here while models are unavailable."></textarea></label>
                <div class="pm-actions">
                    <button type="button" class="arcane-button arcane-button--secondary" data-control="copy-note">Copy note</button>
                    <button type="button" class="arcane-button" data-control="save-note" hidden>Save note</button>
                </div>
                <p class="pm-ai-hint" data-control="note-hint">This note is temporary until you copy or save it. Each model request uses only the message above.</p>
                <div data-control="saved-notes-region" hidden>
                    <label class="arcane-field"><span class="arcane-field__label">Saved notes for this task</span><select data-control="saved-notes"><option value="">No saved notes</option></select></label>
                    <pre data-control="saved-note" hidden></pre>
                    <button type="button" class="arcane-button arcane-button--secondary" data-control="use-saved-note" disabled>Use saved note</button>
                    <p class="pm-ai-status" role="status" data-control="notes-status"></p>
                </div>
            </section>
            <section class="pm-panel pm-ai-models">
                <h2>Text model</h2>
                <p class="pm-ai-status" role="status" data-control="model-status">No model selected.</p>
                <form data-control="model-form">
                    <label class="arcane-field"><span class="arcane-field__label">Run with</span>
                        <select data-control="provider-mode">
                            <option value="local">Available local model</option>
                            <option value="browser">Custom browser CPU model</option>
                            <option value="remote">DigitalOcean serverless · remote</option>
                        </select></label>
                    <label class="arcane-field" data-control="local-fields"><span class="arcane-field__label">Local model</span>
                        <select data-control="local-model"><option value="">No local models available</option></select></label>
                    <div data-control="browser-fields" hidden>
                        <label class="arcane-field"><span class="arcane-field__label">Model ID</span><input data-control="browser-model" autocomplete="off"></label>
                        <label class="arcane-field"><span class="arcane-field__label">Original model file URLs, one per line</span><textarea data-control="browser-files" rows="3" spellcheck="false"></textarea></label>
                        <p class="pm-ai-hint">Load selected model downloads these complete files when needed and stores them in this app for reuse.</p>
                    </div>
                    <div data-control="remote-fields" hidden>
                        <label class="arcane-field"><span class="arcane-field__label">Remote model ID</span><input data-control="remote-model" autocomplete="off"></label>
                        <label class="arcane-field"><span class="arcane-field__label">TWiN access key</span><input data-control="remote-key" type="password" autocomplete="off"></label>
                        <p class="pm-ai-hint">Preparation requests use the selected DigitalOcean service. Your key stays in this session.</p>
                    </div>
                    <button class="arcane-button arcane-button--secondary" data-control="select-model">Select model</button>
                </form>
                <div class="pm-actions">
                    <button type="button" class="arcane-button" data-control="load-model" disabled>Load selected model</button>
                    <button type="button" class="arcane-button arcane-button--secondary" data-control="unload-model" disabled>Unload</button>
                    <button type="button" class="arcane-button arcane-button--tertiary" data-control="refresh-models">Refresh models</button>
                </div>
                <p class="pm-ai-hint" data-control="model-hint">Project browsing and local search remain available while a model loads.</p>
            </section>
        </div>
        <section class="pm-panel pm-ai-faces">
            <header><h2>A familiar face for this task</h2><p class="pm-ai-hint">Preview candidates, then choose the image you want to keep.</p></header>
            <div class="pm-ai-face-workspace">
                <div>
                    <h3>Current face</h3>
                    <div class="pm-ai-current-face" data-control="current-face"><p>Select a task.</p></div>
                    <label class="arcane-field"><span class="arcane-field__label">Choose an image from your device</span>
                        <input type="file" accept="image/*" data-control="image-file"></label>
                    <p class="pm-ai-hint">The complete original is preserved. Importing creates a candidate.</p>
                </div>
                <div>
                    <h3>Create or edit a candidate</h3>
                    <div class="pm-ai-image-controls">
                        <label class="arcane-field"><span class="arcane-field__label">Image model</span>
                            <select data-control="image-model"><option value="">No image models available</option></select></label>
                        <div class="pm-actions">
                            <button type="button" class="arcane-button arcane-button--secondary" data-control="load-image">Load image model</button>
                            <button type="button" class="arcane-button arcane-button--secondary" data-control="unload-image">Unload image model</button>
                        </div>
                    </div>
                    <p class="pm-ai-status" role="status" data-control="image-model-status">Image generation requires an available local runtime and model.</p>
                    <form data-control="face-form">
                        <label class="arcane-field"><span class="arcane-field__label">Face description</span><textarea data-control="face-prompt" rows="4" placeholder="Describe the face you would like to create."></textarea></label>
                        <div class="arcane-form-grid">
                            <label class="arcane-field"><span class="arcane-field__label">Action</span><select data-control="face-action"><option value="generate">Generate a new image</option><option value="edit">Edit the selected image</option></select></label>
                            <label class="arcane-field" data-control="strength-field" hidden><span class="arcane-field__label">Edit strength · 0 to 1</span><input data-control="strength" type="number" min="0" max="1" step="0.05" value="0.6"></label>
                        </div>
                        <p class="pm-ai-hint" data-control="edit-source">Choose “Edit this image” on the current face or a candidate.</p>
                        <div class="pm-actions"><button class="arcane-button" data-control="generate-face">Generate candidate</button><button type="button" class="arcane-button arcane-button--secondary" data-control="cancel-face" disabled>Cancel</button></div>
                    </form>
                    <p class="pm-ai-hint">Editing returns a separate image. Identity, transparency, dimensions and exact prompt adherence depend on the model.</p>
                </div>
            </div>
            <p class="pm-ai-status" role="status" data-control="face-status">Choose a task to prepare its face.</p>
            <div class="pm-ai-candidates" data-control="candidates"></div>
        </section>`;
    root.append(content);
    container.append(root);

    const controls = {};
    for (const element of content.querySelectorAll('[data-control]')) {
        controls[element.dataset.control] = element;
    }
    const imageRuntime = modelServices?.getImageRuntime?.() ?? null;
    let modelState = modelServices?.current?.() ?? {model: null, catalog: []};
    let imageState = imageRuntime?.current?.() ?? {models: [], available: false};
    let faceState = faces?.current?.() ?? {candidates: [], choosingTaskIds: []};
    const tasks = new Map();
    const taskOptions = new Map();
    let selectedTaskId = taskId;
    let taskRefresh = null;
    let tasksLoaded = false;
    let currentFaceRevision = 0;
    let disposed = false;
    let preparation = null;
    let faceOperation = null;
    let modelBusy = false;
    let imageBusy = false;
    let selectingFace = false;
    let savingNote = false;
    let notesRevision = 0;
    let savedNotes = [];
    let editSource = null;

    function currentTask() {
        return tasks.get(selectedTaskId) ?? null;
    }

    function status(target, message, state = 'idle') {
        if (pageSignal.aborted) return;
        target.textContent = message;
        target.dataset.state = state;
    }

    function reportFailure(target, message, error, current = true) {
        if (error?.name !== 'AbortError') console.error(message, error);
        if (pageSignal.aborted || !current) return;
        status(target, error?.name === 'AbortError' ? 'Cancelled.' : message,
            error?.name === 'AbortError' ? 'cancelled' : 'error');
    }

    function updateControls() {
        const hasTask = Boolean(currentTask());
        const selectedModel = modelState.model;
        controls['open-task'].disabled = !hasTask || !onNavigate;
        controls.prepare.disabled = !localAI || !selectedModel || selectedModel.state === 'unavailable' || Boolean(preparation);
        controls['cancel-prepare'].disabled = !preparation;
        controls['select-model'].disabled = !modelServices || modelBusy;
        controls['load-model'].disabled = !selectedModel || modelBusy || selectedModel.busy || selectedModel.loaded;
        controls['unload-model'].disabled = !selectedModel || modelBusy;
        controls['refresh-models'].disabled = modelBusy;
        controls['image-file'].disabled = !hasTask || !faces;
        controls['load-image'].disabled = !imageRuntime || imageBusy || modelState.imageLoad?.busy || !controls['image-model'].value
            || (imageState.loaded && imageState.selectedModel === controls['image-model'].value);
        controls['unload-image'].disabled = !imageRuntime || imageBusy || modelState.imageLoad?.busy || !imageState.selectedModel;
        controls['generate-face'].disabled = !hasTask || !faces || !imageState.selectedModel || Boolean(faceOperation);
        controls['cancel-face'].disabled = !faceOperation;
        controls.task.disabled = Boolean(preparation || faceOperation || selectingFace || savingNote);
        controls['save-note'].disabled = savingNote;
        controls['use-response'].disabled = Boolean(preparation) || !controls.response.textContent;
    }

    function selectedProviderLabel(model) {
        return model.providerId === 'TWIN' ? 'DigitalOcean · remote'
            : model.providerId === 'arcane-browser-wasm-wllama' ? 'Browser CPU'
                : model.providerId;
    }

    function renderModels(snapshot) {
        if (pageSignal.aborted) return;
        modelState = snapshot;
        const prior = controls['local-model'].value;
        controls['local-model'].replaceChildren(new Option('Choose a local model', ''));
        for (const provider of snapshot.catalog ?? []) {
            if (provider.localOnly !== true) continue;
            for (const model of provider.models ?? []) {
                const option = new Option(`${model.name ?? model.id} · ${selectedProviderLabel(provider)}`, `${provider.providerId}\n${model.id}`);
                option.dataset.providerId = provider.providerId;
                option.dataset.modelId = model.id;
                controls['local-model'].append(option);
            }
        }
        controls['local-model'].value = prior;
        if (controls['local-model'].options.length === 1) {
            controls['local-model'].options[0].textContent = 'No local models available';
        }
        const model = snapshot.model;
        if (!model) {
            status(controls['model-status'], 'No model selected.');
        } else if (model.error) {
            status(controls['model-status'], `${model.modelId} could not become ready. Review the selection and try loading again.`, 'error');
        } else {
            const state = model.state === 'ready' && model.loaded ? 'Ready and loaded' : model.state;
            status(controls['model-status'], `${model.modelId} · ${selectedProviderLabel(model)} · ${state}`);
        }
        controls.prepare.textContent = model?.localOnly === false ? 'Prepare with remote model' : 'Prepare with model';
        controls['load-model'].textContent = model?.localOnly === false ? 'Activate remote model' : 'Load selected model';
        controls['model-hint'].textContent = model?.providerId === 'arcane-browser-wasm-wllama'
            ? 'Load selected model downloads its configured files when needed and stores them in this app for reuse. Preparation runs locally in your browser.'
            : !snapshot.core
                ? 'Native models need Arcane Core. A browser CPU model is available in the local model list.'
                : 'Project browsing and local search remain available while a model loads.';
        renderImageModels(imageState);
    }

    function renderImageModels(snapshot) {
        if (pageSignal.aborted) return;
        imageState = snapshot;
        const load = modelState.imageLoad;
        const prior = controls['image-model'].value || load?.modelId || snapshot.selectedModel || '';
        controls['image-model'].replaceChildren(new Option('Choose an image model', ''));
        for (const model of snapshot.models ?? []) {
            controls['image-model'].append(new Option(model.name ?? model.id, model.id));
        }
        controls['image-model'].value = prior;
        if (controls['image-model'].options.length === 1) {
            controls['image-model'].options[0].textContent = 'No image models available';
        }
        const message = load?.busy
            ? load.phase === 'preparing' ? 'Preparing the selected image model…' : 'Loading the selected image model…'
            : load?.error
                ? 'The image model could not be prepared or loaded. Review the connection and selected model, then try again.'
                : snapshot.error
            ? 'The image model is unavailable. Review its local runtime and try loading again.'
            : snapshot.loaded && snapshot.state === 'ready'
                ? `${snapshot.selectedModel} · Ready and loaded`
                : snapshot.selectedModel
                    ? `${snapshot.selectedModel} · ${snapshot.state}`
                    : 'Load an image model to generate or edit. Its download is stored in this app for reuse.';
        status(controls['image-model-status'], message, load?.busy ? 'working' : load?.error || snapshot.error ? 'error' : 'idle');
        updateControls();
    }

    function previewImage(blob, description) {
        const image = document.createElement('img');
        image.alt = description;
        image.className = 'pm-ai-face-image';
        const url = URL.createObjectURL(blob);
        previews.set(image, url);
        image.src = url;
        image.addEventListener('error', function showUnsupportedPreview() {
            if (pageSignal.aborted) return;
            const message = document.createElement('p');
            message.textContent = 'This image cannot be previewed in this browser. The original remains available.';
            image.replaceWith(message);
            releasePreview(image);
        }, {once: true, signal: pageSignal});
        return image;
    }

    function releasePreview(image) {
        const url = previews.get(image);
        if (url) URL.revokeObjectURL(url);
        previews.delete(image);
    }

    function clearPreviews(element) {
        for (const image of element.querySelectorAll('img')) releasePreview(image);
        element.replaceChildren();
    }

    function selectEditSource(blob, description) {
        editSource = {blob, description};
        controls['face-action'].value = 'edit';
        controls['edit-source'].textContent = `Editing: ${description}`;
        renderFaceAction();
        controls['face-prompt'].focus();
    }

    function editButton(blob, description) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arcane-button arcane-button--tertiary';
        button.textContent = 'Edit this image';
        button.addEventListener('click', function selectFaceForEditing() {
            selectEditSource(blob, description);
        }, {signal: pageSignal});
        return button;
    }

    async function renderCurrentFace() {
        const revision = ++currentFaceRevision;
        const task = currentTask();
        clearPreviews(controls['current-face']);
        if (!task) {
            controls['current-face'].textContent = 'Select a task to choose its face.';
            return;
        }
        const title = document.createElement('p');
        title.textContent = task.title;
        if (!task.faceRef) {
            const initials = document.createElement('div');
            initials.className = 'pm-ai-face-initial';
            initials.textContent = Array.from(task.title)[0] ?? '?';
            initials.setAttribute('aria-hidden', 'true');
            controls['current-face'].append(initials, title);
            return;
        }
        controls['current-face'].textContent = 'Loading current face…';
        try {
            const saved = await faces.read(task.faceRef, {signal: pageSignal});
            if (pageSignal.aborted || revision !== currentFaceRevision) return;
            controls['current-face'].replaceChildren();
            if (saved) {
                controls['current-face'].append(previewImage(saved.blob, `Current face for ${task.title}`), title,
                    editButton(saved.blob, `current face for ${task.title}`));
            } else {
                controls['current-face'].textContent = 'The saved face is unavailable. Choose another candidate when ready.';
            }
        } catch (error) {
            if (revision === currentFaceRevision) reportFailure(controls['current-face'], 'The saved face could not be opened. Try refreshing the task.', error);
        }
    }

    function renderFaces(snapshot) {
        if (pageSignal.aborted) return;
        faceState = snapshot;
        for (const candidate of snapshot.candidates ?? []) {
            if (candidate.taskId !== selectedTaskId) continue;
            let card = candidates.get(candidate.id);
            if (!card) {
                card = document.createElement('article');
                card.className = 'pm-ai-candidate';
                card.dataset.candidateId = candidate.id;
                const label = document.createElement('h3');
                label.textContent = candidate.operation === 'import' ? candidate.name ?? 'Imported image'
                    : candidate.operation === 'edit' ? 'Edited candidate' : 'Generated candidate';
                const actions = document.createElement('div');
                actions.className = 'pm-actions';
                const choose = document.createElement('button');
                choose.type = 'button';
                choose.className = 'arcane-button';
                choose.dataset.action = 'choose';
                choose.addEventListener('click', function deliberatelyChooseFace() {
                    chooseFace(candidate.id);
                }, {signal: pageSignal});
                actions.append(choose, editButton(candidate.blob, label.textContent));
                card.append(previewImage(candidate.blob, label.textContent), label, actions);
                if (candidate.prompt) {
                    const description = document.createElement('p');
                    description.className = 'pm-ai-candidate-prompt';
                    description.textContent = candidate.prompt;
                    card.append(description);
                }
                candidates.set(candidate.id, card);
                controls.candidates.append(card);
            }
            const chosen = currentTask()?.faceRef === candidate.id;
            card.querySelector('[data-action="choose"]').textContent = chosen ? 'Current face' : 'Choose this face';
            card.querySelector('[data-action="choose"]').disabled = chosen || selectingFace
                || (snapshot.choosingTaskIds ?? []).includes(selectedTaskId);
        }
        if (snapshot.taskId === selectedTaskId || !snapshot.taskId) {
            status(controls['face-status'], snapshot.message ?? 'Choose an image to create a candidate.', snapshot.status);
        }
        updateControls();
    }

    async function chooseFace(candidateId) {
        selectingFace = true;
        updateControls();
        renderFaces(faceState);
        status(controls['face-status'], 'Saving the selected face…', 'working');
        try {
            await faces.choose(candidateId, {signal: pageSignal});
            if (pageSignal.aborted) return;
            status(controls['face-status'], 'Task face saved.', 'complete');
        } catch (error) {
            reportFailure(controls['face-status'], 'The face could not be saved. Your candidate is still available to choose again.', error);
        } finally {
            selectingFace = false;
            if (!pageSignal.aborted) {
                renderFaces({...faceState, message: controls['face-status'].textContent});
                updateControls();
            }
        }
    }

    function taskInProject(task) {
        return task && (projectId === null || task.projectId === projectId);
    }

    function compareTasks(left, right) {
        const created = String(left.createdAt).localeCompare(String(right.createdAt));
        return created || left.id.localeCompare(right.id);
    }

    function taskLabel(task) {
        return `${task.title}${task.archivedAt ? ' · Archived' : ''}`;
    }

    function renderTaskStatus() {
        status(controls['task-status'], tasks.size ? '' : tasksLoaded
            ? 'Add a task from Your team to give it a face.' : 'Loading tasks…');
    }

    function insertTaskOption(task, option) {
        let first = 1;
        let last = controls.task.options.length;
        while (first < last) {
            const middle = Math.floor((first + last) / 2);
            const other = tasks.get(controls.task.options[middle].value);
            if (compareTasks(task, other) < 0) last = middle;
            else first = middle + 1;
        }
        controls.task.insertBefore(option, controls.task.options[first] ?? null);
    }

    function applyTaskRecord(id, record) {
        const previous = tasks.get(id);
        const task = taskInProject(record) ? record : null;
        let option = taskOptions.get(id);
        let optionsChanged = false;
        if (task) {
            tasks.set(id, task);
            if (!option) {
                option = new Option(taskLabel(task), id);
                taskOptions.set(id, option);
                insertTaskOption(task, option);
                optionsChanged = true;
            } else {
                if (previous.title !== task.title || previous.archivedAt !== task.archivedAt) {
                    option.textContent = taskLabel(task);
                    optionsChanged = true;
                }
                if (previous.createdAt !== task.createdAt) {
                    option.remove();
                    insertTaskOption(task, option);
                    optionsChanged = true;
                }
            }
            if (optionsChanged) controls.task.options[0].textContent = 'Choose a task';
        } else {
            tasks.delete(id);
            option?.remove();
            taskOptions.delete(id);
            optionsChanged = Boolean(option);
        }
        if (optionsChanged) {
            controls.task.value = selectedTaskId ?? '';
            renderTaskStatus();
        }
        if (id !== selectedTaskId) return;
        if (!task) {
            controls.task.value = '';
            changeTask();
        } else if (!previous || previous.title !== task.title || previous.faceRef !== task.faceRef) {
            renderFaces(faceState);
            renderCurrentFace();
        }
    }

    function tasksChanged(change) {
        if (pageSignal.aborted || change.recordType !== 'task') return;
        const record = change.action === 'removed' ? null : change.record;
        // A committed row wins over an older read from an in-flight full list.
        taskRefresh?.changes.set(change.id, record);
        applyTaskRecord(change.id, record);
    }

    async function refresh() {
        if (pageSignal.aborted) return;
        const refreshState = {changes: new Map()};
        taskRefresh = refreshState;
        try {
            const records = await pmData.listTasks({...(projectId === null ? {} : {projectId}), signal: pageSignal});
            if (pageSignal.aborted || taskRefresh !== refreshState) return;
            const refreshed = new Map();
            for (const task of records) refreshed.set(task.id, task);
            for (const [id, task] of refreshState.changes) {
                if (taskInProject(task)) refreshed.set(id, task);
                else refreshed.delete(id);
            }
            tasks.clear();
            taskOptions.clear();
            const options = document.createDocumentFragment();
            options.append(new Option('Choose a task', ''));
            for (const task of Array.from(refreshed.values()).sort(compareTasks)) {
                tasks.set(task.id, task);
                const option = new Option(taskLabel(task), task.id);
                taskOptions.set(task.id, option);
                options.append(option);
            }
            controls.task.replaceChildren(options);
            tasksLoaded = true;
            renderTaskStatus();
            controls.task.value = currentTask() ? selectedTaskId : '';
            if (selectedTaskId && !currentTask()) changeTask();
            else {
                renderFaces(faceState);
                await renderCurrentFace();
            }
        } catch (error) {
            reportFailure(controls['task-status'], 'Tasks could not be loaded. Restore local storage access and refresh this view.',
                error, taskRefresh === refreshState);
        } finally {
            if (taskRefresh === refreshState) taskRefresh = null;
            refreshState.changes.clear();
        }
    }

    function renderProviderMode() {
        const mode = controls['provider-mode'].value;
        controls['local-fields'].hidden = mode !== 'local';
        controls['browser-fields'].hidden = mode !== 'browser';
        controls['remote-fields'].hidden = mode !== 'remote';
    }

    async function performModelAction(action, startingMessage) {
        if (modelBusy || pageSignal.aborted) return;
        modelBusy = true;
        status(controls['model-status'], startingMessage, 'working');
        updateControls();
        try {
            await action();
            if (!pageSignal.aborted) renderModels(modelServices.current());
        } catch (error) {
            reportFailure(controls['model-status'], 'The selected model could not be prepared. Review the model and local runtime, then try again.', error);
        } finally {
            modelBusy = false;
            if (!pageSignal.aborted) updateControls();
        }
    }

    function submitModel(event) {
        event.preventDefault();
        performModelAction(async function selectExplicitModel() {
            const mode = controls['provider-mode'].value;
            if (mode === 'remote') {
                await modelServices.select({providerId: 'TWIN', modelId: controls['remote-model'].value, twinKey: controls['remote-key'].value}, {signal: pageSignal});
                controls['remote-key'].value = '';
            } else if (mode === 'browser') {
                const modelId = controls['browser-model'].value;
                const files = controls['browser-files'].value.split(/\r?\n/).filter(function nonblankURL(value) {
                    return value.trim().length > 0;
                }).map(function sourceURL(value) { return {url: value.trim()}; });
                await modelServices.select({providerId: 'browser-wasm', modelId, source: {id: modelId, files}}, {signal: pageSignal});
            } else {
                const selected = controls['local-model'].selectedOptions[0];
                const providerId = selected?.dataset.providerId;
                const modelId = selected?.dataset.modelId;
                const browserModel = providerId === 'arcane-browser-wasm-wllama'
                    ? modelState.catalog.find(function selectedBrowserProvider(provider) {
                        return provider.providerId === providerId;
                    })?.models.find(function selectedBrowserModel(model) {
                        return model.id === modelId;
                    }) : null;
                await modelServices.select({
                    providerId,
                    modelId,
                    source: browserModel ? {id: browserModel.id, files: browserModel.files} : undefined
                }, {signal: pageSignal});
            }
        }, 'Selecting model…');
    }

    async function submitPreparation(event) {
        event.preventDefault();
        if (preparation || !localAI || !modelState.model) return;
        const prompt = controls.prompt.value;
        if (!prompt.trim()) {
            status(controls['prepare-status'], 'Write what you want to prepare first.');
            controls.prompt.focus();
            return;
        }
        const operation = new AbortController();
        const operationSignal = AbortSignal.any([pageSignal, operation.signal]);
        preparation = operation;
        controls.response.textContent = '';
        controls['response-region'].hidden = false;
        controls['tool-results'].replaceChildren();
        status(controls['prepare-status'], 'Thinking', 'Thinking');
        updateControls();
        try {
            const result = await localAI.prepare({
                taskId: selectedTaskId,
                messages: [{role: 'user', content: prompt}],
                userTurn: {content: prompt, timestamp: new Date().toISOString()},
                persist: false,
                signal: operationSignal,
                onChunk: function renderRealResponseChunk(chunk) {
                    if (operationSignal.aborted || preparation !== operation) return;
                    controls.response.append(document.createTextNode(chunk));
                    status(controls['prepare-status'], 'Preparing your response.', 'responding');
                },
                onToolResult: function showToolOutcome(result) {
                    if (operationSignal.aborted || preparation !== operation) return;
                    const message = document.createElement('p');
                    message.textContent = result.message;
                    controls['tool-results'].append(message);
                }
            });
            if (operationSignal.aborted || preparation !== operation) return;
            controls.response.textContent = result.content;
            status(controls['prepare-status'], result.content
                ? 'The response is ready. Choose “Use response in note” to edit and save it.'
                : 'The model returned no visible text.', result.content ? 'complete' : 'empty');
        } catch (error) {
            if (preparation === operation) reportFailure(controls['prepare-status'], 'Preparation could not finish. Your prompt is ready to try again.', error);
        } finally {
            if (preparation === operation) preparation = null;
            if (!pageSignal.aborted) updateControls();
        }
    }

    function renderFaceAction() {
        const editing = controls['face-action'].value === 'edit';
        controls['strength-field'].hidden = !editing;
        controls['edit-source'].hidden = !editing;
        controls['generate-face'].textContent = editing ? 'Create edited candidate' : 'Generate candidate';
    }

    async function submitFace(event) {
        event.preventDefault();
        if (faceOperation || !currentTask()) return;
        const editing = controls['face-action'].value === 'edit';
        if (editing && !editSource) {
            status(controls['face-status'], 'Choose an image to edit first.');
            return;
        }
        const operation = new AbortController();
        faceOperation = operation;
        const operationSignal = AbortSignal.any([pageSignal, operation.signal]);
        status(controls['face-status'], 'Thinking', 'Thinking');
        updateControls();
        try {
            const input = {taskId: selectedTaskId, model: imageState.selectedModel,
                prompt: controls['face-prompt'].value, signal: operationSignal};
            if (editing) await faces.edit({...input, image: editSource.blob, strength: controls.strength.valueAsNumber});
            else await faces.generate(input);
            if (!operationSignal.aborted) renderFaces(faces.current());
        } catch (error) {
            reportFailure(controls['face-status'], editing
                ? 'This image could not be edited. Use a supported PNG and a loaded image model, then try again.'
                : 'The face could not be generated. Review the selected image model and try again.', error);
        } finally {
            if (faceOperation === operation) faceOperation = null;
            if (!pageSignal.aborted) updateControls();
        }
    }

    async function importFace() {
        const file = controls['image-file'].files[0];
        if (!file || !currentTask()) return;
        status(controls['face-status'], 'Preparing image preview…', 'working');
        try {
            await faces.importCandidate({taskId: selectedTaskId, image: file, signal: pageSignal});
            if (!pageSignal.aborted) renderFaces(faces.current());
        } catch (error) {
            reportFailure(controls['face-status'], 'The image could not be opened. Choose the file again.', error);
        }
    }

    async function loadImageModel() {
        const model = (imageState.models ?? []).find(function selectedImageModel(record) {
            return record.id === controls['image-model'].value;
        });
        if (!model || imageBusy) return;
        imageBusy = true;
        status(controls['image-model-status'], 'Preparing the selected image model…', 'working');
        updateControls();
        try {
            await modelServices.loadImage({model: model.id, offline: false});
            if (!pageSignal.aborted) renderImageModels(imageRuntime.current());
        } catch (error) {
            reportFailure(controls['image-model-status'], 'The image model could not be prepared or loaded. Review the connection and selected model, then try again.', error);
        } finally {
            imageBusy = false;
            if (!pageSignal.aborted) updateControls();
        }
    }

    async function unloadImageModel() {
        if (imageBusy) return;
        imageBusy = true;
        status(controls['image-model-status'], 'Unloading image model…', 'working');
        updateControls();
        try {
            await imageRuntime.unload();
            if (!pageSignal.aborted) renderImageModels(imageRuntime.current());
        } catch (error) {
            reportFailure(controls['image-model-status'], 'The image model could not be unloaded. Try again.', error);
        } finally {
            imageBusy = false;
            if (!pageSignal.aborted) updateControls();
        }
    }

    async function copyNote() {
        try {
            await navigator.clipboard.writeText(controls.note.value);
            status(controls['prepare-status'], 'Note copied.', 'complete');
        } catch (error) {
            controls.note.focus();
            controls.note.select();
            reportFailure(controls['prepare-status'], 'Use your browser’s Copy command to copy the selected note.', error);
        }
    }

    async function saveNote() {
        if (savingNote || pageSignal.aborted) return;
        savingNote = true;
        updateControls();
        status(controls['prepare-status'], 'Saving note…', 'working');
        try {
            await localAI.saveNote({taskId: selectedTaskId, content: controls.note.value, signal: pageSignal});
            status(controls['prepare-status'], 'Note saved.', 'complete');
            await refreshNotes();
        } catch (error) {
            reportFailure(controls['prepare-status'], 'The note could not be saved. Keep it here and try again.', error);
        } finally {
            savingNote = false;
            if (!pageSignal.aborted) updateControls();
        }
    }

    async function refreshNotes() {
        if (typeof localAI?.listNotes !== 'function' || pageSignal.aborted) return;
        const revision = ++notesRevision;
        savedNotes = [];
        controls['saved-notes'].replaceChildren(new Option('Loading saved notes…', ''));
        controls['saved-note'].textContent = '';
        controls['saved-note'].hidden = true;
        controls['use-saved-note'].disabled = true;
        status(controls['notes-status'], 'Loading saved notes…', 'working');
        try {
            const records = await localAI.listNotes({taskId: selectedTaskId, signal: pageSignal});
            if (pageSignal.aborted || revision !== notesRevision) return;
            savedNotes = records;
            controls['saved-notes'].replaceChildren(new Option(records.length ? 'Choose a saved note' : 'No saved notes', ''));
            for (const note of records) {
                const time = new Date(note.createdAt);
                const label = Number.isNaN(time.getTime()) ? note.createdAt : time.toLocaleString();
                controls['saved-notes'].append(new Option(label, note.id));
            }
            controls['saved-note'].textContent = '';
            controls['saved-note'].hidden = true;
            controls['use-saved-note'].disabled = true;
            status(controls['notes-status'], '');
        } catch (error) {
            reportFailure(controls['notes-status'], 'Saved notes could not be loaded. Your open note remains available.',
                error, revision === notesRevision);
        }
    }

    function openSavedNote() {
        const note = savedNotes.find(function selectedSavedNote(record) {
            return record.id === controls['saved-notes'].value;
        });
        controls['saved-note'].textContent = note?.content ?? '';
        controls['saved-note'].hidden = !note;
        controls['use-saved-note'].disabled = !note;
    }

    function changeTask() {
        selectedTaskId = controls.task.value || null;
        editSource = null;
        controls['edit-source'].textContent = 'Choose “Edit this image” on the current face or a candidate.';
        clearPreviews(controls.candidates);
        candidates.clear();
        renderFaces(faceState);
        updateControls();
        renderCurrentFace();
        refreshNotes();
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        page.abort();
        for (const unsubscribe of subscriptions) unsubscribe();
        for (const image of previews.keys()) releasePreview(image);
        candidates.clear();
        tasks.clear();
        taskOptions.clear();
        taskRefresh?.changes.clear();
        taskRefresh = null;
        controls.note.value = '';
        controls.prompt.value = '';
        controls.response.textContent = '';
        controls['saved-note'].textContent = '';
        controls['remote-key'].value = '';
        controls['tool-results'].replaceChildren();
        editSource = null;
        savedNotes = [];
        root.remove();
    }

    controls['prepare-form'].addEventListener('submit', submitPreparation, {signal: pageSignal});
    controls['model-form'].addEventListener('submit', submitModel, {signal: pageSignal});
    controls['face-form'].addEventListener('submit', submitFace, {signal: pageSignal});
    controls['provider-mode'].addEventListener('change', renderProviderMode, {signal: pageSignal});
    controls['face-action'].addEventListener('change', renderFaceAction, {signal: pageSignal});
    controls['image-file'].addEventListener('change', importFace, {signal: pageSignal});
    controls['image-model'].addEventListener('change', updateControls, {signal: pageSignal});
    controls['load-image'].addEventListener('click', loadImageModel, {signal: pageSignal});
    controls['unload-image'].addEventListener('click', unloadImageModel, {signal: pageSignal});
    controls['copy-note'].addEventListener('click', copyNote, {signal: pageSignal});
    controls['save-note'].addEventListener('click', saveNote, {signal: pageSignal});
    controls['saved-notes'].addEventListener('change', openSavedNote, {signal: pageSignal});
    controls['use-response'].addEventListener('click', function usePreparedResponse() {
        controls.note.value = controls.response.textContent;
        controls.note.focus();
        status(controls['prepare-status'], 'Response copied into your note. Edit it and choose Save note when ready.');
    }, {signal: pageSignal});
    controls['use-saved-note'].addEventListener('click', function useSavedNote() {
        controls.note.value = controls['saved-note'].textContent;
        controls.note.focus();
    }, {signal: pageSignal});
    controls.task.addEventListener('change', changeTask, {signal: pageSignal});
    controls['open-task'].addEventListener('click', function openSelectedTask() {
        onNavigate?.('task', {projectId, taskId: selectedTaskId});
    }, {signal: pageSignal});
    controls['cancel-prepare'].addEventListener('click', function cancelThisPreparation() {
        preparation?.abort();
    }, {signal: pageSignal});
    controls['cancel-face'].addEventListener('click', function cancelThisFaceRequest() {
        faceOperation?.abort();
    }, {signal: pageSignal});
    controls['load-model'].addEventListener('click', function loadSelectedTextModel() {
        performModelAction(function loadModel() { return modelServices.load({offline: false}); }, 'Loading selected model…');
    }, {signal: pageSignal});
    controls['unload-model'].addEventListener('click', function unloadSelectedTextModel() {
        performModelAction(function unloadModel() { return modelServices.unload(); }, 'Unloading selected model…');
    }, {signal: pageSignal});
    controls['refresh-models'].addEventListener('click', function refreshAvailableModels() {
        inspectModels(true);
    }, {signal: pageSignal});
    pageSignal.addEventListener('abort', dispose, {once: true});
    window.addEventListener('pagehide', function leavePreparationPage(event) {
        if (!event.persisted) dispose();
    }, {signal: pageSignal});

    if (modelServices?.subscribe) subscriptions.push(modelServices.subscribe(renderModels, {signal: pageSignal}));
    if (imageRuntime?.subscribe) subscriptions.push(imageRuntime.subscribe(renderImageModels, {replay: true, signal: pageSignal}));
    if (faces?.subscribe) subscriptions.push(faces.subscribe(renderFaces, {signal: pageSignal}));
    if (localAI?.subscribe) subscriptions.push(localAI.subscribe(function preparationStatusChanged(snapshot) {
        if (preparation) status(controls['prepare-status'], snapshot.message, snapshot.status);
    }, {signal: pageSignal}));
    if (pmData?.subscribe) subscriptions.push(pmData.subscribe(tasksChanged, {signal: pageSignal}));
    controls['save-note'].hidden = typeof localAI?.saveNote !== 'function';
    controls['saved-notes-region'].hidden = typeof localAI?.listNotes !== 'function';
    renderProviderMode();
    renderFaceAction();
    updateControls();
    if (pageSignal.aborted) dispose();
    else {
        refresh();
        refreshNotes();
        inspectModels();
    }

    function inspectModels(refreshImages = false) {
        if (modelServices) performModelAction(function inspectTextModels() {
            return modelServices.inspect({signal: pageSignal});
        }, 'Checking available models…');
        if (imageRuntime && refreshImages) imageRuntime.inspect({signal: pageSignal}).then(renderImageModels).catch(function imageAvailabilityFailed(error) {
            reportFailure(controls['image-model-status'], 'Image generation is unavailable here. You can import a face image.', error);
        });
    }

    return {refresh, dispose};
}
