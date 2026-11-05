import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyHivewarddTerminalSmokeChanges,
  collectHivewarddTerminalSmokeInputs
} from './hivewardd-terminal-smoke-change-scope.mjs'
import { HIVEWARDD_CHILD_ENTRY_POINTS } from './hivewardd-entry-build.mjs'

it.each([
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'config/tsconfig.cli.json',
  'config/patches/node-pty@1.1.0.patch',
  'native/windows-registry/src/addon.cc',
  'config/scripts/node-pty-job-ownership.cjs',
  '.github/actions/install-node-dependencies/action.yml',
  '.github/workflows/pr.yml',
  'src/cli/deleted-command.ts',
  'src/shared/deleted-contract.ts',
  'src/main/persistence/profile-state/new-worker.ts',
  'resources/licenses/ripgrep/COPYING',
  'config/scripts/runtime-serve-terminal-smoke.test.mjs',
  'config/scripts/hivewardd-terminal-smoke-change-scope.test.mjs'
])('retains the smoke for build and dynamically opened input changes: %s', async (file) => {
  expect((await classifyHivewarddTerminalSmokeChanges([file], async () => new Set())).shouldRun).toBe(
    true
  )
})

it('retains smoke when changed-file evidence or dependency analysis is unavailable', async () => {
  expect((await classifyHivewarddTerminalSmokeChanges([])).shouldRun).toBe(true)
  const result = await classifyHivewarddTerminalSmokeChanges(['src/main/deleted.ts'], async () => {
    throw new Error('Could not resolve deleted dependency')
  })
  expect(result.shouldRun).toBe(true)
  expect(result.reason).toContain('Dependency graph unavailable')
})

describe('the actual terminal smoke dependency graph', () => {
  let inputs
  beforeAll(async () => {
    inputs = await collectHivewarddTerminalSmokeInputs()
  }, 60_000)

  it.each([
    ...Object.values(HIVEWARDD_CHILD_ENTRY_POINTS),
    'src/main/runtime/hiveward-runtime.ts',
    'src/main/windows/windows-process-table.ts',
    'src/main/worker-thread-entry-path.ts',
    'src/cli/index.ts',
    'config/scripts/runtime-serve-terminal-smoke.mjs',
    'config/scripts/build-hivewardd-node.mjs',
    'config/scripts/build-hivewardd.mjs',
    'config/scripts/profile-state-worker-smoke.mjs',
    'config/scripts/install-dev-cli.mjs',
    'config/scripts/verify-cli-bin.mjs',
    'config/scripts/node-server-change-scope.mjs'
  ])('retains the runtime, CLI, build or smoke dependency: %s', async (file) => {
    expect(inputs.has(file)).toBe(true)
    expect((await classifyHivewarddTerminalSmokeChanges([file], async () => inputs)).shouldRun).toBe(
      true
    )
  })

  it.each([
    'src/renderer/src/components/Example.tsx',
    'src/main/menu/register-app-menu.ts',
    'config/scripts/ci-shard-timings.json',
    '.github/workflows/e2e.yml',
    'docs/reference/ci-runner-efficiency.md'
  ])('skips unrelated inputs: %s', async (file) => {
    expect((await classifyHivewarddTerminalSmokeChanges([file], async () => inputs)).shouldRun).toBe(
      false
    )
  })

  it('retains a removed source path when a file is renamed outside the CLI tree', async () => {
    expect(
      (
        await classifyHivewarddTerminalSmokeChanges(
          ['src/cli/deleted-command.ts', 'docs/moved-command.ts'],
          async () => inputs
        )
      ).shouldRun
    ).toBe(true)
  })
})

it('only skips the unchanged smoke after a successful diff and dependency analysis', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/pr.yml', import.meta.url), 'utf8')
  )
  const steps = workflow.jobs.preflight.steps
  const scope = steps.find((candidate) => candidate.id === 'hivewardd-smoke-scope')
  expect(scope.env).toEqual({ BASE_SHA: '${{ github.event.pull_request.base.sha }}' })
  // HEAD^1 bypasses merge-base lookup, permitting shallow checkout; payload head SHA is unused (see localization gate).
  expect(scope.run).toContain('node config/scripts/git-pull-request-diff-base.mjs "$BASE_SHA"')
  expect(scope.run).toContain('git diff --name-only --no-renames -z "$DIFF_BASE" HEAD')
  expect(scope.run).not.toContain('--diff-filter')
  expect(scope.run).toMatch(
    /&& \[ "\$scope" = false \]; then[\s\S]*run=false[\s\S]*else\s+echo 'run=true'/
  )
  // hivewardd refuses to build without the page, so the page builds exactly when the smoke runs.
  const gated = "steps.hivewardd-smoke-scope.outputs.run == 'true'"
  const page = steps.find(
    (candidate) => candidate.uses === './.github/actions/build-mobile-web-bundle'
  )
  const smoke = steps.find((candidate) => candidate.name === 'Boot hivewardd and round-trip a terminal')
  expect(page.if).toBe(gated)
  expect(smoke.if).toBe(gated)
  expect(smoke.run).toBe('pnpm run smoke:hivewardd-terminal')
  expect(steps.indexOf(page)).toBeLessThan(steps.indexOf(smoke))
})
