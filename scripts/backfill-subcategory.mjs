// auction_items.subcategory 백필
//   raw_data.dspslUsgNm 기반 매핑:
//     '자동차' → 'auto'
//     '자동차,중기' → 'auto' (자동차로 보는 게 사용자 검색 의도에 맞음. 중기 포함은 카드 라벨로 표시)
//     '중기' → 'heavy'
//     '기타' → 'etc' (선박 포함)
//     null/빈값 → 'auto' (기본값)
//
// 실행: node backfill-subcategory.mjs --dry
//       node backfill-subcategory.mjs --apply

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function map(usg) {
  if (!usg) return 'auto';
  if (usg === '자동차') return 'auto';
  if (usg === '자동차,중기') return 'auto';
  if (usg === '중기') return 'heavy';
  if (usg === '기타') return 'etc';
  return 'auto';
}

console.log(`Backfill subcategory (apply=${APPLY})`);

let all = [];
let offset = 0;
while (true) {
  const { data, error } = await sb.from('auction_items')
    .select('id, raw_data, subcategory')
    .eq('category', 'vehicle').eq('source', 'court_auction')
    .order('id')
    .range(offset, offset + 999);
  if (error) throw error;
  if (!data?.length) break;
  all = all.concat(data);
  offset += data.length;
  if (data.length < 1000) break;
}
console.log(`vehicle 매물 총: ${all.length}`);

const counts = { auto: [], heavy: [], etc: [], unchanged: 0 };
for (const it of all) {
  const usg = it.raw_data?.dspslUsgNm;
  const target = map(usg);
  if (it.subcategory === target) { counts.unchanged++; continue; }
  counts[target].push(it.id);
}

console.log(`\n매핑 결과:`);
console.log(`  auto: ${counts.auto.length}`);
console.log(`  heavy: ${counts.heavy.length}`);
console.log(`  etc: ${counts.etc.length}`);
console.log(`  변경 없음 (이미 맞음): ${counts.unchanged}`);
console.log(`  → 총 PATCH 대상: ${counts.auto.length + counts.heavy.length + counts.etc.length}`);

if (!APPLY) {
  console.log(`\n--apply 없이 실행 → DB 변경 없음`);
  process.exit(0);
}

const CHUNK = 200;
async function patchGroup(target, ids) {
  let done = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { error } = await sb.from('auction_items').update({ subcategory: target }).in('id', chunk);
    if (error) { console.error(`  ${target} chunk ${i}: ${error.message}`); break; }
    done += chunk.length;
    process.stdout.write(`\r  ${target}: ${done}/${ids.length}`);
  }
  if (ids.length) console.log('');
}

await patchGroup('auto', counts.auto);
await patchGroup('heavy', counts.heavy);
await patchGroup('etc', counts.etc);

// 사후 검증
const { count: a } = await sb.from('auction_items').select('*', { count: 'exact', head: true }).eq('category', 'vehicle').eq('subcategory', 'auto');
const { count: h } = await sb.from('auction_items').select('*', { count: 'exact', head: true }).eq('category', 'vehicle').eq('subcategory', 'heavy');
const { count: e } = await sb.from('auction_items').select('*', { count: 'exact', head: true }).eq('category', 'vehicle').eq('subcategory', 'etc');
console.log(`\n최종: auto=${a} heavy=${h} etc=${e}`);
