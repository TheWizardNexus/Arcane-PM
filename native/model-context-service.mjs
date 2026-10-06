import {resolve} from 'node:path';

/** PM selects its working directory from the native host's actual state root. */
export function createPMModelContextService(options = {}, {stateRoot} = {}) {
    function current() {
        return {workingDirectory: resolve(stateRoot, 'model-working')};
    }

    return {
        name: 'pm.modelContext',
        current,
        methods: {
            'pm.modelContext.current': current
        }
    };
}

export default createPMModelContextService;
