/**
 * 架构图排版：纯函数，不碰 DOM，输入每张卡量出来的尺寸，输出每张卡的位置和全部连线。
 * - 列 = 角色：每个座位声明自己坐哪一列（比上级靠左时自动挪到上级右边一列，下属的下属就一层层往右长）；
 *   列宽取这一列最宽的卡，空列不占地方。
 * - 行 = 子树往下摞：上级和第一个下级在同一条线上（主干是直的），其余下级依次往下排，行高由内容撑开。
 * - 线按摆好的位置算：上级出口 → 分叉点（有 ⊕ 时 ⊕ 就是分叉点）→ 下级入口，拐角统一圆角；
 *   中间哪一列空着，线直接穿过去。全部线拼成一条 path，交叠处不会叠深颜色。
 */

export type Rect = { x: number; y: number; w: number; h: number }

/** 一张卡量出来的尺寸；port 是线要接的那一块（比如 CEO 位只接那个方块，不含下面的字），默认整张卡 */
export type Box = { w: number; h: number; port?: Rect }

export type Slot = {
  id: string
  /** 坐哪一列 */
  col: number
  /** 线怎么经过它：card 线从左边进、右边出；bridge 线从它底下直穿，它像并联的灯泡跨在线上 */
  pass?: 'card' | 'bridge'
  /** 在列里靠左还是居中 */
  align?: 'start' | 'center'
  /** 和上一个兄弟子树之间留多高 */
  gap?: number
  /** 有 ⊕：加的东西会落在哪一列；⊕ 画在那一列前面的空隙里，也是下级的分叉点 */
  addCol?: number
  /** 正上方的卫星（Personal Agent）：从进来的线上分叉上去，穿过它再落回后面的线上 */
  spur?: Slot
  /** 从上级接过来的那一段画虚线（派到别的电脑上执行的下属） */
  dashed?: boolean
  children: Slot[]
}

export type Point = { x: number; y: number }

export type Layout = {
  /** 每张卡左上角 */
  boxes: Record<string, Point>
  /** 全部连线，一条 SVG path */
  path: string
  /** 要画虚线的那几段（dashed 的座位从分叉点接过来的线） */
  dashed: string
  /** 分叉点 */
  dots: Point[]
  /** 每个有 ⊕ 的座位，⊕ 的圆心 */
  adds: Record<string, Point>
  width: number
  height: number
}

export const GAP_X = 56
const GAP_Y = 12
const SPUR_GAP = 12
const RADIUS = 8
const ADD_RADIUS = 12

export function layoutTree(
  roots: Slot[],
  sizes: Record<string, Box | undefined>
): Layout {
  const box = (s: Slot) => sizes[s.id] ?? { w: 0, h: 0 }
  const port = (s: Slot): Rect => {
    const b = box(s)
    return b.port ?? { x: 0, y: 0, w: b.w, h: b.h }
  }
  // 线在这张卡上的高度（相对卡顶）
  const anchor = (s: Slot) =>
    s.pass === 'bridge' ? box(s).h : port(s).y + port(s).h / 2

  // ── 列 ──
  const col = new Map<string, number>()
  const widths: number[] = []
  const widen = (c: number, w: number) => {
    widths[c] = Math.max(widths[c] ?? 0, w)
  }
  const assign = (s: Slot, min: number) => {
    const c = Math.max(s.col, min)
    col.set(s.id, c)
    widen(c, box(s).w)
    if (s.spur) {
      col.set(s.spur.id, c)
      widen(c, box(s.spur).w)
    }
    for (const k of s.children) assign(k, c + 1)
  }
  for (const r of roots) assign(r, 0)
  const lefts: number[] = []
  let cursor = 0
  for (let c = 0; c < widths.length; c++) {
    lefts[c] = cursor
    const w = widths[c] ?? 0
    if (w > 0) cursor += w + GAP_X
  }
  const colLeft = (c: number) => lefts[c] ?? cursor
  const gapBefore = (c: number) => colLeft(c) - GAP_X / 2

  // ── 行：子树占多高（相对它自己那条线，往上 up、往下 down），下级的线相对上级的线往下多少 ──
  const offset = new Map<string, number>()
  const extent = (s: Slot): { up: number; down: number } => {
    const a = anchor(s)
    let up = s.spur ? a + SPUR_GAP + box(s.spur).h : a
    let down = box(s).h - a
    const below = stack(s.children)
    if (s.children.length > 0) {
      up = Math.max(up, below.up)
      down = Math.max(down, below.down)
    }
    return { up, down }
  }
  // 一串兄弟往下摞：第一个和上级同一条线，后面的接着往下
  const stack = (list: Slot[]) => {
    let up = 0
    let bottom = 0
    list.forEach((s, i) => {
      const e = extent(s)
      const y = i === 0 ? 0 : bottom + (s.gap ?? GAP_Y) + e.up
      offset.set(s.id, y)
      if (i === 0) up = e.up
      bottom = y + e.down
    })
    return { up, down: bottom }
  }
  const all = stack(roots)

  // ── 摆位置 ──
  const boxes: Layout['boxes'] = {}
  const trunk = new Map<string, number>()
  const place = (s: Slot, y: number) => {
    const c = col.get(s.id) ?? s.col
    const b = box(s)
    const x =
      s.align === 'center'
        ? colLeft(c) + ((widths[c] ?? 0) - b.w) / 2
        : colLeft(c)
    boxes[s.id] = { x, y: y - anchor(s) }
    trunk.set(s.id, y)
    if (s.spur) {
      const p = port(s)
      const sp = port(s.spur)
      boxes[s.spur.id] = {
        x: x + p.x + p.w / 2 - (sp.x + sp.w / 2),
        y: y - anchor(s) - SPUR_GAP - box(s.spur).h,
      }
    }
    for (const k of s.children) place(k, y + (offset.get(k.id) ?? 0))
  }
  for (const r of roots) place(r, all.up + (offset.get(r.id) ?? 0))

  // ── 线 ──
  const d: string[] = []
  const dash: string[] = []
  const dots: Point[] = []
  const adds: Layout['adds'] = {}
  const spurBack = new Map<string, number>()
  const inX = (s: Slot) => boxes[s.id].x + (s.pass === 'bridge' ? 0 : port(s).x)
  const outX = (s: Slot) =>
    s.pass === 'bridge' ? boxes[s.id].x + box(s).w : inX(s) + port(s).w
  const wire = (s: Slot) => {
    const y = trunk.get(s.id) ?? 0
    if (s.pass === 'bridge') {
      // 线从底下直穿；两条腿从线上升起，绕过卡片再落回线上
      const l = inX(s)
      const r = outX(s)
      const top = boxes[s.id].y + port(s).y + port(s).h / 2
      d.push(
        `M${l} ${y}H${r}`,
        `M${l} ${y}V${top + RADIUS}Q${l} ${top} ${l + RADIUS} ${top}H${r - RADIUS}Q${r} ${top} ${r} ${top + RADIUS}V${y}`
      )
      dots.push({ x: l, y }, { x: r, y })
    }
    if (s.spur) {
      // 从进来的线上分叉上去，穿过卫星，再从它右边落回这一列后面的线上（像 Leader 那样并联）
      const c = col.get(s.id) ?? s.col
      const jx = gapBefore(c)
      const rx = colLeft(c) + (widths[c] ?? 0) + GAP_X / 2
      const sp = port(s.spur)
      const top = boxes[s.spur.id].y + sp.y + sp.h / 2
      const r = Math.min(RADIUS, y - top)
      const spurX = boxes[s.spur.id].x + sp.x
      d.push(
        `M${jx} ${y}V${top + r}Q${jx} ${top} ${jx + r} ${top}H${spurX}`,
        `M${spurX + sp.w} ${top}H${rx - r}Q${rx} ${top} ${rx} ${top + r}V${y}`
      )
      dots.push({ x: jx, y }, { x: rx, y })
      spurBack.set(s.id, rx)
    }
    const addX = s.addCol === undefined ? undefined : gapBefore(s.addCol)
    const kidCol = Math.min(...s.children.map((k) => col.get(k.id) ?? k.col))
    const fx = addX ?? (s.children.length > 0 ? gapBefore(kidCol) : undefined)
    // 卫星落回来的地方也要接上主线，哪怕后面什么都没有
    const back = spurBack.get(s.id)
    const end = Math.max(fx ?? -Infinity, back ?? -Infinity)
    if (end === -Infinity) {
      return
    }
    d.push(`M${outX(s)} ${y}H${end}`)
    if (fx === undefined) return
    if (addX !== undefined) adds[s.id] = { x: addX, y }
    else if (s.children.length > 1) dots.push({ x: fx, y })
    for (const k of s.children) {
      const ky = trunk.get(k.id) ?? y
      const r = Math.min(RADIUS, ky - y)
      const out = k.dashed ? dash : d
      out.push(
        r > 0
          ? `M${fx} ${y}V${ky - r}Q${fx} ${ky} ${fx + r} ${ky}H${inX(k)}`
          : `M${fx} ${y}H${inX(k)}`
      )
    }
  }
  const walk = (s: Slot) => {
    wire(s)
    s.children.forEach(walk)
  }
  roots.forEach(walk)

  let width = 0
  const grow = (s: Slot) => {
    width = Math.max(width, boxes[s.id].x + box(s).w)
    if (s.spur) width = Math.max(width, boxes[s.spur.id].x + box(s.spur).w)
    s.children.forEach(grow)
  }
  roots.forEach(grow)
  for (const a of Object.values(adds)) width = Math.max(width, a.x + ADD_RADIUS)

  return {
    boxes,
    path: d.join(''),
    dashed: dash.join(''),
    dots,
    adds,
    width,
    height: all.up + all.down,
  }
}
