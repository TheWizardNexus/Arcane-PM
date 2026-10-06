import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {join, parse, resolve} from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {CoreError, serializeCoreError} from 'arcane-os/core/contracts';

/** Hook receipts are retained evidence, separate from current Codex task state. */
export function createCodexHooksService(options = {}, {appRoot = process.cwd(), stateRoot} = {}) {
    const storageDirectory = options.storageDirectory == null && stateRoot
        ? resolve(stateRoot, 'bridge/hook-events')
        : resolve(appRoot, options.storageDirectory ?? 'output/bridge/hook-events');
    const hostId = hostname();
    const records = new Map();
    const diagnostics = [];
    let emit = null;
    let receiving = false;

    function current() {
        return {
            receiving,
            records: Array.from(records.values(), function receiptMetadata(record) { return structuredClone(record.metadata); }),
            diagnostics: structuredClone(diagnostics)
        };
    }

    function reportStartupFailure(operation, fileName, error) {
        const diagnostic = {operation, fileName, error: serializeCoreError(error), observedAt: new Date().toISOString()};
        diagnostics.push(diagnostic);
        console.error('Arcane PM Codex hook receipt catalog could not be fully read', diagnostic);
        emit('pm.codexHooks.diagnostic', diagnostic);
    }

    async function start(context) {
        emit = context.emit;
        await mkdir(storageDirectory, {recursive: true});
        const entries = await readdir(storageDirectory, {withFileTypes: true});
        const files = new Set();
        for (const entry of entries) {
            if (entry.isFile()) files.add(entry.name);
        }
        const reads = [];
        for (const fileName of files) {
            if (parse(fileName).ext === '.json') reads.push(loadMetadata(fileName));
            if (parse(fileName).ext === '.txt' && !files.has(`${parse(fileName).name}.json`)) {
                reportStartupFailure('original-without-metadata', fileName, new CoreError({
                    code: 'PM_CODEX_HOOK_METADATA_MISSING',
                    message: 'A retained hook original has no receipt metadata. The original remains on disk.'
                }));
            }
        }
        await Promise.all(reads);
        receiving = true;
        emit('pm.codexHooks.state', current());

        async function loadMetadata(fileName) {
            try {
                const metadata = JSON.parse(await readFile(join(storageDirectory, fileName), 'utf8'));
                if (metadata?.receipt?.eventId === undefined) {
                    throw new CoreError({code: 'PM_CODEX_HOOK_METADATA_UNREADABLE', message: 'Hook receipt metadata has no event ID.'});
                }
                const originalName = `${parse(fileName).name}.txt`;
                const originalAvailable = files.has(originalName);
                records.set(metadata.receipt.eventId, {
                    metadata: {...metadata, originalAvailable},
                    originalPath: join(storageDirectory, originalName)
                });
                if (!originalAvailable) {
                    reportStartupFailure('metadata-without-original', fileName, new CoreError({
                        code: 'PM_CODEX_HOOK_ORIGINAL_MISSING',
                        message: 'Hook receipt metadata exists, and its retained original is unavailable.',
                        eventId: metadata.receipt.eventId
                    }));
                }
            } catch (error) {
                reportStartupFailure('read-metadata', fileName, error);
            }
        }
    }

    async function accept({original}) {
        const receipt = {eventId: randomUUID(), receivedAt: new Date().toISOString(), hostId};
        const originalPath = join(storageDirectory, `${receipt.eventId}.txt`);
        // Retain first. JSON extraction cannot prevent preservation of the input.
        await writeFile(originalPath, original, {encoding: 'utf8', flush: true});
        let source = null;
        let parsed = false;
        let diagnostic = null;
        try {
            const payload = JSON.parse(original);
            source = {
                hookEventName: payload?.hook_event_name ?? null,
                sessionId: payload?.session_id ?? null,
                agentId: payload?.agent_id ?? null,
                turnId: payload?.turn_id ?? null,
                cwd: payload?.cwd ?? null
            };
            parsed = true;
        } catch (error) {
            diagnostic = serializeCoreError(error);
        }
        const metadata = {
            receipt, source, parsed,
            coverage: {scope: 'received-codex-hook', sourceTimeKnown: false, sourceOrderKnown: false},
            originalAvailable: true,
            ...(diagnostic ? {diagnostic} : {})
        };
        await writeFile(join(storageDirectory, `${receipt.eventId}.json`), JSON.stringify(metadata), {encoding: 'utf8', flush: true});
        records.set(receipt.eventId, {metadata, originalPath});
        emit('pm.codexHooks.observed', structuredClone(metadata));
        return {status: 'received', ...structuredClone(metadata)};
    }

    async function read({eventId}, {signal} = {}) {
        const record = records.get(eventId);
        if (!record) {
            throw new CoreError({code: 'PM_CODEX_HOOK_RECEIPT_NOT_FOUND', message: 'That hook receipt is unavailable.', eventId});
        }
        const original = await readFile(record.originalPath, {encoding: 'utf8', signal});
        return {status: 'available', ...structuredClone(record.metadata), original};
    }

    function drain() {
        receiving = false;
        emit?.('pm.codexHooks.state', current());
    }

    function dispose() {
        receiving = false;
        emit = null;
    }

    return {
        name: 'pm.codexHooks',
        start,
        methods: {
            'pm.codexHooks.accept': {lifetime: 'service', handle: accept},
            'pm.codexHooks.status': current,
            'pm.codexHooks.read': read
        },
        drain,
        dispose
    };
}

export default createCodexHooksService;
