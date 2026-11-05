# Ephemeral CI only: one private-sshd account, DefaultShell and vitest process per host cell for an empty runtime store.
param(
 [Parameter(Mandatory=$true)][string]$SourceRoot,
 [Parameter(Mandatory=$true)][hashtable]$Context,
 [Parameter(Mandatory=$true)][ValidateSet('win32-arm64','win32-x64')][string]$Target,
 [Parameter(Mandatory=$true)][string]$ReceiptRoot,
 [ValidateSet('hivewardd-cmd','hivewardd-powershell','hivewardd-convert','hivewardd-cli-managed','hivewardd-cli-convert')][string[]]$Cells=@('hivewardd-cmd','hivewardd-powershell')
)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:HIVEWARD_ISOLATED_SSH_CI -ne '1'){throw 'Disposable CI only'}
$shells=@{'hivewardd-cmd'='cmd';'hivewardd-powershell'='powershell';'hivewardd-convert'='cmd';'hivewardd-cli-managed'='cmd';'hivewardd-cli-convert'='cmd'}
# App-level cells drive the e2e build (and the bundled CLI) against the host; each greps one tagged test.
$appCells=@{'hivewardd-convert'=@('tests/e2e/ssh-hivewardd-auto-convert.spec.ts','');'hivewardd-cli-managed'=@('tests/e2e/ssh-hivewardd-windows-cli-matrix.spec.ts','@hivewardd-cli-managed');'hivewardd-cli-convert'=@('tests/e2e/ssh-hivewardd-windows-cli-matrix.spec.ts','@hivewardd-cli-convert')}
$electronBuilt=$false
if($Context.accounts.Count -lt $Cells.Count){throw 'Each cell needs its own private account'}
$seenApp=$false
foreach($id in $Cells){if($appCells.ContainsKey($id)){$seenApp=$true}elseif($seenApp){throw 'App cells must run last: they switch native modules to Electron'}}
if(-not $Context.forbiddenToolLog){throw 'Run the provisioning with -HiddenTools so toolchain calls are logged'}
$openSshKey='HKLM:\SOFTWARE\OpenSSH'
$windowsPowerShell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$knownPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\known_hosts'
$knownExisted=Test-Path -LiteralPath $knownPath
$priorKnown=if($knownExisted){[IO.File]::ReadAllBytes($knownPath)}else{$null}
$priorBackground=$env:HIVEWARD_BACKGROUND_LAUNCH
$failed=[Collections.Generic.List[string]]::new()
$summary=[Collections.Generic.List[hashtable]]::new()

function Invoke-PrivateSsh([string]$Account,[string]$Command) {
  $start=[Diagnostics.ProcessStartInfo]::new($Context.sshExe)
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($argument in @('-F','NUL','-T','-p',[string]$Context.port,'-i',$Context.identityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$($Context.knownHosts)",'-o','ConnectTimeout=5',"$Account@127.0.0.1",$Command)){$start.ArgumentList.Add($argument)}
  $process=[Diagnostics.Process]::Start($start)
  try {
    $stdout=$process.StandardOutput.ReadToEndAsync();$null=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(30000)){$process.Kill($true);throw 'Private SSH probe deadline exceeded'}
    return $stdout.GetAwaiter().GetResult()
  } finally {$process.Dispose()}
}

function Set-PrivateDefaultShell([string]$Shell) {
  if($Shell -eq 'powershell'){
    if(-not (Test-Path -LiteralPath $openSshKey)){New-Item -Path $openSshKey -Force | Out-Null}
    New-ItemProperty -LiteralPath $openSshKey -Name DefaultShell -Value $windowsPowerShell -PropertyType String -Force | Out-Null
  } elseif(Test-Path -LiteralPath $openSshKey) {
    Remove-ItemProperty -LiteralPath $openSshKey -Name DefaultShell -ErrorAction SilentlyContinue
  }
}

# Diagnostic HIVEWARD_WMI=<ReturnValue>|denied: standard SSH logons lack root\cimv2 Remote Enable; HiveWard must launch without WMI.
function Test-PrivateWmiLaunch([string]$Account) {
  $out=Invoke-PrivateSsh $Account 'powershell.exe -NoProfile -NonInteractive -Command "try{$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=''cmd.exe /d /c exit 0''} -ErrorAction Stop;''HIVEWARD_WMI=''+$r.ReturnValue}catch{''HIVEWARD_WMI=denied''}"'
  $match=[regex]::Match($out,'HIVEWARD_WMI=(\S+)')
  if($match.Success){return $match.Groups[1].Value}else{return 'no-output'}
}

# Run app-level cells last: the e2e build switches natives to Electron’s ABI, which vitest cannot load.
function Invoke-AppCell($Account,[string]$Descriptor,[string]$Log,[string]$Spec,[string]$Grep) {
  $ready=Invoke-PrivateSsh $Account.name 'git init -q hiveward-convert-repo && git -C hiveward-convert-repo -c user.name=hiveward -c user.email=hiveward@example.invalid commit -q --allow-empty -m init && echo HIVEWARD_REPO_READY'
  if($ready -notmatch 'HIVEWARD_REPO_READY'){throw 'Could not create the convert cell repository as the account'}
  # Out of the app's default lookup, so the relay phase runs without a template.
  $template=Join-Path $env:RUNNER_TEMP 'hivewardd-convert-template'
  # Why guarded: Copy-Item into an existing folder nests the copy instead of replacing it.
  if(-not (Test-Path -LiteralPath $template)){Copy-Item -LiteralPath 'out\hivewardd-template' -Destination $template -Recurse -Force}
  Rename-Item -LiteralPath 'out\hivewardd-template' -NewName 'hivewardd-template.convert-hidden'
  try {
    if(-not $script:electronBuilt){
      & node config/scripts/ensure-native-runtime.mjs --runtime=electron 2>&1 | Tee-Object -FilePath $Log | Out-Host
      if($global:LASTEXITCODE -ne 0){Write-Host 'Switching native modules to Electron failed';return $global:LASTEXITCODE}
      & pnpm exec electron-vite build --mode e2e 2>&1 | Tee-Object -FilePath $Log -Append | Out-Host
      if($global:LASTEXITCODE -ne 0){Write-Host 'The e2e app build failed';return $global:LASTEXITCODE}
      $script:electronBuilt=$true
    }
    $env:HIVEWARD_E2E_HIVEWARDD_CONVERT_HOST=$Descriptor;$env:HIVEWARD_E2E_HIVEWARDD_CONVERT_TEMPLATE=$template;$env:SKIP_BUILD='1'
    $grepArgs=if($Grep){@('--grep',$Grep)}else{@()}
    & pnpm exec playwright test --config tests/playwright.config.ts $Spec @grepArgs --project=electron-headless --workers=1 2>&1 | Tee-Object -FilePath $Log -Append | Out-Host
    # Functions return uncaptured output, so only the exit code may reach the caller.
    return $global:LASTEXITCODE
  } finally {
    # Screenshots, traces and error context: Playwright clears test-results on the next cell's run.
    if(Test-Path -LiteralPath 'test-results'){Copy-Item -LiteralPath 'test-results' -Destination ($Log -replace '\.log$','.test-results') -Recurse -Force}
    Remove-Item Env:HIVEWARD_E2E_HIVEWARDD_CONVERT_HOST,Env:HIVEWARD_E2E_HIVEWARDD_CONVERT_TEMPLATE,Env:SKIP_BUILD -ErrorAction SilentlyContinue
    Rename-Item -LiteralPath 'out\hivewardd-template.convert-hidden' -NewName 'hivewardd-template'
  }
}

New-Item -ItemType Directory -Force -Path $ReceiptRoot | Out-Null
Push-Location $SourceRoot
try {
  if(-not (Test-Path -LiteralPath 'out\hivewardd-template')){throw 'Build the hivewardd template before provisioning'}
  # ssh2 consults the runner's known_hosts: pin only this private endpoint, restored below.
  New-Item -ItemType Directory -Force -Path (Split-Path $knownPath) | Out-Null
  Add-Content -LiteralPath $knownPath -Value ("`n"+[IO.File]::ReadAllText($Context.knownHosts))
  $env:HIVEWARD_BACKGROUND_LAUNCH='1'
  # DefaultShell is still stock cmd here.
  $wmi=Test-PrivateWmiLaunch $Context.accounts[0].name
  Write-Host "Standard SSH user WMI Win32_Process.Create: $wmi (no grant; the hivewardd launch must not depend on it)"
  $summary.Add(@{standardUserWmiLaunch=$wmi;granted=$false})
  for($index=0;$index -lt $Cells.Count;$index++){
    $cell=$Cells[$index];$account=$Context.accounts[$index];$shell=$shells[$cell]
    Set-PrivateDefaultShell $shell
    # cmd expands %COMSPEC%; PowerShell prints it literally.
    $dispatch=Invoke-PrivateSsh $account.name 'echo %COMSPEC%'
    $dispatchShell=if($dispatch -match '(?i)\\cmd\.exe'){'cmd'}elseif($dispatch -match '%COMSPEC%'){'powershell'}else{'unknown'}
    if($dispatchShell -ne $shell){throw "DefaultShell $shell did not take effect for $cell (saw $dispatchShell)"}
    if(Test-Path -LiteralPath $Context.forbiddenToolLog){Move-Item -LiteralPath $Context.forbiddenToolLog -Destination (Join-Path $ReceiptRoot "$cell.before.forbidden-tool-calls.log")}
    $descriptor=Join-Path $ReceiptRoot "$cell.descriptor.json"
    @{cell=$cell;target=$Target;host='127.0.0.1';port=[int]$Context.port;username=$account.name;identityFile=$Context.identityFile;home=$account.home;forbiddenToolLog=$Context.forbiddenToolLog;receipt=(Join-Path $ReceiptRoot "$cell.json")} | ConvertTo-Json | Set-Content -LiteralPath $descriptor -Encoding utf8NoBOM
    $env:HIVEWARD_RUN_SSH_WINDOWS_HOST='1';$env:HIVEWARD_SSH_WINDOWS_HOST_CELL=$descriptor
    Write-Host "Windows host cell $cell ($Target, DefaultShell $shell, account $($account.name))"
    if($appCells.ContainsKey($cell)){
      $code=Invoke-AppCell $account $descriptor (Join-Path $ReceiptRoot "$cell.log") $appCells[$cell][0] $appCells[$cell][1]
    } else {
      if(-not $cell.StartsWith('hivewardd-')){throw "Unknown Windows host cell $cell"}
      $lane='src/main/managed-server/host-state/hivewardd-windows-host-lane.test.ts'
      & node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts $lane --reporter=verbose 2>&1 | Tee-Object -FilePath (Join-Path $ReceiptRoot "$cell.log")
      # Why global: under the workflow's GetNewClosure callback, bare $LASTEXITCODE reads a stale captured copy.
      $code=$global:LASTEXITCODE
    }
    # hivewardd.log holds only the last launch on Windows; hivewardd.log.1 is the one before a restart.
    foreach($log in @(Get-ChildItem -Path (Join-Path $account.home '.hiveward-remote\hivewardd-*\hivewardd.log'),(Join-Path $account.home '.hiveward-remote\hivewardd-*\hivewardd.log.1') -File -ErrorAction SilentlyContinue)){Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $ReceiptRoot "$cell.$($log.Directory.Name).$($log.Name)")}
    if(Test-Path -LiteralPath $Context.forbiddenToolLog){Copy-Item -LiteralPath $Context.forbiddenToolLog -Destination (Join-Path $ReceiptRoot "$cell.forbidden-tool-calls.log")}
    $summary.Add(@{cell=$cell;shell=$shell;account=$account.name;exitCode=$code})
    if($code -ne 0){$failed.Add($cell)}
  }
  # Host processes can outlive their client; wait so cleanup can unload the profiles.
  $homes=@($Context.accounts | ForEach-Object {$_.home.TrimEnd('\')+'\'})
  $graceDeadline=[DateTime]::UtcNow.AddSeconds(120)
  do {
    $hostProcesses=@(Get-CimInstance Win32_Process | Where-Object {$path=$_.ExecutablePath;$path -and @($homes | Where-Object {$path.StartsWith($_,[StringComparison]::OrdinalIgnoreCase)}).Count})
    if(-not $hostProcesses.Count){break};Start-Sleep -Seconds 2
  } while([DateTime]::UtcNow -lt $graceDeadline)
  $summary.Add(@{hostProcessesAfterGrace=@($hostProcesses | ForEach-Object {[IO.Path]::GetFileName($_.ExecutablePath)})})
} finally {
  Set-PrivateDefaultShell 'cmd'
  if($knownExisted){[IO.File]::WriteAllBytes($knownPath,$priorKnown)}else{Remove-Item -LiteralPath $knownPath -Force -ErrorAction SilentlyContinue}
  $env:HIVEWARD_BACKGROUND_LAUNCH=$priorBackground
  Remove-Item Env:HIVEWARD_RUN_SSH_WINDOWS_HOST,Env:HIVEWARD_SSH_WINDOWS_HOST_CELL -ErrorAction SilentlyContinue
  $summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ReceiptRoot 'summary.json') -Encoding utf8NoBOM
  Pop-Location
}
if($failed.Count){throw "Windows host cells failed: $($failed -join ', ')"}
