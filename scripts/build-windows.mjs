import {spawn} from 'node:child_process';
import {lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspect} from 'node:util';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputRoot = path.join(workspaceRoot, 'build', 'windows-x64');
const stagingRoot = path.join(workspaceRoot, 'dist', '.native', 'windows-x64');
const logRoot = path.join(workspaceRoot, 'output', 'foundation');
const lockPath = path.join(outputRoot, '.build-windows.lock.json');
const currentPath = path.join(outputRoot, 'current.json');
const nextCurrentPath = path.join(outputRoot, '.current-next.json');
const cancellation = new AbortController();
let runDirectory;
let finalResult;
let finalError;

function cancelWindowsBuild() {
    const error = new Error('Windows build cancelled.');
    error.exitCode = 130;
    cancellation.abort(error);
    console.error('Cancellation requested; waiting for the SDK child and owned cleanup to settle.');
}

console.error('Building one Arcane PM Windows artifact; preserving profiles, models, and shared runtime caches.');
process.on('SIGINT', cancelWindowsBuild);
try {
    finalResult = await buildWindows(cancellation.signal);
    cancellation.signal.throwIfAborted();
} catch (error) {
    finalError = error;
    console.error(inspect(error, {depth: null, maxArrayLength: null, maxStringLength: null}));
    process.exitCode = error.exitCode ?? 1;
}
try {
    if (runDirectory) {
        await writeFile(path.join(runDirectory, 'outcome.json'), `${JSON.stringify({
            ok: finalError === undefined,
            exitCode: process.exitCode ?? 0,
            finishedAt: new Date().toISOString(),
            result: finalResult ?? null,
            error: finalError === undefined ? null : inspect(finalError, {depth: null, maxArrayLength: null, maxStringLength: null})
        }, null, 2)}\n`);
    }
} catch (error) {
    console.error('Saving the final build outcome failed:', inspect(error, {depth: null, maxArrayLength: null, maxStringLength: null}));
    if (!process.exitCode) process.exitCode = 1;
} finally {
    process.removeListener('SIGINT', cancelWindowsBuild);
}

async function buildWindows(signal) {
    if (process.platform !== 'win32') throw new Error('This Windows build workflow requires Windows process inventory.');
    await mkdir(logRoot, {recursive: true});
    runDirectory = await mkdtemp(path.join(logRoot, 'windows-build-'));
    console.error(`Build diagnostics: ${runDirectory}`);
    signal.throwIfAborted();
    await mkdir(outputRoot, {recursive: true});
    await requireOwnedDirectory(outputRoot);
    const lock = await open(lockPath, 'wx').catch(function explainExistingBuild(error) {
        if (error.code === 'EEXIST') {
            throw new Error(`Another build owns ${lockPath}. Read its owner and staleRecovery before retrying.`, {cause: error});
        }
        throw error;
    });
    const acquiredAt = new Date();
    const ownership = {
        owner: 'Arcane PM Windows build',
        pid: process.pid,
        scope: [path.join(outputRoot, 'arcane-portable-*'), stagingRoot, currentPath, nextCurrentPath, path.join(logRoot, 'windows-build-*')],
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + 6 * 60 * 60 * 1000).toISOString(),
        releaseProcedure: 'The owning wrapper removes this lock after the SDK child and cleanup settle.',
        staleRecovery: 'Inspect Windows process inventory and .arcane/workspace-operation.lock.json. Only after the recorded wrapper PID and any SDK build child for this workspace are absent, remove this exact wrapper lock and rerun. Expiry never permits removing a live owner.'
    };
    let workflowError;
    try {
        await lock.writeFile(`${JSON.stringify(ownership, null, 2)}\n`);
        signal.throwIfAborted();
        const previous = await artifactDirectories();
        await requireInactive([...previous, stagingRoot]);
        signal.throwIfAborted();
        const retained = await selectPreviousArtifact(previous);
        for (const directory of previous) {
            if (directory !== retained) await removeBuildDirectory(directory);
        }
        await removeBuildDirectory(stagingRoot);
        const resultLog = path.join(runDirectory, 'result.json');
        const progressLog = path.join(runDirectory, 'progress.ndjson');
        const verificationLog = path.join(runDirectory, 'verification.json');
        console.error(`Complete SDK output: ${resultLog}`);
        console.error(`Complete SDK progress: ${progressLog}`);

        let built;
        let failure;
        try {
            signal.throwIfAborted();
            const cli = path.join(workspaceRoot, 'node_modules', 'arcane-os', 'bin', 'arcane.mjs');
            const execution = await runProcess(process.execPath, [
                cli, 'build', '--workspace', workspaceRoot, '--app', 'arcane-pm',
                '--target', 'windows-x64', '--output-root', outputRoot, '--output', 'json'
            ], {resultLog, progressLog});
            if (execution.error || execution.code !== 0) {
                const error = execution.error ?? new Error(`Arcane SDK build exited with ${execution.code ?? execution.signal}. Complete output: ${resultLog}; progress: ${progressLog}`);
                error.exitCode = execution.code === 0 ? 1 : execution.code ?? 1;
                throw error;
            }
            signal.throwIfAborted();
            const result = JSON.parse(execution.stdout);
            if (!result.ok || !result.result?.artifact?.target?.rootDir) {
                throw new Error('Arcane SDK did not return a successful native artifact. Complete SDK output is preserved above.');
            }
            const directory = path.resolve(result.result.artifact.target.rootDir);
            await requireArtifact(directory);
            await verifySelectedArtifact(result.result, verificationLog, signal);
            signal.throwIfAborted();
            await writeFile(nextCurrentPath, `${JSON.stringify({
                operationId: result.operationId,
                artifactRoot: directory,
                completedAt: new Date().toISOString(),
                logs: {result: resultLog, progress: progressLog, verification: verificationLog, outcome: path.join(runDirectory, 'outcome.json')}
            }, null, 2)}\n`);
            signal.throwIfAborted();
            await rename(nextCurrentPath, currentPath);
            built = directory;
            finalResult = {artifactRoot: built, currentRecord: currentPath};
        } catch (error) {
            failure = error;
        }

        // The child has closed before any output is removed. A failed replacement
        // keeps the previous finished artifact and removes only new partial output.
        const keep = built ?? retained;
        try {
            const directories = await artifactDirectories();
            const obsolete = directories.filter(function obsoleteArtifact(directory) { return directory !== keep; });
            await requireInactive([...obsolete, stagingRoot]);
            for (const directory of obsolete) await removeBuildDirectory(directory, previous.includes(directory));
            await removeBuildDirectory(stagingRoot, false);
        } catch (error) {
            if (failure) {
                const buildFailure = failure;
                failure = new AggregateError([buildFailure, error], 'The SDK build and cleanup both failed.', {cause: buildFailure});
                failure.exitCode = buildFailure.exitCode;
            } else {
                failure = error;
            }
        }
        if (failure) throw failure;
        console.error(`Current finished Windows artifact: ${built}`);
    } catch (error) {
        workflowError = error;
    }
    try {
        await lock.close();
        const currentOwner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (currentOwner.pid === ownership.pid && currentOwner.acquiredAt === ownership.acquiredAt) {
            await rm(lockPath);
        } else {
            throw new Error(`The build lock changed owners and was preserved: ${lockPath}`);
        }
    } catch (error) {
        if (workflowError) workflowError.lockReleaseError = error;
        else workflowError = error;
    }
    if (workflowError) throw workflowError;
    return finalResult;
}

async function artifactDirectories() {
    const entries = await readdir(outputRoot, {withFileTypes: true});
    return entries.filter(function selectedArtifact(entry) {
        return entry.name.startsWith('arcane-portable-') && (entry.isDirectory() || entry.isSymbolicLink());
    }).map(function artifactPath(entry) { return path.join(outputRoot, entry.name); });
}

async function selectPreviousArtifact(directories) {
    if (directories.length === 0) return undefined;
    let selected;
    try {
        selected = path.resolve(JSON.parse(await readFile(currentPath, 'utf8')).artifactRoot);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (!directories.includes(selected)) {
        if (directories.length !== 1) {
            throw new Error(`Multiple existing artifacts have no matching successful build record at ${currentPath}. Preserve them until the current artifact is identified.`);
        }
        selected = directories[0];
    }
    await requireArtifact(selected);
    return selected;
}

async function requireArtifact(directory) {
    if (path.dirname(directory) !== outputRoot || !path.basename(directory).startsWith('arcane-portable-')) {
        throw new Error(`SDK artifact is outside the selected Windows output directory: ${directory}`);
    }
    await requireOwnedDirectory(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, 'arcane-native.json'), 'utf8'));
    if (manifest.kind !== 'arcane-windows-native' || manifest.app?.id !== 'arcane-pm' || manifest.target?.target !== 'windows-x64') {
        throw new Error(`Expected a finished Arcane PM Windows artifact at ${directory}.`);
    }
}

async function requireOwnedDirectory(directory) {
    const canonicalWorkspace = await realpath(workspaceRoot);
    const canonical = await realpath(directory);
    const expected = path.relative(workspaceRoot, directory).toLowerCase();
    const actual = path.relative(canonicalWorkspace, canonical).toLowerCase();
    if (actual !== expected || !(await lstat(directory)).isDirectory()) {
        throw new Error(`Build directory resolves outside its selected project location: ${directory}`);
    }
}

async function verifySelectedArtifact(built, verificationLog, signal) {
    const [{verifyApp, verifyNativeArtifact}, {default: nativeBuilder}] = await Promise.all([
        import('arcane-os'),
        import('arcane-os/native/windows-provider')
    ]);
    console.error('Verifying the selected package and Windows artifact through the public SDK.');
    const results = await Promise.allSettled([
        verifyApp({workspaceRoot, appId: 'arcane-pm', outputDirectory: built.release.output, signal}),
        verifyNativeArtifact({target: 'windows-x64', nativeBuilder, artifact: built.artifact, targetRequest: built.plan.targetRequest, signal})
    ]);
    await writeFile(verificationLog, `${JSON.stringify(results.map(function completeVerificationRecord(result) {
        return result.status === 'fulfilled' ? result : {
            status: result.status,
            reason: inspect(result.reason, {depth: null, maxArrayLength: null, maxStringLength: null})
        };
    }), null, 2)}\n`);
    const failures = results.filter(function failedVerification(result) { return result.status === 'rejected'; })
        .map(function verificationError(result) { return result.reason; });
    if (failures.length) {
        const error = new AggregateError(failures, `Selected artifact verification failed; complete results: ${verificationLog}`);
        if (signal.aborted) error.exitCode = 130;
        throw error;
    }
}

async function reviewManifestInventory(directory, manifestPath, prefix = '') {
    await requireOwnedDirectory(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, manifestPath), 'utf8'));
    const files = new Set([manifestPath, ...manifest.files.map(function declaredFile(relative) {
        return path.posix.join(prefix, relative);
    })]);
    const pending = [''];
    const unlisted = [];
    while (pending.length) {
        const relative = pending.pop();
        for (const entry of await readdir(path.join(directory, relative), {withFileTypes: true})) {
            const member = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) {
                pending.push(member);
            } else if (!entry.isFile() || !files.has(member)) {
                unlisted.push(member);
            }
        }
    }
    if (unlisted.length) {
        throw new Error(`Preserving ${directory}; these entries are outside its generated manifest inventory:\n${unlisted.join('\n')}`);
    }
}

async function removeBuildDirectory(directory, reviewExisting = true) {
    if (directory !== stagingRoot && (path.dirname(directory) !== outputRoot || !path.basename(directory).startsWith('arcane-portable-'))) {
        throw new Error(`This directory is outside the selected disposable build output: ${directory}`);
    }
    try {
        await requireOwnedDirectory(directory);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    if (reviewExisting) {
        if (directory === stagingRoot) {
            const entries = await readdir(directory);
            if (entries.length) await reviewManifestInventory(directory, 'arcane-pm/ARCANE_APP_RELEASE.json', 'arcane-pm');
        } else {
            await reviewManifestInventory(directory, 'arcane-native.json');
        }
    }
    console.error(`Removing disposable build output: ${directory}`);
    await rm(directory, {recursive: true, force: true});
}

async function requireInactive(directories) {
    const command = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath) | ConvertTo-Json -Compress';
    const inventory = await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]);
    if (inventory.error || inventory.code !== 0) {
        throw new Error(`Windows process inventory failed (${inventory.code}):\n${inventory.stdout}${inventory.stderr}`, {cause: inventory.error});
    }
    const processes = JSON.parse(inventory.stdout || '[]');
    const active = processes.filter(function artifactProcess(item) {
        if (!item.ExecutablePath) return false;
        return directories.some(function executableInsideArtifact(directory) {
            const relative = path.relative(directory.toLowerCase(), path.resolve(item.ExecutablePath).toLowerCase());
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
    });
    if (active.length) {
        throw new Error(`Close these Arcane PM artifact processes normally before rebuilding; no process was stopped:\n${JSON.stringify(active, null, 2)}`);
    }
}

async function runProcess(command, args, logs) {
    const errors = [];
    const stdout = [];
    const stderr = [];
    let resultHandle;
    let progressHandle;
    let outcome;
    try {
        if (logs) {
            resultHandle = await open(logs.resultLog, 'wx');
            progressHandle = await open(logs.progressLog, 'wx');
        }
        outcome = await new Promise(function ownChildProcess(resolve) {
            const child = spawn(command, args, {
                cwd: workspaceRoot,
                windowsHide: true,
                stdio: ['inherit', resultHandle?.fd ?? 'pipe', progressHandle?.fd ?? 'pipe']
            });
            if (!logs) {
                child.stdout.setEncoding('utf8');
                child.stderr.setEncoding('utf8');
                child.stdout.on('data', function collectStandardOutput(chunk) { stdout.push(chunk); });
                child.stderr.on('data', function collectStandardError(chunk) { stderr.push(chunk); });
                child.stdout.on('error', function retainOutputPipeError(error) { errors.push(error); });
                child.stderr.on('error', function retainErrorPipeError(error) { errors.push(error); });
            }
            child.once('error', function retainChildError(error) { errors.push(error); });
            child.once('close', function settleChildProcess(code, signal) { resolve({code, signal}); });
        });
    } catch (error) {
        errors.push(error);
    } finally {
        const closed = await Promise.allSettled([resultHandle?.close(), progressHandle?.close()]);
        for (const result of closed) {
            if (result.status === 'rejected') errors.push(result.reason);
        }
    }
    if (logs) {
        const captured = await Promise.allSettled([
            readFile(logs.resultLog, 'utf8'),
            readFile(logs.progressLog, 'utf8')
        ]);
        if (captured[0].status === 'fulfilled') stdout.push(captured[0].value);
        if (captured[1].status === 'fulfilled') stderr.push(captured[1].value);
        for (const result of captured) {
            if (result.status === 'rejected') errors.push(result.reason);
        }
    }
    return {
        ...outcome,
        error: errors.length ? new AggregateError(errors, 'The child process or its output failed.') : undefined,
        stdout: stdout.join(''),
        stderr: stderr.join('')
    };
}
