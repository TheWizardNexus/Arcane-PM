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
    bridge, pmData, projectId, onNavigate, onStatus, signal
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
| `listThreads({cwd, archived, signal})` | All pages for the selected archive state and directory filter. Original thread records remain unchanged. |
| `listProjects({archived, signal})` | Observed working-folder associations from threads, with native project IDs when present. This is not a saved-project registry. |
| `readThread({threadId, signal})` | Current native thread metadata, including actual observed state. Does not resume a thread. |
| `readConversation({threadId, signal})` | Complete accessible turns and original page responses, plus separate coverage. Unavailable/partial history is explicit. |
| `readDirectory({path, signal})` | Native direct-child listing in `original.entries`, with separate `children:[{fileName,path}]` routing metadata joined by the local native host. No recursive traversal. |
| `readFile({path, signal})` | Complete original content in native `original.dataBase64`; Sources owns transport decoding to a retained File. |
| `getFileMetadata({path, signal})` | Native file/directory/link flags and real timestamps in `original`. A zero timestamp means unavailable. |
| `resumeThread({threadId, signal})` | Native resume; required before continuing a thread that is not loaded by this connection. It is separate from a read. |
| `createTask({cwd, content, signal})` | Native thread creation and initial turn; new PM-created tasks select `gpt-6-astra` / `ultra`. |
| `continueTask({threadId, content, signal})` | Resume and submit the complete supplied content to that thread. |
| `sendHandoff({threadId, content, signal})` | Same destination operation with exact prepared text. An explicit typed `input` array may be supplied instead of `content`. |
| `archiveThread({threadId, signal})` | Native archive, including Codex's documented attempt to archive descendants. It does not remove PM records or working files. |
| `restoreThread({threadId, signal})` | Native unarchive. |
| `cancelTurn({threadId, turnId, signal})` | Requests interruption of the exact turn; completion remains an observed native event. |
| `respondToRequest({connectionId, requestId, result, signal})` | Sends an explicit response to an actual pending native request on the observed connection. Native approval/input schemas and authority remain with Codex. |
| `getThreadUrl(threadId)` | `codex://threads/<thread-id>`; no native state change. |
| `openThread({threadId})` | Requests native navigation using that deep link. Reports `requested`, never claims foreground/open confirmation. |
| `dispose()` | Removes bridge subscriptions; does not close a shared SDK Core client. |

All asynchronous methods preserve supplied payload content. `signal` is
operation control, separate from the destination parameters. Disconnection,
missing native service and missing full history return an honest unavailable
state or an actual error, never an empty successful replacement.

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

The Connections view mounts `mountCodexRequests` from `requests.js` before its
initial status refresh, so replay reaches the active view. This section presents
actual command/file approval and question requests, preserves entered answers
across replay, and exposes full protocol only in explicitly opened developer
inspection. It offers no automatic or session-wide approval. Unsupported or
incomplete requests retain their native conversation link.

Connections also accepts an exact Codex task ID through `readThread`, then uses
the existing local association action. This reads metadata without resuming the
conversation or enumerating other projects. The separate task-discovery action
remains available when the user selects broader discovery.

The handoff owner must supply the exact complete prepared text or native typed
input array. The bridge does not turn a domain handoff object into a prompt,
prepend instructions or rewrite selected original sources.

Native deletion, native chat migration across accounts, account login/logout,
credential changes, saved-project creation and working-file deletion are outside
this adapter. The installed CLI exposes a native delete method; that fact does
not select it for PM's initial increment. PM-record removal remains data-owned.

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
