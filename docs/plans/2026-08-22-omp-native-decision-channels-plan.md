---
title: Prepare omp-workflows v0.13.0 for production
date: 2026-08-22
---

# Prepare omp-workflows v0.13.0 for production

omp-workflows already uses OMP-native package, command, Herdr, and protected-decision surfaces while retaining Pi as a supported host adapter. The remaining work is to make that design dependable as one continuously supervised host, prove recovery from real process failures, and release the same `0.13.0` implementation through npm and crates.io.

This is the selected implementation plan. It replaces the earlier implementation detail in this document. Autoimplement must follow it without adding another supervisor, decision node, messaging channel, or trust path.

## Outcome

- `@ericjuta/omp-workflows` and the `omp-workflows` crate ship synchronized version `0.13.0` under immutable tag `v0.13.0`.
- One foreground host owns a canonical project at a time. A duplicate live host is rejected, while a provably stale owner can be reclaimed.
- Operators can inspect bounded, private host health through `omp-workflows host status [--json]` without exposing workflow content or credentials.
- A user-level systemd service runs the existing foreground `host --project` command on Linux and preserves durable runs across lifecycle operations.
- A headless host leaves protected decisions durably waiting. A later same-project OMP or Herdr session can adopt and present them through native HITL exactly once.
- Deterministic subprocess soaks cover process death, stale ownership, durable recovery, decision redelivery, and upgrade behavior.
- Supported compatibility, CI, release, registry, fresh-install, local-service, OMP, and Herdr proofs are green before completion.

## Scope and authority

Implementation is limited to this repository, remote branch `ericjuta/main`, this repository's GitHub Actions and release, the existing npm and crates.io packages, and this host's user-level OMP, Herdr, package, and systemd configuration.

The authorized work includes task-related edits, tests, commits, pushes to `ericjuta/main`, GitHub tag and release creation, npm and crates.io publication, local package installation, Herdr synchronization, fresh OMP/Herdr smoke sessions, and user-level systemd install, enable, start, stop, restart, status, and uninstall operations. Do not push, merge, tag, or publish to `origin` or upstream.

This is a personal fork. Keep the process boring and proportionate. `main` remains unprotected; the release process must still wait for every supported GitHub lane to pass.

## Compatibility contract

### Supported environments

| Surface               | Supported environments                             | Required proof                                                   |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| Node package and CLI  | Node 22.18 and Node 24 on Ubuntu; Node 24 on macOS | Ubuntu full lane, focused Ubuntu 22.18 lane, focused macOS lane  |
| Rust crate and `ompw` | Stable Rust on Ubuntu and macOS                    | Format, Clippy, tests, package dry-run on both operating systems |
| OMP integration       | Ubuntu OMP TUI and RPC; Herdr-hosted OMP on Ubuntu | Fresh OMP and Herdr sessions                                     |
| Pi adapter            | Existing Ubuntu Pi integration                     | Existing non-destructive end-to-end suite                        |
| Service supervision   | Linux user-level systemd only                      | Unit lifecycle and short soak on Ubuntu                          |

Node versions outside this matrix, non-Linux service managers, launchd, and Windows automation are not release blockers.

### Persisted and user-facing identities

Preserve these compatibility identifiers:

- persisted `pi-workflows.*` schema IDs;
- `.pi` workflow and run paths;
- `PI_WORKFLOWS_*` environment variables;
- `PIW_*` viewer themes;
- npm package `@ericjuta/omp-workflows` and command `omp-workflows`;
- crate `omp-workflows`, library `omp_workflows`, and command `ompw`;
- Herdr plugin `ericjuta.omp-workflows`;
- OMP extension commands `/workflow`, `/hitl`, and `/ompw`.

Do not add compatibility aliases, dual reads, dual writes, or a new persisted schema generation. The checked-in v0.12 fixture is an explicit upgrade-recovery contract for the unchanged durable format, not authority for a general migration layer.

## Non-goals

- Do not change Ask Gina or any unrelated repository.
- Do not touch `origin` or upstream.
- Do not add branch protection, enterprise controls, fleet orchestration, or a hosted control plane.
- Do not restore Telegram or add another third-party messaging service.
- Do not add an answer-bearing CLI, stdin protocol, HTTP endpoint, socket protocol, or model tool for protected decisions. A same-UID model shell is not a human trust boundary.
- Do not rename persisted schemas or storage paths.
- Do not add paid telemetry or another paid service.
- Do not add launchd or Windows service automation.
- Do not build automatic rollback, event sourcing, backups, or unbounded chaos or scale tests.
- Do not print, create, rotate, or weaken the handling of credentials.

## Design

### One supervisor per canonical project

The existing `omp-workflows host --project <path>` process remains the only supervisor. Herdr panes, OMP sessions, systemd, controllers, and viewers do not become additional workflow supervisors.

Before opening project resources, the host canonicalizes the project path and claims a private transient lease for that identity. The claim is an atomic create or replace operation and records:

- the canonical project identity;
- owner PID and process start identity;
- boot ID when the operating system exposes one;
- a random ownership nonce;
- acquisition and last-heartbeat timestamps;
- the host and package version needed for diagnosis.

The transient directory and lease are owner-only. The host refreshes the heartbeat at a bounded cadence using atomic replacement. A second host rejects a lease when PID, process start, boot identity, and heartbeat still prove the owner live. It may reclaim only when those observations prove the record stale. PID reuse, a changed boot ID, a dead process, or an expired heartbeat alone is not silently treated as proof when the remaining identity fields disagree; ambiguous state fails closed and is reported as inconsistent.

Every heartbeat and release checks the nonce, so a displaced process cannot overwrite or remove a successor's lease. Normal shutdown removes only the current owner's transient lease. Durable workflow, controller, and decision records are untouched.

### Private health snapshots and status

The owner atomically writes a bounded mode-`0600` `omp-workflows.host-health.v1` snapshot beside its transient lease. The snapshot contains only:

- schema and package version;
- canonical project identifier or digest;
- owner identity and heartbeat timestamps;
- host lifecycle state;
- active, waiting, parked, and failed run counts;
- pending protected-decision IDs and counts;
- bounded controller counts;
- bounded, redacted error classes and summaries.

It must not contain prompts, answers, workflow inputs or outputs, environment values, credentials, tokens, full stack traces, or arbitrary provider responses. Collection, list, and string sizes are capped before the atomic write.

`omp-workflows host status --project <path>` and `--json` read the lease and snapshot without starting a host. Human and JSON output classify the state as:

- `healthy`: one live matching owner and a fresh valid snapshot;
- `stale`: no live owner and an expired, otherwise coherent lease or snapshot;
- `stopped`: no owner and no current health state;
- `inconsistent`: malformed state, mismatched identity or nonce, multiple claims, or ambiguous liveness.

Status reports whether user lingering is enabled but does not enable it. Corrupt transient health never deletes durable runs and never becomes authority to answer a decision.

### User-level systemd lifecycle

Add idempotent Linux commands around the foreground host:

- `omp-workflows host install --project <path>`;
- `omp-workflows host start --project <path>`;
- `omp-workflows host stop --project <path>`;
- `omp-workflows host restart --project <path>`;
- `omp-workflows host status --project <path> [--json]`;
- `omp-workflows host uninstall --project <path>`.

Installation writes one user unit with absolute executable and project paths. The unit uses `default.target`, bounded restart delay and burst limits, `SIGTERM`, `TimeoutStopSec`, `UMask=0077`, and `NoNewPrivileges=true`. It runs the existing foreground host rather than wrapping or daemonizing it.

Install and repeated lifecycle commands converge on the same unit. Uninstall stops, disables, and removes only generated service files; it preserves all durable runs and unrelated user configuration. Commands clearly report unsupported operating systems, missing user systemd, and lingering state. Lingering is enabled only during the explicitly authorized local rollout, never as an install side effect.

Operational documentation uses `journalctl --user` for logs and records exact manual rollback commands.

### Native protected-decision recovery

Protected decisions retain the existing persisted request digest, integrity checks, first-valid settlement, audited source, and terminal cancellation fence.

A headless host persists the wait and advertises bounded pending IDs in health, but has no path to choose an answer. Closing an owning interactive session detaches the durable pending presentation. A later same-project OMP or Herdr session may atomically adopt an eligible detached request, present it through the existing answer-less `hitl` tool and host-owned OMP UI, and continue the run once after a valid human response.

Adoption is bound to project, request digest, and current unsettled state. Concurrent sessions race through compare-and-set; only one owns presentation. Redelivery is idempotent, stale answers are rejected, another valid winner settles pending presentations, and cancellation remains terminal. JSON, print, non-OMP RPC, CLI, stdin, HTTP, sockets, and model tools never gain answer authority.

### Deterministic soaks and upgrade fixture

Use bounded subprocess scenarios with temporary homes and projects, real SQLite databases and run bundles, deterministic mock providers, explicit deadlines, and cleanup assertions. No test writes outside its temporary roots or calls a real model.

Check in one sanitized v0.12-compatible durable fixture. It proves that the unchanged persisted format reopens under v0.13.0 and recovers the expected waiting or parked state. It contains no credentials, prompts from private sessions, or machine-specific paths.

The short CI soak and longer manual release soak cover:

- a live duplicate host is rejected;
- graceful `SIGTERM` releases ownership and preserves durable state;
- `SIGKILL` leaves reclaimable stale transient state;
- PID reuse, process-start mismatch, boot change, nonce mismatch, and ambiguous identity fail safely;
- a stale owner is reclaimed by one winner;
- parked protected decisions are adopted by a later same-project native session;
- decision redelivery and duplicate responses are idempotent;
- cancellation stays terminal;
- SQLite closes and reopens without lost committed state;
- malformed or truncated transient health reports inconsistent without poisoning durable state;
- the v0.12 fixture recovers under v0.13.0;
- child processes, units, sockets, temporary files, and leases are not orphaned.

### CI lanes

Keep the existing Ubuntu Node 24 full `npm run check` and `npm run test:e2e` lane. Add only focused compatibility work elsewhere:

- Ubuntu Node 22.18: package build, focused compatibility tests, and package smoke;
- macOS Node 24: package build, focused compatibility tests, and package smoke;
- Ubuntu and macOS stable Rust: format policy, Clippy, tests, and package dry-run;
- Ubuntu only: user-systemd contract tests and short subprocess soak.

The manual workflow runs the longer release soak. Supported lanes are release blockers by process even though `main` remains unprotected. Do not duplicate the full heavy suite in every matrix cell.

### Release verifier and publication

Use one release verifier as the source of truth for local and GitHub release validation. It must:

1. require synchronized npm and Cargo versions;
2. require exact version `0.13.0` and tag `v0.13.0` for this release;
3. prove the tagged commit is the intended `ericjuta/main` commit and reject unrelated ancestry;
4. reject a dirty tree and unexpected package contents;
5. validate exact npm and crate file inventories;
6. run npm and Cargo package dry-runs;
7. build release artifacts once;
8. emit SHA-256 checksums and a release manifest for those exact artifacts;
9. compare an already-published exact version by registry integrity and checksum, skipping only on an exact match;
10. fail terminally when an existing registry version differs;
11. publish absent artifacts through the repository's existing trusted OIDC paths;
12. poll registries with bounded retries and verify the published exact versions and integrity.

Credentials are considered available only when a non-secret capability check proves the existing trusted publisher can act. Never print, create, or rotate credentials. If registry authorization is unavailable, finish every other selected item and leave publication alone explicitly blocked with non-secret evidence.

## Implementation order

1. Lock synchronized `0.13.0` metadata and the supported environment matrix in code, tests, and release configuration.
2. Add the canonical-project lease, identity checks, heartbeat, duplicate rejection, nonce fencing, and stale reclaim.
3. Add bounded private health snapshots and truthful human and JSON status output.
4. Add idempotent user-level systemd lifecycle commands without changing the foreground host contract.
5. Complete native same-project protected-decision advertisement, adoption, presentation, settlement, and cancellation recovery.
6. Add the deterministic subprocess harness, v0.12 fixture, short soak, and release soak.
7. Add focused Node, macOS, Rust, systemd, and soak CI lanes while retaining one full Node lane.
8. Consolidate release checks into the single verifier and make release jobs consume its build-once artifacts and manifest.
9. Update the existing README, workflow, human-decision, release, rollback, host, journald, and shipped-skill documentation after behavior stabilizes. Do not create duplicate operating guides.
10. Run local gates, local candidate package installs, OMP/Herdr/systemd smokes, reviewer remediation, and all GitHub lanes.
11. Roll out the local candidate, publish `v0.13.0`, verify registries and fresh exact-version installs, repoint this host to published packages, and repeat the smokes.

Remove superseded code and documentation in the same change. Do not leave aliases, migration shims, feature flags, placeholders, or deferred production work.

## Verification

### Repository gates

Run all of the following against the exact candidate:

```bash
npm run check
npm run test:e2e
npx slophammer-ts@latest dry .
npx slophammer-ts@latest check . --only ts.dependency-boundaries-required
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo package --allow-dirty
```

Also run the focused lease, health, status, systemd, decision-adoption, release-verifier, package-inventory, short-soak, and release-soak proofs. Run package installs from the generated npm tarball and crate package before publication.

Push the exact candidate to `ericjuta/main`, run `pi-reviewer --base main`, fix every P0 and P1 finding, repush, and repeat until none remain. Require every supported GitHub lane to be green on that commit.

### Local candidate rollout

Before publication:

1. install the candidate package and viewer locally;
2. synchronize the bundled Herdr plugin;
3. start a fresh OMP session and a fresh Herdr OMP session and confirm the installed extension, skills, workflow list, and `ompw` surface load from the candidate;
4. install, enable, and start the user service for the canonical project;
5. explicitly enable and report user lingering;
6. prove healthy status and single ownership, including harmless duplicate rejection;
7. use a temporary project to prove a headless protected decision remains durable and is later adopted and presented in a fresh native OMP or Herdr session without allowing the model to answer it;
8. confirm durable runs survive restart and uninstall/reinstall exercises.

### Release and published-package proof

After local candidate proof:

1. create immutable tag `v0.13.0` on the proven `ericjuta/main` commit;
2. publish the GitHub release, npm package, and crate through existing authorized paths;
3. compare registry integrity, checksums, package inventories, and manifest to the build-once artifacts;
4. perform fresh exact-version npm and Cargo installs in clean temporary roots;
5. repoint this host's OMP package, Herdr plugin, `ompw`, and user service to the published exact versions;
6. repeat fresh OMP, Herdr, host status, single-owner, restart, and native decision-recovery smokes.

## Acceptance criteria

The work is complete only when:

- npm and Cargo report `0.13.0`, and `v0.13.0` identifies the exact green `ericjuta/main` commit;
- lease and health files are private, bounded, atomic, nonce-fenced, and safe under PID reuse, reboot, corruption, duplicate hosts, and stale reclaim;
- status classifications are truthful and contain no workflow content, answers, environment, or secrets;
- systemd lifecycle is idempotent, uses the required hardening and shutdown behavior, reports lingering, and preserves durable runs;
- native later-session protected-decision recovery is proven without any answer-bearing model or headless interface;
- short and release soaks pass without orphan resources;
- every repository gate, supported CI lane, and reviewer loop is green with no P0 or P1 finding;
- the candidate and published packages both pass fresh OMP, Herdr, package, viewer, and user-service smokes;
- npm and crates.io exact-version integrity and checksums match the release manifest;
- previous exact package versions and all durable runs remain available for manual rollback.

If trusted registry authorization is unavailable, publication alone may remain blocked. The blocker must include non-secret capability evidence, and no other acceptance item may remain unfinished.

## Recovery and rollback

Transient lease or health corruption is handled by stopping the service, preserving durable runs, inspecting status, and reclaiming only when owner identity is provably stale. Ambiguous ownership is never force-cleared automatically.

Service rollback is manual: stop the user unit, install the previous exact npm and Cargo versions, resynchronize Herdr, reinstall the same project unit, and start it. Durable run directories are retained throughout. Registry artifacts and the immutable release tag are never overwritten; a bad release is followed by a new version.

A protected decision remains waiting during rollback. A later eligible same-project OMP or Herdr session presents it through the existing native HITL path, or an operator applies the existing terminal cancellation command. No rollback step creates an alternate answer channel.
