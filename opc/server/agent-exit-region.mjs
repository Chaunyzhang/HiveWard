import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './data-dir.mjs'
import {
  captureProbeEnvironment,
  environmentFingerprint,
  probeExitRegion,
  EXIT_REGION_LIMITATION
} from './exit-region-probe.mjs'

export const DEFAULT_EXIT_POLICY = { claude: ['US'], codex: ['US'], kimi: null }
const fail = (message, details) =>
  Object.assign(new Error(message), { status: 403, code: 'exit_region_blocked', details })
function validPolicy(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    ['claude', 'codex', 'kimi'].every(
      (agent) =>
        (agent === 'kimi' && value[agent] === null) ||
        (Array.isArray(value[agent]) &&
          value[agent].length <= 249 &&
          value[agent].every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX'))
    )
  )
}
export function commandAgent(command) {
  if (typeof command !== 'string') {
    return null
  }
  return (
    /(?:^|[\s/\\"';|&])(?:claude|codex)(?:\.exe|\.cmd)?(?=$|[\s"';|&])/i
      .exec(command)?.[0]
      .match(/claude|codex/i)?.[0]
      .toLowerCase() ?? (/^kimi(?:\s|$)/.test(command) ? 'kimi' : null)
  )
}

export function createExitRegionGuard({
  directory = dataDir(),
  capture = captureProbeEnvironment,
  probe = probeExitRegion,
  fingerprint = environmentFingerprint,
  now = Date.now,
  onWarning = () => {}
} = {}) {
  const file = join(directory, 'agent-exit-region-policy.json')
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(file, `${JSON.stringify(DEFAULT_EXIT_POLICY, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e
    }
  }
  let cache
  let inFlight
  let generation = 0
  const warnings = new Map()
  const policy = () => {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (!validPolicy(value)) {
        throw new Error('invalid_policy')
      }
      return value
    } catch (e) {
      if (e.code === 'ENOENT') {
        return structuredClone(DEFAULT_EXIT_POLICY)
      }
      throw fail('出口地区策略文件无效，已拒绝启动，请在设置中重新保存策略。', {
        reason: 'policy_invalid'
      })
    }
  }
  const project = (result, allowedCountries) => ({
    ...result,
    limitation: EXIT_REGION_LIMITATION,
    agents: Object.fromEntries(
      Object.entries(allowedCountries).map(([agent, countries]) => [
        agent,
        {
          allowed:
            countries === null || (result.country !== null && countries.includes(result.country)),
          allowedCountries: countries
        }
      ])
    )
  })
  async function status({ fresh = false, cwd, shell } = {}) {
    let context
    try {
      context = { ...(await capture({ cwd, shell })), cwd }
      if (!context.env || !context.shell) {
        throw new Error('environment_unavailable')
      }
    } catch {
      generation++
      inFlight = undefined
      cache = undefined
      return project(
        {
          country: null,
          checkedAt: new Date(now()).toISOString(),
          method: 'unavailable',
          source: null,
          reason: 'shell_environment_unavailable'
        },
        policy()
      )
    }
    const key = fingerprint(context)
    const ageLimit = fresh ? 60000 : 180000
    if (cache?.key === key && now() - cache.at < ageLimit) {
      return project(cache.result, policy())
    }
    const requestedGeneration = generation
    if (!inFlight || inFlight.key !== key) {
      const promise = (async () => {
        let measured
        try {
          measured = await probe(context)
        } catch {
          measured = { country: null, method: 'unavailable', source: null, reason: 'probe_failed' }
        }
        const country =
          typeof measured.country === 'string' &&
          /^[A-Z]{2}$/.test(measured.country) &&
          measured.country !== 'XX'
            ? measured.country
            : null
        const result = {
          country,
          checkedAt: new Date(now()).toISOString(),
          method: measured.method,
          source: measured.source ?? null,
          reason: country ? null : (measured.reason ?? 'probe_failed')
        }
        if (generation === requestedGeneration) {
          cache = { key, at: now(), result }
        }
        return result
      })()
      inFlight = { key, promise }
      void promise.finally(() => {
        if (inFlight?.promise === promise) {
          inFlight = undefined
        }
      })
    }
    return project(await inFlight.promise, policy())
  }
  async function assertAllowed(agent, context = {}) {
    const allowed = policy()[agent]
    if (allowed === null || allowed === undefined) {
      return
    }
    const state = await status({ ...context, fresh: true })
    if (!state.agents[agent].allowed) {
      const country = state.country ?? '未知（检测失败或登录 shell 环境不可用）'
      throw fail(
        `拒绝启动 ${agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent}：本机出口国家为 ${country}，允许国家为 ${allowed.join('、') || '无'}。请切换合规出口后重试。${EXIT_REGION_LIMITATION}`,
        {
          agent,
          country: state.country,
          allowedCountries: allowed,
          checkedAt: state.checkedAt,
          method: state.method,
          reason: state.reason ?? 'country_not_allowed'
        }
      )
    }
  }
  return {
    policy,
    status,
    assertAllowed,
    invalidate() {
      generation++
      cache = undefined
      inFlight = undefined
    },
    setPolicy(value) {
      if (!validPolicy(value)) {
        throw Object.assign(
          new Error(
            '策略必须包含 claude、codex、kimi；国家使用两位大写代码，仅 kimi 可以为 null（不限）。'
          ),
          { status: 400, code: 'bad_request' }
        )
      }
      mkdirSync(directory, { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      chmodSync(temp, 0o600)
      renameSync(temp, file)
      generation++
      cache = undefined
      return policy()
    },
    async beforeRpc(method, params = {}) {
      if (method !== 'terminal.create') {
        return
      }
      const commandKind = commandAgent(params.command)
      if (params.launchAgent && commandKind && params.launchAgent !== commandKind) {
        throw fail('启动命令与声明的 Agent 不一致，已拒绝启动。', { reason: 'agent_mismatch' })
      }
      const agent = commandKind || params.launchAgent
      if (!agent) {
        return
      }
      const cwd =
        params.cwd || (params.worktree?.startsWith('path:') ? params.worktree.slice(5) : undefined)
      if (
        (params.command && !new RegExp(`^${agent}(?:\\s|$)`).test(params.command)) ||
        params.executionHostId ||
        (cwd ?? '').startsWith('\\\\') ||
        params.env ||
        params.shell
      ) {
        if (policy()[agent] !== null && policy()[agent] !== undefined) {
          throw fail('无法验证此自定义或远程终端环境的出口地区，请通过目标电脑的 HiveWard 启动。', {
            agent,
            reason: 'unsupported_launch_environment'
          })
        }
      }
      await assertAllowed(agent, { cwd })
    },
    async observe(terminals) {
      const live = new Set()
      for (const terminal of terminals) {
        const agent = terminal.agent || commandAgent(terminal.agentIdentity)
        if (!agent || !terminal.connected) {
          continue
        }
        const key = `${terminal.handle}/${agent}`
        live.add(key)
        try {
          await assertAllowed(agent, { cwd: terminal.worktreePath })
          warnings.delete(key)
        } catch (e) {
          if (e.code !== 'exit_region_blocked') {
            throw e
          }
          if (warnings.has(key)) {
            continue
          }
          const warning = {
            id: randomUUID(),
            terminal: terminal.handle,
            agent,
            country: e.details?.country ?? null,
            detectedAt: new Date(now()).toISOString(),
            message: `发现终端正在运行受限 Agent。${e.message} 当前进程未自动终止，请手动处理。`
          }
          warnings.set(key, warning)
          onWarning(warning)
        }
      }
      for (const key of warnings.keys()) {
        if (!live.has(key)) {
          warnings.delete(key)
        }
      }
    },
    warnings: () => [...warnings.values()]
  }
}
let active
export function configureExitRegionGuard(guard) {
  active = guard
}
export function exitRegionGuard() {
  return (active ??= createExitRegionGuard())
}
