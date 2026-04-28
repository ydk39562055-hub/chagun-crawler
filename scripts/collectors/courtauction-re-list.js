// 대법원 경매정보(courtauction.go.kr) 부동산 물건목록 수집기 - 스텁
// 작성일: 2026-04-15
// TODO: 대법원은 공식 OpenAPI 없음 → HTML 파싱 or 조사 후 정식 채널 확인 필요
// 현재: 구조만 잡아둠. 실제 수집 로직은 미구현.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * 대법원 경매 물건 1건을 수집해 Supabase 에 upsert.
 * @param {object} raw - 원본 HTML/JSON 파싱 결과
 */
export async function upsertCourtProperty(raw) {
  // 1) auction_items 공용 부모 upsert
  const item = {
    category: 'real_estate',
    source: 'court_auction',
    source_item_id: raw.caseNumber,         // 사건번호 (예: 2024타경1234)
    case_number: raw.caseNumber,
    title: raw.title,
    appraisal_price: raw.appraisalPrice,
    min_bid_price: raw.minBidPrice,
    fail_count: raw.failCount ?? 0,
    auction_date: raw.auctionDate,
    status: 'upcoming',
    raw_data: raw,
  };
  const { data: inserted, error } = await supabase
    .from('auction_items')
    .upsert(item, { onConflict: 'source,source_item_id' })
    .select('id')
    .single();
  if (error) throw error;

  // 2) real_estate_details upsert
  const detail = {
    auction_item_id: inserted.id,
    property_type: raw.propertyType,        // 'apartment' 등
    address_road: raw.addressRoad,
    address_jibun: raw.addressJibun,
    sido: raw.sido,
    sigungu: raw.sigungu,
    building_name: raw.buildingName,
    dong_no: raw.dongNo,
    ho_no: raw.hoNo,
    area_m2: raw.areaM2,
    floor: raw.floor,
    total_floors: raw.totalFloors,
    build_year: raw.buildYear,
    photos: raw.photos ?? [],
  };
  await supabase
    .from('real_estate_details')
    .upsert(detail, { onConflict: 'auction_item_id' });

  return inserted.id;
}

async function main() {
  console.log('[court-re-list] 스텁 실행 - 실제 수집 로직 미구현');
  console.log('해야 할 일:');
  console.log('  1) 대법원 경매정보 포털 URL 스펙 조사');
  console.log('  2) robots.txt · 이용약관 확인 (상업적 수집 가능 여부)');
  console.log('  3) 가능하면 공공데이터포털에 "법원경매" API 신청 경로 탐색');
  console.log('  4) 페이지네이션·상세페이지 파싱 구현');
}

if (process.argv[1]?.endsWith('courtauction-re-list.js')) main();
