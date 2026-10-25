# FreeCode launcher for Windows PowerShell
# Creates a freecode.cmd shim in .\bin and gives you the exact PATH line to use.
param(
  [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 18+ is required. Install it first: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
  exit 1
}
$nodeVersion = (node --version).TrimStart('v')
if ([int]($nodeVersion.Split('.')[0]) -lt 18) {
  Write-Host "Node.js $nodeVersion is too old - FreeCode needs 18 or newer." -ForegroundColor Red
  exit 1
}

$binDir = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cmdPath = Join-Path $binDir 'freecode.cmd'
$cmdBody = @"
@echo off
node "%~dp0freecode.mjs" %*
"@
Set-Content -Path $cmdPath -Value $cmdBody -Encoding ASCII

# Also drop a PowerShell function file for profiles that prefer it.
$ps1Path = Join-Path $binDir 'freecode.ps1'
@""
#!/usr/bin/env pwsh
node "$root/bin/freecode.mjs" @args
"@ | Set-Content -Path $ps1Path -Encoding UTF8

Write-Host ""
Write-Host "FreeCode installed" -ForegroundColor Green
Write-Host "  launcher : $cmdPath"
Write-Host "  version  : $(node "$root/bin/freecode.mjs" --version)"

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
    Write-Host "  PATH     : added $binDir (open a NEW terminal to use 'freecode')" -ForegroundColor Green
  } else {
    Write-Host "  PATH     : $binDir already present"
  }
}

Write-Host ""
Write-Host "Try it:" -ForegroundColor Green
Write-Host "  freecode --help"
Write-Host "  freecode --agent kai"
Write-Host ""
