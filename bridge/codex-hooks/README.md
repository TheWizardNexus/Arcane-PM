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

Native hook deadlines and cancellation remain authoritative. Background hooks
can arrive out of order, queue or be cancelled at session shutdown. SessionEnd
runs synchronously within its native three-second deadline. Stop is an observed
stop boundary, which another hook can continue; it never proves task completion.
The input provides no account identity, source time or source sequence. PM's
receipt time describes receipt only. Original content stays outside durable
chat history, and explicit developer inspection can retrieve the full original.

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
[SDK custom Core client](https://github.com/TheWizardNexus/arcane-os-sdk/blob/049ef8a77fa0ac398987b841de29fa5e4162e08e/docs/reference/core-client.md#native-connection-and-explicit-adapters).
