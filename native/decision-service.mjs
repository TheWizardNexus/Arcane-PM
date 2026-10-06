import {createNativeDecisionService} from 'arcane-os/core/decisions';
import {CoreError} from 'arcane-os/core/contracts';

/** PM selects prepared Laya files; the SDK owns their native execution. */
export function createPMDecisionService(options = {}, {appRoot, signal} = {}) {
    const lifetime = new AbortController();
    let context;
    let engine = createEngine();
    let authoritativeEngine = engine;
    let retainedSnapshot = engine.current();
    let selection = {engine, use: null, releasing: null};
    let loading;
    let unloading;
    let closing;

    function createEngine(paths) {
        return createNativeDecisionService(
            {
                name: 'pm.decisions',
                model: 'onnx-community/laya-typed-decisions-ONNX',
                revision: 'main',
                dtype: 'fp32',
                paths,
                sessionOptions: options.sessionOptions,
                executionPreference: options.executionPreference
            },
            {appRoot}
        );
    }

    function current() {
        return authoritativeEngine?.current() ?? retainedSnapshot;
    }

    function startEngine(selectedEngine) {
        selectedEngine.start(
            {
                ...context,
                emit: function emitDecisionState(event, snapshot) {
                    if (event === 'decisions.state') {
                        if (selectedEngine !== authoritativeEngine) return;
                        retainedSnapshot = snapshot;
                        context.emit('pm.decisions.state', snapshot);
                        return;
                    }
                    context.emit(event, snapshot);
                }
            }
        );
    }

    function start(serviceContext) {
        context = serviceContext;
        startEngine(engine);
    }

    function cancellation(message) {
        return new CoreError(
            {name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message}
        );
    }

    function releaseSelection(selected) {
        if (selected.releasing) return selected.releasing;
        selected.releasing = Promise.resolve().then(
            async function releasePreparedSelection() {
                // Rejected work alone does not establish native worker exit.
                await selected.engine?.unload();
                await selected.use?.release();
                selected.use = null;
            }
        );
        return selected.releasing;
    }

    async function retireSelection(selected, {replacement = false} = {}) {
        await releaseSelection(selected);
        if (replacement && selected.engine && selected.engine === authoritativeEngine) {
            // The unloaded selection remains the last authoritative snapshot.
            // Disposing its replaced SDK instance does not close the PM service.
            retainedSnapshot = selected.engine.current();
            authoritativeEngine = null;
        }
        await selected.engine?.dispose();
        selected.unsubscribe?.();
    }

    function observeLoad(operation, callerSignal) {
        function cancelLoad() {
            operation.controller.abort(callerSignal.reason);
        }

        callerSignal?.addEventListener(
            'abort', cancelLoad,
            {once: true}
        );
        if (callerSignal?.aborted) cancelLoad();
        return operation.promise.finally(
            function detachLoadCaller() {
                callerSignal?.removeEventListener('abort', cancelLoad);
            }
        );
    }

    function load({assetProjectionId}, request) {
        lifetime.signal.throwIfAborted();
        request.signal.throwIfAborted();
        if (!context) {
            throw new CoreError(
                {code: 'CORE_NOT_READY', message: 'Start the PM decision service before loading.'}
            );
        }
        if (loading && loading.id === assetProjectionId && !loading.controller.signal.aborted && !unloading) {
            return observeLoad(loading, request.signal);
        }
        if (!loading && !unloading && selection.id === assetProjectionId && current().loaded) {
            return Promise.resolve(
                current()
            );
        }

        const previous = loading;
        const precedingUnload = unloading;
        const operation = {id: assetProjectionId, controller: new AbortController(), selected: null};
        const operationSignal = AbortSignal.any(
            [lifetime.signal, operation.controller.signal]
        );
        loading = operation;
        async function loadPreparedSelection() {
            // Replacements share one native activation and join its actual cleanup.
            if (previous) {
                await Promise.allSettled(
                    [previous.promise]
                );
            }
            if (precedingUnload) await precedingUnload;
            operationSignal.throwIfAborted();
            await retireSelection(
                selection,
                {replacement: true}
            );
            operationSignal.throwIfAborted();
            const modelAssets = await context.getService('model-assets');
            operationSignal.throwIfAborted();
            const use = modelAssets.retain(assetProjectionId);
            const selected = {id: assetProjectionId, use, engine: null, releasing: null};
            operation.selected = selected;
            selection = selected;
            const files = new Map(
                use.members.map(
                    function nativeMember(member) {
                        return [member.path, member.nativePath];
                    }
                )
            );
            for (const member of ['onnx/model.onnx', 'onnx/model.onnx_data', 'tokenizer.json', 'tokenizer_config.json']) {
                if (!files.has(member)) {
                    throw new CoreError(
                        {
                            code: 'PM_DECISION_ASSET_MISSING',
                            message: 'The selected Laya projection is missing a required model member.',
                            member
                        }
                    );
                }
            }
            selected.engine = createEngine(
                {
                    model: files.get('onnx/model.onnx'),
                    tokenizer: files.get('tokenizer.json'),
                    tokenizerConfig: files.get('tokenizer_config.json')
                }
            );
            engine = selected.engine;
            authoritativeEngine = engine;
            retainedSnapshot = engine.current();
            selected.unsubscribe = engine.subscribe(
                function observeNativeRelease(snapshot) {
                    if (!snapshot.loaded && ['unloading', 'error'].includes(snapshot.state)) {
                        // SDK cancellation and terminal native failures also own
                        // real cleanup, even without a later PM unload request.
                        releaseSelection(selected).catch(reportCleanupFailure);
                    }
                },
                {emitCurrent: false}
            );
            startEngine(engine);
            await engine.load(
                {signal: operationSignal}
            );
            operationSignal.throwIfAborted();
            return current();
        }

        async function loadFailed(error) {
            if (operation.selected) {
                try {
                    await releaseSelection(operation.selected);
                } catch (cleanupError) {
                    throw new AggregateError(
                        [error, cleanupError],
                        'Loading and releasing the PM decision model failed.'
                    );
                }
            }
            throw error;
        }

        function loadSettled() {
            if (loading === operation) loading = undefined;
        }

        operation.promise = Promise.resolve().then(loadPreparedSelection).catch(loadFailed);
        operation.promise.then(loadSettled, loadSettled);
        previous?.controller.abort(
            cancellation('A new PM decision selection replaced the pending load.')
        );
        return observeLoad(operation, request.signal);
    }

    async function evaluate(parameters, request) {
        lifetime.signal.throwIfAborted();
        request.signal.throwIfAborted();
        if (loading) await observeLoad(loading, request.signal);
        request.signal.throwIfAborted();
        // Keep the SDK RPC tensor codec and the original tracked Core request.
        return engine.methods['decisions.evaluate'](parameters, request);
    }

    function unload() {
        const acceptedLoad = loading;
        if (!unloading) {
            unloading = Promise.resolve().then(
                async function unloadPreparedSelection() {
                    if (acceptedLoad) {
                        await Promise.allSettled(
                            [acceptedLoad.promise]
                        );
                    }
                    await releaseSelection(selection);
                    return current();
                }
            );

            function unloadSettled() {
                unloading = undefined;
            }

            unloading.then(unloadSettled, unloadSettled);
        }
        acceptedLoad?.controller.abort(
            cancellation('The PM decision model was unloaded.')
        );
        return unloading;
    }

    function dispose() {
        if (closing) return closing;
        const acceptedLoad = loading;
        const acceptedUnload = unloading;
        closing = Promise.resolve().then(
            async function closePreparedSelection() {
                if (acceptedLoad) {
                    await Promise.allSettled(
                        [acceptedLoad.promise]
                    );
                }
                if (acceptedUnload) await acceptedUnload;
                await retireSelection(selection);
                if (!authoritativeEngine) {
                    authoritativeEngine = engine;
                    retainedSnapshot = engine.current();
                    context?.emit('pm.decisions.state', retainedSnapshot);
                }
            }
        );
        signal?.removeEventListener('abort', lifetimeAborted);
        lifetime.abort(
            cancellation('The PM decision service is closing.')
        );
        return closing;
    }

    function lifetimeAborted() {
        dispose().catch(reportCleanupFailure);
    }

    function reportCleanupFailure(error) {
        console.error('Releasing the PM decision model failed.', error);
    }

    signal?.addEventListener(
        'abort', lifetimeAborted,
        {once: true}
    );
    if (signal?.aborted) lifetimeAborted();

    return {
        name: 'pm.decisions',
        start,
        current,
        dispose,
        methods: {
            'pm.decisions.status': current,
            'pm.decisions.load': load,
            'pm.decisions.evaluate': evaluate,
            'pm.decisions.unload': {lifetime: 'service', handle: unload}
        }
    };
}

export default createPMDecisionService;
