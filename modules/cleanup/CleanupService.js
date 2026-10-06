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
            nativeDeleteAvailable: Boolean(bridge?.status?.().capabilities?.deleteThread)
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
                reviewRecord.effect = 'Remove this one PM task record, including its assignment and PM lifecycle fields. Its original conversation and related records remain with their owners. A later deliberate Codex discovery may create a new PM record for that conversation.';
                reviewRecord.buttonLabel = 'Remove this PM record';
                break;
            case 'archive-native-task':
            case 'restore-native-task':
            case 'delete-native-task':
                return reviewNative(reviewRecord);
            default:
                throw new TypeError(`Unknown PM tidy-up action: ${action}`);
        }

        return reviewRecord;
    }

    function reviewNative(record) {
        const origin = record.target.origin;
        const connection = bridge?.status?.();
        const connectedIdentity = connection?.connected && connection.originIdentity
            ? {
                connectionId: connection.connectionId,
                originIdentity: {...connection.originIdentity}
            }
            : null;
        record.owner = 'Codex';
        record.retained = ['PM task record and its archive state', 'Project working files', 'Selected sources and saved handoffs'];
        record.native = {
            threadId: origin?.provider === 'codex' ? origin.threadId : null,
            origin: origin ? {
                provider: origin.provider,
                accountId: origin.accountId,
                hostId: origin.hostId
            } : null,
            identity: null,
            connectedIdentity,
            descendants: ''
        };
        let method;
        switch (record.action) {
            case 'archive-native-task':
                method = 'archiveThread';
                record.effect = 'Archive the selected original Codex conversation. Codex also attempts to archive its spawned descendants. This may stop their work or close pending prompts on this connection, even if archival later fails.';
                record.native.descendants = 'A successful request confirms the selected conversation. Individual descendants can fail to archive; their results remain unconfirmed here.';
                record.buttonLabel = 'Archive this Codex conversation';
                break;
            case 'restore-native-task':
                method = 'restoreThread';
                record.effect = 'Restore the selected original Codex conversation from the native archive.';
                record.native.descendants = 'This restores only the selected conversation. Restoration of spawned descendants is not part of this operation.';
                record.buttonLabel = 'Restore this Codex conversation';
                break;
            case 'delete-native-task':
                method = 'deleteThread';
                record.effect = 'Permanently delete the selected original Codex conversation and its spawned descendants. This cannot be undone; archiving first is unnecessary. Work or pending prompts on this connection may stop before deletion completes.';
                record.native.descendants = 'Codex includes spawned descendants in deletion. Individual descendant results remain unconfirmed here; a failed or interrupted request can still have changed native records.';
                record.buttonLabel = 'Permanently delete this Codex conversation';
                break;
        }

        if (record.native.threadId) {
            record.nativeUrl = bridge?.getThreadUrl
                ? bridge.getThreadUrl(record.native.threadId)
                : origin.url || null;
        }
        record.available = false;
        if (origin?.provider !== 'codex' || !origin.threadId) {
            record.message = 'This PM task has no linked Codex conversation. Associate the original conversation in Connections first.';
        } else if (!origin.accountId || !origin.hostId) {
            record.message = 'The saved association has no complete native account and host identity. Associate this conversation with the intended connection in Connections first.';
        } else if (!connection?.connected) {
            record.message = 'Connect to the intended Codex account and host in Connections, then review this action again.';
        } else if (connectedIdentity?.connectionId === undefined || connectedIdentity?.connectionId === null
            || !connectedIdentity.originIdentity.accountId || !connectedIdentity.originIdentity.hostId) {
            record.message = 'Codex has not supplied the current account and host identity. Review this action after the connection identity is available.';
        } else if (!sameOrigin(origin, connectedIdentity.originIdentity)) {
            record.message = 'This task is associated with a different Codex account or host. Connect to its recorded destination, then review the action again.';
        } else if (!connection.capabilities?.[method] || typeof bridge?.[method] !== 'function') {
            record.message = 'The current Codex connection does not provide this action.';
        } else {
            record.native.identity = connectedIdentity;
            record.available = true;
        }
        return record;
    }

    function sameOrigin(left, right) {
        return left?.provider === 'codex' && right?.provider === 'codex'
            && Boolean(left.accountId) && left.accountId === right.accountId
            && Boolean(left.hostId) && left.hostId === right.hostId;
    }

    function sameIdentity(left, right) {
        return left?.connectionId !== undefined && left?.connectionId !== null
            && left.connectionId === right?.connectionId
            && sameOrigin(left.originIdentity, right.originIdentity);
    }

    function subscribeNative(listener, options) {
        if (bridge?.subscribe) {
            return bridge.subscribe(listener, options);
        }
        return function stopUnavailableSubscription() {};
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
        if (current.native) {
            if (selectedReview.native?.threadId !== current.native.threadId
                || !sameOrigin(selectedReview.native?.origin, current.native.origin)
                || !sameIdentity(selectedReview.native?.identity, current.native.identity)) {
                return {
                    status: 'target-changed',
                    action,
                    targetId,
                    projectId: current.projectId,
                    review: {...current, available: false},
                    message: 'The native destination or connection changed after review. Review the intended conversation again before acting.'
                };
            }
            return executeNative(current, signal);
        }
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
                    ? 'The selected PM task record was removed. Its original conversation and working files remain with their owners. A later deliberate Codex discovery may create a new PM record.'
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

    async function executeNative(current, signal) {
        const {action, targetId, projectId, native} = current;
        let method;
        let expectedStatus;
        let completedMessage;
        switch (action) {
            case 'archive-native-task':
                method = 'archiveThread';
                expectedStatus = 'archived';
                completedMessage = 'Codex confirmed archival of the selected conversation. It also attempted its spawned descendants; individual descendant results remain unconfirmed here.';
                break;
            case 'restore-native-task':
                method = 'restoreThread';
                expectedStatus = 'restored';
                completedMessage = 'Codex confirmed restoration of the selected conversation. Spawned descendants were not selected for restoration.';
                break;
            case 'delete-native-task':
                method = 'deleteThread';
                expectedStatus = 'deleted';
                completedMessage = 'Codex acknowledged deletion of the selected conversation and its spawned-descendant operation. Individual descendant results remain unconfirmed here.';
                break;
        }

        let result;
        try {
            result = await bridge[method](
                {threadId: native.threadId, identity: native.identity, signal}
            );
        } catch (error) {
            // Even a native error can follow partial descendant changes.
            return {
                status: error?.response ? 'failed' : 'unconfirmed',
                action,
                targetId,
                projectId,
                native,
                error,
                message: error?.response
                    ? 'Codex reported a failure. Some native records may already have changed. Inspect the original conversation and its descendants before another action.'
                    : 'The Codex outcome is unconfirmed. Inspect the original conversation and its descendants before another action; this request will not be repeated automatically.'
            };
        }

        if (result?.status === 'unavailable') {
            return {
                status: 'unavailable',
                action,
                targetId,
                projectId,
                native,
                result,
                message: 'The intended Codex destination is unavailable or changed before dispatch. Review its current connection and target before acting again.'
            };
        }
        const completed = result?.status === expectedStatus
            && result.threadId === native.threadId
            && sameIdentity(result.identity, native.identity);
        return {
            status: completed ? 'completed' : 'unconfirmed',
            action,
            targetId,
            projectId,
            native,
            observedAt: result?.observedAt || null,
            result,
            message: completed
                ? `${completedMessage} PM records, sources, handoffs and working files remain with their owners.`
                : 'The bridge did not confirm this exact native action and destination. Inspect the original conversation and its descendants before another action.'
        };
    }

    return {listProjectTargets, review, execute, subscribeNative};
}
