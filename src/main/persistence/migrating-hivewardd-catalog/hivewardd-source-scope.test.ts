import { describe, expect, it } from 'vitest'
import {
  createHivewarddMigrationSourceScope,
  hivewarddMigrationOwnerMatchesScope
} from './hivewardd-source-scope'

const scope = createHivewarddMigrationSourceScope({
  source: { sshTargetId: 'ssh-prod', sshTargetGeneration: 1, targetLabel: 'Production' },
  catalog: {
    repositories: [
      {
        id: 'repo-1',
        path: '/srv/app',
        displayName: 'App',
        badgeColor: '#737373',
        addedAt: 1,
        kind: 'git',
        connectionId: 'ssh-prod'
      }
    ],
    projectGroups: [],
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Notes',
        folderPath: '/srv/notes',
        connectionId: 'ssh-prod',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 1,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  },
  repos: []
})

describe('migration source scope', () => {
  it.each([
    ['a worktree of an exported repository', 'repo-1::/srv/app'],
    ['an exported folder workspace', 'folder:folder-1']
  ])('owns %s', (_name, ownerKey) => {
    expect(hivewarddMigrationOwnerMatchesScope(ownerKey, scope)).toBe(true)
  })

  it.each([
    ['another repository', 'repo-2::/srv/other'],
    ['another folder workspace', 'folder:folder-2'],
    ['no owner', null]
  ])('does not own %s', (_name, ownerKey) => {
    expect(hivewarddMigrationOwnerMatchesScope(ownerKey, scope)).toBe(false)
  })
})
