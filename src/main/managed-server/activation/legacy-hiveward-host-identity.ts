import type { HivewarddActivationRecord } from './hivewardd-activation-record'
import {
  HIVEWARDD_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallVersionDirRegex
} from '../install/remote-install-model'

// 旧包没有独立产品字段，只从实际包内三个一致的产品标记识别继承版本。
export async function identifyLegacyHiveWardRecord(
  record: HivewarddActivationRecord,
  readBundle: (version: string) => Promise<string>
): Promise<HivewarddActivationRecord> {
  if (record.activeProduct || (record.previousProduct && record.previousProduct !== 'HiveWard')) {
    return record
  }
  const version = record.active ?? record.previous
  if (
    !version ||
    !remoteInstallVersionDirRegex(HIVEWARDD_INSTALL_MODEL).test(
      remoteInstallDirName(HIVEWARDD_INSTALL_MODEL, version)
    )
  ) {
    return record
  }
  try {
    const source = await readBundle(version)
    if (
      !/["']?appId["']?\s*:\s*["']local\.opc\.app["']/.test(source) ||
      !/["']?name["']?\s*:\s*["']HiveWard["']/.test(source) ||
      !/["']?runtimeMetadata["']?\s*:\s*["']opc-runtime\.json["']/.test(source)
    ) {
      return record
    }
    return {
      ...record,
      activeProduct: 'HiveWard',
      activeVersionFamily: source.includes('activeVersionFamily') ? 'hiveward' : 'inherited'
    }
  } catch {
    return record
  }
}
