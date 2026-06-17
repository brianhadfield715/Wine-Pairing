# scripts/run_56_live.ps1
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

$Queries = @(
  'how many orders placed today','orders in the last 24 hours','how many orders under $50','order count by day last week',
  'how many orders were placed on weekends','how many orders have a note','orders with total over $200','customer with most orders',
  'customers who ordered only once this month','customer retention rate this quarter','average days between orders per customer',
  'bottom 5 products by units','products with zero sales this month','new products added in the last 30 days',
  'which varietal sells the most','how many products do we have','current inventory count per product','which location has most inventory',
  'average days to ship an order','how many orders shipped same day','orders shipped within 2 days','most common shipping method',
  'average shipping cost per order','orders pending shipment right now','orders fulfilled this week','average discount per order',
  'refunds this month amount','average refund processing time','products with most refund requests','refund trend over last 30 days',
  'total refunded this quarter','busiest hour today','which hour has most orders','orders placed between 6pm and 9pm',
  'compare product sales this month to last month','net profit after refunds and discounts this month','average tax per order',
  'cross sell patterns by category','medium value customers $100 to $500','orders still in draft status',
  'orders that were never fulfilled','how many completed orders this month','all discount codes used','orders grouped by discount code',
  'orders from wholesale customers','orders from retail customers','largest single line item by quantity',
  'product with highest average quantity per order','how many orders include champagne','orders pending more than 3 days',
  'repeat purchase rate last 30 days','average time between repeat purchases','orders with multiple line items',
  'orders with single item only','how many guest checkout orders','email subscriber orders this month'
)

$results = New-Object System.Collections.Generic.List[object]
$i=0
foreach ($q in $Queries) {
  $i++
  try {
    $r = Invoke-RestMethod -Method Post -Uri 'https://wine-pairing-cu78.onrender.com/shopify-qa' -Headers $H -ContentType 'application/json' -Body (@{question=$q} | ConvertTo-Json -Compress) -TimeoutSec 120
    $intent = $r.intent
    $status = if ($r.meta) { $r.meta.status } else { '' }
    $pass = ($intent -ne 'general_help') -and ($status -eq 'ok' -or $status -eq 'help' -or $intent -eq 'capability_unsupported')
    $sym = if ($pass) { 'OK  ' } else { 'FAIL' }
    $ansSnip = if ($r.answer) { $r.answer.Replace("`n",' | ').Substring(0,[Math]::Min(120,$r.answer.Length)) } else { '' }
    "{0,2}. [{1}] {2,-32} -> {3,-30} {4}" -f $i,$sym,($q.Substring(0,[Math]::Min(32,$q.Length))),$intent,$ansSnip | Write-Host
    $results.Add(@{i=$i; q=$q; intent=$intent; status=$status; pass=$pass; answer=$r.answer; error=$null})
  } catch {
    "{0,2}. [{1}] {2,-32} -> ERROR {3}" -f $i,'FAIL',($q.Substring(0,[Math]::Min(32,$q.Length))),$_.Exception.Message | Write-Host
    $results.Add(@{i=$i; q=$q; intent=$null; status='error'; pass=$false; error=$_.Exception.Message})
  }
}

$passCount = ($results | Where-Object { $_.pass }).Count
$failCount = ($results | Where-Object { -not $_.pass }).Count
Write-Host ''
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host ("Passed: {0} / {1}" -f $passCount,$Queries.Count) -ForegroundColor Green
Write-Host ("Failed: {0} / {1}" -f $failCount,$Queries.Count) -ForegroundColor Red
if ($failCount -gt 0) {
  Write-Host ''
  Write-Host "FAILURES:" -ForegroundColor Red
  $results | Where-Object { -not $_.pass } | ForEach-Object {
    "  #{0,2}  '{1}'  intent={2}  status={3}  err={4}" -f $_.i,$_.q,$_.intent,$_.status,$_.error
  }
}
