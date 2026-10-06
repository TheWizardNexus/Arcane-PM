import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {hostname} from 'node:os';
import {CoreError, serializeCoreError} from 'arcane-os/core/contracts';

/** One PM-owned Codex stdio connection. Core owns the application's transport. */
export class CodexAppServer {
    constructor({command = 'codex', args = ['app-server', '--listen', 'stdio://'], cwd} = {}) {
        this.command = command;
        this.args = args;
        this.cwd = cwd;
        this.hostName = hostname();
        this.child = null;
        this.connection = 0;
        this.requestSequence = 0;
        this.pending = new Map();
        this.nativeRequests = new Map();
        this.fileChanges = new Map();
        this.writeQueue = Promise.resolve();
        this.connecting = null;
        this.connectionWanted = false;
        this.closing = null;
        this.emitter = null;
        this.account = null;
        this.accountKnown = false;
        this.accountRefresh = null;
        this.accountRevision = 0;
        this.state = 'disconnected';
        this.message = 'Connect Codex to read and send work.';
        this.processExit = null;
        this.connectionFailure = null;
    }

    setEmitter(emit) {
        this.emitter = emit;
    }

    emit(event, data) {
        this.emitter?.(event, data);
    }

    diagnostic(operation, error, details = {}) {
        this.emit('pm.codex.diagnostic', {
            operation,
            error: serializeCoreError(error),
            ...details,
            observedAt: new Date().toISOString()
        });
    }

    current() {
        const connected = this.state === 'connected';
        return {
            state: this.state,
            connected,
            available: true,
            message: this.message,
            connectionId: this.connection,
            originIdentity: this.identity(),
            host: {name: this.hostName, processId: this.child?.pid ?? null},
            closing: Boolean(this.closing),
            capabilities: {
                listProjects: connected,
                listThreads: connected,
                readConversation: connected,
                readThread: connected,
                readDirectory: connected,
                readFile: connected,
                getFileMetadata: connected,
                resumeThread: connected,
                createTask: connected,
                continueTask: connected,
                sendHandoff: connected,
                archiveThread: connected,
                restoreThread: connected,
                cancelTurn: connected,
                respondToRequest: connected,
                deleteThread: false,
                openThread: true,
                savedProjectRegistry: false
            },
            account: this.account,
            accountKnown: this.accountKnown,
            processId: this.child?.pid ?? null,
            processExit: this.processExit,
            pendingRequests: [...this.nativeRequests.values()].map(function requestSummary(record) {
                return {
                    requestId: record.frame.id, method: record.frame.method,
                    threadId: record.frame.params?.threadId ?? null, responseState: record.responseState
                };
            }),
            observedAt: new Date().toISOString()
        };
    }

    identity() {
        const accountId = this.account?.workspaceRouting?.chatgptAccountId;
        if (!this.accountKnown || !accountId) return null;
        return {provider: 'codex', accountId, hostId: this.hostName};
    }

    publishState(state, message) {
        this.state = state;
        this.message = message;
        this.emit('pm.codex.state', this.current());
    }

    replayRequests() {
        const replayed = new Set();
        for (const record of this.nativeRequests.values()) {
            const params = record.frame.params;
            const key = JSON.stringify([params?.threadId, params?.turnId, params?.itemId]);
            if (this.fileChanges.has(key) && !replayed.has(key)) {
                this.emit('pm.codex.notification', this.fileChanges.get(key));
                replayed.add(key);
            }
        }
        for (const record of this.nativeRequests.values()) this.emit('pm.codex.request', record.frame);
    }

    connect() {
        if (this.state === 'connected' || this.connecting) return this.current();
        if (this.child || this.closing) {
            throw new CoreError({code: 'PM_CODEX_CONNECTION_CLOSING', message: 'The previous Codex connection is still closing.'});
        }
        const owner = this;
        this.connectionWanted = true;
        const operation = Promise.resolve().then(function startOwnedConnection() {
            if (!owner.connectionWanted) return owner.current();
            return owner.openConnection();
        });
        this.connecting = operation;
        this.publishState('connecting', 'Connecting to Codex…');
        function releaseConnectionAttempt() {
            if (owner.connecting === operation) owner.connecting = null;
        }
        operation.then(releaseConnectionAttempt, releaseConnectionAttempt);
        // The retained task publishes its own completion or full error. Returning
        // now lets Core disposal close the child even if initialization stalls.
        return this.current();
    }

    async openConnection() {
        const owner = this;
        this.connection += 1;
        this.processExit = null;
        this.connectionFailure = null;
        this.account = null;
        this.accountKnown = false;
        let child;
        try {
            child = spawn(this.command, this.args, {
                cwd: this.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                shell: false
            });
            this.child = child;
            const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function receiveCodexDiagnostic(content) {
                owner.emit('pm.codex.diagnostic', {operation: 'stderr', content, observedAt: new Date().toISOString()});
            });
            lines.on('line', function receiveCodexLine(line) {
                owner.receiveLine(line);
            });
            child.stdin.on('error', function reportCodexInputFailure(error) {
                owner.failConnection(error);
            });
            child.stdout.on('error', function reportCodexOutputFailure(error) {
                owner.failConnection(error);
            });
            child.stderr.on('error', function reportCodexDiagnosticFailure(error) {
                owner.diagnostic('stderr', error);
            });
            child.on('error', function reportCodexProcessFailure(error) {
                owner.failConnection(error);
            });
            this.closed = new Promise(function observeCodexClose(resolve) {
                child.once('close', function finishCodexConnection(code, signal) {
                    lines.close();
                    const expected = Boolean(owner.closing);
                    owner.processExit = {code, signal};
                    owner.child = null;
                    owner.account = null;
                    owner.accountKnown = false;
                    const error = new CoreError({
                        code: 'PM_CODEX_CONNECTION_CLOSED',
                        message: 'The Codex connection closed.',
                        processExit: {code, signal}
                    });
                    owner.rejectPending(error);
                    if (owner.nativeRequests.size) {
                        owner.diagnostic('native-requests-disconnected', error, {
                            requests: [...owner.nativeRequests.values()].map(function originalRequest(record) { return record.frame; })
                        });
                    }
                    owner.nativeRequests.clear();
                    owner.fileChanges.clear();
                    const cleanExit = expected && code === 0 && !owner.connectionFailure;
                    owner.publishState(cleanExit ? 'disconnected' : 'error',
                        cleanExit ? 'Codex disconnected.' : 'The Codex connection ended. Reconnect when ready.');
                    resolve({code, signal});
                });
            });
            await this.request('initialize', {
                clientInfo: {name: 'arcane_pm', title: 'Arcane PM', version: '0.1.0'},
                capabilities: {experimentalApi: true}
            }, {initializing: true});
            await this.write({method: 'initialized', params: {}});
            if (this.child !== child || this.closing || this.state === 'error') {
                throw new CoreError({code: 'PM_CODEX_CONNECTION_CLOSED', message: 'Codex disconnected while connecting.'});
            }
            this.publishState('connected', 'Codex connected.');
            this.refreshAccount().catch(function reportInitialAccountObservationFailure(error) {
                owner.diagnostic('account-observation', error);
            });
            return this.current();
        } catch (error) {
            if (!this.connectionWanted) return this.current();
            this.failConnection(error);
            throw error;
        }
    }

    refreshAccount() {
        this.accountRevision += 1;
        if (this.accountRefresh) return this.accountRefresh;
        const owner = this;
        const operation = readAccountChanges();
        this.accountRefresh = operation;
        function releaseAccountRead() {
            if (owner.accountRefresh === operation) owner.accountRefresh = null;
        }
        operation.then(releaseAccountRead, releaseAccountRead);
        return operation;

        async function readAccountChanges() {
            let revision;
            do {
                revision = owner.accountRevision;
                try {
                    const result = await owner.request('account/read', {refreshToken: false}, {initializing: true});
                    owner.account = result;
                    owner.accountKnown = true;
                } catch (error) {
                    owner.account = null;
                    owner.accountKnown = false;
                    owner.diagnostic('account/read', error);
                }
            } while (owner.child && !owner.closing && revision !== owner.accountRevision);
            owner.emit('pm.codex.state', owner.current());
        }
    }

    receiveLine(line) {
        let frame;
        try {
            frame = JSON.parse(line);
        } catch (error) {
            this.diagnostic('protocol-parse', error, {content: line});
            this.failConnection(error);
            return;
        }
        if (frame && Object.hasOwn(frame, 'id') && typeof frame.method === 'string') {
            if (!this.nativeRequests.has(frame.id)) this.nativeRequests.set(frame.id, {frame, responseState: 'pending'});
            this.emit('pm.codex.request', frame);
            this.emit('pm.codex.state', this.current());
            return;
        }
        if (frame && Object.hasOwn(frame, 'id')) {
            const pending = this.pending.get(frame.id);
            if (!pending) {
                this.emit('pm.codex.diagnostic', {operation: 'uncorrelated-response', frame, observedAt: new Date().toISOString()});
                return;
            }
            this.pending.delete(frame.id);
            pending.signal?.removeEventListener('abort', pending.onAbort);
            if (pending.abandoned) {
                this.emit('pm.codex.diagnostic', {
                    operation: 'response-after-cancellation', method: pending.method, frame,
                    observedAt: new Date().toISOString()
                });
                return;
            }
            if (Object.hasOwn(frame, 'error')) {
                pending.reject(new CoreError({...frame.error, method: pending.method, response: frame}));
            } else if (Object.hasOwn(frame, 'result')) {
                pending.resolve(frame.result);
            } else {
                const error = new CoreError({code: 'PM_CODEX_RESPONSE_INVALID', message: 'Codex returned a response without a result or error.', frame});
                pending.reject(pending.mutation ? unknownOutcome(pending.method, pending.id, error) : error);
            }
            return;
        }
        if (frame && typeof frame.method === 'string') {
            if (frame.method === 'item/started' && frame.params?.item?.type === 'fileChange') {
                const {threadId, turnId, item} = frame.params;
                this.fileChanges.set(JSON.stringify([threadId, turnId, item.id]), frame);
            }
            if (frame.method === 'serverRequest/resolved') {
                this.nativeRequests.delete(frame.params?.requestId);
                this.emit('pm.codex.state', this.current());
            }
            if (frame.method === 'turn/completed') {
                for (const [key, change] of this.fileChanges) {
                    if (change.params.threadId === frame.params?.threadId && change.params.turnId === frame.params?.turn?.id) {
                        this.fileChanges.delete(key);
                    }
                }
            }
            this.emit('pm.codex.notification', frame);
            if (frame.method === 'account/updated') {
                const owner = this;
                this.account = null;
                this.accountKnown = false;
                this.emit('pm.codex.state', this.current());
                this.refreshAccount().catch(function reportAccountObservationFailure(error) {
                    owner.diagnostic('account-observation', error);
                });
            }
            return;
        }
        this.diagnostic('protocol-frame', new CoreError({
            code: 'PM_CODEX_FRAME_INVALID', message: 'Codex returned an unrecognized protocol frame.', frame
        }));
    }

    request(method, params, {signal, mutation = false, initializing = false} = {}) {
        if (signal?.aborted) return Promise.reject(abortedRequest(method, false, signal.reason));
        if (!this.child || this.closing || (!initializing && this.state !== 'connected')) {
            return Promise.reject(new CoreError({code: 'PM_CODEX_DISCONNECTED', message: 'Connect Codex before this operation.'}));
        }
        const owner = this;
        const id = `arcane-pm-${this.connection}-${++this.requestSequence}`;
        let record;
        const result = new Promise(function awaitCodexResult(resolve, reject) {
            record = {id, method, resolve, reject, signal, mutation, written: false, abandoned: false};
            record.onAbort = function cancelCodexRequest() {
                if (!owner.pending.has(id)) return;
                record.abandoned = true;
                signal.removeEventListener('abort', record.onAbort);
                if (!record.written) owner.pending.delete(id);
                reject(abortedRequest(method, mutation && record.written, signal.reason, id));
            };
            owner.pending.set(id, record);
            signal?.addEventListener('abort', record.onAbort, {once: true});
        });
        this.write({id, method, params}, record).catch(function rejectCodexWrite(error) {
            if (!owner.pending.has(id)) return;
            owner.pending.delete(id);
            signal?.removeEventListener('abort', record.onAbort);
            record.reject(mutation && record.written ? unknownOutcome(method, id, error) : error);
        });
        return result;
    }

    write(frame, request) {
        let source;
        try {
            source = JSON.stringify(frame, protocolValue) + '\n';
        } catch (error) {
            return Promise.reject(error);
        }
        const owner = this;
        const child = this.child;
        const operation = this.writeQueue.then(function writeNextCodexFrame() {
            if (request?.abandoned || request?.signal?.aborted) {
                throw abortedRequest(request.method, false, request.signal?.reason, request.id);
            }
            if (!child || child !== owner.child || child.stdin.destroyed || child.stdin.writableEnded) {
                throw new CoreError({code: 'PM_CODEX_DISCONNECTED', message: 'The Codex input connection is closed.'});
            }
            return new Promise(function awaitCodexWrite(resolve, reject) {
                if (request) request.written = true;
                child.stdin.write(source, 'utf8', function finishCodexWrite(error) {
                    if (error) reject(error);
                    else resolve();
                });
            });
        });
        // Only writes serialize: each frame must finish before the next one.
        function advanceCodexWriter() { return undefined; }
        this.writeQueue = operation.then(advanceCodexWriter, advanceCodexWriter);
        return operation;
    }

    async respond({requestId, connectionId, result, error}, {signal} = {}) {
        signal?.throwIfAborted();
        if (connectionId !== undefined && connectionId !== this.connection) {
            throw new CoreError({code: 'PM_CODEX_REQUEST_CONNECTION_CHANGED', message: 'That request belongs to an earlier Codex connection.'});
        }
        const pending = this.nativeRequests.get(requestId);
        if (!pending) throw new CoreError({code: 'PM_CODEX_REQUEST_NOT_PENDING', message: 'That Codex request is no longer pending.'});
        if (pending.responseState !== 'pending') throw new CoreError({code: 'PM_CODEX_REQUEST_RESPONDING', message: 'A response to that Codex request has already been submitted.'});
        if (result === undefined && error === undefined) throw new TypeError('Supply the native request result or error.');
        if (result !== undefined && error !== undefined) throw new TypeError('Supply either a result or an error.');
        pending.responseState = 'sending';
        this.emit('pm.codex.state', this.current());
        const frame = error === undefined ? {id: requestId, result} : {id: requestId, error};
        const delivery = {id: requestId, method: pending.frame.method, signal, written: false};
        try {
            await this.write(frame, delivery);
            if (signal?.aborted) throw unknownOutcome(pending.frame.method, requestId, signal.reason);
            pending.responseState = 'sent';
            this.emit('pm.codex.state', this.current());
            return {status: 'sent', requestId, acknowledgment: 'stdio-write', acceptedByCodex: null, sentAt: new Date().toISOString()};
        } catch (cause) {
            // No destination response acknowledges a server-request reply.
            // Retain its owner and prevent a second send with an unknown outcome.
            pending.responseState = delivery.written ? 'unknown' : 'pending';
            this.emit('pm.codex.state', this.current());
            throw delivery.written ? unknownOutcome(pending.frame.method, requestId, cause) : cause;
        }
    }

    rejectPending(error) {
        for (const record of this.pending.values()) {
            record.signal?.removeEventListener('abort', record.onAbort);
            if (!record.abandoned) record.reject(record.mutation && record.written
                ? unknownOutcome(record.method, record.id, error) : error);
            record.abandoned = true;
        }
        this.pending.clear();
    }

    failConnection(error) {
        this.connectionFailure = error;
        this.rejectPending(error);
        this.diagnostic('connection', error);
        this.publishState('error', 'Codex connection unavailable. Reconnect when ready.');
        if (this.child && !this.closing) {
            const owner = this;
            this.disconnect().catch(function reportFailedConnectionDrain(drainError) {
                owner.diagnostic('connection-drain', drainError);
            });
        }
    }

    disconnect() {
        this.connectionWanted = false;
        if (this.closing) return this.closing;
        if (!this.child) {
            this.publishState('disconnected', 'Codex disconnected.');
            return Promise.resolve(this.current());
        }
        const owner = this;
        const child = this.child;
        const operation = closeOwnedConnection();
        this.closing = operation;
        this.publishState('disconnected', 'Closing the Codex connection…');
        for (const [id, record] of this.pending) {
            if (record.written) continue;
            record.abandoned = true;
            record.signal?.removeEventListener('abort', record.onAbort);
            record.reject(new CoreError({code: 'PM_CODEX_DISCONNECTED', message: 'Codex disconnected before this request was sent.'}));
            this.pending.delete(id);
        }
        return operation;

        async function closeOwnedConnection() {
            try {
                await owner.writeQueue;
                if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
                const exit = await owner.closed;
                if (exit.code !== 0) {
                    throw new CoreError({code: 'PM_CODEX_EXIT_FAILED', message: 'The Codex process ended without a successful exit.', processExit: exit});
                }
            } finally {
                if (owner.closing === operation) owner.closing = null;
                owner.emit('pm.codex.state', owner.current());
            }
            // Both the event and RPC result describe the completed close.
            return owner.current();
        }
    }
}

function protocolValue(key, value) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
        || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`The supplied ${key || 'request'} value cannot be represented completely by the Codex JSON protocol.`);
    }
    return value;
}

function unknownOutcome(method, requestId, cause) {
    return new CoreError({
        code: 'PM_CODEX_OUTCOME_UNKNOWN',
        message: 'Codex may have accepted this operation. Inspect the destination before sending it again.',
        outcome: 'unknown', method, requestId, cause
    });
}

function abortedRequest(method, unknown, cause, requestId) {
    if (unknown) return unknownOutcome(method, requestId, cause);
    return new CoreError({name: 'AbortError', code: 'PM_CODEX_REQUEST_ABORTED', message: 'The request was cancelled.', method, requestId, cause});
}

export default CodexAppServer;
