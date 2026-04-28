// KB차차차 시세 수집 스텁
// 공식 API 없음 - 크롤링 가능성 조사 후 구현 예정
// 대안: 엔카 오픈API, 헤이딜러 API 문의

export async function fetchKbPrice(maker, model, year, mileageKm) {
  // TODO: 공식 채널 확보 후 구현
  throw new Error('kb-chachacha-price: not implemented');
}

if (process.argv[1]?.endsWith('kb-chachacha-price.js')) {
  console.log('[kb] 스텁 - 차량 시세 API 채널 미확보. 엔카·헤이딜러·올리브영과 API 제휴 필요.');
}
