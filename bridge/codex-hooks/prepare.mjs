import {cp, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Prepare a reviewable local plugin artifact; this performs no installation.
const sourceRoot = fileURLToPath(new URL('./', import.meta.url));
const applicationRoot = fileURLToPath(new URL('../../', import.meta.url));
const destination = join(applicationRoot, 'output', 'bridge', 'codex-hooks');
const endpoint = process.argv[2] ?? 'http://127.0.0.1:4310';
await mkdir(destination, {recursive: true});
await Promise.all([
    cp(join(sourceRoot, 'plugin.json'), join(destination, 'plugin.json')),
    cp(join(sourceRoot, 'hooks'), join(destination, 'hooks'), {recursive: true}),
    cp(join(sourceRoot, 'scripts'), join(destination, 'scripts'), {recursive: true}),
    writeFile(join(destination, 'configuration.json'), JSON.stringify({applicationRoot, endpoint}, null, 2) + '\n', 'utf8')
]);
console.log(`Prepared passive hook plugin: ${destination}`);
