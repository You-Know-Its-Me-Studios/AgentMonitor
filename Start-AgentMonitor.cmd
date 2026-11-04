@echo off
setlocal
"%SystemRoot%\System32\wscript.exe" "%~dp0scripts\Launch-AgentMonitor.vbs" %*
exit /b %errorlevel%
