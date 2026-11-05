import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  HIVEWARDD_MANAGED_STOP_REQUEST_MAX_BYTES,
  HIVEWARDD_MANAGED_STOP_REQUEST_PREFIX,
  HivewarddManagedStopRequestSchema,
  type HivewarddManagedStopContext,
  type HivewarddManagedStopInstance,
  type HivewarddManagedStopRequest
} from '../../shared/hivewardd-stop-request'
import { readHivewarddInstanceLockRecord, type HivewarddLockRecord } from './hivewardd-instance-lock'

/** Nonce-scoped paths prevent requests from addressing a previous instance. */
export function hivewarddManagedStopRequestPath(instance: HivewarddManagedStopInstance): string {
  const digest = createHash('sha256').update(instance.nonce).digest('hex')
  return join(dirname(instance.lockPath), `${HIVEWARDD_MANAGED_STOP_REQUEST_PREFIX}.${digest}`)
}

export function readHivewarddManagedStopRequest(path: string): HivewarddManagedStopRequest {
  if (!lstatSync(path).isFile()) {
    throw new Error('hivewardd_managed_stop_request_not_regular_file')
  }
  const { buffer } = readNodeFileSyncWithinLimit(path, HIVEWARDD_MANAGED_STOP_REQUEST_MAX_BYTES)
  return HivewarddManagedStopRequestSchema.parse(JSON.parse(buffer.toString('utf8')))
}

function sameHivewarddManagedStopInstance(
  left: HivewarddManagedStopInstance,
  right: Pick<HivewarddManagedStopInstance, 'pid' | 'startedAtMs' | 'nonce'>
): boolean {
  return (
    left.pid === right.pid && left.startedAtMs === right.startedAtMs && left.nonce === right.nonce
  )
}

export function hivewarddInstanceLockNames(instance: HivewarddManagedStopInstance): boolean {
  return readHivewarddInstanceLockNaming(instance) !== null
}

export function readHivewarddInstanceLockNaming(
  instance: HivewarddManagedStopInstance
): HivewarddLockRecord | null {
  if (!lstatSync(instance.lockPath).isFile()) {
    return null
  }
  const record = readHivewarddInstanceLockRecord(instance.lockPath)
  return record !== null && sameHivewarddManagedStopInstance(instance, record) ? record : null
}

export function validateHivewarddManagedStopRequest(
  context: HivewarddManagedStopContext,
  requestPath: string
): HivewarddManagedStopRequest {
  const request = readHivewarddManagedStopRequest(requestPath)
  if (
    request.version !== context.version ||
    request.runtimeId !== context.runtimeId ||
    // Windows clients and servers may use different separators for the same lock.
    resolve(request.instance.lockPath) !== resolve(context.instance.lockPath) ||
    !sameHivewarddManagedStopInstance(request.instance, context.instance)
  ) {
    throw new Error('hivewardd_managed_stop_request_identity_mismatch')
  }
  if (!hivewarddInstanceLockNames(context.instance)) {
    throw new Error('hivewardd_managed_stop_instance_lock_changed')
  }
  return request
}
