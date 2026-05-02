// auction_results 정리 — Plan A
//   1) 단순 중복 44건 삭제 (같은 auction_item_id 가진 row 2개 → 더 오래된 것 삭제)
//   2) orphan 1,016건의 case_number → auction_items.case_number 로 auction_item_id 매칭 시도
//
// 실행: node cleanup-results.mjs --dry
//       node cleanup-results.mjs --apply

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log(`auction_results cleanup (apply=${APPLY})`);

// 페이지네이션 헬퍼
async function fetchAll(table, sel, filter) {
  let all = [];
  let offset = 0;
  while (true) {
    let q = sb.from(table).select(sel).order('id', { ascending: true }).range(offset, offset + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) break;
    all = all.concat(data);
    offset += data.length;
    if (data.length < 1000) break;
  }
  return all;
}

// === 단계 1: 단순 중복 정리 ===
console.log('\n=== [1/3] 단순 중복 정리 ===');
const allRows = await fetchAll('auction_results', 'id, auction_item_id, recorded_at, auction_date');
console.log(`  전체 row: ${allRows.length}`);

const byItem = new Map();
for (const r of allRows) {
  if (!r.auction_item_id) continue;
  if (!byItem.has(r.auction_item_id)) byItem.set(r.auction_item_id, []);
  byItem.get(r.auction_item_id).push(r);
}

const dupesToDelete = [];
for (const arr of byItem.values()) {
  if (arr.length <= 1) continue;
  // 가장 최근 auction_date의 row만 남기고 나머지 삭제
  arr.sort((a, b) => (b.auction_date ?? '').localeCompare(a.auction_date ?? '') || (b.recorded_at ?? '').localeCompare(a.recorded_at ?? ''));
  for (let i = 1; i < arr.length; i++) dupesToDelete.push(arr[i].id);
}
console.log(`  중복 row 삭제 대상: ${dupesToDelete.length}건`);

if (APPLY && dupesToDelete.length) {
  const CHUNK = 100;
  let done = 0;
  for (let i = 0; i < dupesToDelete.length; i += CHUNK) {
    const chunk = dupesToDelete.slice(i, i + CHUNK);
    const { error } = await sb.from('auction_results').delete().in('id', chunk);
    if (error) { console.error(`  chunk ${i}: ${error.message}`); break; }
    done += chunk.length;
    process.stdout.write(`\r  삭제 진행: ${done}/${dupesToDelete.length}`);
  }
  console.log(`\n  완료: ${done}건 삭제`);
}

// === 단계 2: orphan auction_item_id 매칭 ===
console.log('\n=== [2/3] orphan auction_item_id 매칭 ===');
const orphans = await fetchAll('auction_results', 'id, category, case_number, vehicle_name, re_address_snapshot, winning_price, auction_date',
  q => q.is('auction_item_id', null));
console.log(`  orphan rows: ${orphans.length}`);

const withCaseNo = orphans.filter(r => r.case_number);
console.log(`  case_number 있는 것: ${withCaseNo.length}/${orphans.length}`);

// case_number 별로 auction_items 조회
const caseNumbers = [...new Set(withCaseNo.map(r => r.case_number))];
console.log(`  unique case_number: ${caseNumbers.length}`);

// auction_items 한꺼번에 조회 (in 절)
const itemsByCase = new Map();
const CASE_CHUNK = 200;
for (let i = 0; i < caseNumbers.length; i += CASE_CHUNK) {
  const chunk = caseNumbers.slice(i, i + CASE_CHUNK);
  const { data, error } = await sb.from('auction_items')
    .select('id, case_number, category, address, raw_data')
    .in('case_number', chunk);
  if (error) throw error;
  for (const it of (data || [])) {
    if (!itemsByCase.has(it.case_number)) itemsByCase.set(it.case_number, []);
    itemsByCase.get(it.case_number).push(it);
  }
}
console.log(`  auction_items 매칭 사건 수: ${itemsByCase.size}`);

// 매칭 시도
const matched = [];   // {orphan_id, item_id}
let multiMatch = 0, noMatch = 0;
for (const r of withCaseNo) {
  const cands = itemsByCase.get(r.case_number) || [];
  if (cands.length === 0) { noMatch++; continue; }
  if (cands.length === 1) {
    matched.push({ orphan_id: r.id, item_id: cands[0].id });
    continue;
  }
  // 같은 case_number 여러 매물 — category + address/carNm 으로 좁힘
  const filteredByCat = cands.filter(c => c.category === r.category);
  if (filteredByCat.length === 1) {
    matched.push({ orphan_id: r.id, item_id: filteredByCat[0].id });
    continue;
  }
  if (r.category === 'real_estate' && r.re_address_snapshot) {
    const addrMatch = filteredByCat.find(c => c.address && c.address.includes(r.re_address_snapshot.slice(0, 15)));
    if (addrMatch) { matched.push({ orphan_id: r.id, item_id: addrMatch.id }); continue; }
  }
  if (r.category === 'vehicle' && r.vehicle_name) {
    const carName = r.vehicle_name.split(/\s/)[0];
    const carMatch = filteredByCat.find(c => c.raw_data?.carNm?.includes(carName));
    if (carMatch) { matched.push({ orphan_id: r.id, item_id: carMatch.id }); continue; }
  }
  multiMatch++;
}
console.log(`  매칭 성공: ${matched.length}`);
console.log(`  case_number만 있는데 auction_items에 없음: ${noMatch}`);
console.log(`  여러 매물 매칭 모호: ${multiMatch}`);
console.log(`  case_number 없음: ${orphans.length - withCaseNo.length}`);

if (APPLY && matched.length) {
  let done = 0;
  for (const m of matched) {
    const { error } = await sb.from('auction_results').update({ auction_item_id: m.item_id }).eq('id', m.orphan_id);
    if (error) {
      // unique constraint 위반 가능 — 같은 auction_item_id 이미 다른 row 가졌을 때
      if (!error.message.includes('duplicate')) console.error(`  ${m.orphan_id}: ${error.message}`);
    } else done++;
    if ((done + 1) % 50 === 0) process.stdout.write(`\r  매칭 진행: ${done}/${matched.length}`);
  }
  console.log(`\n  완료: ${done}건 auction_item_id 채움`);
}

// === 단계 3: 최종 통계 ===
console.log('\n=== [3/3] 최종 통계 ===');
const { count: total } = await sb.from('auction_results').select('*', { count: 'exact', head: true });
const { count: nulls } = await sb.from('auction_results').select('*', { count: 'exact', head: true }).is('auction_item_id', null);
console.log(`  auction_results 총: ${total}`);
console.log(`  auction_item_id NULL: ${nulls} (${total ? ((nulls/total)*100).toFixed(1) : 0}%)`);
console.log(`  auction_item_id 매핑됨: ${total - nulls}`);

if (!APPLY) console.log('\n--apply 추가하면 실제 변경 적용됨');
