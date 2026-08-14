[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,

  [switch]$StopOnly,

  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$taskName = "OpenCodeMemoryService"
$expectedDirectoryName = "OpenCode Memory"
$markerFileName = ".opencode-memory-install-root"
$markerValue = "OpenCodeMemory.InstallRoot.v1"

function Get-NormalizedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return [System.IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
  ).TrimEnd([char[]]@('\', '/'))
}

function Assert-ManagedInstallRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $normalized = Get-NormalizedPath -Path $Path
  $root = [System.IO.Path]::GetPathRoot($normalized).TrimEnd([char[]]@('\', '/'))
  if ([string]::IsNullOrWhiteSpace($normalized) -or $normalized -eq $root) {
    throw "Refusing to operate on a drive root."
  }
  if (-not [System.IO.Path]::GetFileName($normalized).Equals(
    $expectedDirectoryName,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "The install directory name is not '$expectedDirectoryName': $normalized"
  }

  $directory = Get-Item -LiteralPath $normalized -Force
  if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The install directory must not be a junction or symbolic link: $normalized"
  }

  $requiredFiles = @(
    (Join-Path $normalized "OpenCode Memory.exe"),
    (Join-Path $normalized "Uninstall OpenCode Memory.exe"),
    (Join-Path $normalized $markerFileName)
  )
  foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "Required installation identity file is missing: $requiredFile"
    }
  }

  $actualMarker = (Get-Content -Raw -LiteralPath (Join-Path $normalized $markerFileName)).Trim()
  if ($actualMarker -cne $markerValue) {
    throw "The installation identity marker is invalid."
  }

  $pendingDirectories = [System.Collections.Generic.Stack[string]]::new()
  $pendingDirectories.Push($normalized)
  while ($pendingDirectories.Count -gt 0) {
    $directoryPath = $pendingDirectories.Pop()
    foreach ($entryPath in [System.IO.Directory]::EnumerateFileSystemEntries($directoryPath)) {
      $attributes = [System.IO.File]::GetAttributes($entryPath)
      if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The installation contains a junction or symbolic link and cannot be removed safely: $entryPath"
      }
      if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
        $pendingDirectories.Push($entryPath)
      }
    }
  }

  return $normalized
}

function Assert-ManagedTask {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Task,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedExecutable
  )

  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) {
    throw "The '$taskName' task has an unexpected number of actions."
  }

  $actualExecutable = Get-NormalizedPath -Path ([string]$actions[0].Execute)
  if (-not $actualExecutable.Equals($ExpectedExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The '$taskName' task is not owned by this installation: $actualExecutable"
  }
}

function Stop-ManagedProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$ExecutablePaths
  )

  $expected = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($path in $ExecutablePaths) {
    [void]$expected.Add((Get-NormalizedPath -Path $path))
  }

  $matches = @(
    Get-CimInstance -ClassName Win32_Process | Where-Object {
      $candidate = [string]$_.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $false
      }
      try {
        return $expected.Contains((Get-NormalizedPath -Path $candidate))
      } catch {
        return $false
      }
    }
  )

  foreach ($process in $matches) {
    Stop-Process -Id $process.ProcessId -Force
  }

  if ($matches.Count -gt 0) {
    Start-Sleep -Milliseconds 600
  }

  $remaining = @(
    Get-CimInstance -ClassName Win32_Process | Where-Object {
      $candidate = [string]$_.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($candidate)) {
        return $false
      }
      try {
        return $expected.Contains((Get-NormalizedPath -Path $candidate))
      } catch {
        return $false
      }
    }
  )
  if ($remaining.Count -gt 0) {
    throw "One or more managed OpenCode Memory processes could not be stopped."
  }
}

try {
  $installRoot = Assert-ManagedInstallRoot -Path $InstallDir
  if ($ValidateOnly) {
    exit 0
  }

  $serviceHost = Get-NormalizedPath -Path (Join-Path $installRoot "resources\runtime\OpenCodeMemoryServiceHost.exe")
  $nodeExecutable = Get-NormalizedPath -Path (Join-Path $installRoot "resources\runtime\node.exe")
  $desktopExecutable = Get-NormalizedPath -Path (Join-Path $installRoot "OpenCode Memory.exe")

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Assert-ManagedTask -Task $task -ExpectedExecutable $serviceHost
    if ($task.State -eq "Running") {
      Stop-ScheduledTask -TaskName $taskName
      Start-Sleep -Milliseconds 500
    }
  }

  Stop-ManagedProcesses -ExecutablePaths @($serviceHost, $nodeExecutable, $desktopExecutable)

  if ($StopOnly) {
    exit 0
  }

  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }

  $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  if ([string]::IsNullOrWhiteSpace($userProfile)) {
    throw "The current user profile directory could not be resolved."
  }

  $pluginPath = Join-Path $userProfile ".config\opencode\plugins\opencode-mem.js"
  if (Test-Path -LiteralPath $pluginPath -PathType Leaf) {
    $content = Get-Content -LiteralPath $pluginPath -Raw
    $packagedPluginPath = Join-Path $installRoot "resources\plugin\opencode-mem.js"
    if (
      (Test-Path -LiteralPath $packagedPluginPath -PathType Leaf) -and
      $content.StartsWith("// Managed by OpenCode Memory desktop app.") -and
      (Get-FileHash -Algorithm SHA256 -LiteralPath $pluginPath).Hash -ceq
        (Get-FileHash -Algorithm SHA256 -LiteralPath $packagedPluginPath).Hash
    ) {
      Remove-Item -LiteralPath $pluginPath -Force
    }
  }

  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw "The current user's LocalAppData directory could not be resolved."
  }
  $connectionDirectory = Join-Path $localAppData "OpenCodeMemory"
  $connectionPath = Join-Path $connectionDirectory "connection.json"
  if (Test-Path -LiteralPath $connectionPath -PathType Leaf) {
    $removeConnection = $false
    try {
      $connection = Get-Content -Raw -LiteralPath $connectionPath | ConvertFrom-Json
      $removeConnection =
        $connection.managedBy -ceq "OpenCodeMemoryDesktop" -or
        (
          $connection.schemaVersion -eq 1 -and
          $connection.baseUrl -ceq "http://127.0.0.1:4747" -and
          [string]$connection.tokenFile -like "*\.opencode-mem\.auth-token"
        )
    } catch {
      $removeConnection = $false
    }
    if ($removeConnection) {
      Remove-Item -LiteralPath $connectionPath -Force
    }
  }
  if (
    (Test-Path -LiteralPath $connectionDirectory -PathType Container) -and
    -not (Get-ChildItem -LiteralPath $connectionDirectory -Force | Select-Object -First 1)
  ) {
    Remove-Item -LiteralPath $connectionDirectory -Force
  }

  exit 0
} catch {
  [Console]::Error.WriteLine("OpenCode Memory uninstall safety check failed: $($_.Exception.Message)")
  exit 1
}
