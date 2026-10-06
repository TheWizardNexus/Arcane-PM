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
Record lists select the terminal `.json` filenames before decoding IDs or
reading values. Other files in those tables remain untouched and are outside
the PM record query. Unreadable `.json` records still report their full errors.

## Callable API

All record methods return promises. Create/update/archive/restore return the
saved record. `getProject(id)` and `getTask(id)` return a record or `null`.
Records returned to callers are independent copies of SDK cached records.

| Operation | Signature |
| --- | --- |
| Create project | `createProject({name, description?, workFolder?, origin?, faceRef?})` |
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
| Deliberately select a project / task face | `setProjectFace(id, faceRef)` / `setTaskFace(id, faceRef)` |
| Attach an automatic first project face conditionally | `setProjectFaceIfEmpty(id, faceRef, {isCurrent?, signal?} = {})` |
| Attach an automatic first task face conditionally | `setTaskFaceIfEmpty(id, faceRef, {isCurrent?, signal?} = {})` |
| Find explicit native task associations | `listNativeTaskAssociations({accountId?, hostId?, signal?} = {})` |
| Apply one actual native observation | `applyNativeTaskObservation(id, bridgeThreadObservation, {isCurrent, signal?})` |
| Map a deliberate native discovery into PM records | `syncNativeDiscovery(discovery, {isCurrent, signal?, onProgress?, projectId?})` |
| Observe committed changes | `subscribe(handler, {signal?} = {})` returning unsubscribe |

Lists include archived records by default, preserve complete records, and sort
by creation time and PM ID. `{archived:false}` selects the active view;
`{archived:true}` selects the archive. Search is case-insensitive substring
matching over complete string values, including original line breaks; it does
not rewrite stored content.
Task `projectId:null` explicitly selects unassociated tasks. Omitted filters
select all values. No account filter is implicitly applied.

Ordinary lists use the SDK's current value cache. Overlapping lists share only
an in-flight read of the same table and filename; each caller keeps its own
enumeration, complete record copies, filters, sorting and cancellation. A
cancelled caller does not cancel another caller's shared file read. Settled
values remain owned solely by DBOPFS; Data retains no completed-list snapshot.
Local and remote committed changes retire the affected pending read, table
deletion retires that table's pending reads, and `pagehide` clears both sets.
Later readers therefore use the SDK's updated or invalidated value. Explicit
single-record reads, mutation reads and changed-record refreshes remain forced.
A cold list still reads every record before filtering; this sharing removes
duplicate file I/O without imposing a record cap or reducing query coverage.

## Record shapes

Every record has a generated stable UUID `id`, `createdAt` and `updatedAt` ISO
timestamps, and `archivedAt` (`null` when active). These lifecycle fields are
owned by this module. Create and update preserve supplied strings exactly.
Updates change only named supplied fields. Explicit `null` clears a nullable
association. Arrays replace only their named field; omitted arrays stay intact.

`authoredFieldRevisions`, when present, is Data-owned metadata for authored
scalar changes: project `name` and `description`, and task `title`, `assignment`
and `projectId`. Each property's absent revision means `0`; creation establishes
that baseline without adding revision fields. An accepted update advances only
the revisions whose scalar values actually differ from the latest saved record,
inside the same record edit boundary. The first real change advances its field
to `1`. An unchanged save, observation, face selection or lifecycle update leaves
these revisions unchanged. Existing rows are never swept or initialized on read.
Revision metadata and the changed values commit together, and full record reads
and notifications carry both. This metadata is not accepted as caller input.

Consumers retain only the revision values relevant to their own dependencies
when they need to detect subsequent authored changes after releasing transient
source text. They still read the complete current record for the operation.
These counters do not describe native conversation or source-document changes,
record identity, content fingerprints, event history, or delivery acceptance.
No prompt, previous field value or model response is retained by this metadata.
Only mutations through this revision-aware Data implementation advance these
counters; older already-open application code and direct storage writes do not.

Project fields:

- `name`: required nonblank string.
- `description`: string, default `''`.
- `workFolder`: selected system folder path string or `null`, default `null`.
- `origin`: optional connection reference or `null`.
- `faceRef`: stable face ID string or `null`, default `null` for new records.
  Existing projects may omit it; no migration is performed.
- `nativeProject`: discovery-owned saved-project snapshot, when discovered from
  a saved native project. It contains `{provider:'codex', hostId, kind,
  projectId, name, rootPaths, source, createdAt, updatedAt, nativeId,
  desktopProjects}`. `kind` distinguishes
  `native` IDs from `desktop-local` IDs; `source` identifies `codex-app-server`
  or `codex-desktop-state`. Native timestamps retain their original values and
  units, separately from PM lifecycle timestamps. All roots and the saved name
  remain separate from editable PM `name` and `workFolder`.
  `nativeId` retains an explicitly mapped public ID or null;
  `desktopProjects` retains each explicitly joined desktop project's exact
  `{id, name, rootPaths, createdAt, updatedAt}` snapshot.
- `nativeFolder`: discovery-owned `{provider:'codex', hostId, cwd}` only for a
  project created from a genuinely unassigned thread's complete working path.
  Neither discovery identity field is accepted by ordinary project updates.

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
- `nativeActivity`: latest narrow native observation or `null` for a newly
  created task. Existing records can omit it. Only the native observation
  operation writes this member; ordinary task updates preserve it.
- `nativeArchiveObservation`: optional discovery-owned archive evidence,
  separate from PM `archivedAt` and manual `status`. Ordinary task updates
  preserve it. Its shape and observation limits are described below.

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

### Automatic first-face association

`setProjectFaceIfEmpty` and `setTaskFaceIfEmpty` accept a nonblank existing face
reference and return `{applied, reason, project}` or `{applied, reason, task}`
respectively. Each uses the same record edit boundary as its manual
`setProjectFace` or `setTaskFace` counterpart. A missing subject returns
`project-missing` with `project:null` or `task-missing` with `task:null`; an
existing face returns `face-present`. These paths perform no write or event and
never recreate a removed subject. A successful association returns
`applied:true`, `reason:'assigned'` and the saved record. Returned records are
independent copies. Manual selection accepts `null` to clear the association.

The face owner may supply `isCurrent(currentRecord)`, a synchronous boolean
predicate evaluated against the latest detached project or task inside its edit
boundary. Use it to match the still-active generation request and exact content.
`false` returns `request-stale` without writing; a promise or nonboolean is an
input error. This avoids using `updatedAt` as a generation identity, since
unrelated observations can legitimately update a task. Project predicates can
match the request's project name and description without treating unrelated
lifecycle changes as new content. The face owner retains
generation, candidate assets and request cancellation; data owns only the
conditional association. No account connection is inferred or changed.

Cancellation is checked after the current record is read and immediately before
the write. An OPFS write already accepted completes. A manual choice already
saved prevents automatic assignment; a manual choice queued afterward replaces
the automatic face through the same edit boundary. Other record fields, including
archive state, remain unchanged.

### Native activity on explicitly associated tasks

`listNativeTaskAssociations` returns `{taskId, origin}` records with
`provider:'codex'` and complete host/thread identities, including archived tasks.
Optional `accountId` and `hostId` filters match the saved fields exactly; the
account filter describes the historical observing account. Omitted filters
return all complete explicit associations in one scan, allowing the composing
owner to change its connection selection without another scan.
Each origin contains only `provider`, `accountId`, `hostId` and `threadId`.
The saved account remains unchanged and may be null. The bridge supplies new
observations' actual account from native workspace routing and their reported
native hostname.
A hostname is an observed host reference, not a claim of global uniqueness.
Missing identities are not guessed from a selected account, email, process ID,
working folder or thread ID alone. Existing records require deliberate
association through the bridge owner when their host or thread identity is missing.

Subscribe to committed data changes before this one association scan, then keep
the caller's association index current from those changes. Each observation
applies only to an existing selected PM ID; there is no automatic import,
creation, re-association, account migration, or per-event table scan. Removing a
PM task cannot cause the next native event to recreate it. Multiple deliberately
associated PM records remain separate records.

`applyNativeTaskObservation` accepts the bridge's complete per-thread observation
without rewriting it. The bridge contract supplies `threadId`, exact `origin`,
`availability`, native `status`, transient `turn` and `pendingRequests`, complete
application-owned `message`, actual `observedAt`, and `coverage`. Data projects
only these narrow application-owned fields into `task.nativeActivity`:

```js
{
    origin: {provider: 'codex', accountId, hostId, threadId},
    availability: 'observed', // observed | unobserved | disconnected
    state: 'working', // working | needs-input | needs-approval | idle | error | unknown
    message,
    observedAt,
    coverage: {scope: 'connected-server', live: true, reason: null},
    lastObserved: {state: 'working', message, observedAt}
}
```

An actual pending input request or `waitingOnUserInput` flag maps to
`needs-input`. Otherwise an actual pending approval or `waitingOnApproval` flag
maps to `needs-approval`. These request observations can exist before a native
status is available. Without a pending request, native `active` maps to
`working`. Native `idle`
remains `idle`, and `systemError` maps to `error`. Unrecognized states remain
`unknown`. Unobserved or disconnected availability always yields current state
`unknown` and non-live coverage. Native `notLoaded` is unobserved at the bridge
boundary, since another desktop-owned server may still be running that task.
Idle is never inferred to mean the PM task is completed. Imported conversation
turn status does not establish current activity and is not used here.

The last actual known observation is retained in `lastObserved` when current
coverage is lost. The current message and timestamp describe that loss; the
separate historical timestamp continues to describe the last known activity.
No timer invents a stalled state. Saved coverage describes the observation at
its timestamp: a reload must label saved activity historical until the current
bridge observer supplies its authoritative state. It is not proof that the
connection is still live. Manual `status`, `attention`, observations, content,
faces, source/result references and archive state remain unchanged.

An observation matches its selected PM task by provider, exact host and native
thread, independently of the account that first observed the task. It preserves
the original task origin and retains the actual observing account in
`nativeActivity.origin`. Historical `lastObserved` remains attached to that
same native task across observing-account changes.

The required synchronous boolean `isCurrent()` predicate belongs to the
composing owner. It checks the current bridge observer/revision and connection
lifetime, including the actual current account, inside the existing same-record
edit boundary after reading the latest
task. The bridge suppresses stale seed results and retires old connections;
the caller invalidates its queued work when either changes. `signal` cancels
pending work and is checked immediately before a durable write. An OPFS write
already accepted completes. No observer, revision, connection, request or turn
protocol identifier is persisted by this operation.

Results are `{applied, reason, task}` with `task:null` only for `task-missing`.
Other no-write reasons are `origin-mismatch`, `observation-stale`,
`older-observation` and `unchanged`. Older actual timestamps cannot replace a
newer saved observation for the same provider/host/thread. An identical replay
also compares the actual observing account and does not
write or emit. Successful writes return `applied:true`, `reason:'observed'` and
the saved task after publishing the ordinary committed data event. A malformed
observation or asynchronous/nonboolean predicate is `PM_DATA_INPUT`; storage
failures propagate. The operation appends no raw event log or growing history.

This is the PM domain mapping boundary. Native reads, subscription coverage,
account lifecycle and original protocol remain with the bridge; subscription
composition and card presentation remain with the foundation owner. One initial
association scan reads each task once. Each changed observation reads and writes
only its selected PM record; replay and stale outcomes perform no write. Work
for separate tasks can proceed independently, while only same-record writes
serialize. No model request, native mutation, polling, dependency change,
local test or build is selected by these APIs.

### Deliberate native discovery

`syncNativeDiscovery` accepts the bridge's unchanged `discoverWorkspace` result:
`{threads, projectCatalog}`. `threads` is its full `listThreads` or selected
`readThread` result, including actual connection identity. The catalog keeps
the complete native project records/pages and narrowly selected desktop
metadata in their original separate containers. Data reads public project
IDs, names and root paths; the desktop `nativeProjectIdsByLegacyId` map joins
legacy saved assignments only through an explicitly recorded ID mapping.
It never copies the catalog, thread response, protocol or conversation body
into a PM record. The older standalone list/read result is also accepted when
no project catalog is supplied.

Saved project identity is provider, actual host and saved project ID, independent
of account selection. Native and desktop-only IDs remain distinct until the
explicit map joins them. Roots are never used to merge saved projects. New
project names use the complete observed saved name; a blank name uses its ID.
A single root supplies the initial `workFolder`; multiple roots leave that
single selection null while retaining every root in `nativeProject.rootPaths`.
An existing PM project keeps its ID, manual name, folder, face and lifecycle.
The catalog snapshot is retained at creation. Discovery may attach the narrow
`nativeProject` identity to an existing exact ordinary origin match, or retain
an additional explicitly mapped native/desktop ID under that project's record
lock. This updates only `nativeProject` and `updatedAt`, emitting
`changedFields:['nativeProject']`. Ambiguous identity matches are reported;
editable fields and existing histories remain intact. Retaining both source
identities prevents a later incomplete migration map from duplicating a project.
A later map that contradicts a retained native identity is reported as
`conflicting-project-mapping`; it does not merge two saved native projects.

For each new thread, its actual native `projectId` takes precedence, followed
by its explicit saved desktop assignment and exact legacy-to-native ID map.
An explicit assignment whose project is unavailable is reported unresolved;
that task is deferred for a later discovery. An incomplete assignment catalog
cannot establish that an absent assignment is genuinely unassigned. Once
unassigned status is established, the actual host and complete `cwd` select a
folder project, whose initial label is its final path component. Paths remain
unchanged; matching basenames, case folding, separators or overlapping roots
never merge projects. A genuinely unassigned thread without a working folder
becomes a task with `projectId:null`.

Task identity is exact provider, host and native thread ID, independent of the
observing account. Repeating a discovery reuses every matching PM record and
returns each existing association with `created:false`; it creates no new row
when any match exists. Apart from the separately observed native archive
metadata and its `updatedAt`, discovery preserves every existing field,
including a manually cleared project association, assignment, labels, status,
observations, face, archive state and original observing account. Multiple
associated PM tasks remain separate, with no selected winner or historical
merge. A saved thread whose host is missing is reported as `association-required`;
the bridge's deliberate association action supplies missing identity. Discovery does not guess it or
create a duplicate around it. A saved-project discovery does not merge an
older folder project or move its existing tasks.

New tasks use the complete native name (or native ID if unnamed), exact cwd,
origin and original conversation link. Assignment is empty, status is
`unknown`, and observed activity is unset. Conversation content is imported
through the sources owner. New imported tasks remain PM-active; a native
archive listing does not set PM `archivedAt` or planning `status`. Existing
PM archive choices stay unchanged, including records imported by earlier code.
A project never derives archive state from a thread.
`projectId` overrides grouping only for a new, explicitly selected single
thread read, including explicit null; it never moves an existing PM task.

The listing's separate `archiveObservations` supplies actual
`{threadId, archived, observedAt}` evidence. Bridge records each source page's
receipt time and its archive filter without altering native thread records.
Data indexes these observations once per discovery and stores this narrow
latest-discovery snapshot on each exactly matched PM task:

```js
nativeArchiveObservation: {
    origin: {provider: 'codex', accountId, hostId, threadId},
    archived: true, // false for active; null when both partitions returned the ID
    observedAt,
    observations: [{archived: true, observedAt, accountId}]
}
```

`observedAt` is the latest page receipt in this snapshot, never the time a
native task was archived or restored. The lists are not an atomic snapshot.
An ID returned by both partitions retains every supplied observation and has
`archived:null`; completion order does not select a winner. An absent field
means no native archive evidence has been saved. A selected or assignment-recovery
read has no archive evidence and leaves existing metadata unchanged. Missing
threads, partial lists and failed partitions never infer an archive, restore,
deletion or reassociation.

Existing associations receive archive metadata inside their existing record
edit boundary, after rereading and matching provider, exact host and thread.
Their historical account association stays unchanged. The outer origin records
the incoming discovery's observing account; each observation retains its own
actual account, including equal-time evidence retained across account changes.
An older observation snapshot cannot replace a
newer saved one. An identical replay makes no write; a later observation of the
same archive state updates its actual observation time. Contradictory saved and
incoming snapshots at the same timestamp retain their combined evidence as
uncertain; a same-time single-partition replay cannot erase a saved conflict.
Accepted updates change only `nativeArchiveObservation` and `updatedAt`, and emit
`changedFields:['nativeArchiveObservation']`; authored revisions stay unchanged.
A failed write reports its PM ID and retains the readable prior record while
other associations continue. New tasks save metadata in their one creation
write. This adds no raw native payload, growing event history, polling, native
mutation or existing-record migration.

The result contains `{status, reason?, projects, tasks, associations,
createdProjectIds, createdTaskIds, unassociated, failures, archiveConflicts, coverage}`.
Associations contain `{threadId, taskId, projectId, created}`. `coverage`
separately retains thread, public-project and desktop-assignment coverage.
`complete` requires current identity, complete supplied coverage and no
unresolved associations, failures or archive conflicts. `archiveConflicts`
contains each affected native thread ID and its complete observation list.
Conflicts with saved equal-time evidence also identify the affected PM task ID.
`partial` retains all accepted records and actual failures. `unavailable`
retains the bridge's reason; top-level
`unassociated` identifies missing native identity or a catalog host mismatch
and performs no writes. Unresolved rows identify their native thread/project
and, when relevant, candidate PM IDs. An unreadable PM inventory rejects before
creation because existing identity coverage is unknown.

The required synchronous boolean `isCurrent()` checks the composing owner's
exact connection/account lifetime before work and each durable write. A retired
lifetime stops further creation with `reason:'discovery-stale'`. Cancellation
uses `AbortError`; worker cancellation exposes accepted results on
`error.discoveryResult`. An already accepted SDK write completes and publishes
the ordinary created event. A successful project write remains if its task
write fails, so the next deliberate discovery reuses that project. Missing
native rows never delete or archive local records.

Discovery enumerates each PM table once and indexes identities for the batch.
One host-scoped Web Lock serializes its membership lookup/create sequence across
account selections and tabs; native enumeration occurs before this boundary.
Independent record edits and discoveries on other hosts remain concurrent.
Without Web Locks, the pending-operation map coordinates only this page.
Discovery does not impose uniqueness on separate deliberate manual creates or
re-associations. Project requests within a discovery share the same in-flight
creation. Four project and four task workers run concurrently, with each task
awaiting only its selected project. Existing candidates are read again under
their record locks; deletion or reassociation observed then is reported for
this invocation without recreation. `onProgress` observes completed item and
created record counts without changing stored content or delaying workers.
The composing owner acknowledges immediately and owns trigger/cancellation;
this module adds no polling, automatic reload import or deletion subscription.

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
A later deliberate Connect, Find or refresh can recreate an absent local row
from still-existing native metadata, with a new PM ID. Removal itself never
starts discovery and retains no suppression or tombstone record.

## Errors and events

`PM_DATA_INPUT` identifies malformed/unsupported public input,
`PM_DATA_NOT_FOUND` identifies an absent record required by an update,
`PM_DATA_RECORD_UNREADABLE` identifies a saved row that cannot be read as the
expected PM record, and `PM_DATA_STORAGE_UNAVAILABLE` identifies unavailable
browser storage. Original SDK/platform storage failures propagate intact.
List failure exposes `recordType`, complete readable `records`, and per-record
`failures` containing the exact filename and original error on the thrown
aggregate, so incomplete coverage is never reported as a complete list. Callers
can display these readable records with an incomplete-coverage state while
retaining previously displayed unread rows. A failed read is not a removal.
When initial saved inventory prevents discovery, its error retains those same
records and failures; `discoveryResult.reason` is `saved-inventory-unreadable`
and its failures identify the `saved-inventory` stage and record type. Discovery
does not infer missing identities or create replacements from unreadable rows.
Cancellation uses `AbortError`; a write already accepted by OPFS completes.

Committed changes publish canonical SDK event `arcane-pm.data.changed` from
source `arcane-pm.data`, with `{recordType, action, id, record, changedFields}`. `record` is
`null` after removal. Local actions are `created`, `updated`, `archived`,
`restored`, and `removed`. `subscribe` forwards that detail to its handler; subscriber
failures follow the SDK's observational error behavior. There is no second bus,
polling loop or durable event/protocol log.
Subscriptions have no replay: subscribe before loading initial records and
refresh on subsequent change notifications. Mutations resolve only after the
SDK write/delete succeeds and its committed change has been published.

Opening storage subscribes to the published SDK's `DBOPFS.subscribeChanges`
before the first PM read. Same-origin, same-storage-partition documents using
the same application scope receive committed changes through the SDK. Data
selects only its two tables and terminal `.json` record filenames. It reads the
affected complete record and publishes `refreshed`, or `removed` when the current
record is absent. A remote write cannot establish which PM fields changed, or
whether it created, archived or restored a record; `changedFields` is therefore
`null`. Consumers reconcile the returned record, including its archive state,
face and associations, without treating `refreshed` as an authored content edit.
Local PM writes retain their existing precise events and emit no storage echo.

At most four affected-record reads run concurrently. A newer notification for
the same record supersedes an in-flight refresh, and a local committed change
prevents an older refresh from replacing its event. A table deletion refreshes
the IDs already encountered by this document's reads and writes; it does not
enumerate the catalog. No record-body shadow cache or durable notification log
is retained. Refresh read failures include the record type, ID and original
error in developer diagnostics and preserve the
caller's existing displayed record rather than presenting a failed read as a
removal. Explicit list/read operations retain their ordinary failure contract.

The SDK notifications are live only. They do not replay changes missed while a
document is suspended or closed. On a persisted `pageshow`, Data enumerates each
PM table once and refreshes the union of its current record IDs and previously
known IDs through the same bounded queue. Existing subscribers therefore receive
current rows, additions and removals without remounting views or discarding
unsaved form input. Ordinary live notifications still read only affected rows.
Every `pagehide` invalidates pending reads; a newer hide or resume also retires
an unfinished resume inventory. Non-persisted `pagehide` releases Data's storage
subscription. Separate WebView storage
partitions and direct OPFS writes outside DBOPFS are outside this transport.
Without `BroadcastChannel`, SDK local storage and local notifications remain
available, while cross-document notifications are unavailable.

`changedFields` names the explicitly authored fields in an accepted update,
including those returned by a synchronous task updater. Project `name` and
`description`, and task `title`, `assignment` and `projectId`, are included only
when their accepted scalar value differs from the latest stored value. This
lets automatic preparation retain a settled result through an unchanged content
save without retaining old content itself. Other explicitly supplied fields are
included even when their value matches the previous value. The implicit
`updatedAt` timestamp is excluded. Face association emits `['faceRef']`, native
observation emits `['nativeActivity']`, and archive/restore emits `['archivedAt']`.
Creation and removal use `null`; their action already describes the lifecycle.
No-write conditional outcomes emit no event. This transient metadata lets
consumers distinguish content edits from activity, face and lifecycle updates
without retaining old input or model responses. It adds no stored field or
record migration.

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
record. Each list enumerates its selected table once. Overlapping lists share
pending file reads and later lists reuse valid SDK values; cold lists still
read the full inventory with four readers per caller. Only overlapping edits
to the same record serialize; independent records remain concurrent. The caller
renders and acknowledges before awaiting storage. All reads/writes use
asynchronous SDK I/O. No local tests, checks, or builds are selected.
