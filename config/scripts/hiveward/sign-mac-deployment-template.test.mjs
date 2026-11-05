import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { writeHivewarddTemplateTestFixture } from '../hivewardd-template-test-fixture.mjs'
import { signMacWithDeploymentTemplate } from './sign-mac-deployment-template.mjs'

const require = createRequire(import.meta.url)
const { verifyPackagedHivewarddTemplate } = require('../verify-packaged-hivewardd-template.cjs')
const { referencePackagedHivewarddBrowser } = require('../packaged-hivewardd-browser.cjs')
const { HIVEWARDD_TEMPLATE_MANIFEST_FILENAME } = require('../../../src/shared/hivewardd-artifacts.ts')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

it('嵌套签名改写原生字节后，封装外层之前同步部署哈希', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-signing-'))
  try {
    const template = await writeHivewarddTemplateTestFixture(root)
    const native = join(
      template,
      'targets/darwin-arm64/node_modules/node-pty/build/Release/pty.node'
    )
    const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])
    writeFileSync(native, bytes)
    const index = join(template, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(readFileSync(index, 'utf8'))
    manifest.targets['darwin-arm64'].files['node_modules/node-pty/build/Release/pty.node'] =
      hash(bytes)
    writeFileSync(index, JSON.stringify(manifest))
    const browser = join(root, 'agent-browser-darwin-arm64')
    writeFileSync(browser, bytes)
    referencePackagedHivewarddBrowser(root)
    const outer = vi.fn(() => verifyPackagedHivewarddTemplate(root))
    signMacWithDeploymentTemplate(root, {
      signNested: () => {
        appendFileSync(native, 'new-signature')
        appendFileSync(browser, 'new-signature')
        expect(() => verifyPackagedHivewarddTemplate(root)).toThrow()
      },
      signOuter: outer
    })
    expect(outer).toHaveBeenCalledOnce()
    expect(() => verifyPackagedHivewarddTemplate(root)).not.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('不把其他脚本的改动当成签名变化放行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-signing-'))
  try {
    const template = await writeHivewarddTemplateTestFixture(root)
    const outer = vi.fn()
    expect(() =>
      signMacWithDeploymentTemplate(root, {
        signNested: () => appendFileSync(join(template, 'hivewardd.js'), 'unexpected-change'),
        signOuter: outer
      })
    ).toThrow()
    expect(outer).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
