import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@hiveward/process-host'
import { captureProbeEnvironment } from './exit-region-probe.mjs'

/**
 * 出口 IP 和它所在的地方（照 claude-env-check 的「出口一致性」）：
 * 用 Agent 实际用的登录 shell 网络环境，分别走 IPv4、IPv6 各查一次 IP 信息服务；
 * IPv6 单独从另一个国家 / 地区出去就是「双栈分裂」。
 * 只给电脑卡片看，不参与「能不能开 Claude Code / Codex」的判断（那个仍由 exit-region-probe 按国家定）。
 */
export const EXIT_IP_SOURCES = Object.freeze(['https://ipinfo.io/json', 'https://ipapi.co/json/'])
const TTL = 10 * 60 * 1000

/** ipinfo.io / ipapi.co 的回包 → { ip, city, region, country, org } */
export function parseIpInfo(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
  if (!isIP(ip)) {
    return null
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
  const country = str(body.country_code) ?? str(body.country)
  return {
    ip,
    city: str(body.city),
    region: str(body.region),
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    org: str(body.org)
  }
}

async function lookup(family, context, run) {
  const program =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
      : '/usr/bin/curl'
  for (const url of EXIT_IP_SOURCES) {
    try {
      const result = await run({
        program,
        args: [
          '--disable',
          family === 6 ? '-6' : '-4',
          '--silent',
          '--fail',
          '--proto',
          '=https',
          '--max-redirs',
          '0',
          '--connect-timeout',
          '4',
          '--max-time',
          '6',
          '--max-filesize',
          '16384',
          '--header',
          'accept: application/json',
          '--url',
          url
        ],
        env: context.env,
        cwd: context.cwd || homedir(),
        timeoutMs: 7000,
        maxOutputBytes: 16384,
        killOnOutputLimit: true
      })
      const info =
        result.code === 0 && !result.timedOut && !result.outputTruncated
          ? parseIpInfo(result.stdout)
          : null
      // 走 -6 却拿回 IPv4（或反过来）说明这一族根本没出去，不算
      if (info && isIP(info.ip) === family) {
        return info
      }
    } catch {}
  }
  return null
}

/** IPv6 从另一个国家 / 地区出去 */
export function isDualStackSplit(v4, v6) {
  return !!(
    v4 &&
    v6 &&
    (v4.country !== v6.country || (v4.region && v6.region && v4.region !== v6.region))
  )
}

export async function probeExitIp(context, run = runProcess) {
  const [v4, v6] = await Promise.all([lookup(4, context, run), lookup(6, context, run)])
  return { v4, v6, split: isDualStackSplit(v4, v6) }
}

/**
 * 缓存 10 分钟；current() 立刻返回上次结果（还没测过是 null），过期就在后台重测，
 * 不让「局域网」页等网络。
 */
export function createExitIp({
  capture = captureProbeEnvironment,
  probe = probeExitIp,
  now = Date.now
} = {}) {
  let snapshot = null
  let at = 0
  let inFlight = null
  function refresh() {
    inFlight ??= (async () => {
      try {
        const context = await capture({})
        const measured = await probe({ ...context, cwd: undefined })
        snapshot = {
          ...measured,
          checkedAt: new Date(now()).toISOString(),
          reason: measured.v4 || measured.v6 ? null : 'probe_failed'
        }
      } catch {
        snapshot = {
          v4: null,
          v6: null,
          split: false,
          checkedAt: new Date(now()).toISOString(),
          reason: 'shell_environment_unavailable'
        }
      }
      at = now()
      return snapshot
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }
  return {
    current() {
      if (!snapshot || now() - at > TTL) {
        void refresh()
      }
      return snapshot
    },
    refresh
  }
}
