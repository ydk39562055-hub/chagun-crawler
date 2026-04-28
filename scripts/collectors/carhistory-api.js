// 보험개발원 카히스토리(carhistory.or.kr) 사고이력 조회 스텁
// 공식: 사업자 제휴 API 필요 (개인 API 없음)
// 대안: Auto365(자동차365 정부) - 차대번호로 조회

export async function fetchCarHistory(vin) {
  // TODO: 제휴 승인 후 구현
  throw new Error('carhistory-api: partnership required');
}

if (process.argv[1]?.endsWith('carhistory-api.js')) {
  console.log('[carhistory] 사업자 제휴 필요. 수익 발생 후 도입 예정.');
}
