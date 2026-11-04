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
$processRecordPath = Join-Path $workspace '.agent-monitor\server-process.json'
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

function Get-LoopbackListenerProcessId([int]$Port) {
    $owners = @()
    try {
        $owners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
        $rows = @(& $netstat -ano -p tcp 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'The loopback listener owner could not be inspected without administrator access.' }
        $owners = @($rows | ForEach-Object {
            $parts = $_.Trim() -split '\s+'
            if ($parts.Length -ge 5 -and $parts[0] -eq 'TCP' -and $parts[1] -eq "127.0.0.1:$Port" -and $parts[3] -eq 'LISTENING' -and $parts[4] -match '^\d+$') { [int]$parts[4] }
        } | Select-Object -Unique)
    }
    if ($owners.Count -ne 1 -or [int]$owners[0] -lt 1) { throw 'The stale dashboard loopback listener has no unique verifiable process owner.' }
    return [int]$owners[0]
}

function Get-VerifiedLegacyProcess([int]$ProcessId, [string]$ServerPath) {
    try { $native = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop }
    catch { throw 'The legacy dashboard cannot be safely identified because Windows process command-line information is unavailable. Close that old dashboard process manually, then launch again. No process was terminated.' }
    if ($null -eq $native -or [int]$native.ProcessId -ne $ProcessId -or [string]$native.Name -ne 'node.exe' -or -not $native.ExecutablePath -or -not $native.CommandLine -or -not $native.CreationDate) {
        throw 'The legacy listener is not a verifiable Node.js dashboard process. No process was terminated.'
    }
    $executable = [string]$native.ExecutablePath
    if ([IO.Path]::GetFileName($executable) -ne 'node.exe' -or -not (Test-Path -LiteralPath $executable)) { throw 'The legacy listener executable is not a verified Node.js installation. No process was terminated.' }
    $versionInfo = (Get-Item -LiteralPath $executable).VersionInfo
    if ($versionInfo.ProductName -ne 'Node.js' -or $versionInfo.OriginalFilename -ne 'node.exe') { throw 'The legacy listener executable is not Node.js. No process was terminated.' }
    $exePattern = [Regex]::Escape($executable)
    $scriptPattern = [Regex]::Escape($ServerPath)
    $exeArgument = '"' + $exePattern + '"'
    if ($executable -notmatch '\s') { $exeArgument = '(?:' + $exeArgument + '|' + $exePattern + ')' }
    $scriptArgument = '"' + $scriptPattern + '"'
    if ($ServerPath -notmatch '\s') { $scriptArgument = '(?:' + $scriptArgument + '|' + $scriptPattern + ')' }
    $exactCommand = '^\s*' + $exeArgument + '\s+' + $scriptArgument + '\s*$'
    if (-not [Regex]::IsMatch([string]$native.CommandLine, $exactCommand, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        throw 'The legacy listener does not run this exact dashboard server command. No process was terminated.'
    }
    try {
        $created = ([DateTime]$native.CreationDate).ToUniversalTime().Ticks
        $handle = Get-Process -Id $ProcessId -ErrorAction Stop
        $started = $handle.StartTime.ToUniversalTime().Ticks
    } catch { throw 'The legacy dashboard process creation identity could not be verified. No process was terminated.' }
    if ([Math]::Abs($created - $started) -gt [TimeSpan]::TicksPerMillisecond * 10) { throw 'The legacy listener process identity changed. No process was terminated.' }
    return @{ ProcessId = $ProcessId; Created = $created; Started = $started; Executable = $executable; CommandLine = [string]$native.CommandLine; Handle = $handle }
}

function Stop-StaleMonitor($Health, [string]$Address, [int]$Port, [string]$ServerPath) {
    $record = $null
    if (Test-Path -LiteralPath $processRecordPath) {
        try { $record = Get-Content -LiteralPath $processRecordPath -Raw | ConvertFrom-Json }
        catch { throw 'The running dashboard process record is unreadable. The old instance was not stopped.' }
    }
    if ($Health.buildId -or $Health.instanceId -or $Health.pid) {
        if ($null -eq $record -or $record.app -ne 'ykims-agent-monitor' -or
            -not [string]::Equals([string]$record.workspace, $workspace, [StringComparison]::OrdinalIgnoreCase) -or
            [int]$record.port -ne $Port -or [int]$record.pid -ne [int]$Health.pid -or
            -not $Health.instanceId -or [string]$record.instanceId -cne [string]$Health.instanceId -or
            -not $Health.startedAt -or [string]$record.startedAt -cne [string]$Health.startedAt -or
            [string]$record.buildId -cne [string]$Health.buildId -or
            [string]$record.launcherKey -notmatch '^[A-Za-z0-9_+/=-]{32,512}$') {
            throw 'The stale dashboard could not be matched to its private process record. It was not stopped or reused. Close that dashboard instance and launch again.'
        }
        $fresh = Get-MonitorHealth $Address
        if (-not (Assert-MonitorIdentity $fresh) -or [string]$fresh.instanceId -cne [string]$record.instanceId -or [int]$fresh.pid -ne [int]$record.pid) { throw 'The running dashboard changed during restart verification. Launch again; no process was terminated.' }
        Write-StartupLog 'Stopping the verified older dashboard build through its private lifecycle endpoint'
        try { $null = Invoke-RestMethod -Uri "$Address/api/internal/stop" -Method Post -Headers @{ 'X-Agent-Monitor-Launcher-Key' = [string]$record.launcherKey } -ContentType 'application/json' -Body (@{ instanceId = [string]$record.instanceId } | ConvertTo-Json -Compress) -TimeoutSec 5 }
        catch { throw 'The verified older dashboard rejected its private restart request. Close that dashboard instance and launch again.' }
    } else {
        if ($null -ne $record) { throw 'Legacy health does not match the existing process record. The listener was not stopped.' }
        $listener = Get-LoopbackListenerProcessId $Port
        $first = Get-VerifiedLegacyProcess $listener $ServerPath
        $fresh = Get-MonitorHealth $Address
        if (-not (Assert-MonitorIdentity $fresh) -or $fresh.buildId -or $fresh.instanceId -or $fresh.pid -or (Get-LoopbackListenerProcessId $Port) -ne $listener) { throw 'The legacy dashboard listener changed during verification. No process was terminated.' }
        $second = Get-VerifiedLegacyProcess $listener $ServerPath
        if ($first.Created -ne $second.Created -or $first.Started -ne $second.Started -or $first.Executable -cne $second.Executable -or $first.CommandLine -cne $second.CommandLine) { throw 'The legacy dashboard process identity changed. No process was terminated.' }
        Write-StartupLog 'Stopping the verified legacy Node.js dashboard process for this exact folder'
        # The retained process handle and creation identity refer only to this verified dashboard.
        $second.Handle.Kill()
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
        $remaining = Get-MonitorHealth $Address
        if ($null -eq $remaining) { return }
        if (-not (Assert-MonitorIdentity $remaining)) { throw 'The localhost listener changed while stopping the old dashboard.' }
        if ($Health.instanceId -and [string]$remaining.instanceId -cne [string]$Health.instanceId) { throw 'A different dashboard instance appeared during restart. Launch again to verify it.' }
        Start-Sleep -Milliseconds 200
    }
    throw 'The old dashboard did not stop within 15 seconds. The new build was not started.'
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

    $serverPath = Join-Path $workspace 'dist\server\main.js'
    $clientPath = Join-Path $workspace 'dist\client\index.html'
    $buildPath = Join-Path $workspace 'dist\build.json'
    if (-not (Test-Path -LiteralPath $serverPath) -or -not (Test-Path -LiteralPath $clientPath) -or -not (Test-Path -LiteralPath $buildPath)) {
        throw "The production build is missing or predates build identity support. Open this folder in a terminal and run npm install, then npm run build. Folder: $workspace"
    }
    $build = Get-Content -LiteralPath $buildPath -Raw | ConvertFrom-Json
    if ([string]$build.id -notmatch '^[a-f0-9]{64}$') { throw 'The production build identity is invalid. Run npm run build before launching.' }
    $desiredBuildId = [string]$build.id

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
    if ($ready -and [string]$health.buildId -cne $desiredBuildId) {
        Write-StartupLog 'A previous dashboard build is running; verifying a safe replacement'
        Stop-StaleMonitor $health $address $port $serverPath
        $ready = $false
    }
    if (-not $ready) {
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
            if (Assert-MonitorIdentity $health) {
                if ([string]$health.buildId -cne $desiredBuildId) { throw 'The localhost server is still serving a different build. It was not accepted as ready.' }
                $ready = $true; break
            }
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
