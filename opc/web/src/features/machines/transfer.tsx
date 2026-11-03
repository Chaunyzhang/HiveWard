import { useNavigate } from '@tanstack/react-router'
import { useMachines } from '@/lib/machine'
import { Page, PageTitle } from '@/components/layout/page'
import { MachineTransfer } from '@/features/files'
import { BackButton } from '@/features/live/agent-console'
import { platformName } from './verify-code'

/** 局域网 → 点一台电脑：它的传输页。返回箭头回局域网。 */
export function MachineTransferPage({ machineId }: { machineId: string }) {
  const navigate = useNavigate()
  const { data: machines, isLoading, error } = useMachines()
  const machine = machines?.find((m) => m.id === machineId)
  return (
    <Page className='space-y-5'>
      <PageTitle
        leading={
          <BackButton onClick={() => void navigate({ to: '/machines' })} />
        }
        title={machine ? `${machine.name} · 传输` : '传输'}
        subtitle={
          machine
            ? `${machine.self ? '本机' : '局域网'}${machine.platform ? ` · ${platformName(machine.platform)}` : ''} · 选文件下载，或拖进来传过去`
            : undefined
        }
      />
      {machine ? (
        <MachineTransfer machine={machine} />
      ) : (
        <p className='rounded-xl panel p-6 text-[13px] text-muted-foreground'>
          {error
            ? `读取失败：${error.message}`
            : isLoading
              ? '读取中…'
              : '找不到这台电脑，可能已经移出组织了。'}
        </p>
      )}
    </Page>
  )
}
