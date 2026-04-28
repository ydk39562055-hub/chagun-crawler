// 차량 case 상세 수집기 — /pgj/pgj15A/selectAuctnCsSrchRslt.on (경매사건검색 API)
//
// 반환 주요 필드:
//   dma_csBasInf           — 사건 기본 (법원명, 사건번호, 사건명, 채권금액, 재판부)
//   dlt_dspslGdsDspslObjctLst — 매각물건(차량) 리스트 (차종·차량번호·연식·차대번호·감정가·매각물건명세서 ecdocId)
//   dlt_rletCsGdsDtsDxdyInf — 매각기일 정보
//   dlt_rletCsIntrpsLst    — 이해관계인 (채권자/채무자/소유자, 이름 마스킹됨)
//
// 실행:
//   node collectors/court-vehicle-case-collect.js --case 2025타경102224 --boCd B000414 --dry
//   node collectors/court-vehicle-case-collect.js --upsert --limit 5
//   node collectors/court-vehicle-case-collect.js --upsert --case 2025타경102224

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = 'https://www.courtauction.go.kr/pgj/pgj15A/selectAuctnCsSrchRslt.on';
const HOME = 'https://www.courtauction.go.kr/pgj/index.on';
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const UA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPSERT = args.includes('--upsert');
const LIMIT = parseInt(argOf('--limit', '5'), 10) || 5;
const CASE_NUMBER = argOf('--case', null);
const BO_CD_OVERRIDE = argOf('--boCd', null);

async function cookie() {
  const r = await fetch(HOME, { headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR' } });
  const raw = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

async function fetchCase(ck, cortOfcCd, csNo, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'User-Agent': UA(),
          'Accept': 'application/json',
          'Referer': HOME,
          'Origin': 'https://www.courtauction.go.kr',
          'Cookie': ck,
        },
        body: JSON.stringify({ dma_srchCsDtlInf: { cortOfcCd, csNo } }),
      });
      const j = await r.json();
      if (j.status !== 200) throw new Error(`api-${j.status}: ${j.message || ''}`);
      if (!j.data?.dma_csBasInf) throw new Error('no-csBasInf');
      return j.data;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw lastErr;
}

function parseBldDtlDts(text) {
  // "차종 : 승용 대형\n용도 : 자가용\n원동기형식 : G4KR\n차대번호 : KMTHA81BDLU014130\n연식 : 2020\n최초등록일 : 2020-05-25\n보관장소 : ...\n보관방법 : ..."
  if (!text) return {};
  const lines = String(text).split(/\r?\n/);
  const out = {};
  for (const ln of lines) {
    const m = ln.match(/^([^:]+?)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key === '차종') out.carType = val;
    else if (key === '용도') out.usage = val;
    else if (key === '원동기형식') out.engineModel = val;
    else if (key === '차대번호') out.vin = val;
    else if (key === '연식') out.year = val;
    else if (key === '최초등록일') out.firstRegistered = val;
    else if (key === '보관장소') out.storagePlace = val;
    else if (key === '보관방법') out.storageMethod = val;
  }
  return out;
}

function extractVehicleInfo(data) {
  const base = data.dma_csBasInf || {};
  const obj = data.dlt_dspslGdsDspslObjctLst?.[0] || {};
  const parsedVehicle = parseBldDtlDts(obj.bldDtlDts);
  const schedule = data.dlt_rletCsGdsDtsDxdyInf || [];
  const parties = data.dlt_rletCsIntrpsLst || [];
  const spcfcEcdocId = obj.dspslGdsSpcfcEcdocId || null;
  const pbancEcdocId = obj.dspslDxdyPbancEcdocId || null;

  return {
    csBasInf: base,
    mainObjct: obj, // 첫 매각물건 (차량 본체)
    allObjcts: data.dlt_dspslGdsDspslObjctLst || [],
    parsedVehicle, // 파싱된 차량 제원
    schedule,
    parties,
    spcfcEcdocId, // 매각물건명세서 PDF 고유 ID
    pbancEcdocId, // 매각공고 PDF 고유 ID
    fetched_at: new Date().toISOString(),
  };
}

async function pickItems(supabase) {
  let q = supabase
    .from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction')
    .eq('category', 'vehicle');
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  else {
    q = q.is('thumbnail_url', null).order('auction_date', { ascending: true, nullsFirst: false }).limit(LIMIT * 2);
  }
  const { data, error } = await q;
  if (error) throw error;
  // 사건번호 단위 그룹핑 (첫 row만)
  const seen = new Set();
  const out = [];
  for (const d of data || []) {
    if (seen.has(d.case_number)) continue;
    seen.add(d.case_number);
    out.push(d);
    if (out.length >= LIMIT) break;
  }
  return out;
}

async function main() {
  console.log(`차량 case 수집기 (upsert=${DO_UPSERT}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE env missing'); process.exit(1); }
  const supabase = createClient(url, key);

  const items = await pickItems(supabase);
  if (!items.length) { console.log('대상 없음'); return; }
  console.log(`대상 ${items.length}건`);

  const ck = await cookie();
  console.log('쿠키 OK');

  let ok = 0, fail = 0;
  for (const it of items) {
    const raw = it.raw_data || {};
    const cortOfcCd = BO_CD_OVERRIDE || raw.boCd;
    const csNo = it.case_number; // pgj15A는 사건번호 표기(2025타경102224) 수용
    try {
      console.log(`\n→ ${it.case_number} (boCd=${cortOfcCd})`);
      const d = await fetchCase(ck, cortOfcCd, csNo);
      const info = extractVehicleInfo(d);
      console.log(`   차종=${info.parsedVehicle.carType || '-'} 연식=${info.parsedVehicle.year || '-'} VIN=${info.parsedVehicle.vin || '-'}`);
      console.log(`   감정가=${(info.mainObjct.aeeEvlAmt || 0).toLocaleString()}원 최저=${(info.mainObjct.fstPbancLwsDspslPrc || 0).toLocaleString()}원`);
      console.log(`   매각물건명세서ID=${info.spcfcEcdocId?.slice(0, 20) || '없음'}`);
      console.log(`   이해관계인=${info.parties.length}명 매각기일=${info.schedule.length}건`);

      if (DO_UPSERT) {
        const newRaw = {
          ...raw,
          _detail: {
            ...(raw._detail || {}),
            base: info.csBasInf,
            goods: info.mainObjct,
            gdsDspslObjctLst: info.allObjcts,
            parsedVehicle: info.parsedVehicle,
            schedule: info.schedule,
            parties: info.parties,
            spcfcEcdocId: info.spcfcEcdocId,
            pbancEcdocId: info.pbancEcdocId,
            fetched_at: info.fetched_at,
          },
        };
        const { error: upErr } = await supabase
          .from('auction_items')
          .update({ raw_data: newRaw })
          .eq('case_number', it.case_number)
          .eq('source', 'court_auction')
          .eq('category', 'vehicle');
        if (upErr) { console.log('   DB 업데이트 실패:', upErr.message); fail++; continue; }
        console.log('   DB 저장 완료');
      }
      ok++;
    } catch (e) {
      console.log(`   실패: ${e.message}`);
      fail++;
    }
    await sleep(3000 + Math.random() * 2000);
  }

  console.log(`\n완료: 성공 ${ok}건, 실패 ${fail}건`);
  if (!DO_UPSERT) console.log('(--upsert 없으면 DB 저장 안 됨)');
}

main().catch(e => { console.error(e); process.exit(1); });
