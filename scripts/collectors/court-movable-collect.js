// 법원경매 유체동산 수집기 (courtauction.go.kr)
// 엔드포인트: POST /pgj/pgjsearch/searchControllerMain.on (부동산과 동일)
// 핵심: cortAuctnSrchCondCd='0004604' (동산) + mvprpRletDvsCd='00031M'
// 실행:
//   node collectors/court-movable-collect.js                  (1페이지 미리보기)
//   node collectors/court-movable-collect.js --upsert --pages 47  (전체 1863건)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SEARCH_URL = 'https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];
const UA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
const pageDelay = () => 2000 + Math.random() * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const DO_UPSERT = args.includes('--upsert');
const PAGES = parseInt(args[args.indexOf('--pages') + 1] ?? '1', 10) || 1;
const PAGE_SIZE = 40;

const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

async function fetchCookie() {
  const res = await fetch(HOME_URL, {
    headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function payload({ pageNo, pageSize, fromDate, toDate }) {
  return {
    dma_pageInfo: { pageNo, pageSize, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '' },
    dma_srchGdsDtlSrchInfo: {
      rletDspslSpcCondCd: '', bidDvsCd: '000331', mvprpRletDvsCd: '00031M', cortAuctnSrchCondCd: '0004604',
      rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
      rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
      mvprpDspslPlcAdongSdCd: '', mvprpDspslPlcAdongSggCd: '', mvprpDspslPlcAdongEmdCd: '',
      rdDspslPlcAdongSdCd: '', rdDspslPlcAdongSggCd: '', rdDspslPlcAdongEmdCd: '',
      cortOfcCd: '', jdbnCd: '', execrOfcDvsCd: '',
      lclDspslGdsLstUsgCd: '', mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '',
      cortAuctnMbrsId: '',
      aeeEvlAmtMin: '', aeeEvlAmtMax: '',
      lwsDspslPrcRateMin: '', lwsDspslPrcRateMax: '',
      flbdNcntMin: '', flbdNcntMax: '',
      objctArDtsMin: '', objctArDtsMax: '',
      mvprpArtclKndCd: '', mvprpArtclNm: '',
      mvprpAtchmPlcTypCd: '',
      notifyLoc: 'off', lafjOrderBy: '',
      pgmId: 'PGJ151F01',
      csNo: '', cortStDvs: '1', statNum: 1,
      bidBgngYmd: fromDate, bidEndYmd: toDate,
      dspslDxdyYmd: '', fstDspslHm: '', scndDspslHm: '', thrdDspslHm: '', fothDspslHm: '',
      dspslPlcNm: '', lwsDspslPrcMin: '', lwsDspslPrcMax: '',
      grbxTypCd: '', gdsVendNm: '', fuelKndCd: '',
      carMdyrMax: '', carMdyrMin: '', carMdlNm: '', sideDvsCd: '',
    },
  };
}

async function fetchPage(cookie, pageNo, fromDate, toDate, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'User-Agent': UA(),
          'Accept': 'application/json',
          'Referer': HOME_URL,
          'Origin': 'https://www.courtauction.go.kr',
          'Cookie': cookie,
        },
        body: JSON.stringify(payload({ pageNo, pageSize: PAGE_SIZE, fromDate, toDate })),
      });
      const json = await res.json();
      if (json.status !== 200) throw new Error(`API error: ${json.message ?? res.status}`);
      return { total: Number(json.data.dma_pageInfo.totalCnt), items: json.data.dlt_srchResult ?? [] };
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(1500 * i);
    }
  }
  throw lastErr;
}

function toAuctionItem(row) {
  const caseNo = row.srnSaNo || row.mvSaNo || `${row.boCd}-${row.saNo}`;
  const item = row.choigoMaeMokmulNm?.trim() || '유체동산';
  const cnt = Number(row.choigoCnt) || 1;
  const place = [row.hjguSido, row.hjguSigu, row.hjguDong].filter(Boolean).join(' ');
  const titleBits = [item, cnt > 1 ? `외 ${cnt}건` : null, place].filter(Boolean);
  return {
    category: 'vehicle', // 스키마 제약(vehicle|real_estate) — 유체동산 임시로 vehicle에 귀속. 추후 'movable' enum 추가 필요
    source: 'court_auction_movable',
    source_item_id: row.docid,
    case_number: caseNo,
    title: titleBits.join(' · ').slice(0, 120) || caseNo,
    appraisal_price: Number(row.choigoGamevalAmt) || null,
    min_bid_price: Number(row.choigoGamevalAmt) || null,
    fail_count: Number(row.yuchalCnt) || 0,
    auction_date: row.maeGiil?.length === 8
      ? `${row.maeGiil.slice(0, 4)}-${row.maeGiil.slice(4, 6)}-${row.maeGiil.slice(6, 8)}T10:00:00+09:00`
      : null,
    status: 'upcoming',
    thumbnail_url: null,
    raw_data: row,
  };
}

async function main() {
  console.log(`Court Auction 유체동산 수집기 시작 (upsert=${DO_UPSERT}, pages=${PAGES})`);

  const today = new Date();
  const future = new Date(); future.setDate(future.getDate() + 30);
  const fromDate = ymd(today);
  const toDate = ymd(future);

  const cookie = await fetchCookie();
  console.log('세션 쿠키 확보');

  let supabase = null;
  if (DO_UPSERT) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1); }
    supabase = createClient(url, key);
  }

  let totalFetched = 0, totalUpserted = 0, totalErrors = 0;

  for (let pageNo = 1; pageNo <= PAGES; pageNo++) {
    try {
      const { total, items } = await fetchPage(cookie, pageNo, fromDate, toDate);
      if (pageNo === 1) console.log(`전체 ${total}건 / ${PAGE_SIZE}개씩`);
      totalFetched += items.length;
      console.log(`  page ${pageNo}: ${items.length}건`);

      if (supabase && items.length) {
        const rows = items.map(toAuctionItem);
        const { data, error } = await supabase
          .from('auction_items')
          .upsert(rows, { onConflict: 'source,source_item_id' })
          .select('id');
        if (error) { console.error('    upsert error:', error.message); totalErrors++; continue; }
        totalUpserted += data.length;
      } else if (items.length) {
        items.slice(0, 3).forEach(r => {
          console.log(`    · ${r.srnSaNo || r.mvSaNo} | ${r.choigoMaeMokmulNm} (${r.choigoCnt}개) | 감정 ${Number(r.choigoGamevalAmt).toLocaleString()}원 | ${r.hjguSido} ${r.hjguSigu}`);
        });
      }
      await sleep(pageDelay());
    } catch (e) {
      console.error(`  page ${pageNo} 실패:`, e.message);
      totalErrors++;
    }
  }

  console.log(`\n완료: 수집 ${totalFetched}건, upsert ${totalUpserted}건, 에러 ${totalErrors}회`);
  if (!supabase) console.log('(미리보기 - DB 저장 안 됨. --upsert 플래그로 저장)');
}

main().catch(e => { console.error(e); process.exit(1); });
