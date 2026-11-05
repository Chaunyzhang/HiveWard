import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import { overviewQuery } from '@/lib/hiveward-api'
import { useCurrentMachineId, useSwitchMachine } from '@/lib/machine'
import { projectForPath } from '@/lib/project-for-path'

/**
 * 按本机目录打开所在项目的终端页（App 里点系统通知时跳到这里，path 是 Agent 所在的目录）。
 * 正在看别的电脑时先切回本机；目录不属于任何项目就回驾驶舱。
 */
export function GoToPath({ path, t }: { path: string; t?: string }) {
  const navigate = useNavigate()
  const viewing = useCurrentMachineId()
  const switchMachine = useSwitchMachine()
  const { data, isError } = useQuery({
    ...overviewQuery(null),
    enabled: viewing === null,
  })

  useEffect(() => {
    if (viewing !== null) {
      void switchMachine(null)
    }
  }, [viewing, switchMachine])

  useEffect(() => {
    if (isError) {
      void navigate({ to: '/', replace: true })
      return
    }
    if (!data) {
      return
    }
    const project = projectForPath(data.businesses, path)
    void (project
      ? navigate({
          to: '/b/$businessId',
          params: { businessId: project.id },
          search: { tab: 'live', t },
          replace: true,
        })
      : navigate({ to: '/', replace: true }))
  }, [data, isError, path, t, navigate])

  return (
    <div className='grid h-full place-items-center text-muted-foreground'>
      <LoaderCircle className='size-4 animate-spin' />
    </div>
  )
}
