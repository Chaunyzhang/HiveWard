@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\HiveWard.exe" "%~dp0..\hiveward\server\hiwd.mjs" %*
exit /b %errorlevel%
