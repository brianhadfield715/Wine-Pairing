# scripts/run_33_live.ps1
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$EnvPath='C:\Users\bhadf\wine-pairing-backend\.env'
$QaUser=$null; $QaPass=$null
Get-Content $EnvPath | ForEach-Object {
  $line=$_.Trim(); if ($line -and -not $line.StartsWith('#')) {
    $idx=$line.IndexOf('='); if ($idx -gt 0) {
      $k=$line.Substring(0,$idx).Trim(); $v=$line.Substring($idx+1).Trim().Trim('"').Trim("'")
      if ($k -eq 'QA_USER') { $QaUser=$v }; if ($k -eq 'QA_PASS') { $QaPass=$v }
    }
  }
}
$H = @{ Authorization='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$QaUser`:$QaPass")) }

# 33 originally-failing queries:
$Queries = @(
  'what did we sell the most of last week',
  'what sold the most last week',
  'what product types do we sell',
  'list all product categories',
  'what categories do we have',
  'when was our first order',
  'when was our last order',
  'who has bought the most units',
  'who ordered the most units',
  'which customer has the most units',
  'customers by total units',
  'what sku have we sold the most of',
  'what sku sold the most',
  'which sku sold the most',
  'what variant sold the most',
  'top variant last week',
  'chart of sales last week',
  'trending products this month',
  'average order to delivery time',
  'how long does shipping take',
  'what is the date range of the data in your system',
  'what date range does your data cover',
  'how old is your data',
  'when did we last sync data',
  'last data sync time',
  'data last updated',
  'how fresh is your data',
  'when was Brian Hadfield first order',
  'when was Brian Hadfield last order',
  'how many unique customers do we have',
  'products on sale',
  'discounted products',
  'products with a discount'
)

# 4 named bugs:
$BugQueries = @(
  @{ q='bhadfield@myfsi.et last order';                          tag='Bug A (email-only lookup)' },
  @{ q='chart of new vs returning customer counts by month';     tag='Bug B (monthly time-series)' },
  @{ q='who bought the most units';                              tag='Bug C (units not dollars)' },
  @{ q='who were the top customers last month';                  tag='Bug D (chart spec)' }
)

# Regression sanity:
$RegressionQueries = @(
  'revenue this month',
  'top products this month',
  'customer count'
)

$pass=0; $fail=0; $failures=@()
$i=0
foreach ($q in $Queries) {
  $i++
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'https://wine-pairing-cu78.onrender.com/shopify-qa' -Headers $H -ContentType 'application/json' -Body (@{question=$q} | ConvertTo-Json -Compress) -TimeoutSec 120
    $intent=$r.intent; $status=if ($r.meta) { $r.meta.status } else { '' }
    # status=disambiguation is a meaningful answer (the engine listed candidates), not a failure.
    $ok = ($intent -ne 'general_help') -and ($status -eq 'ok' -or $status -eq 'help' -or $status -eq 'disambiguation' -or $intent -eq 'capability_unsupported')
    $sym = if ($ok) { 'OK  ' } else { 'FAIL' }
    $ans = if ($r.answer) { ($r.answer -replace "`n"," | ").Substring(0,[Math]::Min(120,$r.answer.Length)) } else { '' }
    "{0,2}. [{1}] {2,-50} -> {3,-32} {4}" -f $i,$sym,($q.Substring(0,[Math]::Min(50,$q.Length))),$intent,$ans | Write-Host
    if ($ok) { $pass++ } else { $fail++; $failures += "$i. '$q' intent=$intent status=$status" }
  } catch {
    "{0,2}. [{1}] {2,-50} -> ERROR {3}" -f $i,'FAIL',($q.Substring(0,[Math]::Min(50,$q.Length))),$_.Exception.Message | Write-Host
    $fail++; $failures += "$i. '$q' EXC: $($_.Exception.Message)"
  }
}

Write-Host ''; Write-Host '=== 4 NAMED BUGS ===' -ForegroundColor Cyan
foreach ($b in $BugQueries) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'https://wine-pairing-cu78.onrender.com/shopify-qa' -Headers $H -ContentType 'application/json' -Body (@{question=$b.q} | ConvertTo-Json -Compress) -TimeoutSec 120
    Write-Host ("[{0}] '{1}'" -f $b.tag, $b.q) -ForegroundColor Yellow
    Write-Host ("  intent=$($r.intent)  status=$($r.meta.status)") -ForegroundColor Gray
    Write-Host ('  ans: ' + (($r.answer -replace "`n"," | ").Substring(0,[Math]::Min(200,$r.answer.Length))))
    if ($r.visualization) {
      Write-Host ("  viz: chart_type=$($r.visualization.chart_type) x_field=$($r.visualization.x_field) y_field=$($r.visualization.y_field)") -ForegroundColor DarkGray
    }
  } catch {
    Write-Host ("[{0}] ERR: {1}" -f $b.tag, $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ''; Write-Host '=== REGRESSION CHECKS ===' -ForegroundColor Cyan
foreach ($q in $RegressionQueries) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'https://wine-pairing-cu78.onrender.com/shopify-qa' -Headers $H -ContentType 'application/json' -Body (@{question=$q} | ConvertTo-Json -Compress) -TimeoutSec 120
    $ok = ($r.intent -ne 'general_help') -and $r.meta.status -eq 'ok'
    $sym = if ($ok) { 'OK  ' } else { 'FAIL' }
    "[$sym] '$q' -> $($r.intent)  $($r.answer -replace "`n"," | " | Out-String)" -replace "`r?`n$","" | Write-Host
  } catch { Write-Host "[FAIL] '$q' ERR: $($_.Exception.Message)" -ForegroundColor Red }
}

Write-Host ''; Write-Host '=== SUMMARY ===' -ForegroundColor Cyan
Write-Host ("Phrase fixes: {0} / {1} passed, {2} failed" -f $pass, $Queries.Count, $fail) -ForegroundColor Green
if ($fail -gt 0) {
  Write-Host ''; Write-Host 'FAILURES:' -ForegroundColor Red
  $failures | ForEach-Object { "  $_" }
}
