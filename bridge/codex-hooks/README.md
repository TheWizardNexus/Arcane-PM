# Passive desktop observations

This plugin source forwards complete native hook stdin to Arcane PM. It supplies
no approval decision, model context, modified prompt, inference or task control.
Preparing these files does not install or enable a plugin.

Run from the canonical PM checkout:

```powershell
node bridge/codex-hooks/prepare.mjs http://127.0.0.1:4310
```

The generated artifact is `output/bridge/codex-hooks/`. Its `configuration.json`
records this PM application's actual root and explicitly selected receiver URL.
It stays in ignored project output. The cached plugin resolves the already
installed SDK through that application's public package exports; it neither
vendors the SDK nor downloads dependencies. The originating desktop command
environment must resolve the existing `node` executable.

Foundation composes `bridge/hooks-service.mjs` into the existing Core host. The
relay uses the published `createCoreClient({transport})` extension and the
existing development `/rpc` route. The actual final Core response confirms the
receiver stored the original and receipt. This one-request connection has no
SSE stream, service-event subscription or readiness claim. Failed delivery exits
1 with complete stderr diagnostics; successful delivery leaves stdout empty.
There is no automatic retry. An interrupted command can have an unknown result.

For a native app whose selected launch context enables the published SDK's
`coreListener` or explicit `sharedHost`, prepare its separate artifact with:

```powershell
node bridge/codex-hooks/prepare.mjs --native "<native-launch-directory>"
```

Pass the same `--arcane-launch-config <path>` and, when selected by the host,
`--arcane-host-state-root <directory>` arguments as that native application.
The directory argument explicitly selects the native application's launch
working directory. Preparation and delivery use that directory so relative
arguments and locations inside
the launch JSON keep their selected meaning when a hook runs in another project.
Absolute launch locations also remain supported.

Native preparation writes `output/bridge/codex-hooks-native/`, leaving the
development artifact intact. Configuration retains this app's SDK resolution
root, selected arguments and working directory. It includes the descriptor's
ID and launch defaults only when `native.launchContext` exists, matching the
packaged Core entry. The SDK's public `readCoreLaunchContext` reads the same explicit
launch file at preparation and delivery. Preparation reports an unavailable
native selection before writing when that context has no selected endpoint or
selects both listener and shared-host modes; it does not alter the descriptor.
The selected native build must use these same launch defaults and locations. Reprepare after
changing them.

The native relay calls `connectSharedCoreHost` with the selected endpoint and
no startup command, sends the unchanged original to `pm.codexHooks.accept`,
and awaits only its client's close. With SDK 0.84.0 or later,
`native.launchContext.coreListener:{endpoint}` attaches to the ordinary
window-owned Core. The endpoint is explicit; Foundation retains the existing
stdio/window lifetime, services, profile and state location. Closing the window
still drains that Core. An explicitly selected `sharedHost` keeps its separate
headless lifetime. These two modes cannot be selected together.
Foundation owns host startup, lifetime and shutdown. The relay never creates a
second Core, shuts down the app, or falls back to the development receiver.
Invocation and close failures remain in
complete diagnostics. SDK runtime replay describes that Core's lifecycle; it
does not supply historical hooks or Codex Desktop current task state.

Native hook deadlines and cancellation remain authoritative. Background hooks
can arrive out of order, queue or be cancelled at session shutdown. SessionEnd
runs synchronously within its native three-second deadline. Stop is an observed
stop boundary, which another hook can continue; it never proves task completion.
The input provides no account identity, source time or source sequence. PM's
receipt time describes receipt only. Original content stays outside durable
chat history, and explicit developer inspection can retrieve the full original.
`session_id` groups a root and its descendants; an explicit `agent_id` can
identify a spawned child. Missing `agent_id` does not universally establish
which thread executed the event. `turn_id` and `tool_use_id`, when present,
provide correlation rather than chronological ordering. Hook evidence does not
establish authoritative current running, idle, completed or archived state.

Activation is a separate selected operation. Choose the intended local project
or personal scope and preserve stopped projects before registering a marketplace
or changing plugin configuration. Use the native marketplace installation and
plugin toggle, then complete the native review of these exact hooks. Current
desktop documentation requires restart for local plugin updates; source edits
do not establish installed-cache updates or live-session activation. Preserve
all existing hooks and approval settings. Disable only this plugin through its
native toggle or its own `enabled = false` setting. Existing observations remain
saved; disable is not evidence that a previously launched command was cancelled.

Actual desktop hook execution and receiver delivery remain unverified until a
selected origin emits an event and PM reads its complete stored original.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[plugin packaging and local activation](https://developers.openai.com/plugins/build/plugins),
[SDK existing-runtime listener](https://github.com/TheWizardNexus/arcane-os-sdk/blob/0.84.0/docs/reference/core-shared-host.md#attach-to-an-existing-window-owned-core),
[SDK custom Core client](https://github.com/TheWizardNexus/arcane-os-sdk/blob/049ef8a77fa0ac398987b841de29fa5e4162e08e/docs/reference/core-client.md#native-connection-and-explicit-adapters).
