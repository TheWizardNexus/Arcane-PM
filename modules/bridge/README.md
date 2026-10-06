# Codex project bridge

Arcane PM's bridge connects PM project/task workflows to the supported Codex
app-server interface. The browser calls a PM host service through the published
Arcane SDK Core client. A plain browser has no native Codex host; local PM data,
search and preparation remain available independently.

## Browser contract

`modules/bridge/index.js` exports `createCodexBridge` and
`mountConnectionsView`. Create one bridge for the application's lifetime:

```js
const bridge = createCodexBridge({coreClient});
const view = mountConnectionsView(container, {
    bridge, pmData, projectId, discoverTasks, onNavigate, onStatus, signal
});
```

`coreClient` is optional. When omitted, the bridge observes the SDK's
`subscribeCoreClient()` installation lifecycle, including current replay,
retirement and terminal failure. It consumes the exact callback client and
releases old subscriptions before attaching a replacement. It does not install
a transport or probe a local port. Native composition supplies
`bridge/codex-service.mjs` to the SDK Core runtime. The default export is the
synchronous `createCodexService(options)`
factory. Its `command`, `args` and `cwd` options select the owned Codex process;
defaults are `codex app-server --listen stdio://`. The service's start hook
registers event ownership without launching Codex. Only explicit connection
starts that process; disconnect closes its standard input and observes exit.

The SDK's independent `/arcane-core.js` bootstrap can load before or after the
bridge without delaying page rendering. After attaching PM event listeners,
the bridge observes the client's replayable `core.ready` event and reads
`pm.codex.status`; Core waits only for that service's startup. Installation,
dispatcher readiness, service readiness and a native Codex connection remain
distinct. Late status/connect/disconnect results from a retired client cannot
replace current connection presentation. Retirement cancels only the bridge's
initial status read and subscriptions; disposal does not close the shared client.

| Method | Contract |
| --- | --- |
| `status()` | Synchronous last observed connection state; starts no process. |
| `refreshStatus({signal})` | Reads `pm.codex.status` and replays actual pending requests with their matching file-change events. |
| `connect({signal})` | Explicitly starts the owned connection and returns its current state. Completion/error arrives through `subscribe`; rendering remains independent. |
| `disconnect({signal})` | Ends that bridge connection; never stops a separately owned Codex app or daemon. |
| `subscribe(listener, {signal, emitCurrent:true})` | Observes connection state through the shared SDK event owner, with current state replay. Returns unsubscribe. |
| `observeNotifications(listener, {signal})` | Complete native notifications, transient and outside durable chat history. |
| `observeRequests(listener, {signal})` | Actual pending native approval/input requests; never automatically approved. |
| `observeTaskActivity(listener, {threadIds:[], signal, emitCurrent:true})` | Connection-scoped activity snapshots for selected thread IDs. Returns `{setThreadIds,dispose}`; unchanged selections do not repeat reads. |
| `listThreads({cwd, archived, signal})` | All pages for the selected archive state and directory filter. Original thread records remain unchanged. |
| `listProjects({archived, signal})` | Observed working-folder associations from threads, with native project IDs when present. This is not a saved-project registry. |
| `discoverWorkspace({threadId?, archived?, cwd?, signal})` | Unchanged selected `readThread` or `listThreads` result in `threads`, alongside the complete saved `projectCatalog`. Data owns mapping. |
| `readThread({threadId, signal})` | Current native thread metadata, including actual observed state. Does not resume a thread. |
| `readConversation({threadId, signal})` | Complete accessible turns and original page responses, plus separate coverage. Unavailable/partial history is explicit. |
| `readDirectory({path, signal})` | Native direct-child listing in `original.entries`, with separate `children:[{fileName,path}]` routing metadata joined by the local native host. No recursive traversal. |
| `readFile({path, signal})` | Complete original content in native `original.dataBase64`; Sources owns transport decoding to a retained File. |
| `getFileMetadata({path, signal})` | Native file/directory/link flags and real timestamps in `original`. A zero timestamp means unavailable. |
| `hookStatus({signal})` | Passive receiver state, all retained receipt metadata and complete catalog diagnostics. Does not activate hooks or connect Codex. |
| `readHook({eventId, signal})` | Explicit inspection of a retained complete hook original with its separate receipt/source metadata. |
| `observeHooks(listener, {signal})` | Newly stored hook receipt metadata; subscribe before reading `hookStatus` and deduplicate by receipt event ID. |
| `observeHookState(listener, {signal})` | Receiver startup/drain state events; no source activity or native connection claim. |
| `resumeThread({threadId, signal})` | Native resume; required before continuing a thread that is not loaded by this connection. It is separate from a read. |
| `createTask({cwd, content, signal})` | Native thread creation and initial turn; new PM-created tasks select `gpt-6-astra` / `ultra`. |
| `continueTask({threadId, content, signal})` | Resume and submit the complete supplied content to that thread. |
| `sendHandoff({threadId, content, signal})` | Same destination operation with exact prepared text. An explicit typed `input` array may be supplied instead of `content`. |
| `archiveThread({threadId, identity, signal})` | Native archive, including Codex's documented attempt to archive descendants. It does not remove PM records or working files. |
| `restoreThread({threadId, identity, signal})` | Native unarchive of the selected thread; does not resume it or restore descendants. |
| `deleteThread({threadId, identity, signal})` | Permanent native deletion of the selected stored thread and its known spawned subtree. PM records remain independent. |
| `cancelTurn({threadId, turnId, signal})` | Requests interruption of the exact turn; completion remains an observed native event. |
| `respondToRequest({connectionId, requestId, result, signal})` | Sends an explicit response to an actual pending native request on the observed connection. Native approval/input schemas and authority remain with Codex. |
| `getThreadUrl(threadId)` | `codex://threads/<thread-id>`; no native state change. |
| `openThread({threadId})` | Requests native navigation using that deep link. Reports `requested`, never claims foreground/open confirmation. |
| `dispose()` | Removes bridge subscriptions; does not close a shared SDK Core client. |

All asynchronous methods preserve supplied payload content. `signal` is
operation control, separate from the destination parameters. Disconnection,
missing native service and missing full history return an honest unavailable
state or an actual error, never an empty successful replacement.

## Saved project discovery

`discoverWorkspace` starts the selected thread read, native `project/list` cursor
chain and one selected desktop metadata read independently. It returns
`{threads,projectCatalog}` without rewriting the original thread result. The
catalog includes `hostId`, `observedAt`, the separate `native` and `desktop`
sources, and overall coverage. Native projects and pages remain unchanged with
their real IDs, names and complete root lists. Each source has its own
`status`, coverage and complete diagnostic when unavailable or partial.

The desktop source reads the expressly selected project fields from the current
Codex home's `.codex-global-state.json`: `local-projects`,
`thread-project-assignments`, the current host's
`app-server-project-id-by-legacy-project-id-by-host` map, and its
`app-server-projects-migration-by-host` record. The returned names are
`localProjects`, `threadAssignments`, `nativeProjectIdsByLegacyId` and
`migration`. No complete desktop state is returned or copied, and no Codex
metadata is written. Missing fields remain absent with incomplete coverage.
This is selected desktop metadata, not a stable public filesystem contract.

Data prioritizes actual native project membership, then exact saved assignments
and the legacy/native ID map. Multi-root projects and overlapping roots keep
their explicit identities. Full working folder plus host is the fallback for
tasks whose saved project cannot otherwise be established; a missing catalog
field does not establish that a task is unassigned. Data preserves PM IDs,
editable labels, content, avatars and manual status. It does not infer running
state from discovery or merge projects merely because roots overlap.

The application-owned `discoverTasks` callback composes broad discovery and
idempotent Data mapping. Connections consumes the returned wrapper, and exact
ID lookup retains the same catalog for its deliberate Add action. That action
also uses `pmData.syncNativeDiscovery`; it has no competing project creator.
Existing partial identities require an explicit saved-task association, with
separate choices when more than one saved task matches. A selected PM project
applies only to a deliberate exact single-task association. There is no polling
or discovery triggered by PM record removal.

## Passive hook receipts

`bridge/hooks-service.mjs` composes independently as `pm.codexHooks`. Its
`accept({original})` operation has SDK service lifetime: the receiver stores
the complete original and separate receipt metadata before returning
`status:'received'`. Accepted work drains at the Core owner. Startup reads only
its project-owned receipt catalog and reports missing originals or metadata
without deleting them. `status` and `read` are request-lifetime operations.

Each receipt has a real event ID, receipt time and host, separate from optional
source `hookEventName`, `sessionId`, `agentId`, `turnId` and `cwd`. Source time,
source ordering and account identity are unavailable. A receipt is observed
hook evidence; it never becomes an account-specific current native task state
or proof of task completion. Full originals remain outside durable chat
history and are retrieved only for explicit inspection.

The project-owned [plugin source](../../bridge/codex-hooks/README.md) prepares a
portable relay artifact using the installed public SDK Core client extension.
Preparation does not activate it. Native installation, review, scope and desktop
restart are separate operations. A native command interruption can leave an
unknown delivery outcome; there is no automatic retry or fabricated success.

## Selected task activity

`observeTaskActivity` attaches listeners before independently seeding each
selected thread through `readThread`. It never resumes a thread, starts an
inference, polls or waits for all tasks before delivering an observation.
Callbacks receive `{observerId,revision,observedAt,connection,threads}`. The
observer ID and revision order this subscription's callbacks; they belong to
transient coordination, not durable PM history.
Each row also carries transient `observationId` and `observationRevision`.
Unchanged replay keeps these values; removing and selecting a thread again
starts a new row lifetime. Consumers use them per exact origin/task to avoid
repeating unchanged projections, without comparing raw native status data.

`connection.originIdentity` is `{provider:'codex',accountId,hostId}` when native
`account/read` supplies its experimental `workspaceRouting.chatgptAccountId`.
Otherwise it is null. `hostId` is the native host's reported operating-system
hostname, with no global uniqueness claim. The accompanying `host` provides
`name` and the owned connection process ID. This identity describes the account
used for the observation; it does not establish historical account ownership
of every thread retained in the same Codex home.

Each thread observation includes its exact `origin`, `threadId`, `availability`,
native `status` or null, an optional narrow `turn`, actual pending-request
summaries, a complete app-authored `message`, its real `observedAt`, and
`coverage:{scope:'connected-server',live,reason}`. Native status values are
`active`, `idle`, `systemError` and `notLoaded`; active flags may identify
`waitingOnApproval` or `waitingOnUserInput`. An actual pending request or turn
event is evidence of observed activity even while status is unavailable. A
completed turn does not establish that its task is idle or complete.

The native server's `notLoaded` result means this connection cannot observe
that task's runtime. It must not become a claim that a task running in another
desktop/server process is idle, interrupted or finished. The spawned stdio
server has its own task runtime. Its status notifications cover that server;
read-only history access does not subscribe to another server's activity.
Existing pending requests in another connection are not fabricated from status
flags or history. Raw native frames remain transient in the bridge.

Account change, disconnect and retirement cancel outstanding seed reads and
publish coverage loss using each thread's prior exact origin. New account
observations receive the new identity. Late reads cannot replace newer events.
Current replay preserves thread observation times; only new native observations
advance them. Consumers apply loss records against each record's own origin,
even when the snapshot's current connection changed. A later account's snapshot
must not suppress an old account's queued loss record: compare revisions per
origin/task within the current observer lifetime.

`readThread` and `listThreads` return separate `identity:{connectionId,
originIdentity}` only when that identity remained the same across the read.
The complete native payload remains unchanged when identity is unavailable.
Connections saves this observed identity on new local associations. A saved
association with missing identity can be associated deliberately with the
current connection; existing task content is retained and no migration occurs.

Data owns the narrow durable PM activity projection. Foundation owns selection,
view composition and cancellation. The bridge supplies evidence and coverage;
it does not rewrite task assignment, decisions, human attention or conversation
content. Desktop-wide live observation remains a separate required integration
until a supported desktop-owned event authority is actually connected.
Explicit observer disposal or cancellation is silent and makes pending reads
inert. It does not close the shared Core client or native connection.

## Source and acknowledgment boundaries

Conversation results use `original:{thread,turns,pages,metadata}` with separate
`coverage:{complete,scope:'accessible-history',...}` and `observedAt`.
Original native items may contain protocol/developer material. Sources owns
the selection of ordinary visible messages for saved human-readable history;
the bridge neither persists raw protocol nor replaces originals with summaries.
Missing full-history access is not permission to scrape Codex's private database.

Working-folder reads use Codex's public `fs/readDirectory`, `fs/readFile` and
`fs/getMetadata` operations. Each result is `{status:'available',path,original,
observedAt}`; the original native response remains unchanged. Directory entry
names are direct children. PM's host joins the requested directory and each
name with its platform's standard path API, returning separate child routing
metadata. It does not claim that Codex returned those absolute child paths.
The configured Codex process and this adapter operate on the same host.

Sources owns the user-selected root, traversal, stable source associations,
full original retention, text decoding support and explicit refresh. Directory
coverage and readable-text coverage remain separate. Native metadata identifies
symlinks, while file/directory flags resolve their target; traversal must account
for links and report entries it cannot read. A missing file or cancelled refresh
does not remove a prior original. Codex also documents connection-scoped
`fs/watch` / `fs/changed` / `fs/unwatch`; this increment uses explicit refresh and
does not start watches. No filesystem write, remove or copy operation is exposed.

A send is accepted only after an actual `turn/start` response. The successful
result contains `accepted:true`, `status:'accepted'`, `threadId`, `turnId`,
`acceptedAt`, and the unchanged `acknowledgment`. Acceptance means Codex accepted
the turn, not that work completed or that the user read it. Native notifications
carry progress, approval/input requests and completion. A lost response after a
write has an unknown outcome and is never automatically resent.

Core cancellation or transport loss can arrive before a host acknowledgment;
the browser preserves that uncertainty for an invoked mutation. A native
approval/input reply has no separate response acknowledgment: `status:'sent'`
and `acknowledgment:'stdio-write'` confirm only the local write. Pending ownership
ends on Codex's `serverRequest/resolved` event, with execution observed separately.
Actual `thread/archived` and `thread/deleted` notifications also retire pending
requests and matching transient file changes for that exact thread. These
notifications never imply that unreported descendants reached the same outcome.

Archive, restore and delete require the selected read identity envelope:
`{connectionId,originIdentity:{provider,accountId,hostId}}`. This is separate PM
routing context; the native request remains exactly `{threadId}`. The host
compares the selected destination at dispatch and again immediately before a
queued stdin write. A missing or changed destination returns
`{status:'unavailable',accepted:false,reason:'target-changed',message}` without
sending that operation. Successful results retain the actual operation identity
beside the unchanged native acknowledgment, the selected thread ID and the real
observation time. Workflow owns selection, review and user-facing outcomes.

The successful archive and delete responses are native empty objects. Their
separate PM scope names the root, `descendants:'attempted-by-codex'`, and the
applicable `thread/archived` or `thread/deleted` notification surface. Root
acknowledgment does not establish each descendant outcome. Restore returns the
native thread, which may remain `notLoaded`. No archive-first condition is added
to delete. Missing roots, ephemeral threads, cross-process writers and external
fork references can produce real native errors.

Native archive/delete can stop loaded work and cancel pending requests before
the storage operation finishes. A native error may follow runtime teardown or
partial storage changes; it does not prove that nothing changed. Lost responses
retain an unknown outcome. No operation retries automatically, and callers must
inspect the selected destination before trying again. This contract reflects
the reviewed CLI app-server; it does not establish control of other desktop
processes or a cloud account.

The Connections view mounts `mountCodexRequests` from `requests.js` before its
initial status refresh, so replay reaches the active view. This section presents
actual command/file approval and question requests, preserves entered answers
across replay, and exposes full protocol only in explicitly opened developer
inspection. It offers no automatic or session-wide approval. Unsupported or
incomplete requests retain their native conversation link.

Connections also accepts an exact Codex task ID through `discoverWorkspace`,
then uses the existing local association action. This reads that thread's
metadata and the saved project catalog without resuming the conversation or
enumerating other tasks. The separate task-discovery action remains available
when the user selects broader discovery.

The handoff owner must supply the exact complete prepared text or native typed
input array. The bridge does not turn a domain handoff object into a prompt,
prepend instructions or rewrite selected original sources.

Native chat migration across accounts, account login/logout, credential changes,
saved-project creation and working-file deletion are outside this adapter.
PM-record removal remains data-owned.

## Evidence and implementation decision

Read-only local discovery on October 5, 2026 identified Codex CLI `0.160.0`.
`codex app-server --help`, proxy/daemon help and
`codex app-server generate-json-schema --out output/bridge/codex-schema`
established the installed method/field shapes. Generated inspection files are
ignored, task-owned output. No native conversation was created, resumed, sent,
archived, restored, cancelled or deleted during discovery. Schema availability
is not runtime evidence.

On October 6, 2026, the bridge owner used the supported in-app browser with the
published SDK `0.65.0` development host on Windows. Explicit Connect reached the
native connected state; account metadata arrived independently. Reload restored
that connected state through the service status read without another Connect
action. The observed host status retained connection ID `1`. This establishes
that selected connection path, not native sends, approvals or other platforms.
After a coordinated host restart, the old browser client reported retirement;
reload restored the explicit connection action. A subsequent Connect/Disconnect
pass reported successful native process exit and cleared `closing` in the final
RPC result, leaving Connect available again.

A later read-only pass deliberately associated one existing saved PM task with
the actual connection identity. Its metadata read reported `notLoaded`; the
task card showed an unobserved saved Codex observation and unconfirmed current
activity. Explicit Disconnect produced a disconnected observation while the
existing manual PM status remained unchanged. No native task was resumed,
archived, restored, deleted or sent a message during these passes. Native
archive/restore/delete integration has source-review evidence only.

At `2026-10-06T07:22:39.752Z`, the Bridge owner independently executed the
installed CLI `0.160.0` experimental `project/list` through an owned read-only
app-server connection. Three complete pages returned 60 saved projects,
including the actual PM project and root. Disconnect reported exit 0,
`closing:false` and no process ID. This establishes the native catalog read;
combined browser mapping and native hook delivery require their separate
execution evidence. No native thread mutation or inference was performed.

The installed SDK `0.65.0` public `arcane-os/core/client`,
`arcane-os/core/runtime` and `arcane-os/event-manager` supply reusable transport,
service lifecycle and events. PM owns the Codex operation mapping, directory/task
association, connection presentation and handoff acknowledgment semantics. No
SDK or Arcane OS source is imported or edited. PM owns no alternate event bus,
HTTP server, account store or durable conversation store.

One native bridge owns at most one child connection. Initialization occurs once
per connection; account reads follow initialization and account-change events.
Listing reads one page at a time because the next cursor depends on the previous
page. Full conversation retrieval reads the
selected thread's complete pages alongside its metadata, without a content cap.
Discovery uses the native state database only and avoids a file-repair scan.
Independent operations remain independent. Foreground status changes before
waiting; native lifecycle and errors have an explicit owner. Runtime timing is
unmeasured. Local tests, linters and validation builds were not selected.

Official references: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[desktop deep links](https://learn.chatgpt.com/docs/reference/commands#deep-links),
[project and chat boundaries](https://learn.chatgpt.com/docs/projects?surface=app).
The installed schemas are more specific than prose about history support:
`thread/turns/list` advertises `itemsView:'full'`; the adapter must still report
any actual server refusal or partial view honestly.
