/** PM presentation of actual Codex requests; native Codex owns their decisions. */
export function mountCodexRequests(container, {bridge, signal, onStatus} = {}) {
    const lifetime = new AbortController();
    const pageSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const requests = new Map();
    const displayedRequests = new Set();
    const fileItems = new Map();
    const stops = [];
    let current = bridge.status();
    let closed = false;
    let sequence = 0;

    const root = element('section', 'pm-panel');
    const heading = element('h2', '', 'Codex requests');
    const summary = element('p', 'pm-muted');
    summary.setAttribute('role', 'status');
    const list = element('div', 'pm-record-list');
    root.append(heading, summary, list);
    container.replaceChildren(root);

    function element(tag, className = '', text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function active() { return !closed && !pageSignal.aborted; }

    function report(message) {
        if (!active()) return;
        onStatus?.(message);
    }

    function itemKey(threadId, turnId, itemId) {
        return JSON.stringify([threadId, turnId, itemId]);
    }

    function renderSummary() {
        if (!active()) return;
        if (!current.connected) {
            summary.textContent = 'Connect Codex to see requests that need your attention.';
        } else if (!requests.size) {
            summary.textContent = 'No pending Codex requests.';
        } else {
            summary.textContent = `${requests.size} Codex ${requests.size === 1 ? 'request' : 'requests'}. Responses apply only to the selected request.`;
        }
    }

    function syncControls(record) {
        const enabled = active() && !record.retired && current.capabilities?.respondToRequest
            && record.responseState === 'pending' && !record.sending;
        for (const control of record.controls) {
            control.node.disabled = !enabled || (control.needsReview && !record.reviewable);
            if (control.needsReview) control.node.hidden = !record.reviewable;
        }
        if (record.retired) {
            record.status.textContent = 'This request belongs to a previous connection. Your entered answers remain here; review the current conversation in Codex.';
        } else if (record.sending || record.responseState === 'sending') {
            record.status.textContent = 'Sending your response…';
        } else if (record.responseState === 'sent') {
            record.status.textContent = 'Response sent. Codex acceptance and execution remain unconfirmed.';
        } else if (record.responseState === 'unknown') {
            record.status.textContent = 'The response outcome is unknown. Open the conversation in Codex before taking another action.';
        } else if (!current.connected) {
            record.status.textContent = 'The connection is unavailable. This request cannot be answered here yet.';
        } else if (record.responseState === 'unavailable') {
            record.status.textContent = 'This request is no longer available on the current connection.';
        } else if (record.responseState === 'unconfirmed') {
            record.status.textContent = 'Reading the current request state…';
        } else if (record.failureMessage) {
            record.status.textContent = record.failureMessage;
        } else {
            record.status.textContent = record.supported ? 'Waiting for your response.' : 'This request needs a supported Codex client.';
        }
    }

    function receiveState(value) {
        if (!active()) return;
        const connectionChanged = current.connectionId !== undefined
            && value.connectionId !== undefined && current.connectionId !== value.connectionId;
        const connectionEnded = current.connected && !value.connected;
        current = value;
        if (connectionChanged || connectionEnded) {
            for (const record of requests.values()) {
                record.retired = true;
                syncControls(record);
            }
            requests.clear();
            fileItems.clear();
        }
        if (Array.isArray(value.pendingRequests)) {
            const pending = new Map();
            for (const request of value.pendingRequests) pending.set(request.requestId, request);
            for (const [requestId, record] of requests) {
                const native = pending.get(requestId);
                record.responseState = native?.responseState ?? 'unavailable';
                syncControls(record);
            }
        } else {
            for (const record of requests.values()) syncControls(record);
        }
        renderSummary();
    }

    function nativeDetails(frame) {
        const details = element('details');
        details.append(element('summary', '', 'Developer inspection: original Codex request'));
        const content = element('pre');
        details.addEventListener('toggle', function inspectNativeRequest() {
            if (details.open) content.textContent = JSON.stringify(frame, null, 2);
        }, {signal: pageSignal});
        details.append(content);
        return details;
    }

    function receiveRequest(frame) {
        if (!active()) return;
        const previous = requests.get(frame.id);
        if (previous) return;
        const params = frame.params ?? {};
        const article = element('article', 'pm-panel');
        const title = element('h3');
        const status = element('p', 'pm-muted');
        status.setAttribute('role', 'status');
        const content = element('div');
        const actions = element('div', 'pm-actions');
        const native = current.pendingRequests?.find(function matchingRequest(item) { return item.requestId === frame.id; });
        const record = {
            frame, article, content, actions, status, controls: [], secretInputs: [],
            connectionId: current.connectionId, retired: false,
            responseState: native?.responseState ?? 'unconfirmed',
            sending: false, supported: false, reviewable: false, failureMessage: ''
        };
        requests.set(frame.id, record);
        displayedRequests.add(record);
        article.append(title);
        if (typeof params.reason === 'string') article.append(element('p', 'pm-task-description', params.reason));
        article.append(content, actions, status);
        const threadId = params.threadId ?? params.conversationId;
        if (typeof threadId === 'string' && threadId) {
            const link = element('a', '', 'Open this conversation in Codex');
            link.href = bridge.getThreadUrl(threadId);
            article.append(link);
        }
        article.append(nativeDetails(frame));
        list.append(article);

        if (frame.method === 'item/commandExecution/requestApproval') {
            title.textContent = params.kind === 'writeStdin' ? 'Review terminal input' : 'Review command';
            renderCommand(record);
        } else if (frame.method === 'item/fileChange/requestApproval') {
            title.textContent = 'Review file changes';
            renderFiles(record);
        } else if (frame.method === 'item/tool/requestUserInput') {
            title.textContent = 'Codex has a question';
            renderQuestions(record);
        } else {
            title.textContent = 'Codex needs attention';
            content.append(element('p', '', 'PM cannot answer this kind of request. Review it in Codex.'));
        }
        syncControls(record);
        renderSummary();
    }

    function addResponseButton(record, label, result, {needsReview = false} = {}) {
        const button = element('button', 'arcane-button arcane-button--secondary', label);
        button.type = 'button';
        button.addEventListener('click', function respondToApproval() {
            sendResponse(record, result);
        }, {signal: pageSignal});
        record.controls.push({node: button, needsReview});
        record.actions.append(button);
    }

    function approvalActions(record) {
        addResponseButton(record, 'Allow once', {decision: 'accept'}, {needsReview: true});
        addResponseButton(record, 'Decline', {decision: 'decline'});
        addResponseButton(record, 'Decline and stop turn', {decision: 'cancel'});
    }

    function renderCommand(record) {
        const params = record.frame.params;
        record.supported = true;
        if (typeof params.cwd === 'string') {
            record.content.append(element('p', 'pm-task-description', `Working folder: ${params.cwd}`));
        }
        if (typeof params.environmentId === 'string') {
            record.content.append(element('p', '', `Environment: ${params.environmentId}`));
        }
        if (typeof params.command === 'string' && params.command.length) {
            record.content.append(element('pre', '', params.command));
            record.reviewable = true;
        } else {
            record.content.append(element('p', '', 'Codex did not supply the complete command or input for review. Open the conversation to review it before allowing it.'));
        }
        if (params.networkApprovalContext) {
            const network = params.networkApprovalContext;
            record.content.append(element('p', 'pm-task-description', `Network destination: ${network.protocol} ${network.host}`));
        }
        approvalActions(record);
    }

    function renderFiles(record) {
        const params = record.frame.params;
        const notification = fileItems.get(itemKey(params.threadId, params.turnId, params.itemId));
        const changes = notification?.params.item.changes;
        const hasChanges = Array.isArray(changes) && changes.length > 0;
        const requestedSessionAccess = params.grantRoot !== undefined && params.grantRoot !== null;
        record.supported = true;
        record.reviewable = hasChanges && !requestedSessionAccess;
        record.content.replaceChildren();
        if (hasChanges) {
            for (const change of changes) {
                const file = element('section');
                const action = change.kind.type === 'add' ? 'Add' : change.kind.type === 'delete' ? 'Delete' : 'Update';
                file.append(element('h4', '', `${action}: ${change.path}`));
                if (change.kind.move_path !== undefined && change.kind.move_path !== null) {
                    file.append(element('p', 'pm-task-description', `Move to: ${change.kind.move_path}`));
                }
                file.append(element('pre', '', change.diff));
                record.content.append(file);
            }
            const original = element('details');
            original.append(element('summary', '', 'Developer inspection: original file-change event'));
            const details = element('pre');
            original.addEventListener('toggle', function inspectFileChange() {
                if (original.open) details.textContent = JSON.stringify(notification, null, 2);
            }, {signal: pageSignal});
            original.append(details);
            record.content.append(original);
        } else {
            record.content.append(element('p', '', 'The matching file changes have not arrived for review. Open the conversation in Codex to inspect them.'));
        }
        if (requestedSessionAccess) {
            record.content.append(element('p', 'pm-task-description', `Codex requested write access under ${params.grantRoot} for the rest of the session. Review this broader scope in Codex before allowing it.`));
        }
        if (!record.actions.childElementCount) approvalActions(record);
        syncControls(record);
    }

    function renderQuestions(record) {
        const params = record.frame.params;
        const form = element('form', 'pm-form');
        const readers = [];
        record.supported = true;
        record.reviewable = true;
        for (const question of params.questions) {
            const field = element('fieldset');
            field.append(element('legend', '', question.header));
            field.append(element('p', 'pm-task-description', question.question));
            const choices = [];
            const group = `pm-codex-question-${++sequence}`;
            const options = question.options ?? [];
            for (const option of options) {
                const choice = element('div');
                const label = element('label');
                const radio = element('input');
                radio.type = 'radio';
                radio.name = group;
                label.append(radio, element('span', 'pm-task-description', option.label));
                choice.append(label, element('p', 'pm-task-description', option.description));
                field.append(choice);
                choices.push({radio, answer: option.label});
                record.controls.push({node: radio});
            }
            let other = null;
            let answer = null;
            if (!options.length || question.isOther) {
                const label = element('label');
                if (options.length) {
                    const otherLabel = element('label');
                    other = element('input');
                    other.type = 'radio';
                    other.name = group;
                    otherLabel.append(other, document.createTextNode('Other answer'));
                    field.append(otherLabel);
                    label.append(document.createTextNode('Write your answer'));
                    record.controls.push({node: other});
                } else {
                    label.append(document.createTextNode('Your answer'));
                }
                answer = element(question.isSecret ? 'input' : 'textarea', 'arcane-input');
                if (question.isSecret) {
                    answer.type = 'password';
                    answer.autocomplete = 'off';
                    record.secretInputs.push(answer);
                }
                if (other) {
                    answer.addEventListener('input', function selectWrittenAnswer() { other.checked = true; }, {signal: pageSignal});
                }
                label.append(answer);
                field.append(label);
                record.controls.push({node: answer});
            }
            readers.push({id: question.id, read: function readQuestionAnswer() {
                if (answer && (!options.length || other.checked)) return answer.value === '' ? [] : [answer.value];
                const selected = choices.find(function chosenOption(choice) { return choice.radio.checked; });
                return selected ? [selected.answer] : [];
            }});
            form.append(field);
        }
        form.append(element('p', 'pm-muted', 'Unanswered questions will be left unanswered.'));
        const send = element('button', 'arcane-button', 'Send answers');
        send.type = 'submit';
        form.append(send);
        record.controls.push({node: send});
        form.addEventListener('submit', function answerCodexQuestions(event) {
            event.preventDefault();
            const entries = readers.map(function collectQuestionAnswer(reader) {
                return [reader.id, {answers: reader.read()}];
            });
            sendResponse(record, {answers: Object.fromEntries(entries)});
        }, {signal: pageSignal});
        record.content.append(form);
    }

    async function sendResponse(record, result) {
        if (!active() || record.retired || record.sending || record.responseState !== 'pending'
            || !current.capabilities?.respondToRequest || (result.decision === 'accept' && !record.reviewable)) return;
        record.sending = true;
        record.failureMessage = '';
        syncControls(record);
        report('Sending your response to Codex…');
        try {
            const outcome = await bridge.respondToRequest({
                connectionId: record.connectionId, requestId: record.frame.id, result, signal: pageSignal
            });
            if (!active()) return;
            if (outcome.status === 'sent' && outcome.acknowledgment === 'stdio-write') {
                record.responseState = 'sent';
                for (const input of record.secretInputs) input.value = '';
                report('Response sent. Codex acceptance and execution remain unconfirmed.');
            } else if (outcome.status === 'unavailable') {
                record.responseState = 'unavailable';
                report('Codex is unavailable. Your response was not sent.');
            } else {
                record.responseState = 'unknown';
                console.error('Arcane PM received an unconfirmed Codex response outcome', outcome);
                report('The response outcome is unknown. Open the conversation in Codex.');
            }
        } catch (error) {
            console.error('Arcane PM could not confirm the Codex request response', error);
            if (!active()) return;
            if (error.code === 'PM_CODEX_REQUEST_NOT_PENDING' || error.code === 'PM_CODEX_REQUEST_CONNECTION_CHANGED') {
                record.responseState = 'unavailable';
                report('This request is no longer available on the current connection.');
            } else if (error.code === 'PM_CODEX_DISCONNECTED' || error.code === 'PM_CODEX_REQUEST_ABORTED') {
                record.responseState = 'pending';
                record.failureMessage = 'Your response was not sent. Your entered answer remains here; reconnect before trying again.';
                report(record.failureMessage);
            } else {
                record.responseState = 'unknown';
                report('The response outcome is unknown. Open the conversation in Codex before taking another action.');
            }
        } finally {
            record.sending = false;
            if (active()) syncControls(record);
        }
    }

    function receiveNotification(frame) {
        if (!active()) return;
        const params = frame.params;
        if (frame.method === 'serverRequest/resolved') {
            const record = requests.get(params.requestId);
            if (record) {
                record.article.remove();
                requests.delete(params.requestId);
                displayedRequests.delete(record);
                for (const input of record.secretInputs) input.value = '';
                renderSummary();
            }
        } else if (frame.method === 'thread/archived' || frame.method === 'thread/deleted') {
            for (const [requestId, record] of requests) {
                const threadId = record.frame.params?.threadId ?? record.frame.params?.conversationId;
                if (threadId !== params.threadId) continue;
                record.article.remove();
                requests.delete(requestId);
                displayedRequests.delete(record);
                for (const input of record.secretInputs) input.value = '';
            }
            for (const [key, item] of fileItems) {
                if (item.params.threadId === params.threadId) fileItems.delete(key);
            }
            renderSummary();
        } else if (frame.method === 'turn/completed') {
            for (const [key, item] of fileItems) {
                if (item.params.threadId === params.threadId && item.params.turnId === params.turn?.id) fileItems.delete(key);
            }
        } else if (frame.method === 'item/started' && params?.item?.type === 'fileChange') {
            const key = itemKey(params.threadId, params.turnId, params.item.id);
            fileItems.set(key, frame);
            for (const record of requests.values()) {
                const request = record.frame.params;
                if (record.frame.method === 'item/fileChange/requestApproval'
                    && itemKey(request.threadId, request.turnId, request.itemId) === key) renderFiles(record);
            }
        }
    }

    function dispose() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        for (const stop of stops) stop();
        for (const record of displayedRequests) {
            for (const input of record.secretInputs) input.value = '';
        }
        requests.clear();
        displayedRequests.clear();
        fileItems.clear();
        root.remove();
    }

    if (pageSignal.aborted) dispose();
    else {
        stops.push(bridge.observeRequests(receiveRequest, {signal: pageSignal}));
        stops.push(bridge.observeNotifications(receiveNotification, {signal: pageSignal}));
        stops.push(bridge.subscribe(receiveState, {signal: pageSignal}));
        pageSignal.addEventListener('abort', dispose, {once: true});
    }
    return {dispose};
}
