import {createArcaneEventSource} from 'arcane-os/event-manager';

/** One PM preparation turn. Provider and model mechanics stay with the SDK. */
export function createLocalPreparationController(
    {modelServices, getStorage, tools = [], executeTool, signal} = {}
) {
    if (tools.length && typeof executeTool !== 'function') {
        throw new TypeError('Configured preparation tools require their owning executor.');
    }

    const lifetime = new AbortController();
    const lifetimeSignal = signal
        ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const events = createArcaneEventSource(
        {},
        {source: 'arcane-pm.preparation', eventTypes: ['arcane-pm.preparation.state']}
    );
    let active = null;
    const requests = new Set();
    let closed = false;
    let closing = null;
    let state = {
        status: 'idle',
        message: 'Choose a model to prepare work locally.',
        requestId: null,
        taskId: null,
        savedId: null
    };

    function current() {
        return {...state, closed};
    }

    function publish(changes) {
        state = {...state, ...changes};
        events.dispatch('arcane-pm.preparation.state', current());
    }

    function subscribe(listener, {signal: subscriptionSignal} = {}) {
        const stop = events.on(
            'arcane-pm.preparation.state',
            function preparationStateChanged(event) {
                listener(event.detail);
            },
            {signal: subscriptionSignal}
        );
        if (!subscriptionSignal?.aborted) listener(current());
        return stop;
    }

    function cancel() {
        active?.controller.abort();
    }

    function assertCurrent(request) {
        request.signal.throwIfAborted();
        if (closed || active !== request) {
            throw new DOMException('Preparation was cancelled.', 'AbortError');
        }
    }

    function observe(callback, value) {
        if (typeof callback !== 'function') return;
        try {
            const result = callback(value);
            if (result && typeof result.catch === 'function') {
                result.catch(reportObserverFailure);
            }
        } catch (error) {
            reportObserverFailure(error);
        }
    }

    function reportObserverFailure(error) {
        console.error('PM preparation observer failed.', error);
    }

    function prepare(
        {taskId = null, messages, persist = false, userTurn, onChunk, onToolResult,
            onDiagnostic, signal: requestSignal} = {}
    ) {
        if (closed) throw new Error('The preparation controller is closed.');
        if (!Array.isArray(messages)) throw new TypeError('Preparation requires authored messages.');
        cancel();

        const controller = new AbortController();
        const request = {
            id: crypto.randomUUID(),
            controller,
            signal: AbortSignal.any(
                [lifetimeSignal, controller.signal, ...(requestSignal ? [requestSignal] : [])]
            ),
            task: null,
            stopModel: null,
            stopWaitAbort: null,
            selection: null,
            dispatched: false
        };
        active = request;
        requests.add(request);
        request.task = Promise.resolve().then(
            function startPreparation() {
                return executePreparation(request);
            }
        );
        request.signal.addEventListener('abort', releaseModelSubscription, {once: true});
        publish(
            {
                status: 'Thinking',
                message: 'Thinking',
                requestId: request.id,
                taskId,
                savedId: null
            }
        );
        return request.task;

        function releaseModelSubscription() {
            request.stopModel?.();
            request.stopModel = null;
        }

        async function executePreparation(operation) {
            let content = '';
            let response;
            const toolTasks = [];
            const toolResults = [];
            const startedAt = new Date().toISOString();

            try {
                assertCurrent(operation);
                await waitForSelectedModel(operation);
                assertCurrent(operation);
                operation.dispatched = true;
                const ai = modelServices.getAI();
                const result = await ai.streamRequest(
                    {
                        messages,
                        tools,
                        toolChoice: 'auto',
                        localOnly: operation.selection.localOnly === true,
                        signal: operation.signal,
                        id: operation.id,
                        seeThinking: false,
                        onChunk: receiveText,
                        onResponse: receiveResponse,
                        onRequest: inspectRequest,
                        onToolCall: receiveToolCall
                    }
                );
                assertCurrent(operation);
                await Promise.allSettled(toolTasks);
                assertCurrent(operation);

                // Some providers return one final visible text without chunks.
                if (!content && typeof result === 'string') {
                    content = result;
                    if (content) observe(onChunk, content);
                }
                assertCurrent(operation);
                const completedAt = new Date().toISOString();
                let savedId = null;
                if (persist && (content.trim() || toolResults.length)) {
                    const database = await getStorage();
                    assertCurrent(operation);
                    const records = [];
                    if (userTurn) {
                        records.push(
                            {
                                role: 'user',
                                content: userTurn.content,
                                timestamp: userTurn.timestamp ?? startedAt
                            }
                        );
                    }
                    if (content.trim()) {
                        records.push({role: 'assistant', content, timestamp: completedAt});
                    }
                    for (const outcome of toolResults) {
                        if (typeof outcome.message === 'string' && outcome.message.trim()) {
                            records.push(
                                {
                                    role: 'tool',
                                    name: outcome.name,
                                    status: outcome.status,
                                    content: outcome.message,
                                    timestamp: outcome.timestamp
                                }
                            );
                        }
                    }
                    savedId = operation.id;
                    await database.set(
                        'pm_preparations',
                        `${savedId}.json`,
                        {id: savedId, taskId, createdAt: startedAt, completedAt, records}
                    );
                    // An OPFS write already accepted by its owner may finish after abort.
                    assertCurrent(operation);
                }
                assertCurrent(operation);
                publish(
                    {
                        status: content || toolResults.length ? 'complete' : 'empty',
                        message: savedId ? 'Preparation saved.'
                            : content || toolResults.length ? 'Preparation ready.'
                                : 'The model returned no visible response.',
                        savedId
                    }
                );
                assertCurrent(operation);
                return {content, response, toolResults, savedId};
            } catch (error) {
                const wasCancelled = operation.signal.aborted;
                operation.controller.abort(error);
                await Promise.allSettled(toolTasks);
                if (active === operation && !closed) {
                    publish(
                        {
                            status: wasCancelled ? 'cancelled' : 'error',
                            message: wasCancelled
                                ? 'Preparation stopped.'
                                : 'Preparation could not finish. Review the selected model and try again.'
                        }
                    );
                }
                if (!wasCancelled) {
                    console.error('PM preparation failed.', error);
                    observe(onDiagnostic, {type: 'error', error});
                }
                throw error;
            } finally {
                operation.stopModel?.();
                operation.stopModel = null;
                operation.stopWaitAbort?.();
                operation.stopWaitAbort = null;
                operation.signal.removeEventListener('abort', releaseModelSubscription);
                requests.delete(operation);
                if (active === operation) active = null;
                // No prompt, response, tool envelope or visible content enters retained state.
            }

            function receiveText(text, displayId, thinking) {
                assertCurrent(operation);
                if (thinking || !text) return;
                content += text;
                publish({status: 'responding', message: 'Preparing your response.'});
                assertCurrent(operation);
                observe(onChunk, text);
                assertCurrent(operation);
            }

            function receiveResponse(value) {
                assertCurrent(operation);
                response = value;
                observe(onDiagnostic, {type: 'response', response: value});
                assertCurrent(operation);
            }

            function inspectRequest(value) {
                assertCurrent(operation);
                observe(onDiagnostic, {type: 'request', request: value});
                assertCurrent(operation);
            }

            function receiveToolCall(call) {
                assertCurrent(operation);
                const task = executeSelectedTool(call);
                toolTasks.push(task);
            }

            async function executeSelectedTool(call) {
                let outcome;
                try {
                    const result = await executeTool(call, {signal: operation.signal});
                    outcome = {
                        call,
                        result,
                        name: call.function.name,
                        status: result?.status,
                        message: result?.message,
                        timestamp: new Date().toISOString()
                    };
                } catch (error) {
                    console.error('PM preparation tool failed.', error);
                    observe(onDiagnostic, {type: 'tool-error', call, error});
                    outcome = {
                        call,
                        error,
                        name: call.function.name,
                        status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
                        message: error?.name === 'AbortError' ? 'The requested tool was cancelled.'
                            : 'The requested tool could not finish. Review its result and try again.',
                        timestamp: new Date().toISOString()
                    };
                }
                toolResults.push(outcome);
                observe(onDiagnostic, {type: 'tool-settled', outcome});
                // An accepted tool write may finish after cancellation. Preserve its
                // actual settlement while stopping conversation continuation.
                if (operation.signal.aborted || closed || active !== operation) return;
                observe(onToolResult, outcome);
            }
        }
    }

    function waitForSelectedModel(request) {
        return new Promise(
            function waitForPMModel(resolve, reject) {
                let started = false;

                function receiveModelState(snapshot) {
                    const model = snapshot.model;
                    if (!model?.providerId || !model?.modelId) {
                        if (!started) reject(new Error('Select a model before preparing work.'));
                        else request.controller.abort();
                        return;
                    }
                    if (!request.selection) {
                        request.selection = {
                            providerId: model.providerId,
                            modelId: model.modelId,
                            localOnly: model.localOnly
                        };
                    }
                    const matches = model.providerId === request.selection.providerId
                        && model.modelId === request.selection.modelId;
                    const ready = matches && model.state === 'ready' && model.loaded === true;
                    if (!matches || (started && !ready)) {
                        request.controller.abort();
                        return;
                    }
                    if (ready && !started) {
                        started = true;
                        resolve();
                    } else if (!started && ['unavailable', 'error', 'disposed'].includes(model.state)) {
                        reject(new Error('The selected model is unavailable.'));
                    } else if (!started) {
                        publish({message: 'Thinking — waiting for the selected model.'});
                    }
                }

                function preparationModelWaitCancelled() {
                    reject(request.signal.reason);
                }

                request.signal.addEventListener('abort', preparationModelWaitCancelled, {once: true});
                request.stopWaitAbort = function releasePreparationWait() {
                    request.signal.removeEventListener('abort', preparationModelWaitCancelled);
                };
                request.stopModel = modelServices.subscribe(receiveModelState);
                if (request.signal.aborted) {
                    request.stopModel?.();
                    request.stopModel = null;
                    reject(request.signal.reason);
                }
            }
        );
    }

    async function saveNote({taskId = null, content, signal: noteSignal} = {}) {
        const operationSignal = noteSignal
            ? AbortSignal.any([lifetimeSignal, noteSignal]) : lifetimeSignal;
        operationSignal.throwIfAborted();
        if (typeof content !== 'string' || !content.trim()) {
            throw new TypeError('Write a note before saving it.');
        }
        const storage = await getStorage();
        operationSignal.throwIfAborted();
        const note = {id: crypto.randomUUID(), taskId, content, createdAt: new Date().toISOString()};
        await storage.set('pm_preparation_notes', `${note.id}.json`, note);
        return note;
    }

    async function listNotes({taskId, signal: noteSignal} = {}) {
        const operationSignal = noteSignal
            ? AbortSignal.any([lifetimeSignal, noteSignal]) : lifetimeSignal;
        operationSignal.throwIfAborted();
        const storage = await getStorage();
        operationSignal.throwIfAborted();
        const records = await storage.getAll('pm_preparation_notes');
        operationSignal.throwIfAborted();
        const notes = Object.values(records).filter(
            function matchesNoteTask(note) {
                return note && (taskId === undefined || note.taskId === taskId);
            }
        );
        return notes.sort(
            function newestPreparationNote(first, second) {
                return second.createdAt.localeCompare(first.createdAt) || first.id.localeCompare(second.id);
            }
        );
    }

    function dispose() {
        if (closing) return closing;
        closed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        lifetime.abort();
        const pending = Array.from(requests, function pendingPreparation(request) {
            return request.task;
        });
        closing = Promise.allSettled(pending).then(
            function finishPreparationDisposal() {
                events.dispose();
            }
        );
        return closing;
    }

    lifetimeSignal.addEventListener('abort', dispose, {once: true});
    if (lifetimeSignal.aborted) dispose();
    return {prepare, current, subscribe, cancel, saveNote, listNotes, dispose};
}
