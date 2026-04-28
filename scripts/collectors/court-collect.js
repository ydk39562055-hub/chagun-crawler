// 법원경매 부동산 매각물건 수집기 (courtauction.go.kr)
// 엔드포인트: POST /pgj/pgjsearch/searchControllerMain.on
// 실행:
//   node collectors/court-collect.js                  (1페이지 미리보기)
//   node collectors/court-collect.js --upsert         (Supabase 저장)
//   node collectors/court-collect.js --upsert --pages 10
//
// 주의: 과도한 요청 방지 위해 페이지당 500ms 대기

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SEARCH_URL = 'https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';

// User-Agent 풀 (매 요청 랜덤 선택)
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const UA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
// 페이지 간 대기: 2~3초 랜덤 (보수적)
const pageDelay = () => 2000 + Math.random() * 1000;

const args = process.argv.slice(2);
const DO_UPSERT = args.includes('--upsert');
const PAGES = parseInt(args[args.indexOf('--pages') + 1] ?? '1', 10) || 1;
const PAGE_SIZE = 40;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCookie() {
  const res = await fetch(HOME_URL, { headers: {
    'User-Agent': UA(),
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  }});
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function payload({ pageNo, pageSize, fromDate, toDate }) {
  return {
    dma_pageInfo: { pageNo, pageSize, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '' },
    dma_srchGdsDtlSrchInfo: {
      rletDspslSpcCondCd: '', bidDvsCd: '000331', mvprpRletDvsCd: '00031R', cortAuctnSrchCondCd: '0004601',
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

async function fetchPage(cookie, pageNo, fromDate, toDate) {
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
  if (json.status !== 200) throw new Error(`API error: ${json.message}`);
  return { total: Number(json.data.dma_pageInfo.totalCnt), items: json.data.dlt_srchResult ?? [] };
}

function parseMaeGiil(raw) {
  // "20260428" → "2026-04-28T10:00:00+09:00"
  if (!raw || raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T10:00:00+09:00`;
}

const SIDO_SHORT = {'서울':'서울특별시','부산':'부산광역시','대구':'대구광역시','인천':'인천광역시','광주':'광주광역시','대전':'대전광역시','울산':'울산광역시','세종':'세종특별자치시','경기':'경기도','강원':'강원특별자치도','충북':'충청북도','충남':'충청남도','전북':'전북특별자치도','전남':'전라남도','경북':'경상북도','경남':'경상남도','제주':'제주특별자치도'};
function normalizeSido(s) { return SIDO_SHORT[s] || (s.endsWith('시') && !s.endsWith('특별시') && !s.endsWith('광역시') ? '' : s); }

function toAuctionItem(row) {
  const caseNo = row.srnSaNo || `${row.boCd}-${row.saNo}`;
  const addr = row.bgPlaceRdAllAddr?.trim() || row.buldNm || '';
  const area = (row.areaList?.split(/[,\s]/)?.find(x => x.match(/\d/)) || '').trim();
  const titleBits = [row.jiwonNm, row.dspslUsgNm || '부동산', addr.slice(0, 40), area].filter(Boolean);
  return {
    category: 'real_estate',
    source: 'court_auction',
    source_item_id: row.docid,
    case_number: caseNo,
    title: titleBits.join(' · ').slice(0, 120) || caseNo,
    appraisal_price: Number(row.gamevalAmt) || null,
    min_bid_price: Number(row.minmaePrice) || null,
    fail_count: Number(row.yuchalCnt) || 0,
    auction_date: parseMaeGiil(row.maeGiil),
    status: row.mulJinYn === 'Y' ? 'upcoming' : 'canceled',
    thumbnail_url: null,
    sido: normalizeSido(row.hjguSido || row.bgPlaceSido || ''),
    sigungu: row.hjguSigu || row.bgPlaceSigu || '',
    address: row.bgPlaceRdAllAddr || row.maejibun || '',
    raw_data: row,
  };
}

function toRealEstateDetail(auction_item_id, row) {
  // 용도 코드는 따로 매핑 테이블 필요. 임시로 세부 용도명에서 추정
  const usgNm = row.dspslUsgNm ?? '';
  let propertyType = 'etc';
  if (/아파트/.test(usgNm)) propertyType = 'apartment';
  else if (/빌라|연립|다세대/.test(usgNm)) propertyType = 'multi_family';
  else if (/오피스텔/.test(usgNm)) propertyType = 'officetel';
  else if (/단독|주택/.test(usgNm)) propertyType = 'house';
  else if (/상가|점포|근린/.test(usgNm)) propertyType = 'commercial';
  else if (/토지|대지|전|답|임야/.test(usgNm)) propertyType = 'land';

  const areaMatch = (row.areaList || '').match(/([\d.]+)㎡|([\d.]+)m/);
  const areaM2 = areaMatch ? Number(areaMatch[1] || areaMatch[2]) : null;

  const lat = Number(row.wgs84Ycordi) || null;
  const lng = Number(row.wgs84Xcordi) || null;

  return {
    auction_item_id,
    property_type: propertyType,
    address_road: row.bgPlaceRdAllAddr ?? null,
    address_jibun: row.maejibun ?? null,
    sido: row.bgPlaceSido ?? null,
    sigungu: row.bgPlaceSigu ?? null,
    dong: row.bgPlaceDong ?? null,
    building_name: row.buldNm ?? null,
    area_m2: areaM2,
    location: lat && lng ? `SRID=4326;POINT(${lng} ${lat})` : null,
    photos: [],
  };
}

async function main() {
  console.log(`Court Auction 수집기 시작 (upsert=${DO_UPSERT}, pages=${PAGES})`);

  const today = new Date();
  const future = new Date(); future.setDate(future.getDate() + 30);
  const fromDate = ymd(today);
  const toDate = ymd(future);
  console.log(`기간: ${fromDate} ~ ${toDate}`);

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
      if (pageNo === 1) console.log(`전체 ${total}건 / ${PAGE_SIZE}개씩 페이지 수집`);
      totalFetched += items.length;
      console.log(`  page ${pageNo}: ${items.length}건`);

      if (supabase && items.length) {
        const auctionItems = items.map(toAuctionItem);
        const { data: inserted, error } = await supabase
          .from('auction_items')
          .upsert(auctionItems, { onConflict: 'source,source_item_id' })
          .select('id, source_item_id');
        if (error) { console.error('    upsert error:', error.message); totalErrors++; continue; }

        const idMap = new Map(inserted.map(r => [r.source_item_id, r.id]));
        const details = items.map(row => toRealEstateDetail(idMap.get(row.docid), row)).filter(d => d.auction_item_id);
        if (details.length) {
          const { error: err2 } = await supabase
            .from('real_estate_details')
            .upsert(details, { onConflict: 'auction_item_id' });
          if (err2) console.error('    detail upsert error:', err2.message);
        }
        totalUpserted += inserted.length;
      }
      await sleep(pageDelay());
    } catch (e) {
      console.error(`  page ${pageNo} 실패:`, e.message);
      totalErrors++;
    }
  }

  console.log(`\n완료: 수집 ${totalFetched}건, upsert ${totalUpserted}건, 에러 ${totalErrors}회`);

  // 미리보기
  if (!supabase) {
    console.log('\n(미리보기 - DB 저장 안 됨. 실제 저장은 --upsert 플래그)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
