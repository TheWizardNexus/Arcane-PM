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

`coreClient` is optional. When omitted, the bridge reads the existing SDK client
through `getInstalledCoreClient()`; it does not install a transport or probe a
local port. Native composition supplies `bridge/codex-service.mjs` to the SDK
Core runtime. The current foundation selects browser source development, with
no native host running.

| Method | Contract |
| --- | --- |
| `status()` | Synchronous last observed connection state; starts no process. |
| `refreshStatus({signal})` | Reads `pm.codex.status` when a Core client exists. |
| `connect({signal})` | Explicitly asks the composed host to start its owned Codex connection. |
| `disconnect({signal})` | Ends that bridge connection; never stops a separately owned Codex app or daemon. |
| `subscribe(listener, {signal, emitCurrent:true})` | Observes connection state through the shared SDK event owner, with current state replay. Returns unsubscribe. |
| `observeNotifications(listener, {signal})` | Complete native notifications, transient and outside durable chat history. |
| `observeRequests(listener, {signal})` | Actual pending native approval/input requests; never automatically approved. |
| `listThreads({cwd, archived, signal})` | All pages for the selected archive state and directory filter. Original thread records remain unchanged. |
| `listProjects({archived, signal})` | Observed working-folder associations from threads, with native project IDs when present. This is not a saved-project registry. |
| `readThread({threadId, signal})` | Current native thread metadata, including actual observed state. Does not resume a thread. |
| `readConversation({threadId, signal})` | Complete accessible turns and original page responses, plus separate coverage. Unavailable/partial history is explicit. |
| `resumeThread({threadId, signal})` | Native resume; required before continuing a thread that is not loaded by this connection. It is separate from a read. |
| `createTask({cwd, content, signal})` | Native thread creation and initial turn; new PM-created tasks select `gpt-6-astra` / `ultra`. |
| `continueTask({threadId, content, signal})` | Resume and submit the complete supplied content to that thread. |
| `sendHandoff({threadId, content, signal})` | Same destination operation with exact prepared text. An explicit typed `input` array may be supplied instead of `content`. |
| `archiveThread({threadId, signal})` | Native archive, including Codex's documented attempt to archive descendants. It does not remove PM records or working files. |
| `restoreThread({threadId, signal})` | Native unarchive. |
| `cancelTurn({threadId, turnId, signal})` | Requests interruption of the exact turn; completion remains an observed native event. |
| `respondToRequest({requestId, result, signal})` | Delivers an explicit response to an actual pending native request. Native approval/input schemas and authority remain with Codex. |
| `getThreadUrl(threadId)` | `codex://threads/<thread-id>`; no native state change. |
| `openThread({threadId})` | Requests native navigation using that deep link. Reports `requested`, never claims foreground/open confirmation. |
| `dispose()` | Removes bridge subscriptions; does not close a shared SDK Core client. |

All asynchronous methods preserve supplied payload content. `signal` is
operation control, separate from the destination parameters. Disconnection,
missing native service and missing full history return an honest unavailable
state or an actual error, never an empty successful replacement.

## Source and acknowledgment boundaries

Conversation results use `original:{thread,turns,pages}` with separate
`coverage:{complete,scope:'accessible-history',...}` and `observedAt`.
Original native items may contain protocol/developer material. Sources owns
the selection of ordinary visible messages for saved human-readable history;
the bridge neither persists raw protocol nor replaces originals with summaries.
Missing full-history access is not permission to scrape Codex's private database.

A send is accepted only after an actual `turn/start` response. The successful
result contains `accepted:true`, `status:'accepted'`, `threadId`, `turnId`,
`acceptedAt`, and the unchanged `acknowledgment`. Acceptance means Codex accepted
the turn, not that work completed or that the user read it. Native notifications
carry progress, approval/input requests and completion. A lost response after a
write has an unknown outcome and is never automatically resent.

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
is not runtime evidence. Host execution and platform integration remain separate
from the browser-only preview.

The installed SDK `0.62.0` public `arcane-os/core/client`,
`arcane-os/core/runtime` and `arcane-os/event-manager` supply reusable transport,
service lifecycle and events. PM owns the Codex operation mapping, directory/task
association, connection presentation and handoff acknowledgment semantics. No
SDK or Arcane OS source is imported or edited. PM owns no alternate event bus,
HTTP server, account store or durable conversation store.

One native bridge owns at most one child connection. Initialization and account
read occur once per connection; listing reads one page at a time because the next
cursor depends on the previous page. Full conversation retrieval reads the
selected thread's complete pages, without a content cap. Independent operations
remain independent. Foreground status changes before waiting; native lifecycle
and errors have an explicit owner. Runtime timing is unmeasured because native
execution and local tests were not selected.

Official references: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[desktop deep links](https://learn.chatgpt.com/docs/reference/commands#deep-links),
[project and chat boundaries](https://learn.chatgpt.com/docs/projects?surface=app).
The installed schemas are more specific than prose about history support:
`thread/turns/list` advertises `itemsView:'full'`; the adapter must still report
any actual server refusal or partial view honestly.
