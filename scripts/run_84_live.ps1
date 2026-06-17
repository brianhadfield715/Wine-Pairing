# scripts/run_84_live.ps1
# Runs all 84 queries against the live Render service and reports pass/fail.
# Pass = classifier returned a real intent (not general_help) AND the engine
# returned status='ok' or status='help' (for the 4 intentionally-unsupported
# capability questions). Fail = anything else.

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$EnvPath = 'C:\Users\bhadf\wine-pairing-backend\.env'
$QaUser=$null; $QaPass=$null
Get-Content $EnvPath | ForEach-Object {
  $line=$_.Trim(); if ($line -and -not $line.StartsWith('#')) {
    $idx=$line.IndexOf('='); if ($idx -gt 0) {
      $k=$line.Substring(0,$idx).Trim(); $v=$line.Substring($idx+1).Trim().Trim('"').Trim("'")
      if ($k -eq 'QA_USER') { $QaUser=$v }; if ($k -eq 'QA_PASS') { $QaPass=$v }
    }
  }
}
$H = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$QaUser`:$QaPass")) }

$Queries = @(
  'orders by status','refunded orders count','canceled orders','highest order value','lowest order value',
  'what products do we sell','worst selling product','how many SKUs do we have','product categories breakdown',
  'newest products added','average customer lifetime value','customer order frequency','customer locations breakdown',
  'customers with no orders','inventory status','inventory levels by product','inventory by location',
  'products not in inventory','orders placed after 5pm','orders over $500','orders from first time buyers',
  'average items per order','largest order ever','orders with discounts','order completion rate',
  'fulfillment status breakdown','orders shipped this week','orders pending fulfillment','week over week comparison',
  'busiest day of the week','busiest hour of the day','total discounts given','total taxes collected',
  'payment method breakdown','orders paid with credit card','orders paid with PayPal','traffic sources',
  'conversion rate','abandoned cart rate','email campaign performance','average shipping time',
  'orders shipped to state','most common shipping state','international orders count','year over year growth',
  'weekday vs weekend sales','total line items sold','average quantity per line item','orders with free shipping',
  'gift card orders','total tags used on orders','orders tagged with VIP','draft orders count',
  'archived orders count','orders with notes','orders with custom attributes','high value customers this month',
  'customers who spent over $1000','last order date per customer','churned customers in last 30 days',
  'inventory turnover rate','days of inventory remaining','orders by referrer','which day has the most orders',
  'average order lead time','total weight of all orders','heaviest orders','orders with same day shipping',
  'orders with express shipping','refund rate percentage','average refund amount','how long do refunds take',
  'products with most returns','return rate by product','store pick up orders','local delivery orders',
  'shipping cost breakdown','free shipping threshold performance','coupon usage rate',
  'which discount codes are used most','average discount percentage','orders without discount',
  'wholesale orders','retail orders'
)

$results = New-Object System.Collections.Generic.List[object]
$i = 0
foreach ($q in $Queries) {
  $i++
  try {
    $r = Invoke-RestMethod -Method Post `
      -Uri 'https://wine-pairing-cu78.onrender.com/shopify-qa' `
      -Headers $H -ContentType 'application/json' `
      -Body (@{question=$q} | ConvertTo-Json -Compress) -TimeoutSec 120
    $intent = $r.intent
    $status = if ($r.meta) { $r.meta.status } else { '' }
    # Pass criteria: not general_help, and status is ok or help (capability_unsupported).
    $pass = ($intent -ne 'general_help') -and ($status -eq 'ok' -or $status -eq 'help' -or $intent -eq 'capability_unsupported')
    $sym = if ($pass) { 'OK  ' } else { 'FAIL' }
    $ansSnip = if ($r.answer) { $r.answer.Replace("`n", ' | ').Substring(0, [Math]::Min(120, $r.answer.Length)) } else { '' }
    "{0,2}. [{1}] {2,-28} -> {3,-32} {4}" -f $i, $sym, ($q.Substring(0, [Math]::Min(28, $q.Length))), $intent, $ansSnip | Write-Host
    $results.Add(@{ i=$i; q=$q; intent=$intent; status=$status; pass=$pass; answer=$r.answer; error=$null })
  } catch {
    "{0,2}. [{1}] {2,-28} -> ERROR {3}" -f $i, 'FAIL', ($q.Substring(0, [Math]::Min(28, $q.Length))), $_.Exception.Message | Write-Host
    $results.Add(@{ i=$i; q=$q; intent=$null; status='error'; pass=$false; error=$_.Exception.Message })
  }
}

$passCount = ($results | Where-Object { $_.pass }).Count
$failCount = ($results | Where-Object { -not $_.pass }).Count

Write-Host ''
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host ("Passed: {0} / {1}" -f $passCount, $Queries.Count) -ForegroundColor Green
Write-Host ("Failed: {0} / {1}" -f $failCount, $Queries.Count) -ForegroundColor Red

if ($failCount -gt 0) {
  Write-Host ''
  Write-Host "FAILURES:" -ForegroundColor Red
  $results | Where-Object { -not $_.pass } | ForEach-Object {
    "  #{0,2}  '{1}'  intent={2}  status={3}  err={4}" -f $_.i, $_.q, $_.intent, $_.status, $_.error
  }
}
