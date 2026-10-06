import {spawn} from 'node:child_process';
import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';
import {CoreError, serializeCoreError} from 'arcane-os/core/contracts';

/** Locate the user's installed Codex without installing or updating it. */
export async function resolveCodexCommand(command, {signal} = {}) {
    signal?.throwIfAborted();
    if (command !== undefined) return command;
    const windows = process.platform === 'win32';
    const executable = windows ? 'codex.exe' : 'codex';
    const candidates = [];
    const accessErrors = [];
    for (const directory of (process.env.PATH || '').split(delimiter)) {
        if (!directory) continue;
        const path = directory.startsWith('"') && directory.endsWith('"')
            ? directory.substring(1, directory.length - 1) : directory;
        candidates.push(join(path, executable));
    }
    // These are the documented standalone installer destinations. A GUI
    // application's inherited PATH can predate the user's CLI installation.
    if (process.env.CODEX_INSTALL_DIR) candidates.push(join(process.env.CODEX_INSTALL_DIR, executable));
    if (windows && process.env.LOCALAPPDATA) {
        candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', executable));
    } else if (!windows) {
        candidates.push(join(homedir(), '.local', 'bin', executable));
    }
    if (process.platform === 'darwin') {
        candidates.push('/Applications/Codex.app/Contents/Resources/codex');
        candidates.push(join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'));
    }
    for (const candidate of new Set(candidates)) {
        signal?.throwIfAborted();
        if (await executableExists(candidate, accessErrors)) return candidate;
    }
    if (windows) {
        // The current user's registered package identifies the active install;
        // scanning version folders or choosing by modification time does not.
        const installations = await registeredWindowsCodex({signal});
        for (const installation of installations) {
            signal?.throwIfAborted();
            const candidate = join(installation, 'app', 'resources', 'codex.exe');
            if (await executableExists(candidate, accessErrors)) return candidate;
        }
    }
    if (accessErrors.length) {
        throw new CoreError({
            code: 'PM_CODEX_EXECUTABLE_UNAVAILABLE',
            message: 'The installed Codex executable could not be opened.',
            diagnostics: accessErrors
        });
    }
    throw new CoreError({
        code: 'PM_CODEX_EXECUTABLE_NOT_FOUND',
        message: 'Codex could not be found. Install Codex or configure its executable in the Arcane PM host.'
    });
}

async function executableExists(path, accessErrors) {
    try {
        if (!(await stat(path)).isFile()) return false;
        await access(path, constants.X_OK);
        return true;
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
        if (['EACCES', 'EPERM'].includes(error.code)) {
            accessErrors.push(serializeCoreError(error));
            console.error('Codex executable discovery could not read a candidate', error);
            return false;
        }
        throw error;
    }
}

async function registeredWindowsCodex({signal}) {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
        "$ErrorActionPreference='Stop'",
        '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()',
        "ConvertTo-Json -Compress -InputObject @(Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation })"
    ].join('\n');
    const result = await new Promise(function readRegisteredInstallations(resolve, reject) {
        const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal
        });
        let output = '';
        let diagnostics = '';
        const failures = [];
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', function retainPackageLocations(content) { output += content; });
        child.stderr.on('data', function retainPackageDiscoveryError(content) { diagnostics += content; });
        child.stdout.once('error', function retainDiscoveryOutputFailure(error) { failures.push(serializeCoreError(error)); });
        child.stderr.once('error', function retainDiscoveryDiagnosticFailure(error) { failures.push(serializeCoreError(error)); });
        child.once('error', function retainDiscoveryFailure(error) { failures.push(serializeCoreError(error)); });
        child.once('close', function finishPackageDiscovery(code, terminationSignal) {
            if (signal?.aborted) {
                reject(signal.reason);
            } else if (failures.length) {
                reject(new CoreError({...failures[0], failures, output, diagnostics}));
            } else if (code !== 0) {
                reject(new CoreError({
                    code: 'PM_CODEX_INSTALLATION_DISCOVERY_FAILED',
                    message: 'The installed Codex application could not be located.',
                    processExit: {code, signal: terminationSignal}, output, diagnostics
                }));
            } else resolve({output, diagnostics});
        });
    });
    signal?.throwIfAborted();
    if (result.diagnostics) console.error('Codex installation discovery diagnostics', result.diagnostics);
    try {
        const locations = JSON.parse(result.output);
        if (!Array.isArray(locations) || locations.some(function invalidLocation(location) {
            return typeof location !== 'string' || !location;
        })) throw new TypeError('Windows returned an unreadable Codex installation list.');
        return locations;
    } catch (cause) {
        throw new CoreError({
            code: 'PM_CODEX_INSTALLATION_DISCOVERY_FAILED',
            message: 'The installed Codex application could not be located.',
            ...result, cause
        });
    }
}
