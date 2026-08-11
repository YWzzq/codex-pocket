param([switch]$Background)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptRoot

function Import-DotEnv([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }

  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }

    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
      $value = $value -replace '\\([\\"$`])', '$1'
    } elseif ($value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Require-Command([string]$name, [string]$hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name 未找到。$hint"
  }
}

Import-DotEnv (Join-Path $scriptRoot ".env")

Require-Command "node" "请先安装 Node.js 22 或更高版本，并重新打开 PowerShell。"
Require-Command "npm" "请确认 Node.js 安装时已包含 npm。"

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)' -or [int]$Matches[1] -lt 22) {
  throw "Node.js 版本必须是 22 或更高版本，当前为 $nodeVersion。"
}

$codexCommand = if ($env:CODEX_BIN) { $env:CODEX_BIN } else { "codex" }
if ($codexCommand -match '(?i)\b(app-server|daemon)\b') {
  throw "CODEX_BIN 只能填写 Codex 可执行文件，例如 codex.cmd 或 C:\\path\\to\\codex.exe；不要填写 app-server/daemon 参数。"
}
if (-not (Get-Command $codexCommand -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $codexCommand)) {
  throw "Codex 未找到。请先安装并登录 Windows 版 Codex，或在 .env 中设置 CODEX_BIN=C:\\path\\to\\codex.exe。"
}

if (-not (Test-Path -LiteralPath (Join-Path $scriptRoot "node_modules"))) {
  Write-Host "首次运行，正在安装依赖..." -ForegroundColor Yellow
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败。" }
}

if (-not $env:CODEX_POCKET_ROOTS) {
  Write-Host "未设置 CODEX_POCKET_ROOTS，将使用当前项目目录：$scriptRoot" -ForegroundColor Yellow
}

$port = if ($env:PORT) { $env:PORT } else { "8787" }
$localUrl = "http://127.0.0.1:$port"
$publicUrl = if ($env:PUBLIC_URL) { $env:PUBLIC_URL } else { $localUrl }
Write-Host "Codex Pocket Windows 启动中..." -ForegroundColor Green
Write-Host "本机地址：$localUrl"
Write-Host "手机访问地址：$publicUrl"
Write-Host "按 Ctrl+C 停止服务。" -ForegroundColor DarkGray

if ($Background) {
  & npm start
} else {
  & npm run dev
}
exit $LASTEXITCODE
