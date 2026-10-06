import {createArcaneEventSource} from 'arcane-os/event-manager';
import {getInstalledCoreClient, subscribeCoreClient} from 'arcane-os/core/client';
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
const GRANITE_MODEL = {
    id: 'granite-3b',
    name: 'Granite 4.1 3B',
    files: [
        {
            name: 'granite-4.1-3b-Q4_K_M.gguf',
            url: 'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/main/granite-4.1-3b-Q4_K_M.gguf'
        }
    ]
};
const OLLAMA_LANGUAGE_MODELS = [
    {id: 'granite4.2:3b-q4_K_M', name: 'Granite 4.2 3B · Q4_K_M'},
    {id: 'granite4.2:8b-q4_K_M', name: 'Granite 4.2 8B · Q4_K_M'},
    {id: 'granite4.2:30b-q4_K_M', name: 'Granite 4.2 30B · Q4_K_M'},
    {id: 'gpt-oss:20b', name: 'GPT-OSS 20B · MXFP4'},
    {id: 'muse-glimmer:30b-q4_K_M', name: 'Meta Muse Glimmer 30B · Q4_K_M'}
];

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
    let coreClient = null;
    let modelClient = null;
    let coreLifetime = new AbortController();
    let coreCleanup = Promise.resolve();
    let retiredModelCleanup = null;
    let coreError = null;
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
    let loading = false;
    let loadSettled = Promise.resolve();
    let cancelLoad = null;
    let imageLoad = null;
    let imageLoadState = {modelId: null, phase: 'idle', busy: false, error: null};
    let avatarPreparation = null;
    let preferredModel = null;
    let preferenceState = 'pending';
    let preferenceError = null;
    let preferenceRead = null;
    let preferenceWrite = Promise.resolve();
    let languageDownload = null;
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
        return runtimeRecord('llama.cpp')?.models?.find(
            function matchesSelectedModel(model) {
                return model.id === selection?.modelId;
            }
        ) ?? null;
    }

    function catalog() {
        const result = [];
        for (const record of coreState?.runtimes ?? []) {
            if (record.id === 'llama.cpp') {
                result.push(
                    {
                        providerId: record.id,
                        localOnly: true,
                        models: record.models ?? []
                    }
                );
            }
        }
        const installedOllama = runtimeRecord('ollama')?.models ?? [];
        const ollamaModels = OLLAMA_LANGUAGE_MODELS.map(
            function selectableOllamaModel(model) {
                const installed = installedOllama.find(
                    function matchingInstalledModel(record) { return record.id === model.id; }
                );
                return {...installed, ...model, localOnly: true};
            }
        );
        for (const installed of installedOllama) {
            if (!ollamaModels.some(function knownOllamaModel(model) { return model.id === installed.id; })) {
                ollamaModels.push(installed);
            }
        }
        result.push({providerId: 'OLLAMA', localOnly: true, models: ollamaModels});
        const browserModels = browserProvider?.catalog() ?? [];
        const granite = browserModels.find(function matchesGranite(model) {
            return model.id === GRANITE_MODEL.id;
        });
        if (granite) {
            granite.name = GRANITE_MODEL.name;
        } else {
            browserModels.push(GRANITE_MODEL);
        }
        result.push(
            {providerId: BROWSER_PROVIDER, localOnly: true, models: browserModels}
        );
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
            const nativeRuntime = selection.providerId === 'llama.cpp' ? runtimeRecord('llama.cpp') : null;
            const nativeLoaded = selection.providerId === 'OLLAMA'
                ? matching && underlying?.state === 'ready' && underlying.loaded === true
                : nativeRuntime?.available === true && nativeRuntime.state === 'ready'
                    && selectedNativeModel()?.loaded === true;
            const currentNativeClient = Boolean(coreClient) && modelClient === coreClient;
            const loaded = Boolean(activeAI) && !closed && !selecting && !selectedError
                && matching && underlying?.state === 'ready' && underlying.loaded === true
                && (!native || (currentNativeClient && nativeLoaded));
            let state = underlying?.state ?? 'unloaded';
            if (!matching || state === 'ready') state = 'unloaded';
            if (loaded) state = 'ready';
            if (selectedError) state = 'error';
            if (native && !coreClient) state = 'unavailable';
            if (selecting) state = 'unloading';
            if (closed) state = 'disposed';
            model = {
                ...selection,
                state,
                loaded,
                busy: selecting || loading || underlying?.busy === true,
                progress: languageDownload?.progress ?? underlying?.progress ?? null,
                progressKind: languageDownload ? 'ollama' : 'sdk',
                progressPhase: languageDownload ? 'download' : underlying?.progress?.phase ?? null,
                error: selectedError ?? (native ? coreError : null) ?? underlying?.error ?? null,
                ...(native ? {nativeLoaded: currentNativeClient && nativeLoaded} : {})
            };
        }
        return {
            model, imageLoad: {...imageLoadState}, catalog: catalog(),
            preferredModel, preferenceState, preferenceError,
            core: coreState, coreError, retiredModelCleanup, closed
        };
    }

    function ready() {
        assertOpen();
        if (!preferenceRead) {
            const revision = selectionRevision;
            preferenceRead = Promise.resolve().then(
                async function readLanguageModelPreference() {
                    const storage = await getStorage();
                    const saved = await storage.get('pm_local_ai_settings', 'language-model.json', true);
                    assertOpen();
                    if (revision === selectionRevision && saved) preferredModel = saved;
                    preferenceState = 'ready';
                    preferenceError = null;
                    publish();
                    return preferredModel;
                }
            ).catch(
                function languageModelPreferenceUnavailable(error) {
                    preferenceState = 'error';
                    preferenceError = error;
                    preferenceRead = null;
                    publish();
                    throw error;
                }
            );
        }
        return preferenceRead;
    }

    async function saveLanguageModelPreference() {
        const value = {providerId: selection.providerId, modelId: selection.modelId};
        preferredModel = value;
        preferenceWrite = preferenceWrite.catch(
            function previousPreferenceWriteFailed(error) {
                console.error('Arcane PM could not save an earlier language model choice.', error);
            }
        ).then(
            async function writeLanguageModelPreference() {
                const storage = await getStorage();
                await storage.set('pm_local_ai_settings', 'language-model.json', value);
            }
        );
        try {
            await preferenceWrite;
            preferenceState = 'ready';
            preferenceError = null;
        } catch (error) {
            preferenceState = 'error';
            preferenceError = error;
            throw error;
        }
    }

    function publish() {
        const snapshot = getStatus();
        if (!eventsDisposed) {
            events.dispatch('pm.models.changed', snapshot);
        }
        return snapshot;
    }

    function acceptCoreClient({client: nextClient, error = null}) {
        if (closed || coreClient === nextClient) return;
        const previousClient = coreClient;
        stopCore?.();
        stopCore = null;
        coreClient = nextClient;
        coreState = null;
        coreError = error;
        coreRevision += 1;
        coreLifetime.abort(error ?? serviceError('PM_CORE_CHANGED', 'The Arcane Core connection changed.'));
        coreLifetime = new AbortController();
        // Invalidate PM readiness before observing asynchronous SDK cleanup.
        publish();
        if (previousClient && activeAI && modelClient === previousClient) {
            const current = providerRuntime.selection('llm');
            if (current?.providerId === selection?.providerId && current.modelId === selection.modelId) {
                const cleanup = {model: {...selection}, error: null};
                retiredModelCleanup = cleanup;
                coreCleanup = providerRuntime.unload('llm').catch(
                    function reportRetiredModelCleanup(error) {
                        cleanup.error = error;
                        if (retiredModelCleanup === cleanup) publish();
                        globalThis.console?.error('Arcane PM retired model cleanup failed.', error);
                    }
                );
            }
        }
        if (nextClient) {
            stopCore = nextClient.events.on(
                'localai.state',
                function coreModelsChanged(snapshot) {
                    if (closed || coreClient !== nextClient) return;
                    coreState = snapshot;
                    coreError = null;
                    coreRevision += 1;
                    publish();
                }
            );
            inspect().catch(
                function reportCoreModelDiscovery(error) {
                    if (closed || coreClient !== nextClient) return;
                    coreError = error;
                    publish();
                    globalThis.console?.error('Arcane PM model discovery failed.', error);
                }
            );
        }
    }

    function resolveCore() {
        assertOpen();
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
            const inspectionSignal = AbortSignal.any([currentSignal, coreLifetime.signal]);
            const revision = coreRevision;
            const status = await selectedClient.invoke(
                'localai.status',
                {},
                {signal: inspectionSignal, timeoutMs: 0}
            );
            inspectionSignal.throwIfAborted();
            if (selectedClient === coreClient && revision === coreRevision) {
                coreState = status;
                coreError = null;
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
        modelClient = null;
    }

    async function configureRoutedAI(selected, currentSignal) {
        if (!routedAI) {
            const {default: AI} = await import('arcane-os/ai');
            currentSignal.throwIfAborted();
            routedAI = new AI(selected.providerId, '', '', selected.modelId);
        }
        activeAI = routedAI;
        await activeAI.transitionProviders(
            {
                llm: {default: selected, localOnly: selected.localOnly ? selected : null},
                stt: {default: null, localOnly: null},
                tts: {default: null, localOnly: null}
            }
        );
        currentSignal.throwIfAborted();
    }

    async function select(value, {signal: requestSignal, persist = true} = {}) {
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
        cancelLoad?.(serviceError('PM_MODEL_SELECTION_CHANGED', 'The selected model changed.'));
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
            if (loading) await loadSettled;
            await releaseSelectedAI();
            currentSignal.throwIfAborted();
            selection = {providerId: selectedProvider, modelId, localOnly: selectedProvider !== 'TWIN'};
            if (selectedProvider === BROWSER_PROVIDER) {
                const selectedSource = source === undefined && modelId === GRANITE_MODEL.id
                    ? {id: GRANITE_MODEL.id, files: GRANITE_MODEL.files} : source;
                if (selectedSource?.id !== modelId) {
                    throw new TypeError('The complete browser model source must identify the selected model.');
                }
                const store = await getModelStore();
                currentSignal.throwIfAborted();
                const modelSource = createBrowserModelSource(selectedSource);
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
                    modelClient = requireCore();
                    coreProvider = createCoreLocalAIProvider(
                        {client: modelClient}
                    );
                    unregisterCore = providerRuntime.register(coreProvider);
                }
                // Built-in Ollama configuration preloads in the SDK, so apply it
                // only at PM's explicit Load action.
                if (selectedProvider !== 'OLLAMA') await configureRoutedAI(selection, currentSignal);
                if (selectedProvider === 'TWIN' && twinKey !== undefined) {
                    activeAI.twinKey = twinKey;
                }
                if (selection.localOnly) {
                    await inspect(
                        {signal: currentSignal}
                    );
                }
            }
            if (persist) {
                try {
                    await saveLanguageModelPreference();
                } catch (error) {
                    console.error('Arcane PM could not save the selected language model.', error);
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

    async function load({offline = true, signal: requestSignal} = {}) {
        assertOpen();
        if (selecting) {
            throw serviceError('PM_MODEL_SELECTION_BUSY', 'A model selection is already changing.');
        }
        if (loading) {
            throw serviceError('PM_MODEL_LOADING', 'The selected model is already loading.');
        }
        if (!selection || (!activeAI && selection.providerId !== 'OLLAMA')) {
            throw serviceError('PM_MODEL_NOT_SELECTED', 'Choose a model before loading it.');
        }
        const selected = selection;
        const native = selected.providerId === 'OLLAMA' || selected.providerId === 'llama.cpp';
        const loadClient = native ? requireCore() : null;
        if (selected.providerId === 'llama.cpp' && modelClient !== loadClient) {
            throw serviceError('PM_CORE_CHANGED', 'Reselect the llama.cpp model after the Arcane Core connection changes.');
        }
        if (selected.providerId === 'OLLAMA' && loadClient !== getInstalledCoreClient()) {
            throw serviceError('PM_OLLAMA_CORE_MISMATCH', 'The Ollama provider requires the installed Arcane Core connection.');
        }
        const loadLifetime = new AbortController();
        const currentSignal = AbortSignal.any(
            [operationSignal(requestSignal), loadLifetime.signal, ...(native ? [coreLifetime.signal] : [])]
        );
        const revision = selectionRevision;
        let cancellation = Promise.resolve();
        let cancelling = false;
        function cancelNativeLoad() {
            if (!currentSignal.aborted || cancelling) return;
            const current = providerRuntime.selection('llm');
            if (current?.providerId !== selected.providerId || current.modelId !== selected.modelId) return;
            const state = providerRuntime.status('llm');
            if (state.state !== 'loading' && state.loaded !== true && state.busy !== true) return;
            cancelling = true;
            cancellation = providerRuntime.unload('llm').catch(
                function reportCancelledModelLoad(error) {
                    globalThis.console?.error('Arcane PM model load cancellation failed.', error);
                }
            ).finally(
                function finishModelCancellation() {
                    cancelling = false;
                }
            );
        }
        const stopLoadingState = native ? subscribeAIRuntimeState(
            cancelNativeLoad,
            {emitCurrent: true}
        ) : null;
        if (native) {
            currentSignal.addEventListener(
                'abort',
                cancelNativeLoad,
                {once: true}
            );
        }
        loading = true;
        cancelLoad = function cancelSelectedModelLoad(reason) {
            loadLifetime.abort(reason);
        };
        let settleLoad;
        loadSettled = new Promise(
            function trackModelLoad(resolve) {
                settleLoad = resolve;
            }
        );
        selectedError = null;
        publish();
        try {
            currentSignal.throwIfAborted();
            if (native) {
                await coreCleanup;
                currentSignal.throwIfAborted();
                if (selected.providerId === 'OLLAMA') modelClient = loadClient;
            }
            if (selected.providerId === BROWSER_PROVIDER) {
                await activeAI.load(
                    {offline, gpuLayers: 0, signal: currentSignal}
                );
            } else {
                if (selected.providerId === 'OLLAMA') await acquireSelectedOllamaModel(selected, loadClient, currentSignal, offline);
                if (!activeAI) await configureRoutedAI(selected, currentSignal);
                await providerRuntime.load(
                    'llm',
                    {signal: currentSignal, localOnly: selected.localOnly}
                );
            }
            currentSignal.throwIfAborted();
        } catch (error) {
            if (selectionRevision === revision && (!native || coreClient === loadClient)) {
                selectedError = error;
            }
            if (!currentSignal.aborted || error?.name !== 'AbortError') {
                globalThis.console?.error('Arcane PM text model loading failed.', error);
            }
            publish();
            throw error;
        } finally {
            currentSignal.removeEventListener('abort', cancelNativeLoad);
            stopLoadingState?.();
            await cancellation;
            loading = false;
            cancelLoad = null;
            settleLoad();
            publish();
        }
        return getStatus();
    }

    async function acquireSelectedOllamaModel(selected, selectedClient, currentSignal, offline) {
        const published = OLLAMA_LANGUAGE_MODELS.some(
            function requestedLanguageModel(model) { return model.id === selected.modelId; }
        );
        if (!published) return;
        await inspect({signal: currentSignal});
        const installed = runtimeRecord('ollama')?.models?.some(
            function selectedModelInstalled(model) { return model.id === selected.modelId; }
        );
        if (installed) return;
        if (offline) {
            throw serviceError('PM_LANGUAGE_MODEL_NOT_CACHED', 'This language model needs its first download before offline loading.');
        }
        const operation = {modelId: selected.modelId, streamId: crypto.randomUUID(), progress: null};
        languageDownload = operation;
        const stop = selectedClient.events.on(
            'ollama.chunk',
            function selectedLanguageModelProgress(value) {
                if (languageDownload !== operation || value.streamId !== operation.streamId || currentSignal.aborted) return;
                operation.progress = value.chunk;
                publish();
            }
        );
        publish();
        try {
            await selectedClient.invoke(
                'ollama.pull',
                {model: selected.modelId, stream: true, streamId: operation.streamId},
                {signal: currentSignal, timeoutMs: 0}
            );
            currentSignal.throwIfAborted();
        } finally {
            stop();
            if (languageDownload === operation) languageDownload = null;
            publish();
        }
    }

    async function unload({signal: requestSignal} = {}) {
        assertOpen();
        if (selecting) {
            throw serviceError('PM_MODEL_SELECTION_BUSY', 'A model selection is already changing.');
        }
        const currentSignal = operationSignal(requestSignal);
        currentSignal.throwIfAborted();
        cancelLoad?.(serviceError('PM_MODEL_UNLOADED', 'The selected model is unloading.'));
        if (loading) await loadSettled;
        currentSignal.throwIfAborted();
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
            {client: client ?? undefined, signal: lifetimeSignal}
        );
        return imageRuntime;
    }

    function getONNXRuntime() {
        assertOpen();
        onnxRuntime ??= createCoreONNXRuntime(
            {client: client ?? undefined}
        );
        return onnxRuntime;
    }

    function loadImage({model: modelId, offline = true, signal: requestSignal} = {}) {
        assertOpen();
        if (imageLoad) {
            throw serviceError('PM_IMAGE_MODEL_LOADING', 'An image model is already loading.');
        }
        const operation = {
            modelId,
            signal: AbortSignal.any([operationSignal(requestSignal), coreLifetime.signal]),
            task: null
        };
        imageLoad = operation;
        imageLoadState = {modelId, phase: 'preparing', busy: true, progress: null, error: null};
        operation.task = Promise.resolve().then(
            function beginImageModelLoad() {
                return prepareAndLoadImage(operation, offline);
            }
        );
        operation.task.catch(
            function reportImageModelLoadFailure(error) {
                if (!operation.signal.aborted || error?.name !== 'AbortError') {
                    globalThis.console?.error('Arcane PM image model loading failed.', error);
                }
            }
        );
        publish();
        return operation.task;
    }

    async function prepareAndLoadImage(operation, offline) {
        let projection = null;
        let failure = null;
        let result;
        try {
            operation.signal.throwIfAborted();
            const runtime = getImageRuntime();
            const model = runtime.current().models.find(
                function selectedImageModel(record) {
                    return record.id === operation.modelId;
                }
            );
            if (!model) {
                throw serviceError('PM_IMAGE_MODEL_UNAVAILABLE', 'Choose an available image model before loading it.');
            }
            const resources = Object.entries(model.resources ?? {});
            let resourcePaths;
            if (resources.length && resources.every(function downloadableResource(entry) {
                return Boolean(entry[1].url) && !entry[1].path;
            })) {
                const source = {
                    id: model.id,
                    files: resources.map(function imageResourceFile(entry) {
                        return {name: entry[1].filename, url: entry[1].url};
                    })
                };
                projection = await prepareModelAssets(
                    {
                        source, offline, signal: operation.signal,
                        onProgress: function imageAssetsProgress(progress) {
                            if (imageLoad !== operation || operation.signal.aborted) return;
                            imageLoadState = {...imageLoadState, progress};
                            publish();
                        }
                    }
                );
                resourcePaths = Object.fromEntries(resources.map(function resourceRole(entry) {
                    return [entry[0], entry[1].filename];
                }));
            }
            operation.signal.throwIfAborted();
            imageLoadState = {...imageLoadState, phase: 'loading', progress: null};
            publish();
            result = await runtime.load({
                model: model.id,
                assetProjectionId: projection?.id,
                resourcePaths,
                signal: operation.signal
            });
            operation.signal.throwIfAborted();
        } catch (error) {
            failure = error;
        } finally {
            if (projection) {
                try {
                    await releaseModelAssets(projection);
                } catch (error) {
                    failure = failure
                        ? new AggregateError([failure, error], 'Image model loading and preparation cleanup failed.')
                        : error;
                }
            }
            imageLoad = null;
            imageLoadState = {
                modelId: operation.modelId,
                phase: failure ? operation.signal.aborted ? 'cancelled' : 'error' : 'ready',
                busy: false,
                progress: null,
                error: failure
            };
            publish();
        }
        if (failure) throw failure;
        return result;
    }

    async function prepareModelAssets(
        {source, members, offline = true, signal: requestSignal, onProgress} = {}
    ) {
        assertOpen();
        const selectedClient = requireCore();
        const currentSignal = AbortSignal.any([operationSignal(requestSignal), coreLifetime.signal]);
        currentSignal.throwIfAborted();
        let completeMembers = members;
        if (source) {
            const store = await getModelStore();
            const modelSource = createBrowserModelSource(source);
            const stored = await store.ensure(
                modelSource,
                {signal: currentSignal, offline, onProgress}
            );
            // Native companion paths belong to PM; the SDK source keeps cache filenames.
            completeMembers = modelSource.files.map(
                function completeStoredMember(member, index) {
                    return {path: source.files[index].path ?? member.name, file: stored.files[index]};
                }
            );
        }
        const {workingDirectory} = await selectedClient.invoke(
            'pm.modelContext.current',
            {},
            {signal: currentSignal}
        );
        currentSignal.throwIfAborted();
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

    async function releaseModelAssets(projection) {
        await projection.release();
        projections.delete(projection);
    }

    function prepareAvatarModels({signal: requestSignal} = {}) {
        assertOpen();
        requestSignal?.throwIfAborted();
        if (!avatarPreparation) {
            const preparations = [prepareAvatarText(), prepareAvatarImage()];
            const preparation = Promise.all(preparations);
            avatarPreparation = preparation;
            Promise.allSettled(preparations).then(
                function finishAvatarModelPreparation() {
                    if (avatarPreparation === preparation) avatarPreparation = null;
                }
            );
            avatarPreparation.catch(
                function reportAvatarModelPreparation(error) {
                    if (!lifetimeSignal.aborted) console.error('Arcane PM portrait models could not become ready.', error);
                }
            );
        }
        if (!requestSignal) return avatarPreparation;
        const currentPreparation = avatarPreparation;
        return new Promise(
            function observeAvatarModelPreparation(resolve, reject) {
                function cancelled() {
                    requestSignal.removeEventListener('abort', cancelled);
                    reject(requestSignal.reason);
                }
                requestSignal.addEventListener('abort', cancelled, {once: true});
                currentPreparation.then(
                    function prepared(result) {
                        requestSignal.removeEventListener('abort', cancelled);
                        resolve(result);
                    },
                    function preparationFailed(error) {
                        requestSignal.removeEventListener('abort', cancelled);
                        reject(error);
                    }
                );
                if (requestSignal.aborted) cancelled();
            }
        );
    }

    async function prepareAvatarText() {
        await ready();
        assertOpen();
        if (selecting) await selectionSettled;
        assertOpen();
        if (!selection) {
            await select(
                preferredModel ?? {providerId: BROWSER_PROVIDER, modelId: GRANITE_MODEL.id},
                {signal: lifetimeSignal, persist: false}
            );
        }
        if (selection.localOnly !== true) {
            throw serviceError('PM_AVATAR_LOCAL_MODEL_REQUIRED', 'Choose a local language model to prepare portraits.');
        }
        if (loading) await loadSettled;
        assertOpen();
        if (getStatus().model?.loaded !== true) await load({offline: false, signal: lifetimeSignal});
    }

    async function prepareAvatarImage() {
        const runtime = getImageRuntime();
        await new Promise(
            function waitForImageCatalog(resolve, reject) {
                let stop = null;
                let finished = false;
                function finish(error) {
                    if (finished) return;
                    finished = true;
                    stop?.();
                    lifetimeSignal.removeEventListener('abort', cancelled);
                    if (error) reject(error);
                    else resolve();
                }
                function cancelled() { finish(lifetimeSignal.reason); }
                function imageCatalogChanged(snapshot) {
                    if (snapshot.models?.length) finish();
                    else if (snapshot.error) finish(snapshot.error);
                }
                lifetimeSignal.addEventListener('abort', cancelled, {once: true});
                stop = runtime.subscribe(imageCatalogChanged, {signal: lifetimeSignal});
                if (finished) stop();
                if (lifetimeSignal.aborted) cancelled();
            }
        );
        assertOpen();
        if (imageLoad) await imageLoad.task;
        const snapshot = runtime.current();
        if (snapshot.loaded === true) return;
        await loadImage(
            {model: snapshot.selectedModel ?? 'sdxl-base-1.0', offline: false, signal: lifetimeSignal}
        );
    }

    function dispose() {
        if (closing) {
            return closing;
        }
        closed = true;
        lifetimeSignal.removeEventListener('abort', dispose);
        lifetime.abort();
        coreLifetime.abort();
        stopRuntime();
        stopCore?.();
        stopCoreInstallation?.();
        closing = Promise.resolve().then(
            async function releasePMModelServices() {
                await selectionSettled;
                await Promise.allSettled([avatarPreparation, preferenceRead, preferenceWrite]);
                if (loading) await loadSettled;
                // The load owner reports failures and releases its own projection.
                if (imageLoad) await Promise.allSettled([imageLoad.task]);
                const operations = [releaseSelectedAI(), coreCleanup];
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
    const stopCoreInstallation = client ? null : subscribeCoreClient(
        acceptCoreClient,
        {signal: lifetimeSignal, emitCurrent: true}
    );
    if (client) {
        acceptCoreClient(
            {client}
        );
    }
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
        ready,
        select,
        load,
        unload,
        getAI,
        getModelStore,
        getImageRuntime,
        loadImage,
        prepareAvatarModels,
        prepareModelAssets,
        releaseModelAssets,
        prepareImageAssets: prepareModelAssets,
        getONNXRuntime,
        dispose
    };
}
