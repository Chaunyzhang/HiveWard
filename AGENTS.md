# HiveWard Agent Rules

These rules apply to this repository and every child directory.

## 1. Authority

- Follow system, developer, user, then `AGENTS.md` instructions in that order.
- Follow deeper `AGENTS.md` files over higher-level files.
- Treat newer user instructions as current truth when they conflict with older ones.
- Do not revert or overwrite user changes unless the user explicitly asks.

## 2. Clean Refactor Rule

- Before writing any engineering prompt, ask the user to confirm the work mode.
- Treat all refactor, rebuild, foundation, lifecycle, scheduler, execution, persistence, session, approval, security, or API-contract work as `Clean Foundation Strict` unless the user explicitly asks to preserve compatibility.

In `Clean Foundation Strict`:

- Delete all non-canonical logic.
- Do not keep legacy routes, fields, actions, fallbacks, wrappers, aliases, UI branches, projection paths, tests, old owners, heuristic inference, or compatibility code.
- Existing code is not evidence that compatibility is required.
- Retention requires explicit user permission for the exact retained item.
- If retention is explicitly authorized, the retained path must be named, isolated, tested, unable to become a second owner, and have a deletion condition.
- Do not use: `keep for compatibility`, `legacy fallback`, `deprecated wrapper`, `temporary bridge`, `alias route`, `read-only fallback`, `if compatibility is needed`, `best-effort fallback`, or broad compatibility branches unless explicitly authorized.
- Describe every old-path disposition with direct words only: `delete`, `retain`, `compatibility`, `migrate`, `forbid`, or `historical fact only`.
- Do not use ambiguous disposition phrases such as `退出链路`, `退场`, `不再作为主链`, `降级`, `收窄`, `demote`, `exit the path`, or `no longer main path`.
- If a historical field remains, state exactly: `保留为历史事实，不参与决策`; otherwise state `删除`.

Every clean refactor plan or prompt must state:

- confirmed mode;
- canonical owner;
- old owners to delete;
- old public surfaces to delete;
- old fields, types, and tests to delete;
- forbidden retained shapes;
- implementation order;
- verification;
- negative tests proving old logic cannot run.

## 3. Architecture-First Rules

- Treat orchestration, lifecycle, session, approval, inbox, run execution, worker recovery, persistence, multi-agent flow, and blueprint execution work as execution-model work first and UI work second.
- Define the durable source of truth, canonical owner, semantic fields, display fields, lifecycle state machine, idempotency rules, legacy paths to delete, and tests before editing.
- Implement from source of truth outward: shared contracts, persistence/schema/migration, service/worker owner, API/projection, frontend projection/UI, tests/gates.
- Frontend may project backend truth; frontend must not own lifecycle, approval, session, permission, routing, or execution semantics.
- Prefer one resolver, one owner, and one persisted record.
- Do not fix contract bugs with UI masking, prompt-only wording, catch-all types, label inference, string-prefix inference, graph-position inference, or hidden fallback branches.
- Every lifecycle or orchestration change must prove idempotency for resume, refresh, retry, worker restart, and repeated approval actions.

## 4. Model Output Governance

- HiveWard is a scheduling and orchestration layer first.
- Platform code owns routing, lifecycle, persistence, permissions, security boundaries, and declared artifact publication.
- Agents and Managers own judgment, strategy, content, tradeoffs, and expression inside explicit contracts.
- Enforce deterministic product contracts in code.
- Govern model behavior with prompts, role contracts, schemas, examples, and structured context.
- Do not add platform code to reinterpret, normalize, or repair weak model output unless core product semantics, safety, or unrecoverable data consistency requires it.
- Bad model output should be rejected, re-prompted, or surfaced.
- Keep AI decision space open inside clear deterministic boundaries.

## 5. Engineering Prompt Rules

- Inspect relevant code and `AGENTS.md` before writing implementation prompts; then identify the work mode, recommend it, and ask the user to confirm.
- Do not ask the user to confirm before reading the code when the answer can be grounded by repo context.
- For any substantial prompt, create a repo-local handoff file.
- Put all instructions for the next engineer inside one copyable Markdown block or handoff file.
- Text outside the block or file is only user-facing explanation and must not contain hidden requirements.
- Write engineering prompts in Chinese by default; keep code identifiers unchanged.
- Start every prompt with: read `AGENTS.md`, inspect referenced code, follow the document in order, do not skip sections, keep scope tight, avoid guessing, verify every claim, and report deviations.
- Do not let the engineer infer architecture.
- Do not give optional compatibility paths in `Clean Foundation Strict`.
- Define every important field, type, mode, lifecycle state, and product term by responsibility, allowed values, business meaning, producers, consumers, storage, UI projection, permitted actions, forbidden actions, and tests.
- Separate product semantics from engineering mechanics.
- Include a coverage inventory for touched features: concepts, fields, allowed values, producers, consumers, APIs, persistence, frontend state, UI controls, lifecycle transitions, tests, and legacy paths to delete.
- Include a `Forbidden Shapes` section for repeated failure modes.
- After every engineering prompt, add a separate user-facing section named `人话提示词解释`; explain what the prompt asks the engineer to do, why it is written that way, and how it maps to the confirmed mode.
- After every engineering prompt, add a separate user-facing section named `提示词自检报告`; explicitly state whether the prompt fully follows these rules, list any deviations or `none`, and provide strong evidence points from the prompt such as confirmed mode, canonical owner, deletion list, forbidden shapes, verification, and negative tests.

## 6. Verification

- Verify before claiming completion.
- Use targeted tests for changed behavior, then typecheck/lint/build/full tests as appropriate.
- For architecture, lifecycle, persistence, execution, session, approval, or security work, include negative tests proving old or invalid paths cannot decide behavior.
- Source-text checks alone are insufficient for behavior claims.
- If verification cannot run, state the exact command, blocker, next-best check, and remaining risk.
- Do not claim completion with known failing relevant tests.

Required negative tests for clean refactor work must prove old logic cannot:

- execute;
- resume;
- approve;
- reject;
- reply;
- select;
- mutate state;
- project normal capability;
- decide lifecycle;
- decide permissions;
- decide runtime/session identity;
- appear as a normal UI action.

## 7. PR Rules

- Before creating or updating a PR, inspect recent remote PRs in the same release train and match title, body, base branch, version naming, bilingual structure, validation style, and section order.
- Release PR titles use: `Release: <lowercase intent phrase> as v<major>.<minor>.<patch>`.
- Release PR bodies must use the release-train bilingual block format, unless the current train proves a different standard:
  - English block first with English-only headings: `Summary`, `Version`, `Root Cause`, `Changes`, `Size`, `Validation`, and `Notes`.
  - Then a Markdown divider line: `---`.
  - Then Chinese block starting with `中文`, followed by Chinese-only headings: `摘要`, `版本`, `根因`, `主要变更`, `规模`, `验证`, and `备注`.
- Do not use mixed bilingual section headings such as `Summary / 摘要`, `Version / 版本`, or `Validation / 验证` in release PR bodies.
- Do not use per-section language labels such as `English:`, `中文：`, `### English`, or `### 中文`.
- Do not interleave one English bullet with one Chinese bullet. Write the complete English PR body first, then the complete Chinese PR body after the divider.
- English and Chinese PR blocks must contain the same facts, in the same section order, with equivalent validation evidence, size numbers, version numbers, base-branch notes, risks, and remaining-work statements.
- Align title, body, package versions, and lockfile versions.
- Choose patch bumps for narrow compatible changes; choose minor bumps for broad user-facing, schema, storage, API, lifecycle, orchestration, or multi-package contract changes.
- Recompute PR size from the actual diff against the intended base.
- Validation must state exact commands and timing.
- Document stacked or non-main base branches.
- Before staging, committing, pushing, or opening a PR, audit `git status --short`, `git diff --name-status`, `git diff --stat`, and every changed file.
- Exclude local databases, runtime data, generated workspaces, `.omx/state`, `.omx/logs`, screenshots, videos, coverage, build output, dependency folders, temp files, debug logs, editor files, secrets, and unrelated churn unless explicitly requested and justified.

## 8. Commit Rules

Every commit message must use the Lore protocol:

```text
<intent line: why the change was made, not what changed>

<optional concise body: constraints and approach rationale>

Constraint: <external constraint that shaped the decision>
Rejected: <alternative considered> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <warning for future modifiers>
Tested: <what was verified>
Not-tested: <known verification gaps>
```

- Use trailers only when they add decision context.
- Use `Rejected:` for alternatives future agents should not re-explore.
- Use `Directive:` for warnings future agents must respect.

## 9. State And Safety

- Treat `.omx/state`, `.omx/logs`, generated local data, temp files, and runtime artifacts as non-product unless explicitly requested.
- Do not submit local artifacts or unrelated dirty changes.
- Do not use destructive git or filesystem commands unless explicitly requested.
- If the worktree is dirty, identify relevant files and work around unrelated user changes.
- Use `rg` for search when available.
- Prefer structured parsers and typed APIs over ad hoc string manipulation.

## 10. Completion Report

Every code, document, prompt, or PR completion report must include:

- changed files;
- verification commands and results;
- remaining risks or `none`;
- `Change classification`;
- `用人话翻译`.

`Change classification` must contain:

- `Program-level`: deterministic platform/code changes, or `none`.
- `Prompt-level`: prompts, skills, schemas, examples, role contracts, model-output contracts, or `none`.
- `Mixed`: files or changes bridging both, with responsibilities separated, or `none`.

`用人话翻译` must translate the whole technical report into plain Chinese. It is not a short casual summary. It must explain:

- the actual problem;
- what changed;
- why it matters;
- what the user should understand now;
- how each important technical term maps to product meaning;
- every field name and English technical term with Chinese translation and plain-language meaning;
- relationships between fields, types, files, and modules when many appear;
- a Markdown folder/tree diagram when file/module relationships matter;
- what the verification proves and does not prove;
- which changes are temporary patches;
- which changes fix the underlying design or product contract.

## 11. Review Rules

- For review requests, lead with findings ordered by severity.
- Use concrete file and line references.
- Focus on bugs, regressions, missing tests, lifecycle breaks, contract drift, data loss, security risks, and old owners re-entering normal paths.
- If no findings, say so and state residual test gaps.
