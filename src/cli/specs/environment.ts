import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS, LOCAL_COMMAND_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['host', 'name'],
    summary: 'Show or set the name this HiveWard runtime reports to connected clients',
    usage: 'hiveward host name [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    notes: [
      'With --name, updates the answering runtime over its authenticated connection. Use an empty value to return to the detected computer name.',
      'Without --name, prints the name and platform the answering runtime reports.'
    ],
    examples: ['hiveward host name', 'hiveward host name --name build-server']
  },
  {
    path: ['host', 'list'],
    summary: 'List every machine this HiveWard host can target, and how to name each one',
    usage: 'hiveward host list [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Answers "what can I target and what do I pass" in one place: this machine, the SSH targets registered on it, and the HiveWard servers paired with it.',
      'The three kinds are reached differently. A paired HiveWard server is a connection, selected with --environment <name>. An SSH target is a machine the connected HiveWard host reaches, selected with --host ssh:<id>. Passing one where the other belongs is the most common way to get an empty or missing-host answer.',
      'Commands that take --host also accept any name this list prints, such as --host "this machine" or --host <ssh-target-name>. A name two hosts share is refused with the exact flag for each.',
      'SSH rows include the detected remote platform after that target has connected (linux, darwin, or win32); disconnected or older targets report platform unknown.',
      'SSH rows also include whether the target is currently connected and its lifecycle status when known.',
      'Paired-server rows come from the pairing store and report platform unknown; ask one server directly with `hiveward host name --environment <name>`.',
      "SSH targets are read from this machine's own HiveWard runtime, so this lists that machine's targets and not another server's. Run `hiveward host list` on the other machine to see the targets registered there.",
      '--environment and --pairing-code are rejected rather than ignored: paired servers come from this machine\u2019s pairing store, so a routed answer would describe two machines at once.'
    ],
    examples: ['hiveward host list', 'hiveward host list --json']
  },
  {
    path: ['environment', 'add'],
    summary: 'Save a remote HiveWard runtime environment from a pairing code',
    usage: 'hiveward environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'pairing-code', 'name'],
    examples: ['hiveward environment add --name work-laptop --pairing-code hiveward://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved HiveWard runtime environments',
    usage: 'hiveward environment list [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS],
    notes: [
      'Answers from this machine\u2019s pairing store. --environment and --pairing-code are rejected rather than ignored, because there is no other host that could answer.'
    ]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved HiveWard runtime environment',
    usage: 'hiveward environment show --environment <selector> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment']
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved HiveWard runtime environment',
    usage: 'hiveward environment rm --environment <selector> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment']
  }
]
