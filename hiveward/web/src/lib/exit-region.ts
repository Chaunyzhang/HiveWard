import type { AgentExitRegion } from '@shared/api'
import { locale, tr } from '@/lib/i18n'

const regionName = new Intl.DisplayNames([locale], { type: 'region' })

/** 国家码 → 中文名；未知返回「测不出」 */
export function countryName(code: string | null | undefined) {
  if (!code) {
    return tr('测不出')
  }
  try {
    return regionName.of(code) ?? code
  } catch {
    return code
  }
}

/**
 * 这台电脑上能不能开这个 Agent（安全底线：Claude Code / Codex 只在出口合规的电脑上开）。
 * 返回不能开的原因；能开、或者还没检测结果（交给后台判断）时返回 null。
 */
export function exitBlockReason(
  region: AgentExitRegion | null,
  agent: string | undefined
): string | null {
  const rule = agent && region?.agents[agent]
  if (!rule || rule.allowed) {
    return null
  }
  const allowed = (rule.allowedCountries ?? []).map(countryName).join('、')
  return region.country
    ? tr('这台电脑出口在{0}，{1} 只能在{2}出口的电脑上开', [
        countryName(region.country),
        agent === 'codex' ? 'ChatGPT' : 'Claude Code',
        allowed || tr('指定地区'),
      ])
    : tr('测不出这台电脑的出口地区，先不开受限的 Agent')
}
