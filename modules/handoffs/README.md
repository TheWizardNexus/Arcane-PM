# Local handoffs

`createHandoffService({pmData, getStorage, sourceLibrary, bridge, localAI})`
composes application-owned handoff policy with the shared storage, source,
transport, and model owners. It creates no alternate database or model runtime.

`mountHandoffsView(container, {handoffs, pmData, sourceLibrary, projectId,
taskId, handoffId, onNavigate, onStatus, signal})` returns `{refresh, dispose}`.
It saves local drafts, reviews complete selected originals, and keeps sending
as an explicit separate action. It loads its adjacent stylesheet and preserves
the shell's main scrolling surface.

## Preparation

- `createDraft({projectId, fromTaskId, toTaskId, assignment, decisions,
  openQuestions, preparedNote, sourceIds})` returns the saved draft.
- `get(id)` returns a saved record or null; `list({projectId, signal})` returns
  newest-updated records first. Read failures preserve readable records on the
  thrown aggregate error.
- `updateDraft(id, changes)` changes authored fields or source IDs and returns
  to preparing. Previously sent content remains in its original record.
- `prepare(id, {selection, signal})` accepts the source owner's complete
  `getSelection()` result or reads the saved source IDs. Original text stays
  unchanged; source metadata and file references occupy separate fields.
- `readOriginal(handoffId, sourceId)` returns the retained source with its
  complete `originalFile`, when present. Binary snapshots use DBOPFS files.
- `markReady(id)` records readiness after an assignment and the selected
  originals have been prepared. It performs no send.
- `reopen(id)` returns a preparing draft. A previously attempted handoff gets
  a new ID and `previousHandoffId`, preserving its delivery history.

`prepareNote(id, {signal, onChunk})` passes complete separate messages to
`localAI.prepare` with `persist: false`. The model's real chunks appear in the
same note field. Saving the authored note is a separate user action; original
sources remain unchanged. Cancellation, missing input support, and empty output
preserve the previous note. Local model execution depends on the model owner.

## Delivery and progress

`deliveryAvailability(id)` reports whether the connected bridge can carry the
saved handoff. Binary originals currently keep delivery unavailable because the
bridge's native input contract has no complete file-transfer path.

`deliver(id, {signal})` requires a ready record and a receiving task with a
connected native thread. Assignment, decisions, questions, note, and original
text remain separate unchanged native text inputs. Control and source metadata
use separate inputs. The service saves an unconfirmed attempt before the native
call. Acceptance requires the bridge's explicit accepted status, matching
destination thread, and returned native turn ID. A fulfilled Promise alone
does not establish delivery. Missing confirmation remains unconfirmed and is
never automatically retried. Confirmed unavailability before dispatch returns
the record to ready. Raw transport acknowledgments stay outside saved records.

Per-handoff Web Locks serialize the read, attempt write, native call, and result
write across tabs. A module-local queue supports same-realm operation where
Web Locks are unavailable; cross-tab serialization requires Web Locks.
If result storage fails, the thrown error includes `handoffOutcome`, and the
view distinguishes native acceptance from failure to save its tracking record.

`recordProgress(id, {state, message, actor, observedAt})` records attributed
receiving-task evidence after acceptance. `state` is started or completed.
Preparation, readiness, acceptance, and execution remain distinct.

## Retained-file lifecycle

The record's `retainedFiles` inventory registers each owned snapshot before
writing it. Interrupted and replaced snapshots remain visible to their owner.
Reopened drafts reference the existing original while ownership remains with
the original record. Inventory, preparation, reopen, file read, and disposal
coordinate through the handoff-originals lock so active readers and retained
references survive concurrent cleanup.

Pass `handoffs.disposableResources` into `createCleanupService`. Its
`list({projectId, signal})` returns registered files with complete live `usedBy`
handoff IDs, owner, purpose, location, and retained/disposable lifecycle.
`dispose(id, {signal})` re-reads references under coordination, removes only an
unused registered snapshot through DBOPFS, then removes the inventory entry.
An interrupted inventory update can be retried; DBOPFS deletion is idempotent.
The service never scans or deletes working folders, imported source originals,
native conversations, or unrelated app files.

## Verification boundary

Browser verification uses synthetic local PM records. Source inspection covers
delivery and file-lifecycle paths. Actual native acceptance, lost-response
behavior, simultaneous cross-tab sends, and model inference require their
corresponding runtime; no live send or native deletion is part of this review.
Local test suites, linters, type checks, and builds are outside this increment.
