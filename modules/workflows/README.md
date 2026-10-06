# PM orchestration, handoffs, and tidy-up

This application domain keeps a project's guide, assignments, observed work,
attention requests, and handoff preparation together. It uses the data owner's
`pmData` and `getStorage()`; it never opens a second database or edits a native
Codex conversation directly.

## Composition contract

All factories are synchronous. Their storage operations are asynchronous and
surface failures. The shell constructs each service once and passes it into
the selected view. Mounts return `{dispose(), refresh()}` and accept the shell's
page lifetime `signal`; mounting never sends a handoff or deletes a resource.

- `modules/workflows/index.js`: `createWorkflowService({pmData, getStorage})`
  and `mountGuideView(container, {workflows, pmData, projectId, taskId,
  onNavigate, onStatus, signal})`. `taskId` is optional. The module also exports
  `WORKFLOW_CHANGED_EVENT`.
- `modules/handoffs/index.js`: `createHandoffService({pmData, getStorage,
  sourceLibrary, bridge, localAI})` and `mountHandoffsView(container,
  {handoffs, pmData, sourceLibrary, projectId, taskId, handoffId, onNavigate,
  onStatus, signal})`.
- `modules/cleanup/index.js`: `createCleanupService({pmData, bridge,
  disposableResources})` and `mountCleanupView(container, {cleanup, pmData,
  projectId, onNavigate, onStatus, signal})`.

The shell loads the published Arcane theme, ThemeBootstrap, and primitives.
These PM views compose semantic native controls with `arcane-button` and
`arcane-card` primitives. Domain CSS stays beside its view. The shell retains
its fixed navigation and sole main scroll surface.

## Workflow service

`createWorkflowService({pmData, getStorage})` receives the shared data owner and
its ready-storage accessor. It returns these methods; record operations return
promises, while `subscribe` and `dispose` are synchronous.

| Method | Result and effect |
| --- | --- |
| `getProjectOverview(projectId, {signal} = {})` | Returns the project, guide, and task/workflow entries described below. |
| `assign(taskId, assignment, {signal} = {})` | Saves the complete assignment string through `pmData.updateTask`; returns the saved task. |
| `setNextAction(taskId, nextAction, {signal} = {})` | Saves the complete plan string through `pmData.updateTask`; returns the saved task. |
| `recordObservation(taskId, observation, {signal} = {})` | Saves attributed workflow evidence, updates task status, atomically appends task evidence, and returns `{task, observation}`. |
| `requestAttention(taskId, request, {signal} = {})` | Saves the request, updates the task's current attention and next action, and returns `{task, request}`. |
| `resolveAttention(taskId, attentionId, resolution, {signal} = {})` | Saves an answer to one workflow request and returns `{task, resolution, attentionCleared}`. |
| `setGuide(projectId, {name, taskId = null}, {signal} = {})` | Saves and returns this project's guide association. A supplied task must belong to this project. |
| `subscribe(handler, {signal} = {})` | Receives workflow-change detail and returns an unsubscribe function. |
| `dispose()` | Disposes this service's event source. Callers end their subscriptions with unsubscribe or their signal. |

Assignment and next-action changes leave task status unchanged. Guide changes
preserve task identity and face association; `taskId:null` represents a local
project guide with no associated task. These operations perform no native
Codex action, model inference, message delivery, or task execution.

### Overview and stored records

The overview has this shape:

```js
{
    project,
    guide,
    tasks: [
        {
            task,
            workflow: {
                history,
                observations,
                attentionRequests: [{request, resolution}],
                latestObservation
            }
        }
    ]
}
```

`project` and each `task` are the data owner's records. Archived tasks are
included. `guide` is `null` or
`{projectId, name, taskId, createdAt, updatedAt}`. `history` contains the
complete workflow entries for that task, ordered by `recordedAt`, then ID.
`observations` selects observation entries; `latestObservation` is the last
recorded observation or `null`. This ordering describes recording order, not
an inference about current activity. Each attention entry pairs its original
request with the last recorded resolution for that request, or `null`.

The shared DBOPFS connection stores guide records in `pm_project_guides` as
`<encoded-project-id>.json`. Workflow history is append-only in
`pm_workflow_events`, with one `<encoded-task-id>.<encoded-event-id>.json` per
entry. Every history entry contains
`{id, taskId, projectId, kind, recordedAt}` plus its authored fields. Kinds are
`observation`, `attention-requested`, and `attention-resolved`. A resolution
also carries `attentionId`. Generated UUIDs identify these PM records;
filenames encode identifiers only for storage transport.

One overview enumerates workflow keys once, selects keys for the project's
current task records, and reads those entries with at most four active readers.
It never rewrites history or opens another database. Removing a PM task leaves
its workflow records with this domain; an overview only includes tasks that
still appear in the selected project's data-owner list.

### Observation and attention inputs

An observation contains:

- `state`, `message`, `actor`, and `observedAt`: required nonblank strings.
  The caller supplies the actual observation time; the service preserves the
  supplied string rather than inventing one.
- `source`: `local-pm` by default or `connected-task`.
- `sourceRef`: a string or `null`, default `null`. Connected-task evidence
  requires a nonblank reference.
- `blockingEvidence` and `nextAction`: strings, each defaulting to `''`.
  Exact state `stalled` requires both to be nonblank.

The service retains these fields unchanged in the workflow entry. Its atomic
task update sets `status` to the supplied state and appends
`{message, observedAt, sourceRef}` to `observedEvidence`. A nonempty observation
`nextAction` also updates the task's next action; an empty value preserves the
existing plan. The separate `setNextAction` method can deliberately clear it.

A request contains required nonblank `message`, `nextAction`, and `actor`,
optional `sourceRef` (default `null`), and optional `requestedAt` (defaulting to
the actual current request time). It saves task attention as
`{message, requestedAt, sourceRef}` and saves the requested next action without
changing execution status.

A resolution contains required nonblank `message` and `actor`, plus optional
`resolvedAt` (defaulting to the actual current answer time). Its task update
compares the current attention's message, request time, and source reference
with the selected request while holding the data owner's same-task mutation
lock. Only a matching current request is cleared. A newer or different request
remains, with `attentionCleared:false`; the selected answer is still retained.
Resolving attention does not infer that work has started or completed.

States are recorded facts or explicit user decisions. Inactivity, elapsed time,
account changes, or unavailable models never infer a stalled task. A stalled
observation must supply the concrete blocking evidence and next action. Local
PM observations are labeled separately from connected-task evidence.

### Signals, failures, and events

Overview reads check the supplied signal before dependencies, between queued
record reads, and before returning; cancellation uses the signal's abort reason.
Writes check cancellation before their first durable operation. An accepted
assignment or next-action update completes through the data owner. An accepted
workflow-entry write and its subsequent task update finish even if the view
detaches, preserving the local operation's consistency. The view suppresses
detached UI updates and disposes subscriptions and control listeners.

Observation, request, and resolution operations write their full workflow entry
first, then apply the data-owner task update. These are distinct writes. If the
second write fails, the operation throws `PM_WORKFLOW_TASK_UPDATE` with the
complete `savedRecord` and original error as `cause`. The saved entry remains
available in history; its presence alone does not establish that the task
update succeeded. The view reports that partial result, retains entered text,
and offers refresh rather than automatically repeating the operation.

`PM_WORKFLOW_INPUT` describes invalid workflow fields;
`PM_WORKFLOW_NOT_FOUND` identifies an unavailable required project, task, or
attention request. A workflow-history read failure throws an `AggregateError`
with code `PM_WORKFLOW_READ`, readable `records`, and per-entry `failures`.
Other data-owner and SDK errors propagate. Ordinary UI shows the affected
operation and recovery action; complete errors remain in developer diagnostics.

`WORKFLOW_CHANGED_EVENT` is `arcane-pm.workflows.changed`. Canonical SDK
`arcaneEvents` publishes it from source `arcane-pm.workflows` with detail
`{projectId, taskId, action}`. Actions are `assignment`, `next-action`, `guide`,
`observation`, `attention-requested`, and `attention-resolved`. Workflow-entry
operations can notify once after history is saved and again after the task
update. Consumers re-read the records they need; a notification is neither a
remote acceptance signal nor a claim that both writes completed. Subscription
delivery is observational, within the current realm, with no replay or polling.

The guide mount loads its adjacent `guide.css`, composes shared Arcane
primitives, and returns `{refresh, dispose}`. It accepts an optional starting
task, preserves entered text across in-view refresh and selection changes,
and exposes complete history with task-record evidence separately available.
`onStatus(message)` receives ordinary visible status text. `onNavigate` uses
the existing `team`, `task`, and `handoffs` routes with selected IDs. Mounting
reads local records; saving requires an explicit form action.

## Handoff service

`createDraft({projectId, fromTaskId, toTaskId, assignment, decisions,
openQuestions, preparedNote, sourceIds})`, `get(id)`, `list({projectId})`,
`updateDraft(id, changes)`, `prepare(id, {signal})`, `markReady(id)`, and
`reopen(id)` provide local preparation and reopening. Assignment, decisions,
open questions, and prepared note are separate authored text fields. Source
selection records are kept complete and unchanged, with their metadata kept
outside original content. Preparation takes a complete selection through the
source owner's public API and stores it for offline review. Missing originals
remain visibly unavailable; a reference-only selection stays a reference.

`deliver(id, {signal})` is an explicit action through the bridge. It does not
run on save, ready, refresh, navigation, account reconnection, or verification.
`recordProgress(id, observation)` records receiving-task progress only from a
documented observed result. Optional `prepareNote(id, {signal, onChunk})` invokes
the local-AI owner's capability when available and keeps the note separate from
the original sources.

Preparing, ready, destination-confirmed accepted, started, and completed are
distinct outcomes. Delivery failures preserve the draft and complete sources.
An uncertain send is recorded as unconfirmed and requires reconciliation rather
than automatic retry. Acceptance is never inferred from a fulfilled Promise or
a local record write. Reopening an accepted handoff creates a new draft so its
accepted content and delivery history remain available. No native chat migration
or task-identity transfer is implied.

## Ownership and work shape

The PM-specific guide, assignment, attention, handoff, and tidy-up policies live
here. Shared storage, event coordination, styling, models, and host transport
remain with their existing SDK and application owners. There are no SDK or OS
source changes, local copies of generic SDK mechanics, or new dependencies.

An overview reads one selected project's tasks and one set of PM workflow
records. A handoff resolves each selected original once per explicit prepare,
then reuses the stored selection until the user edits the selection or prepares
again. Handoff file cleanup reads local handoff references once to preserve
every saved use before offering an unused snapshot for removal. The full
delivery and resource contract is in [the handoff module](../handoffs/README.md).
There is no polling, native cross-project scan, model call on page load, automatic
delivery retry, or content-length-based work. Views acknowledge work before
awaiting storage or a provider. Actual cold-path timing is unmeasured; local
tests, checks, and builds are not selected. Browser verification uses synthetic
records and performs no real-user deletion or handoff send.
