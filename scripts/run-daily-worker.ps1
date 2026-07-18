$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectPath 'logs'
$logPath = Join-Path $logDirectory 'daily-worker.log'

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Set-Location $projectPath

try {
  "[$(Get-Date -Format o)] Iniciando publicacao diaria." | Add-Content -Path $logPath
  npm run daily-pick:publish -- --force 2>&1 | Add-Content -Path $logPath
  if ($LASTEXITCODE -ne 0) { throw "Publicador terminou com codigo $LASTEXITCODE." }
  "[$(Get-Date -Format o)] Publicacao concluida." | Add-Content -Path $logPath
} catch {
  "[$(Get-Date -Format o)] ERRO: $($_.Exception.Message)" | Add-Content -Path $logPath
  exit 1
}
