import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Machine, TopologyNode } from '@shared/api'
import {
  Check,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Laptop,
  Maximize,
  Minus,
  PlaneLanding,
  Plus,
  UserPlus,
} from 'lucide-react'
import { grokMood, useGrokBots } from '@/lib/grok'
import { overviewQuery } from '@/lib/hiveward-api'
import {
  agentStatus,
  agentStatusStyle,
  backgroundNote,
  livenessStyle,
  type AgentStatus,
  duration,
  timeAgo,
  errorStopText,
} from '@/lib/hiveward-format'
import { useHiveWardTerminals, useQuota } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MachineScope, useSwitchMachine } from '@/lib/machine'
import { cn } from '@/lib/utils'
import { useSettledStatus } from '@/hooks/use-settled-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AddBusinessDialog } from '@/features/businesses/add-business-dialog'
import {
  airborneCount,
  airborneLabel,
  airborneOf,
  rootLabel,
  dispatcherSeat,
  type Airborne,
} from '@/features/session/airborne-seat'
import { externalOrigin } from '@/features/session/external-seat'
import {
  offlineNote,
  remoteLabel,
  useRemoteSeat,
} from '@/features/session/remote-seat'
import {
  useAirborneOnline,
  useOpenAirborne,
} from '@/features/session/use-open-airborne'
import { CloseWorkerButton } from '@/features/session/worker-close'
import { AgentLogo } from './agent-logo'
import { CeoSeat } from './ceo-seat'
import { ExternalTag, SeatTag } from './external-tag'
import { GrokBotAvatar } from './grokbot-avatar'
import { ProjectLogo } from './project-logo'
import { SeatShape, seatTone } from './seat-shape'
import { layoutTree, type Box, type Point } from './topology-layout'
import { isUnassigned, topologySeats, type Seat } from './topology-seats'

/** 一台电脑和它的架构节点；id 为 null 是本机 */
export type MachineGroup = {
  id: string | null
  machine?: Machine
  nodes: TopologyNode[]
}

/** 架构图上点「+」要加的东西：项目、或一个下属（带 projectId 进项目，不带挂在 CEO 后面） */
export type AddSpot = {
  kind: 'project' | 'worker'
  businessId: string
  projectId?: string
  /** 点的是哪台电脑那一列；null 为本机 */
  machine: string | null
}

/**
 * Agent 架构图：可拖动、可缩放的点阵画布。
 *   电脑（局域网里几台就并排几列）
 *    └ 每块业务一组：
 *                     ╭─(Personal Agent)
 *        [业务] ──•────(CEO)──⊕─┬ [项目 A] ──•─╭(Leader)╮─⊕─┬ 下属
 *                               │              ╰────────╯   └ 下属
 *                               ├ [项目 B] ──⊕
 *                               └ 下属（CEO 后面直接派的）
 *      CEO、Personal Agent 常驻；Personal Agent 从 CEO 前面分叉上去，不接回来。
 *      直线是 CEO 直接管；Leader 可有可无，有的话像并联的灯泡，从项目的直线上分出去再接回来。
 *      ⊕ 能点：CEO 后面加项目 / 加下属；项目后面加 Leader / 加下属；Leader 后面加下属。
 * 没登记成业务、但有人在里面派过活的目录也是一组，只有直线。
 * 点业务进业务页；点 CEO、Personal Agent、项目、Leader、下属打开详情（终端画面、任务、汇报）。
 * 每台电脑那一列包在 MachineScope 里，开详情、加东西都直接发到那台电脑。
 */
export function TopologyCanvas({
  groups,
  open,
  onOpen,
  onAdd,
  project,
}: {
  groups: MachineGroup[]
  open?: { node: TopologyNode; machine: string | null }
  onOpen?: (node: TopologyNode, machine: string | null) => void
  onAdd?: (spot: AddSpot) => void
  /** 在项目里看：从项目卡开始画，前面的电脑、业务、CEO、Personal Agent 都不画 */
  project?: boolean
}) {
  // 在项目里看时，别的电脑上没这个项目的 Agent，就不占一列
  const own = project
    ? groups.filter((g) => g.nodes.some((n) => n.kind === 'leader'))
    : groups
  const shown = own.length > 0 ? own : groups.slice(0, 1)
  const rowCount = shown
    .map((g) => g.nodes.filter((n) => n.kind === 'leader').length)
    .join(',')
  const columns = useRef<HTMLDivElement>(null)
  return (
    <Viewport fitKey={rowCount}>
      <div ref={columns} className='relative flex items-start gap-24'>
        <CrossLinks root={columns} links={airborneLinks(shown)} />
        {shown.map((g) => (
          <MachineScope key={g.id ?? 'self'} id={g.id}>
            <MachineColumn
              project={project}
              group={g}
              beside={shown.flatMap((x) => {
                const id = x !== g && columnMachine(x)
                return id ? [id] : []
              })}
              openId={open?.machine === g.id ? open.node.id : undefined}
              onOpen={(node) => onOpen?.(node, g.id)}
              onAdd={(spot) => onAdd?.({ ...spot, machine: g.id })}
            />
          </MachineScope>
        ))}
      </div>
    </Viewport>
  )
}

const columnKey = (g: MachineGroup) => g.id ?? 'self'
/** 这一列是哪台电脑（本机列 id 为 null，用机器列表里的本机 id） */
const columnMachine = (g: MachineGroup) => g.machine?.id ?? g.id

/** 跨列的虚线：一头是 A 列里真正派单的座位，一头是 B 列里「A 派来 N 个」的占位（按列、座位 id 认） */
type CrossLink = {
  from: { column: string; seat: string }
  to: { column: string; seat: string }
}

/** 多机总览里 B 列的空降占位连回 A 列那个真 Leader / CEO（A 列不在就不连） */
function airborneLinks(groups: MachineGroup[]): CrossLink[] {
  return groups.flatMap((g) =>
    g.nodes.flatMap((n) => {
      const a = airborneOf(n)
      if (!a) {
        return []
      }
      const src = groups.find(
        (x) => x !== g && columnMachine(x) === a.machineId
      )
      const seat = src && dispatcherSeat(src.nodes, a.dispatcherId)
      return src && seat
        ? [
            {
              from: { column: columnKey(src), seat: seat.id },
              to: { column: columnKey(g), seat: n.id },
            },
          ]
        : []
    })
  )
}

/**
 * 跨电脑的连线：两列各自排版，量出两张卡在列容器里的位置再画（画布缩放了，按缩放比例换回去）。
 * 卡片挪动（量完摆好、数据变了重排）时重新量。
 */
function CrossLinks({
  root,
  links,
}: {
  root: React.RefObject<HTMLDivElement | null>
  links: CrossLink[]
}) {
  const [d, setD] = useState('')
  const key = JSON.stringify(links)
  useLayoutEffect(() => {
    const el = root.current
    const list: CrossLink[] = JSON.parse(key)
    if (!el || list.length === 0) {
      return
    }
    let frame = 0
    const find = ({ column, seat }: CrossLink['from']) => {
      const col = el.querySelector(`[data-machine="${CSS.escape(column)}"]`)
      // Leader 位优先认并联在线上的那颗灯泡，线接它的接口
      const hit =
        col?.querySelector(`[data-seat="${CSS.escape(`${seat}:leader`)}"]`) ??
        col?.querySelector(`[data-seat="${CSS.escape(seat)}"]`)
      return hit?.querySelector('[data-port]') ?? hit?.firstElementChild ?? hit
    }
    const measure = () => {
      frame = 0
      const box = el.getBoundingClientRect()
      const k = box.width / el.offsetWidth || 1
      const at = (r: DOMRect) => ({
        l: (r.left - box.left) / k,
        r: (r.right - box.left) / k,
        t: (r.top - box.top) / k,
        y: (r.top + r.height / 2 - box.top) / k,
      })
      const column = (key: string) => {
        const c = el.querySelector(`[data-machine="${CSS.escape(key)}"]`)
        return c && at(c.getBoundingClientRect())
      }
      const next = list
        .flatMap(({ from, to }) => {
          const a = find(from)
          const b = find(to)
          if (!a || !b) {
            return []
          }
          const s = at(a.getBoundingClientRect())
          const t = at(b.getBoundingClientRect())
          const sc = column(from.column)
          const tc = column(to.column)
          if (!sc || !tc) {
            return []
          }
          // 绕开 A 列的电脑卡、业务卡：占位卡 → 两列之间的空白 → 竖上去到 A 列顶上 → 横到真座位正上方 → 落到它顶上
          const right = sc.l >= tc.r
          const gap = right ? (tc.r + sc.l) / 2 : (sc.r + tc.l) / 2
          const top = Math.min(sc.t, s.t) - 24
          const cx = (s.l + s.r) / 2
          return [
            roundedPath([
              [right ? t.r : t.l, t.y],
              [gap, t.y],
              [gap, top],
              [cx, top],
              [cx, s.t],
            ]),
          ]
        })
        .join('')
      setD((prev) => (prev === next ? prev : next))
    }
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(measure)
      }
    }
    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(el, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      mo.disconnect()
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [root, key])
  if (!d || links.length === 0) {
    return null
  }
  return (
    <svg className='pointer-events-none absolute inset-0 size-full overflow-visible'>
      <path d={d} strokeDasharray='4 3' className='fill-none stroke-(--wire)' />
    </svg>
  )
}

/** 折线拐角统一圆角（和座位树的连线一样的半径） */
function roundedPath(points: [number, number][], radius = 8): string {
  const [first, ...rest] = points
  let d = `M${first[0]} ${first[1]}`
  rest.forEach(([x, y], i) => {
    const next = rest[i + 1]
    if (!next) {
      d += `L${x} ${y}`
      return
    }
    const [px, py] = i === 0 ? first : rest[i - 1]
    const into = Math.min(radius, Math.hypot(x - px, y - py) / 2)
    const out = Math.min(radius, Math.hypot(next[0] - x, next[1] - y) / 2)
    const ax = x - Math.sign(x - px) * into
    const ay = y - Math.sign(y - py) * into
    const bx = x + Math.sign(next[0] - x) * out
    const by = y + Math.sign(next[1] - y) * out
    d += `L${ax} ${ay}Q${x} ${y} ${bx} ${by}`
  })
  return d
}

function MachineColumn({
  group: { id: machineId, machine, nodes },
  project,
  beside,
  ...open
}: NodeProps & {
  group: MachineGroup
  project?: boolean
  /** 总览里并排的其他电脑 */
  beside: string[]
}) {
  const seats = topologySeats(nodes, {
    project,
    canAdd: !!open.onAdd,
    beside,
  })
  const empty = project
    ? seats.length === 0
    : seats.every((s) => s.children.length === 0)
  const cardMachine = machineId === null ? null : (machine ?? null)
  return (
    <div data-machine={machineId ?? 'self'}>
      {seats.length > 0 && (
        <SeatTree
          seats={seats}
          render={(s) => (
            <SeatCard
              seat={s}
              nodes={nodes}
              machine={machine}
              cardMachine={cardMachine}
              {...open}
            />
          )}
          addDot={(s, at) => <SeatAdd seat={s} at={at} {...open} />}
        />
      )}
      {empty && (
        <p
          className={cn(
            'pt-6 text-[13px] text-muted-foreground',
            !project && 'ms-7'
          )}
        >
          {project
            ? tr('这个项目还没有 Agent。')
            : tr('还没有业务，在左边「业务」旁边点 + 加一个。')}
        </p>
      )}
    </div>
  )
}

/** 一个座位画成什么样：按角色挑外形，位置、连线都不管 */
function SeatCard({
  seat: s,
  nodes,
  machine,
  cardMachine,
  ...open
}: NodeProps & {
  seat: Seat
  nodes: TopologyNode[]
  machine?: Machine
  cardMachine: Machine | null
}) {
  const n = s.node
  const airborne = n && airborneOf(n)
  switch (s.role) {
    case 'computer':
      return <ComputerCard machine={machine} />
    case 'business':
      return n ? <BusinessCard root={n} machine={cardMachine} /> : null
    case 'ceo':
      return n ? (
        <CeoSeat ceo={n} open={n.id === open.openId} onOpen={open.onOpen} />
      ) : null
    case 'pa':
      return n ? <PersonalAgentSeat grok={n} {...open} /> : null
    case 'project':
      return n ? (
        airborne ? (
          <AirborneCard node={n} airborne={airborne} merged={s.merged} />
        ) : n.projectId || isUnassigned(n) ? (
          <ProjectCard
            project={n}
            root={nodes.find((r) => r.id === n.parentId)?.project}
            machine={cardMachine}
          />
        ) : (
          <Node node={n} {...open} />
        )
      ) : null
    case 'leader':
      // 底下留出线穿过去的地方，两侧留出灯泡的两条腿
      return n ? (
        <div className='px-5 pb-6'>
          <LeaderBulb
            leader={n}
            open={n.id === open.openId}
            onOpen={open.onOpen}
          />
        </div>
      ) : null
    case 'worker':
      return n ? <Node node={n} {...open} /> : null
  }
}

/**
 * 座位树：先把每张卡画出来量尺寸，再交给 layoutTree 排位置、算连线（量完才显示，不会闪）。
 * 卡片内容变了（状态、在干的活）会重新量、重新排。
 */
function SeatTree({
  seats,
  render,
  addDot,
}: {
  seats: Seat[]
  render: (s: Seat) => React.ReactNode
  addDot: (s: Seat, at: Point) => React.ReactNode
}) {
  const { sizes, measureRef } = useMeasuredBoxes()
  const all: Seat[] = []
  const collect = (s: Seat) => {
    all.push(s)
    if (s.spur) all.push(s.spur)
    s.children.forEach(collect)
  }
  seats.forEach(collect)
  const ready = all.every((s) => sizes[s.id])
  const layout = layoutTree(seats, sizes)
  return (
    <div
      className={cn('relative', !ready && 'invisible')}
      style={{ width: layout.width, height: layout.height }}
    >
      <svg
        className='pointer-events-none absolute inset-0 overflow-visible'
        width={layout.width}
        height={layout.height}
      >
        <path d={layout.path} className='fill-none stroke-(--wire)' />
        {layout.dashed && (
          <path
            d={layout.dashed}
            strokeDasharray='4 3'
            className='fill-none stroke-(--wire)'
          />
        )}
        {layout.dots.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={3}
            className='fill-muted-foreground/70'
          />
        ))}
      </svg>
      {all.map((s) => {
        const at = layout.boxes[s.id]
        return (
          <div
            key={s.id}
            ref={measureRef}
            data-seat={s.id}
            className='absolute w-max'
            style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
          >
            {render(s)}
          </div>
        )
      })}
      {all.map((s) => {
        const at = layout.adds[s.id]
        return at && <Fragment key={`${s.id}:add`}>{addDot(s, at)}</Fragment>
      })}
    </div>
  )
}

/**
 * 量每张卡（不受缩放影响）：ResizeObserver 一挂上就量一次，之后卡片尺寸变了（状态、在干的活）再量。
 * 卡里标了 data-port 的那块是线要接的地方。
 */
function useMeasuredBoxes() {
  const [sizes, setSizes] = useState<Record<string, Box>>({})
  const [observer] = useState(
    () =>
      new ResizeObserver((entries) => {
        const got: Record<string, Box> = {}
        for (const e of entries) {
          const el = e.target as HTMLElement
          if (el.dataset.seat) got[el.dataset.seat] = measureBox(el)
        }
        setSizes((prev) =>
          Object.entries(got).every(([id, b]) => sameBox(prev[id], b))
            ? prev
            : { ...prev, ...got }
        )
      })
  )
  const measureRef = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return
      observer.observe(el)
      return () => observer.unobserve(el)
    },
    [observer]
  )
  return { sizes, measureRef }
}

function measureBox(el: HTMLElement): Box {
  const box: Box = { w: el.offsetWidth, h: el.offsetHeight }
  const port = el.querySelector<HTMLElement>('[data-port]')
  if (!port) return box
  // 沿 offsetParent 往上加到这张卡为止：不受缩放、悬停放大这些 transform 影响
  let x = 0
  let y = 0
  let n: HTMLElement | null = port
  while (n && n !== el) {
    x += n.offsetLeft
    y += n.offsetTop
    n = n.offsetParent as HTMLElement | null
  }
  if (n !== el) return box
  return { ...box, port: { x, y, w: port.offsetWidth, h: port.offsetHeight } }
}

const sameBox = (p: Box | undefined, q: Box) =>
  !!p &&
  p.w === q.w &&
  p.h === q.h &&
  p.port?.x === q.port?.x &&
  p.port?.y === q.port?.y &&
  p.port?.w === q.port?.w &&
  p.port?.h === q.port?.h

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
        'relative min-h-[480px] flex-1 overflow-hidden dot-canvas select-none',
        dragging ? 'cursor-grabbing' : 'cursor-grab'
      )}
      style={{
        backgroundPosition: `${view.x}px ${view.y}px`,
        backgroundSize: `${16 * view.k}px ${16 * view.k}px`,
      }}
      onPointerDown={(e) => {
        const target = e.target
        // 弹出的菜单渲染在页面最外层，React 事件却会冒泡到这里：不在画布里的不当拖动
        if (
          e.button !== 0 ||
          !(target instanceof Element) ||
          !e.currentTarget.contains(target) ||
          target.closest('button, input, textarea, a')
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
        <ZoomButton label={tr('缩小')} onClick={() => zoomAt(1 / 1.2)}>
          <Minus className='size-3.5' />
        </ZoomButton>
        <button
          type='button'
          title={tr('回到 100%')}
          onClick={() => zoomAt(1 / view.k)}
          className='h-6 w-11 rounded-md font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          {Math.round(view.k * 100)}%
        </button>
        <ZoomButton label={tr('放大')} onClick={() => zoomAt(1.2)}>
          <Plus className='size-3.5' />
        </ZoomButton>
        <ZoomButton label={tr('适应宽度')} onClick={fit}>
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
        {machine?.name ?? tr('这台电脑')}
      </span>
      <span
        className={cn(
          'rounded px-1.5 text-[11px] leading-4',
          !machine || machine.self
            ? 'bg-muted text-muted-foreground'
            : 'bg-brand/15 text-brand'
        )}
      >
        {!machine || machine.self ? tr('本机') : tr('局域网')}
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

  // 业务、项目是「地方」不是 Agent：左边一块方形图标、标明是业务还是项目、写目录；
  // Agent 卡片是 logo + 状态标签 + 在干的活，两类一眼分得开
  // 一整块，图标竖直居中：连线正对图标中间进出
  const body = (
    <div className='flex items-center gap-2.5'>
      <span className='grid size-9 shrink-0 place-items-center rounded-md border bg-muted/50'>
        {business ? (
          <ProjectLogo project={business} machine={machineId} size={16} />
        ) : (
          <Icon className='size-4 text-muted-foreground' />
        )}
      </span>
      <div className='min-w-0 flex-1'>
        <p className='text-[10px] leading-3 text-muted-foreground'>
          {unregistered ? tr('目录') : tr('业务')}
        </p>
        <p className='truncate text-sm leading-5 font-medium'>
          {rootLabel(root)}
        </p>
        {path && (
          <p
            title={path}
            className='truncate font-mono text-[11px] leading-4 text-muted-foreground'
          >
            {path.replace(/^\/Users\/[^/]+/, '~')}
          </p>
        )}
        {(root.stats?.length || unregistered) && (
          <p className='truncate font-mono text-[11px] leading-4 text-muted-foreground'>
            {unregistered ? tr('没登记成业务') : root.stats?.join(' · ')}
          </p>
        )}
      </div>
      {businessId && (
        <ChevronRight className='size-3.5 shrink-0 text-muted-foreground' />
      )}
    </div>
  )
  const cls =
    'block w-60 shrink-0 rounded-lg border bg-panel px-3 py-2.5 text-start'
  if (!businessId) {
    return <UnregisteredCard className={cls} path={path} body={body} />
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

/**
 * 没登记成业务的目录（里面有 Agent 开着才出现在架构图上）：点开说清楚为什么在这儿，
 * 可以登记成业务；里面的 Agent 都关掉后它自己就不显示了。
 */
function UnregisteredCard({
  className,
  path,
  body,
}: {
  className: string
  path?: string
  body: React.ReactNode
}) {
  const [adding, setAdding] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type='button' className={cn(className, 'lift hover-box')}>
            {body}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-64'>
          <DropdownMenuLabel className='text-xs leading-5 font-normal text-muted-foreground'>
            {tr(
              '这个目录没登记成业务，因为里面有 Agent 开着才显示在这儿；把它们都关掉，它就不显示了。'
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAdding(true)}>
            <FolderPlus /> {tr('登记成业务…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {adding && (
        <AddBusinessDialog open onOpenChange={setAdding} initialPath={path} />
      )}
    </>
  )
}

const LIT_FOR = 30 * 60_000
const recent = (iso: string) => Date.now() - new Date(iso).getTime() < LIT_FOR

/**
 * Personal Agent 位：圆形，坐在 CEO 正上方，线从主线分叉上来、穿过它再落回去。
 * 坐的是哪家由老板点进去选（Grok Bot、Hermes、OpenClaw、Muse…），没选时是虚线空位。
 * 最近 30 分钟派过活的是亮的。
 */
function PersonalAgentSeat(props: NodeProps & { grok: TopologyNode }) {
  const { grok, openId, onOpen } = props
  if (grok.agent === 'grokbot' && grok.bot) {
    return <GrokBotSeat {...props} />
  }
  const lit = !!grok.lastSeenAt && recent(grok.lastSeenAt)
  return (
    <div className='flex flex-col items-center gap-1'>
      <SeatShape
        data-port
        role='pa'
        vacant={!grok.agent}
        open={grok.id === openId}
        className={cn(grok.agent && !lit && 'grayscale-[0.4]')}
        title={
          grok.agent === 'grokbot'
            ? tr('还没选 Grok Bot 里的哪个 Bot，点开选')
            : grok.agent
              ? `${grok.label} · ${grok.activity ?? ''}`
              : tr('Personal Agent 位空着，点开选一个')
        }
        onClick={() => onOpen?.(grok)}
      >
        {grok.agent ? (
          <AgentLogo agent={grok.agent} className='size-7' />
        ) : (
          <Plus className='size-4' />
        )}
      </SeatShape>
      <span className='text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
        {grok.agent ? grok.label : 'Personal Agent'}
        {grok.lastSeenAt && <> · {timeAgo(grok.lastSeenAt)}</>}
      </span>
    </div>
  )
}

/** Grok Bot 坐着：画这台电脑上的主 Grok Bot 的真实形象和表情；读不到 Grok Bot 时按业务推一个 */
function GrokBotSeat({
  grok,
  openId,
  onOpen,
}: NodeProps & { grok: TopologyNode }) {
  const lit = !!grok.lastSeenAt && recent(grok.lastSeenAt)
  // 这块业务选定的那个 Bot；还没选具体哪个时画 Grok Bot 的标，等老板点进去选
  const main = useGrokBots().data?.bots.find((b) => b.id === grok.bot)
  // 座位的颜色只看 Grok Bot 自己的实况；头像表情最近派过活也算在忙
  const live = main ? grokMood(main) : 'idle'
  const mood = main?.awaitingYou
    ? 'waiting'
    : lit
      ? 'working'
      : main
        ? grokMood(main)
        : 'idle'
  return (
    <div className='flex flex-col items-center gap-1'>
      <SeatShape
        data-port
        role='pa'
        // 只有真在等你回复才是橙色；最近派过活只是不发灰，不算等待
        tone={
          live === 'waiting'
            ? 'waiting'
            : live === 'working'
              ? 'working'
              : 'idle'
        }
        open={grok.id === openId}
        title={`${main?.name ?? 'Grok Bot'}${main?.awaitingYou ? tr(' · 在等你回复') : ''}${grok.activity ? ` · ${grok.activity}` : ''}`}
        onClick={() => onOpen?.(grok)}
        className={cn(!lit && 'grayscale-[0.4]')}
      >
        <GrokBotAvatar
          seed={grok.businessId ?? grok.id}
          look={main}
          mood={mood}
          animate
          className='size-full p-1'
        />
      </SeatShape>
      <span className='text-[10px] leading-3 whitespace-nowrap text-muted-foreground'>
        Personal Agent
        {grok.lastSeenAt && <> · {timeAgo(grok.lastSeenAt)}</>}
      </span>
    </div>
  )
}

/** 座位后面的 ⊕ 能加什么：CEO 后面加项目 / 下属；Leader 后面加下属 */
function SeatAdd({
  seat: { add, node },
  at,
  onAdd,
}: NodeProps & { seat: Seat; at: Point }) {
  const businessId = node?.businessId
  const projectId = node?.projectId
  if (!add || !node || !businessId) return null
  const worker: AddItem[] = onAdd
    ? [
        {
          label: tr('派个下属'),
          icon: <UserPlus />,
          run: () => onAdd({ kind: 'worker', businessId, projectId }),
        },
      ]
    : []
  const items: AddItem[] =
    add === 'ceo'
      ? [
          {
            label: tr('加项目'),
            icon: <FolderPlus />,
            run: () => onAdd?.({ kind: 'project', businessId }),
          },
          ...worker,
        ]
      : worker
  if (items.length === 0) return null
  const label = add === 'ceo' ? tr('CEO 后面加') : tr('Leader 后面加')
  return <AddDot at={at} label={label} items={items} />
}

type AddItem = { label: string; icon: React.ReactNode; run: () => void }

/**
 * 线尾能点的 ⊕：平时是个小圆点，指上去变成加号。只有一样能加时点了直接加，多样时弹菜单。
 * 圆心在 at（排版算出来的分叉点）。
 */
function AddDot({
  items,
  label,
  at,
}: {
  items: AddItem[]
  label: string
  at: Point
}) {
  const dot = (
    <span className='grid size-2 place-items-center rounded-full bg-muted-foreground/70 transition-all group-hover:size-5 group-hover:border group-hover:bg-panel group-data-[state=open]:size-5 group-data-[state=open]:border group-data-[state=open]:bg-panel'>
      <Plus className='hidden size-3 group-hover:block group-data-[state=open]:block' />
    </span>
  )
  const cls =
    'group absolute z-10 grid size-6 -translate-1/2 place-items-center rounded-full outline-none'
  const style = { left: at.x, top: at.y }
  const only = items.length === 1 ? items[0] : undefined
  if (only) {
    return (
      <button
        type='button'
        title={only.label}
        aria-label={only.label}
        onClick={only.run}
        className={cls}
        style={style}
      >
        {dot}
      </button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        className={cls}
        style={style}
      >
        {dot}
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='w-36'>
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onClick={item.run}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type NodeProps = {
  openId?: string
  onOpen?: (node: TopologyNode) => void
  onAdd?: (spot: Omit<AddSpot, 'machine'>) => void
}

/**
 * 项目卡：点了进项目页（别的电脑上的项目先切过去）；Leader 位是后面那颗胶囊，点它才开 Leader 详情。
 * 「未归项目」是虚线卡，不能点。
 */
function ProjectCard({
  project: n,
  root,
  machine,
}: {
  project: TopologyNode
  root?: string
  /** 这一列是哪台电脑；null 为本机 */
  machine: Machine | null
}) {
  const navigate = useNavigate()
  const switchTo = useSwitchMachine()
  const unassigned = isUnassigned(n)
  // 项目子目录：相对业务目录显示
  const dir =
    n.project && root && n.project !== root
      ? n.project.slice(root.length).replace(/^\//, '')
      : undefined
  const card = (
    <div className='flex items-center gap-2'>
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-md border bg-muted/50 text-muted-foreground',
          unassigned && 'border-dashed bg-transparent'
        )}
      >
        <Folder className='size-3.5' />
      </span>
      <div className='min-w-0'>
        <p
          className={cn(
            'truncate text-[13px] leading-5 font-medium',
            unassigned && 'font-normal text-muted-foreground'
          )}
        >
          {n.label}
        </p>
        <p className='truncate text-[11px] leading-4 text-muted-foreground'>
          {unassigned ? (
            tr('不属于任何项目')
          ) : (
            <>
              {tr('项目 ·')}{' '}
              <span className='font-mono'>{dir ?? tr('整个业务目录')}</span>
            </>
          )}
        </p>
      </div>
    </div>
  )
  if (unassigned) {
    return (
      <div className='w-44 rounded-lg border border-dashed bg-panel/60 px-2.5 py-2'>
        {card}
      </div>
    )
  }
  return (
    <button
      type='button'
      title={tr('进这个项目')}
      onClick={async () => {
        const { businessId, projectId } = n
        if (!businessId) {
          return
        }
        await switchTo(machine)
        void navigate({
          to: '/b/$businessId',
          params: { businessId },
          search: { project: projectId },
        })
      }}
      className='block w-44 lift rounded-lg border hover-box bg-panel px-2.5 py-2 text-start'
    >
      {card}
    </button>
  )
}

/**
 * 空降 Leader 的影子卡：别的电脑（A）上的 CEO / Leader 派活过来，B 的图上替它占个位，派来的下属挂在后面。
 * 虚线边、颜色比真座位淡，不能说话、没有操作；点它到 A 上打开真正的座位。A 离线时变灰、不能点。
 * 多机总览里 A 列也在时只画「A 派来 N 个」的占位，下属在 A 列画过了。
 */
function AirborneCard({
  node: n,
  airborne: a,
  merged,
}: {
  node: TopologyNode
  airborne: Airborne
  merged?: boolean
}) {
  const online = useAirborneOnline()(a)
  const open = useOpenAirborne()
  const note = online
    ? a.businessName
    : [
        tr('{0} 离线', [a.machineName]),
        n.lastSeenAt && tr('最后消息 {0}', [timeAgo(n.lastSeenAt)]),
      ]
        .filter(Boolean)
        .join(' · ')
  const body = (
    <div className='flex items-center gap-2'>
      <span className='grid size-7 shrink-0 place-items-center rounded-md border border-dashed text-muted-foreground'>
        <PlaneLanding className='size-3.5' />
      </span>
      <div className='min-w-0'>
        <p className='truncate text-[13px] leading-5 text-muted-foreground'>
          {merged ? airborneCount(a) : airborneLabel(a)}
        </p>
        {note && (
          <p
            className={cn(
              'text-[11px] leading-4 text-muted-foreground/80',
              online ? 'truncate' : 'line-clamp-2'
            )}
          >
            {note}
          </p>
        )}
      </div>
    </div>
  )
  const cls =
    'block w-52 rounded-lg border border-dashed bg-panel/50 px-2.5 py-2 text-start'
  if (!online) {
    return (
      <div
        className={cn(cls, 'opacity-60 grayscale')}
        title={tr('{0} 连不上，只能看最后状态', [a.machineName])}
      >
        {body}
      </div>
    )
  }
  return (
    <button
      type='button'
      title={tr('到 {0} 上打开 {1}', [a.machineName, a.dispatcherLabel])}
      onClick={() => void open(a)}
      className={cn(cls, 'lift hover-box')}
    >
      {body}
    </button>
  )
}

/** 项目的 Leader：跨在直线上的胶囊，画那家 Agent 的 logo 和状态；干活时发光、等人时橙色 */
function LeaderBulb({
  leader: n,
  open,
  onOpen,
}: {
  leader: TopologyNode
  open: boolean
  onOpen?: (node: TopologyNode) => void
}) {
  const status = useNodeStatus(n)
  const background = useNodeBackground(n)
  const awaiting = status === 'done' && n.review === 'awaiting'
  const look = status ? agentStatusStyle[awaiting ? 'waiting' : status] : null
  // 没人坐：画成空位，点了在详情里复制提示词或开一个坐上来
  const vacant = !n.agent && !n.terminal && !n.dispatcher && !n.sessionId
  return (
    <SeatShape
      role='leader'
      tone={seatTone(status, n.review)}
      vacant={vacant}
      dim={n.liveness === 'exited'}
      open={open}
      title={[`Leader · ${n.sublabel ?? n.agent ?? ''}`, n.activity, background]
        .filter(Boolean)
        .join(' · ')}
      onClick={() => onOpen?.(n)}
      data-port
      className='text-[11px]'
    >
      {!vacant && <AgentLogo agent={n.agent} className='size-4' />}
      <span>
        Leader
        {vacant ? (
          <span className='text-muted-foreground'> · {tr('空位')}</span>
        ) : (
          look && (
            <span className='text-muted-foreground'>
              {' '}
              · {awaiting ? tr('待复核') : look.label}
            </span>
          )
        )}
      </span>
    </SeatShape>
  )
}

function StateChip({
  status,
  review,
  stop,
}: {
  status: AgentStatus
  review?: TopologyNode['review']
  /** 出错停下的那一句（「额度用完 · 约 03:25 恢复」「出错停了：模型服务过载」） */
  stop?: string
}) {
  // 交了活、等上级复核：标成「等待」的颜色（任务页里它也在「待办」），和任务页一致
  const awaiting = status === 'done' && review === 'awaiting'
  const s = agentStatusStyle[awaiting ? 'waiting' : status]
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
      {awaiting ? tr('完成·待复核') : (stop ?? s.label)}
    </span>
  )
}

/** 节点终端里还在跑的后台命令：一句「后台 N 个命令在跑」，不影响状态灯 */
function useNodeBackground(n: TopologyNode): string | undefined {
  const { data } = useHiveWardTerminals()
  return backgroundNote(
    n.terminal
      ? data?.find((t) => t.handle === n.terminal)?.backgroundCommands
      : undefined
  )
}

/** 节点的状态：节点接着终端时以终端实况为准（每列都包在 MachineScope 里，读的是那台电脑的终端） */
function useNodeStatus(n: TopologyNode): AgentStatus | undefined {
  const { data } = useHiveWardTerminals()
  const terminal =
    n.terminal && data
      ? (data.find((t) => t.handle === n.terminal) ?? null)
      : undefined
  return useSettledStatus(
    agentStatus({
      terminal,
      state: n.state,
      liveness: n.liveness,
      // 远程下属的终端在执行端那台电脑上，本机没有：照后台报的状态
      session: !!n.sessionId || !!n.execution,
      errorStop: n.errorStop,
    })
  )
}

function Node({ node: n, openId, onOpen }: NodeProps & { node: TopologyNode }) {
  const leader = n.kind === 'leader'
  // Leader Agent 这格只写是哪家 Agent，项目名在前面的项目卡上
  const project = leader && !!n.projectId
  const vacant = leader && !n.agent && !n.terminal && !n.dispatcher
  const status = useNodeStatus(n)
  const background = useNodeBackground(n)
  const seats = useRemoteSeat()
  const quota = useQuota().data
  if (vacant) {
    return (
      <SeatShape
        role='worker'
        vacant
        open={n.id === openId}
        onClick={() => onOpen?.(n)}
      >
        <p className='truncate text-[13px] text-muted-foreground'>
          {tr('还没开 Leader Agent')}
        </p>
        <p className='mt-0.5 text-[11px] text-muted-foreground'>
          {project
            ? tr('点开选一家开')
            : tr('在业务页建个项目，给它开 Leader Agent')}
        </p>
      </SeatShape>
    )
  }

  // 有状态标签时不再画在线圆点
  const live = n.liveness && !status ? livenessStyle[n.liveness] : null
  // 第二行标题：在干的活；没有时 Leader Agent 写身份，下属写终端名
  const title =
    n.activity || (leader ? `${n.sublabel ?? n.agent} · Leader Agent` : n.label)
  const ran = n.startedAt
    ? n.finishedAt
      ? tr('用时 {0}', [duration(n.startedAt, n.finishedAt)])
      : tr('运行 {0}', [duration(n.startedAt)])
    : n.lastSeenAt
      ? tr('最近活动 {0}', [timeAgo(n.lastSeenAt)])
      : undefined
  const meta = [ran, background, ...(n.stats ?? [])].filter(Boolean).join(' · ')
  // 外援：别的业务找来帮忙的，虚线边、写上它自己的出处
  const origin = externalOrigin(n)
  // 派到别的电脑上执行的（连线虚线）、别的电脑派来的：标上是哪台电脑；执行端离线时卡片变淡，写最后状态
  const remote = seats.execution(n)
  const offline = remote && !remote.online
  const from = seats.from(n)
  const stop =
    n.errorStop && (status === 'quota' || status === 'failed')
      ? errorStopText(
          n.errorStop,
          quota?.providers.find((p) => p.agent === n.agent)?.resetsAt
        )
      : undefined
  return (
    <div className='group/close relative'>
      <SeatShape
        role='worker'
        tone={offline ? undefined : seatTone(status, n.review)}
        dim={n.liveness === 'exited' || offline}
        open={n.id === openId}
        onClick={() => onOpen?.(n)}
        title={
          [
            origin && tr('外援 · {0}', [origin]),
            remote && remoteLabel(remote),
            from,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        className={cn(origin && 'border-dashed')}
      >
        <div className='flex h-5 items-center gap-2'>
          <AgentLogo agent={n.agent} className='size-4' />
          {offline ? null : status ? (
            <StateChip status={status} review={n.review} stop={stop} />
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
        {origin && (
          <p className='mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground'>
            <ExternalTag />
            <span className='truncate'>{origin}</span>
          </p>
        )}
        {(remote || from) && (
          <p className='mt-1 flex min-w-0 items-center gap-1.5'>
            <SeatTag className='shrink'>
              {remote ? remoteLabel(remote) : from}
            </SeatTag>
          </p>
        )}
        {offline ? (
          <p className='mt-0.5 truncate text-[11px] text-muted-foreground'>
            {offlineNote(remote, n)}
          </p>
        ) : (
          meta && (
            <p className='mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums'>
              {meta}
            </p>
          )
        )}
      </SeatShape>
      <CloseWorkerButton
        node={n}
        hover
        className='absolute end-1.5 top-1.5 bg-panel'
      />
    </div>
  )
}
