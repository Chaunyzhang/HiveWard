---
name: hiveward-orchestration
description: >-
  Run work in separate HiveWard worker agents and get their results back. Use when
  the user asks for HiveWard workers or supervision (monitor, task DAGs, ask/reply,
  decision gates), or when the work needs something your own subagents cannot
  give: a different agent (such as Codex from Claude) or its own HiveWard workspace.
  "Have Codex (or Claude) review this and report back" means an HiveWard worker of
  that agent, even when you have your own model subagents.
  Also use when you are a dispatched worker (a prompt with Task and Dispatch
  IDs: ask, worker_done). Otherwise prefer your own subagents,
  including for long or parallel work. Use `hiveward-cli` to hand work off with
  nothing expected back ("hand off", "handover", "give this to another agent",
  "another worktree"), and for terminal control, shell commands, worktree
  management, and reading or waiting on terminals.
---

# HiveWard Orchestration

This file is a discovery stub, not the usage guide. The full, version-matched HiveWard
hiveward-orchestration reference is served by the `hiwd` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

Use HiveWard hiveward-orchestration to run work in separate HiveWard worker agents and get their results
back: when the user asks for HiveWard workers or supervision (monitor, task DAGs, ask/reply,
decision gates), or when the work needs something your own subagents cannot give, such as a
different agent or its own HiveWard workspace. "Have Codex (or Claude) review this and report
back" means an HiveWard worker of that agent, even when you have your own model subagents. Use
it as well when you are a dispatched worker sending `ask` questions or `worker_done`. Otherwise prefer your own subagents,
including for long or parallel work. Use the hiveward-cli skill instead to hand work off with
nothing expected back ("hand off", "handoff", "handover", "give this to another agent",
"another worktree"), and for ordinary terminal control, shell commands, worktree management,
and the built-in browser. Coordination requires real HiveWard runtime state; never substitute a
non-HiveWard subagent tool when the user asked for HiveWard hiveward-orchestration.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `HIVEWARD_CLI_COMMAND` environment variable is set, use its value. HiveWard exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `HIVEWARD_DEV_REPO_ROOT`, use `hiveward-dev`.
- Otherwise, use `hiwd` (`hiveward` is the same command).

Below, `HIVEWARD` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `HIVEWARD` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different HiveWard build.

## Load the version-matched guide before running HiveWard commands

```text
HIVEWARD skills get hiveward-orchestration
```

That prints the compact, version-matched guide for the exact binary that will handle your
next commands. It covers the normal local coordinator loop and dispatched-worker
obligations. For a conditional action gate such as remote placement, uncertain release
recovery, or expanded DAG work, load only the reference that gate names with
`HIVEWARD skills get hiveward-orchestration --reference references/<file>.md`
(`--references` lists the names). If that binary rejects `--reference`, run
`HIVEWARD skills get hiveward-orchestration --full` and read the named bundled reference before acting.

Use the selected executable's `--help` for commands or flags the guide does not cover. If a
command reports that HiveWard is not running, start it with `HIVEWARD open --json` and retry. If it
fails with `runtime_access_denied`, your sandbox blocked the connection: re-run it with
escalated permissions, and do not run `HIVEWARD open` or restart HiveWard. If `skills get` is unknown,
explain that updating HiveWard restores the guide; use `--help` for read-only discovery and do not
guess unsupported commands.
