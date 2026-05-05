// 온비드 공매 부동산 목록 수집기 — 자동차 버전(onbid-vehicle-list.js)과 동일 패턴.
//
// 사용 API: 한국자산관리공사_공매물건정보 (data.go.kr)
//   - 별도 신청 필요. 자동차용 OnbidCarListSrvc2 와 service code 다름.
//   - 신청 후 .env 에:
//       ONBID_REAL_ESTATE_API_KEY=<발급받은 키>
//       ONBID_REAL_ESTATE_API_URL=<목록 endpoint full URL, 예:
//          https://apis.data.go.kr/1360000/OnbidPbctClturInfoInquireSvc/getPbctClturRealEstateList>
//
// 응답 row → auction_items + real_estate_details 변환은 신청 후 실응답 보고 fine-tune 필요.
// 현재 매핑은 자동차 컬렉터 + 일반적인 onbid 부동산 응답 필드 추정.
//
// 실행:
//   node collectors/onbid-realestate-list.js                  (1페이지 미리보기)
//   node collectors/onbid-realestate-list.js --upsert         (Supabase 저장)
//   node collectors/onbid-realestate-list.js --upsert --pages 20

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeSido } from '../lib/sido.js';

// data.go.kr 인증키는 계정당 1개 공통 → 차량용 ONBID_API_KEY 와 동일 사용 가능.
// (부동산 API 별도 활용신청은 했어야 함. 안 했으면 같은 키로도 거부)
const API_KEY = process.env.ONBID_REAL_ESTATE_API_KEY || process.env.ONBID_API_KEY;
const BASE_URL = process.env.ONBID_REAL_ESTATE_API_URL;

if (!API_KEY) {
  console.error('ONBID_API_KEY 또는 ONBID_REAL_ESTATE_API_KEY 누락');
  process.exit(1);
}
if (!BASE_URL) {
  console.error('ONBID_REAL_ESTATE_API_URL 누락 — 신청 가이드 문서의 목록 endpoint URL 을 .env 에 추가');
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (flag, fb) => { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPSERT = args.includes('--upsert');
const ALL = args.includes('--all');
const PAGES = parseInt(argOf('--pages', '1'), 10) || 1;
const PAGE_SIZE = parseInt(argOf('--rows', '100'), 10) || 100;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pageDelay = () => 800 + Math.random() * 400;

// v2 가이드 기준 재산유형코드:
//   0007 압류재산, 0002 공유재산, 0005 기타일반재산, 0006 유입재산,
//   0008 수탁재산, 0010 국유재산, 0011 공공개발재산, 0013 파산자산
//   (0004 불용품·0003 금융권담보·0010 국유는 동산/대량 — 우선 부동산 핵심만)
const PROP_DIV = process.env.ONBID_REAL_ESTATE_PROP_DIV || '0007,0002,0005,0006,0008,0010,0011,0013';

async function fetchPage(pageNo, attempts = 3) {
  const url = new URL(BASE_URL);
  url.searchParams.set('serviceKey', API_KEY);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(PAGE_SIZE));
  url.searchParams.set('resultType', 'json');
  url.searchParams.set('prptDivCd', PROP_DIV);
  url.searchParams.set('pvctTrgtYn', 'N'); // 필수 — 수의계약 불가 (일반 입찰만)

  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      // 첫 페이지 raw 응답을 일부 출력해서 v2 응답 구조 확인 (XML/JSON·필드명)
      if (pageNo === 1 && i === 1) {
        console.log(`[debug] HTTP ${res.status} ${res.headers.get('content-type') || ''}`);
        console.log(`[debug] body head: ${text.slice(0, 800)}`);
      }
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error(`non-JSON response (start: ${text.slice(0, 200)})`); }
      // v1: header.resultCode / v2: response.header.resultCode / 또 다른 변형: resultCode 루트 / v2 에러: result.resultCode
      const code = json?.header?.resultCode
        ?? json?.response?.header?.resultCode
        ?? json?.result?.resultCode
        ?? json?.resultCode;
      const msg = json?.header?.resultMsg
        ?? json?.response?.header?.resultMsg
        ?? json?.result?.resultMsg
        ?? json?.resultMsg
        ?? '';
      // 정상 코드는 '00' 또는 '0' (data.go.kr 표준이지만 v2는 다를 수 있음)
      if (code !== '00' && code !== '0' && code !== 0) {
        throw new Error(`API error ${code}: ${msg}`);
      }

      const body = json.body ?? json.response?.body ?? json.result?.body ?? json.result ?? json;
      const raw = body.items?.item ?? body.items ?? body.item ?? body.list ?? [];
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return { total: Number(body.totalCount ?? body.total ?? 0), items };
    } catch (e) {
      lastErr = e;
      if (pageNo === 1 && i === 1) console.log(`[debug] parse err: ${e.message}`);
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw lastErr;
}

const STATUS_MAP = {
  '0001': 'upcoming', '0002': 'ongoing', '0003': 'ongoing',
  '0004': 'sold', '0005': 'failed', '0006': 'canceled', '0007': 'withdrawn',
};

function parseOnbidDt(s) {
  if (!s || String(s).length < 12) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:00+09:00`;
}

// 부동산 row → auction_items.
// 응답 필드명은 추정이라 실제 신청 후 1페이지 확인 후 조정 필요.
function toAuctionItem(row) {
  const caseNo = row.cltrMngNo || String(row.onbidCltrno);
  const address = [row.lctnSdnm, row.lctnSggnm, row.lctnEmdNm, row.lctnDtl]
    .filter(Boolean).join(' ').trim();
  return {
    category: 'real_estate',
    source: 'onbid',
    source_item_id: String(row.onbidCltrno),
    case_number: caseNo,
    title: (row.onbidCltrNm || row.cltrNm || address || caseNo).slice(0, 200),
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

// 온비드 부동산 카테고리(국문) → DB enum 매핑
// scls(소분류) 우선, 없으면 mcls(중분류)로 폴백.
const SCLS_TO_TYPE = {
  '아파트': 'apartment',
  '오피스텔': 'officetel',
  '연립주택': 'multi_family',
  '다세대주택': 'multi_family',
  '다가구주택': 'multi_family',
  '도시형생활주택': 'multi_family',
  '기숙사': 'multi_family',
  '단독주택': 'house',
  '기타주거용건물': 'house',
  '상가주택': 'house',
};
const MCLS_TO_TYPE = {
  '주거용건물': 'house',
  '상가용및업무용건물': 'commercial',
  '용도복합용건물': 'commercial',
  '산업용및기타특수용건물': 'commercial',
  '토지': 'land',
};
function mapPropertyType(row) {
  const scls = row.cltrUsgSclsCtgrNm;
  if (scls && SCLS_TO_TYPE[scls]) return SCLS_TO_TYPE[scls];
  const mcls = row.cltrUsgMclsCtgrNm;
  if (mcls && MCLS_TO_TYPE[mcls]) return MCLS_TO_TYPE[mcls];
  return 'etc';
}

function toRealEstateDetail(row, auctionItemId) {
  return {
    auction_item_id: auctionItemId,
    property_type: mapPropertyType(row),
    floor: row.flrCnt || null,
    area_m2: Number(row.bldSqms ?? row.bldArea ?? row.totArea) || null,
    land_area_m2: Number(row.landSqms ?? row.lndAr) || null,
    build_year: Number(row.bldngCmpltYr) || null,
  };
}

async function processItems(supabase, items) {
  let upserted = 0, skipped = 0;
  // 같은 onbidCltrno 중복 row 제거 (공고 차수별 중복 등장)
  const seen = new Map();
  for (const r of items) seen.set(String(r.onbidCltrno), r);
  const dedup = [...seen.values()];
  for (const row of dedup) {
    const item = toAuctionItem(row);
    if (!item.source_item_id || !item.case_number) { skipped++; continue; }
    const { data: saved, error: e1 } = await supabase
      .from('auction_items')
      .upsert(item, { onConflict: 'source,source_item_id' })
      .select('id').single();
    if (e1) { console.log('upsert err:', e1.message); skipped++; continue; }
    const detail = toRealEstateDetail(row, saved.id);
    const { error: e2 } = await supabase
      .from('real_estate_details')
      .upsert(detail, { onConflict: 'auction_item_id' });
    if (e2) console.log('detail err:', e2.message);
    upserted++;
  }
  return { upserted, skipped };
}

async function main() {
  console.log(`Onbid 공매 부동산 수집 (upsert=${DO_UPSERT}, all=${ALL}, pages=${PAGES}, rows=${PAGE_SIZE})`);

  let supabase = null;
  if (DO_UPSERT) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  // 1페이지 먼저 받아서 totalCount 확인
  const first = await fetchPage(1);
  console.log(`API totalCount: ${first.total}, 1페이지 items: ${first.items.length}`);

  if (first.items[0]) {
    console.log('--- 첫 row 샘플 (필드 확인용) ---');
    console.log(JSON.stringify(first.items[0], null, 2).slice(0, 1500));
  }

  if (!DO_UPSERT) {
    console.log('\n--upsert 옵션 없이 미리보기만. Supabase 저장 안 함.');
    return;
  }

  let processed = 0, totalUp = 0;
  const lastPage = ALL ? Math.ceil(first.total / PAGE_SIZE) : PAGES;

  for (let p = 1; p <= lastPage; p++) {
    const pageData = p === 1 ? first : await fetchPage(p);
    if (!pageData.items.length) break;
    const r = await processItems(supabase, pageData.items);
    totalUp += r.upserted;
    processed += pageData.items.length;
    console.log(`page ${p}: items ${pageData.items.length}, upserted ${r.upserted}, skipped ${r.skipped}`);
    if (p < lastPage) await sleep(pageDelay());
  }
  console.log(`\n완료: 처리 ${processed}건, upsert ${totalUp}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
