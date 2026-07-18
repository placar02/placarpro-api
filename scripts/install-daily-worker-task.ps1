param(
  [string]$TaskName = 'PlacarPro Daily Publisher',
  [string]$RunAt = '06:00'
)

$ErrorActionPreference = 'Stop'
$workerScript = Join-Path $PSScriptRoot 'run-daily-worker.ps1'
if (-not (Test-Path $workerScript)) { throw "Worker nao encontrado: $workerScript" }

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$workerScript`""
$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Publica as analises diarias do PlacarPro no PostgreSQL.' `
  -Force

Write-Host "Tarefa '$TaskName' instalada para executar diariamente as $RunAt."
