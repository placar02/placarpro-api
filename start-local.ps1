$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }

$processIds = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' -and $_.OwningProcess -gt 0 } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($processId in $processIds) {
  Write-Host "Parando processo antigo na porta $port (PID $processId)..."
  Stop-Process -Id $processId -Force
}

# O processo local atua como worker/publicador. Estas variaveis valem somente
# para esta execucao e nao alteram a configuracao segura usada no Render.
$env:NODE_ENV = "development"
$env:DAILY_PICK_READ_ONLY = "false"
$env:DAILY_PICK_PUBLISHER_ENABLED = "true"
$env:DAILY_PICK_SCHEDULER_ENABLED = "false"

Write-Host "Iniciando API publicadora local na porta $port..."
node server.js
