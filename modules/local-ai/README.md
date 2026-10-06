# Arcane PM preparation and avatars

PM owns preparation purpose, domain records and task/project avatar selection.
The published Arcane SDK owns inference, provider requests, model lifecycle,
downloads, storage mechanisms and temporary native working projections.

## Composition

Import from `modules/local-ai/index.js`:

```js
const services = createPMPreparationServices(
    {getStorage, pmData, signal}
);
const {modelServices, localAI, faces, initialAvatars, decisions} = services;
const view = mountLocalAIView(
    container,
    {modelServices, localAI, faces, decisions, pmData, projectId, signal}
);
```

`getStorage` and `pmData` come from `modules/data/index.js`. Every domain uses
that same ready DBOPFS connection. Construct services once. A view owns its
request signals and subscriptions. Application disposal joins preparation/face
cleanup before closing SDK accessors owned by this composition. The lower-level
exports include `createPMModelServices`, `createLocalPreparationController`,
`createPreparationRequestSlot`, `createInitialAvatarPreparation` and
`createPMDecisionController`.

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
backend and `sd14` model descriptor. The SDK's normal development composition
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

Existing saved faces are reused. A new request waits for the selected local-only
text model and selected image model to be both ready and loaded, without choosing,
loading or downloading either model. The complete original task title,
assignment and project description, or project name and description, reach the
text owner in separate messages. Task preparation resolves the app's lazy
`getSources()` owner only at source consumption. Native-associated tasks await
their conversation import before `readTaskSources(taskId, {kind: 'conversation',
signal})`; ordinary cards and model setup render independently. Every retained
conversation message keeps its complete original content and source role in the
source owner's returned order. Incomplete or unavailable conversation reads
surface a source error and retain full developer diagnostics instead of sending
partial source text. An empty retained scope describes that scope only; native
import coverage remains a separate result. A native task missing its account,
host or thread association exposes a reconnect action before preparation.
App-owned system instructions follow the supplied light and dark references:
distinctive illustrated adult human workers and a project guide, with friendly
expressive faces, individual hairstyles, softly shaded forms and centered
head-and-shoulder composition suited to a round crop. The actual work informs
their character, clothing and one subtle accessory. Deep teal, warm ivory,
muted gold and restrained lavender appear within the clothing and background.
The instructions specify drawn contours, simplified facial planes, stylized
eyes and one finished portrait. Initial generation also supplies the native
image owner's separate `negative_prompt` parameter to discourage photography,
lettering, labels and palette charts. These are generation instructions;
visual comparison with the approved references establishes the actual result.
The complete actual response becomes the image prompt through the published
image owner. No authored source is rewritten or wrapped into that prompt.

The text stage uses `persist: false`, no tools and background request priority.
Its temporary inputs and generated description are released after the operation;
they are not saved in face metadata, history or later model context. The image,
its subject association and ordinary generation metadata are the durable output.
Initial-avatar status retains no prompt or model response.

At most four task descriptions acquire complete conversation sources at once.
Additional tasks expose their queued preparation state and remain cancellable.
Each slot spans import, full retained-source reading and text consumption, then
releases its conversation references before independent image generation. The
separate text-request slot retains foreground priority; page rendering and
project image work do not wait on the task-source queue.

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
tasks once per batch. An unknown prior-content comparison also invalidates the
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
  `imageLoad` contains `{modelId,phase,busy,error}`; its phases are `idle`,
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

Foundation owns installation, import maps and the shared preview. Initial
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
Local Jev chat, agent behavior and native FP32 execution have not been
established by this PM review.

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

## Native next-step comparison

`services.decisions` is the app-owned
`createPMDecisionController({modelServices, signal, client})`. Its explicit
comparison is independent of the text preparation and face-generation requests.
It scores complete caller-supplied alternatives; it does not generate a
conversation, choose tools for user messages, or change task status.

- `current()` and replaying `subscribe(listener, {signal})` expose operation,
  model and loading state without retaining comparison inputs or results.
- `load({offline = true, signal})` prepares Laya's FP32 model and tokenizer
  through the existing SDK model store and temporary native projection owner.
  The view's explicit Load action permits acquisition of missing resources.
  Once accepted, loading belongs to the app and continues across page navigation.
- `evaluate({taskId, rows, runOptions, signal, onDiagnostic})` publishes `Thinking`
  synchronously, waits for this exact selected model to be ready and loaded,
  and forwards complete rows unchanged. It observes Core and model lifecycle
  until the result commits. The returned `{decisions, outputs}` is the complete
  native RPC result; the SDK owns its tensor transport encoding.
- `cancel()` cancels the one active comparison. Cancellation during inference
  follows the native SDK's activation-wide cancellation. Cancelling a readiness
  wait leaves an independent model load running.
- `unload({signal})` and `dispose()` join native cleanup and pending work.
  A supplied Core client remains fixed; otherwise the controller follows the
  published Core installation owner and cancels work when its client retires.

PM selects `onnx-community/laya-typed-decisions-ONNX`, revision `main`, dtype
`fp32`, using the published members `onnx/model.onnx`, adjacent
`onnx/model.onnx_data`, `tokenizer.json` and `tokenizer_config.json`. The SDK
stores the complete assets in the shared DBOPFS model cache. Its native owner
retains the projection while loaded; the browser releases its preparation
ownership after native loading settles. Cached-only preparation is the API
default. A working offline comparison also requires the installed native
runtime and those complete cached assets; source integration alone does not
establish that runtime outcome.

Foundation owns `native/decision-service.mjs` and its descriptor registration.
The browser consumes `pm.decisions.status`, `pm.decisions.load` with the actual
`assetProjectionId`, `pm.decisions.evaluate` with `{rows, runOptions?}`, and
`pm.decisions.unload`. It subscribes to `pm.decisions.state` before reading
status after Core readiness. The native adapter delegates inference and complete
RPC output encoding to the published `arcane-os/core/decisions` service.

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
This increment provides an explicit local comparison. The broader local
conversation and agent outcomes retain their separate acceptance boundaries.

## Historical browser decision capability review

The following records the earlier `0.64.0` browser API review. PM now composes
the native comparison above; it does not use this browser backend. No decision
runtime or model was loaded during that earlier review.

The governing PM outcome remains offline local Jev/local LLM preparation with
application model assets in DBOPFS. This browser API's upstream cache does not
establish that offline storage contract, so its existence does not complete
the outcome. The subsequent native increment uses the published FP32 path and
the shared DBOPFS model owner. No browser backend redesign, optional
runtime/model download or new dependency was selected by this mapping.

The published entry point is
`import {createBrowserDecisionModel} from 'arcane-os/ai/browser-decisions'`.
Construction accepts `{family, model, revision, device, runtime}`. The
documented selections are `family: 'laya'` with
`model: 'onnx-community/laya-typed-decisions-ONNX'` (FP16), or
`family: 'julia'` with `model: 'SupersonicLabs/Julia-1-ONNX'` (FP32).
`revision` defaults to `main` and `device` to `webgpu`. A compatible alternative
backend must be explicitly selected; the SDK does not substitute a backend,
precision or model automatically. Julia FP32 here describes the browser graph
selection, not an established native Core integration or execution result.

| PM operation | Applicable contract and current boundary |
| --- | --- |
| Evaluate explicit next-step choices against complete task state | Browser `evaluate(rows, {signal})` can score caller-owned choices. Each row supplies complete `state`, `question`, `options` and optional `type`. PM's implemented comparison instead uses the native controller documented above. |
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
use and waits for it before sending rows for inference. A future PM operation
must publish its visible `Thinking` state synchronously and observe this exact
client's model/lifecycle without delaying the application shell.

Abort, `unload()` or `dispose()` terminates that client's dedicated Worker and
rejects every outstanding operation on it. Cancellation is client-wide;
independent cancellation requires separate clients. Unload permits later
reactivation; disposal is terminal. Concurrent operations share activation,
while the selected backend owns execution ordering. A replaced activation
ignores old Worker replies. Technical errors remain in developer diagnostics.

Import and construction start no Worker or download. Explicit `load` or
`evaluate` uses the upstream runtime, tokenizer and weights with normal browser
loading/caching. The default runtime is Transformers.js `4.3.0` at its published
CDN module. This API does not expose the cached-only `offline: true` option
used by PM's browser text model store; existing cache alone is not an offline
availability guarantee. No additional model/runtime download or execution was
selected here.

This mapping is based on the installed published `0.64.0` documentation and
client source, following the SDK coordinator's inventory correction. No PM
model loading, browser FP16/FP32 inference, numerical parity, native execution,
or model cancellation was run. The SDK coordinator also reports no additional
actual Laya/Julia browser, native or PM execution evidence. Static lifecycle
source review does not establish those execution outcomes.

Public references: [browser typed decisions](https://cdn.jsdelivr.net/npm/arcane-os@0.64.0/docs/reference/ai/browser-decisions.md),
[published decision client](https://cdn.jsdelivr.net/npm/arcane-os@0.64.0/browser-runtime/ai/browser-decisions.mjs),
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
browser verification are reported separately.

## Browser evidence for this increment

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
