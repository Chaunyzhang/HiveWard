import { windowsProxyRoute } from './windows-proxy-route.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { networkInterfaces, homedir } from 'node:os'
import { basename, win32, join } from 'node:path'
import { runProcess } from '@hiveward/process-host'

export const EXIT_REGION_TARGETS = Object.freeze([
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://one.one.one.one/cdn-cgi/trace',
  'https://cloudflare-dns.com/cdn-cgi/trace'
])
export const EXIT_REGION_LIMITATION =
  '中立地址与 Agent 服务商可能被分流到不同出口，建议开 TUN 或全局模式；本检测不访问 Anthropic / OpenAI，也不能证明其域名的实际出口。'
const proxyKeys = [
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy'
]

export async function captureProbeEnvironment({ shell, cwd } = {}, run = runProcess) {
  const program =
    shell ||
    process.env.SHELL ||
    (process.platform === 'win32'
      ? 'powershell.exe'
      : process.platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash')
  const name = win32.basename(basename(program)).toLowerCase()
  const marker = `HIVEWARD_REGION_${randomUUID().replaceAll('-', '')}`
  let args
  let powershell = false
  if (['zsh', 'bash', 'fish', 'sh'].includes(name)) {
    args = ['-ilc', `printf '\\0${marker}\\0'; /usr/bin/env -0; printf '\\0${marker}_END\\0'`]
  } else if (['powershell.exe', 'pwsh.exe', 'pwsh'].includes(name)) {
    powershell = true
    args = [
      '-NoLogo',
      '-NonInteractive',
      '-Command',
      `$v = @{}; [Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { $v[[string]$_.Key] = [string]$_.Value }; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write('${marker}'); [Console]::Write(($v | ConvertTo-Json -Compress)); [Console]::Write('${marker}_END')`
    ]
  } else {
    throw new Error('shell_environment_unavailable')
  }
  const result = await run({
    program,
    args,
    cwd: cwd || homedir(),
    env: process.env,
    timeoutMs: 6000,
    maxOutputBytes: 256 * 1024,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('shell_environment_unavailable')
  }
  const start = powershell ? marker : `\0${marker}\0`
  const end = powershell ? `${marker}_END` : `\0${marker}_END\0`
  const offset = result.stdout.indexOf(start)
  const ending = result.stdout.indexOf(end, offset + start.length)
  if (offset === -1 || ending === -1) {
    throw new Error('shell_environment_unavailable')
  }
  const text = result.stdout.slice(offset + start.length, ending)
  const env = powershell
    ? JSON.parse(text)
    : Object.fromEntries(
        text
          .split('\0')
          .filter((s) => s.includes('='))
          .map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)])
      )
  return { env, shell: program }
}

export function environmentFingerprint(context, interfaces = networkInterfaces()) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shell: context.shell,
        cwd: context.cwd,
        proxy: proxyKeys.map((k) => [k, context.env[k]]),
        interfaces
      })
    )
    .digest('hex')
}

export function parseTraceCountry(text) {
  const matches = [...text.matchAll(/^loc=([A-Z]{2})\r?$/gm)]
  return matches.length === 1 && matches[0][1] !== 'XX' ? matches[0][1] : null
}

export async function probeExitRegion(context, run = runProcess) {
  const proxy = !!(
    context.env.https_proxy ||
    context.env.HTTPS_PROXY ||
    context.env.all_proxy ||
    context.env.ALL_PROXY
  )
  if (process.platform === 'win32') {
    const reason = await windowsProxyRoute(context.env, run)
    if (reason) {
      return { country: null, method: 'windows-route-check', source: null, reason }
    }
  }
  const program =
    process.platform === 'win32'
      ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
      : '/usr/bin/curl'
  for (const url of EXIT_REGION_TARGETS) {
    try {
      const result = await run({
        program,
        args: [
          '--disable',
          '--silent',
          '--show-error',
          '--fail',
          '--proto',
          '=https',
          '--max-redirs',
          '0',
          '--connect-timeout',
          '3',
          '--max-time',
          '5',
          '--max-filesize',
          '16384',
          '--write-out',
          '\nHIVEWARD_HTTP_STATUS=%{http_code}',
          '--url',
          url
        ],
        env: context.env,
        cwd: context.cwd || homedir(),
        timeoutMs: 6000,
        maxOutputBytes: 16384,
        killOnOutputLimit: true
      })
      const country =
        result.code === 0 &&
        !result.timedOut &&
        !result.outputTruncated &&
        result.stdout.endsWith('HIVEWARD_HTTP_STATUS=200')
          ? parseTraceCountry(result.stdout)
          : null
      if (country) {
        return {
          country,
          method: proxy ? 'login-shell-proxy-trace' : 'login-shell-route-trace',
          source: url,
          reason: null
        }
      }
    } catch {}
  }
  return {
    country: null,
    method: proxy ? 'login-shell-proxy-trace' : 'login-shell-route-trace',
    source: null,
    reason: 'probe_failed'
  }
}
