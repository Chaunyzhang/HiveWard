// 对引擎 errored 提醒分原因；保留 Kimi 丢消息的滚动记录识别。
const stripAnsi = (s) =>
  s.replace(
    // oxlint-disable-next-line no-control-regex -- 去掉终端转义序列，本来就要匹配 ESC 控制字符
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g,
    ''
  )

// 先认额度 / 认证 / 过载，再认限流，最后才是笼统的「模型服务报错」
const QUOTA =
  /exceeded_current_quota|insufficient_quota|exceeded your current quota|usage limit|hit your (?:usage )?limit|limit reached|quota exceeded|out of credits|credit balance is too low|billing/i
const AUTH =
  /\b401\b|authentication_error|authentication failed|unauthori[sz]ed|invalid (?:api|x-api) key|invalid_api_key|please run \/login|oauth token (?:has )?expired|token (?:has )?expired|permission_error|\b403 forbidden/i
const OVERLOADED =
  /\b529\b|overloaded|\b503\b|service unavailable|server is busy|engine_overloaded/i
const RATE = /\b429\b|rate.?limit|too many requests/i
export const ERROR_STOP_LABELS = {
  quota: '额度用完',
  rate_limit: '请求太频繁被限流',
  overloaded: '模型服务过载',
  auth: '登录失效',
  api: '模型服务报错'
}

/** 一行报错是哪一类 */
export function errorStopReason(line) {
  return QUOTA.test(line)
    ? 'quota'
    : AUTH.test(line)
      ? 'auth'
      : OVERLOADED.test(line)
        ? 'overloaded'
        : RATE.test(line)
          ? 'rate_limit'
          : 'api'
}

const lines = (text) =>
  stripAnsi(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** 屏幕上 Kimi 报「Queued message dropped: …」丢掉的那几条消息（原文开头），按出现顺序去重 */
export function droppedQueuedMessages(text) {
  const out = []
  for (const l of lines(text)) {
    const m = /Queued message dropped:\s*(.+)$/i.exec(l)
    const msg = m?.[1].trim()
    if (msg && !out.includes(msg)) {
      out.push(msg)
    }
  }
  return out
}

/** 额度用完那句（hiwd 用，网页有自己的一份带翻译的）：「额度用完 · 约 03:25 恢复」；没有恢复时间就只写「额度用完」 */
export function quotaLabel(resetsAt, now = Date.now()) {
  if (!resetsAt || Date.parse(resetsAt) <= now) {
    return '额度用完'
  }
  const t = new Date(resetsAt)
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const sameDay = new Date(now).toDateString() === t.toDateString()
  return `额度用完 · 约${sameDay ? '' : ` ${t.getMonth() + 1}/${t.getDate()}`} ${hm} 恢复`
}
