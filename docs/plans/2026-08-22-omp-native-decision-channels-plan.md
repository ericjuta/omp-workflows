---
title: Make workflows OMP-native without breaking Pi compatibility
date: 2026-08-22
---

# Make workflows OMP-native without breaking Pi compatibility

The engine already parks a run at `humanDecision()` and accepts one verified
answer. Channel types, config, and `audienceChannels()` live in
`src/extension/decision-channels.ts` and import Pi UI types. Unconfigured
audiences always resolve to `["pi"]`. A headless OMP pane therefore waits on a
TUI that is not there. `src/herdr` is `allow: []`, so an OMP adapter cannot
implement that interface in herdr.

The fork also still exposes the upstream npm, Cargo, CLI, Herdr, and skill
names. Those are user-facing Pi identities even when OMP owns the session.
This plan therefore includes a clean OMP naming cutover while preserving the
existing run-bundle protocol and storage.

This plan is the selected implementation. Autoimplement must not invent another
reviewer or another decision node.

## Outcome

- Channel contract, config, and Telegram are pi-agnostic.
- Pi TUI HITL still works with no `channels.json`.
- OMP TUI and RPC hosts are first-class channels for audience `operator`.
- `/hitl` and the `hitl` tool present the same host-owned decision UI; neither accepts an answer payload.
- JSON, print, and non-OMP RPC hosts remain headless and fail loudly when they have no channel.
- Autoimplement still shells `pi-reviewer --base <branch>`.
- The npm package, Node CLI, Rust viewer, Herdr plugin, and shipped workflow
  skill use OMP-native names.

## Non-goals

- Do not rename persisted `pi-workflows.*` schemas, `PI_WORKFLOWS_*`
  environment variables, `.pi` storage paths, or the existing `PIW_*` viewer
  config contract. They remain compatibility protocol and data identifiers.
- Do not retain legacy package, CLI, Herdr plugin, or skill aliases.
- Do not route review or approval through OMP review or OMP ask.
- Do not change Ask Gina / `nextjs-ai-chatbot`.
- Do not push to `origin` (`osolmaz/pi-workflows`). Publish only to remote
  `ericjuta` (`git@github.com:ericjuta/omp-workflows.git`).
- Do not merge or release.
- Do not add wrappers under `~/.local/bin` to the repo.

## Architecture

### Layers

1. Add `src/channels` with slophammer `allow: [src/workflows]`.
   Move `HumanDecisionChannel`, delivery/settlement types, config parse,
   `decisionConfigDir`, `loadDecisionChannelConfig`, `writeDecisionChannelProfile`,
   `audienceChannels`, and `TelegramDecisionChannel` here. Telegram must not
   import `@earendil-works/pi-coding-agent` or `@earendil-works/pi-tui`.

2. Leave only `PiDecisionChannel` and `PiDecisionUi` in `src/extension`.
   `PiDecisionUi` may keep its Pi `Pick`. The extension imports `src/channels`
   and `src/host` as needed.

3. Keep `src/herdr` as `allow: []`. Herdr remains plugin sync and pane I/O.
   It must not import `src/channels`, `src/extension`, or `src/host`.

4. Put `OmpDecisionChannel` in `src/host`. Allow `src/host` to import
   `src/channels` in addition to workflows, builtins, and controllers.
   The channel takes a pi-agnostic UI port (`custom` + `select` + `input` +
   abort), not herdr types. The extension adapts OMP TUI and RPC UI methods to
   that port without moving channel logic into herdr.

### Host-derived default

Replace the static fallback:

```ts
return configured === undefined ? ["pi"] : [...configured];
```

`audienceChannels(config, audience, host)`:

- If the audience is configured, use those channel ids.
- If unconfigured and `host.kind === "pi-tui"`, default `["pi"]`.
- If unconfigured and `host.kind === "omp"`, default `["omp"]`.
- If unconfigured and `host.kind === "headless"`, return `[]`.

Detect host from the running process, not from `channels.json`:

- Pi TUI: existing `ctx.mode === "tui"` when the process is not OMP.
- OMP TUI or RPC: OMP runtime capability or `OMPCODE=1` plus a mode with an
  interactive UI transport. TUI uses a custom component; RPC uses the host's
  `extension_ui_request` protocol.
- JSON, print, Pi RPC, and other hosts are headless.

Delivery treats `pi` as available only in Pi TUI. Treat `omp` as available only
in OMP TUI or OMP RPC, where the channel can actually prompt. If resolved
channels have no available adapter, keep the existing warning: the decision
remains waiting because its audience has no available channel. Do not
manufacture a Pi or OMP answer from a model or the RPC `workflow answer` tool;
OMP RPC answers must return through the host-owned extension UI response.

Do not default unconfigured `operator` to no channel. That regresses plain Pi.

### OMP channel behavior

`OmpDecisionChannel` id is `omp`. It implements the same
`HumanDecisionChannel` methods: `start`, `deliver`, `settle`, `stop`.

- TUI `deliver` renders the complete `pi-workflows.decision-presentation.v1`
  document in the custom OMP component.
- RPC `deliver` emits a native `select` request containing the readable
  presentation and uniquely numbered choice labels.
- Collect one choice. If the choice has `textInput`, collect that exact text
  through the corresponding TUI or RPC input method.
- Submit through the existing host-owned acceptance path
  (`HumanDecisionChannelAnswer`, first-valid-answer, same store records).
- `settle` aborts either prompt when another channel or a timeout wins.
- Source is `channel: "omp"` with a host-assigned actor id. Workflows and
  models cannot claim this source.

`plan-approval` policy is unchanged: `required` waits, `auto` times out,
`skip` creates no decision. `auto` still works without an OMP UI.

### Spawn contract (docs only)

Document in `docs/workflows.md` (command batch environment already exists)
and `docs/HUMAN_DECISIONS.md`:

- Host login PATH must include `$HOME/.local/bin` and `$HOME/.bun/bin`.
- Reviewer children unset `GOOGLE_GENAI_USE_VERTEXAI` and
  `GOOGLE_CLOUD_LOCATION` via `envUnset`.
- Isolated `runPiAgentGroup` sessions pin the agent-dir catalog.

No new spawn wrappers in the repository.

### OMP-native user-facing identity

Use one clean set of names:

- npm package `@ericjuta/omp-workflows` with primary `omp` plugin metadata and
  the `omp-workflows` executable;
- retain the package's `pi` extension metadata only as the supported Pi host
  adapter, not as a user-facing package or command alias;
- crates.io package `omp-workflows`, Rust library `omp_workflows`, and viewer
  executable `ompw`;
- Herdr plugin id `ericjuta.omp-workflows`, display name `omp-workflows`, and
  pane entrypoint `ompw`;
- shipped skill `omp-workflows`, available as `/skill:omp-workflows`, plus the
  extension commands `/ompw` and `/hitl` and the model-facing `hitl` presenter;

Dynamic workflow and controller loaders accept only the new package imports.
The Herdr launcher starts `ompw` directly. Existing installations must unlink
`osolmaz.pi-workflows` once before linking `ericjuta.omp-workflows`; the new
sync command does not preserve or silently mutate the old registration.

### OMP extension-loader compatibility

The extension module graph must not statically request Pi exports that OMP's
legacy compatibility shim does not provide. `runPiAgentGroup` capability-detects
`ModelRuntime`: Pi keeps its isolated runtime and agent-directory catalog path;
OMP uses the shimmed `createAgentSession` with `modelPattern`, restricted native
tool names, and no ambient extensions, skills, prompts, context files, MCP, or
LSP. Legacy `find` and `ls` requests map to OMP `glob`.
The same missing export is the extension-process fallback host marker because
Herdr OMP can expose `OMPCODE=1` to tool children without exposing it to the
legacy extension process. OMP TUI and RPC modes use the `omp` channel. JSON,
print, Pi RPC, and other non-interactive modes remain headless. An accepted
native decision persists `source.channel: "omp"`.

A fresh Herdr OMP session must load the extension and expose the workflow
surface without `Export named 'ModelRuntime' not found`.

### Optional sqlite export

If cheap after the channel lift: export `wrapSqliteDatabase` and add a unit
test where fake `.get()` returns `null`. Do not block the channel work on
this.

## Implementation steps

1. Add `src/channels` and the slophammer boundary. Move types, config, and
   Telegram. Update imports and tests
   (`test/decision-channel-config.test.ts`,
   `test/telegram-decision-channel.test.ts`).
2. Narrow `src/extension/decision-channels.ts` to Pi TUI only. Keep
   `test/pi-decision-channel.test.ts` importing the extension module.
3. Add host kind to `audienceChannels` and tests for pi-tui / omp / headless
   defaults, including configured audiences unchanged.
4. Implement `OmpDecisionChannel` in `src/host` with a fake UI port in tests
   (mirror `test/pi-decision-channel.test.ts` without Pi types).
5. Wire the extension to start the OMP channel when the host is OMP, deliver
   pending decisions to it, and settle it with Pi/Telegram. Add `/hitl` and a
   `hitl` tool that can present that channel but cannot provide its answer.
6. Update `docs/HUMAN_DECISIONS.md`, `docs/HUMAN_DECISION_PRESENTATIONS.md`,
   `docs/workflows.md`, `skills/omp-workflows/SKILL.md`, and
   `skills/autoimplement/SKILL.md` for host-derived defaults and the `omp`
   channel. Mention the spawn contract.
7. Remove the static `ModelRuntime` requirement from the extension module
   graph. Keep Pi's runtime path and add the restricted OMP SDK path. Verify in
   a fresh Herdr OMP session.
8. Export the sqlite wrapper and test a fake statement returning `null`.
9. Rename the npm and Cargo packages, CLIs, Herdr plugin, extension command,
   dynamic loader imports, and shipped workflow skill to the OMP identities.
   Update active documentation, tests, package metadata, and release workflows.
10. Verify: `npm run check`, `npm run test:e2e`, `cargo fmt`, `cargo clippy`,
    `cargo test`, package dry runs, live `omp-workflows` / `ompw` / Herdr / OMP
    skill smoke tests, `npx slophammer-ts@latest dry .`, and the dependency
    boundary check.
11. Commit with Conventional Commits. Push the task branch to remote
    `ericjuta` only if authorized. Open or update a PR on
    `ericjuta/omp-workflows` if publication needs a PR. Do not push `origin`.

## Verification

- `audienceChannels(null, "operator", { kind: "pi-tui" })` equals `["pi"]`.
- `audienceChannels(null, "operator", { kind: "omp" })` equals `["omp"]`.
- `audienceChannels(null, "operator", { kind: "headless" })` equals `[]`.
- Configured audiences are unchanged.
- Telegram tests still pass with no Pi imports in `src/channels`.
- Pi decision channel tests still pass.
- New OMP channel tests cover deliver, text input, cancel, and settle.
- `src/herdr` still has no engine or channel imports.
- `src/workflows` still has `allow: []`.
- Reviewer command is still `pi-reviewer` with args `--base <branch>`.
- The npm package is `@ericjuta/omp-workflows`; `omp-workflows --help` works
  and no `pi-workflows` executable is packaged.
- The Cargo package is `omp-workflows`; `ompw --help` works and no `piw`
  executable is built.
- Herdr plugin id is `ericjuta.omp-workflows`, entrypoint is `ompw`, and its
  launcher starts `ompw`.
- The installed skill is `omp-workflows` and resolves as
  `/skill:omp-workflows`; the extension command is `/ompw`.
- A fresh OMP session loads the extension without requiring `ModelRuntime`,
  lists workflows when the host supplies `i`, and an isolated agent exposes
  only the mapped read-only tools.
- A Herdr OMP TUI decision redraws after navigation and persists an accepted
  answer with `source.channel: "omp"`.
- OMP RPC emits native `select` and optional `input` requests, and settlement
  cancels the pending request.
- `decisionHostKind` returns `omp` for OMP TUI and RPC, but remains `headless`
  for JSON, print, and Pi RPC.

## Public contracts

- Add channel id `omp` beside `pi` and `telegram:<profile>`.
- Change `audienceChannels` to require host kind. This is an alpha in-place
  change. Update all callers and tests. No compatibility shim.
- Persist the same human-decision v1 records. No new schema generation.
- Rename user-facing package, CLI, plugin, and skill contracts in place. No
  legacy command, package-import, plugin-id, or skill aliases.

## Recovery

Existing waiting runs keep their request digest. After this change, an
unconfigured operator decision in an OMP pane delivers to `omp` instead of
warning that `pi` is unavailable. Pi TUI behavior is unchanged.

The naming cutover does not rewrite existing run bundles. Local installations
unlink the old Herdr plugin and install the new npm and Cargo package names;
workflow definitions must import `@ericjuta/omp-workflows` after the cutover.
