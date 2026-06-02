# Next Stage Runtime Provider Adapter Notes

## Decision

下一阶段要做的是 `Runtime Provider Layer`，不是把 OpenClaw / Hermes 单独做成和投影层平级的特殊层。

所有 runtime provider 平级：

```text
Runtime Provider Layer
├─ OpenClaw Adapter
│  └─ OpenClaw native session / agent / transcript
├─ Hermes Adapter
│  └─ Hermes profile / session / transcript
├─ Codex Adapter
│  └─ Codex thread / session / transcript
├─ Claude Code Adapter
│  └─ Claude native session / transcript
├─ Google Adapter
├─ Cursor Adapter
└─ OpenCode Adapter
```

`NativeConsoleProjection` 是更上层的统一投影，不和 provider adapter 平级：

```text
HiveWard Core
├─ RunCommand
├─ RunCommandStep
├─ ApprovalRequest
├─ NodeExecutionSession
└─ Permission / Lifecycle

Runtime Provider Layer
├─ OpenClaw Adapter
├─ Hermes Adapter
├─ Codex Adapter
├─ Claude Code Adapter
├─ Google Adapter
├─ Cursor Adapter
└─ OpenCode Adapter

Unified Projection Layer
├─ RuntimeSessionProjection
├─ NativeConsoleProjection
└─ ExecutionTraceProjection
```

## Adapter Contract Direction

Each provider adapter should expose the same conceptual contract, with optional capabilities declared explicitly:

- `startTask`
- `waitForTask`
- `cancelTask`
- `resumeTask` / `resumeSession`
- `listNativeSessions`
- `getNativeTranscript`
- `getResumeProof`

Optional capability absence must be explicit. Do not infer support from provider name, session key shape, CLI output labels, or local wrapper names.

## Disposition Rules

- `保留`: each provider's native session, agent, profile, thread, and transcript concepts inside that provider adapter.
- `兼容`: provider-native console experiences through adapter-specific optional capabilities and unified projection.
- `禁止`: any provider bypassing HiveWard core lifecycle, approval, permission, run command, or command step ownership.
- `删除`: fake proof paths that write `sessionKey`, task id, nodeRun id, agent id, or profile id as `nativeSessionId` without provider proof.
- `保留为历史事实，不参与决策`: raw provider session records when they cannot prove resumability through the adapter contract.

## Provider Notes

| Provider | Adapter responsibility |
| --- | --- |
| `OpenClaw` | Gateway session list, agent session, transcript, agent id, resume proof if gateway can prove same-session continuation. |
| `Hermes` | Profile id, agent alias resolution, CLI/native session id, transcript, resume proof if Hermes can prove same-session continuation. |
| `Codex` | Thread id, SDK resume proof, transcript/session metadata. |
| `Claude Code` | Native session id, SDK/CLI resume proof, transcript/session metadata. |
| `Google` | CLI session id, resume argument, output parser, proof limits. |
| `Cursor` | Stream-json session id, resume argument, proof limits. |
| `OpenCode` | Session argument, workspace run output, proof limits. |

## Core Boundary

Provider adapters may report native facts. They must not decide HiveWard lifecycle.

HiveWard core remains the owner for:

- `RunCommand`
- `RunCommandStep`
- `ApprovalRequest`
- `ApprovalDecision`
- permission checks
- lifecycle transitions
- execution trace truth

Provider-native console projection may display and continue provider sessions only through the adapter contract. It must not become a second lifecycle owner.

## One-Sentence Handoff

下一阶段请按 `D:\HiveWard-execution-rebuild-stack\docs\next-stage-runtime-provider-adapter-notes.md` 设计 Runtime Provider Layer：OpenClaw、Hermes、Codex、Claude Code、Google、Cursor、OpenCode 都是平级 provider adapter，NativeConsoleProjection 是上层统一投影；保留 provider 原生会话能力，兼容原生控制台体验，禁止绕过 HiveWard core，删除无 provider proof 的假 `nativeSessionId`。
