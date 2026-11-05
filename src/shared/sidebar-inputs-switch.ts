// Gate main-owned sidebar producers and feed domains on HIVEWARD_SIDEBAR_INPUTS_IS_MAIN; off in shipped builds.
// Instantiate producers conditionally so switch-off builds drop them; register RPCs in SIDEBAR_INPUT_METHODS
// and domains in sidebar-inputs-feed-domains.ts.

/** Substituted by electron.vite.config.ts; absent (off) in tests, the CLI and the web client. */
declare const HIVEWARD_SIDEBAR_INPUTS: 'window' | 'main' | undefined

export const HIVEWARD_SIDEBAR_INPUTS_IS_MAIN =
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- undeclared outside electron-vite builds; a bare read throws.
  typeof HIVEWARD_SIDEBAR_INPUTS !== 'undefined' && HIVEWARD_SIDEBAR_INPUTS === 'main'
