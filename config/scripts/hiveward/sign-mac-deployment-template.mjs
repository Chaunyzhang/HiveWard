import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { HIVEWARDD_TEMPLATE_MANIFEST_FILENAME } = require('../../../src/shared/hivewardd-artifacts.ts')
const {
  findHivewarddTemplateMachOFiles,
  resealHivewarddTemplateManifest
} = require('../packaged-hivewardd-template.cjs')
const { resealSignedPackagedBrowser } = require('../packaged-hivewardd-browser.cjs')
const { verifyPackagedHivewarddTemplate } = require('../verify-packaged-hivewardd-template.cjs')

// 只重封此次可能签名的原生文件；JS 等其他内容改动仍由原有校验拒绝。
export function signMacWithDeploymentTemplate(resourcesDir, { signNested, signOuter }) {
  const template = join(resourcesDir, 'hivewardd-template')
  const present = existsSync(template)
  if (present) {
    verifyPackagedHivewarddTemplate(resourcesDir)
  }
  signNested()
  if (present) {
    resealHivewarddTemplateManifest(template, findHivewarddTemplateMachOFiles(template))
    const manifest = JSON.parse(
      readFileSync(join(template, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME), 'utf8')
    )
    const browsers = Object.entries(manifest.targets)
      .filter(([target, entry]) => target.startsWith('darwin-') && entry.packagedBrowser)
      .map(([, entry]) => entry.browserName)
    if (browsers.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name))) {
      throw new Error('Mac 部署模板包含不安全的浏览器文件名')
    }
    resealSignedPackagedBrowser(resourcesDir, browsers)
    verifyPackagedHivewarddTemplate(resourcesDir)
  }
  signOuter()
}
