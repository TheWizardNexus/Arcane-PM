import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Prepare a reviewable local plugin artifact; this performs no installation.
const sourceRoot = fileURLToPath(new URL('./', import.meta.url));
const applicationRoot = fileURLToPath(new URL('../../', import.meta.url));
const native = process.argv[2] === '--native';
const destination = join(applicationRoot, 'output', 'bridge', native ? 'codex-hooks-native' : 'codex-hooks');
let configuration;
if (native) {
    const {readCoreLaunchContext} = await import('arcane-os/core/host');
    const descriptor = JSON.parse(await readFile(join(applicationRoot, 'arcane-app.json'), 'utf8'));
    if (!process.argv[3]) throw new Error('Supply the native application launch working directory after --native.');
    const workingDirectory = resolve(process.argv[3]);
    const argv = process.argv.slice(4);
    const defaults = descriptor.native?.launchContext;
    const selection = {argv, workingDirectory};
    // Match the packaged Core entry: app ID resolution is selected only when
    // the descriptor supplies launch defaults. Explicit launch files still work.
    if (defaults !== undefined) {
        selection.appId = descriptor.id;
        selection.defaults = defaults;
    }
    process.chdir(workingDirectory);
    const context = await readCoreLaunchContext(selection);
    if (context.coreListener !== undefined && context.sharedHost !== undefined) {
        throw new TypeError('Select either coreListener or sharedHost in the native application launch context.');
    }
    const endpoint = context.coreListener !== undefined ? context.coreListener?.endpoint : context.sharedHost?.endpoint;
    if (!endpoint) {
        throw new Error('Select a Core listener or shared host endpoint in the native application launch context before preparing its hook relay.');
    }
    configuration = {applicationRoot, native: selection};
} else {
    const endpoint = process.argv[2] ?? 'http://127.0.0.1:4310';
    configuration = {applicationRoot, endpoint};
}
await mkdir(destination, {recursive: true});
await Promise.all([
    cp(join(sourceRoot, 'plugin.json'), join(destination, 'plugin.json')),
    cp(join(sourceRoot, 'hooks'), join(destination, 'hooks'), {recursive: true}),
    cp(join(sourceRoot, 'scripts'), join(destination, 'scripts'), {recursive: true}),
    writeFile(join(destination, 'configuration.json'), JSON.stringify(configuration, null, 2) + '\n', 'utf8')
]);
console.log(`Prepared passive hook plugin: ${destination}`);
