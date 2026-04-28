// 법원경매 물건 상세 조회 (사진·내역·감정평가서 정보)
// 목록에서 받은 docid 로 상세 엔드포인트 호출
// 탐색 결과 후속 개발 예정 — 지금은 스텁
//
// 추정 엔드포인트 (목록 API 분석에서 힌트):
//   POST /pgj/pgj111/selectGdsDspslDtlSrch.on  (물건 상세)
//   POST /pgj/pgj111/selectGdsDspslPhtInf.on   (사진)
//   POST /pgj/pgj111/selectGdsDspslFileInf.on  (첨부파일 목록)
//
// TODO: 실제 네트워크 캡처로 엔드포인트·페이로드 확정 필요

import 'dotenv/config';

const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

export async function fetchDetail(docid, boCd, saNo, maemulSer, mokmulSer) {
  // TODO: 상세 API 페이로드 리버스 필요
  throw new Error('court-detail: 미구현. 사이트 상세 페이지 네트워크 캡처 후 개발');
}

if (process.argv[1]?.endsWith('court-detail.js')) {
  console.log('court-detail: 스텁. 다음 단계에서 상세 API 캡처 후 구현');
}
