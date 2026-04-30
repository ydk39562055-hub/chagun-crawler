# 로컬 PC가 켜진 동안 크롤링 collector를 매시간 자동 실행
# GitHub Actions가 느리거나 막혀 있을 때 백업용
#
# 실행:
#   pwsh -File scripts/local-runner.ps1
# 또는 Windows Task Scheduler에 등록 (1회 등록 → 부팅 시 자동 시작)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Run-Collector {
  param([string]$name, [string[]]$args)
  $ts = Get-Date -Format 'yyyy-MM-dd_HH-mm'
  $log = Join-Path $logDir "$name-$ts.log"
  Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] $name 시작 -> $log"
  & node $args 2>&1 | Tee-Object -FilePath $log
  Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] $name 종료"
}

while ($true) {
  $now = Get-Date
  Write-Host "`n=== $($now.ToString('yyyy-MM-dd HH:mm:ss')) 사이클 시작 ==="

  Run-Collector -name 'spcfc'        -args @('collectors/court-spcfc-fetch.js', '--upload', '--limit', '10')
  Run-Collector -name 'spcfc-veh'    -args @('collectors/court-spcfc-fetch.js', '--upload', '--category', 'vehicle', '--limit', '10')
  Run-Collector -name 'docs-snap'    -args @('collectors/court-docs-snap.js', '--upload', '--limit', '10')
  Run-Collector -name 'photo-rehost' -args @('collectors/court-photo-rehost.js', '--upload', '--limit', '10')

  Write-Host "=== 사이클 완료, 다음 사이클까지 30분 대기 ==="
  Start-Sleep -Seconds 1800
}
