[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$logs = Join-Path $workspace '.agent-monitor\logs'
$serverLog = Join-Path $logs 'server.log'
$errorLog = Join-Path $logs 'error.log'
$startupLog = Join-Path $logs 'startup.log'
$instancePath = Join-Path $workspace '.agent-monitor\server-instance.json'
$mutex = $null
$ownsMutex = $false

function Write-StartupLog([string]$Text) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            Add-Content -LiteralPath $startupLog -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString('o'), $Text)
            return
        } catch [System.IO.IOException] {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds 30
        }
    }
}

function Get-MonitorHealth([string]$Address) {
    try {
        return Invoke-RestMethod -Uri "$Address/api/health" -Method Get -TimeoutSec 2
    } catch {
        return $null
    }
}

function Assert-MonitorIdentity($Health) {
    if ($null -eq $Health) { return $false }
    if ($Health.app -ne 'ykims-agent-monitor' -or
        -not [string]::Equals([string]$Health.workspace, $workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The configured localhost port belongs to another application or another Agent Monitor folder. Close that instance or choose a different port in agent-monitor.config.json.'
    }
    return ($Health.ready -eq $true)
}

try {
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $port = 4317
    $configPath = Join-Path $workspace 'agent-monitor.config.json'
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($null -ne $config.port) { $port = $config.port }
    }
    if ($env:AGENT_MONITOR_PORT) { $port = $env:AGENT_MONITOR_PORT }
    $parsedPort = 0
    if (-not [int]::TryParse([string]$port, [ref]$parsedPort) -or $parsedPort -lt 1024 -or $parsedPort -gt 65535) {
        throw 'The dashboard port must be an integer from 1024 to 65535.'
    }
    $port = $parsedPort
    $address = "http://127.0.0.1:$port"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($workspace.ToLowerInvariant()))).Replace('-', '').Substring(0, 32) }
    finally { $sha.Dispose() }
    $mutex = [System.Threading.Mutex]::new($false, "Local\YKIMS.AgentMonitor.$digest")
    try { $ownsMutex = $mutex.WaitOne(30000) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another launch is still starting Agent Monitor. Try the shortcut again in a moment.' }
    Write-StartupLog 'Launch requested'

    # A prior instance may still be healthy after an optional port setting was changed.
    # The record can select only a loopback port, and health must prove this exact app/folder.
    if (Test-Path -LiteralPath $instancePath) {
        $instancePort = 0
        try {
            $instance = Get-Content -LiteralPath $instancePath -Raw | ConvertFrom-Json
            if ([int]::TryParse([string]$instance.port, [ref]$instancePort) -and $instancePort -ge 1024 -and $instancePort -le 65535) {
                $priorAddress = "http://127.0.0.1:$instancePort"
                $prior = Get-MonitorHealth $priorAddress
                if ($null -ne $prior -and $prior.app -eq 'ykims-agent-monitor' -and $prior.ready -eq $true -and
                    [string]::Equals([string]$prior.workspace, $workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $port = $instancePort
                    $address = $priorAddress
                }
            }
        } catch {
            Write-StartupLog 'Prior instance record is unavailable; checking the configured port'
        }
    }
    $health = Get-MonitorHealth $address
    $ready = Assert-MonitorIdentity $health
    if (-not $ready) {
        $serverPath = Join-Path $workspace 'dist\server\main.js'
        $clientPath = Join-Path $workspace 'dist\client\index.html'
        if (-not (Test-Path -LiteralPath $serverPath) -or -not (Test-Path -LiteralPath $clientPath)) {
            throw "The production build is missing. Open this folder in a terminal and run npm install, then npm run build. Folder: $workspace"
        }
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
        if ($null -eq $nodeCommand) { throw 'Node.js LTS is required. Install Node.js 22.13 or a newer supported LTS release, then use this shortcut again.' }
        $nodePath = $nodeCommand.Source
        $version = (& $nodePath --version | Out-String).Trim()
        if ($version -notmatch '^v(\d+)\.(\d+)\.') { throw 'The installed Node.js version could not be determined.' }
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13) -or ($major % 2 -ne 0)) {
            throw "Node.js $version is unsupported. Use Node.js 22.13 or a newer supported LTS release."
        }
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $env:AGENT_MONITOR_WORKSPACE = $workspace
        $env:AGENT_MONITOR_PORT = [string]$port
        # The only command-line argument is a literal, quoted path. No shell evaluates workspace text.
        $serverArgument = '"' + $serverPath + '"'
        $server = Start-Process -FilePath $nodePath -ArgumentList $serverArgument -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $errorLog -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while ([DateTime]::UtcNow -lt $deadline) {
            $health = Get-MonitorHealth $address
            if (Assert-MonitorIdentity $health) { $ready = $true; break }
            if ($server.HasExited) { throw "Agent Monitor exited during startup. See $errorLog and $serverLog" }
            Start-Sleep -Milliseconds 300
        }
        if (-not $ready) {
            if (-not $server.HasExited) { $server.Kill() }
            throw "Agent Monitor did not become ready within 30 seconds. See $errorLog and $serverLog"
        }
    }
    @{ port = $port; workspace = $workspace } | ConvertTo-Json -Compress | Set-Content -LiteralPath $instancePath -Encoding UTF8
    if (-not $NoBrowser) { Start-Process -FilePath $address | Out-Null }
    Write-StartupLog "Ready at $address"
    Write-Output "Agent Monitor is running at $address"
} catch {
    $message = $_.Exception.Message
    $message = $message -replace '(?i)sk-[a-z0-9_-]{16,}', '[redacted]'
    try { Write-StartupLog "ERROR $message" }
    catch { Write-Warning 'The startup log could not be written. Check write access to this application folder.' }
    $message = "$message`r`n`r`nStartup log: $startupLog`r`nServer logs: $serverLog and $errorLog"
    if (-not $NonInteractive) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $null = $shell.Popup($message, 0, 'Agent Monitor could not start', 16)
        } catch { Write-Warning 'The startup message could not be displayed.' }
    }
    Write-Error -Message $message -ErrorAction Continue
    exit 1
} finally {
    if ($ownsMutex -and $null -ne $mutex) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
