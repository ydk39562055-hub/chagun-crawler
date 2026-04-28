# 차근경매 - 데이터 수집 스크립트

온비드 공매 + 대법원 경매 낙찰가 수집.

## 셋업

### 1. Node.js 설치
Node 20 이상 필요. [nodejs.org](https://nodejs.org) 에서 LTS 버전 설치.

버전 확인:
```bash
node -v
npm -v
```

### 2. 의존성 설치
```bash
cd C:/Users/ydk39/OneDrive/Desktop/my-project/chagun-auction/scripts
npm install
```

### 3. 환경변수 파일 생성
```bash
cp .env.example .env
```

`.env` 파일 열어서 값 채우기:
- `ONBID_API_KEY` = 공공데이터포털 인증키(Encoding)
- `SUPABASE_URL` = 이미 채워짐
- `SUPABASE_SERVICE_ROLE_KEY` = Supabase Settings → API → service_role

> ⚠️ `.env` 파일은 절대 Git에 올리지 마세요. `.gitignore`에 이미 추가됨.

### 4. 첫 테스트 실행 (API 응답 구조 확인)
```bash
npm run test:list
```

→ 콘솔에 응답 JSON/XML 구조가 출력됨. 여기서 필드 이름 확인 후 Supabase 매핑 결정.

## 스크립트 목록

| 명령 | 설명 |
|------|------|
| `npm run test:list` | 차량 물건목록 샘플 5건 가져와서 구조 출력 |
| `npm run collect:list` | 차량 물건목록 전체 수집 → Supabase 저장 |
| `npm run collect:results` | 낙찰 결과 전체 수집 → Supabase 저장 |
| `npm run collect:all` | 전체 파이프라인 순차 실행 |

## 자동화 (나중에)

- 로컬 Windows 작업 스케줄러로 매일 자동 실행
- 또는 Supabase Edge Function + cron (운영 환경)
- 또는 GitHub Actions (이미 macro-report 경험 있음)
