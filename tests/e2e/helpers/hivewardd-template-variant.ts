// Change only template build identity to model an app update bundling a newer hivewardd.
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  HIVEWARDD_TEMPLATE_MANIFEST_FILENAME,
  HIVEWARDD_VERSION
} from '../../../src/shared/hivewardd-artifacts'

const ENTRY = 'hivewardd.js'

/** Rewrites `templateDir` in place; its manifest keeps verifying. */
export function makeHivewarddTemplateVariant(templateDir: string, tag: string): void {
  const entry = path.join(templateDir, ENTRY)
  appendFileSync(entry, `\n// hivewardd e2e template variant ${tag}\n`)
  const manifestPath = path.join(templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.commonSha256[ENTRY] = createHash('sha256').update(readFileSync(entry)).digest('hex')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The host's activation record, read the way a client reads it. */
export function readHostHivewarddActivation(exec: (command: string) => string): {
  active?: string
  previous?: string
  activeAppVersion?: string
} {
  return JSON.parse(exec('cat "$HOME/.hiveward-remote/hivewardd-active.json"'))
}

export function isHivewarddFullVersion(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${HIVEWARDD_VERSION}+`)
}
