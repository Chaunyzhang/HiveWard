export const HIVEWARD_EDITOR_SAVE_DIRTY_FILES_EVENT = 'hiveward:editor-save-dirty-files'
export const HIVEWARD_EDITOR_PREPARE_HOT_EXIT_EVENT = 'hiveward:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
