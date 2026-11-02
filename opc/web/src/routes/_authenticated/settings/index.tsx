import { createFileRoute, redirect } from '@tanstack/react-router'

// 设置目前只有「外观」一页
export const Route = createFileRoute('/_authenticated/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/appearance', replace: true })
  },
})
