# scripts/backfill_history.ps1
# ----------------------------------------------------------------------------
# Operational backfill: load all Shopify order history from store launch in
# October 2023 forward, then refresh customers and inventory, then verify
# coverage and a few historical analytics questions.
#
# Uses ONLY existing endpoints on the live Render service. No backend code
# changes are required to run this script.
#
# How to run:
#   cd C:\Users\bhadf\wine-pairing-backend
#   .\scripts\backfill_history.ps1
#
# Credentials:
#   The script reads QA_USER / QA_PASS from the local .env in the repo root
#   by default. To override, edit the two variables under "CREDENTIALS" below.
# ----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'  # avoid Invoke-WebRequest progress UI
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# --- CONFIG -----------------------------------------------------------------

$BaseUrl        = 'https://wine-pairing-cu78.onrender.com'
$LogPath        = Join-Path $PSScriptRoot 'backfill_history.log'
$PageLimit      = 50
$MaxPages1      = 20
$MaxPages2      = 40
$HttpTimeoutSec = 200

$Today = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddT00:00:00.000Z')
$Windows = @(
  @{ since = '2023-10-01T00:00:00.000Z'; until = '2024-01-01T00:00:00.000Z' },
  @{ since = '2024-01-01T00:00:00.000Z'; until = '2024-04-01T00:00:00.000Z' },
  @{ since = '2024-04-01T00:00:00.000Z'; until = '2024-07-01T00:00:00.000Z' },
  @{ since = '2024-07-01T00:00:00.000Z'; until = '2024-10-01T00:00:00.000Z' },
  @{ since = '2024-10-01T00:00:00.000Z'; until = '2025-01-01T00:00:00.000Z' },
  @{ since = '2025-01-01T00:00:00.000Z'; until = '2025-04-01T00:00:00.000Z' },
  @{ since = '2025-04-01T00:00:00.000Z'; until = $Today                     }
)

# --- CREDENTIALS ------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvPath  = Join-Path $RepoRoot '.env'

$QaUser = $null
$QaPass = $null

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
  Write-Host 'ERROR: QA_USER/QA_PASS not found. Edit them at the top of the script or add to .env.' -ForegroundColor Red
  exit 2
}

$AuthHeader = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$QaUser`:$QaPass"))
$Headers    = @{ Authorization = $AuthHeader }

# --- LOGGING ----------------------------------------------------------------

if (Test-Path $LogPath) { Remove-Item $LogPath -Force }
$VALID_COLORS = @('Black','DarkBlue','DarkGreen','DarkCyan','DarkRed','DarkMagenta','DarkYellow','Gray','DarkGray','Blue','Green','Cyan','Red','Magenta','Yellow','White')

function Write-Log {
  [CmdletBinding()]
  param(
    [Parameter(Position=0)][string]$Message = '',
    [Parameter(Position=1)][string]$Color = 'Gray'
  )
  if ($VALID_COLORS -notcontains $Color) { $Color = 'Gray' }
  $stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  $line  = '[' + $stamp + '] ' + $Message
  Write-Host $line -ForegroundColor $Color
  Add-Content -Path $LogPath -Value $line
}

# --- HTTP HELPERS -----------------------------------------------------------

function Invoke-AdminApi {
  param([string]$Path, [hashtable]$Body)
  $url  = "$BaseUrl$Path"
  $json = if ($Body) { ($Body | ConvertTo-Json -Compress) } else { '{}' }
  $resp = Invoke-WebRequest -Method Post -Uri $url -Headers $Headers `
                            -ContentType 'application/json' -Body $json `
                            -TimeoutSec $HttpTimeoutSec -UseBasicParsing
  $data = if ($resp.Content) { $resp.Content | ConvertFrom-Json } else { $null }
  return @{ status = [int]$resp.StatusCode; body = $data }
}

function Invoke-AdminApiSafe {
  param([string]$Path, [hashtable]$Body)
  try {
    return Invoke-AdminApi -Path $Path -Body $Body
  } catch {
    $err = $_.Exception
    $status = $null
    $body = $null
    if ($err.Response) {
      $status = [int]$err.Response.StatusCode
      try {
        $reader = New-Object IO.StreamReader($err.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        try { $body = $body | ConvertFrom-Json } catch { }
      } catch { }
    }
    if ($status -eq 401) {
      Write-Log 'AUTH FAILED (401). Check QA_USER / QA_PASS in .env.' 'Red'
      throw 'auth failed'
    }
    return @{ status = $status; error = $err.Message; body = $body }
  }
}

function Ask-QA {
  param([string]$Question)
  try {
    $r = Invoke-AdminApi -Path '/shopify-qa' -Body @{ question = $Question }
    return $r.body
  } catch {
    Write-Log ('QA call failed: ' + $_.Exception.Message) 'Red'
    return $null
  }
}

# --- ORDERS BACKFILL --------------------------------------------------------

function Format-WindowResult {
  param([string]$Since, [string]$Until, $Body)
  return ('  ok={0} pages={1} orders={2} lines={3} skipO={4} skipL={5} cancel={6} ms={7}' -f `
    $Body.ok, $Body.pages_fetched, $Body.orders_written, $Body.line_items_written, `
    $Body.orders_skipped, $Body.lines_skipped, $Body.cancelled_seen, $Body.elapsed_ms)
}

function Run-Window {
  param([string]$Since, [string]$Until, [int]$MaxPages)
  Write-Log ('-> POST /admin/sync/orders since=' + $Since + ' until=' + $Until + ' limit=' + $PageLimit + ' maxPages=' + $MaxPages) 'Cyan'
  $body = @{ sinceIso = $Since; untilIso = $Until; limit = $PageLimit; maxPages = $MaxPages }
  $r = Invoke-AdminApiSafe -Path '/admin/sync/orders' -Body $body
  if (-not $r) { return @{ ok = $false; error = 'no response' } }
  if ($r.status -ne 200) {
    $msg = 'HTTP ' + $r.status + ': ' + ($r.body | ConvertTo-Json -Compress 2>$null)
    Write-Log $msg 'Red'
    return @{ ok = $false; error = $msg; status = $r.status; body = $r.body }
  }
  Write-Log (Format-WindowResult -Since $Since -Until $Until -Body $r.body) 'Green'
  return @{ ok = $true; body = $r.body }
}

# ----------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------

Write-Log ('===== Historical backfill ===== base=' + $BaseUrl) 'White'

# Quick auth probe
Write-Log 'Auth probe...' 'Gray'
try {
  $probe = Invoke-AdminApi -Path '/shopify-qa' -Body @{ question = 'how far back does the order data go' }
  if ($probe.status -ne 200) { throw ('auth probe status ' + $probe.status) }
  Write-Log 'Auth ok.' 'Green'
} catch {
  Write-Log ('Auth probe failed: ' + $_.Exception.Message) 'Red'
  exit 3
}

# --- Phase 1: orders backfill ----------------------------------------------

$WindowQueue = New-Object System.Collections.Generic.Queue[hashtable]
foreach ($w in $Windows) {
  $WindowQueue.Enqueue([hashtable]@{ since = $w.since; until = $w.until; tries = 0 })
}

$Results       = New-Object System.Collections.Generic.List[hashtable]
$RetryCount    = 0
$SplitCount    = 0
$FailedWindows = New-Object System.Collections.Generic.List[hashtable]

while ($WindowQueue.Count -gt 0) {
  $w = $WindowQueue.Dequeue()
  $maxPages = if ($w.tries -ge 1) { $MaxPages2 } else { $MaxPages1 }
  $r = Run-Window -Since $w.since -Until $w.until -MaxPages $maxPages

  if (-not $r.ok) {
    Write-Log ('Window FAILED: ' + $w.since + ' to ' + $w.until) 'Red'
    $FailedWindows.Add(@{ since = $w.since; until = $w.until; error = $r.error })
    if ($w.tries -lt 1) {
      Write-Log '  ... retrying once' 'Yellow'
      $w.tries = $w.tries + 1
      $WindowQueue.Enqueue($w)
      $RetryCount += 1
    }
    continue
  }

  $body = $r.body
  $cap  = [int]$body.pages_fetched -ge $maxPages
  $Results.Add(@{ since = $w.since; until = $w.until; body = $body; maxPages = $maxPages; capped = $cap })

  if ($cap) {
    if ($w.tries -lt 1) {
      Write-Log ('  potentially truncated (pages=' + $body.pages_fetched + '). Retrying with maxPages=' + $MaxPages2) 'Yellow'
      $w.tries = $w.tries + 1
      $WindowQueue.Enqueue($w)
      $RetryCount += 1
    } else {
      $sinceDt = [DateTime]::Parse($w.since, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
      $untilDt = [DateTime]::Parse($w.until, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
      $midDt   = $sinceDt.AddTicks( ([long]($untilDt - $sinceDt).Ticks) / 2 )
      $mid     = $midDt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      Write-Log ('  STILL truncated at maxPages=' + $MaxPages2 + '. Splitting at ' + $mid) 'Yellow'
      $WindowQueue.Enqueue(@{ since = $w.since; until = $mid;     tries = 0 })
      $WindowQueue.Enqueue(@{ since = $mid;     until = $w.until; tries = 0 })
      $SplitCount += 1
    }
  }
}

# --- Phase 2: customers refresh --------------------------------------------

Write-Log '' 'White'
Write-Log '-> POST /admin/sync/customers' 'Cyan'
$custOk = $false
try {
  $r = Invoke-AdminApiSafe -Path '/admin/sync/customers' -Body @{}
  if ($r.status -eq 200) {
    Write-Log ('  customers: ' + ($r.body | ConvertTo-Json -Compress)) 'Green'
    $custOk = $true
  } else {
    Write-Log ('  customers FAILED: status=' + $r.status + ' body=' + ($r.body | ConvertTo-Json -Compress)) 'Red'
  }
} catch {
  Write-Log ('  customers FAILED: ' + $_.Exception.Message) 'Red'
}

# --- Phase 3: inventory refresh --------------------------------------------

Write-Log '' 'White'
Write-Log '-> POST /admin/sync/inventory' 'Cyan'
$invOk = $false
try {
  $r = Invoke-AdminApiSafe -Path '/admin/sync/inventory' -Body @{}
  if ($r.status -eq 200) {
    Write-Log ('  inventory: ' + ($r.body | ConvertTo-Json -Compress)) 'Green'
    $invOk = $true
  } else {
    Write-Log ('  inventory FAILED: status=' + $r.status + ' body=' + ($r.body | ConvertTo-Json -Compress)) 'Red'
  }
} catch {
  Write-Log ('  inventory FAILED: ' + $_.Exception.Message) 'Red'
}

# --- Phase 4: verification --------------------------------------------------

Write-Log '' 'White'
Write-Log '===== Verification =====' 'White'

$coverage = Ask-QA -Question 'What date range does the order data cover?'
$verifyA  = Ask-QA -Question 'How much did we sell in November 2023?'
$verifyB  = Ask-QA -Question 'What were the top items sold in December 2023?'
$verifyC  = Ask-QA -Question 'Who were the top customers in Q1 2024?'

$verifyAll = @(
  @{ label = 'COVERAGE'; v = $coverage },
  @{ label = 'NOV 2023'; v = $verifyA },
  @{ label = 'DEC 2023'; v = $verifyB },
  @{ label = 'Q1 2024';  v = $verifyC }
)
foreach ($q in $verifyAll) {
  Write-Log ('---- ' + $q.label + ' ----') 'Cyan'
  if (-not $q.v) {
    Write-Log '  (no response)' 'Red'
  } else {
    $status = if ($q.v.meta) { $q.v.meta.status } else { '' }
    Write-Log ('  intent=' + $q.v.intent + ' domain=' + $q.v.domain + ' status=' + $status)
    if ($q.v.meta -and $q.v.meta.timeframe) {
      Write-Log ('  timeframe=' + ($q.v.meta.timeframe | ConvertTo-Json -Compress))
    }
    Write-Log ('  answer: ' + $q.v.answer)
  }
}

# --- Phase 5: final summary -------------------------------------------------

$earliest = $null; $latest = $null
$totalOrders = 0
foreach ($r in $Results) {
  if ($r.body) {
    $totalOrders += [int]$r.body.orders_written
    $win = $r.body.window
    if ($win) {
      if (-not $earliest -or $win.sinceIso -lt $earliest) { $earliest = $win.sinceIso }
      if (-not $latest   -or $win.untilIso -gt $latest)   { $latest   = $win.untilIso }
    } else {
      if (-not $earliest -or $r.since -lt $earliest) { $earliest = $r.since }
      if (-not $latest   -or $r.until -gt $latest)   { $latest   = $r.until }
    }
  }
}

if ($coverage -and $coverage.data -and $coverage.data.Count -gt 0) {
  $row = $coverage.data[0]
  if ($row.earliest_order_at) { $earliest = $row.earliest_order_at }
  if ($row.latest_order_at)   { $latest   = $row.latest_order_at }
}

$custStatus = if ($custOk) { 'OK' } else { 'FAILED' }
$invStatus  = if ($invOk)  { 'OK' } else { 'FAILED' }

Write-Log '' 'White'
Write-Log '===== FINAL SUMMARY =====' 'White'
Write-Log ('windows_attempted    = ' + $Windows.Count)
Write-Log ('windows_completed_ok = ' + $Results.Count)
Write-Log ('windows_failed       = ' + $FailedWindows.Count)
Write-Log ('retries              = ' + $RetryCount)
Write-Log ('splits               = ' + $SplitCount)
Write-Log ('orders_written_total = ' + $totalOrders)
Write-Log ('earliest_loaded      = ' + $earliest)
Write-Log ('latest_loaded        = ' + $latest)
Write-Log ('customers_refresh    = ' + $custStatus)
Write-Log ('inventory_refresh    = ' + $invStatus)

if ($FailedWindows.Count -gt 0) {
  Write-Log '' 'Red'
  Write-Log 'FAILED WINDOWS:' 'Red'
  foreach ($f in $FailedWindows) {
    Write-Log ('  ' + $f.since + ' to ' + $f.until + '  ' + $f.error) 'Red'
  }
  exit 1
}

Write-Log ''
Write-Log 'BACKFILL COMPLETE.' 'Green'
exit 0
