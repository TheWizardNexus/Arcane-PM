# Arcane PM preparation and avatars

PM owns preparation purpose, domain records and task/project avatar selection.
The published Arcane SDK owns inference, provider requests, model lifecycle,
downloads, storage mechanisms and temporary native working projections.

## Composition

Import from `modules/local-ai/index.js`:

```js
const services = createPMPreparationServices(
    {getStorage, pmData, getSources, getWorkflows, signal}
);
const {modelServices, localAI, faces, initialAvatars, decisions, speech} = services;
const view = mountLocalAIView(
    container,
    {modelServices, localAI, faces, decisions, speech, pmData, projectId, signal}
);
```

`getStorage` and `pmData` come from `modules/data/index.js`. Every domain uses
that same ready DBOPFS connection. Construct services once. A view owns its
request signals and subscriptions. Application disposal joins preparation/face
cleanup before closing SDK accessors owned by this composition. The lower-level
exports include `createPMModelServices`, `createLocalPreparationController`,
`createPreparationRequestSlot`, `createInitialAvatarPreparation` and
`createPMDecisionController` and `createPMSpeechController`.

`getSources()` and `getWorkflows()` lazily resolve the application's existing
SourceLibrary and WorkflowService. They do not create additional stores or
block rendering. Initial portraits read the complete current task work,
ordered workflow history and retained original sources through those owners.
Project guides include all member tasks and direct project sources. Every
original text remains a separate unchanged model message; field descriptions
remain in application-authored control messages. Temporary preparation inputs
and responses are released after their operation.

## Language model selection and preparation

`modelServices.catalog()` includes these published local Ollama choices:

| Choice | Exact model identifier |
| --- | --- |
| Granite 4.2 3B, Q4_K_M | `granite4.2:3b-q4_K_M` |
| Granite 4.2 8B, Q4_K_M | `granite4.2:8b-q4_K_M` |
| Granite 4.2 30B, Q4_K_M | `granite4.2:30b-q4_K_M` |
| GPT-OSS 20B, MXFP4 | `gpt-oss:20b` |
| Meta Muse Glimmer 30B, Q4_K_M | `muse-glimmer:30b-q4_K_M` |

The identifiers and quantizations come from the published
[Granite catalog](https://ollama.com/library/granite4.2/tags),
[GPT-OSS model](https://ollama.com/library/gpt-oss:20b), and
[Meta Muse Glimmer model](https://ollama.com/library/muse-glimmer:30b-q4_K_M).
The existing browser Granite 4.1 3B choice and discovered installed models
remain available. Catalog presence describes the selected public provider
route; it is not evidence of inference or memory fit on a particular machine.

`select({providerId, modelId})` stores the nonsecret language model choice in
`pm_local_ai_settings/language-model.json`. `ready()` reads that preference
without loading a model; `current().preferredModel`, `preferenceState` and
`preferenceError` expose the result. A later explicit selection wins over an
earlier pending read. Custom browser source URLs remain supplied through the
existing explicit browser-source flow; this preference stores model identity.

`load({offline: false, signal})` acquires only the selected missing catalog
model through the SDK's public `ollama.pull` boundary, then loads it through
the existing local provider. An offline load of an uncached choice reports
that the first download is required. Selection alone never downloads every
catalog entry. The SDK-owned native runtime stays with the application's
existing descriptor and host lifecycle.

`current().model.progress` preserves the provider's progress. Browser model
downloads report actual file totals and member shard totals. During an Ollama
pull, `progressKind` is `ollama`, `progressPhase` is `download`, and `progress`
is the original upstream chunk. Its `completed` and `total` describe the current
layer, not an invented whole-model percentage. `imageLoad.progress` forwards
the SDK's model acquisition/projection progress; image loading is a separate
phase. Missing denominators remain indeterminate.

`prepareAvatarModels({signal})` starts shared text and image preparation
concurrently after a first-render portrait request. It uses the saved/current
local selection, or the existing browser Granite default when none exists,
and the selected image model or SDXL base when none exists. A remote text
selection produces an explicit local-model requirement. Cancelling one
portrait stops that observer; application disposal owns shared model cleanup.
Saved faces return before this preparation begins. Exact model readiness and
continued lifecycle observation remain required at inference.

## Local Kokoro speech

`services.speech` owns a direct SDK `createBrowserKokoroProvider` independently
of language-model selection. Its model is
`onnx-community/Kokoro-82M-v1.0-ONNX`, FP32, with the published Kokoro JavaScript
adapter and WASM execution. The app selects `af_heart` as its initial voice.
The SDK owns model, voice and runtime acquisition through the shared DBOPFS
speech artifact store. Construction and selection of a language model do not
start speech preparation or audio playback.

- `current()` and replaying `subscribe(listener, {signal})` expose actual
  lifecycle state, readiness, progress, the app-supplied voice catalog, errors
  and execution metadata.
- `load({signal})` explicitly prepares the local voice and reuses saved SDK
  resources. Its complete upstream resource closure can require acquisition;
  this API makes no offline-enforcement claim.
- `synthesize({text, voice, speed = 1, signal})` immediately publishes
  `Thinking`, waits for the selected loaded voice and forwards the complete
  original text with `textFormat: 'plain'`. It returns a complete WAV Blob.
- `cancel()`, `unload({signal})` and `dispose()` own cancellation and cleanup.
  Temporary input is released after synthesis. The controller retains no
  speech text, returned audio or conversation history.

Playback is a separate explicit UI action through the shared SDK playback
owner. The app's text-provider transitions cannot unload this independent
speech provider. Source composition and catalog presence do not establish a
successful local synthesis or playback on an unobserved host.
The declared voice is Heart (`af_heart`, `en-US`). The SDK preserves this
display record in its synchronous catalog; loading does not discover a larger
voice inventory.

The preparation view reads its task list once on mount or explicit refresh.
Committed Data events update the supplied complete row in its keyed task list
and update only the affected option, preserving creation-time and ID ordering.
Events received during a list read take precedence over that read's results.
Activity-only updates perform no storage read or selector rebuild. A selected
task's title or face change refreshes its face; removal or movement outside the
selected project clears that selection and refreshes its notes. Complete task
content and deliberately saved faces remain with their existing owners.

The authored descriptor selects Ollama and `stable-diffusion.cpp` under
`native.localAI`. The latter uses the published `master-929-3f8527a`, `auto`
backend and the `sd14` and `sdxl-base-1.0` model descriptors. SDXL's published
profile supplies a 1024-by-1024 canvas for text-to-image generation. Its complete
official checkpoint is acquired through the same SDK model-store workflow;
selecting it preserves SD14's available descriptor and previously saved faces.
The SDK's normal development composition
owns the local service, image service, model projection service and asynchronous
runtime preparation. Foundation owns descriptor composition and the shared
development server lifecycle. The former PM service wrapper is superseded by
that public SDK composition; registering both would duplicate `local-ai`.

An externally owned daemon can report `installed: false` and `available: true`
because PM supplied no executable. Readiness follows the actual provider state,
not that installation field. If the daemon was absent when the service started,
the published `localai.services.recover({runtimes: ['ollama']})` operation owns
an explicit reconnection attempt; reading status alone does not restart it.

## Preparation

`createLocalPreparationController({modelServices, getStorage, tools = [],
executeTool, acquireRequest, requestPriority = 'user', signal})` returns one PM
preparation controller.

- `prepare({taskId, messages, persist = false, userTurn, onChunk, onToolResult,
  onDiagnostic, expectedSelection, signal})` passes complete authored messages to the SDK.
  It synchronously publishes `Thinking`, observes the exact selected provider
  and model's ready/loaded state, and returns `{content, response, toolResults,
  savedId}`. Another preparation supersedes its current request.
  Internal callers may supply `expectedSelection: {providerId, modelId, localOnly}`
  to bind the intended model at synchronous acceptance; a later change cancels
  the request before another route can consume it.
- `onChunk(text)` receives real visible fragments in order. No empty assistant
  turn or fabricated text appears while waiting.
- `current()` returns operation metadata and concise status, with no retained
  prompt, response or tool protocol. `subscribe(listener, {signal})` replays
  that state and returns an unsubscribe function.
- `cancel()` aborts the request and readiness wait. `dispose()` also releases
  subscriptions and joins owned work.
- `saveNote({taskId, content, signal})` deliberately saves a complete authored
  note and returns `{id, taskId, content, createdAt}`. `listNotes({taskId,signal})`
  reads the complete saved notes. These are separate PM notes, not chat history.

The complete configured tool set is offered with automatic model selection
for every user-authored turn. The SDK emits complete structural calls. The
injected `executeTool(call, {signal})` invokes the actual owning tool and returns
its public `{status, message}` alongside its actual operation result. Calls are
never invented or rewritten. Each real tool failure is observable without
suppressing sibling calls. This controller adds no corrective retry or automatic
tool continuation; a tool-enabled workflow owns its continuation and outcomes.

`response` and `toolResults` preserve the complete active operation result for
the caller. Raw protocol belongs only in an explicitly selected inspection
surface. Ordinary UI consumes visible text and useful public status.
`onDiagnostic` observes complete request/response/error data without retaining
it in this controller or saved history.

`persist: false` never writes prompt/result history or feeds it into later
model context. The caller may display the active result while preparing a note.
The view clears its temporary surface on replacement or disposal. Explicitly
saving a chosen or edited note is a separate user action.

`persist: true` writes one `pm_preparations/<id>.json` record through the shared
DBOPFS owner, with task association, real operation timestamps and narrow
visible records. Optional `userTurn` is the actual current `{content,timestamp}`.
Selected sources and internal instructions stay with their existing owners.
Only complete nonblank assistant content and real public tool messages are
saved. No cancelled/failed assistant output, system prompt, argument object,
provider envelope, reasoning, raw call or transient status is saved. No automatic
memory extraction or history replay occurs. Manual notes use the separate
`pm_preparation_notes` table and preserve their complete content.

Cancellation stops new persistence. An OPFS write already accepted by its
storage owner may finish after cancellation; cancellation does not roll it back.
Actual tool settlements likewise remain available to the operation's diagnostic
callback even when cancelled conversation continuation is suppressed.

Composition supplies one `createPreparationRequestSlot({signal})` owner to
manual preparation and background avatar prompt preparation. Its
`acquire({signal, priority = 'user'})` resolves an idempotent release function.
The SDK's current text request owner accepts one active request, so waiting
requests share that exact contention boundary. User work goes ahead of queued
background work; each priority retains arrival order. Active work finishes or
cancels through its normal SDK lifecycle. A queued cancellation removes only
that request. Release follows SDK request and actual tool settlement, before
unrelated persistence; it does not assert native inference has physically ended.
`dispose()` rejects queued work while the active owner retains responsibility
for releasing its slot. Cards and model loading continue independently.

## First avatars from work content

`services.initialAvatars` prepares first avatars for both tasks and projects:

- `ensureTask(taskId, {signal, retry = false})` and
  `ensureProject(projectId, {signal, retry = false})` resolve the final transient
  status. They synchronously publish pending state and proceed in the background.
- `current()` and replaying `subscribe(listener, {signal})` expose
  `{statuses: [{subjectType, subjectId, status, message, faceId}], closed}`.
  Live updates add `incremental: true` and include only changed subjects;
  initial replay and `current()` return the complete current status set.
  Accepted work starts with `Thinking`, waits in `pending` for models, and
  forwards actual image-owner `generating` and `saving` phases for its subject.
- `cancelTask(id)` and `cancelProject(id)` cancel only the named subject.
  `dispose()` joins its owned operations and clears transient state.

Existing saved faces are reused. A new request starts shared local model
preparation, then waits for the selected local-only text model and image model
to be both ready and loaded. The complete original task title,
assignment and project description, or project name and description, reach the
text owner in separate messages. Preparation resolves the app's lazy
`getSources()` and `getWorkflows()` owners only at work consumption.
Native-associated tasks await their conversation import before
`readTaskSources(taskId, {signal})`; every retained source kind remains in scope.
Ordinary cards and model setup render independently. Every retained
conversation message keeps its complete original content and source role in the
source owner's returned order. Native import's `coverage.textComplete` describes
complete retained conversation text independently of unavailable attachments.
Portrait preparation can use that complete text while attachment notices retain
their complete original references and coverage in developer diagnostics, outside
model messages. This does not claim the text model read those attachments.
Native read or partial-history failures and retained-text/source-read failures
still surface a source error with full diagnostics. An empty retained scope
describes that scope only; native import coverage remains a separate result.
A native task missing its account,
host or thread association exposes a reconnect action before preparation.
App-owned system instructions ask for an original, concrete image-generation
description of an illustrated adult worker or project guide. The guidance focuses
on visible individual facial features, complexion, hair and one small accessory
inspired by the work, without biography, symbolic explanation or body-pose
narrative. The supplied light and dark references guide a centered, viewer-facing
portrait with complete hair, a small margin and only shoulder tops visible,
simplified illustration, soft matte dimensional shading and a relaxed friendly
expression. A deep teal collar and restrained muted gold detail accompany a plain
pale mint or lavender background. The application owns the circular presentation.
Initial generation also supplies the native
image owner's separate `negative_prompt` parameter to discourage photography,
lettering, labels, palette charts, long torso and hand compositions, decorative
scenery and crowns, and monochrome etched rendering. These are generation
instructions; visual comparison with the approved references establishes the actual result.
The complete actual response becomes the image prompt through the published
image owner. No authored source is rewritten or wrapped into that prompt.

The text stage uses `persist: false`, no tools and background request priority.
Its temporary inputs and generated description are released after the operation;
they are not saved in face metadata, history or later model context. The image,
its subject association and ordinary generation metadata are the durable output.
Initial-avatar status retains no prompt or model response.

At most four avatar descriptions acquire complete work sources at once.
Additional requests expose their queued preparation state and remain cancellable.
Each slot spans workflow reading, import, full retained-source reading and text
consumption, then releases its source references before independent image
generation. The separate text-request slot retains foreground priority; page
rendering remains independent. Project member acquisition uses complete ordered
batches, retaining every member. Associated binary sources without readable
text report the actual text-model incompatibility. Arbitrary result references,
cross-task source references and working-folder contents are not resolved by
this associated-source contract.

The Data owner's `authoredFieldRevisions` identify actual authored scalar
changes after temporary source text is released. Private preparation status
retains only the relevant counters: project name and description; task title,
assignment and project association; and the associated project's description.
Absent counters start at zero. Committed local and cross-document records
advance observed metadata before invalidating affected faceless work, so
repeated notifications, unchanged saves, activity and face updates do not
restart failed or cancelled preparation. Saved faces remain chosen. Native
origin and conversation changes keep their separate existing comparisons.
Only revision-aware Data writes advance these counters; older open writers or
direct storage changes cannot establish a settled text change through them.
Committed Sources content or association changes invalidate affected faceless
tasks and projects once per batch. Member-task work and workflow changes also
invalidate affected active project descriptions. An unknown prior-content comparison invalidates the
affected work without claiming the content changed. Saved images remain chosen.
Explicit `retry: true` or a genuine source change permits another attempt while
the subject remains faceless. Model replacement, loss of readiness, source
changes and deletion cancel stale operations. A saved face always wins over
late automatic work through the data owner's conditional association methods.
The image runtime owns contention within its native context; PM adds no image
queue or readiness polling.

## Models

`createPMModelServices({getStorage, signal, client})` returns synchronously:

- `current()` / `getStatus()` -> `{model,catalog,core,imageLoad,closed}`. `model` is null
  or `{providerId,modelId,localOnly,state,loaded,busy,progress,error}`.
  `imageLoad` contains `{modelId,phase,busy,progress,error}`; its phases are `idle`,
  `preparing`, `loading`, `ready`, `cancelled` and `error`.
- `subscribe(listener,{signal})` replays the same snapshot.
- `inspect({signal})` refreshes the available public Core catalog.
- `catalog()` returns provider groups and their actual model records.
- `select({providerId,modelId,source,twinKey},{signal})` explicitly chooses a
  route. `load({offline = true,signal})` and `unload({signal})` are separate operations.
- `getAI()` returns the current SDK provider-neutral request owner.
- `getModelStore()` lazily composes the SDK model store over shared DBOPFS.
- `getImageRuntime()` returns the SDK accessor, including an honest unavailable
  state in a browser without Core. `getONNXRuntime()` exposes the SDK's tensor
  accessor, not a PM text pipeline.
- `loadImage({model,offline = true,signal})` loads an explicit SDK image-catalog
  model, preparing its complete configured resources through the model store
  and releasing its temporary projection after native loading settles. The
  app owner retains its operation, progress and error through page navigation.
- `prepareModelAssets({source,members,workingDirectory,offline = true,signal,onProgress})`
  prepares SDK-owned temporary native projections from complete cached assets
  or supplied complete Blob members. An explicit `offline: false` permits the
  SDK model store to acquire a selected missing resource into the shared DBOPFS
  cache. The image model Load action uses that path for configured SDK resources.
  Each `source.files[]` member uses a single cache `name` and its complete upstream
  `url`; an optional PM-owned `path` selects the native relative projection path.
  Without `path`, projection uses the SDK-normalized filename. Complete stored
  files retain the source descriptor's order through that mapping.
  The caller uses `releaseModelAssets(projection)` after the native owner takes
  its retain during load. That paired method also releases this owner's retained
  projection reference. `prepareImageAssets` remains an alias for existing callers.
- `dispose()` joins owned cleanup and releases SDK accessors/projections.

Model loading belongs to the app's model owner. Leaving the local preparation
page releases its controls and subscriptions while an accepted load continues.
Reopening the page reads the owner's current operation and model state. Model
replacement, explicit cancellation and app disposal retain their existing
cancellation boundaries. Page-specific preparation drafts and face candidates
keep their separate page lifetime.

The local catalog includes Granite 4.1 3B Q4_K_M (`granite-3b`) using
[IBM's official complete GGUF](https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/tree/main).
Its app-owned descriptor declares the single original
`granite-4.1-3b-Q4_K_M.gguf` resource. Model data is acquired through the published
SDK model store; it is not shipped in PM source. Selection starts no download or
inference and preserves other native, remote and custom browser choices.

Browser text loading uses complete `id` and `files:[{name,url}]` descriptors and
the SDK's packaged Wllama runtime on CPU. The explicit Load action supplies
`offline: false` to acquire missing files into the same app DBOPFS store;
the service API otherwise defaults to cached-only loading. Existing complete
files are reused. No file importer, model conversion, splitting or alternative
fetch path is added. Image original selection is independent of this source
contract. Actual download, loading and inference remain distinct from static
source-format compatibility.

The published `0.67.0` image and ONNX accessors follow Core installation and
retirement when their client is unspecified. PM leaves that default selection
with the SDK, so the existing accessor can attach after Core becomes available.
A non-null client explicitly supplied to `createPMModelServices` remains fixed.
The SDK owns retirement cancellation and excludes late state and results from
the replaced client. See the [published image lifecycle](https://github.com/TheWizardNexus/arcane-os-sdk/blob/0.67.0/docs/reference/local-image-generation.md).
Runtime installation, checkpoint preparation, native loading and actual
generation remain separate observed states. Imported originals and deliberate
face selection continue through their existing storage owner.

## Faces

`createTaskFaceController({imageRuntime,data,getStorage,signal})` is exported
from `modules/faces/index.js` and composed as `services.faces`.

- `generate({taskId,model,prompt,parameters,signal})` produces candidates.
- `edit({taskId,model,image,prompt,strength,parameters,signal})` sends a complete
  supported PNG and explicit strength to the SDK. The original remains intact.
- `importCandidate({taskId,image,prompt = '',signal})` accepts a deliberately
  selected complete Blob/File unchanged, without requiring a model.
- `choose(candidateId,{signal})` saves the complete image and separate metadata,
  then changes its task association through the data owner.
- `read(faceId,{signal})` returns `{blob,metadata,originalBlob}` or null.
  The displaying view owns and revokes its temporary object URL.
- `current`, `subscribe`, `cancel` and `dispose` expose the candidate workflow.

Generation, editing and import retain the current face until deliberate choice
succeeds. [The face contract](../faces/README.md) details storage and partial
write outcomes. Editing makes no promise of identity, alpha, source dimensions
or exact prompt adherence.

## Published SDK and delivery boundaries

Foundation owns installation, import maps and the selected native build. Initial
implementation and browser evidence used `arcane-os@0.62.0`; the decision-model
mapping below was inspected at `0.64.0`. The selected Ollama integration consumes
the published `0.65.0` contract. The development declaration tracks `latest`
through the foundation owner.
Browser-WASM, Core llama.cpp and the built-in Ollama provider expose local text
routes. Ollama capability/catalog presence alone is not proof of an actually
loaded model. PM consumes the SDK provider's selected ready/loaded lifecycle;
the SDK owns preload, resident-model name comparison, observed readiness loss,
and cancellation through Core. It checks residency before inference and before
accepting the terminal result while forwarding actual stream chunks immediately.
Outbound model names and complete prompts remain unchanged.

Ollama supplies resident snapshots rather than an ongoing external-eviction
subscription. The SDK adds no periodic polling and makes no atomic-residency
promise. PM's preparation controller retains its exact selection observer
through the request, cancels on selection or readiness loss, and publishes
`Thinking` before its first wait. See the published
[selected Ollama readiness contract](https://github.com/TheWizardNexus/arcane-os-sdk/blob/0.65.0/docs/reference/local-ai.md#selected-ollama-model-readiness).

An earlier API inventory omitted the published browser typed-decision pipeline.
`createBrowserDecisionModel` supports Laya/Julia state/question/options
evaluation. Preserve that existing capability when describing local decision
support. Generic ONNX tensor sessions, browser typed decisions, conversational
text/tool requests and remote Jev/System One are separate public contracts.
PM's selected local JEV models are Laya FP16 and Julia 1 FP32. Typed decisions
score supplied choices; conversational preparation uses the language model.

Optional DigitalOcean serverless inference uses the published `TWIN` provider's
endpoint, model and access-key settings. Its explicit selection meets the
optional remote requirement; it is never an automatic fallback. Importing
these modules sends no paid request. Arbitrary endpoint override is outside
this increment.

Image execution uses `arcane-os/ai/core-image`; native working members use
`arcane-os/ai/core-model-assets`. SDK `createDbopfsModelStore` receives the
existing DBOPFS connection. Installation, stored assets, projections, loading
and inference remain separate operations. Optional native dependencies and
model downloads were unselected during the earlier capability review. The
subsequent avatar setup selects the SDK-owned Stable Diffusion runtime and
`sd14` checkpoint through those same public owners; actual execution evidence
is reported separately.

Ordinary task browsing, local text search and manual preparation remain usable
without Core or loaded models. Source integration is distinct from actual
native inference and provider availability on an individual device.

## Local next-step comparison

`services.decisions` is the app-owned
`createPMDecisionController({modelServices, signal, client})`. Its explicit
comparison is independent of the text preparation and face-generation requests.
It scores complete caller-supplied alternatives; it does not generate a
conversation, choose tools for user messages, or change task status.

- `current()` and replaying `subscribe(listener, {signal})` expose operation,
  model, selection, available choices and loading state without retaining
  comparison inputs or results.
- `choices()` returns browser Laya FP16 (`laya-fp16`, the initial selection),
  browser Julia 1 FP32 (`julia1-fp32`), native Laya FP32
  (`laya-native-fp32`), native Laya FP16 (`laya-native-fp16`) and native Julia 1
  FP32 (`julia1-native-fp32`). `select(choiceId, {signal})` cancels and joins work on
  the previous selected model, releases its owned activation and changes the
  selection without downloading. Accepted selection cleanup belongs to the app.
- `load({signal})` prepares the selected browser model through the published
  SDK decision client and the existing shared DBOPFS model store. Actual SDK
  progress passes through `current().load.progress` and model status unchanged.
  The browser API uses normal upstream acquisition and saved resources; an
  explicit `offline: true` request reports its missing cached-only capability.
  Each native choice uses `load({offline = true, signal})` through the model store
  and temporary native projection owner. The view's Load action supplies
  `offline: false` to permit resource acquisition. Loading remains app-owned
  across page navigation.
- `evaluate({taskId, rows, runOptions, signal, onDiagnostic})` publishes `Thinking`
  synchronously, waits for this exact selected model to be ready and loaded,
  and forwards complete rows unchanged. It observes the selected model's
  lifecycle until the result commits, including Core for the native route.
  Before inference, a snapshot for the previous native model or a pending
  activation keeps the comparison waiting. Selected-load failures remain
  observable; errors from a different retiring model do not become this
  selection's failure. An accepted retry's preparation and loading also keep
  waiting through its prior activation's error. Readiness loss or replacement after
  inference starts cancels that request.
  The returned `{decisions, outputs}` is the complete SDK result. Native
  `runOptions` remain supported on the native route; browser selection reports
  that unsupported option instead of discarding it.
- `cancel()` cancels the one active comparison. Cancellation during inference
  follows the selected SDK client's activation-wide cancellation. Cancelling a readiness
  wait leaves an independent model load running.
- `unload({signal})` and `dispose()` join selected-model cleanup and pending work.
  A supplied Core client remains fixed; otherwise the controller follows the
  published Core installation owner and cancels work when its client retires.

Native choices use the published `arcane-os@0.81.0` model-selection contract,
with revision `main` and the following complete source layouts:

| Native choice | Family and model | Dtype | Graph and adjacent companion |
| --- | --- | --- | --- |
| Laya FP32 | `laya`, `onnx-community/laya-typed-decisions-ONNX` | `fp32` | `onnx/model.onnx`, `onnx/model.onnx_data` |
| Laya FP16 | `laya`, `onnx-community/laya-typed-decisions-ONNX` | `fp16` | `onnx/model_fp16.onnx`, `onnx/model_fp16.onnx_data` |
| Julia 1 FP32 | `julia`, `SupersonicLabs/Julia-1-ONNX` | `fp32` | `model.onnx`, `model.onnx.data` |

Each choice also includes its repository's root `tokenizer.json` and
`tokenizer_config.json`. The SDK stores complete originals in the existing
shared DBOPFS model cache under their single filenames. PM retains native
companion paths in each cohesive choice descriptor and supplies those paths
with the complete stored files to the SDK projection. The chosen graph,
tokenizer and tokenizer configuration paths accompany the load request.

The SDK native activation retains the projection through worker cleanup; the
browser releases its preparation ownership after native loading settles.
Cached-only preparation remains the API default. A working offline comparison
also requires the installed native runtime and those complete cached assets.
This source integration establishes neither native model execution nor a
particular execution device; Foundation owns actual built-app acceptance.

Foundation owns `native/decision-service.mjs` and its descriptor registration.
The browser consumes `pm.decisions.status`, `pm.decisions.load` with the complete
`{family, model, revision, dtype, assetProjectionId, resourcePaths}` selection,
`pm.decisions.evaluate` with `{rows, runOptions?}`, and
`pm.decisions.unload`. It subscribes to `pm.decisions.state` before reading
status after Core readiness. The native adapter delegates inference and complete
RPC output encoding to the published `arcane-os/core/decisions` service.
The adapter requires a prepared projection and preserves the earlier
`{assetProjectionId}` call as Laya FP32 with its original graph and tokenizer
mapping. It forwards complete SDK snapshots, including `pendingActivation`,
and keeps evaluation waiting for an accepted load. SDK service cleanup owns
the activation; the PM service's outer lifetime still disposes that owner.

The view keeps state, question and each alternative in separate complete fields.
It displays the actual recommended alternative and every returned option score.
These scores are model preferences, not calibrated confidence or observed task
facts. “Use recommended step” copies the original selected alternative into the
existing note editor; the ordinary Save action remains deliberate. Inputs and
results are transient and clear on replacement or disposal. Complete technical
requests, responses and errors belong in developer diagnostics, outside saved
notes and history.

Public references: [native typed decisions](https://thewizardnexus.github.io/arcane-os-sdk/reference/native-decisions/)
and [model assets](https://thewizardnexus.github.io/arcane-os-sdk/reference/model-assets/).
The native selections above follow the
[published 0.81.0 contract](https://github.com/TheWizardNexus/arcane-os-sdk/blob/0.81.0/docs/reference/native-decisions.md).
This increment provides an explicit local comparison. The broader local
conversation and agent outcomes retain their separate acceptance boundaries.

## Published browser decision contract

PM composes the published `0.79.1` browser decision client with the same
DBOPFS model store returned by `modelServices.getModelStore()`. The SDK owns
model/runtime resource acquisition and inference. A chosen browser backend
does not depend on native Core readiness. Selection and construction start no
worker or download; the explicit load action prepares the model.

The published entry point is
`import {createBrowserDecisionModel} from 'arcane-os/ai/browser-decisions'`.
Construction accepts `{family, model, revision, device, dtype, store, runtime}`. The
documented selections are `family: 'laya'` with
`model: 'onnx-community/laya-typed-decisions-ONNX'` (FP16), or
`family: 'julia'` with `model: 'SupersonicLabs/Julia-1-ONNX'` (FP32).
`revision` defaults to `main` and `device` to `webgpu`. A compatible alternative
backend must be explicitly selected; the SDK does not substitute a backend,
precision or model automatically. These browser selections have their own
activation and lifecycle; the native choices described above use the separate
Core decision service. Execution evidence remains specific to the actual route.

| PM operation | Applicable contract and current boundary |
| --- | --- |
| Evaluate explicit next-step choices against complete task state | Browser `evaluate(rows, {signal})` scores caller-owned choices. Each row supplies complete `state`, `question`, `options` and optional `type`. PM routes to the explicitly selected browser or native client. |
| Draft a preparation note or make model-selected tool calls | Existing `localAI.prepare` uses the text request owner. Typed decisions score supplied options and do not generate chat text or emitted tool calls. |
| Evaluate state/questions through remote Jev/System One | `fetchSystemOneRequest` from `arcane-os/ai/twin-cloud` uses explicit `twinKey`, `model`, `state` and `questions` at the remote DigitalOcean endpoint. Its result is parsed JSON; it is not a local fallback. |

Each row uses string state/question and a nonempty string-array of options;
the `noul` type requires exactly two false/true choices. This is a row API,
not the remote keyed-question or OpenJev helper-object contract.
Rows and options remain in caller order. The SDK documents complete unchanged
strings at the tokenizer boundary, with required model encoding owned inside
the SDK. PM must preserve supplied task/source content and keep its question,
options and routing information in their separate fields. This mapping does
not authorize classifying user-authored chat to narrow its configured tools.

`evaluate` returns `{decisions, outputs}`. Each decision retains its original
row, option `logits`, raw-softmax `probabilities`, `answerIndex` and `value`.
For `choice`, `value` is the complete selected option; `score` is the weighted
zero-based option index; `noul` is option 1's probability for a two-option row.
Graph action outputs exist only when the selected graph actually returns them.
`outputs` retains complete named tensor data for explicit diagnostics. These
scores are not calibrated confidence or automatic PM policy, and the API
does not write chat history, memory or DBOPFS records.

`status()` exposes `{family, model, revision, device, dtype, state, loaded,
busy, activeRequests, progress, error}`. `subscribe(listener,
{emitCurrent: true, signal})` replays current state by default. States are
`unloaded`, `loading`, `ready`, `error` and `disposed`; `loaded` follows
the SDK's successful ready state. An explicit `load({signal})` prepares the
activation. `evaluate(rows, {signal})` also starts that activation on first
use and waits for it before sending rows for inference. PM publishes visible
`Thinking` synchronously and waits for explicit selected-model readiness before
calling evaluate. Its lifecycle observer remains active through the response;
the application shell continues independently.

Abort, `unload()` or `dispose()` terminates that client's dedicated Worker and
rejects every outstanding operation on it. Cancellation is client-wide;
independent cancellation requires separate clients. Unload permits later
reactivation; disposal is terminal. Concurrent operations share activation,
while the selected backend owns execution ordering. A replaced activation
ignores old Worker replies. Technical errors remain in developer diagnostics.

Import and construction start no Worker or download. Explicit `load` uses
the upstream runtime, tokenizer and weights through the supplied shared store.
The default runtime is Transformers.js `4.3.0` at its published
CDN module. This API does not expose the cached-only `offline: true` option
used by PM's browser text model store; existing cache alone is not an offline
availability guarantee.

This integration was reviewed against the installed published `0.79.1`
documentation and client source. The earlier `0.64.0` review established the
API inventory only. This source increment ran no model loading, browser
FP16/FP32 inference, numerical parity or model cancellation. Source integration
and those execution outcomes remain separate evidence boundaries.

Public references: [browser typed decisions](https://github.com/TheWizardNexus/arcane-os-sdk/blob/0.79.1/docs/reference/ai/browser-decisions.md),
[published decision client](https://github.com/TheWizardNexus/arcane-os-sdk/blob/0.79.1/browser-runtime/ai/browser-decisions.mjs),
and [remote System One](https://cdn.jsdelivr.net/npm/arcane-os@0.64.0/docs/reference/ai/twin-cloud.md#evaluate-caller-owned-state-with-system-one).

## Ownership and work cardinality

One controller owns one active preparation request. Independent task and project
work proceeds concurrently until it reaches the SDK's single text-request slot
or native image context. Each face operation retains every actual returned
image candidate. SDK context operations and per-subject association writes
serialize at their owners. Model assets reuse the SDK store; selected model
changes invalidate readiness.

PM source stays in `modules/local-ai/` and `modules/faces/`. It creates no engine,
downloader, model-store implementation, exporter, provider adapter, native
projection copy or competing event bus. UI uses the foundation's Arcane theme
layers. Source uses plain JavaScript and named callbacks. Native timing runs,
local tests/checks and validation builds are unselected. Source review and
actual built-app acceptance are reported separately. Application, model,
integration and visual acceptance use the actual built app with its Core and
existing profile through supported app-scoped controls. Browser-preview trials,
whole-desktop control and foreground input are outside this acceptance path.

## Historical browser evidence

The observations below predate the built-app acceptance requirement. They remain
historical evidence and do not establish acceptance of the packaged application.

On October 6, 2026, the local-AI owner used the shared source preview and a
disposable Moon gardener task. The actual browser displayed the no-model
state, saved a complete multiline manual note, imported a synthetic SVG as a
candidate, and saved that image only after deliberate choice. After page
reload, the saved image and complete note were read back through the interface.
The All projects task filter was corrected during this review. No native model,
model download, remote inference, local test suite or validation build ran.

After the published `0.65.0` existing-Ollama service composition, a fresh browser
opened the local-AI view and explicitly refreshed its catalog. The actual public
`Arcane.localAI.status()` response reported the configured Ollama endpoint ready
at `http://127.0.0.1:11434`, with `available: true`, `installed: false`,
`owned: false` and an empty model catalog. `Arcane.ollama.running()` returned
`{models: []}`. This establishes that endpoint's current catalog and residency;
it does not describe models elsewhere on the computer. The image service was
unconfigured and reported no `image.status` method. No model was selected,
loaded or executed during that browser read, and the owned browser tab was closed.
