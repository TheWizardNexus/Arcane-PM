# Arcane PM preparation and task faces

PM owns preparation purpose, domain records and deliberate task-face selection.
The published Arcane SDK owns inference, provider requests, model lifecycle,
downloads, storage mechanisms and temporary native working projections.

## Composition

Import from `modules/local-ai/index.js`:

```js
const services = createPMPreparationServices(
    {getStorage, pmData, signal}
);
const {modelServices, localAI, faces} = services;
const view = mountLocalAIView(
    container,
    {modelServices, localAI, faces, pmData, projectId, signal}
);
```

`getStorage` and `pmData` come from `modules/data/index.js`. Every domain uses
that same ready DBOPFS connection. Construct services once. A view owns its
request signals and subscriptions. Application disposal joins preparation/face
cleanup before closing SDK accessors owned by this composition. The lower-level
exports are `createPMModelServices` and `createLocalPreparationController`.

## Preparation

`createLocalPreparationController({modelServices, getStorage, tools = [],
executeTool, signal})` returns one PM preparation controller.

- `prepare({taskId, messages, persist = false, userTurn, onChunk, onToolResult,
  onDiagnostic, signal})` passes complete authored messages to the SDK.
  It synchronously publishes `Thinking`, observes the exact selected provider
  and model's ready/loaded state, and returns `{content, response, toolResults,
  savedId}`. Another preparation supersedes its current request.
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

## Models

`createPMModelServices({getStorage, signal, client})` returns synchronously:

- `current()` / `getStatus()` -> `{model,catalog,core,closed}`. `model` is null
  or `{providerId,modelId,localOnly,state,loaded,busy,progress,error}`.
- `subscribe(listener,{signal})` replays the same snapshot.
- `inspect({signal})` refreshes the available public Core catalog.
- `catalog()` returns provider groups and their actual model records.
- `select({providerId,modelId,source,twinKey},{signal})` explicitly chooses a
  route. `load({signal})` and `unload({signal})` are separate operations.
- `getAI()` returns the current SDK provider-neutral request owner.
- `getModelStore()` lazily composes the SDK model store over shared DBOPFS.
- `getImageRuntime()` returns the SDK accessor, including an honest unavailable
  state in a browser without Core. `getONNXRuntime()` exposes the SDK's tensor
  accessor, not a PM text pipeline.
- `prepareImageAssets({source,members,workingDirectory,signal,onProgress})`
  prepares SDK-owned temporary native projections from complete cached assets
  or supplied complete Blob members. The caller releases its returned
  projection after the native owner takes its retain during load.
- `dispose()` joins owned cleanup and releases SDK accessors/projections.

Browser text loading uses an explicit SDK source descriptor with complete
`id` and `files:[{name,url}]`, cached-only assets and CPU selection. No file
importer or alternative fetch path is invented for the published source API.
Image original selection is independent of this model-source contract.

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

Foundation owns installation, import maps and the shared preview. The package
selected for implementation is `arcane-os@0.62.0`; its development declaration
tracks `latest` through that owner. Browser-WASM and Core llama.cpp expose local
text routes. Ollama capability/catalog presence alone is not proof of an
actually loaded model. Published ONNX handles tensor sessions; a local Jev chat
pipeline has not been established from the inspected public contracts. The
located Jev operation is remote System One with state/questions input. Exact
contract questions were referred to the SDK owner through the PM manager.

Optional DigitalOcean serverless inference uses the published `TWIN` provider's
endpoint, model and access-key settings. Its explicit selection meets the
optional remote requirement; it is never an automatic fallback. Importing
these modules sends no paid request. Arbitrary endpoint override is outside
this increment.

Image execution uses `arcane-os/ai/core-image`; native working members use
`arcane-os/ai/core-model-assets`. SDK `createDbopfsModelStore` receives the
existing DBOPFS connection. Installation, stored assets, projections, loading
and inference remain separate operations. Optional native dependencies and
model downloads were not selected or executed during this task.

Ordinary task browsing, local text search and manual preparation remain usable
without Core or loaded models. Source integration is distinct from actual
native inference and provider availability on an individual device.

## Ownership and work cardinality

One controller owns one active preparation request; independent task
controllers may proceed concurrently. Each face operation retains every actual
returned candidate. SDK context operations and per-task association writes
serialize only at their actual owners. Model assets reuse the SDK store;
selected model changes invalidate readiness.

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
