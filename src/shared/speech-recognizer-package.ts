/** Desktop and hiveward serve share the app’s platform recognizer addon; hivewardd slots omit the ~70 MB package. */

/** Set by `hiveward serve` for hivewardd: the directory of the app's recognizer package. */
export const SPEECH_RECOGNIZER_DIR_ENV = 'HIVEWARD_SPEECH_RECOGNIZER_DIR'

export function speechRecognizerPackageName(platform: string, arch: string): string {
  return platform === 'win32' && arch === 'x64'
    ? 'sherpa-onnx-win-x64'
    : `sherpa-onnx-${platform}-${arch}`
}
