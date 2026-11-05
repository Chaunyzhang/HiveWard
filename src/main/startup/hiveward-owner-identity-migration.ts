// 一次性资料迁移专用：只把旧身份字段改成 hiveward-owner，用户原文不动。
export function migrateOwnerIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(migrateOwnerIdentity)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      ['id', 'ownerId', 'recipient', 'to'].includes(key) && item === 'opc-owner'
        ? 'hiveward-owner'
        : migrateOwnerIdentity(item)
    ])
  )
}
