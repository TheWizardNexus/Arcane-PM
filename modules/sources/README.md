# PM sources and local search

Import `createSourceLibrary` and `mountSourcesView` from `modules/sources/index.js`.
The factory is synchronous and takes `{getStorage, pmData, bridge?}`. It opens no
second database. The data owner's `getStorage()` supplies the single SDK DBOPFS
connection. The shell loads `modules/sources/sources.css` after the Arcane theme.

## Source contract

A source has a stable PM UUID `id`, `kind` (`task`, `conversation`, `file`, or
`note`), `title`, `projectId`, `taskId`, `accountId`, `origin`, `location`,
`importedAt`, `refreshedAt`, `archivedAt`, `indexed`, `freshness`, `textKey`, and
`originalKey`. External identities remain separate from the PM UUID. Switching
accounts never remaps a source or migrates a native conversation. Locations are
exact supplied references; browser file selection exposes a filename, not an
invented absolute system path.

`pm_sources` holds metadata, `pm_source_originals` holds complete original file
snapshots, and `pm_source_text` holds verbatim text in a `{content}` storage
record. JSON storage encoding preserves the original string, including a
leading BOM and lone surrogates; only the unchanged content field is passed to
search or returned to callers. `pm_source_documents` is the
SDK-owned derived search corpus. `pm_source_preferences` stores selected IDs and
the last explicit query for each project. Working files stay in their folders.
No original is deleted by index removal or task archival.

| Method | Contract |
| --- | --- |
| `importSources(records, {signal, onProgress} = {})` | Retain records with `content` (complete text or null), optional `originalFile`, and source metadata. Returns `{sources, failures}`. An existing `id` explicitly refreshes that retained source. |
| `importFiles(files, {projectId, taskId, signal, onProgress} = {})` | Retain explicitly selected browser Files. UTF-8 text is searchable; unsupported or undecodable formats retain the complete original and searchable filename metadata. |
| `importFolder(path, {projectId, taskId, origin, signal, onProgress} = {})` | Read an explicitly selected absolute folder through the connected bridge. Retain full originals with stable source IDs and report enumeration, original-read, text and index coverage separately. |
| `importTasks({projectId, taskId, signal, onProgress} = {})` | Refresh metadata/complete assignments from PM task records, including archived tasks. An explicit task ID refreshes its current mapping even after a project move. |
| `importConversation(taskId, {signal, onProgress} = {})` | Ask the bridge for complete accessible history. Retain each user text part and assistant message separately, verbatim. Return visible-text coverage and explicit unavailable-attachment failures. Unsupported/partial history is reported; summaries never become complete originals. |
| `refresh(id, options)` | Refresh task or conversation through its owner. A folder source refreshes its selected root through the read-only bridge. `refresh(id, {file, signal})` retains an explicitly reselected working file under the same PM source ID. |
| `list({projectId, taskId, kind, indexed, signal} = {})` | Return all corresponding metadata, including archived sources and retained sources removed from search. Filters select exact PM associations. |
| `query(text, {projectId, kind, signal, onProgress} = {})` | Persist the exact query, search locally using the published SDK, return `{query, matches, failures, total}`. Matches contain `{source, body, score, matchedFields}`. Every body is complete. |
| `read(id, {signal} = {})` | Return `{source, content, originalFile, availability, freshness, failures}`. Availability is `retained` or `unavailable`; freshness is `snapshot`, `current`, or `stale`. Text and original-file reads are independent, so a readable original remains recoverable if its search text is unavailable. No missing content is fabricated. |
| `readTaskSources(taskId, {kind, signal} = {})` | Return `{sources, unavailableIds, failures, complete, coverage}` for this exact task, independently of search membership or global selection. Each source is a full `read` result. `coverage.scope` is `retained-task-sources`; completeness concerns these retained records only, including an empty scope, and never claims complete native history. |
| `subscribe(handler, {signal} = {})` | Observe committed source batches through the shared SDK event owner. Returns unsubscribe. No replay or native reads occur. |
| `select(id, selected = true)` / `getSelectedIds()` | Persist explicit source selection across projects independently of navigation, so originals from one project can be included in another project's handoff. |
| `getSelection({signal} = {})` | Return `{sources, unavailableIds, complete}` with full `read` results in selection order. File values remain File objects; consumers store them as files, never JSON-serialize them. |
| `getQuery(projectId)` | Return the complete saved query, default `''`. |
| `removeFromIndex(id)` / `restoreToIndex(id)` | Change searchable membership only; retain originals, metadata, selection, native chats and system files. |
| `dispose()` | Cancel shared task acquisitions and release the task-record subscription and source event handle. Other operations retain their caller-owned cancellation signals. |

`mountSourcesView(container, {sources, projectId, sourceId, taskId, handoffId, onNavigate, onSelection,
onStatus, signal})` returns `{dispose()}`. Routes are `task`, `sources`, and
`handoffs`; route parameters carry project/task/source IDs. Incoming handoff
and task IDs are preserved when returning to the existing draft. Rendering and status
acknowledgement precede storage work. Search runs on explicit form submission,
not every keystroke. Result selection retains the complete original for local
preparation; it does not send anything.

## Ownership and execution

PM owns source associations, archive semantics, selection, refresh policy and
the source-reading view. Published `arcane-os/dbopfs-document-library` owns
document corpus persistence and lexical scoring. The shared DBOPFS owns file
I/O and the browser's persistence boundary. Native conversations stay with the
bridge. The public site's article search is a separate unchanged feature.

The initial published SDK contract was inspected at `arcane-os@0.62.0`.
`bootstrap` replaces one derived corpus; `search` returns complete bodies.
`buildContext` and its assembled labels are deliberately unused for original
retrieval. No model, network request, token allowance, or output limit is needed
for ordinary local search.

Conversation mapping uses the installed Codex app-server schema:
`original.turns[].items[]`, `userMessage.content[].text` for text parts and
`agentMessage.text`. Complete source text stays in its own file; source metadata
holds native item/turn IDs, multipart position, role, and actual nullable turn
timestamps. No per-message timestamp is invented. Non-text attachments remain
with the native conversation and are reported as unavailable locally. Tool,
reasoning, bootstrap and provider envelopes never cross this retention boundary.
Original revisions are retained; refreshing commits the current metadata only
after the new original has been written. Disposal of prior retained revisions
is a separate lifecycle operation outside this increment.

Task-scoped reads order kinds deterministically, then conversation origins and
their actual native turn/item/part positions. Other retained records use import
time and stable source ID. Conversation refresh records `turnIndex` and
`itemIndex` without changing text. Earlier snapshots remain untouched until an
explicit refresh; when their ordering coordinates are absent, reads retain them
in stable import order and report `coverage.ordered: false`. Callers needing a
current native transcript must await `importConversation(taskId)` and inspect
its own coverage before asking for a content-derived result. `readTaskSources`
does not discover threads, refresh history, assign project names, rewrite task
assignments, or change `sourceRefs`. Unsupported binary files may be fully
retained with `content: null`; callers must use the actual content availability.

Each source-change batch is `{changes}`. A change contains `id`, `taskId`,
`previousTaskId`, `projectId`, `previousProjectId`, `kind`, `operation`
(`created` or `updated`), `contentChanged`, `associationChanged`, and
`originalChanged`. Exact previous text comparison determines `contentChanged`;
an unreadable prior representation gives `null`, explicitly unknown. An
identical-text refresh reports `false`. `originalChanged` reports replacement
of a retained File revision, not a comparison of file contents. Events contain
metadata only and publish committed changes even when a later item is cancelled
or indexing fails. Search exclusion and global selection are not source
deletion or content change. No source-removal operation is added.

One task read enumerates source metadata once and reads matching originals in
groups of four. Only the metadata snapshot shares the existing mutation queue;
retained original revisions are read outside it. It does not make native or
model requests. One retention batch publishes one metadata event; text comparison
adds one previous-text read per refreshed record. Folder refresh compares each
staged text record at publication, keeping decoded folder bodies out of the
pending metadata list. Storage and event mechanics remain SDK-owned; PM owns
the task association, original-content mapping, and avatar input selection.

Concurrent `importConversation` calls share active work when the PM task,
revision, display associations, full saved native origin, and observed bridge
connection identity match. Distinct imports remain ordered per task. Concurrent
`readTaskSources` calls share one metadata enumeration and one set of original
reads when their task, exact `kind` option and queue generation match. An omitted
kind remains different from explicit `null`. Queueing a non-snapshot operation
advances that generation before it starts, so a subsequent reader waits for
earlier queued work instead of joining an older snapshot. This conservatively
also separates reads across queued query or selection writes. Task-record
events retire matching acquisitions from further sharing; existing consumers
keep their selected operation and its ordinary freshness result.

Each caller owns its cancellation and progress observer. Cancelling one caller
rejects only that caller, removes its observer, and leaves other consumers
running. Cancelling the last caller aborts the shared signal through native
reading, retention and indexing, or stops further retained-original groups.
Already-started DBOPFS reads finish through their existing storage owner;
Sources suppresses their cancelled result. Library disposal cancels every
shared acquisition. Progress observer failures remain observational. Complete
results and errors retain their existing shapes; active consumers receive the
same result and must leave its records unchanged.

Acquisition entries and listeners are released on success, failure or last
consumer cancellation. The mutation queue retains completion only, never its
last result. There is no completed transcript cache, timer or polling. Callers
own returned references and release them when their work finishes; the canonical
retained originals and prior revisions keep their existing storage lifecycle.
Later non-overlapping calls perform fresh acquisition. For two matching active
portrait consumers this reduces two native reads/retention/index passes to one
and two full original-read passes to one; elapsed runtime has not been measured.
The coordination is PM task/source policy in this DAO. SDK DBOPFS, corpus and
event owners remain unchanged; the inspected published `arcane-os@0.79.0` API
does not expose this task-acquisition contract.

One import batch performs one corpus replacement, regardless of batch record
count. Independent file reads settle in groups of four; errors identify actual
records. The original writes and derived corpus replacement share a narrow
mutation queue because they update one search corpus. Task identity lookup and
revision decisions share that retention boundary. Native conversation reads
are ordered per task outside the corpus queue, so independent search continues
while the connection responds. Message identities retain their actual native
provider, host, thread and account. A search snapshot shares
that queue so replacement cannot remove the generation being read. Search has asynchronous
storage reads and caller-owned cancellation; the SDK's ranking remains its
published implementation. Corpus preparation is cached until a source mutation,
and task changes mark task snapshots stale. There is no polling. A failed index
refresh preserves original records and permits explicit retry. A partial SDK
bootstrap is reported through its complete read failures and remains eligible
for a later explicit rebuild; readable indexed results remain available. Raw errors stay
in developer diagnostics; ordinary UI reports recovery actions.

## Explicit working-folder import

The bridge's `readDirectory`, `readFile` and `getFileMetadata` call the native
Codex [filesystem API](https://learn.chatgpt.com/docs/app-server#filesystem).
Schema and documentation support are distinct from actual connected access.
The native owner supplies complete original responses and separate host-joined
child paths; Sources uses those paths without guessing the host's path syntax.
Base64 decoding is confined to the file transport boundary. File contents are
retained unchanged and supported UTF-8 text becomes searchable separately.

Each folder source retains its chosen root and entry location. Refreshes keep
the same source association, search membership and selection. Native reads are
ordered per root and bounded within each refresh. Complete originals are saved
as they arrive, followed by one publication of current source metadata and one
derived corpus refresh. Unrelated native waiting does not hold the search queue.

Results include `coverage` with `scope: 'selected-directory'`, `rootPath`,
`complete`, `cancelled`, `enumerationComplete`, `originalsComplete`,
`textComplete`, `indexComplete`, `filesSeen`, and `retained`. Every failed entry
has its exact path and phase in `failures`; raw errors remain in diagnostics.
Unsupported text formats retain their full file originals. Descendant directory
links that cannot be traversed with established target/cycle semantics are
reported in `untraversed`, and previous originals survive missing entries,
unreadable files and cancelled refreshes. This coverage concerns this selected
refresh; it never proves access to every native file or conversation.

Folder reading occurs only after an explicit import or refresh action. This
increment adds no filesystem writes, deletes, watches or automatic polling.

This increment selects source and Git delivery, plus supported browser
verification using disposable records. Local tests, checks, linters, validation
builds, packaging, native platforms and production deployment are unselected.
