const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { HIVEWARDD_TEMPLATE_MANIFEST_FILENAME } = require('../../src/shared/hivewardd-artifacts.ts')
const { hivewarddAgentBrowserNativeName } = require('../../src/shared/hivewardd-agent-browser-name.ts')
const { verifyPackagedHivewarddTemplate } = require('./verify-packaged-hivewardd-template.cjs')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function targetBrowserName(target) {
  const [platform, arch] = target.split('-')
  return hivewarddAgentBrowserNativeName(platform, arch, target.endsWith('-musl') ? 'musl' : 'glibc')
}

function manifestPath(resourcesDir) {
  return join(resourcesDir, 'hivewardd-template', HIVEWARDD_TEMPLATE_MANIFEST_FILENAME)
}

/** The template omits drivers for size; point a target at the app's own copy so its slot still gets one (#33846). */
function referencePackagedHivewarddBrowser(resourcesDir) {
  const path = manifestPath(resourcesDir)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const referenced = []
  for (const [target, entry] of Object.entries(manifest.targets)) {
    const browserName = targetBrowserName(target)
    if (entry.browserName || !existsSync(join(resourcesDir, browserName))) {
      continue
    }
    entry.browserName = browserName
    entry.browserSha256 = sha256(join(resourcesDir, browserName))
    entry.packagedBrowser = true
    referenced.push(target)
  }
  if (referenced.length > 0) {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  verifyPackagedHivewarddTemplate(resourcesDir)
  return referenced
}

/** Reseal referenced drivers the Windows signer rewrote; `signedResourcePaths` are resources-relative. */
function resealSignedPackagedBrowser(resourcesDir, signedResourcePaths) {
  const path = manifestPath(resourcesDir)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const signed = new Set(signedResourcePaths)
  for (const entry of Object.values(manifest.targets)) {
    if (entry.packagedBrowser && signed.has(entry.browserName)) {
      entry.browserSha256 = sha256(join(resourcesDir, entry.browserName))
    }
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

module.exports = { referencePackagedHivewarddBrowser, resealSignedPackagedBrowser }
