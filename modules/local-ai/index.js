import {createPMModelServices} from './model-services.js';
import {createLocalPreparationController} from './preparation.js';
import {createTaskFaceController} from '../faces/index.js';

export {createPMModelServices} from './model-services.js';
export {createLocalPreparationController} from './preparation.js';
export {mountLocalAIView} from './view.js';

/** Compose PM-owned concerns once; the supplied data owner remains shared. */
export function createPMPreparationServices(
    {getStorage, pmData, tools = [], executeTool, signal} = {}
) {
    const modelServices = createPMModelServices({getStorage, pmData, signal});
    const localAI = createLocalPreparationController(
        {modelServices, getStorage, tools, executeTool, signal}
    );
    const faces = createTaskFaceController(
        {imageRuntime: modelServices.getImageRuntime(), data: pmData, getStorage, signal}
    );
    let closing = null;

    function dispose() {
        if (closing) return closing;
        closing = closePreparationServices();
        return closing;
    }

    async function closePreparationServices() {
        await Promise.allSettled([localAI.dispose(), faces.dispose()]);
        await modelServices.dispose();
    }

    return {modelServices, localAI, faces, dispose};
}
