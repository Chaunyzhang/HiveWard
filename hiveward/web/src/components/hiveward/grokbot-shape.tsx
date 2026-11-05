import type { GrokBotColor, GrokBotShape } from '@shared/api'

/*
 * Grok Bot 的头像：形状 + 颜色 + 一对胶囊眼睛，眼睛随状态变表情。
 * 形状名、11 种颜色、没选形象时按 Bot id 推默认形象的规则都和 Grok Bot 一致；
 * 图形是 HiveWard 自己画的平面版（Grok Bot 自己是实时生成的 3D），不是它的素材。
 */

export type GrokBotMood = 'idle' | 'working' | 'waiting' | 'blocked' | 'done'
export type GrokBotLook = { shape: GrokBotShape; color: GrokBotColor }

export const GROK_COLORS: Record<GrokBotColor, string> = {
  black: '#000000',
  brown: '#936439',
  red: '#FF263C',
  orange: '#FF6700',
  yellow: '#FF9800',
  green: '#00C972',
  cyan: '#00BCA6',
  blue: '#1084FE',
  violet: '#9159FE',
  magenta: '#FF309B',
  gray: '#777777',
}

type ShapeDef = {
  d: string
  /** 眼睛中心高度（重心偏下的形状眼睛也往下放） */
  eyeY: number
  rotate?: number
  /** 叠在身体上的部件（南瓜的梗） */
  extra?: { d: string; fill: string }
}

const circles = (list: [number, number, number][]) =>
  list
    .map(
      ([x, y, r]) =>
        `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`
    )
    .join('')

const star6 = (() => {
  const pts = Array.from({ length: 12 }, (_, i) => {
    const r = i % 2 ? 5.6 : 10
    const a = (Math.PI / 6) * i - Math.PI / 2
    return `${(12 + r * Math.cos(a)).toFixed(2)} ${(12.5 + r * Math.sin(a)).toFixed(2)}`
  })
  return `M${pts.join('L')}z`
})()

const petals = Array.from({ length: 6 }, (_, i): [number, number, number] => {
  const a = (Math.PI / 3) * i
  return [12 + 5.6 * Math.cos(a), 12 + 5.6 * Math.sin(a), 4.4]
})

// 24×24 画布
const SHAPES: Record<string, ShapeDef> = {
  blob: { d: circles([[12, 12.5, 9.5]]), eyeY: 12 },
  pebble: {
    d: 'M2.5 13a9.5 7.5 0 1 0 19 0a9.5 7.5 0 1 0-19 0z',
    eyeY: 12.5,
    rotate: -8,
  },
  bean: {
    d: 'M7.5 4.5c2.6 0 3.6 1.7 5.2 1.7s2.5-1.7 4.6-1.7c2.9 0 4.2 3 4.2 6.6C21.5 16.8 17.4 21 12 21S2.5 17.3 2.5 12.1C2.5 7.6 4.6 4.5 7.5 4.5z',
    eyeY: 12.5,
  },
  egg: {
    d: 'M12 2.5c4.6 0 8 6.1 8 11a8 8 0 0 1-16 0c0-4.9 3.4-11 8-11z',
    eyeY: 13.5,
  },
  squircle: {
    d: 'M12 2.5c7.6 0 9.5 1.9 9.5 9.5s-1.9 9.5-9.5 9.5S2.5 19.6 2.5 12 4.4 2.5 12 2.5z',
    eyeY: 12,
  },
  tablet: {
    d: 'M7.5 5.5h9a5.5 5.5 0 0 1 5.5 5.5v2a5.5 5.5 0 0 1-5.5 5.5h-9A5.5 5.5 0 0 1 2 13v-2a5.5 5.5 0 0 1 5.5-5.5z',
    eyeY: 12,
    rotate: -10,
  },
  capsule: {
    d: 'M12 2.5a6.5 6.5 0 0 1 6.5 6.5v6a6.5 6.5 0 0 1-13 0V9A6.5 6.5 0 0 1 12 2.5z',
    eyeY: 11.5,
  },
  cylinder: { d: 'M4 6.5a8 3 0 0 1 16 0v11a8 3 0 0 1-16 0z', eyeY: 12.5 },
  hex: { d: 'M12 2.5l8.3 4.8v9.4L12 21.5l-8.3-4.8V7.3z', eyeY: 12, rotate: 12 },
  gem: { d: 'M7 4h10l5 6-10 11.5L2 10z', eyeY: 10 },
  crystal: { d: 'M12 2l6.5 6.5L16 21.5H8L5.5 8.5z', eyeY: 12 },
  wedge: {
    d: 'M10.3 3.6a2 2 0 0 1 3.4 0l8 13.6a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3z',
    eyeY: 14.5,
    rotate: 14,
  },
  shield: {
    d: 'M12 2.5l8.5 3v6c0 5.2-3.6 8.9-8.5 10.5-4.9-1.6-8.5-5.3-8.5-10.5v-6z',
    eyeY: 11,
  },
  dome: { d: 'M2.5 20.5v-6.5a9.5 9.5 0 0 1 19 0v6.5z', eyeY: 13 },
  arch: {
    d: 'M3 21V11.5a9 9 0 0 1 18 0V21h-5.5v-8.5a3.5 3.5 0 0 0-7 0V21z',
    eyeY: 7.5,
  },
  cloud: {
    d: 'M7 19.5a5 5 0 0 1-.6-9.96A6 6 0 0 1 17.6 8.6a4.5 4.5 0 0 1-.1 10.9z',
    eyeY: 13.5,
  },
  teardrop: {
    d: 'M12 2.5s7.5 7.6 7.5 12a7.5 7.5 0 0 1-15 0c0-4.4 7.5-12 7.5-12z',
    eyeY: 14.5,
    rotate: 12,
  },
  leaf: { d: 'M3.5 20.5C3.5 9.5 9.5 3.5 20.5 3.5c0 11-6 17-17 17z', eyeY: 12 },
  square: {
    d: 'M5 4.5h14a.5.5 0 0 1 .5.5v14a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5z',
    eyeY: 12,
    rotate: -14,
  },
  sparkle: {
    d: 'M12 2c1.4 5 4.8 8.6 10 10-5.2 1.4-8.6 5-10 10-1.4-5-4.8-8.6-10-10 5.2-1.4 8.6-5 10-10z',
    eyeY: 12,
  },
  clover: {
    d: `${circles([
      [8.4, 8.4, 4.6],
      [15.6, 8.4, 4.6],
      [8.4, 15.6, 4.6],
      [15.6, 15.6, 4.6],
    ])}M8.4 8.4h7.2v7.2H8.4z`,
    eyeY: 12,
  },
  flower: { d: circles([...petals, [12, 12, 6]]), eyeY: 12 },
  heart: {
    d: 'M12 21s-9.2-5.5-9.2-11.6A5 5 0 0 1 12 6.6a5 5 0 0 1 9.2 2.8C21.2 15.5 12 21 12 21z',
    eyeY: 12,
    rotate: -10,
  },
  house: { d: 'M12 3l9 7.6V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.4z', eyeY: 14 },
  star: { d: star6, eyeY: 12.5 },
  pumpkin: {
    d: 'M12 5.5c5.4 0 9.5 3.4 9.5 8s-3.6 7.5-9.5 7.5-9.5-2.9-9.5-7.5 4.1-8 9.5-8z',
    eyeY: 13,
    extra: {
      d: 'M11.2 6.2c0-2 .6-3.4 2-4l.8.9c-1 .5-1.3 1.6-1.3 3.1z',
      fill: '#3f3f46',
    },
  },
}

// ── 没选形象时的默认：照 Grok Bot 的规则按 Bot id 算（和它界面上显示的一致） ──
const DEFAULT_SHAPES = [
  'blob',
  'pebble',
  'squircle',
  'tablet',
  'wedge',
  'hex',
  'cloud',
  'teardrop',
]
const DEFAULT_COLORS: GrokBotColor[] = [
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
]
const GOLDEN = 2654435769

function fnv(s: string) {
  let t = 2166136261
  for (let i = 0; i < s.length; i++) {
    t ^= s.charCodeAt(i)
    t = Math.imul(t, 16777619)
  }
  return t >>> 0
}

function mix(s: string) {
  let t = fnv(s) | 0
  t = Math.imul(t ^ (t >>> 16), 73244475)
  t = Math.imul(t ^ (t >>> 13), 3266489909)
  return (t ^ (t >>> 16)) >>> 0
}

function firstRandom(seed: number) {
  const t = ((seed >>> 0) + 1831565813) | 0
  let e = Math.imul(t ^ (t >>> 15), 1 | t)
  e = (e + Math.imul(e ^ (e >>> 7), 61 | e)) ^ e
  return ((e ^ (e >>> 14)) >>> 0) / 4294967296
}

/** 按 Bot id 推默认形象 */
export function grokBotLook(id: string): GrokBotLook {
  const h = (fnv(id) ^ Math.imul(1, GOLDEN)) >>> 0
  return {
    shape: DEFAULT_SHAPES[mix(id) % DEFAULT_SHAPES.length],
    color:
      DEFAULT_COLORS[
        Math.floor(
          firstRandom((h ^ Math.imul(1, GOLDEN)) >>> 0) * DEFAULT_COLORS.length
        )
      ],
  }
}

function eyes(y: number, color: string, mood: GrokBotMood, blink: boolean) {
  if (mood === 'done') {
    // 笑眼：两道向上的弧
    return (
      <g fill='none' stroke={color} strokeWidth={1.4} strokeLinecap='round'>
        <path d={`M8.6 ${y + 0.8}q1.2-1.8 2.4 0`} />
        <path d={`M13 ${y + 0.8}q1.2-1.8 2.4 0`} />
      </g>
    )
  }
  // 干活：往右看、眯一点；等待：往上看；受阻：眯成一条线
  const dx = mood === 'working' ? 1 : 0
  const dy = mood === 'waiting' ? -1.2 : 0
  const h = mood === 'blocked' ? 1.3 : mood === 'working' ? 3.4 : 4.2
  return (
    <g fill={color} className={blink ? 'grokbot-blink' : undefined}>
      {[9.8, 14.2].map((x) => (
        <rect
          key={x}
          x={x - 0.95 + dx}
          y={y - h / 2 + dy}
          width={1.9}
          height={h}
          rx={0.95}
          transform={`rotate(-12 ${x + dx} ${y + dy})`}
        />
      ))}
    </g>
  )
}

/**
 * 画在 24×24 里的头像图形（AgentLogo 也用它）。look 传形象，传字符串就当 Bot id 按默认规则推。
 * animate：空闲时呼吸、干活时蹦、等你时眨眼（系统开了「减少动态效果」就不动）。
 */
export function grokBotShape(
  look: GrokBotLook | string,
  mood: GrokBotMood = 'idle',
  animate = false
) {
  const { shape, color } = typeof look === 'string' ? grokBotLook(look) : look
  const def = SHAPES[shape] ?? SHAPES.blob
  const fill = GROK_COLORS[color] ?? GROK_COLORS.black
  const black = color === 'black'
  const motion = !animate
    ? undefined
    : mood === 'working'
      ? 'grokbot-hop'
      : mood === 'waiting' || mood === 'blocked'
        ? undefined
        : 'grokbot-breathe'
  return (
    <g className={motion}>
      <g transform={def.rotate ? `rotate(${def.rotate} 12 12)` : undefined}>
        <path
          d={def.d}
          fill={fill}
          // 黑色身体在深色界面上看不见：描一圈浅边
          stroke={black ? 'rgb(255 255 255 / 0.22)' : fill}
          strokeWidth={black ? 0.8 : 1}
          strokeLinejoin='round'
        />
        {def.extra && <path d={def.extra.d} fill={def.extra.fill} />}
        {eyes(
          def.eyeY,
          black ? '#ffffff' : '#1a1a1a',
          mood,
          !!animate && mood === 'waiting'
        )}
      </g>
    </g>
  )
}
