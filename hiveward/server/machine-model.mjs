import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@hiveward/process-host'

/** 电脑型号，给局域网页的卡片看：Mac「MacBook Pro · Apple M3 Pro」，Windows「厂商 型号」 */
export function parseMacHardware(text) {
  try {
    const hw = JSON.parse(text)?.SPHardwareDataType?.[0]
    const name = hw?.machine_name?.trim()
    const chip = (hw?.chip_type ?? hw?.cpu_type)?.trim()
    return name ? [name, chip].filter(Boolean).join(' · ') : null
  } catch {
    return null
  }
}

// 主板 / 整机厂商留着没意义的占位值
const PLACEHOLDER = /^(to be filled|default string|system product name|system manufacturer|o\.e\.m\.|none)$/i

export function parseWindowsHardware(text) {
  try {
    const { Manufacturer, Model } = JSON.parse(text) ?? {}
    const parts = [Manufacturer, Model]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v && !PLACEHOLDER.test(v))
    return parts.length ? parts.join(' ').slice(0, 120) : null
  } catch {
    return null
  }
}

async function measure(run, platform) {
  if (platform === 'darwin') {
    const r = await run({
      program: '/usr/sbin/system_profiler',
      args: ['SPHardwareDataType', '-json'],
      timeoutMs: 15000,
      maxOutputBytes: 256 * 1024,
      killOnOutputLimit: true
    })
    return r.code === 0 ? parseMacHardware(r.stdout) : null
  }
  if (platform === 'win32') {
    const r = await run({
      program: join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      args: [
        '-NoLogo',
        '-NonInteractive',
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model | ConvertTo-Json -Compress'
      ],
      timeoutMs: 15000,
      maxOutputBytes: 64 * 1024,
      killOnOutputLimit: true
    })
    return r.code === 0 ? parseWindowsHardware(r.stdout) : null
  }
  const name = await readFile('/sys/devices/virtual/dmi/id/product_name', 'utf8').catch(() => '')
  return name.trim() || null
}

/** 型号不会变：每次启动测一次；current() 立刻返回（还没测完是 null） */
export function createMachineModel({ run = runProcess, platform = process.platform } = {}) {
  let value = null
  const ready = measure(run, platform)
    .catch(() => null)
    .then((v) => {
      value = v
      return v
    })
  return { current: () => value, ready }
}
