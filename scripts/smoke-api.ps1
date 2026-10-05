$ErrorActionPreference = "Stop"
$env:HH_PORT = "7077"
$env:HH_DB_PATH = "data/smoke.sqlite"

$proc = Start-Process -FilePath "node" -ArgumentList "--no-warnings", "dist/server.js" -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Seconds 2
  $health = Invoke-RestMethod "http://127.0.0.1:7077/health"
  Write-Host "health: $($health | ConvertTo-Json -Compress)"

  $body = '{"regions":[{"code":"A","population":"100"},{"code":"B","population":"300"}]}'
  $version = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7077/versions" -ContentType "application/json" -Body $body
  Write-Host "version id: $($version.id)"

  $analysis = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7077/versions/$($version.id)/analyses" -ContentType "application/json" -Body '{"totalSeats":6}'
  Write-Host "analysis: totalSeats=$($analysis.totalSeats) rounds=$($analysis.rounds.Count) rules=$($analysis.rulesVersion)"

  $bad = try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7077/versions/$($version.id)/analyses" -ContentType "application/json" -Body '{"totalSeats":1}'
  } catch { $_.ErrorDetails.Message }
  Write-Host "too-few-seats: $bad"
} finally {
  Stop-Process -Id $proc.Id
}
