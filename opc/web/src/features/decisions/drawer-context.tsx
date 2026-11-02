import { createContext, useContext, useState } from 'react'

const DrawerContext = createContext<{
  open: boolean
  setOpen: (open: boolean) => void
} | null>(null)

export function DecisionsDrawerProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <DrawerContext value={{ open, setOpen }}>{children}</DrawerContext>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDecisionsDrawer() {
  const ctx = useContext(DrawerContext)
  if (!ctx)
    throw new Error('useDecisionsDrawer 必须在 DecisionsDrawerProvider 内使用')
  return ctx
}
