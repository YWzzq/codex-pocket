param(
  [ValidateSet("install", "start", "stop", "uninstall", "status")]
  [string]$Action = "install"
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptRoot
$taskName = "Codex Pocket"
$startScript = Join-Path $projectRoot "start-windows.ps1"

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "找不到 $startScript。"
}

function Invoke-Schtasks([string[]]$arguments) {
  & schtasks.exe @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "schtasks 执行失败（退出码 $LASTEXITCODE）。"
  }
}

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -Background"

switch ($Action) {
  "install" {
    Invoke-Schtasks @("/Create", "/TN", $taskName, "/SC", "ONLOGON", "/TR", $taskCommand, "/RL", "LIMITED", "/F")
    Write-Host "已创建 Windows 登录启动任务：$taskName"
  }
  "start" {
    Invoke-Schtasks @("/Run", "/TN", $taskName)
    Write-Host "已请求启动：$taskName"
  }
  "stop" {
    Invoke-Schtasks @("/End", "/TN", $taskName)
    Write-Host "已停止：$taskName"
  }
  "uninstall" {
    Invoke-Schtasks @("/Delete", "/TN", $taskName, "/F")
    Write-Host "已删除：$taskName"
  }
  "status" {
    Invoke-Schtasks @("/Query", "/TN", $taskName, "/FO", "LIST")
  }
}
