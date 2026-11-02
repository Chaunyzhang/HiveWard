/*
 * Grok Bot 的头像：每个 Bot 一个形状 + 一种颜色 + 一对胶囊眼睛，眼睛随状态变表情。
 * 形状和颜色按 seed（比如业务 id）固定挑，同一个 Bot 每次都长一样。HiveWard 自己画的，不是 xAI 的素材。
 */

export type GrokBotMood = 'idle' | 'working' | 'waiting' | 'blocked' | 'done'

const COLORS = [
  '#F4F4F5',
  '#FF6B57',
  '#FF9F1C',
  '#FFD23F',
  '#3DDC97',
  '#2EC4B6',
  '#4CC9F0',
  '#4361EE',
  '#7B61FF',
  '#C77DFF',
  '#FF5DA2',
  '#8D99AE',
]

// 24×24 画布；eyeY 是眼睛中心的高度（三角、云、水滴的重心偏下）
const SHAPES = [
  { d: 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20z', eyeY: 11.5 },
  { d: 'M2 12a10 8.5 0 1 0 20 0a10 8.5 0 1 0-20 0z', eyeY: 11.5 },
  {
    d: 'M12 2c7.5 0 10 2.5 10 10s-2.5 10-10 10S2 19.5 2 12 4.5 2 12 2z',
    eyeY: 11.5,
  },
  { d: 'M8 5h8a7 7 0 0 1 0 14H8A7 7 0 0 1 8 5z', eyeY: 11.5 },
  {
    d: 'M10.27 3.5a2 2 0 0 1 3.46 0l8.2 14.2a2 2 0 0 1-1.73 3H3.8a2 2 0 0 1-1.73-3z',
    eyeY: 14.5,
  },
  { d: 'M12 2.2l8.5 4.9v9.8L12 21.8l-8.5-4.9V7.1z', eyeY: 11.5 },
  {
    d: 'M7 19a5 5 0 0 1-.6-9.96A6 6 0 0 1 17.6 8.1A4.5 4.5 0 0 1 17.5 19z',
    eyeY: 13.5,
  },
  { d: 'M12 2.5s8 8 8 12.5a8 8 0 0 1-16 0C4 10.5 12 2.5 12 2.5z', eyeY: 14.5 },
]

function hash(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  }
  return h >>> 0
}

// 浅色身体配黑眼睛，深色身体配白眼睛
function eyeColor(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16)
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return lum > 150 ? '#111' : '#fff'
}

function eyes(y: number, color: string, mood: GrokBotMood) {
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
    <g fill={color}>
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

/** 画在 24×24 里的头像图形（AgentLogo 也用它） */
export function grokBotShape(seed: string, mood: GrokBotMood = 'idle') {
  const h = hash(seed)
  const shape = SHAPES[h % SHAPES.length]
  const color = COLORS[(h >>> 8) % COLORS.length]
  return (
    <>
      <path
        d={shape.d}
        fill={color}
        stroke={color}
        strokeWidth={1}
        strokeLinejoin='round'
      />
      {eyes(shape.eyeY, eyeColor(color), mood)}
    </>
  )
}
