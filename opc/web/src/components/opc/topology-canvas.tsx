import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Machine, TopologyNode } from '@shared/api'
import {
  Check,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  Laptop,
  Maximize,
  Minus,
  Plus,
} from 'lucide-react'
import { MachineScope, useSwitchMachine } from '@/lib/machine'
import { overviewQuery } from '@/lib/opc-api'
import {
  agentStatus,
  agentStatusStyle,
  livenessStyle,
  type AgentStatus,
  timeAgo,
} from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { AgentLogo } from './agent-logo'
import { ProjectLogo } from './project-logo'

/** 一台电脑和它的架构节点；id 为 null 是本机 */
export type MachineGroup = {
  id: string | null
  machine?: Machine
  nodes: TopologyNode[]
}

/**
 * Agent 架构图：可拖动、可缩放的点阵画布。
 *   电脑（局域网里几台就并排几列）
 *    └ 每个项目（= 一块业务）一行：[项目] ──直线── [总 Agent] → 下属
 *                                  ╰─ Grok Bot ─╯  像并联的灯泡，从直线上分出去再接回来
 * 没登记成项目、但有人在里面派过活的目录也是一行，只有直线、没有 Grok。
 * 点项目进项目页（在那儿派活）；点 Grok 灯泡、总 Agent、下属打开详情（终端画面、任务、汇报）。
 * 每台电脑那一列包在 MachineScope 里，开详情都直接发到那台电脑。
 */
export function TopologyCanvas({
  groups,
  open,
  onOpen,
}: {
  groups: MachineGroup[]
  open?: { node: TopologyNode; machine: string | null }
  onOpen?: (node: TopologyNode, machine: string | null) => void
}) {
  const rowCount = groups
    .map((g) => g.nodes.filter((n) => n.kind === 'leader').length)
    .join(',')
  return (
    <Viewport fitKey={rowCount}>
      <div className='flex items-start gap-24'>
        {groups.map((g) => (
          <MachineScope key={g.id ?? 'self'} id={g.id}>
            <MachineColumn
              group={g}
              openId={open?.machine === g.id ? open.node.id : undefined}
              onOpen={(node) => onOpen?.(node, g.id)}
            />
          </MachineScope>
        ))}
      </div>
    </Viewport>
  )
}

function MachineColumn({
  group: { id: machineId, machine, nodes },
  ...open
}: NodeProps & { group: MachineGroup }) {
  const childrenOf = (id: string) => nodes.filter((n) => n.parentId === id)
  const byId = (id?: string) => nodes.find((n) => n.id === id)
  const rows = nodes.filter((n) => n.kind === 'leader')
  return (
    <div>
      <ComputerCard machine={machine} />
      {rows.length > 0 ? (
        <ul className='vtree'>
          {rows.map((row) => (
            <li key={row.id}>
              <ProjectCard
                row={row}
                root={byId(row.parentId)}
                machine={machineId === null ? null : (machine ?? null)}
              />
              <Wire grok={byId(row.via)} {...open} />
              <ul className='htree'>
                <Branch node={row} childrenOf={childrenOf} {...open} />
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className='ms-7 pt-6 text-[13px] text-muted-foreground'>
          还没有项目，在左边「项目」旁边点 + 加一个。
        </p>
      )}
    </div>
  )
}

const MIN = 0.3
const MAX = 1.6
const clamp = (k: number) => Math.min(MAX, Math.max(MIN, k))
type View = { x: number; y: number; k: number }

/** 以 (px, py) 为中心缩放，那一点在屏幕上不动 */
function zoomed(v: View, factor: number, px: number, py: number): View {
  const k = clamp(v.k * factor)
  return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
}

/**
 * 拖动、缩放的画布：按住空白处拖动；触控板左右滑动平移（上下滑动照常滚页面），双指捏合（或按住 ⌘/Ctrl 滚轮）缩放。
 * 卡片上的按钮、输入框照常点，不会触发拖动。右下角有缩放按钮和「适应」。
 */
function Viewport({
  fitKey,
  children,
}: {
  fitKey: string
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 24, y: 24, k: 1 })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; px: number; py: number }>(null)

  // 按宽度摆下（最多 100%），从顶上开始；行多了往下拖着看
  const fit = () => {
    const b = box.current
    const c = content.current
    if (!b || !c) return
    const pad = 32
    const k = clamp(Math.min(1, (b.clientWidth - pad * 2) / c.offsetWidth))
    setView({
      k,
      x: Math.max(pad, (b.clientWidth - c.offsetWidth * k) / 2),
      y: Math.max(pad, (b.clientHeight - c.offsetHeight * k) / 2),
    })
  }

  // 老板还没动过画布时，内容或画布尺寸一变（数据陆续到、窗口拉宽）就重新摆；拖过、缩放过就不再自作主张
  const touched = useRef(false)
  useLayoutEffect(() => {
    touched.current = false
    fit()
    const ro = new ResizeObserver(() => !touched.current && fit())
    if (box.current) ro.observe(box.current)
    if (content.current) ro.observe(content.current)
    return () => ro.disconnect()
  }, [fitKey])

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const b = box.current
    touched.current = true
    setView((v) =>
      zoomed(
        v,
        factor,
        cx ?? (b?.clientWidth ?? 0) / 2,
        cy ?? (b?.clientHeight ?? 0) / 2
      )
    )
  }

  // 滚轮要能 preventDefault，React 的 onWheel 是被动监听，只能自己挂
  useEffect(() => {
    const b = box.current
    if (!b) return
    // 上下滚动留给页面（不然滚页面经过画布时，画布里的东西会被滚跑）；左右滑动平移，捏合 / ⌘+滚轮缩放
    const onWheel = (e: WheelEvent) => {
      const zoom = e.ctrlKey || e.metaKey
      if (!zoom && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()
      if (zoom) {
        const r = b.getBoundingClientRect()
        touched.current = true
        setView((v) =>
          zoomed(
            v,
            Math.exp(-e.deltaY * 0.01),
            e.clientX - r.left,
            e.clientY - r.top
          )
        )
      } else {
        touched.current = true
        setView((v) => ({ ...v, x: v.x - e.deltaX }))
      }
    }
    b.addEventListener('wheel', onWheel, { passive: false })
    return () => b.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div
      ref={box}
      className={cn(
        'relative h-[560px] overflow-hidden dot-canvas select-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab'
      )}
      style={{
        backgroundPosition: `${view.x}px ${view.y}px`,
        backgroundSize: `${16 * view.k}px ${16 * view.k}px`,
      }}
      onPointerDown={(e) => {
        if (
          e.button !== 0 ||
          (e.target as HTMLElement).closest('button, input, textarea, a')
        )
          return
        touched.current = true
        drag.current = { x: view.x, y: view.y, px: e.clientX, py: e.clientY }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        setView((v) => ({
          ...v,
          x: d.x + e.clientX - d.px,
          y: d.y + e.clientY - d.py,
        }))
      }}
      onPointerUp={() => {
        drag.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        setDragging(false)
      }}
    >
      <div
        ref={content}
        className='absolute start-0 top-0 w-max origin-top-left'
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
        }}
      >
        {children}
      </div>

      <div className='absolute end-3 bottom-3 flex items-center gap-0.5 rounded-lg border bg-panel p-0.5 shadow-sm'>
        <ZoomButton label='缩小' onClick={() => zoomAt(1 / 1.2)}>
          <Minus className='size-3.5' />
        </ZoomButton>
        <button
          type='button'
          title='回到 100%'
          onClick={() => zoomAt(1 / view.k)}
          className='h-6 w-11 rounded-md font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          {Math.round(view.k * 100)}%
        </button>
        <ZoomButton label='放大' onClick={() => zoomAt(1.2)}>
          <Plus className='size-3.5' />
        </ZoomButton>
        <ZoomButton label='适应宽度' onClick={fit}>
          <Maximize className='size-3.5' />
        </ZoomButton>
      </div>
    </div>
  )
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      title={label}
      aria-label={label}
      onClick={onClick}
      className='grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
    >
      {children}
    </button>
  )
}

/** 最上层：这些 Agent 跑在哪台电脑上（切到别的电脑时就是那台） */
function ComputerCard({ machine }: { machine?: Machine }) {
  return (
    <div className='flex w-max items-center gap-2.5 rounded-lg border bg-panel px-3 py-2'>
      <Laptop className='size-4 text-muted-foreground' />
      <span className='text-[13px] font-medium'>
        {machine?.name ?? '这台电脑'}
      </span>
      <span
        className={cn(
          'rounded px-1.5 text-[11px] leading-4',
          !machine || machine.self
            ? 'bg-muted text-muted-foreground'
            : 'bg-brand/15 text-brand'
        )}
      >
        {!machine || machine.self ? '本机' : '局域网'}
      </span>
    </div>
  )
}

/**
 * 项目卡：每个项目（= 一块业务）一张，写着项目名和目录，点进去是项目页（在那儿给总 Agent 派活）。
 * 旧版后台还没有项目节点时，用总 Agent 这一行自己的业务名和目录。
 */
function ProjectCard({
  row,
  root,
  machine,
}: {
  row: TopologyNode
  root?: TopologyNode
  /** 这一列是哪台电脑；null 为本机 */
  machine: Machine | null
}) {
  const navigate = useNavigate()
  const switchTo = useSwitchMachine()
  const project = root?.kind === 'project' ? root : undefined
  const label = project?.label ?? row.label
  const path = project?.project ?? row.project
  const businessId = project?.businessId ?? row.businessId
  const unregistered = project ? !!project.unregistered : !row.businessId
  const Icon = unregistered ? FolderOpen : FolderGit2
  // 登记过的项目画它自己的 logo（到它所在那台电脑的概况里找）
  const machineId = machine && !machine.self ? machine.id : null
  const { data } = useQuery({
    ...overviewQuery(machineId),
    enabled: !!businessId,
  })
  const business = data?.businesses.find((b) => b.id === businessId)

  const body = (
    <>
      <div className='flex items-center gap-1.5'>
        {business ? (
          <ProjectLogo project={business} machine={machineId} size={14} />
        ) : (
          <Icon className='size-3.5 shrink-0 text-muted-foreground' />
        )}
        <p className='truncate text-sm font-medium'>{label}</p>
        {businessId && (
          <ChevronRight className='ms-auto size-3.5 shrink-0 text-muted-foreground' />
        )}
      </div>
      {path && (
        <p
          title={path}
          className='mt-0.5 truncate font-mono text-[11px] text-muted-foreground'
        >
          {path.replace(/^\/Users\/[^/]+/, '~')}
        </p>
      )}
      {(row.stats?.length || unregistered) && (
        <p className='mt-1.5 truncate font-mono text-[11px] text-muted-foreground'>
          {unregistered ? '没登记成项目' : row.stats?.join(' · ')}
        </p>
      )}
    </>
  )
  const cls =
    'block w-56 shrink-0 rounded-lg border bg-panel px-3 py-2.5 text-start'
  if (!businessId) {
    return <div className={cls}>{body}</div>
  }
  return (
    <button
      type='button'
      onClick={async () => {
        // 别的电脑上的项目：先切到那台电脑再进项目页
        await switchTo(machine)
        void navigate({ to: '/b/$businessId', params: { businessId } })
      }}
      className={cn(cls, 'lift hover-box')}
    >
      {body}
    </button>
  )
}

const LIT_FOR = 30 * 60_000
const recent = (iso: string) => Date.now() - new Date(iso).getTime() < LIT_FOR

/**
 * 项目到总 Agent 是一条直线；这个项目的 Grok Bot 像并联的灯泡，从直线上分出去再接回来。
 * 最近 30 分钟派过活的灯泡是亮的。没登记的目录没有 Grok，只有直线。
 */
function Wire({ grok, openId, onOpen }: NodeProps & { grok?: TopologyNode }) {
  const lit = !!grok?.lastSeenAt && recent(grok.lastSeenAt)
  return (
    <div className='relative h-28 w-44 shrink-0'>
      <span className='absolute inset-x-0 top-1/2 border-t border-muted-foreground/50' />
      {grok && (
        <>
          <span className='absolute inset-x-5 top-3 bottom-1/2 rounded-t-xl border-x border-t border-muted-foreground/50' />
          <span className='absolute start-5 top-1/2 size-1.5 -translate-1/2 rounded-full bg-muted-foreground' />
          <span className='absolute end-5 top-1/2 size-1.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground' />
          <button
            type='button'
            data-open={grok.id === openId}
            title={grok.activity}
            onClick={() => onOpen?.(grok)}
            className={cn(
              'absolute start-1/2 top-3 size-10 -translate-1/2 overflow-hidden rounded-full border-2 bg-panel transition-shadow hover:scale-105',
              lit
                ? 'border-attention shadow-[0_0_16px] shadow-attention/60'
                : 'border-border grayscale-[0.4]',
              grok.id === openId && 'ring-2 ring-ring'
            )}
          >
            <AgentLogo agent='grokbot' className='size-full' />
          </button>
          <span className='absolute start-1/2 top-[38px] -translate-x-1/2 text-center text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
            Grok Bot
            {grok.lastSeenAt && <> · {timeAgo(grok.lastSeenAt)}</>}
          </span>
        </>
      )}
    </div>
  )
}

type NodeProps = {
  openId?: string
  onOpen?: (node: TopologyNode) => void
}

function Branch({
  node,
  childrenOf,
  ...rest
}: NodeProps & {
  node: TopologyNode
  childrenOf: (id: string) => TopologyNode[]
}) {
  const kids = childrenOf(node.id)
  return (
    <li>
      <Node node={node} {...rest} />
      {kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <Branch key={k.id} node={k} childrenOf={childrenOf} {...rest} />
          ))}
        </ul>
      )}
    </li>
  )
}

function StateChip({ status }: { status: AgentStatus }) {
  const s = agentStatusStyle[status]
  return (
    <span
      className={cn(
        'ms-auto flex shrink-0 items-center gap-1 rounded px-1.5 text-[11px] leading-4',
        s.chip
      )}
    >
      {s.pulse && (
        <span className='size-1.5 animate-pulse rounded-full bg-current' />
      )}
      {status === 'done' && <Check className='size-3' />}
      {s.label}
    </span>
  )
}

/** 节点的状态：节点接着终端时以终端实况为准（每列都包在 MachineScope 里，读的是那台电脑的终端） */
function useNodeStatus(n: TopologyNode): AgentStatus | undefined {
  const { data } = useOrcaTerminals()
  const terminal =
    n.terminal && data
      ? (data.find((t) => t.handle === n.terminal) ?? null)
      : undefined
  return useSettledStatus(
    agentStatus({ terminal, state: n.state, liveness: n.liveness })
  )
}

function Node({ node: n, openId, onOpen }: NodeProps & { node: TopologyNode }) {
  const leader = n.kind === 'leader'
  // 总 Agent 这格只写是哪个 Agent，项目名在项目卡上
  const vacant = leader && !n.agent && !n.terminal && !n.dispatcher
  const status = useNodeStatus(n)
  if (vacant) {
    return (
      <button
        type='button'
        data-open={n.id === openId}
        onClick={() => onOpen?.(n)}
        className='block w-56 shrink-0 rounded-lg border border-dashed bg-panel/60 px-3 py-2 text-start hover:bg-accent'
      >
        <p className='text-[13px] text-muted-foreground'>还没有总 Agent</p>
        <p className='mt-0.5 text-[11px] text-muted-foreground'>
          派第一个任务时会开一个 Claude Code 当总 Agent
        </p>
      </button>
    )
  }

  // 有状态标签时不再画在线圆点
  const live = n.liveness && !status ? livenessStyle[n.liveness] : null
  return (
    <button
      type='button'
      data-open={n.id === openId}
      onClick={() => onOpen?.(n)}
      className={cn(
        'block w-56 shrink-0 lift rounded-lg border hover-box bg-panel px-3 py-2 text-start',
        n.liveness === 'exited' && 'opacity-60'
      )}
    >
      <div className='flex items-center gap-2'>
        {live && (
          <span
            title={live.label}
            className={cn('size-1.5 shrink-0 rounded-full', live.dot)}
          />
        )}
        <AgentLogo agent={n.agent} className='size-4' />
        <span
          className={cn(
            'truncate',
            leader
              ? 'text-[13px] font-medium'
              : 'font-mono text-xs text-muted-foreground'
          )}
        >
          {leader ? (n.sublabel ?? n.agent) : n.label}
        </span>
        {status ? (
          <StateChip status={status} />
        ) : (
          n.lastSeenAt && (
            <span className='ms-auto shrink-0 text-[11px] text-muted-foreground'>
              {timeAgo(n.lastSeenAt)}
            </span>
          )
        )}
      </div>
      {n.activity && (
        <p className='mt-1 line-clamp-1 text-[13px] leading-5'>{n.activity}</p>
      )}
      {!leader && n.sublabel && (
        <p className='truncate text-xs text-muted-foreground'>{n.sublabel}</p>
      )}
      {n.stats && n.stats.length > 0 && (
        <p className='mt-1 truncate font-mono text-[11px] text-muted-foreground'>
          {n.stats.join(' · ')}
        </p>
      )}
    </button>
  )
}
