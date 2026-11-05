import { describe, expect, it } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import {
  orchestrationMutationRecoveryError,
  renderCommand,
  renderResolvedOrchestrationCommand
} from './orchestration-mutation-recovery'
import { RuntimeClientError } from './runtime-client'

describe('orchestration mutation recovery', () => {
  it('queries a known dispatch before issuing the keyed retry', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_1',
        dispatchId: 'dispatch_1',
        originalCommand: ['hiveward', 'orchestration', 'worker-start', '--task', 'task_1']
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect(result.data).toMatchObject({
      recovery: {
        orchestrationRequestId: 'request_1',
        dispatchId: 'dispatch_1',
        queryCommand: [
          'hiveward',
          'orchestration',
          'worker-show',
          '--dispatch',
          'dispatch_1',
          '--json'
        ],
        retryCommand: [
          'hiveward',
          'orchestration',
          'worker-start',
          '--task',
          'task_1',
          '--retry-request',
          'request_1'
        ],
        workerDeathInferred: false
      }
    })
    expect(result.message.indexOf('hiveward orchestration worker-show')).toBeLessThan(
      result.message.indexOf('hiveward orchestration worker-start')
    )
    expect((result.data as { nextSteps?: string[] }).nextSteps).toEqual([
      'Run hiveward orchestration worker-show --dispatch dispatch_1 --json before retrying.',
      'After inspecting the Dispatch, if keyed recovery is still needed, run hiveward orchestration worker-start --task task_1 --retry-request request_1 from this same terminal. --retry-request reuses the same operation identity so HiveWard can replay, join, or safely recover it without starting a separate duplicate.'
    ])
  })

  it('does not invent a dispatch for an old-client-shaped error', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_2',
        originalCommand: ['hiveward', 'orchestration', 'worker-start', '--task', 'task_2']
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect(result.data).toMatchObject({
      recovery: {
        orchestrationRequestId: 'request_2',
        retryCommand: expect.arrayContaining(['--retry-request', 'request_2']),
        workerDeathInferred: false
      }
    })
    expect((result.data as Record<string, unknown>).recovery).not.toHaveProperty('dispatchId')
    expect(result.message).not.toContain('worker death')
  })

  it('offers a read-only request lookup when the response carried no dispatch', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_unavailable', 'runtime unavailable', {
        orchestrationRequestId: 'request_4',
        originalCommand: ['hiveward', 'orchestration', 'worker-start', '--task', 'task_4']
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect(result.data).toMatchObject({
      recovery: {
        queryCommand: [
          'hiveward',
          'orchestration',
          'request-show',
          '--request',
          'request_4',
          '--json'
        ]
      }
    })
    expect((result.data as { nextSteps?: string[] }).nextSteps?.[0]).toBe(
      'Run hiveward orchestration request-show --request request_4 --json before retrying.'
    )
  })

  it('describes keyed retry without overclaiming one replay outcome', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_5',
        originalCommand: ['hiveward', 'orchestration', 'worker-start', '--task', 'task_5']
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect((result.data as { nextSteps?: string[] }).nextSteps?.[1]).toContain(
      'replay, join, or safely recover it without starting a separate duplicate'
    )
    expect((result.data as { nextSteps?: string[] }).nextSteps?.[1]).toContain(
      'absence does not prove a retry is safe'
    )
  })

  it('renders the exact executable and safely quotes original arguments', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_3',
        dispatchId: 'dispatch_3',
        originalCommand: [
          'hiveward-dev',
          'orchestration',
          'worker-start',
          '--task',
          'task 3',
          '--comment',
          'literal $(do-not-run)'
        ]
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect((result.data as { nextSteps?: string[] }).nextSteps).toEqual([
      'Run hiveward-dev orchestration worker-show --dispatch dispatch_3 --json before retrying.',
      "After inspecting the Dispatch, if keyed recovery is still needed, run hiveward-dev orchestration worker-start --task 'task 3' --comment 'literal $(do-not-run)' --retry-request request_3 from this same terminal. --retry-request reuses the same operation identity so HiveWard can replay, join, or safely recover it without starting a separate duplicate."
    ])
    expect(result.message).toContain("'literal $(do-not-run)'")
  })

  it('parses legacy command text without losing quoted arguments', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_4',
        originalCommand:
          'hiveward orchestration worker-stop --dispatch dispatch_4 --comment "quoted value"'
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect(
      (result.data as { recovery?: { retryCommand?: string[] } }).recovery?.retryCommand
    ).toEqual([
      'hiveward',
      'orchestration',
      'worker-stop',
      '--dispatch',
      'dispatch_4',
      '--comment',
      'quoted value',
      '--retry-request',
      'request_4'
    ])
  })

  it.each([
    [
      'gate-create',
      ['hiveward', 'orchestration', 'gate-create', '--task', 'task_1', '--question', 'ship?']
    ],
    [
      'worker-retain',
      ['hiveward', 'orchestration', 'worker-retain', '--dispatch', 'dispatch_1', '--json']
    ]
  ])('replays exact %s argv with the keyed retry', (_name, originalCommand) => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_exact',
        originalCommand
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect(
      (result.data as { recovery?: { retryCommand?: string[] } }).recovery?.retryCommand
    ).toEqual([...originalCommand, '--retry-request', 'request_exact'])
  })

  it('reuses the request identity without duplicating an existing retry flag', () => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_reused',
        originalCommand: [
          'hiveward',
          'orchestration',
          'worker-retain',
          '--dispatch',
          'dispatch_1',
          '--retry-request=request_reused'
        ]
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }

    expect(
      (result.data as { recovery?: { retryCommand?: string[] } }).recovery?.retryCommand
    ).toEqual([
      'hiveward',
      'orchestration',
      'worker-retain',
      '--dispatch',
      'dispatch_1',
      '--retry-request',
      'request_reused'
    ])
  })

  it('renders Windows cmd recovery guidance without quote drift or percent expansion', () => {
    expect(
      renderCommand(
        [
          'hiveward',
          'orchestration',
          'worker-start',
          '--comment',
          'literal "quoted" %PATH% & safe'
        ],
        'win32',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      )
    ).toBe(
      '"hiveward" "orchestration" "worker-start" "--comment" "literal ""quoted"" "^%"PATH"^%" & safe"'
    )
  })

  it('shell-quotes a configured Windows executable when resolving portable recovery commands', () => {
    expect(
      renderResolvedOrchestrationCommand(
        'hiveward orchestration worker-show --dispatch ctx_1 --json',
        'C:\\Program Files\\HiveWard\\hiveward.cmd',
        'win32',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      )
    ).toBe(
      '"C:\\Program Files\\HiveWard\\hiveward.cmd" "orchestration" "worker-show" "--dispatch" "ctx_1" "--json"'
    )
  })

  it('keeps PowerShell and POSIX recovery guidance literal', () => {
    expect(
      renderCommand(['hiveward', 'literal "quoted" $HOME'], 'win32', {
        ComSpec: 'powershell.exe'
      })
    ).toBe("& 'hiveward' 'literal \\\"quoted\\\" $HOME'")
    expect(renderCommand(['hiveward', 'literal $(do-not-run)'], 'darwin')).toBe(
      "hiveward 'literal $(do-not-run)'"
    )
  })

  it.runIf(process.platform !== 'win32')(
    'round trips POSIX recovery argv through /bin/sh',
    async () => {
      const values = ['with spaces', "apostrophe's", 'literal $(do-not-run)', 'line one\nline two']
      const command = renderCommand(
        [
          process.execPath,
          '-e',
          'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
          ...values
        ],
        'darwin'
      )

      const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })

      expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
      expect(JSON.parse(result.stdout)).toEqual(values)
    }
  )

  it.each([
    [
      'split',
      [
        'hiveward',
        'orchestration',
        'send',
        '--pairing-code',
        'split-secret',
        '--subject',
        'status'
      ],
      'split-secret'
    ],
    [
      'equals',
      ['hiveward', 'orchestration', 'send', '--pairing-code=equals-secret', '--subject', 'status'],
      'equals-secret'
    ],
    [
      'dispatch split',
      [
        'hiveward',
        'orchestration',
        'send',
        '--dispatch-capability',
        'split-dispatch-secret',
        '--subject',
        'status'
      ],
      'split-dispatch-secret'
    ],
    [
      'dispatch equals',
      [
        'hiveward',
        'orchestration',
        'send',
        '--dispatch-capability=equals-dispatch-secret',
        '--subject',
        'status'
      ],
      'equals-dispatch-secret'
    ]
  ])('blocks recovery and removes %s credentials', (_name, originalCommand, secret) => {
    const result = orchestrationMutationRecoveryError(
      new RuntimeClientError('runtime_timeout', 'request timed out', {
        orchestrationRequestId: 'request_secret',
        originalCommand
      })
    )
    if (!(result instanceof RuntimeClientError)) {
      throw new Error('Expected recovery error')
    }
    const output = JSON.stringify({ message: result.message, data: result.data })

    expect(output).not.toContain(secret)
    expect(result.message).toContain('Recovery is blocked')
    expect(result.data).toMatchObject({
      recovery: {
        orchestrationRequestId: 'request_secret',
        recoveryBlocked: true
      }
    })
    expect(result.data).not.toHaveProperty('originalCommand')
    expect((result.data as { recovery: object }).recovery).not.toHaveProperty('retryCommand')
  })

  it.each([
    ['runtime_unavailable', true],
    ['remote_runtime_unavailable', true],
    ['runtime_timeout', true],
    ['invalid_runtime_response', true],
    ['runtime_manually_disconnected', false],
    ['remote_runtime_timeout', false],
    ['runtime_rpc_queue_overloaded', false],
    ['invalid_argument', false]
  ])('treats %s as an unknown mutation outcome: %s', (code, unknown) => {
    const error = new RuntimeClientError(code, 'failed', { orchestrationRequestId: 'request-1' })
    expect(orchestrationMutationRecoveryError(error) !== error).toBe(unknown)
  })
})
