// 用量：各家 Agent 的额度用了多少（5 小时窗口、每周窗口…），数据来自引擎的 RateLimitService，
// 和 HiveWard 状态栏同一份。只在 HiveWard 桌面 App 里有（引擎把 usage 传进 startCockpit）。
// 只往外给百分比和重置时间，账号、令牌这些一概不出 main。

const NAMES = {
  claude: 'Claude',
  codex: 'ChatGPT（Codex）',
  gemini: 'Gemini',
  opencodeGo: 'OpenCode Go',
  kimi: 'Kimi',
  antigravity: 'Antigravity',
  minimax: 'MiniMax',
  grok: 'Grok',
  cursor: 'Cursor',
  zcode: 'ZCode'
}

const WINDOWS = [
  ['session', '5 小时'],
  ['weekly', '每周'],
  ['fableWeekly', '每周（Fable）'],
  ['monthly', '每月']
]

function windowOf(w, label) {
  if (!w || !Number.isFinite(w.usedPercent)) {
    return null
  }
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    resetsAt: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt).toISOString() : undefined
  }
}

/** 引擎的 RateLimitState → 网页用的用量列表；没接过、没数据的那几家不列 */
export function usageSummary(state) {
  if (!state) {
    return { available: false, providers: [] }
  }
  const providers = Object.entries(NAMES).flatMap(([key, name]) => {
    const p = state[key]
    if (!p || p.status === 'unavailable') {
      return []
    }
    const windows = WINDOWS.map(([k, label]) => windowOf(p[k], label)).filter(Boolean)
    if (!windows.length && p.status !== 'error') {
      return []
    }
    return [
      {
        id: key,
        name,
        plan: p.planType ?? undefined,
        status: p.status,
        error: p.status === 'error' ? (p.error ?? '读不到') : undefined,
        windows,
        updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : undefined
      }
    ]
  })
  return { available: true, providers }
}

export function usageRoutes(usage) {
  if (!usage) {
    return []
  }
  return [
    ['GET', /^\/api\/usage$/, async () => usageSummary(usage.getState())],
    ['POST', /^\/api\/usage\/refresh$/, async () => usageSummary(await usage.refresh())]
  ]
}
