import { runProcess, spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import type { ChildProcess } from 'node:child_process'
import type { ProcessSpec } from '@orca/process-host/process-spec'

const HELPER_TIMEOUT_MS = 10_000
const HELPER_MAX_OUTPUT_BYTES = 1024 * 1024
const WATCH_RESTART_MS = 1_000
const WATCH_MAX_PENDING_CHARS = 4096

export async function runClipboardHelper(spec: ProcessSpec, signal?: AbortSignal): Promise<string> {
  try {
    const result = await runProcess({
      ...spec,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeoutMs: HELPER_TIMEOUT_MS,
      maxOutputBytes: HELPER_MAX_OUTPUT_BYTES,
      killOnOutputLimit: true,
      terminationBarrier: true
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('clipboard_process_failed')
    }
    return result.stdout
  } catch {
    throw new Error('clipboard_process_failed')
  }
}

export function watchClipboardSequence(spec: ProcessSpec, onChange: () => void): () => void {
  const watcher = new ClipboardSequenceWatcher(spec, onChange)
  return () => watcher.stop()
}

class ClipboardSequenceWatcher {
  private child: ChildProcess | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private pending = ''
  private sequence: number | null = null
  private stopped = false

  constructor(
    private readonly spec: ProcessSpec,
    private readonly onChange: () => void
  ) {
    this.start()
  }

  stop(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.clearRestartTimer()
    const child = this.child
    this.child = null
    if (child) {
      void forceTerminateProcessTree(child)
    }
  }

  private start(): void {
    if (this.stopped || this.child || this.restartTimer) {
      return
    }
    let child: ChildProcess
    try {
      child = spawnProcess({ ...this.spec, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      this.scheduleRestart()
      return
    }
    this.child = child
    this.pending = ''
    child.stdout?.on('data', (chunk: Buffer | string) => this.receive(child, chunk))
    child.stdout?.on('error', () => this.fail(child))
    child.stderr?.on('data', () => {})
    child.stderr?.on('error', () => {})
    child.stdin?.on('error', () => {})
    child.stdin?.end()
    child.once('error', () => this.fail(child))
    child.once('close', () => this.fail(child))
  }

  private receive(child: ChildProcess, chunk: Buffer | string): void {
    if (this.stopped || this.child !== child) {
      return
    }
    this.pending += chunk.toString()
    if (this.pending.length > WATCH_MAX_PENDING_CHARS) {
      this.fail(child)
      return
    }
    const lines = this.pending.split('\n')
    this.pending = lines.pop() ?? ''
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }
      if (!/^\d+$/.test(line)) {
        this.fail(child)
        return
      }
      const sequence = Number(line)
      if (!Number.isSafeInteger(sequence)) {
        this.fail(child)
        return
      }
      if (this.sequence !== null && sequence !== this.sequence) {
        try {
          this.onChange()
        } catch {}
      }
      this.sequence = sequence
    }
  }

  private fail(child: ChildProcess): void {
    if (this.child !== child) {
      return
    }
    this.child = null
    void forceTerminateProcessTree(child)
    if (!this.stopped) {
      this.scheduleRestart()
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) {
      return
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, WATCH_RESTART_MS)
    this.restartTimer.unref?.()
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }
}
