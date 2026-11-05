const stripAnsi = (s) =>
  s.replace(
    // oxlint-disable-next-line no-control-regex -- 去掉终端转义序列，本来就要匹配 ESC 控制字符
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g,
    ''
  )

// Kimi 执行批准后的计划时，转圈是单独一行的月相（🌑🌒…🌘）
const MOON = /^\s*[\u{1F311}-\u{1F318}]\s*$/mu

/** 整屏最后 15 行有没有「转圈 + 文字」（⠼ Thinking…）或月相转圈；codex 开场的点阵动画是转圈连空格，不算 */
export const spinningOnScreen = (lines) => {
  const tail = stripAnsi(lines.slice(-15).join('\n'))
  return /[\u2801-\u28ff] [A-Za-z\u4e00-\u9fff]/u.test(tail) || MOON.test(tail)
}

/** 屏幕最后几行有没有 Agent 的转圈字符 */
export const spinning = (preview) =>
  MOON.test(stripAnsi(preview ?? '')) ||
  /[\u2801-\u28ff] \S/u.test(
    stripAnsi(preview ?? '')
      .trim()
      .split('\n')
      .slice(-3)
      .join('\n')
  )
