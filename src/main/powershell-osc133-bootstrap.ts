import { getPowerShellOmpShellWrapper } from './pty/omp-shell-wrapper'
import { MANAGED_DATA_ACCOUNT_POWERSHELL_RESTORE } from '../shared/managed-data-account-shell'
import { getPowerShellAgentWrappers } from '../shared/powershell-agent-wrappers'
export { encodePowerShellCommand } from '../shared/powershell-command-encoding'

// Inline scripts work under Restricted/AllSigned policies that block dot-sourced files.
// EncodedCommand preserves quoting for appended cwd/startup commands; AMSI and script logging still decode it.
const POWERSHELL_OSC133_BOOTSTRAP = `# HiveWard OSC 133 shell integration for PowerShell.
# Profiles have already loaded normally by the time -EncodedCommand runs.
# Restore managed ownership before the shell-integration compatibility guard.
if ($env:HIVEWARD_OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR = $env:HIVEWARD_OPENCODE_CONFIG_DIR }
${MANAGED_DATA_ACCOUNT_POWERSHELL_RESTORE}
if ($env:HIVEWARD_MIMOCODE_CONFIG_DIR) { $env:MIMOCODE_CONFIG_DIR = $env:HIVEWARD_MIMOCODE_CONFIG_DIR }
if ($env:HIVEWARD_CODEX_HOME) { $env:CODEX_HOME = $env:HIVEWARD_CODEX_HOME }

if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage" -and
    ((-not (Test-Path variable:global:__HiveWardOsc133State)) -or
     $null -eq $Global:__HiveWardOsc133State.OriginalPrompt)) {
    # Wrap the user's final prompt/readline state; do not source profiles here.

    # Preserve Windows CJK output by keeping ConPTY on UTF-8 without bypassing
    # profile loading or execution-policy checks.
    try {
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
        [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
        $OutputEncoding = [Console]::OutputEncoding
    } catch { Write-Error $_ -ErrorAction Continue }

${getPowerShellOmpShellWrapper()}
${getPowerShellAgentWrappers()}

    $Global:__HiveWardOsc133State = @{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
    }

    function Global:prompt {
        # Capture FIRST; any other expression can clobber PowerShell's success bit.
        $fakeExitCode = [int](!$global:?)
        Set-StrictMode -Off
        $result = ""

        # Emit D from prompt, not readline state. Some profile setups bypass
        # PSConsoleHostReadLine; the consumer only needs completion.
        if ($Global:__HiveWardOsc133State.HasSeenPrompt) {
            $result += "$($Global:__HiveWardOsc133State.Esc)]133;D;$fakeExitCode$($Global:__HiveWardOsc133State.Bel)"
        }
        $Global:__HiveWardOsc133State.HasSeenPrompt = $true

        $result += "$($Global:__HiveWardOsc133State.Esc)]133;A$($Global:__HiveWardOsc133State.Bel)"
        # Preserve the previous success/failure value for prompts that inspect it.
        if ($fakeExitCode -ne 0) { Write-Error "failure" -ea ignore }
        $result += $Global:__HiveWardOsc133State.OriginalPrompt.Invoke()
        $result += "$($Global:__HiveWardOsc133State.Esc)]133;B$($Global:__HiveWardOsc133State.Bel)"
        $result
    }

    # Local ConPTY delivers real Alt+Left/Right (#29177); mirror Alt+B/F so Emacs-mode word motion survives.
    if ($Global:__HiveWardOsc133State.HasPSReadLine) {
        & {
            $bound = Get-PSReadLineKeyHandler -Bound -ErrorAction SilentlyContinue
            foreach ($pair in ('LeftArrow', 'b'), ('RightArrow', 'f')) {
                $source = $bound | Where-Object Key -ceq "Alt+$($pair[1])" | Select-Object -First 1
                if ($source -and -not ($bound | Where-Object Key -eq "Alt+$($pair[0])")) {
                    try { Set-PSReadLineKeyHandler -Chord "Alt+$($pair[0])" -Function $source.Function } catch {}
                }
            }
        }
    }

    if ($Global:__HiveWardOsc133State.HasPSReadLine -and
        $null -ne $Global:__HiveWardOsc133State.OriginalReadLine) {
        function Global:PSConsoleHostReadLine {
            $commandLine = $Global:__HiveWardOsc133State.OriginalReadLine.Invoke()
            [Console]::Write("$($Global:__HiveWardOsc133State.Esc)]133;C$($Global:__HiveWardOsc133State.Bel)")
            return $commandLine
        }
    }
}
`

// Strip comments and indentation to leave command-line space for appended startup commands (no multi-line strings).
const POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD = POWERSHELL_OSC133_BOOTSTRAP.replace(
  /^[ \t]*#.*\n/gm,
  ''
).replace(/^[ \t]+/gm, '')

export function getPowerShellOsc133Bootstrap(): string {
  return POWERSHELL_OSC133_BOOTSTRAP_PAYLOAD
}

// Startup commands run before the first prompt, which suppresses 133;D; mark them like typed commands.
export function getPowerShellOsc133StartupCommandMark(): string {
  return 'if (Test-Path variable:global:__HiveWardOsc133State) { [Console]::Write("$([char]27)]133;C$([char]7)"); $Global:__HiveWardOsc133State.HasSeenPrompt = $true }'
}

export function isPowerShellExecutableName(shellName: string): boolean {
  const normalized = shellName.toLowerCase()
  return (
    normalized === 'pwsh' ||
    normalized === 'pwsh.exe' ||
    normalized === 'powershell' ||
    normalized === 'powershell.exe'
  )
}
