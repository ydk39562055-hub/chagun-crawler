// 백필 진척 점검 — 매일 GH Actions에서 돌고 issue로 보고
//   로컬 실행: node backfill-stats.mjs   (dotenv로 .env 읽음)
//   GH 실행:   secrets로 env 주입 — dotenv 호출은 .env 없을 때 무시됨
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const today = new Date();
const ninetyDaysLater = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
const isoNow = today.toISOString();
const iso90 = ninetyDaysLater.toISOString();

async function count(table, filter = (q) => q) {
  const { count, error } = await filter(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  return count;
}

function pct(num, denom) {
  if (!denom) return '0.0%';
  return ((num / denom) * 100).toFixed(1) + '%';
}

console.log(`기준일: ${isoNow.slice(0, 10)} (90일 윈도우: ~${iso90.slice(0, 10)})\n`);

// 1. 총 매물 (90일 윈도우 + 법원 source)
const courtRealTotal = await count('auction_items', (q) =>
  q.eq('category', 'real_estate').like('source', 'court%').gte('auction_date', isoNow).lte('auction_date', iso90),
);
const courtVehicleTotal = await count('auction_items', (q) =>
  q.eq('category', 'vehicle').like('source', 'court%').gte('auction_date', isoNow).lte('auction_date', iso90),
);

// 온비드
const onbidVehicleTotal = await count('auction_items', (q) =>
  q.eq('category', 'vehicle').eq('source', 'onbid'),
);
const onbidReTotal = await count('auction_items', (q) =>
  q.eq('category', 'real_estate').eq('source', 'onbid'),
);

console.log('=== 매물 풀 ===');
console.log(`법원 부동산 (90일 내):     ${courtRealTotal.toLocaleString()}건`);
console.log(`법원 차량 (90일 내):       ${courtVehicleTotal.toLocaleString()}건`);
console.log(`온비드 차량 (전체):        ${onbidVehicleTotal.toLocaleString()}건`);
console.log(`온비드 부동산 (전체):      ${onbidReTotal.toLocaleString()}건`);

// 2. 사진 채워진 비율 (법원, 90일)
const courtRealWithPhoto = await count('auction_items', (q) =>
  q.eq('category', 'real_estate').like('source', 'court%').gte('auction_date', isoNow).lte('auction_date', iso90).not('thumbnail_url', 'is', null),
);
const courtVehicleWithPhoto = await count('auction_items', (q) =>
  q.eq('category', 'vehicle').like('source', 'court%').gte('auction_date', isoNow).lte('auction_date', iso90).not('thumbnail_url', 'is', null),
);

console.log('\n=== 사진(thumbnail_url) ===');
console.log(`법원 부동산:  ${courtRealWithPhoto.toLocaleString()}/${courtRealTotal.toLocaleString()} (${pct(courtRealWithPhoto, courtRealTotal)})`);
console.log(`법원 차량:    ${courtVehicleWithPhoto.toLocaleString()}/${courtVehicleTotal.toLocaleString()} (${pct(courtVehicleWithPhoto, courtVehicleTotal)})`);

// 3. detail 테이블 채워진 비율
// vehicle_details
const vehicleDetailTotal = await count('vehicle_details');
console.log('\n=== detail 테이블 ===');
console.log(`vehicle_details:        ${vehicleDetailTotal.toLocaleString()}건`);

// real_estate_details
const reDetailTotal = await count('real_estate_details');
console.log(`real_estate_details:    ${reDetailTotal.toLocaleString()}건`);

// 4. PDF / 등기 요약 — JSONB 경로별 PostgREST 'not is null' 필터
//    경로: raw_data._detail.<key>
async function jsonbCount(category, jsonbPath) {
  const { count, error } = await supabase
    .from('auction_items')
    .select('*', { count: 'exact', head: true })
    .eq('category', category)
    .like('source', 'court%')
    .gte('auction_date', isoNow)
    .lte('auction_date', iso90)
    .not(jsonbPath, 'is', null);
  if (error) {
    console.log(`  ! ${jsonbPath} 쿼리 에러: ${error.message}`);
    return null;
  }
  return count;
}

console.log('\n=== 90일 법원 매물의 _detail.* 채워진 건수 ===');
const pdfChecks = [
  ['매각PDF (spcfc)', 'raw_data->_detail->dspslGdsSpcfcPdf'],
  ['감정평가서 PDF (aeeWevlPdf)', 'raw_data->_detail->aeeWevlPdf'],
  ['문건/송달 PDF (docsSnapPdf)', 'raw_data->_detail->docsSnapPdf'],
  ['문건/송달 JSON (docsSnapJson)', 'raw_data->_detail->docsSnapJson'],
  ['현황조사서 JSON (curstExmn)', 'raw_data->_detail->curstExmn'],
  ['현황조사서 PDF (curstExmnPdf)', 'raw_data->_detail->curstExmnPdf'],
  ['등기요약 (rgstSummary)', 'raw_data->_detail->rgstSummary'],
  ['등기요약 atSale', 'raw_data->_detail->rgstSummary->atSale'],
  ['등기요약 atAppraisal', 'raw_data->_detail->rgstSummary->atAppraisal'],
];

console.log('\n[부동산]');
for (const [label, path] of pdfChecks) {
  const n = await jsonbCount('real_estate', path);
  if (n != null) console.log(`  ${label}: ${n.toLocaleString()}/${courtRealTotal.toLocaleString()} (${pct(n, courtRealTotal)})`);
}

console.log('\n[차량]');
const vehicleChecks = [
  ['매각PDF (spcfc)', 'raw_data->_detail->dspslGdsSpcfcPdf'],
  ['감정평가서 PDF (aeeWevlPdf)', 'raw_data->_detail->aeeWevlPdf'],
  ['문건/송달 (docsSnap)', 'raw_data->_detail->docsSnap'],
  ['차량 detail (parsedSpcfc)', 'raw_data->_detail->parsedSpcfc'],
];
for (const [label, path] of vehicleChecks) {
  const n = await jsonbCount('vehicle', path);
  if (n != null) console.log(`  ${label}: ${n.toLocaleString()}/${courtVehicleTotal.toLocaleString()} (${pct(n, courtVehicleTotal)})`);
}

// 6. status 분포 (법원 부동산, 90일)
const { data: statusDist } = await supabase
  .from('auction_items')
  .select('status')
  .eq('category', 'real_estate')
  .like('source', 'court%')
  .gte('auction_date', isoNow)
  .lte('auction_date', iso90)
  .limit(50000);

if (statusDist) {
  const sc = {};
  for (const r of statusDist) sc[r.status] = (sc[r.status] || 0) + 1;
  console.log('\n=== 법원 부동산 status (90일) ===');
  for (const [s, n] of Object.entries(sc).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n.toLocaleString()}`);
  }
}

// 7. 최근 24시간 신규/수정
const oneDayAgo = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();
const newLast24h = await count('auction_items', (q) =>
  q.gte('created_at', oneDayAgo).like('source', 'court%'),
);
const updatedLast24h = await count('auction_items', (q) =>
  q.gte('updated_at', oneDayAgo).like('source', 'court%'),
);
console.log('\n=== 최근 24h 활동 (법원) ===');
console.log(`신규 등록: ${newLast24h.toLocaleString()}건`);
console.log(`업데이트:  ${updatedLast24h.toLocaleString()}건`);
