// 온비드 공매 차량 물건목록 수집기 (한국자산관리공사 OpenAPI)
// 엔드포인트: GET https://apis.data.go.kr/B010003/OnbidCarListSrvc2/getCarCltrList2
// 필수 파라미터: serviceKey, pageNo, numOfRows, resultType(json), prptDivCd, pvctTrgtYn, dspsMthodCd
// 실행:
//   node collectors/onbid-vehicle-list.js                  (1페이지 미리보기)
//   node collectors/onbid-vehicle-list.js --upsert         (Supabase 저장)
//   node collectors/onbid-vehicle-list.js --upsert --pages 20
//   node collectors/onbid-vehicle-list.js --upsert --all   (전체 페이지 순회)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeSido } from '../lib/sido.js';

const API_KEY = process.env.ONBID_API_KEY;
const BASE_URL = 'https://apis.data.go.kr/B010003/OnbidCarListSrvc2/getCarCltrList2';

if (!API_KEY) {
  console.error('ONBID_API_KEY 누락 (scripts/.env)');
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const DO_UPSERT = args.includes('--upsert');
const ALL = args.includes('--all');
const PAGES = parseInt(argOf('--pages', '1'), 10) || 1;
const PAGE_SIZE = parseInt(argOf('--rows', '100'), 10) || 100;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pageDelay = () => 800 + Math.random() * 400;

// prptDivCd: 0007 압류재산 · 0005 기타일반재산 (공매 차량 주류)
// dspsMthodCd: 0001 매각 (임대 0002 제외)
async function fetchPage(pageNo, attempts = 3) {
  const url = new URL(BASE_URL);
  url.searchParams.set('serviceKey', API_KEY);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(PAGE_SIZE));
  url.searchParams.set('resultType', 'json');
  url.searchParams.set('prptDivCd', '0007,0005');
  url.searchParams.set('pvctTrgtYn', 'N');
  url.searchParams.set('dspsMthodCd', '0001');

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      const json = JSON.parse(text);
      const code = json?.header?.resultCode ?? json?.response?.header?.resultCode;
      const msg = json?.header?.resultMsg ?? json?.response?.header?.resultMsg ?? '';
      if (code !== '00') throw new Error(`API error ${code}: ${msg}`);

      const body = json.body ?? json.response?.body ?? {};
      const raw = body.items?.item ?? [];
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const total = Number(body.totalCount ?? 0);
      return { total, items };
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw lastErr;
}

// 입찰준비중/진행중은 upcoming/ongoing, 개찰완료·유찰·취소 매핑
const STATUS_MAP = {
  '0001': 'upcoming',  // 입찰준비중
  '0002': 'ongoing',   // 입찰진행중
  '0003': 'ongoing',   // 개찰준비중
  '0004': 'sold',      // 개찰완료 (낙찰 기본, 실제 유찰이면 결과 스텝에서 갱신)
  '0005': 'failed',    // 유찰
  '0006': 'canceled',  // 취소
  '0007': 'withdrawn', // 낙찰취소·철회
};

const FUEL_MAP_KO = {
  '휘발유': 'gasoline', '가솔린': 'gasoline',
  '경유': 'diesel', '디젤': 'diesel',
  'LPG': 'lpg', 'LPG(일반형)': 'lpg',
  '하이브리드': 'hybrid',
  '전기': 'ev', '전기차': 'ev',
  '수소': 'hydrogen',
  'CNG': 'cng',
};
function normFuel(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t || t === '-') return null;
  return FUEL_MAP_KO[t] ?? 'other';
}

function normTransmission(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (t.includes('자동')) return 'auto';
  if (t.includes('수동')) return 'manual';
  if (t.includes('CVT')) return 'cvt';
  if (t.includes('DCT')) return 'dct';
  return null;
}

// onbidCltrNm(제목) 에서 VIN·보관소·색상 추출 — 새 API 호출 없음
const VIN_LABEL_RE = /차대번호\s*[:\-]?\s*([A-HJ-NPR-Z0-9 ]{11,22})/;
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const STORAGE_RE = /(오토마트[^\s(),\[\]]*보관소|[가-힣A-Za-z0-9]+보관소|[가-힣]+지점|[가-힣]+캠퍼스)/;
const COLOR_RE = /(흰색|검정|검은색|은색|회색|빨간색|빨강|파란색|파랑|초록|갈색|노란색|하늘색|은회색|진주색|크림색|펄|블랙|화이트|실버|그레이|블루|레드)/;

function extractVIN(text) {
  if (!text) return null;
  const t = String(text);
  const labeled = t.match(VIN_LABEL_RE);
  if (labeled) {
    const v = labeled[1].replace(/\s+/g, '');
    if (v.length >= 11 && v.length <= 17) return v;
  }
  const cands = t.match(VIN_RE) || [];
  return cands[0] || null;
}
const extractStorage = text => (text && String(text).match(STORAGE_RE)?.[1]) || null;
const extractColor = text => (text && String(text).match(COLOR_RE)?.[1]) || null;

// "202604291700" → "2026-04-29T17:00:00+09:00"
function parseOnbidDt(s) {
  if (!s || String(s).length < 12) return null;
  const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
  const h = s.slice(8, 10), mi = s.slice(10, 12);
  return `${y}-${mo}-${d}T${h}:${mi}:00+09:00`;
}

function toAuctionItem(row) {
  const caseNo = row.cltrMngNo || String(row.onbidCltrno);
  const maker = row.cltrMkrNm?.trim() || '';
  const model = (row.carMdlNm || row.carVhknNm || '').trim();
  const year = Number(row.yrmdl) || null;
  const fuel = normFuel(row.fuelCont);

  const titleBits = [
    year && year >= 1980 && year <= 2100 ? `${year}` : null,
    [maker, model].filter(Boolean).join(' ').trim() || '차량',
    fuel,
    (row.lctnSggnm || row.lctnSdnm || '').trim(),
  ].filter(Boolean);

  const address = [row.lctnSdnm, row.lctnSggnm, row.lctnEmdNm].filter(Boolean).join(' ');

  return {
    category: 'vehicle',
    source: 'onbid',
    source_item_id: String(row.onbidCltrno),
    case_number: caseNo,
    title: (row.onbidCltrNm || titleBits.join(' · ')).slice(0, 200) || caseNo,
    appraisal_price: Number(row.apslEvlAmt) || null,
    min_bid_price: Number(row.lowstBidPrcIndctCont) || null,
    fail_count: Number(row.usbdNft) || 0,
    auction_date: parseOnbidDt(row.cltrBidEndDt),
    status: STATUS_MAP[row.pbctStatCd] ?? 'upcoming',
    thumbnail_url: row.thnlImgUrlAdr || null,
    sido: normalizeSido(row.lctnSdnm || '', address),
    sigungu: row.lctnSggnm || '',
    dong: row.lctnEmdNm || '',
    address,
    raw_data: row,
  };
}

function toVehicleDetail(row, auctionItemId) {
  const year = Number(row.yrmdl);
  const title = row.onbidCltrNm || '';
  return {
    auction_item_id: auctionItemId,
    maker: row.cltrMkrNm?.trim() || null,
    model: (row.carMdlNm || row.carVhknNm || '').trim() || null,
    trim: null,
    year: year >= 1980 && year <= 2100 ? year : null,
    mileage_km: Number(row.drvDstc) || null,
    fuel_type: normFuel(row.fuelCont),
    transmission: normTransmission(row.pnsNm),
    color: row.carColrNm?.trim() || extractColor(title),
    vin: extractVIN(title),
    engine_displacement_cc: Number(row.dsvlm) || null,
    auction_round: 1,
    storage_location: extractStorage(title),
  };
}

async function main() {
  console.log(`Onbid 공매 차량 수집 시작 (upsert=${DO_UPSERT}, all=${ALL}, pages=${PAGES}, rows=${PAGE_SIZE})`);

  let supabase = null;
  if (DO_UPSERT) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1); }
    supabase = createClient(url, key);
  }

  // 1페이지로 total 확인
  const first = await fetchPage(1);
  console.log(`전체 ${first.total}건`);
  const totalPages = ALL ? Math.ceil(first.total / PAGE_SIZE) : PAGES;
  console.log(`페이지 순회: 1..${totalPages}`);

  let totalFetched = 0, totalUpserted = 0, totalErrors = 0;

  for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
    let items;
    try {
      const r = pageNo === 1 ? first : await fetchPage(pageNo);
      items = r.items;
      totalFetched += items.length;
      console.log(`  page ${pageNo}: ${items.length}건`);

      if (supabase && items.length) {
        // 같은 onbidCltrno 가 한 페이지에 중복 등장할 수 있음 (공고번호 차수별)
        const seen = new Map();
        for (const r of items) seen.set(String(r.onbidCltrno), r);
        const dedupItems = [...seen.values()];
        const auctionItems = dedupItems.map(toAuctionItem);
        const { data: inserted, error } = await supabase
          .from('auction_items')
          .upsert(auctionItems, { onConflict: 'source,source_item_id' })
          .select('id, source_item_id');
        if (error) { console.error('    upsert error:', error.message); totalErrors++; }
        else {
          totalUpserted += inserted.length;
          const idByKey = new Map(inserted.map(r => [r.source_item_id, r.id]));
          const vdRows = dedupItems
            .map(r => {
              const id = idByKey.get(String(r.onbidCltrno));
              return id ? toVehicleDetail(r, id) : null;
            })
            .filter(Boolean);
          if (vdRows.length) {
            const { error: vdErr } = await supabase
              .from('vehicle_details')
              .upsert(vdRows, { onConflict: 'auction_item_id' });
            if (vdErr) console.error('    vehicle_details upsert error:', vdErr.message);
          }
        }
      } else if (items.length) {
        items.slice(0, 3).forEach(r => {
          console.log(`    · ${r.cltrMngNo} | ${r.cltrMkrNm || ''} ${r.carMdlNm || r.carVhknNm || ''} (${r.yrmdl}) | 감정 ${Number(r.apslEvlAmt).toLocaleString()}원 | 최저 ${Number(r.lowstBidPrcIndctCont).toLocaleString()}원 | ${r.lctnSdnm || ''} ${r.lctnSggnm || ''}`);
        });
      }
      if (pageNo < totalPages) await sleep(pageDelay());
    } catch (e) {
      console.error(`  page ${pageNo} 실패:`, e.message);
      totalErrors++;
    }
  }

  console.log(`\n완료: 수집 ${totalFetched}건, upsert ${totalUpserted}건, 에러 ${totalErrors}회`);
  if (!supabase) console.log('(미리보기 - DB 저장 안 됨. --upsert 플래그로 저장)');
}

main().catch(e => { console.error(e); process.exit(1); });
