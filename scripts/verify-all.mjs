// 어제 적용한 변경사항 전체 검증
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function ct(table, fn = q => q) {
  const { count } = await fn(sb.from(table).select('*', { count: 'exact', head: true }));
  return count ?? 0;
}

console.log('=== 1. status 정리 검증 ===');
const sold = await ct('auction_items', q => q.eq('status', 'sold').eq('source', 'court_auction'));
const failed = await ct('auction_items', q => q.eq('status', 'failed').eq('source', 'court_auction'));
console.log(`status='sold' (court_auction): ${sold}건 — 어제 적용 후 327건이었음`);
console.log(`status='failed': ${failed}건 — 어제 +973 추가됨`);
console.log(sold === 327 ? '✅ 그대로 유지' : `⚠️ 변동 ${sold - 327}건`);

console.log('\n=== 2. auction_results cleanup 검증 ===');
const resultsTotal = await ct('auction_results');
const resultsNull = await ct('auction_results', q => q.is('auction_item_id', null));
const resultsHasItem = resultsTotal - resultsNull;
console.log(`총 row: ${resultsTotal} — 어제 정리 후 1343건`);
console.log(`auction_item_id NULL (orphan): ${resultsNull} — 어제 1003건`);
console.log(`auction_item_id 매핑됨: ${resultsHasItem} — 어제 340건`);

// 중복 재발 확인
const { data: allRes } = await sb.from('auction_results')
  .select('auction_item_id')
  .not('auction_item_id', 'is', null)
  .limit(2000);
const idCounts = new Map();
for (const r of (allRes || [])) {
  idCounts.set(r.auction_item_id, (idCounts.get(r.auction_item_id) || 0) + 1);
}
const dupes = [...idCounts.values()].filter(c => c > 1).length;
console.log(`auction_item_id 중복: ${dupes}건 — 어제 정리 후 0건이어야`);
console.log(dupes === 0 ? '✅ 중복 없음' : `⚠️ 중복 발견 ${dupes}건 — UNIQUE constraint 미적용?`);

console.log('\n=== 3. AVM 매칭 로직 검증 ===');
console.log('차량 sample 5건의 매칭 키 + 가능한 comps 수');
const { data: sampleItems } = await sb.from('auction_items')
  .select('case_number, raw_data, vehicle_details(maker, model, year)')
  .eq('category', 'vehicle')
  .eq('source', 'court_auction')
  .gte('auction_date', new Date().toISOString())
  .order('auction_date')
  .limit(5);

for (const it of (sampleItems || [])) {
  const v = Array.isArray(it.vehicle_details) ? it.vehicle_details[0] : it.vehicle_details;
  const maker = v?.maker;
  const model = v?.model;
  const carNm = it.raw_data?.carNm;
  const matchKey = maker || (model ? model.split(/[\s(]/)[0].trim() : null) || carNm?.split(/[\s(]/)[0]?.trim() || null;
  const year = v?.year;

  let q = sb.from('auction_results')
    .select('id', { count: 'exact', head: true })
    .eq('category', 'vehicle')
    .gt('winning_price', 0)
    .gt('bid_ratio', 0);
  if (matchKey) q = q.ilike('vehicle_name', `%${matchKey}%`);
  if (year) q = q.gte('vehicle_year', year - 2).lte('vehicle_year', year + 2);
  const { count } = await q;

  console.log(`  [${it.case_number}] matchKey="${matchKey}" year=${year} → comps=${count}건`);
}

console.log('\n=== 4. 감정평가서 사진 필터 검증 ===');
// _photos_source='aeeWevl_pdf' 인 차량 매물 중 _photos에 들어있는 source 분포
const { data: pdfPhotoItems } = await sb.from('auction_items')
  .select('case_number, raw_data')
  .eq('category', 'vehicle')
  .eq('raw_data->_photos_source', '"aeeWevl_pdf"')
  .limit(3);
console.log(`_photos_source=aeeWevl_pdf 매물 ${pdfPhotoItems?.length ?? 0}건 (sample)`);
for (const it of (pdfPhotoItems || [])) {
  const photos = it.raw_data?._photos || [];
  const sources = [...new Set(photos.map(p => p.source))];
  console.log(`  [${it.case_number}] 사진 ${photos.length}장, source: ${sources.join(', ')}`);
}

console.log('\n=== 5. 백필 진척 모니터 issue 작성됐는지 ===');
// gh CLI로 확인하는 게 더 정확하지만 여기선 skip
console.log('  (gh CLI로 별도 확인: gh issue list --label monitoring --limit 5)');
