# scripts/check_data_coverage.ps1
# Lightweight verification: prints data-coverage + a few historical analytics
# answers from the live service. Does not modify anything.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\check_data_coverage.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$BaseUrl = 'https://wine-pairing-cu78.onrender.com'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvPath  = Join-Path $RepoRoot '.env'
$QaUser = $null; $QaPass = $null
if (Test-Path $EnvPath) {
  Get-Content $EnvPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $idx = $line.IndexOf('=')
      if ($idx -gt 0) {
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        if ($k -eq 'QA_USER') { $QaUser = $v }
        if ($k -eq 'QA_PASS') { $QaPass = $v }
      }
    }
  }
}
if (-not $QaUser -or -not $QaPass) {
  Write-Host 'ERROR: QA_USER/QA_PASS not found.' -ForegroundColor Red
  exit 2
}
$Headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$QaUser`:$QaPass")) }

function Ask {
  param([string]$Q)
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$BaseUrl/shopify-qa" -Headers $Headers -ContentType 'application/json' -Body (@{ question = $Q } | ConvertTo-Json -Compress) -TimeoutSec 120
    return $r
  } catch { Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red; return $null }
}

$questions = @(
  'What date range does the order data cover?',
  'How much did we sell in November 2023?',
  'What were the top items sold in December 2023?',
  'Who were the top customers in Q1 2024?'
)

foreach ($q in $questions) {
  Write-Host ''
  Write-Host ('Q: ' + $q) -ForegroundColor Cyan
  $r = Ask -Q $q
  if (-not $r) { continue }
  Write-Host ("  intent=$($r.intent)  domain=$($r.domain)  status=$($r.meta.status)") -ForegroundColor Gray
  if ($r.meta.timeframe) { Write-Host ("  timeframe=$($r.meta.timeframe | ConvertTo-Json -Compress)") -ForegroundColor Gray }
  Write-Host ('  ' + $r.answer)
}
