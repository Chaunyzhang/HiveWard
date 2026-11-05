#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  HIVEWARDD_NODE_PTY_DIR,
  HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME,
  HIVEWARDD_SERVER_TARGET_FILENAME,
  HIVEWARDD_TEMPLATE_MANIFEST_FILENAME,
  HIVEWARDD_TEMPLATE_TARGETS_DIR,
  hivewarddNodePtySlotFiles,
  hivewarddTemplateCommonFilenames,
  hivewarddTemplateTargetFilenames
} from '../../src/shared/hivewardd-artifacts.ts'
import { hivewarddAgentBrowserNativeName } from '../../src/shared/hivewardd-agent-browser-name.ts'
import {
  COMPAT_SERVER_TARGET_BASES,
  COMPAT_SERVER_TARGETS,
  HIVEWARDD_TEMPLATE_TARGETS,
  pinnedNodeRuntimeAsset
} from '../../src/shared/node-runtime-pin.ts'
import { HIVEWARDD_PREBUILDS_DIR } from './build-hivewardd-prebuilds.mjs'
import {
  COMPAT_SLOT_ADDONS,
  findCompatAddonGaps,
  findSlotProblems,
  readManifest
} from './hivewardd-prebuild-slot-contents.mjs'
import { runProcessSync } from '@hiveward/process-host'
import { verifyPackagedHivewarddTemplate } from './verify-packaged-hivewardd-template.cjs'
import { readHivewarddMobileWebAssetFilenames } from './hivewardd-mobile-web-bundle.mjs'
import { assertNotDarkBuild, darkBuildMarkers } from '../dark-build-switches.cjs'

const root = resolve(import.meta.dirname, '../..')
const outputDir = join(root, 'out', 'hivewardd-template')
const buildDir = join(root, 'out', '.hivewardd-template-build')

function isExecutable(filename) {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function copy(source, destination, executable = false) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  if (executable && process.platform !== 'win32') {
    chmodSync(destination, 0o755)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** One full package per target; each needs that target's node-pty slot in out/hivewardd-prebuilds. */
function buildTargetPackage(target) {
  const packageDir = join(buildDir, target, 'hivewardd')
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-hivewardd-node.mjs'),
      '--target',
      target,
      '--out-dir',
      packageDir
    ],
    cwd: root,
    // Desktop template omits optional ~10MB browsers per target; packaging references the app's own copy instead.
    // A checkout has no app copy, so HIVEWARDD_OMIT_AGENT_BROWSER=0 keeps drivers for local Chromium serve.
    env: { ...process.env, HIVEWARDD_OMIT_AGENT_BROWSER: process.env.HIVEWARDD_OMIT_AGENT_BROWSER ?? '1' },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`hivewardd ${target} package build failed with exit ${result.code ?? 'unknown'}`)
  }
  return packageDir
}

function stageTarget(target, packageDir) {
  const destination = join(outputDir, HIVEWARDD_TEMPLATE_TARGETS_DIR, target)
  const files = {}
  for (const filename of hivewarddTemplateTargetFilenames(target)) {
    const staged = join(destination, ...filename.split('/'))
    copy(join(packageDir, ...filename.split('/')), staged, isExecutable(filename))
    files[filename] = sha256(staged)
  }
  const browserName = hivewarddAgentBrowserNativeName(
    target.split('-')[0],
    target.split('-')[1],
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const browserSource = join(packageDir, browserName)
  if (!existsSync(browserSource)) {
    return { files }
  }
  const browserDestination = join(destination, browserName)
  copy(browserSource, browserDestination, true)
  return { files, browserName, browserSha256: sha256(browserDestination) }
}

// Allow partial CI --targets only; shipped templates require every target.
export function requestedTemplateTargets(argv = process.argv) {
  const index = argv.indexOf('--targets')
  if (index === -1) {
    return HIVEWARDD_TEMPLATE_TARGETS
  }
  const targets = (argv[index + 1] ?? '').split(',').filter(Boolean)
  const unknown = targets.filter((target) => !HIVEWARDD_TEMPLATE_TARGETS.includes(target))
  if (targets.length === 0 || unknown.length > 0) {
    throw new Error(
      `--targets needs a comma-separated subset of ${HIVEWARDD_TEMPLATE_TARGETS.join(',')}; got ${argv[index + 1] ?? 'nothing'}`
    )
  }
  return [...new Set(targets)]
}

// Compat target reuses base package with slot addons/runtime marker swapped; omit missing slots so rung B reports unavailable.
function stageCompatTarget(compat, basePackageDir) {
  const problems = findSlotProblems(readManifest(HIVEWARDD_PREBUILDS_DIR), HIVEWARDD_PREBUILDS_DIR, [
    compat
  ])
  if (problems.length > 0) {
    process.stdout.write(
      `[build-hivewardd-template] skipping compat target ${compat}: ${problems.join('; ')}\n`
    )
    return null
  }
  const destination = join(outputDir, HIVEWARDD_TEMPLATE_TARGETS_DIR, compat)
  const slotFiles = new Map([
    ...hivewarddNodePtySlotFiles(compat).map((file) => [
      `${HIVEWARDD_NODE_PTY_DIR}/build/Release/${file}`,
      join(HIVEWARDD_PREBUILDS_DIR, compat, ...file.split('/'))
    ]),
    ...Object.entries(COMPAT_SLOT_ADDONS).map(([file, shipped]) => [
      shipped,
      join(HIVEWARDD_PREBUILDS_DIR, compat, ...file.split('/'))
    ])
  ])
  // Why fatal: the base binary would pass every check here and fail only on a compat host.
  const gaps = findCompatAddonGaps(hivewarddTemplateTargetFilenames(compat), slotFiles)
  if (gaps.length > 0) {
    throw new Error(`compat target ${compat} would ship base-target addons: ${gaps.join(', ')}`)
  }
  const files = {}
  for (const filename of hivewarddTemplateTargetFilenames(compat)) {
    const staged = join(destination, ...filename.split('/'))
    if (filename === HIVEWARDD_SERVER_TARGET_FILENAME) {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, `${compat}\n`)
    } else if (filename === HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME) {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, `${pinnedNodeRuntimeAsset(compat).executableSha256}\n`)
    } else {
      const source = slotFiles.get(filename) ?? join(basePackageDir, ...filename.split('/'))
      copy(source, staged, isExecutable(filename))
    }
    files[filename] = sha256(staged)
  }
  return { files }
}

/**
 * `--dark-test-template` lets a dark switch through for test servers only; the template then
 * carries the switch's marker, which packaging refuses.
 */
export function assertTemplateBuildAllowed(argv = process.argv, env = process.env) {
  if (!argv.includes('--dark-test-template')) {
    // The template is what releases ship as the server; a dark build must never become one.
    assertNotDarkBuild([], env)
  }
}

function sameBytes(left, right) {
  return sha256(left) === sha256(right)
}

async function main() {
  assertTemplateBuildAllowed()
  const templateTargets = requestedTemplateTargets()
  rmSync(buildDir, { recursive: true, force: true })
  const packages = Object.fromEntries(
    templateTargets.map((target) => [target, buildTargetPackage(target)])
  )
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  const [firstTarget] = templateTargets
  // Every package carries the same page: its manifest is a common file, checked byte for byte below.
  const commonArtifacts = hivewarddTemplateCommonFilenames(
    readHivewarddMobileWebAssetFilenames(packages[firstTarget])
  )
  for (const filename of commonArtifacts) {
    const source = join(packages[firstTarget], ...filename.split('/'))
    // Why check every target: the template keeps one copy, so a per-target difference would ship wrong bytes.
    for (const target of templateTargets) {
      if (!sameBytes(source, join(packages[target], ...filename.split('/')))) {
        throw new Error(`${filename} differs between ${firstTarget} and ${target} packages`)
      }
    }
    copy(source, join(outputDir, ...filename.split('/')), isExecutable(filename))
  }
  const targets = Object.fromEntries(
    templateTargets.map((target) => [target, stageTarget(target, packages[target])])
  )
  // A partial CI template stages a compat target only beside its base target.
  for (const compat of COMPAT_SERVER_TARGETS.filter((candidate) =>
    templateTargets.includes(COMPAT_SERVER_TARGET_BASES[candidate])
  )) {
    const staged = stageCompatTarget(compat, packages[COMPAT_SERVER_TARGET_BASES[compat]])
    if (staged) {
      targets[compat] = staged
    }
  }
  const commonSha256 = Object.fromEntries(
    commonArtifacts.map((filename) => [filename, sha256(join(outputDir, filename))])
  )
  writeFileSync(
    join(outputDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME),
    `${JSON.stringify({ schemaVersion: 3, commonSha256, targets }, null, 2)}\n`
  )
  verifyPackagedHivewarddTemplate(join(root, 'out'), templateTargets)
  // Outside the manifest, so deploys never copy it; it marks the whole template as test-only.
  for (const marker of darkBuildMarkers()) {
    writeFileSync(join(outputDir, marker.fileName), marker.text)
  }
  rmSync(buildDir, { recursive: true, force: true })
  process.stdout.write(`[build-hivewardd-template] ok — ${Object.keys(targets).length} targets\n`)
}

if (process.argv[1]?.endsWith('build-hivewardd-template.mjs')) {
  await main()
}
