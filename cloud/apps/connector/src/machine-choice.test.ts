import type { ConnectorProject } from '@hiveward-cloud/connector-contract'
import { describe, expect, it } from 'vitest'
import type { ConnectorIdentity } from './connector-identities.js'
import { chooseMachine, type KnownHost } from './machine-choice.js'

function host(
  hostId: string,
  hostName: string,
  projects: ConnectorProject[],
  agents = ['claude'],
  sources = ['slack']
): KnownHost {
  return {
    hostId,
    hostName,
    hello: {
      v: 1,
      contract: 1,
      hostName,
      platform: 'darwin',
      runtime: 'desktop',
      hivewardVersion: '1.4.230',
      agents,
      promptKinds: [],
      features: [],
      sources,
      projects
    }
  }
}

const project = (name: string, placeId: string, remote?: string): ConnectorProject => ({
  placeId,
  name,
  ...(remote ? { remote } : {}),
  kind: 'git',
  where: { kind: 'local' }
})

const identity = (overrides: Partial<ConnectorIdentity> = {}): ConnectorIdentity => ({
  accountId: 'user-1',
  defaultHostId: null,
  defaultProject: null,
  containerProjects: {},
  ...overrides
})

const laptop = host('h1', 'laptop', [
  project('hiveward', 'pl_1', 'Chaunyzhang/HiveWard'),
  project('web', 'pl_2')
])
const server = host('h2', 'build box', [project('hiveward', 'pl_3', 'Chaunyzhang/HiveWard')])

const choose = (text: string, ident = identity(), hosts = [laptop, server], channelId = 'C1') =>
  chooseMachine({ source: 'slack', hosts, identity: ident, containerId: channelId, text })

describe('chooseMachine', () => {
  it('takes a project named in the message, by name or remote', () => {
    expect(choose('fix web please')).toMatchObject({
      kind: 'chosen',
      hostId: 'h1',
      placeId: 'pl_2',
      agent: 'claude'
    })
    expect(choose('in Chaunyzhang/HiveWard on build box')).toMatchObject({ kind: 'chosen', hostId: 'h2' })
  })

  it('falls back to the channel default, then the personal default', () => {
    const ident = identity({
      defaultProject: 'hiveward',
      containerProjects: { C1: 'web' },
      defaultHostId: 'h2'
    })
    expect(choose('fix it', ident)).toMatchObject({ kind: 'chosen', placeId: 'pl_2' })
    expect(choose('fix it', ident, [laptop, server], 'C2')).toMatchObject({
      kind: 'chosen',
      placeId: 'pl_3'
    })
  })

  it('asks when the project is on several machines and none is the default', () => {
    expect(choose('fix hiveward')).toEqual({
      kind: 'ask',
      options: [
        { project: 'hiveward', hostName: 'laptop' },
        { project: 'hiveward', hostName: 'build box' }
      ]
    })
  })

  it('asks with every project when nothing names one', () => {
    expect(choose('fix it')).toMatchObject({
      kind: 'ask',
      options: expect.arrayContaining([{ project: 'web', hostName: 'laptop' }])
    })
  })

  it('needs a machine that can run a connector agent', () => {
    expect(
      choose('fix hiveward', identity(), [host('h3', 'old', [project('hiveward', 'pl_4')], ['gemini'])])
    ).toEqual({
      kind: 'no_machine'
    })
    expect(choose('fix hiveward', identity(), [])).toEqual({ kind: 'no_machine' })
  })

  it('passes over a machine that does not take Slack work', () => {
    const hiveward = [project('hiveward', 'pl_3', 'Chaunyzhang/HiveWard')]
    const discordOnly = host('h2', 'build box', hiveward, ['claude'], ['discord'])
    expect(choose('fix hiveward', identity(), [laptop, discordOnly])).toMatchObject({
      kind: 'chosen',
      hostId: 'h1'
    })
    expect(choose('fix hiveward', identity(), [discordOnly])).toEqual({ kind: 'no_machine' })
  })

  it('reads a repository link, and lets no default override the project the message names', () => {
    const ident = identity({ defaultProject: 'web', defaultHostId: 'h1' })
    expect(choose('fix <https://github.com/Chaunyzhang/HiveWard|this> on build box', ident)).toMatchObject(
      {
        kind: 'chosen',
        hostId: 'h2'
      }
    )
    expect(choose('compare hiveward and web', ident)).toMatchObject({ kind: 'ask' })
  })

  it('reads a project name at the end of a sentence', () => {
    const ident = identity({ defaultProject: 'web' })
    for (const text of ['Please fix hiveward.', 'Please fix hiveward...', 'Please fix hiveward?']) {
      expect(choose(text, ident, [laptop])).toMatchObject({ kind: 'chosen', placeId: 'pl_1' })
    }
  })
  it('reads non-English project names, in either Unicode form, over a different default', () => {
    const ident = identity({ defaultProject: 'web' })
    for (const name of ['café', '프로젝트', '工具']) {
      const desk = host('h1', 'laptop', [project(name, 'pl_named'), project('web', 'pl_web')])
      for (const text of [`Please fix ${name}.`, `Please fix ${name}`.normalize('NFD')]) {
        expect(choose(text, ident, [desk])).toMatchObject({ kind: 'chosen', placeId: 'pl_named' })
      }
    }
  })
})
