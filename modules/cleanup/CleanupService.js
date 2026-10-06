/** PM lifecycle policy; storage and resource operations stay with their owners. */
export function createCleanupService({pmData, bridge, disposableResources} = {}) {
    if (!pmData) {
        throw new TypeError('Arcane PM tidy-up requires the shared PM data owner.');
    }

    async function listProjectTargets(projectId = null, {signal} = {}) {
        signal?.throwIfAborted();
        const tasksRequest = pmData.listTasks(
            {projectId, signal}
        );
        const projectRequest = projectId ? pmData.getProject(projectId) : null;
        const resourcesRequest = disposableResources?.list
            ? disposableResources.list(
                {projectId, signal}
            )
            : [];
        const results = await Promise.allSettled(
            [projectRequest, tasksRequest, resourcesRequest]
        );
        signal?.throwIfAborted();

        return {
            project: results[0].status === 'fulfilled' ? results[0].value : null,
            tasks: results[1].status === 'fulfilled' ? results[1].value : results[1].reason?.records || [],
            resources: results[2].status === 'fulfilled' ? results[2].value : [],
            projectError: results[0].status === 'rejected' ? results[0].reason : null,
            tasksError: results[1].status === 'rejected' ? results[1].reason : null,
            resourcesError: results[2].status === 'rejected' ? results[2].reason : null,
            resourcesAvailable: Boolean(disposableResources?.list),
            nativeDeleteAvailable: false
        };
    }

    async function review({action, targetId, projectId = null}, {signal} = {}) {
        signal?.throwIfAborted();
        if (action === 'dispose-resource') {
            return reviewResource(targetId, projectId, signal);
        }

        const task = await pmData.getTask(targetId);
        signal?.throwIfAborted();
        if (!task || task.projectId !== projectId) {
            return {
                action,
                targetId,
                projectId,
                title: 'Task unavailable',
                available: false,
                effect: 'No task will change.',
                message: 'This task is no longer in the selected project. Refresh the task list.',
                retained: []
            };
        }

        const reviewRecord = {
            action,
            targetId,
            projectId,
            title: task.title,
            target: task,
            available: true,
            owner: 'Arcane PM',
            retained: ['Original Codex conversation', 'Project working files', 'Selected sources and saved handoffs'],
            message: ''
        };

        switch (action) {
            case 'archive-task':
                reviewRecord.effect = 'Put this PM task in the archive. Its complete record stays searchable.';
                reviewRecord.buttonLabel = 'Archive this PM task';
                break;
            case 'restore-task':
                reviewRecord.effect = 'Return this PM task to the active view with its history and identity.';
                reviewRecord.buttonLabel = 'Restore this PM task';
                break;
            case 'remove-task-record':
                reviewRecord.effect = 'Remove this one PM task record, including its assignment and PM lifecycle fields. Related records remain with their owners.';
                reviewRecord.buttonLabel = 'Remove this PM record';
                break;
            case 'delete-native-task':
                reviewRecord.owner = 'Codex';
                reviewRecord.available = false;
                reviewRecord.effect = 'Native Codex conversation deletion is a separate operation.';
                reviewRecord.message = 'The connected bridge does not provide native conversation deletion. Open the original conversation to manage it in Codex.';
                reviewRecord.retained = ['PM task record', 'Project working files', 'Selected sources and saved handoffs'];
                if (task.origin?.provider === 'codex') {
                    reviewRecord.nativeUrl = task.origin.url || (
                        task.origin.threadId && bridge?.getThreadUrl
                            ? bridge.getThreadUrl(task.origin.threadId)
                            : null
                    );
                }
                break;
            default:
                throw new TypeError(`Unknown PM tidy-up action: ${action}`);
        }

        return reviewRecord;
    }

    async function reviewResource(targetId, projectId, signal) {
        const resources = disposableResources?.list
            ? await disposableResources.list(
                {projectId, signal}
            )
            : [];
        signal?.throwIfAborted();
        const resource = resources.find(
            function findSelectedResource(candidate) {
                return candidate.id === targetId && candidate.projectId === projectId;
            }
        );
        const available = Boolean(
            resource?.appOwned === true
            && resource.lifecycle === 'disposable'
            && Array.isArray(resource.usedBy)
            && resource.usedBy.length === 0
            && disposableResources?.dispose
        );

        return {
            action: 'dispose-resource',
            targetId,
            projectId,
            title: resource?.title || 'App resource unavailable',
            target: resource || null,
            available,
            owner: resource?.owner || 'Resource owner unavailable',
            effect: 'Remove only this app-owned disposable resource through its owning module.',
            buttonLabel: 'Remove this disposable resource',
            retained: ['PM task records', 'Original Codex conversations', 'Project working files', 'Other app resources'],
            message: available ? '' : 'Only a resource its app owner marks disposable and no longer in use can be removed here.'
        };
    }

    async function execute(selectedReview, {signal} = {}) {
        const current = await review(
            selectedReview,
            {signal}
        );
        signal?.throwIfAborted();
        if (!current.available) {
            return {
                status: 'unavailable',
                review: current,
                message: current.message
            };
        }

        const {action, targetId} = current;
        let result;
        let status;
        let message;

        switch (action) {
            case 'archive-task':
                result = await pmData.archiveTask(targetId);
                status = result?.id === targetId && result.archivedAt ? 'completed' : 'unconfirmed';
                message = status === 'completed'
                    ? 'PM task archived. Its history remains available.'
                    : 'The data owner did not confirm archival. Refresh before trying again.';
                break;
            case 'restore-task':
                result = await pmData.restoreTask(targetId);
                status = result?.id === targetId && result.archivedAt === null
                    ? 'completed'
                    : 'unconfirmed';
                message = status === 'completed'
                    ? 'PM task restored to the active view.'
                    : 'The data owner did not confirm restoration. Refresh before trying again.';
                break;
            case 'remove-task-record':
                result = await pmData.removeTaskRecord(targetId);
                status = result?.id === targetId && result.removed === true
                    ? 'completed'
                    : 'unconfirmed';
                if (result?.id === targetId && result.removed === false) {
                    status = 'unchanged';
                }
                message = status === 'completed'
                    ? 'The selected PM task record was removed. Its original conversation and working files remain with their owners.'
                    : status === 'unchanged'
                        ? 'The selected PM task record was already absent.'
                        : 'The data owner did not confirm removal. Refresh before trying again.';
                break;
            case 'dispose-resource':
                result = await disposableResources.dispose(
                    targetId,
                    {signal}
                );
                status = result?.id === targetId && result.disposed === true
                    ? 'completed'
                    : 'unconfirmed';
                message = status === 'completed'
                    ? 'The resource owner confirmed removal of the selected disposable resource.'
                    : 'The resource owner did not confirm removal. Review its current state before trying again.';
                break;
        }

        // A committed owner write remains an observed result even if the view detached.
        return {status, action, targetId, projectId: current.projectId, message, result};
    }

    return {listProjectTargets, review, execute};
}
