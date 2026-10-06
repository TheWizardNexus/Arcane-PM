# Arcane PM records

Import named functions or the `pmData` object from `./modules/data/index.js`.
This module owns PM project/task records and one shared SDK DBOPFS connection.
It does not own Codex conversations, source documents, handoffs, model assets,
face images, or working-folder files.

## Storage and ownership

`await getStorage()` returns the ready SDK DBOPFS instance. The document declares
`<meta name="arcane-app-id" content="arcane-pm">` before SDK storage loads.
The first call imports `arcane-os/modules/DBOPFS.js`; that published module owns
the singleton and its readiness. Importing PM records alone does not open storage.
OPFS availability and write failures reject honestly. There is no in-memory
success substitute and no startup migration or rewrite of existing records.
If the SDK's initial connection fails, its singleton retains that failure;
after correcting browser storage availability, reload the page to reopen it.
PM does not replace or dispose another owner's SDK singleton.

Other domain owners reuse this exact connection with their SDK libraries and
own table names: sources, handoffs/workflows, local preparation, faces and model
assets remain with those owners. Use the SDK's `get`, `set`, `getAllKeys`,
`writeFile`, `readFile`, and `delete` APIs as appropriate to the owned content.
`set` uses JSON for records; image/model owners use the SDK's complete asset
contracts. Content stays separate from metadata. PM tables are `pm_projects`
and `pm_tasks`, with one `<PM id>.json` file per record.

## Callable API

All record methods return promises. Create/update/archive/restore return the
saved record. `getProject(id)` and `getTask(id)` return a record or `null`.
Records returned to callers are independent copies of SDK cached records.

| Operation | Signature |
| --- | --- |
| Create project | `createProject({name, description?, workFolder?, origin?})` |
| Read project | `getProject(id)` |
| Update project | `updateProject(id, changes)` |
| List projects | `listProjects({archived?, query?, signal?} = {})` |
| Archive / restore project | `archiveProject(id)` / `restoreProject(id)` |
| Remove only selected project record | `removeProjectRecord(id)` |
| Create task | `createTask({title, projectId?, assignment?, workFolder?, origin?, assignee?, status?, observedEvidence?, sourceRefs?, resultRefs?, faceRef?, decisions?, openQuestions?, attention?, nextAction?})` |
| Read task | `getTask(id)` |
| Update task | `updateTask(id, changes)` or `updateTask(id, current => changes)` |
| List tasks | `listTasks({projectId?, archived?, status?, query?, signal?} = {})` |
| Archive / restore task | `archiveTask(id)` / `restoreTask(id)` |
| Remove only selected task record | `removeTaskRecord(id)` |
| Deliberately select a face | `setTaskFace(id, faceRef)` |
| Observe committed changes | `subscribe(handler, {signal?} = {})` returning unsubscribe |

Lists include archived records by default, preserve complete records, and sort
by creation time and PM ID. `{archived:false}` selects the active view;
`{archived:true}` selects the archive. Search is case-insensitive substring
matching over complete string values, including original line breaks; it does
not rewrite stored content.
Task `projectId:null` explicitly selects unassociated tasks. Omitted filters
select all values. No account filter is implicitly applied.

## Record shapes

Every record has a generated stable UUID `id`, `createdAt` and `updatedAt` ISO
timestamps, and `archivedAt` (`null` when active). These lifecycle fields are
owned by this module. Create and update preserve supplied strings exactly.
Updates change only named supplied fields. Explicit `null` clears a nullable
association. Arrays replace only their named field; omitted arrays stay intact.

Project fields:

- `name`: required nonblank string.
- `description`: string, default `''`.
- `workFolder`: selected system folder path string or `null`, default `null`.
- `origin`: optional connection reference or `null`.

Task fields:

- `title`: required nonblank string.
- `projectId`: PM project UUID or `null`, default `null`.
- `assignment`, `nextAction`: complete strings, default `''`.
- `workFolder`: selected system folder path string or `null`. `null` means use
  the associated project's current folder when available.
- `origin`: originating connection reference or `null`.
- `assignee`: `{kind, id, name}` or `null`; all three values are strings.
- `status`: nonblank string, default `'idle'`. Workflow owners supply actual
  observed states. This layer does not infer completion or remote acceptance.
- `observedEvidence`: array of `{message, observedAt, sourceRef?}`. `message`
  and the actual `observedAt` timestamp are strings; `sourceRef` is an optional
  string or `null`. The author supplies observation time; storage does not
  invent an observation.
- `sourceRefs`, `resultRefs`: arrays of domain-owned reference ID strings.
- `faceRef`: stable face ID string or `null`; only an explicit change replaces it.
- `decisions`, `openQuestions`: arrays of complete strings.
- `attention`: `{message, requestedAt, sourceRef?}` or `null`.

`origin` carries only `{provider, accountId?, projectId?, threadId?, hostId?, url?}`.
`provider` is a string; omitted reference members default to `null`. Account
references identify native access separately from PM identity and orchestration.
Changing an account connection performs no native-chat migration.

Source/result contents, preparation and handoff delivery records live with their
owning services. This narrow DAO accepts the documented fields and reports
unsupported or malformed fields rather than silently discarding them. It never
accepts raw provider/tool envelopes, system/bootstrap prompts, transient
`Thinking`, or nonpersistent operation content as a generic record payload.
No content migration is performed on old data.

## Archive and removal

Archive updates `archivedAt` only (plus `updatedAt`). It preserves status,
identity, face, assignments, sources, results and relationships. Restore clears
`archivedAt`. Project archival does not change child task records.

Removal takes exactly one selected PM ID and returns
`{removed, recordType, id}`. Repeating an already-absent removal returns
`removed:false`. It deletes only the selected PM row. Related tasks, source
copies, handoffs, face/model assets, native conversations and working files
remain with their owners. A task may retain the ID of a removed project; a
caller displays its missing association and may explicitly reassign it.

## Errors and events

`PM_DATA_INPUT` identifies malformed/unsupported public input,
`PM_DATA_NOT_FOUND` identifies an absent record required by an update,
`PM_DATA_RECORD_UNREADABLE` identifies a saved row that cannot be read as the
expected PM record, and `PM_DATA_STORAGE_UNAVAILABLE` identifies unavailable
browser storage. Original SDK/platform storage failures propagate intact.
List failure exposes readable records and per-record failures on the thrown
aggregate error so incomplete coverage is never reported as a complete list.
Cancellation uses `AbortError`; a write already accepted by OPFS completes.

Committed changes publish canonical SDK event `arcane-pm.data.changed` from
source `arcane-pm.data`, with `{recordType, action, id, record}`. `record` is
`null` after removal. Actions are `created`, `updated`, `archived`, `restored`,
and `removed`. `subscribe` forwards that detail to its handler; subscriber
failures follow the SDK's observational error behavior. There is no second bus,
polling loop or durable event/protocol log. Notifications are within the current
realm; explicit list/read calls refresh saved state across page reloads.
Subscriptions have no replay: subscribe before loading initial records and
refresh on subsequent change notifications. Mutations resolve only after the
SDK write/delete succeeds and its committed change has been published.

Same-record read/modify/write operations use browser Web Locks where available,
including across tabs. When Web Locks is unavailable, same-page edits serialize
through the record owner's pending-operation map; cross-tab concurrent editing
is not coordinated in that environment. Independent records remain concurrent.
Callers replace a supplied array as a whole. When a change depends on the latest
task, pass a synchronous updater to `updateTask`. It receives an independent
copy of the record inside the same-record edit boundary and returns ordinary
supported changes. Returning a promise is an input error. Keep I/O and unrelated
work outside this callback. This supports app-owned evidence appends and
conditional attention updates without saving from a stale caller snapshot:

```js
await pmData.updateTask(taskId, function appendObservedState(current) {
    return {
        status: observation.status,
        observedEvidence: [...current.observedEvidence, {
            message: observation.message,
            observedAt: observation.observedAt,
            sourceRef: observation.sourceRef
        }]
    };
});
```

The caller supplies actual observation values. Domain histories and full source
content stay with their owners; this callback performs no implicit observation,
content transformation or history migration.

## Capability decision

PM needs durable project/task associations that preserve source ownership,
recognizable faces and the distinction between local preparation and accepted
remote delivery. These schemas and lifecycle rules belong in PM. The SDK owns
DBOPFS, application scope and canonical events. Native filesystem and Codex
operations stay with the bridge. No SDK or OS source is changed.

Connection initialization is invariant once per page; a mutation touches one PM
record. Lists enumerate the selected table once and read each selected record
once. Only overlapping edits to the same record serialize; independent records
remain concurrent. The caller renders and acknowledges before awaiting storage.
All reads/writes use asynchronous SDK I/O. Runtime timing is unmeasured until
authorized browser verification. No local tests, checks, or builds are selected.
