[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$serviceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$serviceDirectory = Join-Path $serviceRoot "service"
$nodeExecutable = Join-Path $serviceRoot "runtime\node.exe"
$entryPoint = Join-Path $serviceDirectory "dist\standalone\service-main.js"

if (-not (Test-Path -LiteralPath $nodeExecutable)) {
  throw "Bundled Node.js runtime not found: $nodeExecutable"
}

if (-not (Test-Path -LiteralPath $entryPoint)) {
  throw "Standalone service entry point not found: $entryPoint"
}

$env:OPENCODE_MEM_HOST = "127.0.0.1"
$env:OPENCODE_MEM_PORT = "4747"
$env:OPENCODE_MEM_VERSION = "__APP_VERSION__"
$env:OPENCODE_MEM_MODEL_BUNDLE = Join-Path $serviceRoot "models"
$env:OPENCODE_MEM_MODEL_CACHE = $env:OPENCODE_MEM_MODEL_BUNDLE
$env:OPENCODE_MEM_REQUIRE_BUNDLED_MODEL = "1"
$env:OPENCODE_MEM_BUNDLED_MODEL = "Xenova/nomic-embed-text-v1"
$env:OPENCODE_MEM_BUNDLED_MODEL_DIMENSIONS = "768"
$env:OPENCODE_MEM_MODEL_REVISION = "2f98ed5b9768f159d9cc55782f2e867abbc8d6ac"
$env:OPENCODE_MEM_MODEL_DTYPE = "q8"
$env:NODE_PATH = Join-Path $serviceDirectory "node_modules"

$process = Start-Process `
  -FilePath $nodeExecutable `
  -ArgumentList ('"{0}"' -f $entryPoint) `
  -WorkingDirectory $serviceDirectory `
  -WindowStyle Hidden `
  -PassThru

$process.WaitForExit()
exit $process.ExitCode
