# Approval Thread Contract

## Purpose

Approval threads are the single conversation and lifecycle contract for HiveWard approvals. A reply or comment is always message-only. Only explicit lifecycle decisions can advance, end, or recalculate workflow state.

This document records the architecture, API surface, migration notes, test matrix, and prompt boundary for the approval thread refactor.

## Core Model

- `ApprovalThread` is the stable discussion container for one approval concern. Revised requests stay in the same thread when they share the same approval concern.
- `ApprovalReply` is an append-only message fact. It stores user, agent, manager, or system text and optional provenance metadata.
- `ApprovalRequest` is the current approvable request fact. It carries kind, revision, capabilities, run/node references, and request status.
- `ApprovalDecision` is the lifecycle action fact. Decisions record actions such as `approve`, `reject`, `complete`, `terminate`, `request_changes`, or `revise`.
- `ManagerMail` is a rebuildable projection from approval facts. It must not become the source of truth for approval status.

## Action Matrix

| Action | Lifecycle effect | Allowed side effects |
| --- | --- | --- |
| `reply` / comment | Append a message only. Keep request and thread lifecycle unchanged. | Store a reply fact, update thread activity time, refresh read projections. |
| `approve` | Accept the current request and run the deterministic next step for that request kind. | Resume execution, import an approved proposal, accept an agent output, or move a self-iteration round forward when that kind permits it. |
| `complete` | Mark the approval target complete. | End the relevant round, session, run, or approval thread when the request kind permits it. |
| `terminate` | Explicitly stop the workflow. | Record the reason and end the related run, session, or thread. |
| `reject` | Deny the current request. | Close the current request. Do not implicitly rerun, revise, or continue execution. |
| `request_changes` | Explicitly request changes to an Agent proposal. | May supersede the current request and rerun the Agent node into a new pending request in the same thread when the request kind permits it. |
| `revise` | Explicitly ask the platform to regenerate a governed plan or report. | May supersede the current request and create a revised requirement plan or release report in the same thread when the request kind permits it. |

`reply` must not call a harness, schedule a worker, create the next round, generate a revised request, import a blueprint, complete a run, terminate a run, or return a resume signal.

## API Surface

Native thread reads:

- `GET /api/approval-threads?runId=<runId>&status=open|closed`
- `GET /api/approval-threads/:approvalThreadId`
- `GET /api/approval-threads/:approvalThreadId/replies`

Request actions:

- `POST /api/approval-requests/:approvalRequestId/approve` accepts the current request and may resume deterministic workflow.
- `POST /api/approval-requests/:approvalRequestId/reject` rejects the current request without implicitly revising or rerunning work.
- `POST /api/approval-requests/:approvalRequestId/reply` appends a thread reply and returns the still-current request, thread, replies, and decisions.
- `POST /api/approval-requests/:approvalRequestId/complete` completes a request when the capability allows it.
- `POST /api/approval-requests/:approvalRequestId/terminate` terminates a request when the capability allows it.
- `POST /api/approval-requests/:approvalRequestId/request-changes` explicitly requests changes when `requestChanges` is allowed.
- `POST /api/approval-requests/:approvalRequestId/revise` explicitly regenerates the request when `revise` is allowed.

Thread endpoints are read and aggregation surfaces. Request endpoints are the only lifecycle action write surface; clients must not infer that a thread-level read API can mutate approval lifecycle.

Compatibility facades:

- `POST /api/inbox/:itemId/reply` appends an inbox reply and, for approval-backed inbox items, appends the matching approval reply/decision without advancing lifecycle.
- `POST /api/blueprint-runs/:runId/reply` resolves the run-level waiting approval and delegates to the append-only reply path.
- Legacy pending approval views should derive their thread id from `approvalThreadId` / `threadId`, not from display titles or list positions.

## Persistence And Migration

- SQLite is the primary durable store. Approval threads and replies are stored separately from approval requests and decisions.
- SQLite migration `approval_threads` creates `approval_threads` and unified `approval_replies`.
- SQLite migration `approval_reply_metadata` adds `approval_replies.metadata_json` and backfills legacy reply rows with `legacySource`, `legacyAction`, `legacyMeaning`, and `requestKind`.
- New reply rows derived from decisions carry metadata linking them back to the source decision, request kind, and resulting status.
- File-store loading backfills missing approval threads and reply projections from existing approval request/decision facts.
- `ManagerMail` is rebuilt from approval facts as a compatibility projection. Projection drift must not mutate `ApprovalThread`, `ApprovalRequest`, `ApprovalDecision`, or `ApprovalReply` facts.

## Test Matrix

Minimum verification for this contract:

- Shared action semantics: `npm test -- packages/shared/src/lifecycle.test.ts`
- Store append-only reply and thread facts: `npm test -- apps/api/src/services/lifecycleServices.test.ts`
- SQLite migrations and metadata backfill: `npm test -- apps/api/src/store/sqlite/sqliteDriver.test.ts`
- Store contract parity: `npm test -- apps/api/src/store/sqlite/sqliteStoreContract.test.ts`
- File-store compatibility backfill: `npm test -- apps/api/src/store/fileHivewardStore.test.ts`
- API thread and facade behavior: `npm test -- apps/api/src/routes/apiRouter.test.ts --testNamePattern approval`
- Worker lifecycle split: `npm test -- apps/api/src/worker/blueprintWorker.test.ts --testNamePattern "approval replies|release report rejection|Agent approval rejection|requirement approval open"`
- UI stable thread rendering: `npm test -- apps/web/src/components/WorkspacePages.test.tsx --testNamePattern ApprovalsPage`
- Run-state derivation: `npm test -- apps/web/src/lib/run-state.test.ts`
- Type contracts: `npm run typecheck -w @hiveward/shared`, `npm run typecheck -w @hiveward/api`, and `npm run typecheck -w @hiveward/web`

## Prompt And Role Contract

HiveWard platform code owns routing, lifecycle state, persistence, permissions, and declared publication. Harness agents, Manager prompts, CEO role prompts, and Leader role prompts own judgment, content, tradeoffs, and expression only.

Role agents may:

- Draft feedback, revision notes, summaries, proposals, reports, and approval-facing text.
- Explain what approval action a human should consider next.
- Submit a governed inbox proposal only through the documented `hiveward-inbox` block or a real platform API/tool.

Role agents must not:

- Claim that a reply approved, completed, terminated, imported, reran, revised, or advanced anything.
- Treat natural-language feedback as an implicit `approve`, `complete`, `terminate`, `request_changes`, or `revise` action.
- Claim a blueprint, run, round, approval, or inbox item changed unless HiveWard confirms the platform action.
- Hide lifecycle changes inside report prose, reply text, or Manager reasoning.

If a human provides feedback without using an explicit lifecycle action, the correct statement is that the feedback was recorded and the approval remains pending. If the product needs "reject and change" behavior, it must use the explicit capability-gated `request_changes` or `revise` action; natural-language feedback alone is never a lifecycle action.
