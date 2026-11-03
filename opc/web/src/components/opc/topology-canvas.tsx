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
import { grokMood, useGrokBots } from '@/lib/grok'
import { MachineScope, useSwitchMachine } from '@/lib/machine'
import { overviewQuery } from '@/lib/opc-api'
import {
  agentStatus,
  agentStatusStyle,
  livenessStyle,
  type AgentStatus,
  duration,
  timeAgo,
} from '@/lib/opc-format'
import { useOrcaTerminals } from '@/lib/orca-live'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import { AgentLogo } from './agent-logo'
import { CeoSeat } from './ceo-seat'
import { GrokBotAvatar } from './grokbot-avatar'
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
 *    └ 每块业务一组：[业务] ──直线──┬ [项目 A] → [Leader Agent] → 下属
 *                      ╰ Grok Bot ╯ └ [项目 B] → [Leader Agent] → 下属
 *      Grok Bot 像并联的灯泡，从直线上分出去再接回来；一个项目一个 Leader Agent。
 * 没登记成业务、但有人在里面派过活的目录也是一组，只有直线、没有 Grok。
 * 点业务进业务页；点 Grok 灯泡、Leader Agent、下属打开详情（终端画面、任务、汇报）。
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
  // 每块业务一组：根是业务节点（旧版后台叫 project），下面并排它的各个项目
  const roots = nodes.filter(
    (n) => (n.kind === 'business' || n.kind === 'project') && !n.parentId
  )
  return (
    <div>
      <ComputerCard machine={machine} />
      {roots.length > 0 ? (
        <ul className='vtree'>
          {roots.map((root) => {
            const leaders = childrenOf(root.id).filter(
              (n) => n.kind === 'leader'
            )
            const ceo = childrenOf(root.id).find((n) => n.kind === 'ceo')
            // CEO 直接派的 Worker（不属于任何项目）挂在 CEO 位下面
            const ceoWorkers = ceo ? childrenOf(ceo.id) : []
            return (
              <li key={root.id}>
                <BusinessCard
                  root={root}
                  machine={machineId === null ? null : (machine ?? null)}
                />
                <Wire
                  grok={byId(leaders.find((n) => n.via)?.via)}
                  ceo={ceo}
                  {...open}
                />
                <div className='htree'>
                  <ul className='ms-0'>
                    {ceoWorkers.length > 0 && (
                      <CeoWorkers
                        workers={ceoWorkers}
                        childrenOf={childrenOf}
                        {...open}
                      />
                    )}
                    {leaders.map((n) =>
                      n.projectId || isUnassigned(n) ? (
                        <ProjectBranch
                          key={n.id}
                          leader={n}
                          root={root}
                          childrenOf={childrenOf}
                          {...open}
                        />
                      ) : (
                        <Branch
                          key={n.id}
                          node={n}
                          childrenOf={childrenOf}
                          {...open}
                        />
                      )
                    )}
                  </ul>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className='ms-7 pt-6 text-[13px] text-muted-foreground'>
          还没有业务，在左边「业务」旁边点 + 加一个。
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

/** 业务卡：每块业务一张，写着业务名和目录，点进去是业务页（在那儿建项目、看终端）。 */
function BusinessCard({
  root,
  machine,
}: {
  root: TopologyNode
  /** 这一列是哪台电脑；null 为本机 */
  machine: Machine | null
}) {
  const navigate = useNavigate()
  const switchTo = useSwitchMachine()
  const path = root.project
  const businessId = root.businessId
  const unregistered = !!root.unregistered
  const Icon = unregistered ? FolderOpen : FolderGit2
  // 登记过的业务画它自己的 logo（到它所在那台电脑的概况里找）
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
        <p className='truncate text-sm font-medium'>{root.label}</p>
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
      {(root.stats?.length || unregistered) && (
        <p className='mt-1.5 truncate font-mono text-[11px] text-muted-foreground'>
          {unregistered ? '没登记成业务' : root.stats?.join(' · ')}
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
        // 别的电脑上的业务：先切到那台电脑再进业务页
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
 * 业务到它的项目们是一条直线，CEO 位就坐在这条直线上（业务 → CEO → 项目）；
 * Personal Agent（现在是 Grok Bot）是并联的另一条路，从 CEO 前面分出去、绕过 CEO 再接回来。
 * 最近 30 分钟派过活的 Personal Agent 是亮的。没登记的目录两样都没有，只有直线。
 */
function Wire({
  grok,
  ceo,
  openId,
  onOpen,
}: NodeProps & { grok?: TopologyNode; ceo?: TopologyNode }) {
  const lit = !!grok?.lastSeenAt && recent(grok.lastSeenAt)
  // 画这台电脑上的主 Grok Bot 的真实形象和表情；读不到 Grok Bot 时按业务推一个
  const main = useGrokBots().data?.bots[0]
  const mood = main?.awaitingYou
    ? 'waiting'
    : lit
      ? 'working'
      : main
        ? grokMood(main)
        : 'idle'
  return (
    <div className={cn('relative w-44 shrink-0', ceo ? 'h-44' : 'h-28')}>
      <span className='absolute inset-x-0 top-1/2 border-t border-muted-foreground/50' />
      {ceo && <CeoSeat ceo={ceo} open={ceo.id === openId} onOpen={onOpen} />}
      {grok && (
        <>
          <span className='absolute inset-x-5 top-3 bottom-1/2 rounded-t-xl border-x border-t border-muted-foreground/50' />
          <span className='absolute start-5 top-1/2 size-1.5 -translate-1/2 rounded-full bg-muted-foreground' />
          <span className='absolute end-5 top-1/2 size-1.5 translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground' />
          <button
            type='button'
            data-open={grok.id === openId}
            title={`${main?.name ?? 'Grok Bot'}${main?.awaitingYou ? ' · 在等你回复' : ''}${grok.activity ? ` · ${grok.activity}` : ''}`}
            onClick={() => onOpen?.(grok)}
            className={cn(
              'absolute start-1/2 top-3 size-10 -translate-1/2 overflow-hidden rounded-full border-2 bg-panel transition-shadow hover:scale-105',
              lit
                ? 'border-attention shadow-[0_0_16px] shadow-attention/60'
                : 'border-border grayscale-[0.4]',
              grok.id === openId && 'ring-2 ring-ring'
            )}
          >
            <GrokBotAvatar
              seed={grok.businessId ?? grok.id}
              look={main}
              mood={mood}
              animate
              className='size-full p-1'
            />
          </button>
          <span className='absolute start-1/2 top-[38px] -translate-x-1/2 text-center text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
            Personal Agent
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

/** CEO 直接派的 Worker：前面一张「CEO 直派」卡，后面挂这些 Worker */
function CeoWorkers({
  workers,
  childrenOf,
  ...rest
}: NodeProps & {
  workers: TopologyNode[]
  childrenOf: (id: string) => TopologyNode[]
}) {
  return (
    <li>
      <div className='w-40 shrink-0 rounded-lg border border-dashed bg-panel/60 px-3 py-2'>
        <p className='truncate text-[13px] text-muted-foreground'>CEO 直派</p>
        <p className='truncate font-mono text-[11px] text-muted-foreground'>
          不属于任何项目
        </p>
      </div>
      <ul>
        {workers.map((k) => (
          <Branch key={k.id} node={k} childrenOf={childrenOf} {...rest} />
        ))}
      </ul>
    </li>
  )
}

const isUnassigned = (n: TopologyNode) =>
  n.kind === 'leader' && !n.projectId && n.id.endsWith(':unassigned')

/**
 * 业务下的一个项目：[项目] → [Leader Agent] → 下属。
 * 「未归项目」没有 Leader Agent，下属直接挂在项目卡后面。
 */
function ProjectBranch({
  leader,
  root,
  childrenOf,
  ...rest
}: NodeProps & {
  leader: TopologyNode
  root: TopologyNode
  childrenOf: (id: string) => TopologyNode[]
}) {
  const unassigned = isUnassigned(leader)
  const kids = unassigned ? childrenOf(leader.id) : [leader]
  // 项目子目录：相对业务目录显示
  const dir =
    leader.project && root.project && leader.project !== root.project
      ? leader.project.slice(root.project.length).replace(/^\//, '')
      : undefined
  return (
    <li>
      <div
        className={cn(
          'w-40 shrink-0 rounded-lg border bg-panel px-3 py-2',
          unassigned && 'border-dashed bg-panel/60'
        )}
      >
        <p
          className={cn(
            'truncate text-[13px] font-medium',
            unassigned && 'font-normal text-muted-foreground'
          )}
        >
          {leader.label}
        </p>
        <p className='truncate font-mono text-[11px] text-muted-foreground'>
          {unassigned ? '不属于任何项目' : (dir ?? '整个业务目录')}
        </p>
      </div>
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

function StateChip({
  status,
  review,
}: {
  status: AgentStatus
  review?: TopologyNode['review']
}) {
  const s = agentStatusStyle[status]
  // 交了活、等上级复核：仍是「完成」，但标出来还差一步
  const awaiting = status === 'done' && review === 'awaiting'
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 rounded px-1.5 text-[11px] leading-4',
        s.chip
      )}
    >
      {s.pulse && (
        <span className='size-1.5 animate-pulse rounded-full bg-current' />
      )}
      {status === 'done' && <Check className='size-3' />}
      {awaiting ? '完成·待复核' : s.label}
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
  // Leader Agent 这格只写是哪家 Agent，项目名在前面的项目卡上
  const project = leader && !!n.projectId
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
        <p className='truncate text-[13px] text-muted-foreground'>
          还没开 Leader Agent
        </p>
        <p className='mt-0.5 text-[11px] text-muted-foreground'>
          {project ? '点开选一家开' : '在业务页建个项目，给它开 Leader Agent'}
        </p>
      </button>
    )
  }

  // 有状态标签时不再画在线圆点
  const live = n.liveness && !status ? livenessStyle[n.liveness] : null
  // 第二行标题：在干的活；没有时 Leader Agent 写身份，下属写终端名
  const title =
    n.activity || (leader ? `${n.sublabel ?? n.agent} · Leader Agent` : n.label)
  const ran = n.startedAt
    ? n.finishedAt
      ? `用时 ${duration(n.startedAt, n.finishedAt)}`
      : `运行 ${duration(n.startedAt)}`
    : n.lastSeenAt
      ? `最近活动 ${timeAgo(n.lastSeenAt)}`
      : undefined
  const meta = [ran, ...(n.stats ?? [])].filter(Boolean).join(' · ')
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
      <div className='flex h-5 items-center gap-2'>
        <AgentLogo agent={n.agent} className='size-4' />
        {status ? (
          <StateChip status={status} review={n.review} />
        ) : (
          live && (
            <span className='flex items-center gap-1 text-[11px] text-muted-foreground'>
              <span className={cn('size-1.5 rounded-full', live.dot)} />
              {live.label}
            </span>
          )
        )}
      </div>
      <p className='mt-1 line-clamp-1 text-[13px] leading-5 font-medium'>
        {title}
      </p>
      {meta && (
        <p className='mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums'>
          {meta}
        </p>
      )}
    </button>
  )
}
