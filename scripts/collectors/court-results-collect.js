// 법원경매 매각결과 수집기 (courtauction.go.kr) — 순수 fetch 버전
// court-stealth.js의 collectResults를 Playwright 없이 재구현
// 엔드포인트: POST /pgj/pgjsearch/selectDspslSchdRsltSrch.on
// 부동산(최근 6개월) + 자동차(최근 3개월) 매각결과 수집
// 실행:
//   node collectors/court-results-collect.js                          (미리보기)
//   node collectors/court-results-collect.js --upsert                 (Supabase 저장)
//   node collectors/court-results-collect.js --upsert --pages 50 --months 6
//
// 안정성: UA 풀 로테이션, 2~3초 랜덤 딜레이, 재시도 3회+지수백오프

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const RESULTS_URL = 'https://www.courtauction.go.kr/pgj/pgjsearch/selectDspslSchdRsltSrch.on';
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
const PAGES = parseInt(args[args.indexOf('--pages') + 1] ?? '5', 10) || 5;
const MONTHS = parseInt(args[args.indexOf('--months') + 1] ?? '6', 10) || 6;
const PAGE_SIZE = 40;

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchCookie() {
  const res = await fetch(HOME_URL, {
    headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function resultsPayload({ pageNo, pageSize, fromDate, toDate, category }) {
  const isVehicle = category === 'vehicle';
  return {
    dma_pageInfo: {
      pageNo, pageSize, bfPageNo: '', startRowNo: '',
      totalCnt: '', totalYn: 'Y', groupTotalCount: '',
    },
    dma_srchGdsDtlSrchInfo: {
      statNum: '3',
      pgmId: 'PGJ158M01',
      cortStDvs: '1',
      cortOfcCd: '',
      bidDvsCd: '000331',
      mvprpRletDvsCd: isVehicle ? '' : '00031R',
      cortAuctnSrchCondCd: isVehicle ? '0004603' : '0004601',
      dspslDxdyYmd: '',
      dspslDxdyFromYmd: fromDate,
      dspslDxdyToYmd: toDate,
      rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
      rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
      aeeEvlAmtMin: '', aeeEvlAmtMax: '',
      lwsDspslPrcRateMin: '', lwsDspslPrcRateMax: '',
      flbdNcntMin: '', flbdNcntMax: '',
      lafjOrderBy: '',
      cortAuctnMbrsId: '', csNo: '',
      lclDspslGdsLstUsgCd: isVehicle ? '30000' : '',
      mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '',
      execrOfcDvsCd: '',
      mvprpArtclKndCd: '', mvprpArtclNm: '',
      gdsVendNm: '', grbxTypCd: '', carMdlNm: '',
      carMdyrMin: '', carMdyrMax: '', fuelKndCd: '', sideDvsCd: '',
    },
  };
}

async function fetchResultsPage(cookie, pageNo, fromDate, toDate, category, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(RESULTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'User-Agent': UA(),
          'Accept': 'application/json',
          'Referer': HOME_URL,
          'Origin': 'https://www.courtauction.go.kr',
          'Cookie': cookie,
        },
        body: JSON.stringify(resultsPayload({ pageNo, pageSize: PAGE_SIZE, fromDate, toDate, category })),
      });
      const json = await res.json();
      if (json.status !== 200) throw new Error(`API error: ${json.message ?? res.status}`);
      return { total: Number(json.data?.dma_pageInfo?.totalCnt || 0), items: json.data?.dlt_srchResult ?? [] };
    } catch (e) {
      lastErr = e;
      console.log(`    재시도 (${i}/${attempts}): ${e.message.split('\n')[0]}`);
      if (i < attempts) await sleep(2000 * Math.pow(2, i - 1));
    }
  }
  throw lastErr;
}

const FUEL_MAP = {
  '0001001': 'gasoline', '0001002': 'diesel', '0001003': 'lpg',
  '0001004': 'hybrid', '0001005': 'gasoline', '0001006': 'ev', '0001009': 'other',
};

function parseResultType(row) {
  // mulStatcd: 04=매각확정(낙찰), 03=진행중, 02=유찰, 그 외=취소
  if (row.mulStatcd === '04') return 'sold';
  if (row.mulStatcd === '02') return 'failed';
  if (row.mulStatcd === '03') return 'canceled'; // 진행중(미확정)
  return 'canceled';
}

function parseAuctionDate(raw) {
  if (!raw || raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function toResultRow(row, category) {
  const gamevalAmt = Number(row.gamevalAmt) || 0;
  const maeAmt = Number(row.maeAmt) || 0;

  const base = {
    category,
    result_type: parseResultType(row),
    case_number: row.srnSaNo || null,
    winning_price: maeAmt || null,
    bid_ratio: gamevalAmt && maeAmt ? Number((maeAmt / gamevalAmt * 100).toFixed(2)) : null,
    bidder_count: Number(row.bidCnt) || null,
    auction_date: parseAuctionDate(row.maeGiil) || new Date().toISOString().slice(0, 10),
  };

  if (category === 'real_estate') {
    // 주소: 도로명전체주소 → 지번 → printSt(법원 표시용 전체주소) → 시도/시군구/동 조합
    // 토지·대지 물건은 bgPlaceRdAllAddr/maejibun 둘 다 비어있어도 printSt 엔 "시도 시군구 동 본번-부번" 형태로 들어옴
    const addr = row.bgPlaceRdAllAddr?.trim()
      || row.maejibun?.trim()
      || row.printSt?.trim()
      || [row.hjguSido, row.hjguSigu, row.hjguDong].filter(Boolean).join(' ').trim()
      || null;
    base.re_address_snapshot = addr || null;
    base.re_property_type = row.dspslUsgNm || null;
    base.re_area_m2 = row.areaList ? Number(row.areaList.match(/[\d.]+/)?.[0]) || null : null;
  } else {
    const carParts = [row.carNm?.trim(), row.jejosaNm?.trim()].filter(Boolean);
    base.vehicle_name = carParts.join(' ') || null;
    base.vehicle_year = Number(row.carYrtype) || null;
    base.vehicle_mileage_km = Number(row.carKm) || null;
    base.vehicle_fuel_type = row.fuelKindcd ? (FUEL_MAP[row.fuelKindcd] || null) : null;
    base.vehicle_condition_grade = row.mulBigo?.slice(0, 100) || null;
  }

  return base;
}

async function loadExistingKeys(supabase, category, fromDate) {
  // case_number+auction_date 를 주 키로. 기존 row 는 case_number 가 null 일 수 있어
  // 폴백 키(auction_date|winning_price|주소/차량명) 도 함께 저장
  const primary = new Set();
  const fallback = new Set();
  const pageSize = 1000;
  let offset = 0;
  const dateFilter = `${fromDate.slice(0, 4)}-${fromDate.slice(4, 6)}-${fromDate.slice(6, 8)}`;
  while (true) {
    const { data, error } = await supabase
      .from('auction_results')
      .select('case_number, auction_date, winning_price, re_address_snapshot, vehicle_name')
      .eq('category', category)
      .gte('auction_date', dateFilter)
      .range(offset, offset + pageSize - 1);
    if (error) { console.error('기존 키 로드 실패:', error.message); break; }
    if (!data?.length) break;
    for (const r of data) {
      if (r.case_number) primary.add(`${r.case_number}|${r.auction_date}`);
      const kb = category === 'real_estate' ? (r.re_address_snapshot ?? '') : (r.vehicle_name ?? '');
      fallback.add(`${r.auction_date}|${r.winning_price}|${kb}`);
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return { primary, fallback };
}

async function collectCategory(cookie, supabase, category, months) {
  const today = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  const fromDate = ymd(from);
  const toDate = ymd(today);

  const label = category === 'real_estate' ? '부동산' : '자동차';
  console.log(`\n[${label}] 매각결과 수집 (${fromDate} ~ ${toDate}, pages=${PAGES})`);

  // 인메모리 기존 키 — case_number 주키 + 주소/차량명 폴백키
  const existing = DO_UPSERT && supabase
    ? await loadExistingKeys(supabase, category, fromDate)
    : { primary: new Set(), fallback: new Set() };
  if (DO_UPSERT) console.log(`  기존 저장분: ${existing.fallback.size}건 (${fromDate}~, case_number 있음: ${existing.primary.size})`);

  let totalFetched = 0, totalSaved = 0, totalErrors = 0;
  let emptyPages = 0;
  const EMPTY_PAGE_LIMIT = 3; // 새 건 0인 페이지가 연속 3번이면 조기 종료

  for (let pageNo = 1; pageNo <= PAGES; pageNo++) {
    try {
      const { total, items } = await fetchResultsPage(cookie, pageNo, fromDate, toDate, category);
      if (pageNo === 1) console.log(`  전체 ${total}건 / ${PAGE_SIZE}개씩`);
      totalFetched += items.length;

      if (!items.length) break; // 더 이상 결과 없음

      let pageSaved = 0;
      if (DO_UPSERT && supabase) {
        const seenCases = new Set();
        for (const raw of items) {
          // 매각확정(mulStatcd=04) + 낙찰가 있는 건만
          if (raw.mulStatcd !== '04' || !Number(raw.maeAmt)) continue;

          // 일괄매각 중복 방지: 같은 사건번호는 첫 물건만 저장
          const caseKey = `${raw.boCd}-${raw.saNo}`;
          if (seenCases.has(caseKey)) continue;
          seenCases.add(caseKey);

          const row = toResultRow(raw, category);
          const primaryKey = row.case_number ? `${row.case_number}|${row.auction_date}` : null;
          const kb = category === 'real_estate' ? (row.re_address_snapshot ?? '') : (row.vehicle_name ?? '');
          const fallbackKey = `${row.auction_date}|${row.winning_price}|${kb}`;
          if (primaryKey && existing.primary.has(primaryKey)) continue;
          if (existing.fallback.has(fallbackKey)) continue;
          if (primaryKey) existing.primary.add(primaryKey);
          existing.fallback.add(fallbackKey);

          // auction_items 매칭 (있으면 연결, 없어도 저장)
          const { data: ai } = await supabase
            .from('auction_items')
            .select('id')
            .eq('source', 'court_auction')
            .eq('source_item_id', raw.docid)
            .maybeSingle();
          row.auction_item_id = ai?.id ?? null;

          const { error } = await supabase.from('auction_results').insert(row);
          if (error) {
            console.error(`    upsert 실패 (${raw.docid}):`, error.message);
            totalErrors++;
          } else {
            totalSaved++;
            pageSaved++;
          }
        }

        console.log(`  page ${pageNo}: ${items.length}건 / 신규 ${pageSaved}건`);
        if (pageSaved === 0) {
          emptyPages++;
          if (emptyPages >= EMPTY_PAGE_LIMIT) {
            console.log(`  연속 ${EMPTY_PAGE_LIMIT}페이지 신규 0건 → 조기 종료`);
            break;
          }
        } else {
          emptyPages = 0;
        }
      } else if (items.length) {
        console.log(`  page ${pageNo}: ${items.length}건`);
        // 미리보기: 낙찰가 있는 건만
        const confirmed = items.filter(r => Number(r.maeAmt) > 0);
        console.log(`    (낙찰 확정: ${confirmed.length}건 / 전체 ${items.length}건)`);
        confirmed.slice(0, 3).forEach(r => {
          const rt = parseResultType(r);
          const price = Number(r.maeAmt || 0).toLocaleString();
          const ratio = Number(r.gamevalAmt) && Number(r.maeAmt)
            ? (Number(r.maeAmt) / Number(r.gamevalAmt) * 100).toFixed(1) + '%'
            : '-';
          console.log(`    · ${r.srnSaNo || r.docid} | ${rt} | ${price}원 | 낙찰률 ${ratio} | ${r.bgPlaceRdAllAddr || r.carNm || ''}`);
        });
        if (confirmed.length > 3) console.log(`    ... 외 ${confirmed.length - 3}건`);
      }

      await sleep(pageDelay());
    } catch (e) {
      console.error(`  page ${pageNo} 실패:`, e.message);
      totalErrors++;
    }
  }

  console.log(`  [${label}] 완료: 수집 ${totalFetched}건, 저장 ${totalSaved}건, 에러 ${totalErrors}건`);
  return { totalFetched, totalSaved, totalErrors };
}

async function main() {
  console.log(`Court Auction 매각결과 수집기 시작 (upsert=${DO_UPSERT}, pages=${PAGES}, months=${MONTHS})`);

  let supabase = null;
  if (DO_UPSERT) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1); }
    supabase = createClient(url, key);
  }

  const cookie = await fetchCookie();
  console.log('세션 쿠키 확보');

  // 부동산 매각결과 (최근 N개월)
  const re = await collectCategory(cookie, supabase, 'real_estate', MONTHS);

  // 쿠키 갱신 (부동산 수집 후 세션 만료 방지)
  const cookie2 = await fetchCookie();

  // 자동차 매각결과 (부동산의 절반 기간, 최소 6개월)
  const vehicleMonths = Math.min(MONTHS, 12);
  const ve = await collectCategory(cookie2, supabase, 'vehicle', vehicleMonths);

  const grand = {
    fetched: re.totalFetched + ve.totalFetched,
    saved: re.totalSaved + ve.totalSaved,
    errors: re.totalErrors + ve.totalErrors,
  };
  console.log(`\n=== 전체 완료: 수집 ${grand.fetched}건, 저장 ${grand.saved}건, 에러 ${grand.errors}건 ===`);
  if (!DO_UPSERT) console.log('(미리보기 - DB 저장 안 됨. --upsert 플래그로 저장)');
}

main().catch(e => { console.error(e); process.exit(1); });
