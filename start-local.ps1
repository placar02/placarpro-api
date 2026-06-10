$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }

$processIds = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' -and $_.OwningProcess -gt 0 } |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($processId in $processIds) {
  Write-Host "Parando processo antigo na porta $port (PID $processId)..."
  Stop-Process -Id $processId -Force
}

Write-Host "Iniciando API na porta $port..."
node server.js
