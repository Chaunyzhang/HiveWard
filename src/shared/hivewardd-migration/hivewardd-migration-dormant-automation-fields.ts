import {
  optionalFinite,
  optionalNullableString,
  requiredBoolean,
  requiredFinite,
  requiredRecord,
  requiredString,
  requiredStringOrEmpty
} from './hivewardd-migration-dormant-value-validation'

export function parsePrecheck(value: unknown): void {
  if (value === null) {
    return
  }
  const record = requiredRecord(value, 'hivewardd_migration_dormant_automation_precheck_invalid')
  requiredString(record.command, 'hivewardd_migration_dormant_automation_precheck_command_invalid')
  requiredFinite(
    record.timeoutSeconds,
    'hivewardd_migration_dormant_automation_precheck_timeout_invalid'
  )
}

export function parseOutputSnapshot(value: unknown): void {
  if (value === null) {
    return
  }
  const record = requiredRecord(value, 'hivewardd_migration_dormant_automation_output_invalid')
  if (record.format !== 'plain_text') {
    throw new Error('hivewardd_migration_dormant_automation_output_format_invalid')
  }
  requiredStringOrEmpty(record.content, 'hivewardd_migration_dormant_automation_output_content_invalid')
  requiredFinite(record.capturedAt, 'hivewardd_migration_dormant_automation_output_time_invalid')
  requiredBoolean(record.truncated, 'hivewardd_migration_dormant_automation_output_truncated_invalid')
}

export function parsePrecheckResult(value: unknown): void {
  if (value === null) {
    return
  }
  const record = requiredRecord(value, 'hivewardd_migration_dormant_automation_precheck_result_invalid')
  requiredString(
    record.command,
    'hivewardd_migration_dormant_automation_precheck_result_command_invalid'
  )
  optionalFinite(
    record.exitCode,
    'hivewardd_migration_dormant_automation_precheck_result_exit_invalid',
    true
  )
  requiredBoolean(
    record.timedOut,
    'hivewardd_migration_dormant_automation_precheck_result_timeout_invalid'
  )
  requiredFinite(
    record.durationMs,
    'hivewardd_migration_dormant_automation_precheck_result_duration_invalid'
  )
  for (const field of ['stdout', 'stderr'] as const) {
    requiredStringOrEmpty(record[field], `hivewardd_migration_dormant_automation_${field}_invalid`)
    requiredBoolean(
      record[`${field}Truncated`],
      `hivewardd_migration_dormant_automation_${field}_truncated_invalid`
    )
  }
  optionalNullableString(
    record.error,
    'hivewardd_migration_dormant_automation_precheck_result_error_invalid'
  )
  requiredFinite(
    record.startedAt,
    'hivewardd_migration_dormant_automation_precheck_result_started_invalid'
  )
  requiredFinite(
    record.completedAt,
    'hivewardd_migration_dormant_automation_precheck_result_completed_invalid'
  )
}

export function parseUsage(value: unknown): void {
  if (value === null) {
    return
  }
  const record = requiredRecord(value, 'hivewardd_migration_dormant_automation_usage_invalid')
  if (record.status !== 'known' && record.status !== 'unavailable') {
    throw new Error('hivewardd_migration_dormant_automation_usage_status_invalid')
  }
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningOutputTokens',
    'totalTokens',
    'estimatedCostUsd'
  ] as const) {
    optionalFinite(record[field], `hivewardd_migration_dormant_automation_usage_${field}_invalid`, true)
  }
  requiredFinite(record.collectedAt, 'hivewardd_migration_dormant_automation_usage_collected_invalid')
}
