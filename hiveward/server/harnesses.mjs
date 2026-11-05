// 本机装了哪些 Agent（Harness），分两类：
// - Personal Agent：常驻的 AI 同事（Grok Bot、Hermes、OpenClaw、Muse…），坐业务的 Personal Agent 位；
// - Coding Agent：写代码的命令行（Claude Code、Codex、OpenCode、Kimi…），坐 CEO / Leader / 下属位。
// 命令行由引擎检测（preflight.detectAgents，和 HiveWard 设置页「已安装」同一份，会补齐登录 shell 的 PATH）；
// 桌面 App 看 /Applications、~/Applications 里有没有。只读，不启动任何东西。
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { call } from './hiveward-client.mjs'
import { badRequest } from './business.mjs'

/** Personal Agent：有桌面 App 的看 App，有命令行的看命令行，有一样就算装了 */
export const PERSONAL_AGENTS = {
  grokbot: { name: 'Grok Bot', maker: 'xAI', apps: ['Grok Bot.app'] },
  hermes: { name: 'Hermes', maker: 'Nous Research', apps: ['Hermes.app'], cli: 'hermes' },
  openclaw: { name: 'OpenClaw', maker: 'OpenClaw', apps: ['OpenClaw.app'], cli: 'openclaw' },
  muse: { name: 'Muse', maker: 'Meta', cli: 'muse' }
}

// 引擎认得的命令行（和 HiveWard 设置页同名）；Personal Agent 的命令行不在这里
const CODING_NAMES = {
  claude: 'Claude Code',
  'claude-agent-teams': 'Claude Agent Teams',
  codex: 'Codex',
  opencode: 'OpenCode',
  opencode2: 'OpenCode 2',
  pi: 'Pi',
  omp: 'OMP',
  kimi: 'Kimi Code',
  grok: 'Grok CLI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  droid: 'Droid',
  amp: 'Amp',
  aider: 'Aider',
  goose: 'Goose',
  crush: 'Charm',
  cline: 'Cline',
  continue: 'Continue',
  'qwen-code': 'Qwen Code',
  'mistral-vibe': 'Mistral Vibe',
  dsh: 'DeepSeek Harness',
  codebuddy: 'CodeBuddy',
  openclaude: 'OpenClaude',
  devin: 'Devin',
  ante: 'Ante',
  trae: 'Trae',
  zcode: 'ZCode',
  autohand: 'Autohand Code',
  'mimo-code': 'MiMo Code',
  'prime-agent': 'Prime Agent',
  qoder: 'Qoder CLI',
  'qoder-cn': 'Qoder CLI China',
  kilo: 'Kilocode',
  kiro: 'Kiro',
  aug: 'Auggie',
  codebuff: 'Codebuff',
  freebuff: 'Freebuff',
  'command-code': 'Command Code',
  rovo: 'Rovo Dev',
  jcode: 'Jcode'
}

const CACHE_MS = 60_000
let cached = null

async function appVersion(path) {
  try {
    const plist = await readFile(join(path, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  } catch {
    return undefined
  }
}

async function findApp(names, dirs) {
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name)
      if (existsSync(path)) {
        return { path, version: await appVersion(path) }
      }
    }
  }
  return null
}

/**
 * 认一遍本机的 Agent。clis 是引擎检测到的命令行 id；拿不到（引擎没开）时 clis 为 null，
 * 只按 App 认 Personal Agent，Coding Agent 列表为空并带上 error。
 */
export async function classifyHarnesses({
  clis,
  error,
  appDirs = ['/Applications', join(homedir(), 'Applications')]
}) {
  const found = new Set(clis ?? [])
  const personal = []
  for (const [id, p] of Object.entries(PERSONAL_AGENTS)) {
    const app = p.apps && process.platform === 'darwin' ? await findApp(p.apps, appDirs) : null
    const cli = p.cli && found.has(id) ? p.cli : undefined
    personal.push({
      id,
      name: p.name,
      maker: p.maker,
      kind: 'personal',
      installed: !!(app || cli),
      ...(app ? { app: app.path, version: app.version } : {}),
      ...(cli ? { command: cli } : {})
    })
  }
  const coding = [...found]
    .filter((id) => !Object.hasOwn(PERSONAL_AGENTS, id))
    .map((id) => ({
      id,
      name: CODING_NAMES[id] ?? id,
      kind: 'coding',
      installed: true,
      command: id === 'claude-agent-teams' ? 'claude（Agent Teams）' : id
    }))
  return {
    personal,
    coding,
    checkedAt: new Date().toISOString(),
    ...(error ? { error } : {})
  }
}

async function detect(refresh) {
  try {
    const clis = refresh
      ? (await call('preflight.refreshAgents', {})).agents
      : await call('preflight.detectAgents', {})
    return classifyHarnesses({ clis: Array.isArray(clis) ? clis : [] })
  } catch (e) {
    return classifyHarnesses({ clis: null, error: `命令行没认出来：${e.message}` })
  }
}

export async function harnesses({ refresh = false } = {}) {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value
  }
  const value = await detect(refresh)
  cached = { at: Date.now(), value }
  return value
}

/** 业务的 Personal Agent 位坐谁：PERSONAL_AGENTS 里的 id，null 清空 */
export function personalAgentPatch(value) {
  if (value !== null && !Object.hasOwn(PERSONAL_AGENTS, value)) {
    throw badRequest(`personalAgent 必须是 ${Object.keys(PERSONAL_AGENTS).join('、')} 之一或 null`)
  }
  return value
}

/** Personal Agent 产品里具体哪一个 Agent（例如 Grok Bot 里的某个 Bot 的 id）；null 清空 */
export function personalAgentBotPatch(value) {
  if (value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw badRequest('personalAgentBot 必须是 Bot 的 id 或 null')
  }
  return value
}

export const harnessRoutes = [
  [
    'GET',
    /^\/api\/harnesses$/,
    async (_req, _p, url) => harnesses({ refresh: url.searchParams.has('refresh') })
  ]
]
