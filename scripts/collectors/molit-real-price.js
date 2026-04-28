// 국토부 실거래가 공개시스템 - 아파트 매매 실거래가 수집 스텁
// 공공데이터포털: "아파트매매 실거래 상세 자료" (getRTMSDataSvcAptTradeDev)
// 작성일: 2026-04-15

import 'dotenv/config';

const API_KEY = process.env.MOLIT_API_KEY;
const BASE = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';

/**
 * @param {string} lawdCd - 지역코드 5자리 (예: '11680' 강남구)
 * @param {string} dealYmd - 거래년월 YYYYMM
 */
export async function fetchAptTrades(lawdCd, dealYmd, pageNo = 1, numOfRows = 100) {
  // 공공데이터 Encoding 키는 URLSearchParams가 재인코딩해 403 유발 → 디코드 후 삽입
  const decodedKey = decodeURIComponent(API_KEY ?? '');
  const url = new URL(BASE);
  url.searchParams.set('serviceKey', decodedKey);
  url.searchParams.set('LAWD_CD', lawdCd);
  url.searchParams.set('DEAL_YMD', dealYmd);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(numOfRows));

  const res = await fetch(url);
  const text = await res.text();
  // 국토부는 XML 기본 - 파서 필요
  return { status: res.status, text };
}

async function main() {
  if (!API_KEY) {
    console.log('[molit] MOLIT_API_KEY 미설정 - 공공데이터포털 "아파트매매 실거래 상세" 신청 필요');
    return;
  }
  const r = await fetchAptTrades('11680', '202603');
  console.log('[molit] 샘플 호출 결과:', r.status);
  console.log(r.text.slice(0, 400));
}

if (process.argv[1]?.endsWith('molit-real-price.js')) main();
