import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { createRequire } from 'node:module'
import { generateLanCertificate } from './lan-certificate.mjs'

const certificateTimes = (pem) => {
  const der = new X509Certificate(pem).raw
  const times = []
  for (let i = 0; i + 1 < der.length; i++) {
    const length = der[i + 1]
    if ((der[i] === 0x17 && length === 13) || (der[i] === 0x18 && length === 15)) {
      times.push(der.subarray(i + 2, i + 2 + length).toString('latin1'))
    }
  }
  return times
}

test('certificate validity uses strict RFC 5280 time strings', () => {
  const times = certificateTimes(generateLanCertificate().cert)
  assert.equal(times.length, 2)
  for (const time of times) {
    assert.match(time, /^(?:\d{12}|\d{14})Z$/)
  }
})

// Electron 用 BoringSSL，比 Node 的 OpenSSL 严格；Node 能解析不代表 App 里能解析。
test('Electron runtime parses the generated certificate', (t) => {
  let electron
  try {
    electron = createRequire(import.meta.url)('electron')
  } catch {
    t.skip('electron is not installed')
    return
  }
  if (typeof electron !== 'string') {
    t.skip('electron binary path is unavailable')
    return
  }
  const script = `
    const { X509Certificate, createPrivateKey } = require('node:crypto')
    const { cert, key } = JSON.parse(process.argv[1])
    const certificate = new X509Certificate(cert)
    if (!certificate.checkPrivateKey(createPrivateKey(key))) process.exit(2)
  `
  execFileSync(electron, ['-e', script, JSON.stringify(generateLanCertificate())], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe'
  })
})
