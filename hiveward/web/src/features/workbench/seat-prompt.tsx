import type { BusinessSummary, Machine, Project } from '@shared/api'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'
import { useMachineId, useMachines } from '@/lib/machine'

/**
 * 空座位的「复制提示词」：老板把它贴进自己正在用的 Agent（Claude Code / Codex 会话），
 * 那个 Agent 没有上下文也能照着坐上来——写清楚是哪台电脑、哪块业务、哪个项目、哪个座位，
 * 用哪条命令坐、坐上后干什么、什么时候离座。
 */
export function CopySeatPrompt({
  business,
  project,
}: {
  business: BusinessSummary
  /** 给了就是这个项目的 Leader 位，不给是业务的 CEO 位 */
  project?: Project
}) {
  const machineId = useMachineId()
  const { data: machines } = useMachines()
  const machine = machineId
    ? machines?.find((m) => m.id === machineId)
    : machines?.find((m) => m.self)
  return (
    <button
      type='button'
      onClick={() => {
        void navigator.clipboard
          .writeText(seatPrompt({ business, project, machine }))
          .then(
            () => toast.success(tr('提示词已复制，贴给你正在用的 Agent 就行')),
            () => toast.error(tr('没复制成，再点一次试试'))
          )
      }}
      className='flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90'
    >
      <Copy className='size-3.5' />
      {tr('复制提示词')}
    </button>
  )
}

function seatPrompt({
  business: b,
  project: p,
  machine,
}: {
  business: BusinessSummary
  project?: Project
  machine?: Machine
}) {
  const seat = p
    ? `「${b.name}」业务里「${p.name}」项目的 Leader 位`
    : `「${b.name}」业务的 CEO 位`
  const command = p
    ? `hiwd seat leader --business ${b.id} --project ${p.id}`
    : `hiwd seat ceo --business ${b.id}`
  const where = machine
    ? `${machine.name}${machine.self ? '（就是开着 HiveWard 的这台）' : '（局域网里的那台，不是我手上这台）'}`
    : '开着 HiveWard 的这台电脑'
  const win = machine?.platform === 'win32'
  const projects = (b.projects ?? []).filter((x) => x.status !== 'archived')
  const projectLines = projects.length
    ? projects
        .map(
          (x) =>
            `  - ${x.name}（id：${x.id}）：Leader ${x.leader ? `${x.leader.agent} 坐着` : '空位'}；目录 ${x.path}`
        )
        .join('\n')
    : '  - 还没有项目'

  const role = p
    ? `Leader 带「${p.name}」这一个项目：接 CEO 或我派来的活，拆开后用 hiwd new 派给下属 Agent，下属交活后复核，再把结果汇报上去。`
    : `CEO 管整块业务：派单、增减项目、复核下属交上来的活。CEO 不亲自写代码、不干具体的活；属于某个项目的活交给那个项目的 Leader，不属于任何项目的活直接派下属 Agent。`

  return `请你去坐 HiveWard 里${seat}。

【背景】
HiveWard 是我（老板）的一人公司驾驶舱：把我在各块业务里用的 AI Agent 组织成「业务 → CEO → 项目 Leader → 下属 Agent」的架构，在网页上能看到谁在干什么、派了什么活、交没交。每块业务有一个 CEO 位，每个项目有一个 Leader 位，座位常驻、坐的 Agent 可以换。
${role}

【要坐的座位】
- 电脑：${where}
- 业务：${b.name}（id：${b.id}）
- 业务目录：${b.workspacePath}
${p ? `- 项目：${p.name}（id：${p.id}）\n- 项目目录：${p.path}\n` : ''}- 这块业务现在的项目：
${projectLines}

【怎么坐上去】
1. 这件事必须在你自己这个会话里做：只有 Claude Code 和 ChatGPT（Codex 命令行）的会话能这样坐（HiveWard 靠 CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID 认出你，靠你会话的工作目录找到你的对话记录）。所以直接在你会话当前的工作目录里执行命令，不要先 cd 到别处，也不要开新终端、子进程或别的程序代跑。你如果不是 Claude Code / ChatGPT，就告诉我，我在 HiveWard 网页上给这个座位开一个终端。
2. 先确认能用 hiwd（HiveWard 自带的命令行）：执行 \`hiwd --help\`。${
    win
      ? tr(
          '找不到就到 HiveWard 安装目录的 resources\\hiveward\\server\\hiwd.mjs，用 node 跑它。'
        )
      : '找不到就用 `node /Applications/HiveWard.app/Contents/Resources/hiveward/server/hiwd.mjs` 代替 hiwd。'
  }
3. 执行：
   ${command}
   - 提示座位已经有人坐时，先停下来问我要不要顶替；我同意了，再在命令后面加 --replace。
   - 提示认不出业务或项目时，执行 \`hiwd projects --business ${b.id}\` 看一眼，把结果告诉我。
4. 命令成功会打印一份岗位说明，后面就照它做。坐上后，HiveWard 架构图里这个座位会显示你。

【坐上以后】
- \`hiwd projects --business ${b.id}\`：看项目和各项目的 Leader。
- 派活、复核等具体命令以岗位说明为准；派出去的活交回来后，用 \`hiwd read\` 看汇报和实际改动，再用 \`hiwd review <任务id> --accept\` 通过，或 \`--rework "意见"\` 打回。别让交上来的活一直挂着没人复核。
- 活都干完、没有在等的下属以后，执行 \`hiwd seat leave\` 离座。

现在先坐上去，读完岗位说明，回我一句：你坐上了哪个座位，看到了哪些项目。然后等我派活，不要自己开工。`
}
