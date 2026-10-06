# Task faces

`createTaskFaceController({imageRuntime, data, getStorage = data.getStorage, signal})`
uses the published SDK image accessor and PM's single shared DBOPFS connection.
It owns PM candidate selection and saved task associations. It creates no image
engine, model store, downloader, provider adapter, or native working projection.

## Operations

- `generate({taskId, model, prompt, parameters?, signal?})` returns
  `{result, candidates}` after actual SDK generation. `result` is the complete
  SDK result. Each candidate exposes `id`, `taskId`, `operation`, `model`,
  `prompt`, `parameters`, `strength`, `blob`, `mediaType`, `name`, `width`, `height`,
  `createdAt`, and `chosen`.
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
  `data.setTaskFace(taskId, candidateId)`. It returns `{faceId, metadata, task}`.
- `read(faceId, {signal?} = {})` returns `{blob, metadata, originalBlob}` or
  `null` when no face metadata exists. `originalBlob` is `null` for generation.
- `current()` exposes transient `status`, `message`, `progress`, active
  `operation`/`taskId`, model availability, complete candidate records,
  `choosingTaskIds`, and `disposed`.
- `subscribe(listener, {signal?} = {})` synchronously replays current state,
  then observes changes, returning an unsubscribe function.
- `cancel()` aborts inference or a pending readiness wait. `dispose()` aborts
  owned work, removes subscriptions, joins pending inference/selection work,
  and releases transient candidates. The injected shared image accessor and
  loaded model remain under their composition owner's lifecycle.

An accepted inference publishes transient `Thinking` synchronously, before any
storage or model wait. Requests wait for the exact selected model to be loaded
and `ready`; an unavailable/failed runtime reports an error. Loading remains an
ordinary waiting state. Replacement, unloading, cancellation and controller
disposal suppress late candidates. Actual native sampling progress remains
progress; no intermediate image or conversation output is fabricated.

The controller retains all completed candidates during its lifetime. Generating,
editing and cancelling leave the task association unchanged. A saved face
changes only after `choose()` finishes the data-owner association write. Failure
before that write preserves the current association and the candidate for
retry. Already accepted storage writes may complete after cancellation; saved
unassociated assets remain available, and no automatic rollback or deletion
touches previous faces. An association write already accepted by the data owner
returns its actual outcome even if cancellation arrives during that write.

One task permits one selection write at a time in this controller; independent
tasks save concurrently. Another inference supersedes the active inference.
Complete images are written using `writeFile('pm_face_images', filename, blob)`;
metadata uses `set('pm_faces', faceId + '.json', metadata)`. Metadata and complete
prompts are separate from image content. Reads use `readFile`, preserving the
complete image without decoding, resizing, compositing, or re-encoding it.
`read()` restores the saved media type on the returned Blob while preserving
the complete file content.

Events use `createArcaneEventSource` with source `arcane-pm.faces` and semantic
event `arcane-pm.faces.state`. Concise ordinary status is separate from complete
rejected errors and developer-console diagnostics. No durable chat history,
tool protocol, request envelope, or model output log is created.

## Capability and evidence boundary

PM needs persistent recognizable task associations with a deliberate candidate
choice. This workflow and its records are PM domain behavior. Neutral image
inference, PNG transport, model lifecycle, native cancellation and DBOPFS I/O
reuse their published SDK owners. Presentation remains with the local-AI view
and the application's shared theme; this module adds no visual styles.

One inference request runs once and retains its actual returned images. One
choice writes one candidate, optionally one original, one metadata record and
one task association. SDK context ownership controls native contention; PM
adds no download loop or readiness polling. Timing and native execution are
unmeasured. Source inspection is the selected verification boundary; no local
tests, checks, native execution or validation builds were run for this module.

Image editing does not guarantee face identity, alpha, source dimensions or
exact prompt adherence. Optional models/runtimes require their own explicit
selection and dependency authority. An ordinary browser without Core preserves
the unavailable image state and does not disable other PM functionality.
