<#
  FamilyHub Kiosk for Windows
  Turns a Windows PC into a FamilyHub kiosk screen: at sign-in, Microsoft Edge opens FamilyHub
  full screen with its own profile (so the screen stays paired), the display is kept awake,
  and Edge is reopened if it's closed.

  Install:    double-click Install.cmd   (or: .\Install-FamilyHubKiosk.ps1 -Url https://family.example.com)
  Stop now:   double-click "Stop FamilyHub Kiosk" in the Start menu (it starts again at next sign-in)
  Uninstall:  double-click Uninstall.cmd (or: .\Install-FamilyHubKiosk.ps1 -Uninstall)
#>
param(
  [string]$Url,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$AppDir   = Join-Path $env:LOCALAPPDATA 'FamilyHubKiosk'
$Startup  = [Environment]::GetFolderPath('Startup')
$Programs = [Environment]::GetFolderPath('Programs')
$StartLnk = Join-Path $Startup 'FamilyHub Kiosk.lnk'
$StopLnk  = Join-Path $Programs 'Stop FamilyHub Kiosk.lnk'
$RunLnk   = Join-Path $Programs 'FamilyHub Kiosk.lnk'

function Stop-Kiosk {
  $pidFile = Join-Path $AppDir 'watchdog.pid'
  if (Test-Path $pidFile) {
    $wpid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($wpid) { Stop-Process -Id $wpid -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  # Close only the kiosk's Edge (identified by its own profile folder), not the user's normal Edge.
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*FamilyHubKiosk*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function New-Shortcut($path, $arguments) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = (Get-Command powershell.exe).Source
  $s.Arguments = $arguments
  $s.WorkingDirectory = $AppDir
  $s.WindowStyle = 7   # minimized
  $s.Save()
}

if ($Uninstall) {
  Stop-Kiosk
  Remove-Item $StartLnk, $StopLnk, $RunLnk -Force -ErrorAction SilentlyContinue
  Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "FamilyHub Kiosk has been removed from this PC." -ForegroundColor Green
  return
}

Write-Host ""
Write-Host "  FamilyHub Kiosk for Windows" -ForegroundColor Cyan
Write-Host "  Opens FamilyHub full screen every time you sign in to this PC."
Write-Host ""
if (-not $Url) { $Url = Read-Host "Your FamilyHub address (e.g. https://family.example.com)" }
$Url = $Url.Trim()
if ($Url -notmatch '^https?://') { $Url = "https://$Url" }
$Url = ($Url -replace '/kiosk/?$', '').TrimEnd('/')

try {
  Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 10 | Out-Null
  Write-Host "Found FamilyHub at $Url" -ForegroundColor Green
} catch {
  Write-Host "Couldn't reach $Url right now. Installing anyway; check the address if the screen stays on 'Waiting'." -ForegroundColor Yellow
}

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge wasn't found. Install Edge and run this again." }

Stop-Kiosk
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
@{ url = $Url; edge = $edge } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $AppDir 'config.json')

# The watchdog: keeps the display awake and Edge open on FamilyHub.
@'
$ErrorActionPreference = 'Continue'
$AppDir = Join-Path $env:LOCALAPPDATA 'FamilyHubKiosk'
$cfg = Get-Content (Join-Path $AppDir 'config.json') -Raw | ConvertFrom-Json
Set-Content (Join-Path $AppDir 'watchdog.pid') $PID
Add-Type -Namespace FH -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED: no sleep, no screen-off while the kiosk runs.
[FH.Power]::SetThreadExecutionState([uint32]"0x80000003") | Out-Null
$edgeProfile = Join-Path $AppDir 'EdgeProfile'
while ($true) {
  # Wait for the network / server before opening, so Edge doesn't land on an error page.
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -Uri "$($cfg.url)/api/health" -UseBasicParsing -TimeoutSec 5 | Out-Null; break } catch { Start-Sleep -Seconds 5 }
  }
  $edgeArgs = @(
    "--user-data-dir=`"$edgeProfile`"", "--app=$($cfg.url)/kiosk", '--start-fullscreen',
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,msEdgeSidebarV2',
    '--overscroll-history-navigation=0', '--disable-pinch', '--autoplay-policy=no-user-gesture-required'
  )
  $p = Start-Process -FilePath $cfg.edge -ArgumentList $edgeArgs -PassThru
  $p.WaitForExit()
  # Edge may hand off to another process of the same profile; wait until all of them are gone.
  do {
    Start-Sleep -Seconds 3
    $running = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*FamilyHubKiosk*" }
  } while ($running)
}
'@ | Set-Content -Encoding UTF8 (Join-Path $AppDir 'FamilyHubKiosk.ps1')

@"
`$pidFile = Join-Path '$AppDir' 'watchdog.pid'
if (Test-Path `$pidFile) { Stop-Process -Id (Get-Content `$pidFile) -Force -ErrorAction SilentlyContinue; Remove-Item `$pidFile -Force }
Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { `$_.CommandLine -like '*FamilyHubKiosk*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
"@ | Set-Content -Encoding UTF8 (Join-Path $AppDir 'Stop-FamilyHubKiosk.ps1')

$run  = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\FamilyHubKiosk.ps1`""
$stop = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\Stop-FamilyHubKiosk.ps1`""
New-Shortcut $StartLnk $run
New-Shortcut $RunLnk $run
New-Shortcut $StopLnk $stop

Start-Process powershell.exe -ArgumentList $run -WindowStyle Hidden
Write-Host ""
Write-Host "Done! FamilyHub is opening full screen." -ForegroundColor Green
Write-Host " - Enter the pairing code from FamilyHub -> Settings -> App settings -> Kiosk screens."
Write-Host " - It opens by itself every time you sign in to this Windows account."
Write-Host " - To close it for now: Start menu -> 'Stop FamilyHub Kiosk'. To remove it: Uninstall.cmd"
Write-Host ""
