@echo off
setlocal
set "ASSISTANT_ROOT=%~dp0"
node "%ASSISTANT_ROOT%runtime\cli.mjs" %*
exit /b %ERRORLEVEL%
