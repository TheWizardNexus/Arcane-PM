import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';

// Codex owns the command lifetime. The receiver owns accepted service work.
// Empty stdout is deliberate: an observation adds no model context or decision.
try {
    const [original, configuration] = await Promise.all([
        readOriginal(),
        readFile(new URL('../configuration.json', import.meta.url), 'utf8').then(JSON.parse)
    ]);
    const resolveFromApplication = createRequire(join(configuration.applicationRoot, 'package.json'));
    const {createCoreClient} = await import(pathToFileURL(resolveFromApplication.resolve('arcane-os/core/client')).href);
    const endpoint = new URL('/rpc', configuration.endpoint);
    endpoint.searchParams.set('client', randomUUID());
    const deliveries = new Set();
    const failures = [];
    let client;

    function send(frame) {
        const delivery = post(frame);
        deliveries.add(delivery);
        delivery.then(function delivered() { deliveries.delete(delivery); }, function failed() { deliveries.delete(delivery); });
        return delivery;
    }

    async function post(frame) {
        const response = await fetch(endpoint, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(frame)
        });
        const result = await response.json();
        if (!response.ok) {
            const error = new Error(result.error?.message ?? 'The PM receiver could not accept the observation.');
            error.response = result;
            throw error;
        }
        // /rpc returns the actual final Core frame. Control acknowledgments
        // contain no response frame and must not settle an unrelated request.
        if (result.type === 'response') client.receive(result);
        else if (frame.type === 'request') {
            const error = new Error('The PM receiver returned no final observation acknowledgment.');
            error.response = result;
            throw error;
        }
    }

    client = createCoreClient({
        transport: {name: 'pm-hook-request', send},
        replayRuntimeState: false,
        onError: function observeTransportFailure(error) { failures.push(error); }
    });
    try {
        const result = await client.invoke('pm.codexHooks.accept', {original}, {timeoutMs: 0});
        if (result.status !== 'received') {
            const error = new Error('The PM receiver did not confirm observation storage.');
            error.response = result;
            throw error;
        }
    } finally {
        client.close();
        const remaining = await Promise.allSettled([...deliveries]);
        for (const delivery of remaining) if (delivery.status === 'rejected') failures.push(delivery.reason);
    }
    if (failures.length) throw new AggregateError(failures, 'The PM observation transport reported a failure.');
} catch (error) {
    process.stderr.write(inspect(error, {depth: null, maxArrayLength: null, maxStringLength: null}) + '\n');
    process.exitCode = 1;
}

async function readOriginal() {
    process.stdin.setEncoding('utf8');
    let original = '';
    for await (const part of process.stdin) original += part;
    return original;
}
