import { spawnProcess, runProcess } from '@orca/process-host'
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// EOF survives parent SIGKILL; the guardian owns and reaps its dns-sd child.
const guardian = `
umask 077
export LC_ALL=C
file=$1
token=$2
limit=$3
shift 3
/usr/bin/dns-sd "$@" </dev/null &
child=$!
cleanup() {
  trap '' TERM INT HUP
  kill -TERM %1 2>/dev/null
  kill -KILL %1 2>/dev/null
  wait "$child" 2>/dev/null
  /bin/rm -f "$file" "$file.$token.tmp"
}
trap 'cleanup; exit' TERM INT HUP
started=$(/bin/ps -p "$child" -o lstart=)
printf '%s\\n%s /usr/bin/dns-sd %s\\n' "$child" "$started" "$*" > "$file.$token.tmp"
/bin/mv "$file.$token.tmp" "$file"
if [ "$limit" -gt 0 ]; then read -r -t "$limit" unused; else read -r unused; fi
cleanup
`
export function spawnBonjour(args, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const limit = args[0] === '-L' ? '4' : args[0] === '-G' ? '3' : '0'
  const child = spawnProcess({
    program: '/bin/sh',
    args: [
      '-c',
      guardian,
      'hiveward-dnssd-guardian',
      join(directory, token),
      token,
      limit,
      ...args
    ],
    stdio: ['pipe', 'pipe', 'ignore']
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.stdin.on('error', () => {})
  child.stop = () => {
    child.stdin.end()
    return closed
  }
  return child
}

export function ownedOrphan(output, identity) {
  const match = /^\s*1\s+(.+)$/.exec(output.trim())
  return Boolean(
    identity &&
    match &&
    match[1].replace(/\s+/g, ' ') === identity.trim().replace(/\s+/g, ' ') &&
    /\s\/usr\/bin\/dns-sd\s/.test(identity)
  )
}
export async function cleanupBonjourOrphans(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const token of readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}$/.test(token)) {
      continue
    }
    const file = join(directory, token)
    try {
      const [pid, identity] = readFileSync(file, 'utf8').trim().split('\n')
      if (!/^\d+$/.test(pid)) {
        continue
      }
      const result = await runProcess({
        program: '/bin/ps',
        env: { ...process.env, LC_ALL: 'C' },
        args: ['-p', pid, '-o', 'ppid=,lstart=,command='],
        timeoutMs: 1000
      })
      if (ownedOrphan(result.stdout, identity)) {
        process.kill(Number(pid), 'SIGTERM')
        unlinkSync(file)
      } else if (!result.stdout.trim()) {
        unlinkSync(file)
      }
    } catch {}
  }
}

// Old registrations carry identity; old unmarked browsers/resolvers cannot be safely attributed.
export function legacyRegistrationPid(line, machine, port) {
  const match = /^\s*(\d+)\s+1\s+(?:\/usr\/bin\/)?dns-sd -R (.+)$/.exec(line)
  const suffix = ` _opc._tcp local ${port} id=${machine.id} v=`
  return match && match[2].includes(suffix) ? Number(match[1]) : null
}
export async function cleanupLegacyRegistration(machine, port) {
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-axo', 'pid=,ppid=,command='],
    timeoutMs: 1000
  })
  for (const line of result.stdout.split('\n')) {
    const pid = legacyRegistrationPid(line, machine, port)
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  }
}
