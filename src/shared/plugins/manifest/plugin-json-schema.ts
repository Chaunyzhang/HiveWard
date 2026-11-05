import { z } from 'zod'
import { pluginManifestV2Object } from './plugin-manifest'
import { PLUGIN_CATALOG_FILENAME, pluginCatalogDocumentSchema } from '../catalog/plugin-catalog'
import { renderPluginSchemaReference } from './plugin-schema-reference-doc'
import { renderPluginHostApiReference } from '../workers/plugin-host-api-reference-doc'
import { renderPluginThemeTokenReference } from '../artifacts/plugin-theme-token-reference-doc'
import {
  PLUGIN_CATALOG_POLICY_NOTES,
  PLUGIN_MANIFEST_POLICY_NOTES
} from './plugin-schema-policy-notes'

// Why the format in the file name: a later breaking format publishes beside v2, so a URL an author
// pinned never changes meaning under them.
export const PLUGIN_SCHEMA_DIRECTORY = 'docs/schemas/plugins'
export const PLUGIN_MANIFEST_SCHEMA_FILE = 'hiveward-plugin.v2.schema.json'
export const PLUGIN_CATALOG_SCHEMA_FILE = 'hiveward-catalog.v2.schema.json'
/** Git ref for published schemas; switch to the first v2 release tag when it ships. */
export const PLUGIN_SCHEMA_GIT_REF = 'hiveward'
export const PLUGIN_SCHEMA_BASE_URL = `https://raw.githubusercontent.com/Chaunyzhang/HiveWard/${PLUGIN_SCHEMA_GIT_REF}/${PLUGIN_SCHEMA_DIRECTORY}/`

export type PluginJsonSchema = z.core.JSONSchema.BaseSchema

function toPublishedSchema(
  schema: z.ZodType,
  file: string,
  title: string,
  description: string
): PluginJsonSchema {
  // Why input side: authors write what HiveWard reads, before defaults and transforms apply.
  const generated = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any'
  })
  const { $schema, ...body } = generated
  return { $schema, $id: `${PLUGIN_SCHEMA_BASE_URL}${file}`, title, description, ...body }
}

export function pluginManifestJsonSchema(): PluginJsonSchema {
  return toPublishedSchema(
    pluginManifestV2Object,
    PLUGIN_MANIFEST_SCHEMA_FILE,
    'HiveWard plugin manifest',
    'The hiveward-plugin.json file at the root of a HiveWard plugin (manifest format 2).'
  )
}

export function pluginCatalogJsonSchema(): PluginJsonSchema {
  return toPublishedSchema(
    pluginCatalogDocumentSchema,
    PLUGIN_CATALOG_SCHEMA_FILE,
    'HiveWard plugin catalog',
    `The ${PLUGIN_CATALOG_FILENAME} file that lists installable plugins and their releases.`
  )
}

/** Every generated file, keyed by repo-relative path, for the schema writer. */
export function pluginSchemaGeneratedFiles(): Record<string, string> {
  const manifest = pluginManifestJsonSchema()
  const catalog = pluginCatalogJsonSchema()
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
  return {
    [`${PLUGIN_SCHEMA_DIRECTORY}/${PLUGIN_MANIFEST_SCHEMA_FILE}`]: manifestJson,
    [`${PLUGIN_SCHEMA_DIRECTORY}/${PLUGIN_CATALOG_SCHEMA_FILE}`]: `${JSON.stringify(catalog, null, 2)}\n`,
    'docs/reference/plugin-manifest.md': renderPluginSchemaReference(manifest, {
      file: 'hiveward-plugin.json',
      schemaFile: PLUGIN_MANIFEST_SCHEMA_FILE,
      sinceNote:
        '`Since` is an engine capability version, independent of the HiveWard app version; raise `engines.hiveward` when you use a newer capability.',
      appendix: PLUGIN_MANIFEST_POLICY_NOTES
    }),
    'docs/reference/plugin-catalog.md': renderPluginSchemaReference(catalog, {
      file: PLUGIN_CATALOG_FILENAME,
      schemaFile: PLUGIN_CATALOG_SCHEMA_FILE,
      sinceNote:
        '`Since` is an engine capability version, independent of the HiveWard app version. Older engines ignore fields they do not know.',
      appendix: PLUGIN_CATALOG_POLICY_NOTES
    }),
    'docs/reference/plugin-host-api.md': renderPluginHostApiReference(),
    'docs/reference/plugin-theme-tokens.md': renderPluginThemeTokenReference()
  }
}
