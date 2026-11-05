import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

const SELECTOR_NOTE =
  '--environment names a managed HiveWard server this machine deployed over SSH (see `hiveward environment list`); it is a selector here, not a routing flag.'
const DESKTOP_NOTE =
  'Runs on this machine’s HiveWard desktop app, the same action as Settings > HiveWard on your SSH hosts. A runtime without the SSH registry (headless `hiveward serve`) refuses it.'

export const MANAGED_SERVER_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'status'],
    summary: 'Show a managed HiveWard server’s active version, terminals and pending work',
    usage: 'hiveward environment status --environment <selector> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment'],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE],
    examples: ['hiveward environment status --environment build-box']
  },
  {
    path: ['environment', 'update'],
    summary: 'Update a managed HiveWard server to this build’s version',
    usage: 'hiveward environment update --environment <selector> [--force] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment', 'force'],
    notes: [
      'Without --force, an update that would restart over running terminals is deferred and reported, not applied.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['hiveward environment update --environment build-box']
  },
  {
    path: ['environment', 'rollback'],
    destructive: true,
    summary: 'Roll a managed HiveWard server back to its previous version',
    usage: 'hiveward environment rollback --environment <selector> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment'],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE]
  },
  {
    path: ['environment', 'recover'],
    summary: 'Finish or undo a managed HiveWard server’s interrupted update, rollback or stop',
    usage:
      'hiveward environment recover --environment <selector> [--accept-changed-state --yes] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment', 'accept-changed-state', 'yes'],
    notes: [
      'When a rejected build changed profile state, recover refuses rather than restart the previous build over it. --accept-changed-state --yes restores the prelaunch snapshot instead, the same as Restore in Settings > HiveWard on your SSH hosts; what the rejected build changed is discarded.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: [
      'hiveward environment recover --environment build-box',
      'hiveward environment recover --environment build-box --accept-changed-state --yes'
    ]
  },
  {
    path: ['environment', 'stop'],
    destructive: true,
    summary: 'Stop a managed HiveWard server and unlink it from this machine (decommission)',
    usage: 'hiveward environment stop --environment <selector> --yes [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment', 'yes'],
    notes: [
      'Stops hivewardd on the SSH host and, once the host proves it exited, removes the server from this machine. Its terminals end. Requires --yes.',
      'If the host cannot prove hivewardd exited, the server stays linked and the refusal says why; nothing is removed on a guess. For a host that is gone for good, use `hiveward environment forget`.',
      'If this server is the default host for new projects, choose another one first. `hiveward environment cancel-stop` withdraws a stop hivewardd has not acted on yet.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['hiveward environment stop --environment build-box --yes']
  },
  {
    path: ['environment', 'forget'],
    destructive: true,
    summary: 'Unlink a managed HiveWard server whose SSH host is gone, without stopping it',
    usage: 'hiveward environment forget --environment <selector> --yes [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment', 'yes'],
    notes: [
      'Removes the server from this machine without contacting its host, so the SSH host can then be removed. Use it when the host was deleted or can never be reached again. Requires --yes.',
      'Nothing on the host is stopped: if it comes back, hivewardd may still be running there, and connecting to it again relinks it.',
      SELECTOR_NOTE,
      DESKTOP_NOTE
    ],
    examples: ['hiveward environment forget --environment build-box --yes']
  },
  {
    path: ['environment', 'cancel-stop'],
    summary: 'Withdraw a managed HiveWard server stop that hivewardd has not acted on yet',
    usage: 'hiveward environment cancel-stop --environment <selector> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'environment'],
    notes: [SELECTOR_NOTE, DESKTOP_NOTE]
  }
]
