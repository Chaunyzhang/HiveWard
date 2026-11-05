import { cn } from '@/lib/utils'

// 几何来自 resources/brand/draw-hive.mjs，改形状先改那边再同步这里。
const BARS = [
  [0, -152, 131.64, -76],
  [131.64, -76, 131.64, 76],
  [131.64, 76, 0, 152],
  [0, 152, -131.64, 76],
  [-131.64, 76, -131.64, -76],
  [-131.64, -76, 0, -152],
  [0, 0, -131.64, -76],
  [0, 0, 131.64, -76],
  [0, 0, 0, 152],
]
const CELLS = [
  [0, 0],
  [0, -152],
  [131.64, -76],
  [131.64, 76],
  [0, 152],
  [-131.64, 76],
  [-131.64, -76],
]
const HEX = [
  [0, -54.97],
  [47.6, -27.48],
  [47.6, 27.48],
  [0, 54.97],
  [-47.6, 27.48],
  [-47.6, -27.48],
]

/** HiveWard 扁平蜂巢标志，透明底；连杆颜色跟随深浅色模式。 */
export function HiveLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox='-256 -256 512 512'
      className={cn('size-5', className)}
      aria-hidden='true'
    >
      <g className='stroke-[#5B5650] dark:stroke-[#8A847C]' strokeWidth={22.8}>
        {BARS.map(([x1, y1, x2, y2]) => (
          <line
            key={`${x1},${y1},${x2},${y2}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
          />
        ))}
      </g>
      <g
        fill='#FFA41C'
        stroke='#FFA41C'
        strokeWidth={18}
        strokeLinejoin='round'
      >
        {CELLS.map(([cx, cy]) => (
          <polygon
            key={`${cx},${cy}`}
            points={HEX.map(([x, y]) => `${cx + x},${cy + y}`).join(' ')}
          />
        ))}
      </g>
    </svg>
  )
}
