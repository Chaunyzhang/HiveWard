import { HiveWardRuntimeService } from '../../runtime/hiveward-runtime'

export class ReceivingRuntime extends HiveWardRuntimeService {
  override getOrchestrationDbIfAvailable() {
    return super.getOrchestrationDbIfAvailable()
  }
  mailTarget(handle: string) {
    return this.resolveStructuredMailboxTarget(handle)
  }
}
