@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if defined HIVEWARD_EXECUTABLE (
  "%HIVEWARD_EXECUTABLE%" "%~dp0..\server\hiwd.mjs" %*
) else (
  "%~dp0..\..\..\HiveWard.exe" "%~dp0..\server\hiwd.mjs" %*
)
exit /b %errorlevel%
