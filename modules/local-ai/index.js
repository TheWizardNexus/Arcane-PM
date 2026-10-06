import {createPMModelServices} from './model-services.js';
import {createLocalPreparationController} from './preparation.js';
import {createPreparationRequestSlot} from './request-slot.js';
import {createInitialAvatarPreparation} from './initial-avatars.js';
import {createTaskFaceController} from '../faces/index.js';

export {createPMModelServices} from './model-services.js';
export {createLocalPreparationController} from './preparation.js';
export {createPreparationRequestSlot} from './request-slot.js';
export {createInitialAvatarPreparation} from './initial-avatars.js';
export {mountLocalAIView} from './view.js';

/** Compose PM-owned concerns once; the supplied data owner remains shared. */
export function createPMPreparationServices(
    {getStorage, getSources, pmData, tools = [], executeTool, signal} = {}
) {
    const modelServices = createPMModelServices({getStorage, pmData, signal});
    const requestSlot = createPreparationRequestSlot({signal});
    const localAI = createLocalPreparationController(
        {modelServices, getStorage, tools, executeTool, acquireRequest: requestSlot.acquire, signal}
    );
    const faces = createTaskFaceController(
        {imageRuntime: modelServices.getImageRuntime(), data: pmData, getStorage, signal}
    );
    const initialAvatars = createInitialAvatarPreparation(
        {modelServices, faces, data: pmData, getStorage, getSources, acquireRequest: requestSlot.acquire, signal}
    );
    let closing = null;

    function dispose() {
        if (closing) return closing;
        closing = closePreparationServices();
        return closing;
    }

    async function closePreparationServices() {
        requestSlot.dispose();
        const outcomes = await Promise.allSettled(
            [localAI.dispose(), initialAvatars.dispose(), faces.dispose()]
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

    return {modelServices, localAI, faces, initialAvatars, dispose};
}
