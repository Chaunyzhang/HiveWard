import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import { configureWslHostsGate } from './wsl-host-gate'

// 只读取本地已有主机与迁移日志，不再使用供应商远程策略缓存。
export function configureWslHostsGateFromDisk(userDataPath: string, _appVersion: string): void {
  configureWslHostsGate({
    hasSavedWslHost: () => readWslHostDeployments(userDataPath).deployments.length > 0,
    // Any journal entry, committed or not: recovery must reset an in-flight move whose host is gone.
    hasWslMoveCutover: () => listWslMoveCutovers(userDataPath).length > 0,
    policy: () => 'allow',
    movedProjects: () => 'keep'
  })
}
