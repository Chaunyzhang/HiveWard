export type MainWindowLoadObserver = {
  onLoaded?: () => void
  onError?: (error: Error) => void
}

export type CreateMainWindowOptions = {
  getIsQuitting?: () => boolean
  deferLoad?: boolean
  revealOnDidFinishLoad?: boolean
  title?: string
}
