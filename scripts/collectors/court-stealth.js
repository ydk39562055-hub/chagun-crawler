// Playwright 스텔스 버전 — 실브라우저 세션 재사용 + 지터 + 긴 간격
// 차단 당한 후 재시도용. 하루 50~100건만 천천히.
// 실행: node collectors/court-stealth.js --mode detail --limit 50 --upsert
//       node collectors/court-stealth.js --mode results --pages 5 --upsert

import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const MODE = args[args.indexOf('--mode') + 1] ?? 'detail'; // detail | results
const LIMIT = parseInt(args[args.indexOf('--limit') + 1] ?? '30', 10);
const PAGES = parseInt(args[args.indexOf('--pages') + 1] ?? '3', 10);
const DO_UPSERT = args.includes('--upsert');

const MIN_DELAY_MS = 2500;
const JITTER_MS = 2000; // 2~4.5초 랜덤

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_DELAY_MS + Math.random() * JITTER_MS;

async function gotoWithRetry(page, url, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (e) {
      lastErr = e;
      console.log(`  goto 실패 (${i}/${attempts}): ${e.message.split('\n')[0]}`);
      if (i < attempts) await sleep(5000 * i);
    }
  }
  throw lastErr;
}

async function initContext(browser) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Accept': '*/*',
      'DNT': '1',
    },
  });
  const page = await ctx.newPage();
  // 홈 방문으로 세션 획득 (실브라우저 플로우)
  await gotoWithRetry(page, 'https://www.courtauction.go.kr/');
  await sleep(1500);
  // 한번 물건검색 들어가기 (세션 워밍업)
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('a')).find(a => (a.textContent || '').trim() === '물건상세검색');
    t?.click();
  }).catch(() => {});
  await sleep(2000);
  return { ctx, page };
}

async function postJson(page, url, body) {
  const resp = await page.evaluate(async ({ url, body }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Accept': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    const text = await res.text();
    return { status: res.status, text };
  }, { url, body });
  try { return JSON.parse(resp.text); } catch { return { status: 500, message: resp.text.slice(0, 200) }; }
}

async function collectDetails(page, supabase) {
  const { data: items } = await supabase
    .from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction')
    .is('thumbnail_url', null)
    .order('auction_date', { ascending: true })
    .limit(LIMIT);

  console.log(`상세 수집 대상 ${items.length}건 (아직 사진 없는 물건)`);

  let ok = 0, blocked = 0;
  for (const it of items) {
    const raw = it.raw_data ?? {};
    const payload = {
      dma_srchGdsDtlSrch: {
        cortOfcCd: raw.boCd,
        csNo: String(raw.saNo),
        dspslGdsSeq: Number(raw.maemulSer || 1),
        pgmId: 'PGJ15BA00',
      },
    };
    const r = await postJson(page, 'https://www.courtauction.go.kr/pgj/pgj15B/selectAuctnCsSrchRslt.on', payload);

    if (r.status !== 200 || /차단|비정상/.test(r.message || '')) {
      console.log(`  ${it.case_number} BLOCKED:`, (r.message || '').slice(0, 80));
      blocked++;
      if (blocked >= 3) {
        console.log('\n3건 연속 차단 — 중단');
        break;
      }
      await sleep(10000);
      continue;
    }
    const d = r.data?.dma_result ?? {};
    const photos = (d.csPicLst ?? []).map((p, i) => ({
      order: i,
      url: p.picFileUrl ? `https://www.courtauction.go.kr${p.picFileUrl}${p.picTitlNm}` : null,
      title: p.picTitlNm,
      type_code: p.cortAuctnPicDvsCd,
    })).filter(p => p.url);

    const goods = d.dspslGdsDxdyInfo ?? {};
    const base = d.csBaseInfo ?? {};

    if (DO_UPSERT) {
      await supabase.from('auction_items').update({
        raw_data: {
          ...raw,
          _photos: photos,
          _detail: {
            base, goods,
            picDvsIndvdCnt: d.picDvsIndvdCnt ?? [],
            dstrtDemnInfo: d.dstrtDemnInfo ?? [],
            fetched_at: new Date().toISOString(),
          },
        },
        thumbnail_url: photos[0]?.url ?? null,
      }).eq('id', it.id);
    }
    ok++;
    blocked = 0;
    console.log(`  [${ok}/${items.length}] ${it.case_number} · 사진 ${photos.length} · 비고 ${(goods.dspslGdsRmk || '').slice(0, 30)}`);
    await sleep(jitter());
  }
  console.log(`\n완료: 성공 ${ok}`);
}

async function collectResults(page, supabase) {
  // 과거 낙찰 아카이브
  const url = 'https://www.courtauction.go.kr/pgj/pgjsearch/selectDspslSchdRsltSrch.on';
  const today = new Date();
  const from = new Date(); from.setDate(from.getDate() - 30);
  const ymd = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;

  let totalSaved = 0;
  for (let pageNo = 1; pageNo <= PAGES; pageNo++) {
    const payload = {
      dma_pageInfo: { pageNo, pageSize: 40, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '' },
      dma_srchGdsDtlSrchInfo: {
        statNum: '3', pgmId: 'PGJ158M01', cortStDvs: '1', cortOfcCd: '',
        bidDvsCd: '000331', mvprpRletDvsCd: '00031R', cortAuctnSrchCondCd: '0004601',
        dspslDxdyYmd: '', dspslDxdyFromYmd: ymd(from), dspslDxdyToYmd: ymd(today),
        // 나머지 필드는 빈값으로
      },
    };
    const r = await postJson(page, url, payload);
    if (r.status !== 200) {
      console.log(`  page ${pageNo} ERROR:`, r.message?.slice(0, 80));
      break;
    }
    const list = r.data?.dlt_srchResult ?? [];
    console.log(`  page ${pageNo}: ${list.length}건 (총 ${r.data?.dma_pageInfo?.totalCnt})`);

    if (DO_UPSERT && list.length) {
      const rows = list.map(row => ({
        auction_item_id: null, // 기존 auction_items 와 매칭 필요 (docid 로)
        category: 'real_estate',
        result_type: row.mulStatcd === '03' ? 'sold' : row.mulStatcd === '02' ? 'failed' : 'canceled',
        winning_price: Number(row.maeAmt) || null,
        bid_ratio: row.gamevalAmt && row.maeAmt ? Number((Number(row.maeAmt) / Number(row.gamevalAmt) * 100).toFixed(2)) : null,
        auction_date: row.maeGiil ? `${row.maeGiil.slice(0, 4)}-${row.maeGiil.slice(4, 6)}-${row.maeGiil.slice(6, 8)}` : new Date().toISOString().slice(0, 10),
        re_address_snapshot: row.bgPlaceRdAllAddr,
        re_property_type: row.dspslUsgNm,
      }));
      // auction_item_id 없는 경우를 위해 먼저 매칭 or insert-only (unique 제약 해제 필요)
      // 여기선 일단 매칭되는 것만
      for (const raw of list) {
        const { data: ai } = await supabase
          .from('auction_items')
          .select('id')
          .eq('source', 'court_auction')
          .eq('source_item_id', raw.docid)
          .maybeSingle();
        if (!ai) continue;
        const row = rows[list.indexOf(raw)];
        row.auction_item_id = ai.id;
        await supabase.from('auction_results').upsert(row, { onConflict: 'auction_item_id' });
        totalSaved++;
      }
    }
    await sleep(jitter());
  }
  console.log(`\n완료: 저장 ${totalSaved}건`);
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log(`Stealth 모드 시작: mode=${MODE}, upsert=${DO_UPSERT}`);
  const browser = await chromium.launch({ headless: true });

  try {
    const { page } = await initContext(browser);
    if (MODE === 'detail') await collectDetails(page, supabase);
    else if (MODE === 'results') await collectResults(page, supabase);
    else console.log('알 수 없는 모드:', MODE);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
