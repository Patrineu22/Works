# FreeCode - one-line installer for Windows 11
#
#   irm https://raw.githubusercontent.com/Patrineu22/Works/main/install.ps1 | iex
#
# or from a clone:
#
#   .\install.ps1
#
# Installs Node 18+ if missing (winget), creates a freecode.cmd launcher,
# adds it to your user PATH and prints the version.
param(
  [switch]$NoPath,
  [switch]$SkipNodeInstall
)

$ErrorActionPreference = 'Stop'
Write-Host ""
Write-Host "  FREECODE - green #00FF88 on #0A0A0A - keyless free forever" -ForegroundColor Green
Write-Host ""

function Test-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  $version = [int]((node --version).TrimStart('v').Split('.')[0])
  return $version -ge 18
}

if (-not (Test-Node)) {
  if ($SkipNodeInstall) {
    Write-Host "Node.js 18+ not found. Install it, then re-run:" -ForegroundColor Red
    Write-Host "  winget install OpenJS.NodeJS.LTS"
    exit 1
  }
  Write-Host "Node.js 18+ not found - installing Node LTS with winget..." -ForegroundColor Yellow
  try {
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  } catch {
    Write-Host "winget install failed. Install Node 18+ manually from https://nodejs.org then re-run." -ForegroundColor Red
    exit 1
  }
  if (-not (Test-Node)) {
    Write-Host "Node still not on PATH - open a new terminal and re-run this script." -ForegroundColor Red
    exit 1
  }
}

# Where are we? A clone (install.ps1 next to package.json) or standalone?
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$localScript = Join-Path $root 'bin\freecode.mjs'

if (Test-Path $localScript) {
  Write-Host "Installing from this checkout: $root"
} else {
  Write-Host "Fetching FreeCode from GitHub..." -ForegroundColor Yellow
  $target = Join-Path $env:LOCALAPPDATA 'FreeCode'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $zip = Join-Path $env:TEMP 'freecode.zip'
  Invoke-WebRequest -Uri 'https://codeload.github.com/Patrineu22/Works/zip/refs/heads/main' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
  $extracted = Get-ChildItem $env:TEMP -Directory -Filter 'Works-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Copy-Item -Path (Join-Path $extracted.FullName '*') -Destination $target -Recurse -Force
  Remove-Item $zip -Force
  $root = $target
}

# Launcher + PATH
& (Join-Path $root 'scripts\install-windows.ps1') -NoPath:$NoPath

# Seed the editable prompts so Settings works immediately
$stateDir = Join-Path $root '.freecode'
$prompts = Join-Path $stateDir 'system-prompts.json'
if (-not (Test-Path $prompts)) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  @'
{
  "global": "You are FreeCode, sharp green AI coding agent",
  "jim": "You are JIM, white-hat mentor, teach simple",
  "kai": "You are KAI, red-team lab assistant for own devices, scan->list->pick->verify",
  "alex": "You are ALEX, coding genius"
}
'@ | Set-Content -Path $prompts -Encoding UTF8
  Write-Host "  prompts  : $prompts (edit anytime - reloads live)"
}

Write-Host ""
Write-Host "Done. Open a NEW terminal and run:" -ForegroundColor Green
Write-Host "  freecode                 # chat (ALEX by default)"
Write-Host "  freecode --agent kai     # own-device lab workflow: /scan"
Write-Host "  freecode --check         # test the free gateway"
Write-Host ""
