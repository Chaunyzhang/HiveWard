// 认出派单引擎贴进 Agent 的派单前言，只取 === TASK === 后面老板 / 上级写的正文。
// 照 src/shared/hiveward-dispatch-status-prompt.ts 的认法：可选的引导句、可选的 <pasted_content> 包裹、固定开头。

const LEAD =
  'Please carry out this task from my HiveWard coordinator by following the brief I pasted below.'
const PREFIX = 'You are working inside HiveWard, a multi-agent IDE.'
const MARKER = '=== TASK ==='
const PASTED = '<pasted_content'
// Claude Code 对话记录只存前一千多字，末尾写上这个
const TRUNCATED = /\n… \(truncated\)$/
// 派单引擎打进终端叫 Agent 去收消息的提示（src/main/runtime/orchestration/formatter.ts），不是谁说的话
const MAIL_NOTICE = /^You have (?:\d+ (?:new )?|new )orchestration messages?\b/

/** 是派单前言就返回开头位置，否则 -1 */
function preambleStart(text) {
  let start = text.length - text.trimStart().length
  if (text.startsWith(LEAD, start)) {
    start += LEAD.length
    start += text.slice(start).length - text.slice(start).trimStart().length
  }
  if (text.startsWith(PASTED, start)) {
    const close = text.indexOf('>', start)
    if (close === -1 || close - start > 64) {
      return -1
    }
    start = close + 1
    start += text.slice(start).length - text.slice(start).trimStart().length
  }
  return text.startsWith(PREFIX, start) ? start : -1
}

export const isDispatchPreamble = (text) => typeof text === 'string' && preambleStart(text) !== -1

/** 派单前言里的任务正文；不是派单前言、或正文被截掉了返回 undefined */
export function dispatchTaskBody(text) {
  if (!isDispatchPreamble(text)) {
    return undefined
  }
  // 单独成行的 === TASK ===：前言里引用的提交标题可能也带这串字
  const lines = text.split(/\r?\n/)
  const at = lines.indexOf(MARKER)
  if (at === -1) {
    return undefined
  }
  const body = lines
    .slice(at + 1)
    .join('\n')
    .replace(/<\/pasted_content>\s*$/, '')
    .trim()
  return body || undefined
}

/** Claude Code 记的是截断版：在完整派单原文（fullTexts）里找同一个开头的那条 */
export function truncatedPreambleBody(text, fullTexts) {
  // 截断处可能连固定开头都没留全：只认记下来的完整派单原文
  if (typeof text !== 'string' || !TRUNCATED.test(text)) {
    return undefined
  }
  const head = text.replace(TRUNCATED, '')
  const full = fullTexts.findLast((t) => t.startsWith(head))
  return full ? dispatchTaskBody(full) : undefined
}

/** 派单前言里写的任务编号 */
function dispatchTaskId(text) {
  return isDispatchPreamble(text) ? /Your task ID is:\s*(\S+)/.exec(text)?.[1] : undefined
}

const isMailNotice = (item) =>
  item.kind === 'user' && typeof item.text === 'string' && MAIL_NOTICE.test(item.text.trim())

/** 对话里不显示派单引擎叫 Agent 收消息的提示 */
export const withoutMailNotices = (items) => items.filter((item) => !isMailNotice(item))

/** 引擎读出的对话里派单前言只显示任务原文、不显示收消息提示：前言里有完整正文就取正文，截断了按任务编号用 taskSpec 取派单原文 */
export function showDispatchTasks(chat, taskSpec) {
  const items = withoutMailNotices(chat.items).map((item) => {
    if (item.kind !== 'user') {
      return item
    }
    const id = dispatchTaskId(item.text)
    const text = dispatchTaskBody(item.text) ?? (id ? taskSpec(id) : undefined)
    return text ? { ...item, text } : item
  })
  return { ...chat, items }
}
