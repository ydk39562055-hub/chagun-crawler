# 로컬 PC가 켜진 동안 GH Actions의 모든 collector를 미러 실행
# GitHub Actions가 느리거나 막혀 있을 때 백업/병행용
#
# 실행:
#   pwsh -File scripts/local-runner.ps1                   # 전체 사이클 무한 반복
#   pwsh -File scripts/local-runner.ps1 -Mode fast        # 가벼운 collector만 (30분 주기)
#   pwsh -File scripts/local-runner.ps1 -Mode slow        # 무거운 collector만 (매일 1회용)
#   pwsh -File scripts/local-runner.ps1 -Mode spcfc       # 매각PDF만 (GH IP 차단으로 로컬만 처리 가능)
#   pwsh -File scripts/local-runner.ps1 -Once             # 한 사이클만 실행하고 종료

param(
  [ValidateSet('full', 'fast', 'slow', 'spcfc')] [string]$Mode = 'full',
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
# UTF-8 콘솔 출력 (Node.js 한글 출력 깨짐 방지)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
Set-Location $PSScriptRoot

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Run-Collector {
  param([string]$name, [string[]]$cmdArgs)
  $ts = Get-Date -Format 'yyyy-MM-dd_HH-mm'
  $log = Join-Path $logDir "$name-$ts.log"
  $hms = (Get-Date).ToString('HH:mm:ss')
  Write-Host "[$hms] >>> $name 시작 -> $log"
  & node $cmdArgs 2>&1 | Tee-Object -FilePath $log
  $hms = (Get-Date).ToString('HH:mm:ss')
  Write-Host "[$hms] <<< $name 종료"
}

# === collector 그룹 정의 (GH Actions 워크플로 매칭) ===

# 가벼운 — 매시간 1사이클. 5/8 IP 차단 사례 후 limit 보수적으로 조정.
$fastJobs = @(
  @{ name='spcfc-real';      cmdArgs=@('collectors/court-spcfc-fetch.js',     '--upload', '--limit', '5') },
  @{ name='spcfc-vehicle';   cmdArgs=@('collectors/court-spcfc-fetch.js',     '--upload', '--category', 'vehicle', '--limit', '5') },
  @{ name='rgst-extract';    cmdArgs=@('collectors/court-rgst-extract.js',    '--upload', '--limit', '30') },
  @{ name='docs-snap';       cmdArgs=@('collectors/court-docs-snap.js',       '--upload', '--limit', '5') },
  @{ name='photo-rehost';    cmdArgs=@('collectors/court-photo-rehost.js',    '--upload', '--limit', '5') },
  @{ name='docs-fetch';      cmdArgs=@('collectors/court-docs-fetch.js',      '--upload', '--limit', '20') },
  @{ name='vehicle-docs';    cmdArgs=@('collectors/court-vehicle-docs-fetch.js', '--upload', '--limit', '10') },
  @{ name='vehicle-photos';  cmdArgs=@('collectors/court-vehicle-photos-from-page.js', '--upload', '--limit', '5') },
  @{ name='realestate-photos'; cmdArgs=@('collectors/court-realestate-photos-from-page.js', '--upload', '--limit', '5') }
)

# 호출0 자체처리 — 가벼움 매시간 가능
$selfJobs = @(
  @{ name='curst-pdf';       cmdArgs=@('collectors/court-curst-pdf-generate.js',  '--upload', '--limit', '100') },
  @{ name='rgst-extract';    cmdArgs=@('collectors/court-rgst-extract.js',        '--upload', '--limit', '100') },
  @{ name='tenant-curst';    cmdArgs=@('collectors/court-tenant-from-curst.js',   '--upload', '--limit', '100') },
  @{ name='vehicle-spcfc';   cmdArgs=@('collectors/court-vehicle-spcfc-extract.js','--upload', '--limit', '100') }
)

# 매각PDF만 — GH IP 차단 우회용 최소 모드
# (GH가 나머지 collector를 다 처리하는 안정 상태에서 PC 부담 줄이기 위해)
$spcfcJobs = @(
  @{ name='spcfc-real';      cmdArgs=@('collectors/court-spcfc-fetch.js',     '--upload', '--limit', '10') },
  @{ name='spcfc-vehicle';   cmdArgs=@('collectors/court-spcfc-fetch.js',     '--upload', '--category', 'vehicle', '--limit', '10') }
)

# 무거운 — 매일 1~2회 (vehicle-docs 는 fastJobs 로 옮김)
$slowJobs = @(
  @{ name='detail-real';     cmdArgs=@('collectors/court-detail-collect.js',  '--upsert', '--limit', '100', '--category', 'real_estate') },
  @{ name='detail-vehicle';  cmdArgs=@('collectors/court-detail-collect.js',  '--upsert', '--limit', '100', '--category', 'vehicle') },
  @{ name='vehicle-snap';    cmdArgs=@('collectors/court-docs-snap.js',           '--upload', '--category', 'vehicle', '--limit', '6') },
  @{ name='onbid-vehicle';   cmdArgs=@('collectors/onbid-vehicle-list.js',    '--upsert', '--all') },
  @{ name='onbid-vehicle-enrich'; cmdArgs=@('collectors/onbid-vehicle-enrich.js', '--upsert') },
  @{ name='onbid-realestate';cmdArgs=@('collectors/onbid-realestate-list.js', '--upsert', '--all') }
)

# 모드별 작업 선택
$cycleCount = 0
while ($true) {
  $cycleCount++
  $now = Get-Date
  Write-Host "`n=== Cycle $cycleCount @ $($now.ToString('yyyy-MM-dd HH:mm:ss')) ==="

  if ($Mode -eq 'fast') {
    $jobs = $fastJobs + $selfJobs
  } elseif ($Mode -eq 'slow') {
    $jobs = $slowJobs
  } elseif ($Mode -eq 'spcfc') {
    $jobs = $spcfcJobs
  } else {
    # full: 매 사이클 fast+self, 24사이클(약 12시간)마다 slow 추가
    $jobs = $fastJobs + $selfJobs
    if ($cycleCount -eq 1 -or ($cycleCount % 24) -eq 0) {
      Write-Host "  (이번 사이클은 slow 그룹도 포함)"
      $jobs += $slowJobs
    }
  }

  foreach ($j in $jobs) {
    Run-Collector -name $j.name -cmdArgs $j.cmdArgs
    # 5/8 IP 차단 사후 — 잡 간 60초 휴식으로 burst 완화
    Start-Sleep -Seconds 60
  }

  if ($Once) { break }

  Write-Host "=== 사이클 $cycleCount 완료, 60분 대기 ==="
  Start-Sleep -Seconds 3600
}
