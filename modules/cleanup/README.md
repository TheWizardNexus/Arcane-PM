# Arcane PM tidy-up

This module owns the Arcane PM cleanup workflow: review one exact target, carry
out the selected owner operation, and report its observed result. Archiving a PM
task, removing its PM record, deleting its native Codex chat, and disposing of
an app-owned resource are separate actions.

## Capability decision

- Users need to put a PM task away, restore it, or review a precisely scoped
  removal without confusing a reference with its original chat or working files.
- PM task lifecycle and these ownership distinctions are PM-specific business
  behavior. Storage, native Codex operations, and resource disposal remain with
  their data, bridge, and resource owners.
- The panel composes the published Arcane `arcane-button`, `arcane-card`,
  `arcane-field`, and `arcane-state` primitives. The foundation loads the shared
  theme, ThemeBootstrap, and primitives before app styling.
- There are no provider/model calls, local storage implementations, folder
  scanners, generic deletion adapters, or new third-party dependencies here.
- Work is one project listing and one selected action at a time in the panel.
  A listing reads each owning collection once; execution calls only the selected
  owner. No item triggers repeated project scans or automatic cleanup.
- Source and intended diff review are selected. Tests, checks, builds, and live
  destructive verification remain unselected. Runtime timings are unmeasured.

## Callable contract

`index.js` exports:

```js
createCleanupService({pmData, bridge, disposableResources});
mountCleanupView(container, {
    cleanup, pmData, projectId, onNavigate, onStatus, signal
});
```

The synchronous factory receives the application's one `pmData` owner, its
optional Codex bridge, and an optional explicit owner of disposable resources.
It opens no database. `projectId:null` (the default) selects unassociated PM
tasks, following the data owner's contract. All service operations are asynchronous:

| Method | Result and side effects |
| --- | --- |
| `listProjectTargets(projectId, {signal} = {})` | Reads the selected project, its complete active and archived task list, and the optional resource inventory concurrently. Returns `{project,tasks,resources,projectError,tasksError,resourcesError,resourcesAvailable,nativeDeleteAvailable}`. Partial data-list failure retains its readable `error.records` and the complete error. Starts no model or native process. |
| `review({action,targetId,projectId}, {signal} = {})` | Reads one exact task or resource, returning `{action,targetId,projectId,title,target,owner,available,effect,buttonLabel,retained,message,nativeUrl?}`. It performs no mutation. Missing or moved targets are unavailable. |
| `execute(review, {signal} = {})` | Refreshes the selected target's current ownership/lifecycle, then invokes only the selected operation. Returns `{status,action,targetId,projectId,message,result}` or `{status:'unavailable',review,message}`. Owner errors reject unchanged. |

An `execute` status is `completed` only after the owning operation explicitly
confirms the matching target's result. `unchanged` is an already absent PM row.
`unconfirmed` means the owner response did not establish completion and requires
current-state review before another attempt. No operation is retried
automatically. The complete owner result remains available to the caller;
ordinary UI displays the separate user-facing message.

| Action | Owning operation and effect |
| --- | --- |
| `archive-task` | `pmData.archiveTask(id)` updates PM archive metadata. The task's status, identity, full content and related records remain available. |
| `restore-task` | `pmData.restoreTask(id)` clears PM archive metadata. |
| `remove-task-record` | `pmData.removeTaskRecord(id)` removes exactly that PM row. Sources, handoffs, model/face assets, native chats and working files remain with their owners. |
| `delete-native-task` | Unavailable in this bridge increment. The UI can open an existing Codex origin URL, or the bridge's documented `getThreadUrl(threadId)` link, without asserting navigation success. |
| `dispose-resource` | Calls only the explicit resource owner's `dispose(id,{signal})` for an app-owned resource whose current lifecycle is disposable with no current users. |

Native Codex archive/restore methods are separate bridge operations and are
never called by PM task archival. The installed native CLI's broader method
inventory does not select deletion for this initial bridge increment.

## Disposable-resource owner

This optional PM integration has two asynchronous methods:

```js
list({projectId, signal});
dispose(id, {signal});
```

`list` returns complete records with
`{id,projectId,title,owner,purpose,location,appOwned,lifecycle,usedBy}`.
`usedBy` contains complete string identifiers or labels for current users.
The owner records actual creation ownership and lifecycle rather than inferring
disposability from a path, task archive, age, or filename. `appOwned:true`,
`lifecycle:'disposable'`, and an empty `usedBy` array select an available
disposal action. `active` and `retained` resources remain reviewable without a
removal action. Unknown ownership or use remains with its owner. No selected
system folder becomes a cleanup candidate.

`dispose` owns the real deletion, checks current lifecycle at its mutation
boundary, preserves unrelated resources, and returns `{id,disposed:true}` only
when the selected resource has actually been removed. It propagates the signal
to its operation when cancellation is supported; an accepted mutation must
report its real result. There is no default filesystem or model-asset remover.
With no resource owner configured, the app-file view explains its unavailability.

## View and lifecycle

The mount returns `{refresh,dispose}` and renders immediately before storage
reads. `onStatus(message)` receives concise ordinary status as a string;
observer errors are diagnostic and do not change the selected action's result.
`pmData` and `onNavigate` are accepted shell composition fields; this focused
view needs only its injected cleanup service for data operations.

Tasks, app files, and working folders have separate views. A selected target
review shows its owner, exact record, effect and preserved related content.
The explicit action button is the mutation trigger. Opening, refreshing,
reviewing or switching views executes nothing. An uncertain action preserves
the selected review and disables another attempt until a fresh target review.

The view links its own `AbortController` to the shell's page signal. Disposal
removes its DOM and aborts queued reads and resource work; data writes already
accepted by the data owner complete there and are not misrepresented as undone.
Late reads and disposed views do not alter the mounted UI. There are no timers
or polling. Exact diagnostics go to the developer console, outside saved chat.

The component loads only its own `cleanup.css`, relies on the foundation's
Arcane theme and primitives, and introduces no document scrollbar or fixed
shell changes. Native labels and buttons preserve keyboard operation; complete
record text wraps and remains readable as content grows.

## Source review boundary

Current source was inspected against the PM data and bridge READMEs and the
data owner's archive, restore, removal and partial-list implementations. No
local test, check, linter, build, or runtime deletion was run by this owner.
The mounted application and any selected browser verification remain with the
composing workflow and foundation owners.
