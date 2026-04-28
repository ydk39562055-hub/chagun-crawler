// 온비드 공매 차량 데이터 보강
// 목록 API 응답(raw_data)에 이미 주행거리·배기량·차번호 포함되지만
// VIN·보관장소·색상은 onbidCltrNm(제목) 안에 섞여있음 → 정규식 파싱.
//
// 새 API 호출 없음. DB 읽기 → 파싱 → vehicle_details 업데이트만.
//
// 실행:
//   node collectors/onbid-vehicle-enrich.js                 (미리보기)
//   node collectors/onbid-vehicle-enrich.js --upsert        (DB 반영)
//   node collectors/onbid-vehicle-enrich.js --upsert --limit 200

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPSERT = args.includes('--upsert');
const LIMIT = parseInt(argOf('--limit', '500'), 10) || 500;

// KOR VIN: 영문자 대문자 + 숫자 17자, I/O/Q 제외. 공백 제거한 17자 덩어리.
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{11,17}\b/g;
const VIN_LABEL_RE = /차대번호\s*[:\-]?\s*([A-HJ-NPR-Z0-9 ]{11,22})/;

function extractVIN(text) {
  if (!text) return null;
  const t = String(text);
  const labeled = t.match(VIN_LABEL_RE);
  if (labeled) {
    const v = labeled[1].replace(/\s+/g, '');
    if (v.length >= 11 && v.length <= 17) return v;
  }
  // 차량번호(번호판: 한글+숫자) 와 구분. 영문숫자만 조합
  const cands = t.match(VIN_RE) || [];
  for (const c of cands) {
    // 17자 VIN 우선
    if (c.length === 17) return c;
  }
  return null;
}

// 보관소 추출: "오토마트 XX보관소" / "XX지점" / "XX캠퍼스" 우선
const STORAGE_RE = /(오토마트[^\s(),\[\]]*보관소|[가-힣A-Za-z0-9]+보관소|[가-힣]+지점|[가-힣]+캠퍼스)/;
function extractStorage(text) {
  if (!text) return null;
  const m = String(text).match(STORAGE_RE);
  return m ? m[1].trim() : null;
}

// 색상 추출: "흰색/흑색/은색/회색/검정/빨강/파랑" 등
const COLOR_RE = /(흰색|검정|검은색|은색|회색|빨간색|빨강|파란색|파랑|초록|갈색|노란색|하늘색|은회색|진주색|크림색|펄|블랙|화이트|실버|그레이|블루|레드)/;
function extractColor(text) {
  if (!text) return null;
  const m = String(text).match(COLOR_RE);
  return m ? m[1] : null;
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 보강 대상: vin/storage/color 중 하나라도 null 인 onbid 차량
  const { data: items, error } = await supabase
    .from('auction_items')
    .select('id, title, raw_data, vehicle_details(id, vin, storage_location, color)')
    .eq('source', 'onbid')
    .eq('category', 'vehicle')
    .limit(LIMIT);
  if (error) { console.error(error.message); process.exit(1); }

  let parsed = 0, updated = 0, skipped = 0;
  for (const it of items) {
    const vd = Array.isArray(it.vehicle_details) ? it.vehicle_details[0] : it.vehicle_details;
    if (!vd) { skipped++; continue; }

    // 제목 + onbidCltrNm 둘 다 보강 소스
    const src = [it.title, it.raw_data?.onbidCltrNm].filter(Boolean).join(' | ');
    const vin = vd.vin ?? extractVIN(src);
    const storage = vd.storage_location ?? extractStorage(src);
    const color = vd.color ?? extractColor(src);

    const patch = {};
    if (!vd.vin && vin) patch.vin = vin;
    if (!vd.storage_location && storage) patch.storage_location = storage;
    if (!vd.color && color) patch.color = color;

    if (Object.keys(patch).length === 0) { skipped++; continue; }
    parsed++;

    if (DO_UPSERT) {
      const { error: upErr } = await supabase.from('vehicle_details').update(patch).eq('id', vd.id);
      if (upErr) console.error(`  ${it.id.slice(0,8)} update 실패:`, upErr.message);
      else updated++;
    }

    if (parsed <= 5) console.log(`  [${parsed}] ${it.id.slice(0,8)} ← ${JSON.stringify(patch)}`);
  }

  console.log(`\n대상 ${items.length}건 · 파싱 ${parsed}건 · 업데이트 ${updated}건 · 스킵 ${skipped}건`);
  if (!DO_UPSERT) console.log('(미리보기 - --upsert 로 DB 반영)');
}

main().catch(e => { console.error(e); process.exit(1); });
