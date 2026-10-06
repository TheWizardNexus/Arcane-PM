import {createNativeDecisionService} from 'arcane-os/core/decisions';
import {CoreError} from 'arcane-os/core/contracts';

/** PM selects prepared model files; the SDK owns their native execution. */
export function createPMDecisionService(options = {}, {appRoot, signal} = {}) {
    const engine = createNativeDecisionService(
        {
            name: 'pm.decisions',
            sessionOptions: options.sessionOptions,
            executionPreference: options.executionPreference
        },
        {appRoot}
    );
    let loading;

    function start(context) {
        engine.start(
            {
                ...context,
                emit: function emitDecisionState(event, snapshot) {
                    context.emit(event === 'decisions.state' ? 'pm.decisions.state' : event, snapshot);
                }
            }
        );
    }

    function observeLoad(operation, callerSignal) {
        function cancelLoad() {
            operation.controller.abort(callerSignal.reason);
        }

        callerSignal?.addEventListener('abort', cancelLoad, {once: true});
        if (callerSignal?.aborted) cancelLoad();
        return operation.promise.finally(
            function detachLoadCaller() {
                callerSignal?.removeEventListener('abort', cancelLoad);
            }
        );
    }

    function load(
        {
            family = 'laya',
            model = 'onnx-community/laya-typed-decisions-ONNX',
            revision = 'main',
            dtype = 'fp32',
            assetProjectionId,
            resourcePaths = {
                model: 'onnx/model.onnx',
                tokenizer: 'tokenizer.json',
                tokenizerConfig: 'tokenizer_config.json'
            },
            executionTarget
        },
        request
    ) {
        request.signal.throwIfAborted();
        if (assetProjectionId == null) {
            throw new CoreError(
                {code: 'PM_DECISION_PROJECTION_REQUIRED', message: 'Prepare the selected model assets before loading.'}
            );
        }
        const controller = new AbortController();
        const operation = {
            controller,
            promise: engine.load(
                {
                    family, model, revision, dtype, assetProjectionId, resourcePaths, executionTarget,
                    signal: AbortSignal.any([request.signal, controller.signal])
                }
            )
        };
        loading = operation;

        function loadSettled() {
            if (loading === operation) loading = undefined;
        }

        operation.promise.then(loadSettled, loadSettled);
        return operation.promise;
    }

    async function evaluate(parameters, request) {
        request.signal.throwIfAborted();
        if (loading) await observeLoad(loading, request.signal);
        request.signal.throwIfAborted();
        // Preserve the SDK RPC tensor codec and the original tracked Core request.
        return engine.methods['decisions.evaluate'](parameters, request);
    }

    function dispose() {
        signal?.removeEventListener('abort', lifetimeAborted);
        return engine.dispose();
    }

    function lifetimeAborted() {
        dispose().catch(reportCleanupFailure);
    }

    function reportCleanupFailure(error) {
        console.error('Releasing the PM decision model failed.', error);
    }

    signal?.addEventListener('abort', lifetimeAborted, {once: true});
    if (signal?.aborted) lifetimeAborted();

    return {
        name: 'pm.decisions',
        start,
        current: engine.current,
        dispose,
        methods: {
            'pm.decisions.status': engine.current,
            'pm.decisions.load': load,
            'pm.decisions.evaluate': evaluate,
            'pm.decisions.unload': engine.methods['decisions.unload']
        }
    };
}

export default createPMDecisionService;
