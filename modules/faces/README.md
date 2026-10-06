# Task and project avatars

`createTaskFaceController({imageRuntime, data, getStorage = data.getStorage, signal})`
uses the published SDK image accessor and PM's single shared DBOPFS connection.
It owns PM first-avatar persistence, candidate selection and saved task/project
associations. It creates no image engine, model store, downloader, provider
adapter, or native working projection.

## Operations

- `generate({taskId, model, prompt, parameters?, signal?})` returns
  `{result, candidates}` after actual SDK generation. `result` is the complete
  SDK result. Each candidate exposes `id`, `taskId`, `operation`, `model`,
  `prompt`, `parameters`, `strength`, `blob`, `mediaType`, `name`, `width`, `height`,
  `createdAt`, and `chosen`. `subjectType` and `subjectId` distinguish task and
  project identities. `projectId` identifies the initial subject's project.
  Initial candidates retain no prompt or source text; their public `prompt`
  is `undefined` and `source` is `null`. Deliberate candidates retain their
  complete authored prompt as before.
- `edit({taskId, model, image, prompt, strength, parameters?, signal?})` has the
  same result. `image` is the original complete supported PNG Blob/File, and
  `strength` must be explicit. The SDK owns decoder support and parameter errors.
- `importCandidate({taskId, image, prompt = '', signal?})` returns one candidate
  using the caller's complete browser Blob/File. It performs no decoding or
  conversion and does not need Core or a model. The caller's media type and
  filename stay in metadata; dimensions remain unknown (`null`). The view
  owns browser format support, display errors and preview URLs. Saving uses the
  same deliberate `choose()` action. Passing an imported file to `edit()` still
  requires a PNG encoding supported by the SDK.
- `choose(candidateId, {signal?} = {})` writes the complete candidate image and,
  for an edit, its complete original PNG, saves metadata, and then calls
  `data.setTaskFace(taskId, candidateId)` or
  `data.setProjectFace(projectId, candidateId)`. It returns
  `{faceId, metadata, task}` or `{faceId, metadata, project}`.
- `ensureInitialFace({taskId, projectId, model, prompt, source, parameters?,
  signal?})` generates and saves the first actual returned image only while that
  task remains without a face. `source` contains the complete original strings
  `{title, assignment, projectPurpose}`. `projectId` is the task's actual project
  ID or `null`. The separate `prompt` is the complete model-authored image
  description. This method returns `{applied, reason, task, faceId}`, with
  complete `result`, `candidates` and saved `metadata` when generation reaches
  persistence. Reasons are `assigned`, `face-present`, `task-missing`, or
  `request-stale`. Existing faces return without inference or a storage write.
- `cancelInitialFace(taskId)` cancels that task's pending first-avatar operation.
- `ensureInitialProjectFace({projectId, model, prompt, source, parameters?,
  signal?})` uses the same lifecycle for a project's own avatar. Its original
  `source` is `{name, description}`. It returns `{applied, reason, project,
  faceId}`, plus the same complete generated result/candidates/metadata when
  applicable. Missing projects use reason `project-missing`.
- `cancelInitialProjectFace(projectId)` cancels only that project's initial work.
- `read(faceId, {signal?} = {})` returns `{blob, metadata, originalBlob}` or
  `null` when no face metadata exists. `originalBlob` is `null` for generation.
- `current()` exposes transient `status`, `message`, `progress`, active
  `operation`/`taskId`, model availability, complete candidate records,
  `choosingTaskIds`, `choosingProjectIds`, `initialFaces`, and `disposed`. Each
  `initialFaces` entry is `{subjectType, subjectId, taskId, projectId, status,
  message, progress, faceId}` and retains its latest transient `Thinking`,
  `generating`, `saving`, `ready`, `cancelled`, or `error` state. Project entries use
  `taskId: null`; task entries preserve the existing task ID.
- `subscribe(listener, {signal?} = {})` synchronously replays current state,
  then observes changes, returning an unsubscribe function.
- `cancel()` aborts inference or a pending readiness wait. `dispose()` aborts
  owned work, removes subscriptions, joins pending inference/selection work,
  and releases transient candidates and initial-avatar state. The injected
  shared image accessor and loaded model remain under their composition owner's
  lifecycle.

An accepted inference publishes transient `Thinking` synchronously, before any
storage or model wait. Requests wait for the exact selected model to be loaded
and `ready`; an unavailable/failed runtime reports an error. Loading remains an
ordinary waiting state. Replacement, unloading, cancellation and controller
disposal suppress late candidates. Actual native sampling progress remains
progress; no intermediate image or conversation output is fabricated.

The controller retains all completed candidates during its lifetime. Deliberate
generation, editing and cancelling leave the task association unchanged. An
existing saved face changes only after `choose()` finishes the data-owner
association write. Failure before that write preserves the current association
and the candidate for retry. Already accepted storage writes may complete after cancellation; saved
unassociated assets remain available, and no automatic rollback or deletion
touches previous faces. An association write already accepted by the data owner
returns its actual outcome even if cancellation arrives during that write.

One task or project permits one deliberate selection write at a time in this
controller; independent subjects save concurrently. Another deliberate inference
supersedes the active deliberate inference. First-avatar requests have independent
subject ownership and leave those deliberate requests running. Their keys are
`task:<id>` and `project:<id>`; matching IDs across record types remain separate.
Complete images are written using `writeFile('pm_face_images', filename, blob)`;
metadata uses `set('pm_faces', faceId + '.json', metadata)`. Deliberate generation
and editing preserve complete prompts separately from image content. Initial
avatar metadata omits prompt and source text. Reads use `readFile`, preserving the
complete image without decoding, resizing, compositing, or re-encoding it.
`read()` restores the saved media type on the returned Blob while preserving
the complete file content.

## First-avatar lifecycle and content

The application composition starts first-avatar work asynchronously so cards
render immediately. It supplies an actual selected image model and a meaningful
image description derived from the task or project's work. The shared visual
direction is the approved warm adult editorial illustration, soft rounded forms, deep teal,
warm ivory, muted gold and restrained lavender in the
[design references](../../docs/designs/image-prompts.md). The subject or symbol
comes from the actual work; the older sample employee portraits do not define
new task or project subjects. This controller chooses no model and invents no
prompt, subject, source content or result.

The published image API accepts one prompt. Composition prepares that prompt
through its text owner using separate application instructions and complete
original task title, assignment and project-purpose messages, or original
project name and description messages. The text preparation uses `persist: false`.
Its original strings reach this controller unchanged in `source` for the active
request's freshness comparisons. `projectPurpose` comes from the project owner; the task record has no
invented purpose field. This controller forwards the complete image prompt
unchanged and keeps the generated image untouched.

The initial request's prompt and source text exist only during the active
operation. They never enter retained candidate records or DBOPFS face metadata,
and the request releases its input on every settlement. The intended durable
output is the complete image, its subject association, model/parameters,
dimensions and real timestamp. Every additional actual image remains available
as a candidate without retaining that temporary text. The complete SDK result
is returned for the caller's active operation and is not cached by this
controller. Deliberate generation/editing retain their existing complete prompt
metadata; this boundary performs no migration of existing records.

Both initial-avatar methods publish `Thinking` synchronously before their first
storage or model wait. Duplicate calls for the same pending subject, source and
model join its existing promise and original cancellation signal. A changed
source or model supersedes only that subject's initial request. The composition
owns cancellation when task or project-purpose changes invalidate its prepared
description. Selected-model replacement, unloading, errors and
disposal also cancel active inference through the SDK signal. Pending operations
are tracked before observers run so disposal joins accepted work.

Each request reads its task or project before waiting, before generation and
before saving. It preserves every existing `faceRef`. After complete image and metadata
writes, `data.setTaskFaceIfEmpty(taskId, faceId, {isCurrent, signal})` owns the
conditional association under its existing task lock. Its synchronous callback
checks the live request and exact task ID, project ID, title and assignment;
a project uses `data.setProjectFaceIfEmpty(projectId, faceId, {isCurrent, signal})`
under its project lock and checks its exact project ID, name and description.
A deliberate selection in progress also makes that subject's initial request
stale. Each association uses its own record; a project never borrows a task's
avatar. `choose()` cancels initial generation before its own save. A source change,
deletion, cancellation or concurrent saved face prevents a new association.
Status and account changes do not alter the source comparison. Reload reuses
the saved association and complete image through `read()`.

The first returned image becomes the initial face. Every additional actual
image remains a candidate for deliberate choice; no generated image is
fabricated or discarded. Failures retain honest transient status and complete
developer diagnostics. There is no automatic retry, regeneration, rollback or
asset deletion. Accepted image/metadata writes can leave unassociated saved
assets if cancellation or another choice wins before association. An association
write already accepted by the data owner returns its actual outcome. SDK native
context ownership serializes competing image operations; PM adds no inference
queue or readiness polling.

Events use `createArcaneEventSource` with source `arcane-pm.faces` and semantic
event `arcane-pm.faces.state`. Concise ordinary status is separate from complete
rejected errors and developer-console diagnostics. No durable chat history,
tool protocol, request envelope, or model output log is created.

## Capability and evidence boundary

PM needs persistent recognizable task/project associations, work-derived first
avatars and deliberate choices for variants or replacement. These workflows and
their records are PM domain behavior. Neutral image inference, PNG transport,
model lifecycle, native cancellation and DBOPFS I/O
reuse their published SDK owners. Presentation remains with the local-AI view
and the application's shared theme; this module adds no visual styles.

One inference request runs once and retains its actual returned images. One
choice writes one candidate, optionally one original, one metadata record and
one task or project association. SDK context ownership controls native contention; PM
adds no download loop or readiness polling. Timing and native execution are
unmeasured. Source inspection is the selected verification boundary; no local
tests, checks, native execution or validation builds were run for this module.

Image editing does not guarantee face identity, alpha, source dimensions or
exact prompt adherence. Runtime/model setup belongs to application composition
and the published SDK under the active dependency authority. This controller
performs no setup. An ordinary browser without Core preserves
the unavailable image state and does not disable other PM functionality.
