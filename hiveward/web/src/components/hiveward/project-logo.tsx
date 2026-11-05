import { useState } from 'react'
import type { BusinessSummary } from '@shared/api'
import { scoped, useMachineId } from '@/lib/machine'
import { cn } from '@/lib/utils'

/**
 * 素色占位图标：项目里认不出 logo 时用。都是 20×20 的单色几何线条，
 * 按项目目录挑一个，同一个项目每次都是同一个图形。
 */
const MARKS: React.ReactNode[] = [
  <circle key='ring' cx='10' cy='10' r='5.5' />,
  <g key='pair'>
    <circle cx='8' cy='10' r='4.5' />
    <circle cx='12' cy='10' r='4.5' />
  </g>,
  <path key='tri' d='M10 4.5 15.5 14.5h-11Z' />,
  <path key='diamond' d='M10 4 16 10 10 16 4 10Z' />,
  <path key='hex' d='M10 4 15.2 7v6L10 16l-5.2-3V7Z' />,
  <path key='bars' d='M5 6.5h10M5 10h10M5 13.5h6' />,
  <g key='dot-box'>
    <rect x='4.5' y='4.5' width='11' height='11' rx='2.5' />
    <circle cx='10' cy='10' r='1.2' fill='currentColor' />
  </g>,
  <path key='arch' d='M4.5 15V10a5.5 5.5 0 0 1 11 0v5' />,
  <path key='cross' d='M10 4.5v11M4.5 10h11' />,
  <path
    key='wave'
    d='M3.5 10c1.6-2.6 3.3-2.6 4.9 0s3.3 2.6 4.9 0 2.4-1.7 3.2-.9'
  />,
  <g key='grid' fill='currentColor' stroke='none'>
    <circle cx='7' cy='7' r='1.4' />
    <circle cx='13' cy='7' r='1.4' />
    <circle cx='7' cy='13' r='1.4' />
    <circle cx='13' cy='13' r='1.4' />
  </g>,
  <path key='signal' d='M5 15a10 10 0 0 1 10-10M5 15a6 6 0 0 1 6-6M5 15h.01' />,
]

function pick(seed: string) {
  let h = 0
  for (const c of seed) {
    h = (h * 31 + c.charCodeAt(0)) | 0
  }
  return MARKS[Math.abs(h) % MARKS.length]
}

export function PlaceholderMark({
  seed,
  className,
}: {
  seed: string
  className?: string
}) {
  return (
    <svg
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.5}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
      className={className}
    >
      {pick(seed)}
    </svg>
  )
}

/**
 * 项目图标：有项目自己的 logo 就用它（图片读失败也退回占位）；没有就画素色占位图标。
 * size 是外框边长（px），侧栏 18、项目页 40。
 */
export function ProjectLogo({
  project,
  size = 18,
  machine: machineProp,
  className,
}: {
  project: Pick<BusinessSummary, 'logo' | 'workspacePath' | 'name'>
  size?: number
  /** 项目在哪台电脑上（null 本机）；不传就跟着当前看的那台 */
  machine?: string | null
  className?: string
}) {
  const scopedMachine = useMachineId()
  const machine = machineProp === undefined ? scopedMachine : machineProp
  const [broken, setBroken] = useState<string | null>(null)
  const src = project.logo ? scoped(project.logo, machine) : null
  const radius = Math.round(size * 0.24)
  if (src && broken !== src) {
    return (
      <img
        src={src}
        alt=''
        draggable={false}
        onError={() => setBroken(src)}
        style={{ width: size, height: size, borderRadius: radius }}
        className={cn('shrink-0 object-contain', className)}
      />
    )
  }
  return (
    <span
      style={{ width: size, height: size, borderRadius: radius }}
      className={cn(
        'grid shrink-0 place-items-center border bg-muted/60 text-muted-foreground',
        className
      )}
    >
      <PlaceholderMark
        seed={project.workspacePath || project.name}
        className='size-[72%]'
      />
    </span>
  )
}
