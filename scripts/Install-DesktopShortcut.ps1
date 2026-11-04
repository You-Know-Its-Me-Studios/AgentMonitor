[CmdletBinding()]
param([string]$DestinationDirectory)
$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$desktop = if ($DestinationDirectory) { [System.IO.Path]::GetFullPath($DestinationDirectory) } else { [Environment]::GetFolderPath('DesktopDirectory') }
if (-not $desktop) { throw 'The current user Desktop folder could not be resolved.' }
$launcher = Join-Path $workspace 'scripts\Launch-AgentMonitor.vbs'
if (-not (Test-Path -LiteralPath $launcher)) { throw "The launcher is missing: $launcher" }
$shell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $desktop 'Agent Monitor.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $workspace
$shortcut.WindowStyle = 7
$shortcut.Description = 'Open the local Agent Monitor dashboard'
$iconPath = Join-Path $workspace 'scripts\agent-monitor.ico'
if (Test-Path -LiteralPath $iconPath) { $shortcut.IconLocation = "$iconPath,0" }
try { $shortcut.Save() }
catch { throw "Windows denied writing the shortcut to $shortcutPath. Run this installer as the current user in a normal PowerShell window; administrator rights are not required. $($_.Exception.Message)" }
Write-Output "Created $shortcutPath"
