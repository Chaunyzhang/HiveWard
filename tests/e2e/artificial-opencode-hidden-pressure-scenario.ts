import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import {
  type HiddenPressureOutputMode,
  writePressureOutputScript
} from './artificial-opencode-hidden-pressure-script'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  resolveActiveTabId,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { readActiveScreen } from './helpers/alt-screen-frame'

type HiddenPressurePane = {
  ptyId: string
}

type HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate> = {
  annotateTypingMeasurement: (
    testInfo: TestInfo,
    type: string,
    paneCount: number,
    measurement: TMeasurement,
    debug: TDebug | null,
    scheduler: TScheduler | null,
    mainPressure: TMainPressure | null,
    ackGate: TAckGate | null
  ) => void
  ensureActiveWorktreePaneLoad: (page: Page, paneCount: number) => Promise<HiddenPressurePane[]>
  holdTerminalAckGate: (page: Page, ptyIds: string[]) => Promise<void>
  measureTypingDuringLoad: (
    page: Page,
    scriptPath: string,
    ptyId: string,
    runId: string
  ) => Promise<TMeasurement>
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
  readTerminalAckGateDebug: (page: Page) => Promise<TAckGate | null>
  readTerminalOutputSchedulerDebug: (page: Page) => Promise<TScheduler | null>
  readTerminalPtyOutputDebug: (page: Page) => Promise<TDebug | null>
  releaseTerminalAckGate: (page: Page) => Promise<void>
  resetTerminalPtyOutputDebug: (page: Page) => Promise<void>
  writeInteractivePromptScript: (scriptPath: string, runId: string) => void
}

type HiddenPressureDebug = {
  hiddenRendererSkipCount: number
}

type HiddenPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

type HiddenPressureMainSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryGatedPtyCount: number
}

type HiddenPressureSchedulerSnapshot = {
  peakQueuedChars: number
  droppedBacklogCount: number
}

type HiddenPressureAckGate = {
  heldAckChars: number
}

// Allow loaded-CI restore overhead within 4s; poll at fixed intervals to avoid serializing whole buffers on backoff.
const MAX_HIDDEN_RESTORE_LATENCY_MS = 4_000
// Hidden bytes drop in main after ingestion, so delivery pressure must stay below the former ACK-backpressure target.
const MAIN_RENDERER_PRESSURE_TARGET_CHARS = 2 * 1024 * 1024
// Worst-key latency and timer drift share CI starvation spikes; keep the median strict.
const MAX_HIDDEN_PRESSURE_TIMER_DRIFT_MS = 3_000

export async function runHiddenRealPtyPressureScenario<
  TMeasurement extends HiddenPressureMeasurement,
  TDebug extends HiddenPressureDebug,
  TMainPressure extends HiddenPressureMainSnapshot,
  TAckGate extends HiddenPressureAckGate,
  TScheduler extends HiddenPressureSchedulerSnapshot
>({
  deps,
  annotationSuffix,
  hiddenPaneCount,
  pressureOutputChars,
  pressureOutputMode = 'tui',
  pressureStartDelayMs,
  testInfo,
  testRepoPath,
  hivewardPage
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  annotationSuffix?: string
  hiddenPaneCount: number
  pressureOutputChars: number
  pressureOutputMode?: HiddenPressureOutputMode
  pressureStartDelayMs: number
  testInfo: TestInfo
  testRepoPath: string
  hivewardPage: Page
}): Promise<void> {
  await waitForSessionReady(hivewardPage)
  const firstWorktreeId = await waitForActiveWorktree(hivewardPage)
  const allWorktreeIds = await getAllWorktreeIds(hivewardPage)
  const secondWorktreeId = allWorktreeIds.find((id) => id !== firstWorktreeId)
  expect(Boolean(secondWorktreeId), 'OpenCode hidden PTY pressure needs a second worktree').toBe(
    true
  )
  if (!secondWorktreeId) {
    return
  }

  await switchToWorktree(hivewardPage, secondWorktreeId)
  const hiddenPanes = await deps.ensureActiveWorktreePaneLoad(hivewardPage, hiddenPaneCount)

  const runId = randomUUID()
  const typingScriptPath = path.join(
    testRepoPath,
    `.hiveward-opencode-hidden-pressure-typing-${runId}.mjs`
  )
  const pressureScriptPath = path.join(
    testRepoPath,
    `.hiveward-opencode-hidden-pressure-load-${runId}.mjs`
  )
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId, pressureOutputMode)

  await deps.resetTerminalPtyOutputDebug(hivewardPage)
  await deps.holdTerminalAckGate(
    hivewardPage,
    hiddenPanes.map((pane) => pane.ptyId)
  )
  try {
    await startHiddenPressureCommands({
      hiddenPanes,
      hivewardPage,
      pressureOutputChars,
      pressureScriptPath,
      pressureStartDelayMs
    })
    await switchToTypingWorkspace(hivewardPage, firstWorktreeId)
    const typingPtyId = await waitForActivePanePtyId(hivewardPage)

    // Wait for main to drop a pane’s output; hidden delivery no longer builds the old ACK-pressure backlog.
    await waitForMainHiddenDeliveryDrops(hivewardPage, deps, pressureOutputChars)
    const measurement = await deps.measureTypingDuringLoad(
      hivewardPage,
      typingScriptPath,
      typingPtyId,
      runId
    )
    const debug = await deps.readTerminalPtyOutputDebug(hivewardPage)
    const scheduler = await deps.readTerminalOutputSchedulerDebug(hivewardPage)
    const mainPressure = await deps.readMainPtyPressureDebug(hivewardPage)
    const ackGate = await deps.readTerminalAckGateDebug(hivewardPage)
    deps.annotateTypingMeasurement(
      testInfo,
      `opencode-hidden-real-pty-pressure-typing${annotationSuffix ?? ''}`,
      hiddenPanes.length + 1,
      measurement,
      debug,
      scheduler,
      mainPressure,
      ackGate
    )

    // Assert main’s drop counter: hidden bytes never reach renderer delivery or its former skip counters.
    expect(mainPressure?.hiddenDeliveryDroppedChars ?? 0).toBeGreaterThanOrEqual(
      pressureOutputChars
    )
    expect(mainPressure?.peakRendererInFlightChars ?? 0).toBeLessThan(
      MAIN_RENDERER_PRESSURE_TARGET_CHARS
    )
    // Hidden delivery must leave the renderer queue nearly empty without backlog drops.
    expect(scheduler?.peakQueuedChars ?? 0).toBeLessThan(pressureOutputChars)
    expect(scheduler?.droppedBacklogCount ?? Number.POSITIVE_INFINITY).toBe(0)
    expect(measurement.medianLatencyMs).toBeLessThan(75)
    // A single echo can collide with a loaded flush; use worst latency only for hangs while median detects sluggish typing.
    expect(measurement.worstLatencyMs).toBeLessThan(3_000)
    expect(measurement.maxTimerDriftMs).toBeLessThan(MAX_HIDDEN_PRESSURE_TIMER_DRIFT_MS)

    await deps.releaseTerminalAckGate(hivewardPage)
    const restoreLatencyMs = await measureHiddenOutputRestoreLatency(
      hivewardPage,
      secondWorktreeId,
      runId
    )
    testInfo.annotations.push({
      type: `opencode-hidden-real-pty-restore${annotationSuffix ?? ''}`,
      description: `panes=${hiddenPanes.length + 1} restore=${restoreLatencyMs.toFixed(
        1
      )}ms hiddenDeliveryDroppedChars=${
        mainPressure?.hiddenDeliveryDroppedChars ?? 0
      } mainPeakInFlightChars=${mainPressure?.peakRendererInFlightChars ?? 0} heldAckChars=${
        ackGate?.heldAckChars ?? 0
      }`
    })
    expect(restoreLatencyMs).toBeLessThan(MAX_HIDDEN_RESTORE_LATENCY_MS)
  } finally {
    await cleanupHiddenPressureScenario({
      deps,
      firstWorktreeId,
      hiddenPanes,
      hivewardPage,
      pressureScriptPath,
      secondWorktreeId,
      typingScriptPath
    })
  }
}

// Readiness is a pane’s worth of hidden output dropped in main, not the former delivery backlog.
async function waitForMainHiddenDeliveryDrops<TMainPressure extends HiddenPressureMainSnapshot>(
  hivewardPage: Page,
  deps: { readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null> },
  pressureOutputChars: number
): Promise<void> {
  await expect
    .poll(
      async () => (await deps.readMainPtyPressureDebug(hivewardPage))?.hiddenDeliveryDroppedChars ?? 0,
      { timeout: 30_000, message: 'Main hidden-delivery gate did not drop hidden PTY output' }
    )
    .toBeGreaterThanOrEqual(pressureOutputChars)
}

async function measureHiddenOutputRestoreLatency(
  hivewardPage: Page,
  worktreeId: string,
  runId: string
): Promise<number> {
  const restoreStart = performance.now()
  await switchToWorktree(hivewardPage, worktreeId)
  // Resolve this worktree’s terminal; activeTabId may still name the previous worktree or another tab kind.
  const tabId = (await resolveActiveTabId(hivewardPage)) ?? ''
  await expect
    .poll(async () => (await readActiveScreen(hivewardPage, tabId))?.rows.join('\n') ?? '', {
      timeout: 20_000,
      // One-second backoff can dominate the measured restore latency.
      intervals: [50],
      message: 'No restored output from main buffer on return (or no active terminal pane)'
    })
    .toContain(`OPENCODE_PRESSURE_DONE_${runId}_`)
  return performance.now() - restoreStart
}

async function startHiddenPressureCommands({
  hiddenPanes,
  hivewardPage,
  pressureOutputChars,
  pressureScriptPath,
  pressureStartDelayMs
}: {
  hiddenPanes: HiddenPressurePane[]
  hivewardPage: Page
  pressureOutputChars: number
  pressureScriptPath: string
  pressureStartDelayMs: number
}): Promise<void> {
  await Promise.all(
    hiddenPanes.map((pane, paneIndex) =>
      sendToTerminal(
        hivewardPage,
        pane.ptyId,
        `node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${pressureOutputChars} ${pressureStartDelayMs}\r`
      )
    )
  )
}

async function switchToTypingWorkspace(hivewardPage: Page, worktreeId: string): Promise<void> {
  await switchToWorktree(hivewardPage, worktreeId)
  await expect.poll(() => getActiveWorktreeId(hivewardPage), { timeout: 10_000 }).toBe(worktreeId)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage, 30_000)
}

async function cleanupHiddenPressureScenario<
  TMeasurement,
  TDebug,
  TScheduler,
  TMainPressure,
  TAckGate
>({
  deps,
  firstWorktreeId,
  hiddenPanes,
  hivewardPage,
  pressureScriptPath,
  secondWorktreeId,
  typingScriptPath
}: {
  deps: HiddenPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  firstWorktreeId: string
  hiddenPanes: HiddenPressurePane[]
  hivewardPage: Page
  pressureScriptPath: string
  secondWorktreeId: string
  typingScriptPath: string
}): Promise<void> {
  await deps.releaseTerminalAckGate(hivewardPage)
  await switchToWorktree(hivewardPage, firstWorktreeId).catch(() => undefined)
  await waitForActivePanePtyId(hivewardPage)
    .then((ptyId) => sendToTerminal(hivewardPage, ptyId, '\x03'))
    .catch(() => undefined)
  await switchToWorktree(hivewardPage, secondWorktreeId).catch(() => undefined)
  await Promise.all(
    hiddenPanes.map((pane) => sendToTerminal(hivewardPage, pane.ptyId, '\x03').catch(() => undefined))
  )
  rmSync(typingScriptPath, { force: true })
  rmSync(pressureScriptPath, { force: true })
}
