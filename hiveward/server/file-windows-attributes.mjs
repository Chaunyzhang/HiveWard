import { spawnProcess } from '@hiveward/process-host'
import { fileError } from './file-path-policy.mjs'

// One worker uses literal paths over stdin; no per-file shell or command interpolation.
const script = `[Console]::InputEncoding = [Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); while ($null -ne ($line = [Console]::ReadLine())) { try { $q = $line | ConvertFrom-Json; $a = (Get-Item -Force -LiteralPath $q.path -ErrorAction Stop).Attributes; @{ id = $q.id; blocked = [bool]($a -band 6) } | ConvertTo-Json -Compress } catch { @{ id = $q.id; error = 'attributes_unavailable' } | ConvertTo-Json -Compress } }`
export function windowsFileAttributes(platform = process.platform) {
  let child,
    buffer = '',
    sequence = 0
  const waiting = new Map()
  const fail = () => {
    for (const pending of waiting.values()) {
      pending.reject(fileError(503, 'attributes_unavailable', '无法核实 Windows 文件属性'))
    }
    waiting.clear()
    child = undefined
  }
  return {
    async check(path) {
      if (platform !== 'win32') {
        return
      }
      if (!child) {
        child = spawnProcess({
          program: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', script],
          stdio: ['pipe', 'pipe', 'ignore']
        })
        child.on('error', fail)
        child.on('exit', fail)
        child.stdin.on('error', fail)
        child.stdout.on('data', (data) => {
          buffer += data.toString('utf8')
          let end
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end)
            buffer = buffer.slice(end + 1)
            try {
              const result = JSON.parse(line)
              const pending = waiting.get(result.id)
              waiting.delete(result.id)
              if (result.error || result.blocked) {
                pending?.reject(fileError(403, 'file_forbidden', '隐藏或系统文件不共享'))
              } else {
                pending?.resolve()
              }
            } catch {
              fail()
            }
          }
        })
      }
      await new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(fileError(503, 'attributes_unavailable', '读取文件属性超时'))
        }, 5000)
        waiting.set(id, {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          }
        })
        child.stdin.write(`${JSON.stringify({ id, path })}\n`)
      })
    },
    close() {
      child?.stdin.end()
    }
  }
}
