import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
const root = path.resolve(import.meta.dirname, '../../..')
const product = JSON.parse(readFileSync(path.join(root, 'src/shared/opc-product.json'), 'utf8'))
const app = path.join(root, `dist/mac-arm64/${product.name}.app`)
const codesign = (args) => execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' })

// Local signing identity (certificate SHA-1 or name), never committed: OPC_SIGN_IDENTITY or
// .opc-tools/sign-identity. Ad-hoc builds get a new keychain partition (cdhash) on every build,
// so macOS asks for keychain access after each upgrade; a team-backed certificate keeps it stable.
const identityFile = path.join(root, '.opc-tools/sign-identity')
const identity =
  process.env.OPC_SIGN_IDENTITY?.trim() ||
  (existsSync(identityFile) ? readFileSync(identityFile, 'utf8').trim() : '') ||
  '-'
const sign = ['--sign', identity, ...(identity === '-' ? [] : ['--timestamp=none'])]
console.log(`signing ${product.name}.app with ${identity === '-' ? 'ad-hoc' : identity}`)

codesign([
  '--force',
  '--deep',
  ...sign,
  '--entitlements',
  path.join(root, 'resources/build/entitlements.mac.plist'),
  app
])
// The upstream daemon copier verifies the helper against the outer app's designated identity.
codesign([
  '--force',
  ...sign,
  '--entitlements',
  path.join(root, 'resources/build/entitlements.mac.plist'),
  '-r',
  `=designated => identifier "${product.appId}"`,
  app
])
codesign(['--verify', '--deep', '--strict', '--verbose=2', app])
codesign([
  '--verify',
  '--strict',
  '-R',
  `=identifier "${product.appId}"`,
  path.join(app, 'Contents/Helpers/Orca Terminal Host.app')
])
