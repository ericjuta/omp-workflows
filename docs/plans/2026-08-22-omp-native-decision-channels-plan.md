---
title: Make human decisions OMP-native without breaking Pi
date: 2026-08-22
---

# Make human decisions OMP-native without breaking Pi

The engine already parks a run at `humanDecision()` and accepts one verified
answer. Channel types, config, and `audienceChannels()` live in
`src/extension/decision-channels.ts` and import Pi UI types. Unconfigured
audiences always resolve to `["pi"]`. A headless OMP pane therefore waits on a
TUI that is not there. `src/herdr` is `allow: []`, so an OMP adapter cannot
implement that interface in herdr.

This plan is the selected implementation. Autoimplement must not invent another
reviewer, another decision node, or a plugin rename.

## Outcome

- Channel contract, config, and Telegram are pi-agnostic.
- Pi TUI HITL still works with no `channels.json`.
- An OMP pane is a first-class channel for audience `operator`.
- Headless hosts fail loudly when they have no channel.
- Autoimplement still shells `pi-reviewer --base <branch>`.
- Herdr plugin id stays `osolmaz.pi-workflows`.

## Non-goals

- Do not rename the npm package `@osolmaz/pi-workflows`.
- Do not rename herdr plugin id `osolmaz.pi-workflows` or entrypoint `piw`.
  This checkout is a fallback fork (`ericjuta/omp-workflows`). A new id would
  orphan existing herdr installs and break `syncHerdrPlugin`.
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
   The channel takes a pi-agnostic UI port (`custom` + `input` + abort), not
   herdr types. The extension, when the process is an OMP pane, adapts herdr
   pane I/O to that port without moving channel logic into herdr.

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

- Pi TUI: existing `ctx.mode === "tui"`.
- OMP: herdr/OMP pane environment already present in this host (pane id or
  herdr parent). Do not invent a new user-facing env var unless detection is
  otherwise impossible; if one is required, document it in
  `docs/HUMAN_DECISIONS.md`.
- Otherwise headless.

Delivery already treats `pi` as available only when `ctx.mode === "tui"`.
Keep that gate. Treat `omp` as available only when the OMP channel can
actually prompt. If resolved channels have no available adapter, keep the
existing warning: the decision remains waiting because the audience has no
available channel. Do not manufacture a Pi answer from a model or RPC
`workflow answer`.

Do not default unconfigured `operator` to no channel. That regresses plain Pi.

### OMP channel behavior

`OmpDecisionChannel` id is `omp`. It implements the same
`HumanDecisionChannel` methods: `start`, `deliver`, `settle`, `stop`.

- `deliver` renders `pi-workflows.decision-presentation.v1` (same document
  segments as Pi/Telegram).
- Collect one choice. If the choice has `textInput`, collect that exact text.
- Submit through the existing host-owned acceptance path
  (`HumanDecisionChannelAnswer`, first-valid-answer, same store records).
- `settle` closes the prompt when another channel or a timeout wins.
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

### OMP extension-loader compatibility

The extension module graph must not statically request Pi exports that OMP's
legacy compatibility shim does not provide. `runPiAgentGroup` capability-detects
`ModelRuntime`: Pi keeps its isolated runtime and agent-directory catalog path;
OMP uses the shimmed `createAgentSession` with `modelPattern`, restricted native
tool names, and no ambient extensions, skills, prompts, context files, MCP, or
LSP. Legacy `find` and `ls` requests map to OMP `glob`.
The same missing export is the extension-process fallback host marker because
Herdr OMP can expose `OMPCODE=1` to tool children without exposing it to the
legacy extension process. A native decision accepted in Herdr must persist
`source.channel: "omp"`.

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
   pending decisions to it, and settle it with Pi/Telegram.
6. Update `docs/HUMAN_DECISIONS.md`, `docs/HUMAN_DECISION_PRESENTATIONS.md`,
   and `docs/workflows.md` for host-derived defaults and the `omp` channel.
   Mention the spawn contract. State that the herdr plugin id is unchanged.
7. Remove the static `ModelRuntime` requirement from the extension module
   graph. Keep Pi's runtime path and add the restricted OMP SDK path. Verify in
   a fresh Herdr OMP session.
8. Export the sqlite wrapper and test a fake statement returning `null`.
9. Verify: `npm run check`, `npm run test:e2e`,
   `npx slophammer-ts@latest dry .`,
   `npx slophammer-ts@latest check . --only ts.dependency-boundaries-required`.
10. Commit with Conventional Commits. Push `main` or the task branch to
    remote `ericjuta` only. Open or update a PR on `ericjuta/omp-workflows`
    if publication needs a PR. Do not push `origin`.

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
- Plugin id in `herdr-plugin.toml` and `src/herdr/constants.ts` is still
  `osolmaz.pi-workflows`.
- A fresh OMP session loads the extension without requiring `ModelRuntime`,
  lists workflows when the host supplies `i`, and an isolated agent exposes
  only the mapped read-only tools.
- A Herdr OMP decision redraws after navigation and persists an accepted answer
  with `source.channel: "omp"`.

## Public contracts

- Add channel id `omp` beside `pi` and `telegram:<profile>`.
- Change `audienceChannels` to require host kind. This is an alpha in-place
  change. Update all callers and tests. No compatibility shim.
- Persist the same human-decision v1 records. No new schema generation.

## Recovery

Existing waiting runs keep their request digest. After this change, an
unconfigured operator decision in an OMP pane delivers to `omp` instead of
warning that `pi` is unavailable. Pi TUI behavior is unchanged.
