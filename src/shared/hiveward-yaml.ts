import { parseDocument } from 'yaml'
import { isHiveWardYamlConversionWithinLimit } from './hiveward-yaml-merge-expansion'
import type {
  HivewarddefaultTabTemplate,
  HiveWardHooks,
  HiveWardVmRecipe,
  HiveWardVmRecipeDiagnostic
} from './hiveward-yaml-hook-types'
import {
  isHiveWardYamlFieldWithinLimit,
  isHiveWardYamlTextWithinLimit,
  MAX_HIVEWARD_YAML_ALIAS_COUNT,
  MAX_HIVEWARD_YAML_COLLECTION_ENTRIES
} from './hiveward-yaml-file-limit'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isHiveWardYamlFieldWithinLimit(value)) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

const DEFAULT_TAB_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/
export const HIVEWARD_VM_RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const HIVEWARD_VM_RECIPE_ID_RULE =
  'Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'

// Bound work requested by one repository file.
const MAX_SHARED_DIRECTORIES = 100

/** Normalize safe repo-relative paths. Reject internal ./ rather than collapsing it: Git reports the collapsed path,
 * so stored comparisons would miss and symlinks would appear permanently untracked. */
function normalizeSharedDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SHARED_DIRECTORIES)) {
    const raw = asTrimmedString(entry)
    if (!raw) {
      continue
    }
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const segments = normalized.split('/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      segments.includes('..') ||
      segments.includes('.') ||
      segments.includes('') ||
      segments.includes('.git')
    ) {
      continue
    }
    seen.add(normalized)
  }
  return Array.from(seen)
}

function normalizeDefaultTabs(value: unknown): HivewarddefaultTabTemplate[] {
  if (!Array.isArray(value) || value.length > MAX_HIVEWARD_YAML_COLLECTION_ENTRIES) {
    return []
  }

  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) {
        return null
      }
      const title = asTrimmedString(record.title)
      const command = asTrimmedString(record.command)
      const color = asTrimmedString(record.color)
      const normalizedColor = color && DEFAULT_TAB_COLOR_RE.test(color) ? color : undefined
      if (!title && !command && !normalizedColor) {
        return null
      }
      return {
        ...(title ? { title } : {}),
        ...(normalizedColor ? { color: normalizedColor } : {}),
        ...(command ? { command } : {})
      }
    })
    .filter((entry): entry is HivewarddefaultTabTemplate => entry !== null)
}

type VmRecipeParseResult = {
  recipes: HiveWardVmRecipe[]
  diagnostics: HiveWardVmRecipeDiagnostic[]
}

function normalizeVmRecipes(value: unknown): VmRecipeParseResult {
  const diagnostics: HiveWardVmRecipeDiagnostic[] = []
  if (!Array.isArray(value)) {
    return { recipes: [], diagnostics }
  }
  if (value.length > MAX_HIVEWARD_YAML_COLLECTION_ENTRIES) {
    return {
      recipes: [],
      diagnostics: [
        {
          index: MAX_HIVEWARD_YAML_COLLECTION_ENTRIES,
          message: `At most ${MAX_HIVEWARD_YAML_COLLECTION_ENTRIES} environment recipes are supported.`
        }
      ]
    }
  }

  const seenIds = new Set<string>()
  const recipes = value
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) {
        diagnostics.push({
          index,
          message: 'Recipe entry must be a mapping.'
        })
        return null
      }
      const id = asTrimmedString(record.id)
      const name = asTrimmedString(record.name)
      const create = asTrimmedString(record.create) ?? asTrimmedString(record.command)
      if (!id) {
        diagnostics.push({ index, field: 'id', message: 'Recipe id is required.' })
        return null
      }
      if (!HIVEWARD_VM_RECIPE_ID_PATTERN.test(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Invalid recipe id "${id}". ${HIVEWARD_VM_RECIPE_ID_RULE}`
        })
        return null
      }
      if (seenIds.has(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Duplicate recipe id "${id}". Recipe ids must be unique.`
        })
        return null
      }
      if (!name) {
        diagnostics.push({ index, field: 'name', message: `Recipe "${id}" is missing name.` })
        return null
      }
      if (!create) {
        diagnostics.push({ index, field: 'create', message: `Recipe "${id}" is missing create.` })
        return null
      }
      seenIds.add(id)
      const description = asTrimmedString(record.description)
      const checkoutMode = asTrimmedString(record.checkoutMode)
      if (checkoutMode && checkoutMode !== 'hiveward-worktree' && checkoutMode !== 'provisioned-root') {
        diagnostics.push({
          index,
          field: 'checkoutMode',
          message: `Recipe "${id}" checkoutMode must be "hiveward-worktree" or "provisioned-root".`
        })
        return null
      }
      const suspend = asTrimmedString(record.suspend)
      const resume = asTrimmedString(record.resume)
      const destroyValue = asTrimmedString(record.destroy) ?? asTrimmedString(record.cleanup)
      const destroyDisabled = destroyValue === 'none'
      return {
        id,
        name,
        create,
        ...(checkoutMode ? { checkoutMode } : {}),
        ...(description ? { description } : {}),
        ...(suspend ? { suspend } : {}),
        ...(resume ? { resume } : {}),
        ...(destroyValue && !destroyDisabled ? { destroy: destroyValue } : {}),
        ...(destroyDisabled ? { destroyDisabled: true } : {})
      }
    })
    .filter((entry): entry is HiveWardVmRecipe => entry !== null)
  return { recipes, diagnostics }
}

export function parseHiveWardYaml(content: string): HiveWardHooks | null {
  if (!isHiveWardYamlTextWithinLimit(content)) {
    return null
  }

  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      merge: true,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0 || !isHiveWardYamlConversionWithinLimit(document)) {
      return null
    }
    root = document.toJS({ maxAliasCount: MAX_HIVEWARD_YAML_ALIAS_COUNT })
  } catch {
    return null
  }

  const record = asRecord(root)
  if (!record) {
    return null
  }

  const scriptsRecord = asRecord(record.scripts)
  const setup = scriptsRecord ? asTrimmedString(scriptsRecord.setup) : undefined
  const archive = scriptsRecord ? asTrimmedString(scriptsRecord.archive) : undefined
  const setupAgentStartupPolicy =
    record.setupAgentStartupPolicy === 'start-immediately' ||
    record.setupAgentStartupPolicy === 'wait-for-setup'
      ? record.setupAgentStartupPolicy
      : undefined
  const issueCommand = asTrimmedString(record.issueCommand)
  const defaultTabs = normalizeDefaultTabs(record.defaultTabs)
  const environmentRecipeParse = normalizeVmRecipes(record.environmentRecipes)
  const environmentRecipes = environmentRecipeParse.recipes
  const environmentRecipeDiagnostics = environmentRecipeParse.diagnostics
  const worktreeRecord = asRecord(record.worktree)
  const sharedDirectories = worktreeRecord
    ? normalizeSharedDirectories(worktreeRecord.sharedDirectories)
    : []

  if (
    !setup &&
    !archive &&
    !issueCommand &&
    !setupAgentStartupPolicy &&
    defaultTabs.length === 0 &&
    environmentRecipes.length === 0 &&
    environmentRecipeDiagnostics.length === 0 &&
    sharedDirectories.length === 0
  ) {
    return null
  }

  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
    },
    ...(setupAgentStartupPolicy ? { setupAgentStartupPolicy } : {}),
    ...(issueCommand ? { issueCommand } : {}),
    ...(defaultTabs.length > 0 ? { defaultTabs } : {}),
    ...(environmentRecipes.length > 0 ? { environmentRecipes } : {}),
    ...(environmentRecipeDiagnostics.length > 0 ? { environmentRecipeDiagnostics } : {}),
    ...(sharedDirectories.length > 0 ? { worktree: { sharedDirectories } } : {})
  }
}
