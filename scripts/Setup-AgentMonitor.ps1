[CmdletBinding()]
param([string]$LogPath, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDirectory = Join-Path $workspace '.agent-monitor'
if (-not $LogPath) { $LogPath = Join-Path $runtimeDirectory 'logs\setup.log' }
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null

function Write-SetupLog([string]$Text) { Add-Content -LiteralPath $LogPath -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('o'), $Text) }
function Assert-MinimumVersion([string]$Actual, [string]$Range, [string]$Name) {
    if ($Range -notmatch '^>=(\d+)\.(\d+)\.(\d+)$') { throw "Unsupported $Name engine declaration '$Range'. Update the setup script to match package.json." }
    $minimum = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    if ($Actual -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { throw "$Name version could not be determined." }
    $installed = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
    if ($installed -lt $minimum) { throw "$Name $installed is unsupported. This project requires $Name $Range. Install a current supported Node.js LTS release with npm from https://nodejs.org/, then launch again." }
}
function Invoke-SetupCommand([string[]]$Arguments, [string]$Phase) {
    Write-SetupLog $Phase
    # Direct Node execution preserves spaces and avoids npm.cmd/PowerShell shim policy issues.
    # Windows PowerShell must not turn harmless native stderr warnings into failures.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $nodePath @Arguments >> $LogPath 2>&1
        $commandExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($commandExit -ne 0) { throw "$Phase failed (exit $commandExit). See $LogPath" }
}
function Get-SetupState {
    $json = & $nodePath $stateHelper 'inspect' $workspace 2>> $LogPath
    if ($LASTEXITCODE -ne 0) { throw "The source download is incomplete or build state could not be read. Re-extract/download the complete repository. See $LogPath" }
    return ($json | ConvertFrom-Json)
}

try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) { throw 'Node.js and npm are required. Install a supported Node.js LTS release from https://nodejs.org/ with npm, close and reopen your terminal, then launch Start-AgentMonitor.cmd again.' }
    $nodePath = $nodeCommand.Source
    $package = Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json
    $nodeVersion = (& $nodePath '--version' 2>> $LogPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Node.js could not run. Repair or reinstall a supported Node.js LTS release. See $LogPath" }
    Assert-MinimumVersion $nodeVersion ([string]$package.engines.node) 'Node.js'
    $npmCandidates = @((Join-Path (Split-Path -Parent $nodePath) 'node_modules\npm\bin\npm-cli.js'))
    foreach ($commandName in @('npm.cmd', 'npm')) {
        $npmCommand = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($npmCommand) {
            $npmDirectory = Split-Path -Parent $npmCommand.Source
            $npmCandidates += Join-Path $npmDirectory 'node_modules\npm\bin\npm-cli.js'
            $npmCandidates += Join-Path $npmDirectory '..\lib\node_modules\npm\bin\npm-cli.js'
        }
    }
    $npmCli = $npmCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $npmCli) { throw 'npm is missing from this Node.js installation. Reinstall a supported Node.js LTS release with its npm component enabled, then launch again.' }
    $npmVersion = (& $nodePath $npmCli '--version' 2>> $LogPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "npm could not run. Repair or reinstall Node.js with its npm component. See $LogPath" }
    Assert-MinimumVersion $npmVersion ([string]$package.engines.npm) 'npm'
    $stateHelper = Join-Path $workspace 'scripts\build-state.mjs'
    Push-Location -LiteralPath $workspace
    try {
        $state = Get-SetupState
        $installed = $false
        if (-not $state.dependenciesCurrent) {
            Invoke-SetupCommand @($npmCli, 'ci', '--include=dev', '--no-audit', '--no-fund') 'Installing locked dependencies with npm ci'
            Invoke-SetupCommand @($stateHelper, 'record-dependencies', $workspace) 'Recording completed dependency installation'
            $installed = $true
        }
        if ($installed -or -not $state.buildCurrent) {
            Invoke-SetupCommand @($npmCli, 'run', 'build') 'Building the production dashboard'
            $state = Get-SetupState
            if (-not $state.buildCurrent) { throw "The production build did not produce a matching build manifest. See $LogPath" }
        }
        if (-not $NoShortcut -and -not (Test-Path -LiteralPath (Join-Path $runtimeDirectory 'shortcut-installed.json'))) {
            try {
                & (Join-Path $workspace 'scripts\Install-DesktopShortcut.ps1') >> $LogPath 2>&1
                @{ installedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $runtimeDirectory 'shortcut-installed.json') -Encoding UTF8
            } catch { Write-SetupLog 'Desktop shortcut creation was unavailable. Use Start-AgentMonitor.cmd, or run scripts\Install-DesktopShortcut.ps1 manually.' }
        }
    } finally { Pop-Location }
    return @{ NodePath = $nodePath; NpmCli = $npmCli; LogPath = $LogPath }
} catch {
    $message = $_.Exception.Message
    Write-SetupLog "ERROR $message"
    throw "$message`r`nSetup log: $LogPath"
}
