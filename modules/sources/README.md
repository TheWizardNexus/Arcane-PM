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
| `importTasks({projectId, taskId, signal, onProgress} = {})` | Refresh metadata/complete assignments from PM task records, including archived tasks. An explicit task ID refreshes its current mapping even after a project move. |
| `importConversation(taskId, {signal, onProgress} = {})` | Ask the bridge for complete accessible history. Retain each user text part and assistant message separately, verbatim. Return visible-text coverage and explicit unavailable-attachment failures. Unsupported/partial history is reported; summaries never become complete originals. |
| `refresh(id, options)` | Refresh task or conversation through its owner. `refresh(id, {file, signal})` retains an explicitly reselected working file under the same PM source ID. |
| `list({projectId, indexed, signal} = {})` | Return all corresponding metadata, including archived sources and retained sources removed from search. |
| `query(text, {projectId, kind, signal, onProgress} = {})` | Persist the exact query, search locally using the published SDK, return `{query, matches, failures, total}`. Matches contain `{source, body, score, matchedFields}`. Every body is complete. |
| `read(id, {signal} = {})` | Return `{source, content, originalFile, availability, freshness, failures}`. Availability is `retained` or `unavailable`; freshness is `snapshot`, `current`, or `stale`. Text and original-file reads are independent, so a readable original remains recoverable if its search text is unavailable. No missing content is fabricated. |
| `select(id, selected = true)` / `getSelectedIds()` | Persist explicit source selection independently of navigation. |
| `getSelection({signal} = {})` | Return `{sources, unavailableIds, complete}` with full `read` results in selection order. File values remain File objects; consumers store them as files, never JSON-serialize them. |
| `getQuery(projectId)` | Return the complete saved query, default `''`. |
| `removeFromIndex(id)` / `restoreToIndex(id)` | Change searchable membership only; retain originals, metadata, selection, native chats and system files. |
| `dispose()` | Release the task-record subscription; active operations use their caller-owned cancellation signals. |

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

This increment selects source and Git delivery, plus supported browser
verification using disposable records. Local tests, checks, linters, validation
builds, packaging, native platforms and production deployment are unselected.
