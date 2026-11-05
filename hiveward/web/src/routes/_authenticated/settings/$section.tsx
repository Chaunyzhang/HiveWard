import { createFileRoute } from '@tanstack/react-router'

// 设置在弹窗里：/settings/<页> 由上一层打开弹窗，这里不画东西
export const Route = createFileRoute('/_authenticated/settings/$section')({
  component: () => null,
})
