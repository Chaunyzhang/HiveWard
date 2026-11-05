import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'

export const PROFILE_STATE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['profile', 'state', 'exports'],
    summary: 'List retained SQLite backups and JSON exports for profile-state recovery',
    usage: 'hiveward profile state exports [--profile-id <id>] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'profile-id']
  },
  {
    path: ['profile', 'state', 'rollback'],
    destructive: true,
    summary:
      'Repair damaged sections, restore a SQLite backup or retained JSON export, or keep the current JSON or SQLite profile',
    usage:
      'hiveward profile state rollback (--repair | --backup <id> | --revision <revision> | --current-json | --current-sqlite | --latest-json) [--profile-id <id>] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'repair',
      'revision',
      'backup',
      'current-json',
      'current-sqlite',
      'latest-json',
      'profile-id'
    ],
    notes: [
      '--profile-id selects another profile without changing the active profile. Prepare each profile before installing a JSON-only build.',
      'HiveWard must be stopped. Recovery validates the selected artifact and archives the current database family, JSON, and retained recovery artifacts before replacing state.',
      '--repair replaces only the damaged sections of the SQLite profile, each from the newest backup with a readable copy, and keeps everything else. A copy of the damaged database is archived first.',
      '--backup restores SQLite authority; --revision restores a JSON export for an older compatible runtime.',
      '--latest-json exports the latest SQLite state and restores it as JSON before launching an older JSON-only build. The current database and recovery artifacts are archived.',
      '--current-json keeps the current hiveward-data.json, including edits from an older build. It replaces SQLite state without merging; both copies are archived. The next SQLite-capable start imports the selected JSON.',
      '--current-sqlite keeps the current SQLite state and discards JSON edits from an older build. The JSON is archived, then rewritten from SQLite.'
    ],
    examples: [
      'hiveward profile state exports',
      'hiveward profile state rollback --repair',
      'hiveward profile state rollback --backup <id>',
      'hiveward profile state rollback --revision 1',
      'hiveward profile state rollback --latest-json',
      'hiveward profile state rollback --current-json',
      'hiveward profile state rollback --current-sqlite'
    ]
  }
]
