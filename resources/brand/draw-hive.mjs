// 用代码画 HiveWard 扁平版蜂巢标志：node resources/brand/draw-hive.mjs
// 七块尖顶六边形排成蜂巢：外圈六块连成一圈，中心块连左上、右上、正下三块（俯看像一个立方体）。
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HONEY = '#FFA41C'
const BAR = '#5B5650'
const SIZE = 512

const spacing = 152 // 相邻六边形中心距
const radius = 0.43 * spacing // 六边形外接圆半径
const corner = 9 // 圆角
const barWidth = 0.15 * spacing

const round = (n) => Math.round(n * 100) / 100
const at = (deg, len, cx = 0, cy = 0) => [
  cx + len * Math.cos((deg * Math.PI) / 180),
  cy + len * Math.sin((deg * Math.PI) / 180)
]

// 中心 + 六个邻居；邻居方向 -90° 起每 60° 一个
const cells = {
  center: [0, 0],
  top: at(-90, spacing),
  upperRight: at(-30, spacing),
  lowerRight: at(30, spacing),
  bottom: at(90, spacing),
  lowerLeft: at(150, spacing),
  upperLeft: at(210, spacing)
}
const links = [
  ['top', 'upperRight'],
  ['upperRight', 'lowerRight'],
  ['lowerRight', 'bottom'],
  ['bottom', 'lowerLeft'],
  ['lowerLeft', 'upperLeft'],
  ['upperLeft', 'top'],
  ['center', 'upperLeft'],
  ['center', 'upperRight'],
  ['center', 'bottom']
]

// 圆角靠同色描边 + round 拐角实现，所以多边形本身往里收一圈，保证边到中心距离不变
const inner = radius - corner / Math.cos(Math.PI / 6)
const hexPoints = ([cx, cy]) =>
  [-90, -30, 30, 90, 150, 210].map((d) => at(d, inner, cx, cy).map(round).join(',')).join(' ')

// plate：底板占画布的比例。macOS 图标按系统网格四周留透明边（824/1024），其他平台满版。
function hive({ honey = HONEY, bar = BAR, background, plate = 1, scale = 1 } = {}) {
  const c = SIZE / 2
  const side = round(SIZE * plate)
  const offset = round((SIZE - side) / 2)
  const bg = background
    ? `  <rect x="${offset}" y="${offset}" width="${side}" height="${side}" rx="${round(side * 0.22)}" fill="${background}"/>\n`
    : ''
  const bars = links
    .map(([a, b]) => {
      const [x1, y1] = cells[a]
      const [x2, y2] = cells[b]
      return `    <line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}"/>`
    })
    .join('\n')
  const hexes = Object.values(cells)
    .map((p) => `    <polygon points="${hexPoints(p)}"/>`)
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">
${bg}  <g transform="translate(${c} ${c}) scale(${round(scale * plate)})">
  <g stroke="${bar}" stroke-width="${round(barWidth)}">
${bars}
  </g>
  <g fill="${honey}" stroke="${honey}" stroke-width="${corner * 2}" stroke-linejoin="round">
${hexes}
  </g>
  </g>
</svg>
`
}

const here = import.meta.dirname
const variants = {
  'hiveward-hive-flat.svg': hive(),
  'hiveward-hive-flat-light.svg': hive({ background: '#FBF4E8', scale: 0.78 }),
  'hiveward-hive-flat-dark.svg': hive({ background: '#17171A', bar: '#8A847C', scale: 0.78 }),
  'hiveward-app-icon-mac.svg': hive({
    background: '#17171A',
    bar: '#8A847C',
    scale: 0.78,
    plate: 824 / 1024
  }),
  'hiveward-hive-flat-mono.svg': hive({ honey: '#17171A', bar: '#17171A' })
}
for (const [name, svg] of Object.entries(variants)) {
  writeFileSync(join(here, name), svg)
}
console.log(Object.keys(variants).join('\n'))
