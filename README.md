# chagun-crawler

법원경매(courtauction.go.kr)·온비드(공공데이터포털) 자동 수집 워크플로.

비공개 차근경매 메인 레포(`chagun-auction`)에서 크롤링 부분만 분리한 public 레포 — GitHub Actions 무제한 무료 한도를 활용하기 위함.

## 구조

```
.github/workflows/   GitHub Actions 워크플로 (스케줄/수동)
scripts/             크롤링 스크립트 (Node.js + Playwright)
  ├── collectors/    수집기 본체
  ├── lib/           공용 유틸
  └── package.json
```

## 워크플로 스케줄 (KST)

| 워크플로 | 시각 | 주기 |
|---|---|---|
| `court-cron.yml` | 03:00 | 매일 |
| `court-daily-light.yml` | 04:00 | 매일 |
| `court-daily-realestate.yml` | 04:30 | 매일 |
| `pdf-capture.yml` | 05:00 | 매일 |
| `court-vehicle-altday.yml` | 05:30 | 격일(홀수일) |
| `onbid-collect.yml` | 06:00 | 매일 |

수동 트리거: `capture-detail`, `court-probe`, `photo-probe`, `photo-rehost`, `pdf-parse`.

## 환경변수

워크플로 실행에 필요한 GitHub Secrets — 레포 Settings → Secrets and variables → Actions:

- `SUPABASE_URL` — Supabase 프로젝트 URL
- `SUPABASE_SERVICE_ROLE_KEY` — 서버 전용 키
- `GEMINI_API_KEY` — Gemini API 키 (감정평가서 OCR/분석용)
- `ONBID_API_KEY` — 공공데이터포털 인증키 (Encoding 버전)
- `ONBID_REAL_ESTATE_API_URL` — 온비드 부동산 API URL (선택)

## 데이터 흐름

```
크롤링 (이 레포, 무료)  →  Supabase  →  웹앱 (chagun-auction private)
```

이 레포는 데이터를 Supabase 에 적재하기만 함. 사용자 인터페이스, 권리분석 알고리즘, 비즈니스 로직은 별도 private 레포에 있음.

## 라이선스

내부 운영용 — 외부 기여 받지 않습니다.
