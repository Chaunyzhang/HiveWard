import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  businessIdentity,
  clearProjectIdentityCache,
  detectProjectIdentity
} from './project-identity.mjs'

test.beforeEach(() => clearProjectIdentityCache())

async function tempProject(t, name = 'sample-app') {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-project-identity-'))
  const dir = join(root, name)
  await mkdir(dir)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { dir, root }
}

async function put(root, file, contents = '') {
  const path = join(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return path
}

const putJson = (root, file, value) => put(root, file, JSON.stringify(value))

test('package productName and resources icon win over all lower-priority candidates', async (t) => {
  const { dir } = await tempProject(t)
  await putJson(dir, 'package.json', {
    productName: 'Package Product',
    build: { productName: 'Package Builder' },
    name: '@scope/package-name'
  })
  await putJson(dir, 'electron-builder.json', { productName: 'Builder JSON' })
  await put(dir, 'electron-builder.yml', 'productName: Builder YAML\n')
  await putJson(dir, 'src-tauri/tauri.conf.json', { productName: 'Tauri Product' })
  await putJson(dir, 'app.json', { expo: { name: 'Expo Product' } })
  await put(dir, 'README.md', '# README Product\n')
  const icon = await put(dir, 'resources/icon.png', 'png')
  await put(dir, 'build/icon.svg', '<svg/>')
  await put(dir, 'logo.ico', 'ico')
  const identity = await detectProjectIdentity(dir)
  assert.equal(identity.name, 'Package Product')
  assert.equal(identity.logo.path, await realpath(icon))
  assert.equal(identity.logo.contentType, 'image/png')
  assert.equal(identity.logo.size, 3)
})

test('application config, README, scoped package, and basename fallback order', async (t) => {
  const { dir } = await tempProject(t, 'fallback-directory')
  await putJson(dir, 'package.json', {
    build: { productName: 'Package Builder' },
    name: '@scope/scoped-package'
  })
  await putJson(dir, 'electron-builder.json', { productName: 'Builder JSON' })
  await put(dir, 'electron-builder.yml', 'productName: "Builder YAML" # comment\n')
  await putJson(dir, 'src-tauri/tauri.conf.json', { productName: 'Tauri Product' })
  await putJson(dir, 'app.json', { expo: { name: 'Expo Product' } })
  await put(dir, 'README.md', '# README Product\n')
  assert.equal((await detectProjectIdentity(dir)).name, 'Package Builder')
  await putJson(dir, 'package.json', { name: '@scope/scoped-package' })
  assert.equal((await detectProjectIdentity(dir)).name, 'Builder JSON')
  await rm(join(dir, 'electron-builder.json'))
  assert.equal((await detectProjectIdentity(dir)).name, 'Builder YAML')
  await rm(join(dir, 'electron-builder.yml'))
  assert.equal((await detectProjectIdentity(dir)).name, 'Tauri Product')
  await rm(join(dir, 'src-tauri/tauri.conf.json'))
  assert.equal((await detectProjectIdentity(dir)).name, 'Expo Product')
  await rm(join(dir, 'app.json'))
  assert.equal((await detectProjectIdentity(dir)).name, 'README Product')
  await rm(join(dir, 'README.md'))
  assert.equal((await detectProjectIdentity(dir)).name, 'scoped-package')
  await rm(join(dir, 'package.json'))
  assert.equal((await detectProjectIdentity(dir)).name, 'fallback-directory')
})

test('README title is cleaned and long or sentence-like titles are rejected', async (t) => {
  const { dir } = await tempProject(t)
  await putJson(dir, 'package.json', { name: '@scope/readme-fallback' })
  await put(
    dir,
    'README.md',
    '## Ignored\n# **Nebula** [Desk](https://example.com) ![mark](mark.png) #\n'
  )
  assert.equal((await detectProjectIdentity(dir)).name, 'Nebula Desk')
  await put(dir, 'README.md', `# ${'A'.repeat(61)}\n# Second Heading\n`)
  assert.equal((await detectProjectIdentity(dir)).name, 'readme-fallback')
  await put(dir, 'README.md', '# This is a project\n# Second Heading\n')
  assert.equal((await detectProjectIdentity(dir)).name, 'readme-fallback')
})

test('malformed metadata is ignored without preventing later fallbacks', async (t) => {
  const { dir } = await tempProject(t, 'malformed-fallback')
  await put(dir, 'package.json', '{not json')
  await put(dir, 'electron-builder.yml', 'productName: Valid YAML\n')
  assert.equal((await detectProjectIdentity(dir)).name, 'Valid YAML')
  await rm(join(dir, 'electron-builder.yml'))
  assert.equal((await detectProjectIdentity(dir)).name, 'malformed-fallback')
})

test('logo detection skips oversized and non-regular files and uses the next MIME type', async (t) => {
  const { dir } = await tempProject(t)
  await put(dir, 'resources/icon.png', Buffer.alloc(256 * 1024 + 1))
  await mkdir(join(dir, 'build/icon.svg'), { recursive: true })
  const favicon = await put(dir, 'public/favicon.ico', 'ico')
  const identity = await detectProjectIdentity(dir)
  assert.equal(identity.logo.path, await realpath(favicon))
  assert.equal(identity.logo.contentType, 'image/x-icon')
  assert.equal(identity.logo.size, 3)
})

test('a 256 KiB JPEG icon is accepted', async (t) => {
  const { dir } = await tempProject(t)
  const icon = await put(dir, 'app/icon.jpeg', Buffer.alloc(256 * 1024))
  const identity = await detectProjectIdentity(dir)
  assert.equal(identity.logo.path, await realpath(icon))
  assert.equal(identity.logo.contentType, 'image/jpeg')
  assert.equal(identity.logo.size, 256 * 1024)
})

test('logo symlinks escaping the canonical project root are rejected', async (t) => {
  const { dir, root } = await tempProject(t)
  const outside = await put(root, 'outside.png', 'outside')
  await mkdir(join(dir, 'resources'))
  try {
    await symlink(outside, join(dir, 'resources/icon.png'))
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('file symlinks are not permitted')
      return
    }
    throw error
  }
  assert.equal((await detectProjectIdentity(dir)).logo, null)
})

test('cache reuses unchanged results and invalidates mtime and new higher-priority files', async (t) => {
  const { dir } = await tempProject(t)
  await putJson(dir, 'package.json', { name: '@scope/fallback' })
  await put(dir, 'README.md', '# Cached Name\n')
  const logo = await put(dir, 'logo.png', 'one')
  const first = await detectProjectIdentity(dir)
  assert.equal(first.name, 'Cached Name')
  assert.strictEqual(await detectProjectIdentity(dir), first)

  const config = await put(dir, 'electron-builder.yml', 'productName: First\n')
  const withConfig = await detectProjectIdentity(dir)
  assert.equal(withConfig.name, 'First')
  assert.notStrictEqual(withConfig, first)

  await writeFile(config, 'productName: Other\n')
  const configTime = new Date(Date.now() + 10000)
  await utimes(config, configTime, configTime)
  assert.equal((await detectProjectIdentity(dir)).name, 'Other')

  const priorLogoMtime = withConfig.logo.mtimeMs
  const logoTime = new Date(Date.now() + 20000)
  await utimes(logo, logoTime, logoTime)
  const touched = await detectProjectIdentity(dir)
  assert.ok(touched.logo.mtimeMs > priorLogoMtime)

  const preferredIcon = await put(dir, 'resources/icon.svg', '<svg/>')
  const withPreferredIcon = await detectProjectIdentity(dir)
  assert.equal(withPreferredIcon.logo.path, await realpath(preferredIcon))
  assert.equal(withPreferredIcon.logo.contentType, 'image/svg+xml')
})

test('business identity defaults to auto, preserves user names, and builds versioned logo URLs', async (t) => {
  const { dir } = await tempProject(t)
  await putJson(dir, 'package.json', { productName: 'Detected Product' })
  const icon = await put(dir, 'resources/icon.png', 'png')
  const business = {
    id: 'team/a project?',
    name: 'Legacy Placeholder',
    workspacePath: dir
  }
  const expectedLogo = `/api/businesses/${encodeURIComponent(business.id)}/logo?v=${Math.trunc((await stat(icon)).mtimeMs)}`
  assert.deepEqual(await businessIdentity(business), {
    name: 'Detected Product',
    nameSource: 'auto',
    logo: expectedLogo
  })
  assert.deepEqual(
    await businessIdentity({ ...business, name: 'Owner Choice', nameSource: 'user' }),
    {
      name: 'Owner Choice',
      nameSource: 'user',
      logo: expectedLogo
    }
  )
  await rm(icon)
  const withoutLogo = await businessIdentity(business)
  assert.equal(withoutLogo.name, 'Detected Product')
  assert.equal(withoutLogo.nameSource, 'auto')
  assert.equal(Object.hasOwn(withoutLogo, 'logo'), false)
})
