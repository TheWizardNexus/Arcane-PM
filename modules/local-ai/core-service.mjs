import {createLocalAIService} from 'arcane-os/core/local-ai';

/** Observe an existing local service without acquiring or launching a runtime. */
export default function createPMExistingLocalAIService(options, {appRoot, signal, onEvent}) {
    return createLocalAIService(options, {appRoot, signal, onEvent});
}
