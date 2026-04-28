// 법원경매 자동차/중기 수집기 (courtauction.go.kr)
// 엔드포인트: POST /pgj/pgjsearch/searchControllerMain.on (부동산과 동일)
// 핵심 페이로드: cortAuctnSrchCondCd='0004603', pgmId='PGJ154M01', lclDspslGdsLstUsgCd='30000'
// 실행:
//   node collectors/court-vehicle-collect.js                  (1페이지 미리보기)
//   node collectors/court-vehicle-collect.js --upsert         (Supabase 저장)
//   node collectors/court-vehicle-collect.js --upsert --pages 20
//
// 안정성: UA 풀, 페이지 간 2~3초, 재시도 3회

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SEARCH_URL = 'https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const UA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
const pageDelay = () => 2000 + Math.random() * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const DO_UPSERT = args.includes('--upsert');
const PAGES = parseInt(args[args.indexOf('--pages') + 1] ?? '1', 10) || 1;
const PAGE_SIZE = 40;

async function fetchCookie() {
  const res = await fetch(HOME_URL, {
    headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function payload({ pageNo, pageSize }) {
  return {
    dma_pageInfo: { pageNo, pageSize, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '' },
    dma_srchGdsDtlSrchInfo: {
      cortAuctnSrchCondCd: '0004603', cortStDvs: 1,
      rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
      rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
      cortOfcCd: '', jdbnCd: '',
      aeeEvlAmtMin: '', aeeEvlAmtMax: '',
      rletLwsDspslPrcMin: '', rletLwsDspslPrcMax: '',
      lclDspslGdsLstUsgCd: '30000', mclDspslGdsLstUsgCd: '30100', sclDspslGdsLstUsgCd: '',
      execrOfcDvsCd: '', flbdNcntMin: '', flbdNcntMax: '', lafjOrderBy: '',
      pgmId: 'PGJ154M01', cortAuctnMbrsId: '', csNo: '', statNum: 1,
      gdsVendNm: '', grbxTypCd: '', carMdlNm: '', carMdyrMin: '', carMdyrMax: '',
      fuelKndCd: '', dspslDxdyYmd: '', sideDvsCd: '',
    },
  };
}

async function fetchPage(cookie, pageNo, attempts = 3) {
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
        body: JSON.stringify(payload({ pageNo, pageSize: PAGE_SIZE })),
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

const FUEL_MAP = {
  '0001001': 'gasoline', '0001002': 'diesel', '0001003': 'lpg',
  '0001004': 'hybrid',  '0001005': 'gasoline', '0001006': 'ev', '0001009': 'other',
};

const SIDO_SHORT = {'서울':'서울특별시','부산':'부산광역시','대구':'대구광역시','인천':'인천광역시','광주':'광주광역시','대전':'대전광역시','울산':'울산광역시','세종':'세종특별자치시','경기':'경기도','강원':'강원특별자치도','충북':'충청북도','충남':'충청남도','전북':'전북특별자치도','전남':'전라남도','경북':'경상북도','경남':'경상남도','제주':'제주특별자치도'};
function normalizeSido(s) { return SIDO_SHORT[s] || (s.endsWith('시') && !s.endsWith('특별시') && !s.endsWith('광역시') ? '' : s); }

function toAuctionItem(row) {
  const caseNo = row.srnSaNo || `${row.boCd}-${row.saNo}`;
  const carName = row.carNm?.trim() || '';
  const year = Number(row.carYrtype) || null;
  const fuel = row.fuelKindcd ? FUEL_MAP[row.fuelKindcd] : null;
  const storage = row.bgPlaceRdAllAddr?.trim() || row.bgPlaceSido || '';
  const titleBits = [
    year && year > 1980 ? `${year}` : null,
    carName || '차량',
    fuel,
    storage.slice(0, 30),
  ].filter(Boolean);
  return {
    category: 'vehicle',
    source: 'court_auction',
    source_item_id: row.docid,
    case_number: caseNo,
    title: titleBits.join(' · ').slice(0, 120) || caseNo,
    appraisal_price: Number(row.gamevalAmt) || null,
    min_bid_price: Number(row.minmaePrice) || null,
    fail_count: Number(row.yuchalCnt) || 0,
    auction_date: row.maeGiil?.length === 8
      ? `${row.maeGiil.slice(0, 4)}-${row.maeGiil.slice(4, 6)}-${row.maeGiil.slice(6, 8)}T10:00:00+09:00`
      : null,
    status: row.mulJinYn === 'Y' ? 'upcoming' : 'canceled',
    thumbnail_url: null,
    sido: normalizeSido(row.hjguSido || row.bgPlaceSido || ''),
    sigungu: row.hjguSigu || row.bgPlaceSigu || '',
    address: row.bgPlaceRdAllAddr || '',
    raw_data: row,
  };
}

async function main() {
  console.log(`Court Auction 자동차 수집기 시작 (upsert=${DO_UPSERT}, pages=${PAGES})`);

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
      const { total, items } = await fetchPage(cookie, pageNo);
      if (pageNo === 1) console.log(`전체 ${total}건 / ${PAGE_SIZE}개씩`);
      totalFetched += items.length;
      console.log(`  page ${pageNo}: ${items.length}건`);

      if (supabase && items.length) {
        const auctionItems = items.map(toAuctionItem);
        const { data: inserted, error } = await supabase
          .from('auction_items')
          .upsert(auctionItems, { onConflict: 'source,source_item_id' })
          .select('id, source_item_id');
        if (error) { console.error('    upsert error:', error.message); totalErrors++; continue; }
        totalUpserted += inserted.length;
      } else if (items.length) {
        // 미리보기: 샘플 3건
        items.slice(0, 3).forEach(r => {
          console.log(`    · ${r.srnSaNo} | ${r.carNm} (${r.carYrtype}) | 감정 ${Number(r.gamevalAmt).toLocaleString()}원 | 최저 ${Number(r.minmaePrice).toLocaleString()}원 | 유찰 ${r.yuchalCnt}회 | ${r.bgPlaceRdAllAddr || ''}`);
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
