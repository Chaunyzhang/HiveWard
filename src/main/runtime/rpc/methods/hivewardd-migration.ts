import type { z } from 'zod'
import {
  HivewarddMigrationCatalogParams,
  HivewarddMigrationCatalogReferenceParams,
  HivewarddMigrationCommitCatalogParams
} from '../../../../shared/rpc-contract/hivewardd-migration-params'
import { parseHivewarddMigrationManifest } from '../../../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import { HivewarddMigrationSnapshotChunkRequestSchema } from '../../../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import { HivewarddMigrationBlobChunkRequestSchema } from '../../../../shared/hivewardd-migration/hivewardd-migration-blob-transfer'
import { assertHivewarddMigrationManifestDigest } from '../../../hivewardd/hivewardd-migration-manifest-digest'
import { assertHivewarddMigrationSourceServedHere } from '../../../hivewardd/hivewardd-migration-wsl-destination'
import { defineMethod, type RpcContext } from '../core'

export const HIVEWARDD_MIGRATION_METHODS = [
  defineMethod({
    name: 'hivewardd.migration.stageCatalog',
    permission: 'host-admin',
    params: HivewarddMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageHivewarddMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'hivewardd.migration.commitCatalog',
    permission: 'host-admin',
    params: HivewarddMigrationCommitCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.commitStagedHivewarddMigrationCatalog(migrationManifest(params), {
        signal: context.signal,
        ...(params.expectedBlobs ? { expectedBlobs: params.expectedBlobs } : {})
      })
    }
  }),
  defineMethod({
    name: 'hivewardd.migration.stageSnapshotChunk',
    permission: 'host-admin',
    params: HivewarddMigrationSnapshotChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageHivewarddMigrationSnapshotChunk(params)
    }
  }),
  // A separate method, not a field on stageSnapshotChunk: an older host would strip the field and
  // stage the bytes as a snapshot.
  defineMethod({
    name: 'hivewardd.migration.stageBlobChunk',
    permission: 'host-admin',
    params: HivewarddMigrationBlobChunkRequestSchema,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.stageHivewarddMigrationBlobChunk(params)
    }
  }),
  defineMethod({
    name: 'hivewardd.migration.abortCatalog',
    permission: 'host-admin',
    params: HivewarddMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedHivewarddMigrationCatalog(migrationManifest(params), {
        signal: context.signal
      })
    }
  }),
  // Why a reference: a source fenced on a manifest no request can carry must still be releasable.
  defineMethod({
    name: 'hivewardd.migration.abortCatalogByReference',
    permission: 'host-admin',
    params: HivewarddMigrationCatalogReferenceParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.abortStagedHivewarddMigrationCatalogByReference(params, {
        signal: context.signal
      })
    }
  }),
  defineMethod({
    name: 'hivewardd.migration.catalogState',
    permission: 'host-admin',
    params: HivewarddMigrationCatalogParams,
    handler: async (params, context) => {
      requireMigrationRuntimeClient(context)
      return context.runtime.getHivewarddMigrationCatalogState(migrationManifest(params))
    }
  })
]

function migrationManifest(params: z.infer<typeof HivewarddMigrationCatalogParams>) {
  const manifest = parseHivewarddMigrationManifest(params.manifest)
  // Raw, not parsed: parsing drops fields this host predates, which a newer client signed.
  assertHivewarddMigrationManifestDigest(params.manifest)
  assertHivewarddMigrationSourceServedHere(manifest.source)
  return manifest
}

function requireMigrationRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId) {
    throw new Error('hivewardd_migration_runtime_client_required')
  }
}
