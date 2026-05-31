# HiveWard Agent Rules

These rules apply to this repository and all child directories. Follow them in new windows, resumed threads, and fresh agent sessions.

## 提示词交接规则

- 写给下一位 Agent 或工程师的提示词、任务说明、实现提示词、交接说明之前，必须先阅读当前工作范围适用的 `AGENTS.md`，并按其中规则组织交接内容。
- 写给下一位 Agent 或工程师的提示词和需求包，必须放进一个完整的 Markdown 代码块，保证可以一次复制。
- 如果交接提示词里会包含代码示例、命令示例或任何三反引号代码块，外层必须使用四反引号或更长的 Markdown 围栏，例如 ````markdown；内部代码块只能使用比外层更短的围栏，避免外层代码块被提前关闭。
- 如果不确定交接提示词里会不会出现内部代码块，默认使用四反引号外层围栏。
- 交接提示词和任务说明默认用中文，包括章节名、标签、验收标准和验证说明；除非用户明确要求使用其他语言。
- Markdown 代码块外只写给当前用户看的说明，不放下一位 Agent 必须执行的要求。
- 不要把下一位 Agent 需要遵守的要求拆在普通文字和代码块两处；下一位 Agent 需要看的内容必须全部放进同一个 Markdown 代码块。
- 输出前必须检查：外层围栏关闭之后，不能再出现任何给下一位 Agent 或工程师看的要求、代码、验收标准、验证命令或补充说明。
- 当用户要求“给工程师的提示词”“给下一个 Agent 的提示词”“可复制任务包”时，回答里只能有一个给对方复制的 Markdown 代码块；不要再额外输出第二个代码块演示正确格式。
- `变更分类`、`说人话`、测试结果、当前进度说明只属于当前用户可读汇报，不属于给工程师复制的提示词；除非用户明确要求把这些内容也交给工程师，否则不要放进交接代码块。
- 如果同一轮既修改了文件又要交付工程师提示词，先用普通文字简短说明本轮已改什么，再给一个且只有一个可复制提示词代码块；代码块关闭后不要追加给工程师看的内容。

## PR 提交流程规则

- 用户说“TPR”“提 PR”“开 PR”“发 PR”“把这个 PR 一下”时，默认理解为把当前分支的相关改动提交、推送到远端并创建 Pull Request；如果工作树里混有明显无关改动，必须先说明范围并只暂存本次相关文件。
- 提 PR 前必须检查当前分支、远端、工作树和 diff：至少运行 `git status --short --branch`、查看相关 `git diff`，并确认没有误收用户未要求的改动。
- 提 PR 前必须查看远端仓库的 PR 规则和近期 PR 格式：优先检查 `.github/pull_request_template*`；如果没有模板，则参考远端最近已合并或已关闭 PR 的标题和正文结构。
- 当前 HiveWard 远端 PR 的通用格式以近期 PR 为准：发布型 PR 标题使用 `Release: ... as vX.Y.Z`；非发布型 PR 可使用简洁的 `[codex] ...` 或用户指定标题。
- PR 正文默认使用远端近期 PR 的双语结构：先 `## English`，再 `## 中文`。英文区包含 `### Summary`、必要时的 `### Version`、`### Changes`、修复类改动的 `### Root Cause`、`### Validation`、`### Notes`；中文区对应包含 `### 摘要`、必要时的 `### 版本`、`### 主要变更`、修复类改动的 `### 根因`、`### 验证`、`### 备注`。
- 如果 PR 是小型非发布改动，仍要覆盖同样信息密度：改了什么、为什么改、影响范围、验证结果、已知限制；可以省略确实不适用的 Version/版本，但不能省略验证说明。
- 创建 PR 前必须先完成本地验证。若验证被环境问题阻塞，PR 正文和最终汇报必须明确写出具体命令、失败原因、是否与本次改动有关，以及已执行的替代验证。
- 默认创建 Draft PR，除非用户明确要求 ready for review 或远端既有流程明显要求非 draft release PR。
- `gh` 可用且已认证时可以用 `gh` 创建 PR；如果 `gh` 不存在或未认证，但 GitHub connector 可用，可以通过 GitHub connector 创建 PR，并在 PR Notes/备注里说明创建方式。
- PR 创建完成后的汇报必须包含分支名、提交哈希、PR 链接、目标分支、验证结果和任何环境限制；代码或文档工作仍必须按本文件的 `变更分类` 与 `说人话` 规则收尾。

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
- 汇报已完成的改动时，必须明确归类为 `程序层`、`提示词层` 或 `混合`。`提示词层` 指通过提示词、结构化输出要求、示例、角色契约来影响模型行为；`程序层` 指改变调度、生命周期、持久化、权限、界面、接口、运行时行为、测试或确定性产品契约；`混合` 必须分别说清楚哪部分属于程序层、哪部分属于提示词层。
- 代码或文档工作的完成汇报必须包含一个中文小节，标题为 `变更分类`，并按下面三个桶输出：
  - `程序层`: 写确定性平台/代码改动，包括调度、生命周期、持久化、权限、界面、接口、运行时行为、测试和其他产品契约；如果没有，写 `程序层: 无`。
  - `提示词层`: 写提示词、skill、结构化输出要求、示例、角色契约和模型输出契约的改动；如果没有，写 `提示词层: 无`。
  - `混合`: 写同时连接程序层和提示词层的文件或改动，并分别解释程序层责任和提示词层责任；如果没有，写 `混合: 无`。
- 不能只用 `混合` 两个字带过同时包含两类责任的改动。必须同时列出具体的程序层内容和提示词层内容，让后续 Agent 和评审者看清楚责任边界。
- 标准工程汇报之后，必须增加一个中文小节，标题为 `说人话`。这个小节不能只写一句简化版，必须说明完整问题、改了什么、为什么重要、用户现在应该怎么理解这个项目、哪些程序层改动只是临时补丁、哪些改动真正修好了底层设计或产品契约。
