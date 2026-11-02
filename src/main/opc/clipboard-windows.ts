import { windowsPowerShellPath } from '@orca/process-host/windows-system-binary'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { runClipboardHelper } from './clipboard-process'

const WINDOWS_SEQUENCE_SCRIPT = `
Add-Type -Namespace OrcaOpcClipboard -Name NativeMethods -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'
while ($true) {
  [Console]::WriteLine([OrcaOpcClipboard.NativeMethods]::GetClipboardSequenceNumber())
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 500
}
`

const WINDOWS_READ_FILES_SCRIPT = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$paths = [string[]]@(Get-Clipboard -Format FileDropList)
[Console]::Out.Write((ConvertTo-Json -InputObject $paths -Compress))
`

const WINDOWS_WRITE_FILES_SCRIPT = `
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$paths = [string[]]@(ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()))
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($path in $paths) { [void]$list.Add($path) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($list)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`

function powerShellSpec(script: string, sta: boolean): ProcessSpec {
  return {
    program: windowsPowerShellPath(),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      ...(sta ? ['-STA'] : []),
      '-Command',
      script
    ],
    env: process.env
  }
}

export function windowsClipboardSequenceSpec(): ProcessSpec {
  return powerShellSpec(WINDOWS_SEQUENCE_SCRIPT, false)
}

export async function readWindowsClipboardFiles(signal?: AbortSignal): Promise<string[]> {
  const output = await runClipboardHelper(powerShellSpec(WINDOWS_READ_FILES_SCRIPT, true), signal)
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error('clipboard_process_failed')
  }
  if (!Array.isArray(value)) {
    throw new Error('clipboard_process_failed')
  }
  const paths: string[] = []
  for (const path of value) {
    if (typeof path !== 'string') {
      throw new Error('clipboard_process_failed')
    }
    paths.push(path)
  }
  return paths
}

export async function writeWindowsClipboardFiles(
  paths: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  await runClipboardHelper(
    { ...powerShellSpec(WINDOWS_WRITE_FILES_SCRIPT, true), input: JSON.stringify(paths) },
    signal
  )
}
