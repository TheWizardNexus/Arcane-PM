import {createPMModelServices} from './model-services.js';
import {createLocalPreparationController} from './preparation.js';
import {createPreparationRequestSlot} from './request-slot.js';
import {createInitialAvatarPreparation} from './initial-avatars.js';
import {createPMDecisionController} from './decisions.js';
import {createPMSpeechController} from './speech.js';
import {createTaskFaceController} from '../faces/index.js';
import {subscribeCoreClient} from 'arcane-os/core/client';
import {attachModelObservation} from 'arcane-os/ai/model-observation';
import * as aiRuntimeState from 'arcane-os/ai-runtime-state';

export {createPMModelServices} from './model-services.js';
export {createLocalPreparationController} from './preparation.js';
export {createPreparationRequestSlot} from './request-slot.js';
export {createInitialAvatarPreparation} from './initial-avatars.js';
export {createPMDecisionController} from './decisions.js';
export {createPMSpeechController} from './speech.js';
export {mountLocalAIView} from './view.js';

/** Compose PM-owned concerns once; the supplied data owner remains shared. */
export function createPMPreparationServices(
    {getStorage, getSources, getWorkflows, pmData, tools = [], executeTool, signal} = {}
) {
    // Dependents settle before their shared model owner closes, including app abort.
    const modelServices = createPMModelServices({getStorage, pmData});
    const decisions = createPMDecisionController({modelServices, signal});
    const speech = createPMSpeechController({getStorage, signal});
    const requestSlot = createPreparationRequestSlot({signal});
    const localAI = createLocalPreparationController(
        {modelServices, getStorage, tools, executeTool, acquireRequest: requestSlot.acquire, signal}
    );
    const faces = createTaskFaceController(
        {imageRuntime: modelServices.getImageRuntime(), data: pmData, getStorage, signal}
    );
    const initialAvatars = createInitialAvatarPreparation(
        {modelServices, faces, data: pmData, getStorage, getSources, getWorkflows, acquireRequest: requestSlot.acquire, signal}
    );
    let closing = null;
    let observationClient = null;
    let observationReady = false;
    let stopCoreReady = null;
    let observedOwners = null;
    const observationClosures = new Set();

    function reportObservationFailure(error) {
        console.error('Arcane PM model observation failed.', error);
    }

    function retireObservation() {
        const attachment = observedOwners?.attachment;
        observedOwners = null;
        if (!attachment) return;
        const completion = attachment.close();
        observationClosures.add(completion);
        function observationClosed() {
            observationClosures.delete(completion);
        }
        // The SDK reports complete failures through onError; retain closure
        // until settled without delaying an independent replacement owner.
        completion.then(observationClosed, observationClosed);
    }

    function observeModelOwners() {
        if (closing || !observationReady || !observationClient) return;
        const decisionModel = decisions.getBrowserModel();
        const modelController = modelServices.getModelController();
        if (observedOwners?.client === observationClient
            && observedOwners.decisionModel === decisionModel
            && observedOwners.modelController === modelController) return;
        retireObservation();
        const selected = {
            client: observationClient, decisionModel, modelController,
            attachment: null
        };
        observedOwners = selected;
        try {
            selected.attachment = attachModelObservation(
                {
                    client: selected.client,
                    aiRuntimeState,
                    imageRuntime: modelServices.getImageRuntime(),
                    decisionModel,
                    modelController,
                    signal,
                    onError: reportObservationFailure
                }
            );
        } catch (error) {
            reportObservationFailure(error);
        }
    }

    function acceptObservationCore({client}) {
        if (closing || observationClient === client) return;
        stopCoreReady?.();
        stopCoreReady = null;
        retireObservation();
        observationClient = client;
        observationReady = false;
        if (!client) return;
        stopCoreReady = client.events.when(
            'core.ready',
            function observationCoreReady() {
                if (closing || observationClient !== client) return;
                observationReady = true;
                observeModelOwners();
            }
        );
    }

    const stopModelOwners = modelServices.subscribe(observeModelOwners);
    const stopDecisionOwner = decisions.subscribe(observeModelOwners);
    const stopObservationCore = subscribeCoreClient(
        acceptObservationCore,
        {signal, emitCurrent: true}
    );

    function dispose() {
        if (closing) return closing;
        signal?.removeEventListener('abort', dispose);
        closing = closePreparationServices();
        closing.catch(function reportPreparationCleanup(error) {
            console.error('Arcane PM preparation cleanup failed.', error);
        });
        return closing;
    }

    async function closePreparationServices() {
        stopObservationCore();
        stopCoreReady?.();
        stopModelOwners();
        stopDecisionOwner();
        retireObservation();
        requestSlot.dispose();
        const outcomes = await Promise.allSettled(
            [
                ...observationClosures,
                localAI.dispose(), initialAvatars.dispose(), faces.dispose(),
                decisions.dispose(), speech.dispose()
            ]
        );
        const failures = outcomes.filter(
            function cleanupFailed(outcome) {
                return outcome.status === 'rejected';
            }
        ).map(
            function cleanupError(outcome) {
                return outcome.reason;
            }
        );
        try {
            await modelServices.dispose();
        } catch (error) {
            failures.push(error);
        }
        if (failures.length) throw new AggregateError(failures, 'PM preparation cleanup could not finish.');
    }

    signal?.addEventListener('abort', dispose, {once: true});
    if (signal?.aborted) dispose();
    return {modelServices, localAI, faces, initialAvatars, decisions, speech, dispose};
}
