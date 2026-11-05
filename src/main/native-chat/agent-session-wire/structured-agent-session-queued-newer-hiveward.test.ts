import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  SAVED_BY_NEWER_HIVEWARD
} from '../agent-session-journal/journal-host-database-test-support'
import { JOURNAL_NEWER_SCHEMA_MESSAGE } from '../agent-session-journal/journal-open-failure'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const REFUSED_BY_NEWER_HIVEWARD = {
  ok: false,
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerHiveWard' },
    message: JOURNAL_NEWER_SCHEMA_MESSAGE
  }
}

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** Stamp the existing rig database with a newer open verdict; writes must honor it too. */
async function reopenOnNewerHivewarddatabase(close: () => Promise<unknown>): Promise<void> {
  await close()
  Object.defineProperty(openTestJournalHostDatabase(rig.root), 'readOnly', { value: true })
}

async function expectHistoryRefused(): Promise<void> {
  await expect(
    rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  ).rejects.toMatchObject(SAVED_BY_NEWER_HIVEWARD)
}

async function twoCardsBehindWork() {
  await rig.workingSend()
  const first = await queuedDraft('first')
  const second = await queuedDraft('second')
  return {
    first,
    second,
    cards: [
      { messageId: first, state: 'waiting' },
      { messageId: second, state: 'waiting' }
    ]
  }
}

describe("a newer HiveWard's journal", () => {
  it('refuses the history read, a queued send, Send-now and Delete with the update words', async () => {
    const { first, second } = await twoCardsBehindWork()
    await reopenOnNewerHivewarddatabase(() => rig.host.close(HOST_TEST_SESSION, 'evict'))
    await expectHistoryRefused()

    expect(await rig.send('third', 'queue-if-active').result).toMatchObject(REFUSED_BY_NEWER_HIVEWARD)
    expect(await rig.sendNow(first)).toMatchObject(REFUSED_BY_NEWER_HIVEWARD)
    expect(await rig.deleteQueued(second)).toMatchObject(REFUSED_BY_NEWER_HIVEWARD)
    await expectHistoryRefused()
  })

  it('refuses Resume of the queue a restart paused with the update words', async () => {
    await twoCardsBehindWork()
    await reopenOnNewerHivewarddatabase(() => rig.restartHostProcess())
    await expectHistoryRefused()

    expect(await rig.resume()).toMatchObject(REFUSED_BY_NEWER_HIVEWARD)
  })
})
