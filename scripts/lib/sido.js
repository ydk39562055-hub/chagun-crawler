// 시도 정규화 — 수집기 공용
// 단축형("서울") → 정식("서울특별시") 변환
// 시군구 오값("고양시")이 들어오면 주소 문자열에서 시도를 역추정
// 주소 첫머리에서 시도를 직접 추출하는 fromAddress() 도 제공

export const SIDO_SHORT = {
  '서울': '서울특별시',
  '부산': '부산광역시',
  '대구': '대구광역시',
  '인천': '인천광역시',
  '광주': '광주광역시',
  '대전': '대전광역시',
  '울산': '울산광역시',
  '세종': '세종특별자치시',
  '경기': '경기도',
  '강원': '강원특별자치도',
  '충북': '충청북도',
  '충남': '충청남도',
  '전북': '전북특별자치도',
  '전남': '전라남도',
  '경북': '경상북도',
  '경남': '경상남도',
  '제주': '제주특별자치도',
};

export const SIDO_FULL_SET = new Set(Object.values(SIDO_SHORT));

// 정규화: 단축형·정식형·시군구오값 모두 정식형으로 변환
// 시군구 오값이면 fallbackAddr(주소) 에서 시도 역추정
export function normalizeSido(s, fallbackAddr) {
  if (!s && !fallbackAddr) return null;
  if (s && SIDO_FULL_SET.has(s)) return s;
  if (s && SIDO_SHORT[s]) return SIDO_SHORT[s];
  // 시군구 오값 또는 null → 주소에서 탐색
  if (fallbackAddr) {
    for (const full of SIDO_FULL_SET) {
      if (fallbackAddr.includes(full)) return full;
    }
    for (const short of Object.keys(SIDO_SHORT)) {
      if (fallbackAddr.startsWith(short)) return SIDO_SHORT[short];
    }
  }
  return null;
}

// 주소 문자열에서 시도만 추출 (sido 값이 전혀 없을 때 단독 사용)
export function sidoFromAddress(addr) {
  return normalizeSido(null, addr);
}
