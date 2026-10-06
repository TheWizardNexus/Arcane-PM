import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {CoreError, serializeCoreError} from 'arcane-os/core/contracts';

/** Preserve the two project sources separately; PM Data owns their mapping. */
export async function readProjectCatalog(codex, {signal} = {}) {
    signal?.throwIfAborted();
    const [native, desktop] = await Promise.all([
        readNativeProjects(),
        readDesktopProjects()
    ]);
    signal?.throwIfAborted();
    return {
        hostId: codex.hostName,
        observedAt: new Date().toISOString(),
        native,
        desktop,
        coverage: {complete: native.coverage.complete && desktop.coverage.complete}
    };

    async function readNativeProjects() {
        const projects = [];
        const pages = [];
        let cursor = null;
        let complete = false;
        let diagnostic;
        try {
            do {
                signal?.throwIfAborted();
                const page = await codex.request('project/list', {cursor}, {signal});
                signal?.throwIfAborted();
                pages.push(page);
                if (!Array.isArray(page.data)) {
                    throw new CoreError({code: 'PM_CODEX_PROJECT_PAGE_INVALID', message: 'Codex returned an incomplete project page.'});
                }
                for (const project of page.data) projects.push(project);
                if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
                    throw new CoreError({code: 'PM_CODEX_PROJECT_CURSOR_MISSING', message: 'Codex did not return a project pagination cursor.'});
                }
                cursor = page.nextCursor;
            } while (cursor !== null);
            complete = true;
        } catch (error) {
            if (signal?.aborted) throw error;
            diagnostic = serializeCoreError(error);
            codex.diagnostic('project-catalog-native', error);
        }
        return {
            status: complete ? 'available' : pages.length ? 'partial' : 'unavailable',
            projects,
            pages,
            coverage: {complete, nextCursor: cursor},
            ...(diagnostic ? {diagnostic} : {})
        };
    }

    async function readDesktopProjects() {
        const selected = {};
        let complete = false;
        let diagnostic;
        try {
            signal?.throwIfAborted();
            const resolvedHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
            const hostKey = `local:${resolvedHome}`;
            const content = await readFile(join(resolvedHome, '.codex-global-state.json'), {encoding: 'utf8', signal});
            signal?.throwIfAborted();
            const state = JSON.parse(content);
            // This explicitly selected desktop metadata never leaves its owner
            // as a complete global-state object and is never written here.
            const sources = {
                localProjects: state?.['local-projects'],
                threadAssignments: state?.['thread-project-assignments'],
                nativeProjectIdsByLegacyId: state?.['app-server-project-id-by-legacy-project-id-by-host']?.[hostKey],
                migration: state?.['app-server-projects-migration-by-host']?.[hostKey]
            };
            const unavailableFields = [];
            for (const [name, value] of Object.entries(sources)) {
                if (value !== undefined) selected[name] = value;
                if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailableFields.push(name);
            }
            if (unavailableFields.length) {
                throw new CoreError({
                    code: 'PM_CODEX_DESKTOP_PROJECT_METADATA_INCOMPLETE',
                    message: 'Some desktop project metadata is unavailable.',
                    unavailableFields
                });
            }
            complete = true;
        } catch (error) {
            if (signal?.aborted) throw error;
            diagnostic = serializeCoreError(error);
            codex.diagnostic('project-catalog-desktop', error);
        }
        return {
            status: complete ? 'available' : Object.keys(selected).length ? 'partial' : 'unavailable',
            ...selected,
            observedAt: new Date().toISOString(),
            coverage: {complete},
            ...(diagnostic ? {diagnostic} : {})
        };
    }
}
