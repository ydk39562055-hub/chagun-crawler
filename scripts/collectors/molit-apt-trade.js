// 국토부 아파트 실거래가 수집기
// API: getRTMSDataSvcAptTradeDev (공공데이터포털)
// 활용신청: https://www.data.go.kr/data/15126469/openapi.do
// 실행:
//   node collectors/molit-apt-trade.js --lawd 11680 --from 202603 --to 202604
//   node collectors/molit-apt-trade.js --all --upsert   (주요 지역 자동)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';

const KEY = process.env.MOLIT_API_KEY || process.env.ONBID_API_KEY; // 공공데이터 키 공용
const BASE = 'https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev';

// 주요 지역 코드 (LAWD 5자리)
const MAJOR_LAWD = [
  { code: '11110', name: '종로구' }, { code: '11140', name: '중구' },
  { code: '11170', name: '용산구' }, { code: '11200', name: '성동구' },
  { code: '11215', name: '광진구' }, { code: '11230', name: '동대문구' },
  { code: '11260', name: '중랑구' }, { code: '11290', name: '성북구' },
  { code: '11305', name: '강북구' }, { code: '11320', name: '도봉구' },
  { code: '11350', name: '노원구' }, { code: '11380', name: '은평구' },
  { code: '11410', name: '서대문구' }, { code: '11440', name: '마포구' },
  { code: '11470', name: '양천구' }, { code: '11500', name: '강서구' },
  { code: '11530', name: '구로구' }, { code: '11545', name: '금천구' },
  { code: '11560', name: '영등포구' }, { code: '11590', name: '동작구' },
  { code: '11620', name: '관악구' }, { code: '11650', name: '서초구' },
  { code: '11680', name: '강남구' }, { code: '11710', name: '송파구' },
  { code: '11740', name: '강동구' },
];

const args = process.argv.slice(2);
const LAWD = args[args.indexOf('--lawd') + 1];
const FROM = args[args.indexOf('--from') + 1];
const TO = args[args.indexOf('--to') + 1];
const ALL = args.includes('--all');
const DO_UPSERT = args.includes('--upsert');

function curYm() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchTrades(lawdCd, dealYmd, pageNo = 1) {
  // 공공데이터 Encoding 키(%2B 등)는 URLSearchParams가 다시 인코딩해 403 유발
  // decodeURIComponent로 원본 복원 후 삽입 (Decoding 키는 변화 없음)
  const decodedKey = decodeURIComponent(KEY);
  const url = new URL(BASE);
  url.searchParams.set('serviceKey', decodedKey);
  url.searchParams.set('LAWD_CD', lawdCd);
  url.searchParams.set('DEAL_YMD', dealYmd);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', '100');
  const res = await fetch(url);
  const text = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const j = parser.parse(text);
  const code = j?.response?.header?.resultCode;
  if (code !== '00' && code !== '000') return { error: j?.response?.header?.resultMsg || text.slice(0, 200), items: [] };
  const items = j?.response?.body?.items?.item ?? [];
  return { items: Array.isArray(items) ? items : [items] };
}

function toSnapshot(row, sigunguCd) {
  const price = Number(String(row.dealAmount ?? '').replace(/,/g, '').trim()) * 10_000; // 만원 → 원
  const areaM2 = Number(row.excluUseAr) || null;
  const priceM2 = areaM2 ? Math.round(price / areaM2) : null;
  const priceP = areaM2 ? Math.round(price / (areaM2 / 3.3058)) : null;
  const ymd = [row.dealYear, String(row.dealMonth).padStart(2, '0'), String(row.dealDay).padStart(2, '0')].join('-');
  return {
    re_detail_id: null,                        // 당장 매칭 없이 저장 못함 — 별도 집계 테이블 필요
    source: 'molit_real_price',
    snapshot_type: 'trade',
    price,
    price_per_m2: priceM2,
    price_per_py: priceP,
    traded_at: ymd,
    expose_floor_range: null,
    sample_count: 1,
    raw: { ...row, sigunguCd },
  };
}

async function collectOne(supabase, lawdCd, ymd) {
  const { items, error } = await fetchTrades(lawdCd, ymd);
  if (error) { console.log(`    ${lawdCd}/${ymd} 실패: ${error}`); return 0; }
  if (!items.length) { console.log(`    ${lawdCd}/${ymd} 0건`); return 0; }
  console.log(`    ${lawdCd}/${ymd} ${items.length}건`);
  if (!DO_UPSERT) return items.length;
  // re_market_snapshots 테이블 필요 (migration 0002)
  const rows = items.map(r => toSnapshot(r, lawdCd));
  const { error: err } = await supabase.from('re_market_snapshots').insert(rows);
  if (err) console.log(`      insert err: ${err.message}`);
  return items.length;
}

async function main() {
  if (!KEY) { console.error('API 키 없음 (MOLIT_API_KEY 또는 ONBID_API_KEY)'); process.exit(1); }
  const supabase = DO_UPSERT ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;

  if (LAWD && FROM && TO) {
    // 단일 지역·기간
    console.log(`${LAWD} ${FROM} ~ ${TO}`);
    let ymd = FROM;
    while (ymd <= TO) {
      await collectOne(supabase, LAWD, ymd);
      const y = Number(ymd.slice(0, 4));
      const m = Number(ymd.slice(4, 6));
      const next = m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`;
      ymd = next;
      await new Promise(r => setTimeout(r, 300));
    }
    return;
  }

  if (ALL) {
    const ymd = curYm();
    console.log(`서울 25개 구 ${ymd}월 실거래가 수집`);
    let total = 0;
    for (const { code, name } of MAJOR_LAWD) {
      const n = await collectOne(supabase, code, ymd);
      total += n;
      process.stdout.write(`  ${name}: ${n}건\n`);
      await new Promise(r => setTimeout(r, 400));
    }
    console.log(`\n총 ${total}건`);
    return;
  }

  console.log('사용법: --lawd 11680 --from 202603 --to 202604');
  console.log('     : --all --upsert');
}

main().catch(e => { console.error(e); process.exit(1); });
