# HiveWard Agent Rules

These rules apply to this repository and all child directories. Follow them in new windows, resumed threads, and fresh agent sessions.

## PR Writing Rules

- Before creating or updating a PR, inspect the recent remote PRs in the same release train and match their title, body structure, base-branch convention, version naming, and validation style.
- Release PR titles must follow the established format: `Release: <lowercase intent phrase> as v<major>.<minor>.<patch>`.
- A release PR body must include these sections unless the current release train has a clearly different standard: `Summary / 摘要`, `Version / 版本`, `Root Cause / 根因`, `Changes / 变更`, `Size / 规模`, `Validation / 验证`, and `Notes / 备注`.
- PR bodies must be bilingual when the release train uses bilingual explanations. English and Chinese must have the same section structure and the same facts. Do not write detailed English sections and then only a loose Chinese summary.
- If an English bullet mentions behavior, scope, tests, version, base branch, risk, or remaining work, the Chinese side must include the same information in plain Chinese.
- Keep version metadata aligned with the PR title and body. If the PR says `v0.5.19`, package versions and lockfile versions must also say `0.5.19`, unless the PR explicitly explains why there is no version bump.
- Recompute PR size from the actual diff against the intended base branch. Do not reuse stale file counts, insertion counts, or deletion counts.
- Validation entries must state exactly what was run and when. If a full test/build was run before a metadata-only change, say that plainly instead of implying it was rerun after the metadata change.
- Document the intended base branch when the release train is stacked or when remote `main` is behind the active release baseline.
- Exclude local test artifacts, logs, generated workspaces, and unrelated documentation from feature PRs unless the user explicitly asks to include them.

## Model Output Governance

- HiveWard is a scheduling and orchestration layer first. The platform owns routing, lifecycle state, persistence, permissions, and declared output publication; Agents and Managers own judgment, strategy, content, tradeoffs, and expression.
- Platform code should enforce deterministic product contracts only: scheduling semantics, lifecycle integrity, security boundaries, persistence correctness, and artifact publication contracts.
- Model and harness behavior limits must be expressed through prompts, role contracts, output schemas, examples, and structured context.
- Workflow-specific model behavior constraints belong in that workflow's prompts, role contracts, schemas, and examples, not in broad project engineering rules, unless they define a deterministic platform scheduling or lifecycle contract.
- Do not add platform code to reinterpret, normalize, or correct weak model or harness output merely to make it look better. Bad AI output should be rejected, re-prompted, or surfaced; model-output mistakes are prompt/output-contract problems unless they violate core product semantics or safety.
- Do not add compatibility logic merely to guess model intent or patch over ordinary formatting mistakes. Treat model-output shape mistakes as prompt/output-contract problems.
- When behavior is wrong because the underlying lifecycle, state model, orchestration boundary, or module contract is wrong, fix the underlying design. This applies across frontend, backend, worker, store, and shared packages. Preserve module-level logical consistency instead of using quick patches to cover exposed chain breaks or errors.
- Prefer clear contracts over hidden heuristics. System-level behavior must be explicit in configuration, typed system interfaces, context, or prompts; do not infer important semantics from names, labels, ordinary slot positions, or incidental graph shape.
- Keep AI decision space open inside clear boundaries. Avoid hard-coding decisions that should naturally belong to an Agent or Manager, such as whether more research is needed, how to scope a plan, what risks matter, or how to explain a result.
- Restrictions on model output shape must be handled primarily through prompts, output contracts, and examples.
- Runtime validation should guard only core product semantics, safety boundaries, and unrecoverable data consistency issues.
- When reporting a completed change, explicitly classify it as prompt-level, program-level, or mixed. Prompt-level changes adjust model behavior through prompts, schemas, examples, or role contracts. Program-level changes alter scheduling, lifecycle, persistence, permissions, UI, or deterministic product contracts. Mixed changes must name both sides and keep their responsibilities separate.
- Completion reports for code/documentation work must include a concise "Change classification" section with three explicit buckets:
  - `Program-level`: list deterministic platform/code changes, including scheduling, lifecycle, persistence, permissions, UI, APIs, runtime behavior, tests, and other product contracts. If none, write `Program-level: none`.
  - `Prompt-level`: list prompt, skill, schema, example, role contract, and model-output-contract changes. If none, write `Prompt-level: none`.
  - `Mixed`: list files or changes that intentionally bridge both sides, and explain which responsibility is program-level and which is prompt-level. If none, write `Mixed: none`.
- Do not use only the word "mixed" as the completion classification when both kinds of changes exist. Report the mixed classification plus the concrete program-level and prompt-level contents separately so future agents and reviewers can see which responsibility moved where.
- After the standard engineering report, add a Chinese plain-language section titled `说人话`. This section must be more than a one-sentence simplification: explain the whole problem, what changed, why it matters, what the user should now understand about the project, which program-level changes are temporary patches, and which changes fix the underlying design or product contract successfully.
