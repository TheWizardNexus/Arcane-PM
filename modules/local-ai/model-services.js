import {createArcaneEventSource} from 'arcane-os/event-manager';
import {getInstalledCoreClient} from 'arcane-os/core/client';
import {createCoreLocalAIProvider} from 'arcane-os/ai/core-local';
import {createCoreONNXRuntime} from 'arcane-os/ai/core-onnx';
import {createCoreImageRuntime} from 'arcane-os/ai/core-image';
import {prepareCoreModelAssets} from 'arcane-os/ai/core-model-assets';
import {getAIProviderRuntime} from 'arcane-os/ai-provider-runtime';
import {subscribeAIRuntimeState} from 'arcane-os/ai-runtime-state';
import {
    createArcaneAI,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';

const BROWSER_PROVIDER = 'arcane-browser-wasm-wllama';
const OLLAMA_LIFECYCLE_MESSAGE = 'Ollama model loading is unavailable in this SDK version.';

function serviceError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * PM's explicit model selection and shared SDK composition. Importing and
 * creating this owner starts no model download, installation or inference.
 * Complete model originals remain in the data owner's DBOPFS instance.
 */
export function createPMModelServices(
    {getStorage, signal, client = null} = {}
) {
    const owner = {};
    const events = createArcaneEventSource(
        owner,
        {source: 'pm-model-services', eventTypes: ['pm.models.changed']}
    );
    const lifetime = new AbortController();
    const lifetimeSignal = signal
        ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const providerRuntime = getAIProviderRuntime();
    let coreClient = client;
    let coreState = null;
    let coreRevision = 0;
    let stopCore = null;
    let selection = null;
    let activeAI = null;
    let routedAI = null;
    let browserProvider = null;
    let coreProvider = null;
    let unregisterCore = null;
    let stopBrowser = null;
    let stopBrowserProgress = null;
    let storePromise = null;
    let imageRuntime = null;
    let onnxRuntime = null;
    let selectedError = null;
    let closed = false;
    let eventsDisposed = false;
    let selecting = false;
    let selectionRevision = 0;
    let selectionSettled = Promise.resolve();
    let closing = null;
    const projections = new Set();

    function operationSignal(requestSignal) {
        return requestSignal
            ? AbortSignal.any([lifetimeSignal, requestSignal]) : lifetimeSignal;
    }

    function assertOpen() {
        lifetimeSignal.throwIfAborted();
        if (closed) {
            throw serviceError('PM_MODELS_CLOSED', 'The project model owner is closed.');
        }
    }

    function runtimeRecord(id) {
        return coreState?.runtimes?.find(
            function matchesRuntime(record) {
                return record.id === id;
            }
        ) ?? null;
    }

    function selectedNativeModel() {
        const id = selection?.providerId === 'OLLAMA' ? 'ollama' : 'llama.cpp';
        return runtimeRecord(id)?.models?.find(
            function matchesSelectedModel(model) {
                return model.id === selection?.modelId;
            }
        ) ?? null;
    }

    function catalog() {
        const result = [];
        for (const record of coreState?.runtimes ?? []) {
            if (record.id === 'llama.cpp' || record.id === 'ollama') {
                result.push(
                    {
                        providerId: record.id === 'ollama' ? 'OLLAMA' : record.id,
                        localOnly: true,
                        models: record.models ?? []
                    }
                );
            }
        }
        if (browserProvider) {
            result.push(
                {providerId: BROWSER_PROVIDER, localOnly: true, models: browserProvider.catalog()}
            );
        }
        if (selection?.providerId === 'TWIN') {
            result.push(
                {providerId: 'TWIN', localOnly: false, models: [{id: selection.modelId}]}
            );
        }
        return result;
    }

    function getStatus() {
        let model = null;
        if (selection) {
            const underlying = selection.providerId === BROWSER_PROVIDER
                ? activeAI?.status().llm : providerRuntime.status('llm');
            const matching = selection.providerId === BROWSER_PROVIDER
                ? underlying?.provider === BROWSER_PROVIDER && underlying?.model?.id === selection.modelId
                : (underlying?.providerId === selection.providerId
                    && underlying?.modelId === selection.modelId);
            const native = selection.providerId === 'OLLAMA'
                || selection.providerId === 'llama.cpp';
            const nativeModel = native ? selectedNativeModel() : null;
            const nativeRuntime = native
                ? runtimeRecord(selection.providerId === 'OLLAMA' ? 'ollama' : 'llama.cpp') : null;
            const nativeLoaded = nativeRuntime?.available === true
                && nativeRuntime.state === 'ready' && nativeModel?.loaded === true;
            const loaded = Boolean(activeAI) && !closed && !selecting && !selectedError
                && selection.providerId !== 'OLLAMA' && matching && underlying?.state === 'ready'
                && underlying.loaded === true && (!native || nativeLoaded);
            let state = underlying?.state ?? 'unloaded';
            if (!matching || state === 'ready') state = 'unloaded';
            if (loaded) state = 'ready';
            if (selectedError) state = 'error';
            if (selection.providerId === 'OLLAMA') state = 'unavailable';
            if (selecting) state = 'unloading';
            if (closed) state = 'disposed';
            model = {
                ...selection,
                state,
                loaded,
                busy: selecting || underlying?.busy === true,
                progress: underlying?.progress ?? null,
                error: selectedError ?? (selection.providerId === 'OLLAMA'
                    ? {code: 'PM_OLLAMA_LIFECYCLE_UNAVAILABLE', message: OLLAMA_LIFECYCLE_MESSAGE}
                    : underlying?.error ?? null),
                ...(native ? {nativeLoaded} : {})
            };
        }
        return {model, catalog: catalog(), core: coreState, closed};
    }

    function publish() {
        const snapshot = getStatus();
        if (!eventsDisposed) {
            events.dispatch('pm.models.changed', snapshot);
        }
        return snapshot;
    }

    function resolveCore() {
        assertOpen();
        coreClient ??= getInstalledCoreClient();
        if (coreClient && !stopCore) {
            stopCore = coreClient.events.on(
                'localai.state',
                function coreModelsChanged(snapshot) {
                    coreState = snapshot;
                    coreRevision += 1;
                    publish();
                }
            );
        }
        return coreClient;
    }

    function requireCore() {
        const selectedClient = resolveCore();
        if (!selectedClient) {
            throw serviceError('PM_CORE_UNAVAILABLE', 'Connect Arcane Core to use native models.');
        }
        return selectedClient;
    }

    async function inspect({signal: requestSignal} = {}) {
        const currentSignal = operationSignal(requestSignal);
        currentSignal.throwIfAborted();
        const selectedClient = resolveCore();
        if (selectedClient) {
            const revision = coreRevision;
            const status = await selectedClient.invoke(
                'localai.status',
                {},
                {signal: currentSignal, timeoutMs: 0}
            );
            currentSignal.throwIfAborted();
            if (revision === coreRevision) {
                coreState = status;
                coreRevision += 1;
            }
        }
        return publish();
    }

    function subscribe(listener, {signal: subscriptionSignal} = {}) {
        const stop = events.on(
            'pm.models.changed',
            function deliverModelState(event) {
                listener(event.detail);
            },
            {signal: subscriptionSignal}
        );
        if (!subscriptionSignal?.aborted) {
            try {
                listener(getStatus());
            } catch (error) {
                stop();
                throw error;
            }
        }
        return stop;
    }

    function getModelStore() {
        assertOpen();
        if (!storePromise) {
            storePromise = Promise.resolve().then(
                async function composeSharedModelStore() {
                    if (typeof getStorage !== 'function') {
                        throw serviceError('PM_STORAGE_UNAVAILABLE', 'Project storage is unavailable.');
                    }
                    const dbopfs = await getStorage();
                    assertOpen();
                    return createDbopfsModelStore(
                        {dbopfs}
                    );
                }
            ).catch(
                function modelStoreUnavailable(error) {
                    storePromise = null;
                    throw error;
                }
            );
        }
        return storePromise;
    }

    async function releaseSelectedAI() {
        stopBrowser?.();
        stopBrowserProgress?.();
        stopBrowser = null;
        stopBrowserProgress = null;
        if (selection?.providerId === BROWSER_PROVIDER && activeAI) {
            await activeAI.dispose();
            browserProvider = null;
        } else if (selection && activeAI) {
            const current = providerRuntime.selection('llm');
            if (current?.providerId === selection.providerId && current.modelId === selection.modelId) {
                await activeAI.transitionProviders(
                    {
                        llm: {default: null, localOnly: null},
                        stt: {default: null, localOnly: null},
                        tts: {default: null, localOnly: null}
                    }
                );
            }
        }
        if (coreProvider) {
            await coreProvider.dispose();
            unregisterCore?.();
            coreProvider = null;
            unregisterCore = null;
        }
        activeAI = null;
    }

    async function select(value, {signal: requestSignal} = {}) {
        assertOpen();
        if (selecting) {
            throw serviceError('PM_MODEL_SELECTION_BUSY', 'A model selection is already changing.');
        }
        const {providerId, modelId, source, twinKey, baseUrl} = value;
        const selectedProvider = providerId === 'browser-wasm' ? BROWSER_PROVIDER : providerId;
        if (!['llama.cpp', 'OLLAMA', 'TWIN', BROWSER_PROVIDER].includes(selectedProvider)) {
            throw serviceError('PM_TEXT_PROVIDER_UNAVAILABLE', 'Select a supported text provider. ONNX tensors and Jev state evaluation require their own supported model pipeline.');
        }
        if (typeof modelId !== 'string' || !modelId.trim()) {
            throw new TypeError('A model selection requires its exact model identifier.');
        }
        if (baseUrl !== undefined) {
            throw serviceError('PM_PROVIDER_ENDPOINT_UNAVAILABLE', 'The published TWiN provider owns its DigitalOcean endpoint.');
        }
        const currentSignal = operationSignal(requestSignal);
        currentSignal.throwIfAborted();
        selecting = true;
        selectionRevision += 1;
        let settleSelection;
        selectionSettled = new Promise(
            function trackModelSelection(resolve) {
                settleSelection = resolve;
            }
        );
        selectedError = null;
        publish();
        try {
            await releaseSelectedAI();
            currentSignal.throwIfAborted();
            selection = {providerId: selectedProvider, modelId, localOnly: selectedProvider !== 'TWIN'};
            if (selectedProvider === BROWSER_PROVIDER) {
                if (source?.id !== modelId) {
                    throw new TypeError('The complete browser model source must identify the selected model.');
                }
                const store = await getModelStore();
                currentSignal.throwIfAborted();
                const modelSource = createBrowserModelSource(source);
                if (modelSource.id !== modelId) {
                    throw new TypeError('The SDK browser source must preserve the exact selected model identifier.');
                }
                browserProvider = createBrowserWasmLlmProvider(
                    {sources: [modelSource], store, loadDefaults: {gpuLayers: 0}}
                );
                activeAI = createArcaneAI(
                    {provider: browserProvider, loadPolicy: 'manual'}
                );
                stopBrowser = activeAI.llm.on('statechange', publish);
                stopBrowserProgress = activeAI.llm.on('progress', publish);
            } else {
                if (selectedProvider === 'llama.cpp') {
                    coreProvider = createCoreLocalAIProvider(
                        {client: requireCore()}
                    );
                    unregisterCore = providerRuntime.register(coreProvider);
                }
                if (!routedAI) {
                    const {default: AI} = await import('arcane-os/ai');
                    currentSignal.throwIfAborted();
                    routedAI = new AI(selectedProvider, '', '', modelId);
                }
                activeAI = routedAI;
                const routes = {
                    llm: {default: selection, localOnly: selection.localOnly ? selection : null},
                    stt: {default: null, localOnly: null},
                    tts: {default: null, localOnly: null}
                };
                await activeAI.transitionProviders(routes);
                currentSignal.throwIfAborted();
                if (selectedProvider === 'TWIN' && twinKey !== undefined) {
                    activeAI.twinKey = twinKey;
                }
                if (selection.localOnly) {
                    await inspect(
                        {signal: currentSignal}
                    );
                }
            }
        } catch (error) {
            selectedError = error;
            throw error;
        } finally {
            selecting = false;
            publish();
            settleSelection();
        }
        return getStatus();
    }

    async function load({signal: requestSignal} = {}) {
        assertOpen();
        if (selecting) {
            throw serviceError('PM_MODEL_SELECTION_BUSY', 'A model selection is already changing.');
        }
        if (!selection || !activeAI) {
            throw serviceError('PM_MODEL_NOT_SELECTED', 'Choose a model before loading it.');
        }
        const currentSignal = operationSignal(requestSignal);
        const revision = selectionRevision;
        selectedError = null;
        try {
            if (selection.providerId === BROWSER_PROVIDER) {
                await activeAI.load(
                    {offline: true, gpuLayers: 0, signal: currentSignal}
                );
            } else {
                if (selection.providerId === 'OLLAMA') {
                    throw serviceError('PM_OLLAMA_LIFECYCLE_UNAVAILABLE', OLLAMA_LIFECYCLE_MESSAGE);
                }
                await providerRuntime.load(
                    'llm',
                    {signal: currentSignal, localOnly: selection.localOnly}
                );
            }
            currentSignal.throwIfAborted();
            return publish();
        } catch (error) {
            if (selectionRevision === revision) {
                selectedError = error;
            }
            publish();
            throw error;
        }
    }

    async function unload({signal: requestSignal} = {}) {
        assertOpen();
        if (selecting) {
            throw serviceError('PM_MODEL_SELECTION_BUSY', 'A model selection is already changing.');
        }
        const currentSignal = operationSignal(requestSignal);
        if (selection?.providerId === BROWSER_PROVIDER && activeAI) {
            await activeAI.unload(
                {signal: currentSignal}
            );
        } else if (selection && activeAI) {
            await providerRuntime.unload(
                'llm',
                {signal: currentSignal}
            );
        }
        return publish();
    }

    function getAI() {
        return activeAI;
    }

    function getImageRuntime() {
        assertOpen();
        imageRuntime ??= createCoreImageRuntime(
            {client: resolveCore(), signal: lifetimeSignal}
        );
        return imageRuntime;
    }

    function getONNXRuntime() {
        assertOpen();
        onnxRuntime ??= createCoreONNXRuntime(
            {client: resolveCore()}
        );
        return onnxRuntime;
    }

    async function prepareImageAssets(
        {source, members, workingDirectory, signal: requestSignal, onProgress} = {}
    ) {
        assertOpen();
        const selectedClient = requireCore();
        const currentSignal = operationSignal(requestSignal);
        let completeMembers = members;
        if (source) {
            const store = await getModelStore();
            const modelSource = createBrowserModelSource(source);
            const stored = await store.ensure(
                modelSource,
                {signal: currentSignal, offline: true, onProgress}
            );
            completeMembers = modelSource.files.map(
                function completeStoredMember(member, index) {
                    return {path: member.name, file: stored.files[index]};
                }
            );
        }
        const projection = await prepareCoreModelAssets(
            {client: selectedClient, workingDirectory, members: completeMembers, signal: currentSignal, onProgress}
        );
        if (currentSignal.aborted) {
            await projection.release();
            currentSignal.throwIfAborted();
        }
        projections.add(projection);
        return projection;
    }

    function dispose() {
        if (closing) {
            return closing;
        }
        closed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        lifetime.abort();
        stopRuntime();
        stopCore?.();
        closing = Promise.resolve().then(
            async function releasePMModelServices() {
                await selectionSettled;
                const operations = [releaseSelectedAI()];
                if (imageRuntime) {
                    operations.push(imageRuntime.close());
                }
                if (onnxRuntime) {
                    operations.push(onnxRuntime.close());
                }
                for (const projection of projections) {
                    operations.push(projection.release());
                }
                const results = await Promise.allSettled(operations);
                projections.clear();
                publish();
                events.dispose();
                eventsDisposed = true;
                const failures = results.filter(
                    function cleanupFailed(result) {
                        return result.status === 'rejected';
                    }
                );
                if (failures.length) {
                    throw new AggregateError(
                        failures.map(
                            function cleanupReason(result) {
                                return result.reason;
                            }
                        ),
                        'Project model cleanup could not finish.'
                    );
                }
            }
        );
        closing.catch(
            function reportPMModelCleanup(error) {
                globalThis.console?.error('Arcane PM model cleanup failed.', error);
            }
        );
        return closing;
    }

    const stopRuntime = subscribeAIRuntimeState(
        function sdkModelStateChanged() {
            if (selection?.providerId !== BROWSER_PROVIDER) {
                publish();
            }
        },
        {signal: lifetimeSignal, emitCurrent: true}
    );
    lifetimeSignal.addEventListener(
        'abort',
        dispose,
        {once: true}
    );
    if (lifetimeSignal.aborted) {
        dispose();
    }

    return {
        current: getStatus,
        getStatus,
        subscribe,
        inspect,
        catalog,
        select,
        load,
        unload,
        getAI,
        getModelStore,
        getImageRuntime,
        prepareImageAssets,
        getONNXRuntime,
        dispose
    };
}
