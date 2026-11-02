import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const source = resolve('opc/web')
const stage = resolve('.opc-build/cockpit')
mkdirSync(stage, { recursive: true })
for (const name of readdirSync(stage)) {
  if (name !== 'node_modules') {
    rmSync(join(stage, name), { recursive: true, force: true })
  }
}
cpSync(source, stage, {
  recursive: true,
  filter: (path) => !/(?:^|[\\/])(?:node_modules|dist|\.git)(?:[\\/]|$)|\.tsbuildinfo$/.test(path)
})
cpSync(resolve('opc/shared'), resolve('.opc-build/shared'), { recursive: true })
const pnpm = process.env.npm_execpath
if (!pnpm) {
  throw new Error('Run through pnpm build:cockpit')
}
const script = /\.[cm]?js$/i.test(pnpm)
const executable = script ? process.execPath : pnpm
const prefix = script ? [pnpm] : []
execFileSync(executable, [...prefix, 'install', '--frozen-lockfile'], {
  cwd: stage,
  stdio: 'inherit'
})
execFileSync(executable, [...prefix, 'build'], { cwd: stage, stdio: 'inherit' })
