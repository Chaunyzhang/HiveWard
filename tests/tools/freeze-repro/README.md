# Live remote freeze repros

Two harnesses for bulk-open / reconnect freeze repros on large paired remotes:

| Harness                               | Realism                                                               | Purpose                              |
| ------------------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| **Realistic** (preferred for stories) | Idle + flood backlog → wake/reconnect-like refresh → human-paced open | Models overnight/return/restart      |
| **Bulk parallel** (stress amp)        | Concurrent `terminal switch`                                          | Forces hard freeze for load ceilings |

## Prerequisites

1. **Desktop HiveWard running** (`hiveward status --json`).
2. A **large paired remote** (many worktrees / agent terminals). Lab fleets often have ~60 worktrees and 100+ terminals.
3. Repo checkout with these scripts.

```bash
hiveward environment list --json
hiveward worktree list --environment <name> --json | head
hiveward terminal list --environment <name> --json | head
```

---

## A. Realistic repro (preferred)

Story: remotes keep streaming while the user is away; user returns (optionally after wake/reconnect-like refresh) and opens sessions one-by-one.

```bash
# Idle + human-paced open
HIVEWARD_FREEZE_ENV=paired-remote \
HIVEWARD_FREEZE_SCENARIO=idle-backlog-open \
HIVEWARD_FREEZE_CREATE=8 \
HIVEWARD_FREEZE_IDLE_MS=45000 \
HIVEWARD_FREEZE_OPEN_COUNT=24 \
pnpm run repro:live-remote-realistic-freeze

# Wake-like: idle + reconnect metadata storm + open  ← hard freeze in lab
HIVEWARD_FREEZE_ENV=paired-remote \
HIVEWARD_FREEZE_SCENARIO=idle-backlog-reconnect-open \
HIVEWARD_FREEZE_CREATE=10 \
HIVEWARD_FREEZE_IDLE_MS=60000 \
HIVEWARD_FREEZE_OPEN_COUNT=40 \
pnpm run repro:live-remote-realistic-freeze

# Restart-proxy: idle + hiveward open + refresh storm + open (does not kill desktop)
HIVEWARD_FREEZE_ENV=paired-remote \
HIVEWARD_FREEZE_SCENARIO=restart-proxy \
HIVEWARD_FREEZE_CREATE=0 \
HIVEWARD_FREEZE_IDLE_MS=20000 \
HIVEWARD_FREEZE_OPEN_COUNT=30 \
pnpm run repro:live-remote-realistic-freeze
```

Or: `node config/scripts/live-remote-realistic-freeze-repro.mjs`

### Scenarios

| `HIVEWARD_FREEZE_SCENARIO`        | Models                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `idle-backlog-open`           | User away while agents stream; returns and opens sessions                                     |
| `idle-backlog-reconnect-open` | Same + parallel status/worktree/terminal refresh (wake/reconnect client storm)                |
| `restart-proxy`               | `hiveward open` + refresh storm + open (post-restart discovery; no process kill)                  |
| `lockup-storm`                | Idle + flood + reconnect + **concurrent** open fan-out + **mid-storm `hiveward status` watchdog** |

### Realistic knobs

| Variable                          | Default             | Meaning                                                           |
| --------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `HIVEWARD_FREEZE_ENV`                 | `paired-remote`     | Paired remote environment name                                    |
| `HIVEWARD_FREEZE_SCENARIO`            | `idle-backlog-open` | See table above                                                   |
| `HIVEWARD_FREEZE_CREATE`              | `0`                 | New flood terminals; mutation requires an explicit positive value |
| `HIVEWARD_FREEZE_IDLE_MS`             | `45000`             | Time “away” while floods run                                      |
| `HIVEWARD_FREEZE_OPEN_COUNT`          | `20`                | Sessions to open after return                                     |
| `HIVEWARD_FREEZE_PACE_MS`             | `250`               | Base delay between opens (human pace)                             |
| `HIVEWARD_FREEZE_PACE_JITTER_MS`      | `150`               | Random extra delay                                                |
| `HIVEWARD_FREEZE_SOFT_MS` / `HARD_MS` | 2000 / 5000         | Thresholds                                                        |

### Lab results (2026-07-31, client 1.4.163 / remote 1.4.163-rc.0)

| Scenario                                           | create | idle   | open           | peak                                                 | Signal                                                                    |
| -------------------------------------------------- | ------ | ------ | -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| idle-backlog-open                                  | 6      | 45s    | 24             | **1.7s** max open                                    | none (&lt; soft)                                                          |
| **idle-backlog-reconnect-open**                    | 10     | 60s    | 40             | **11.0s** max open; reconnect refresh **3.6s**       | **HARD (recovered)**                                                      |
| **restart-proxy**                                  | 0      | 20s    | 30             | **11.2s** max open                                   | **HARD (recovered)**                                                      |
| **lockup-storm** (parallel open + overlap refresh) | 12–16  | 45–60s | 64–80 @ p20–32 | **27–35s** batches; some `Terminal reveal timed out` | **HARD stalls + reveal timeouts; app still answers `hiveward status` ~150ms** |

### Full-app forever freeze?

**Not observed** under CLI-driven escalation (including mid-storm status watchdog).

Latest lockup-storm with watchdog (2026-07-31):

| Field                       | Value                               |
| --------------------------- | ----------------------------------- |
| `foreverUiLockupObserved`   | **false**                           |
| Mid-storm status samples    | **95**, max **~631ms**, **0 hangs** |
| Peak open/batch             | **~34s** (recovered hard stall)     |
| `Terminal reveal timed out` | yes (under fan-out)                 |
| Post-storm `hiveward status`    | **~113ms**                          |
| Force Quit required         | **no**                              |

Bar for full-app freeze in the harness: continuous **≥30s** window where `hiveward status` hangs/fails or stays ≥15s slow (`evaluateFullAppFreeze` / `foreverUiLockupObserved`).
CLI spawn failures are reported as harness infrastructure errors, not product freezes.

What we **do** reproduce: severe multi-second / multi-tens-of-seconds stalls + flaky reveal.
What we **do not**: UI dead forever until Force Quit. That likely needs **real OS sleep/wake**, **renderer React #185**, or a path status RPC does not share with the frozen surface.

| Exit | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | no freeze                                                                       |
| 1    | soft (≥2s recovered)                                                            |
| 2    | hard stall ≥5s **but recovered**                                                |
| 4    | permanentLockup heuristic (timeouts/fail-rate; check `foreverUiLockupObserved`) |
| 5    | **full-app forever freeze** (status unhealthy ≥ forever window)                 |
| 3    | harness error                                                                   |

```bash
# Full-app freeze attempt (watchdog on)
HIVEWARD_FREEZE_ENV=paired-remote HIVEWARD_FREEZE_SCENARIO=lockup-storm \
  HIVEWARD_FREEZE_CREATE=12 HIVEWARD_FREEZE_IDLE_MS=30000 HIVEWARD_FREEZE_OPEN_COUNT=80 \
  HIVEWARD_FREEZE_STORM_PARALLEL=28 HIVEWARD_FREEZE_FOREVER_WINDOW_MS=30000 \
  pnpm run repro:live-remote-realistic-freeze
# Expect exit 2 (recovered hard) unless foreverUiLockupObserved becomes true
```

**Interpretation:** Pure sequential open after idle stays under 2s. **Wake/reconnect-style refresh + open** (or concurrent fan-out) produces **recovered hard stalls**. True permanent lockup remains unproven with CLI-only levers.

Reports: `test-results/freeze-repro/live-realistic-freeze-<env>-<scenario>.json`

---

## B. Stress amp (bulk parallel)

Artificial concurrency lever; still useful for ceilings / CI stress.

```bash
HIVEWARD_FREEZE_ENV=paired-remote \
HIVEWARD_FREEZE_CREATE=0 \
HIVEWARD_FREEZE_SWITCH_PASSES=3 \
HIVEWARD_FREEZE_PARALLEL=16 \
pnpm run repro:live-remote-bulk-open-freeze
```

Lab: sequential soft ~3.3–3.9s; **parallel=16 → ~20s HARD**.

---

## Exit codes (both harnesses)

| Code | Meaning                           |
| ---- | --------------------------------- |
| 0    | No freeze signal under thresholds |
| 1    | Soft freeze (peak ≥ 2s)           |
| 2    | **Hard freeze (peak ≥ 5s)**       |
| 3    | Harness failure                   |

---

## Product fix (concurrent host-focus storms)

Generation-aware **latest-wins single-flight** for exclusive host focus:

| Layer    | Module                                                                             |
| -------- | ---------------------------------------------------------------------------------- |
| Runtime  | `TerminalFocusNavigationCoalescer` via `HiveWardRuntimeService.focusTerminal`          |
| Contract | `RuntimeTerminalFocus.navigated?: boolean` — `false` when superseded / nav skipped |

**In scope:** concurrent `terminal.focus` / bulk-switch storms.
**Residual:** sequential soft freezes; reconnect/wake metadata storms — need cheaper activation + scan bounding, not only focus coalescing.

## Files

| Path                                                           | Role                               |
| -------------------------------------------------------------- | ---------------------------------- |
| `config/scripts/live-remote-realistic-freeze-repro.mjs`        | Naturalistic harness               |
| `config/scripts/live-remote-bulk-open-freeze-repro.mjs`        | Parallel stress harness            |
| `config/scripts/live-remote-freeze-rpc.mjs`                    | Cross-platform bounded CLI runner  |
| `config/scripts/live-remote-bulk-open-freeze-metrics.mjs`      | Shared thresholds / handle extract |
| `config/scripts/live-remote-bulk-open-freeze-metrics.test.mjs` | Unit tests                         |
| `src/main/runtime/terminal-focus-navigation-coalescer.ts`      | Host focus single-flight           |
| `pnpm run repro:live-remote-realistic-freeze`                  | package entry                      |
| `pnpm run repro:live-remote-bulk-open-freeze`                  | package entry                      |

---

## Safety

- Both harnesses default to `HIVEWARD_FREEZE_CREATE=0`. A positive value creates persistent, high-output remote terminals; use it only on an isolated target you can clean up.
- `restart-proxy` does **not** kill HiveWard; it runs `hiveward open` + refresh RPCs only.
- Manual capture if UI fully freezes: `sample HiveWard 5 -file ~/Desktop/hiveward-freeze-sample.txt`

The scripts honor `HIVEWARD_CLI_COMMAND`, then use `hiveward-dev` in a dev runtime, `hiveward-ide` on Linux, and `hiveward` elsewhere.

PowerShell equivalent for the first example:

```powershell
$env:HIVEWARD_FREEZE_ENV = 'paired-remote'
$env:HIVEWARD_FREEZE_SCENARIO = 'idle-backlog-open'
$env:HIVEWARD_FREEZE_CREATE = '8'
$env:HIVEWARD_FREEZE_IDLE_MS = '45000'
$env:HIVEWARD_FREEZE_OPEN_COUNT = '24'
pnpm run repro:live-remote-realistic-freeze
```
