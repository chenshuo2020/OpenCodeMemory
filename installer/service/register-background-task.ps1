param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,

  [switch]$RestartRunning
)

$ErrorActionPreference = "Stop"
$taskName = "OpenCodeMemoryService"
$serviceHost = Join-Path $InstallRoot "runtime\OpenCodeMemoryServiceHost.exe"
$nodeExecutable = Join-Path $InstallRoot "runtime\node.exe"
$launcher = Join-Path $InstallRoot "service-wrapper\OpenCodeMemoryService.mjs"
$workingDirectory = Join-Path $InstallRoot "service"

if (-not (Test-Path -LiteralPath $serviceHost)) {
  throw "Windowless background service host not found: $serviceHost"
}
if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  throw "Bundled Node.js runtime not found: $nodeExecutable"
}
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Background service launcher not found: $launcher"
}
if (-not (Test-Path -LiteralPath $workingDirectory)) {
  throw "Background service directory not found: $workingDirectory"
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($RestartRunning) {
  try {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($existingTask.State -eq "Running") {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
      Start-Sleep -Milliseconds 500
    }
  } catch {
    # There may be no previous task on a first installation.
  }
}

$action = New-ScheduledTaskAction `
  -Execute $serviceHost `
  -WorkingDirectory $workingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
# The GUI-subsystem host starts node.exe with CREATE_NO_WINDOW, so the task can
# use the ordinary current-user token without showing a blank console window.
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

if ($RestartRunning) {
  Start-ScheduledTask -TaskName $taskName
}
