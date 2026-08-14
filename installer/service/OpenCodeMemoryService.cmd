@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "SERVICE_ROOT=%%~fI"
set "OPENCODE_MEM_HOST=127.0.0.1"
set "OPENCODE_MEM_PORT=4747"
set "OPENCODE_MEM_VERSION=__APP_VERSION__"
set "OPENCODE_MEM_MODEL_BUNDLE=%SERVICE_ROOT%\models"
set "OPENCODE_MEM_MODEL_CACHE=%SERVICE_ROOT%\models"
set "OPENCODE_MEM_REQUIRE_BUNDLED_MODEL=1"
set "OPENCODE_MEM_BUNDLED_MODEL=Xenova/nomic-embed-text-v1"
set "OPENCODE_MEM_BUNDLED_MODEL_DIMENSIONS=768"
set "OPENCODE_MEM_MODEL_REVISION=2f98ed5b9768f159d9cc55782f2e867abbc8d6ac"
set "OPENCODE_MEM_MODEL_DTYPE=q8"
set "NODE_PATH=%SERVICE_ROOT%\service\node_modules"

cd /d "%SERVICE_ROOT%\service"
"%SERVICE_ROOT%\runtime\node.exe" "%SERVICE_ROOT%\service\dist\standalone\service-main.js"
exit /b %ERRORLEVEL%
