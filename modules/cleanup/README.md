# Arcane PM tidy-up

This module owns the Arcane PM cleanup workflow: review one exact target, carry
out the selected owner operation, and report its observed result. PM task
archival, restoration and record removal remain separate from native Codex chat
archival, restoration and deletion, and from app-owned resource disposal.

## Capability decision

- Users need to put a PM task or its original Codex chat away, restore either,
  or review a precisely scoped removal while seeing each action's destination
  and consequences for spawned chats and working files.
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
  owner. Native connection events invalidate a changed destination without
  polling, project rescans or automatic cleanup. Native execution refreshes the
  selected PM association once before dispatch; the bridge owns the exact
  native request and its connection lifetime.
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
tasks, following the data owner's contract. Listing, review and execution are
asynchronous; subscription registration is synchronous:

| Method | Result and side effects |
| --- | --- |
| `listProjectTargets(projectId, {signal} = {})` | Reads the selected project, its complete active and archived task list, and the optional resource inventory concurrently. Returns `{project,tasks,resources,projectError,tasksError,resourcesError,resourcesAvailable,nativeDeleteAvailable}`. Partial data-list failure retains its readable `error.records` and the complete error. Starts no model or native process. |
| `review({action,targetId,projectId}, {signal} = {})` | Reads one exact task or resource, returning `{action,targetId,projectId,title,target,owner,available,effect,buttonLabel,retained,message,nativeUrl?,native?}`. It performs no mutation. Missing or moved targets are unavailable. Native review also reads the bridge's current observed connection synchronously. |
| `execute(review, {signal} = {})` | Reviews the target again, then invokes only the selected owner operation. PM/resource operations return `{status,action,targetId,projectId,message,result}` and propagate owner errors. Native result shapes and uncertainty are described below. An unavailable current review returns `{status:'unavailable',review,message}` without dispatch. |
| `subscribeNative(listener, {signal,emitCurrent:true})` | Passes the listener and options to `bridge.subscribe`; callbacks receive current connection state and registration returns unsubscribe. With no bridge subscription, returns a no-op unsubscribe. No alternate event bus or poller is created. |

An `execute` status is `completed` only after the owning operation explicitly
confirms the matching target's result. `unchanged` is an already absent PM row.
`unconfirmed` means the owner response did not establish completion and requires
current-state review before another attempt. Native `failed` means a native
error response was returned; partial changes may still have occurred.
`target-changed` means the saved destination or connection changed after review
and no native action was dispatched. No operation is retried automatically.
Complete owner results and errors remain available to the caller; ordinary UI
displays the separate user-facing message.

| Action | Owning operation and effect |
| --- | --- |
| `archive-task` | `pmData.archiveTask(id)` updates PM archive metadata. The task's status, identity, full content and related records remain available. |
| `restore-task` | `pmData.restoreTask(id)` clears PM archive metadata. |
| `remove-task-record` | `pmData.removeTaskRecord(id)` removes exactly that PM row. Sources, handoffs, model/face assets, native chats and working files remain with their owners. |
| `archive-native-task` | `bridge.archiveThread({threadId,identity,signal})` archives the original Codex chat and attempts its spawned descendants. The selected chat's acknowledgment does not establish every descendant's result. |
| `restore-native-task` | `bridge.restoreThread({threadId,identity,signal})` restores only the selected original Codex chat. Spawned descendants are not selected for restoration. |
| `delete-native-task` | `bridge.deleteThread({threadId,identity,signal})` requests permanent deletion of the original Codex chat and its spawned descendants. This is irreversible and does not require prior archival. Individual descendant results remain unconfirmed here. |
| `dispose-resource` | Calls only the explicit resource owner's `dispose(id,{signal})` for an app-owned resource whose current lifecycle is disposable with no current users. |

Native operations preserve the PM task record and its archive metadata, project
working files, selected sources and saved handoffs. PM archival, restoration
and removal never invoke native lifecycle operations. Native archive and delete
can stop work or close pending prompts on the selected connection before their
storage mutation completes; a later failure does not prove nothing changed.

## Native destination and result contract

Every native review includes this separate routing and consequence record:

```js
native: {
    threadId,
    origin: {provider, accountId, hostId},
    identity: {connectionId, originIdentity},
    connectedIdentity: {connectionId, originIdentity},
    descendants
}
```

`origin` is the task's saved association, or `null` when absent. `threadId` is
the associated Codex thread ID, or `null`. `connectedIdentity` is the currently
connected bridge identity, or `null` when unavailable. `identity` remains
`null` until the complete saved account and host match the connected Codex
identity and the selected bridge method is available. `descendants` is complete
action-specific consequence text. These fields are metadata; task content is
unchanged. `nativeUrl` uses the bridge's public thread-link method, or the saved
origin URL when that method is absent. A link requests navigation and never
claims the original chat was opened or foregrounded.

Native execution compares the fresh thread ID, provider/account/host and
connection identity against the reviewed destination. A changed destination
returns `{status:'target-changed',action,targetId,projectId,review,message}` with
an unavailable review and no native dispatch. An unavailable fresh review also
stops before dispatch. The bridge receives the selected thread and identity;
it owns transport and current connection handling.

A returned native acknowledgment produces
`{status,action,targetId,projectId,native,observedAt,result,message}`. Completion
requires the expected bridge status (`archived`, `restored` or `deleted`), the
exact selected thread ID and the matching reviewed connection identity.
`observedAt` is the bridge's actual observation time or `null`; no time is
invented. The full bridge result stays in `result`. Native unavailable results
return the same routing fields and complete result without an invented
observation time. A caught native error returns
`{status,action,targetId,projectId,native,error,message}`: `failed` when the
error has a native response, otherwise `unconfirmed`. Errors from the initial
target review can still reject before this native execution boundary.

Archive completion confirms the selected chat and only an attempt on spawned
descendants. Restore completion covers the selected chat alone. Delete
completion acknowledges the selected chat and its spawned-descendant operation,
while individual descendant outcomes remain unconfirmed. Native failure,
interruption or response loss can follow partial changes; the UI directs the
user to inspect the native state before another explicit action. This service
never records a native acknowledgment as a PM archive-state change or as a task
completion outcome.

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
The task action selector offers distinct PM actions and all three native
actions. A native review displays the full thread ID, saved provider/account/
host, connection identity at review and complete descendant consequences even
when the operation is unavailable. All native actions retain the original-chat
link when one exists. Missing identity fields are labeled unavailable.

The explicit selected-action button is the mutation trigger, following the
visible consequences. There is no additional confirmation modal. Opening,
refreshing, reviewing, selecting an action or switching views executes nothing.
Pending execution disables target and action changes; status updates before
the first asynchronous wait. Connection changes invalidate an unsubmitted
native review and display the new observed connection separately. A change
during review also requires explicit re-review. Pending execution and its
original reviewed destination remain intact while the owner settles.

Native results retain the original target, selected action, effect and reviewed
identity. The outcome panel displays the complete service message and actual
`observedAt` when returned. Completed, failed and uncertain results all disable
repeat execution until the user explicitly reviews the native action again or
selects another target/action. Inventory refresh preserves this result. Native
outcomes are transient view state, not durable chat history. Complete native
errors go to the developer console; raw protocol and exceptions are excluded
from the ordinary interface. A successful PM/resource operation refreshes its
inventory; an uncertain result requires a fresh review before another attempt.

The view links its own `AbortController` to the shell's page signal. Disposal
removes its DOM, connection subscription and rendered-control listeners, and
aborts queued reads and cancellable owner work. Data writes already accepted by
the data owner complete there. Native cancellation does not establish reversal
of an invoked operation. Late reads and disposed views do not alter the mounted
UI. Each rerender removes its prior controls' listeners. There are no timers or
polling. Exact diagnostics go to the developer console, outside saved chat.

The component loads only its own `cleanup.css`, relies on the foundation's
Arcane theme and primitives, and introduces no document scrollbar or fixed
shell changes. Native labels and buttons preserve keyboard operation; complete
record text wraps and remains readable as content grows.

## Source review boundary

Current source was inspected against the PM data and bridge contracts and the
cleanup service's native destination/result mapping. No local test, check,
linter, build or real native archive, restore, delete or other chat/file
operation was run by this owner. Static source review does not establish native
execution or descendant outcomes. Non-mutating browser review, when selected,
remains coordinated with the composing workflow and foundation owners.
