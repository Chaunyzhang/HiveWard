// 终端里的 Agent 停在选择菜单上等人选（Kimi 计划模式的「? Approve this plan → [1] Approve …」、
// Claude 的「Do you want to proceed? ❯ 1. Yes」）。Kimi 不报状态，只能看屏幕认出来。

import { apiError } from './business.mjs'

const stripAnsi = (s) =>
  s.replace(
    // oxlint-disable-next-line no-control-regex -- 去掉终端转义序列，本来就要匹配 ESC 控制字符
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g,
    ''
  )

// 「→ [1] Approve」「  [2] Reject」「❯ 1. Yes」「  2. No」；带箭头的是光标所在那项
const OPTION = /^([→❯›▶]\s*)?(?:\[(\d+)\]|(\d+)\.)\s+(\S.*)$/u
// 框线、分隔线：菜单到这里结束
const RULE = /^[╭╰─━┄═+-]{3,}/u

/**
 * 屏幕最后 40 行里有没有正在等人选的菜单：至少两项、从 1 连续编号、有一项带光标箭头，上面有一句问话。
 * 有就返回 { question, options: [{ n, label }], cursor }（cursor 是光标所在项的编号），没有返回 null。
 */
export function screenMenu(text) {
  const lines = stripAnsi(text ?? '')
    .split('\n')
    .slice(-40)
    .map((l) => l.replace(/^[\s│┃║|]+|[\s│┃║|]+$/gu, ''))
  const at = lines.findLastIndex((l) => OPTION.exec(l)?.[1])
  if (at === -1) {
    return null
  }
  const parse = (l) => {
    const m = OPTION.exec(l)
    return m ? { n: Number(m[2] ?? m[3]), label: m[4].trim(), cursor: !!m[1] } : null
  }
  const cursor = parse(lines[at]).n
  // 往上找到第 1 项（中间夹的是选项说明），遇到框线还没找到就不算
  let first = -1
  for (let i = at; i >= 0 && !RULE.test(lines[i]); i--) {
    if (parse(lines[i])?.n === 1) {
      first = i
      break
    }
  }
  if (first < 0) {
    return null
  }
  // 第 1 项上面第一句非空的就是问话
  const question = lines
    .slice(0, first)
    .findLast((l) => l && !RULE.test(l))
    ?.replace(/^\?\s+/, '')
  // 往下收选项，编号要连续；遇到框线停
  const options = []
  for (let i = first; i < lines.length && !RULE.test(lines[i]); i++) {
    const o = parse(lines[i])
    if (o && o.n === options.length + 1) {
      options.push({ n: o.n, label: o.label })
    }
  }
  if (options.length < 2 || !question) {
    return null
  }
  return { question, options, cursor }
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'

/** 选第 n 项要发给终端的按键：从光标所在项上下移过去，再回车 */
export function menuKeys(menu, n) {
  const delta = n - menu.cursor
  return `${(delta > 0 ? DOWN : UP).repeat(Math.abs(delta))}\r`
}

/**
 * 在终端的菜单上选一项（pick 是编号或选项文字）。先重读整屏确认菜单还在，免得菜单已经过去了还往里按键。
 * 返回选中的那项；菜单不在了或没这一项 → 409。
 */
export async function chooseMenu(rpc, terminal, pick) {
  const read = await rpc('terminal.read', { terminal, screen: true })
  const menu = screenMenu(read?.terminal?.tail?.join('\n'))
  const option = menu?.options.find((o) => o.n === pick || o.label === pick)
  if (!menu) {
    throw apiError(409, 'menu_gone', 'Agent 已经不在等你选了')
  }
  if (!option) {
    throw apiError(409, 'menu_option_missing', `菜单上没有这一项：${pick}`)
  }
  await rpc('terminal.send', { terminal, text: menuKeys(menu, option.n), enter: false })
  return option
}
