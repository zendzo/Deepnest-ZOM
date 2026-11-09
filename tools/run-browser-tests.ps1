# Browser smoke/end-to-end tests.
# Starts tools/browser-server.js, drives headless Edge, and reports PASS/FAIL.
#
#   powershell -ExecutionPolicy Bypass -File tools/run-browser-tests.ps1
#
# Set BROWSER_TEST_EDGE to override the Edge executable path.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$port = Get-Random -Minimum 8100 -Maximum 8999
$base = "http://127.0.0.1:$port"

$edgeCandidates = @(
    $env:BROWSER_TEST_EDGE,
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$edgeCandidates = @($edgeCandidates)
if ($edgeCandidates.Count -eq 0) {
    Write-Error 'Edge or Chrome was not found. Set BROWSER_TEST_EDGE to the executable path.'
}

$edge = $edgeCandidates | Select-Object -First 1
$server = $null
$serverOut = Join-Path $env:TEMP 'deepnest-browser-server.out'
$serverErr = Join-Path $env:TEMP 'deepnest-browser-server.err'
$results = @()

try {
    $server = Start-Process -FilePath 'node' -ArgumentList @(
        'tools/browser-server.js',
        '--port', "$port"
    ) -WorkingDirectory $repo -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr

    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        try {
            $response = Invoke-WebRequest -Uri "$base/health" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {
            # server still starting
        }
    }
    if (-not $ready) {
        throw "Browser server did not start. See $serverErr"
    }

    $tests = @(
        @{ Name = 'smoke';   Url = "$base/tools/browser-smoke.html";       Marker = 'data-smoke="PASS"' },
        @{ Name = 'dxf';     Url = "$base/tools/browser-e2e.html?noworker=1";     Marker = 'data-e2e="PASS"' },
        @{ Name = 'nc1';     Url = "$base/tools/browser-e2e-nc1.html?noworker=1"; Marker = 'data-e2e="PASS"' },
        @{ Name = 'batch';   Url = "$base/tools/browser-e2e-batch.html?noworker=1"; Marker = 'data-e2e="PASS"' },
        @{ Name = 'large';   Url = "$base/tools/browser-e2e-large.html?noworker=1"; Marker = 'data-e2e="PASS"' }
    )

    foreach ($test in $tests) {
        $profile = Join-Path $env:TEMP ("deepnest-edge-" + [guid]::NewGuid().ToString('N'))
        $out = Join-Path $env:TEMP ("deepnest-browser-" + $test.Name + ".html")
        $err = Join-Path $env:TEMP ("deepnest-browser-" + $test.Name + ".err")
        Remove-Item $out, $err -ErrorAction SilentlyContinue

        $arguments = @(
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--no-first-run',
            '--disable-extensions',
            '--disable-background-networking',
            "--user-data-dir=$profile",
            '--virtual-time-budget=300000',
            '--dump-dom',
            $test.Url
        )

        $process = Start-Process -FilePath $edge -ArgumentList $arguments -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $out -RedirectStandardError $err

        $content = if (Test-Path $out) { Get-Content $out -Raw } else { '' }
        $passed = $content -match [regex]::Escape($test.Marker)
        $results += [pscustomobject]@{
            Test = $test.Name
            Passed = $passed
            Output = $out
        }

        Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
    }
}
finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
}

$failed = $results | Where-Object { -not $_.Passed }
$results | ForEach-Object {
    if ($_.Passed) {
        Write-Host "PASS $($_.Test)"
    } else {
        Write-Host "FAIL $($_.Test) (DOM: $($_.Output))"
    }
}

if ($failed) {
    exit 1
}
Write-Host 'All browser tests passed.'
