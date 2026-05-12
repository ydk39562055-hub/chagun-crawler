// 부동산 상세 페이지(PGJ15BA00)에서 사진 영역 직접 수집.
// court 직접 URL이 만료되어 photo-rehost가 못 받는 매물 보완.
//
// 전략:
//   1) deep link로 PGJ15BA00 진입 (cortOfcCd, csNo, dspslGdsSeq)
//   2) 페이지 안의 사진 src 수집 (base64 또는 살아있는 court URL)
//   3) 외부 URL이면 fetch 후 buf, base64면 decode → Supabase 업로드
//
// 실행:
//   node collectors/court-realestate-photos-from-page.js --case 2024타경118390
//   node collectors/court-realestate-photos-from-page.js --upload --limit 5

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const DEBUG = args.includes('--debug');
const LIMIT = parseInt(argOf('--limit', '5'), 10) || 5;
const CASE_NUMBER = argOf('--case', null);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a)) + a;

function parseCaseNo(s) {
  const m = String(s || '').match(/^(\d{4})\D+(\d+)/);
  return m ? { year: m[1], csNum: m[2] } : null;
}

async function fetchPagePhotos(ctx, raw, caseNumber) {
  const page = await ctx.newPage();
  page.on('dialog', async d => { try { await d.accept(); } catch {} });
  try {
    const jiwonNm = raw.jiwonNm || raw._detail?.base?.cortSptNm || raw._detail?.base?.cortOfcNm;
    const parsed = parseCaseNo(caseNumber);
    if (!jiwonNm || !parsed) throw new Error('missing-jiwonNm-or-caseno');

    await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // PGJ159M00 검색 → 결과 클릭
    await page.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(2500);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { value: jiwonNm });
    await sleep(250);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear', { value: String(parsed.year) });
    await sleep(250);
    await page.fill('#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo', String(parsed.csNum));
    await sleep(300);
    await page.click('#mf_wfm_mainFrame_btn_auctnCsSrchBtn');
    await sleep(7000);

    // "물건상세조회" 버튼 클릭 → 새 페이지에서 매물 상세 열림
    const dtlBtn = await page.$('input[id$="_btn_gdsDtlInq"]');
    if (!dtlBtn) throw new Error('no-detail-btn');
    // 클릭 후 새 페이지(popup) 대기
    const [newPage] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null),
      dtlBtn.click({ force: true, timeout: 10000 }),
    ]);
    const targetPage = newPage || page;
    await targetPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await sleep(rand(4000, 6000));

    if (DEBUG) {
      const html = await targetPage.content();
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dumpPath = (process.env.RUNNER_TEMP || os.tmpdir()) + '/realestate-page.html';
      fs.writeFileSync(dumpPath, html);
      console.log(`    [debug] HTML dumped to ${dumpPath} (${html.length}b)`);
    }

    // 모든 이미지 src 수집 (base64 또는 court URL)
    const imgs = await targetPage.evaluate(() => {
      const out = [];
      const allImgs = document.querySelectorAll('img');
      for (const el of allImgs) {
        const src = el.src || '';
        if (!src) continue;
        // placeholder 제외
        if (/loading|spinner|btn_|ico_|logo|footer|header/i.test(src)) continue;
        const r = el.getBoundingClientRect();
        // 너무 작은 이미지(아이콘) 제외
        if (r.width < 80 || r.height < 80) continue;
        out.push({
          src,
          w: Math.round(r.width),
          h: Math.round(r.height),
          id: el.id || '',
          alt: el.alt || '',
        });
      }
      return out;
    });
    return imgs;
  } finally {
    await page.close().catch(() => {});
  }
}

async function uploadOne(supabase, raw, src, idx) {
  const boCd = raw.boCd;
  const saNo = String(raw.saNo);
  let buf, ext, mime;

  const m = src.match(/^data:(image\/\w+);base64,(.+)$/);
  if (m) {
    mime = m[1];
    ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
    buf = Buffer.from(m[2], 'base64');
  } else if (src.startsWith('http')) {
    const r = await fetch(src, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.courtauction.go.kr/' },
    });
    if (!r.ok) return null;
    buf = Buffer.from(await r.arrayBuffer());
    const sig = buf.slice(0, 5).toString('hex');
    if (sig.startsWith('ffd8ff')) { ext = 'jpg'; mime = 'image/jpeg'; }
    else if (sig.startsWith('89504e')) { ext = 'png'; mime = 'image/png'; }
    else return null;
  } else {
    return null;
  }

  if (buf.length < 1500) return null; // placeholder/icon
  const path = `${boCd}/${saNo}/page-photo-${String(idx + 1).padStart(2, '0')}.${ext}`;
  const { error } = await supabase.storage.from('auction-photos').upload(path, buf, { contentType: mime, upsert: true });
  if (error) { console.log(`    upload err ${path}: ${error.message}`); return null; }
  return {
    url: `${process.env.SUPABASE_URL}/storage/v1/object/public/auction-photos/${path}`,
    path,
    source: 'detail_page',
  };
}

async function processOne(ctx, supabase, item) {
  const raw = item.raw_data ?? {};
  if (!raw.boCd || !raw.saNo) return { ok: false, reason: 'missing-ids' };

  const imgs = await fetchPagePhotos(ctx, raw, item.case_number);
  console.log(`    [${item.case_number}] 페이지에서 후보 이미지 ${imgs.length}장`);
  if (imgs.length === 0) return { ok: false, reason: 'no-imgs-on-page' };

  if (!DO_UPLOAD) return { ok: true, dry: true, count: imgs.length, sample: imgs.slice(0, 3).map(i => i.src.slice(0, 80)) };

  const photoMeta = [];
  for (let i = 0; i < imgs.length; i++) {
    const meta = await uploadOne(supabase, raw, imgs[i].src, i);
    if (meta) photoMeta.push(meta);
  }
  if (!photoMeta.length) return { ok: false, reason: 'all-decode-fail' };

  // 일괄매각 multi-row: 같은 case_number 모든 row 에 _photos / thumbnail 동기화.
  // 안 그러면 화면 카드가 다른 row 를 잡았을 때 사진 안 보임.
  const { data: siblings, error: sibErr } = await supabase
    .from('auction_items')
    .select('id, raw_data')
    .eq('case_number', item.case_number)
    .eq('source', 'court_auction')
    .eq('category', 'real_estate');
  if (sibErr) return { ok: false, reason: 'db-sib-' + sibErr.message };

  const extractedAt = new Date().toISOString();
  let updatedRows = 0;
  for (const sib of siblings ?? []) {
    const sibRaw = { ...(sib.raw_data ?? {}), _photos: photoMeta, _photos_source: 'detail_page', _photos_extracted_at: extractedAt };
    const { error } = await supabase.from('auction_items')
      .update({ raw_data: sibRaw, thumbnail_url: photoMeta[0].url })
      .eq('id', sib.id);
    if (error) console.log(`    sibling ${sib.id.slice(0,8)} FAIL: ${error.message}`);
    else updatedRows++;
  }
  return { ok: true, count: photoMeta.length, rows: updatedRows };
}

async function main() {
  console.log(`Court Realestate Photos from Page (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 윈도우 30일: 가까운 매물부터 빠르게 채우기 위해 90→30 으로 좁힘.
  // 풀이 5천건대로 줄어서 limit 30 페이스로 며칠 안에 완료 가능.
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(); future.setDate(future.getDate() + 30);

  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data, auction_date, created_at')
    .eq('source', 'court_auction').eq('category', 'real_estate')
    .not('raw_data->boCd', 'is', null)
    .gte('auction_date', today)
    .lte('auction_date', future.toISOString().slice(0, 10))
    // 사이트 list 페이지가 auction_date asc 정렬이라 같은 순서로 처리해서 첫 페이지에 사진 채움
    // tie-breaker: 같은 매각일이면 신규 매물 먼저
    .order('auction_date', { ascending: true })
    .order('created_at', { ascending: false });
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  else {
    // 사진 없거나(NEW), court 직접 URL(404 깨짐) 매물 둘 다 대상
    q = q.or('thumbnail_url.is.null,thumbnail_url.like.%courtauction.go.kr%');
    // --sudogwon: 서울/경기/인천만
    if (args.includes('--sudogwon')) q = q.in('sido', ['서울특별시', '경기도', '인천광역시']);
  }
  // multi-row case_number 중복 처리 + fail/SKIP 여유 위해 후보 풀을 LIMIT * 5 로 확보.
  const { data, error } = await q.limit(LIMIT * 5);
  if (error) { console.error(error); process.exit(1); }
  console.log(`대상 ${data.length}건`);

  if (data.length === 0) return;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2400 }, locale: 'ko-KR' });
  let ok = 0, fail = 0, consec = 0;
  // 같은 case_number 가 multi-row 로 후보에 여러 번 들어와도 한 번만 처리. 처리 시 모든 row 동기화됨.
  const processedCases = new Set();
  try {
    for (const it of data) {
      if (ok >= LIMIT) break;
      if (processedCases.has(it.case_number)) continue;
      processedCases.add(it.case_number);
      try {
        const r = await processOne(ctx, supabase, it);
        if (r.ok) {
          console.log(`[OK] ${it.case_number} ${r.count}장 (${r.rows ?? 1}개 row 동기화)${r.dry ? ' (dry)' : ''}`);
          if (r.sample) for (const s of r.sample) console.log(`  - ${s}`);
          ok++; consec = 0;
        } else {
          console.log(`[SKIP] ${it.case_number} ${r.reason}`);
          fail++;
          if (!/no-imgs|missing-ids/.test(r.reason)) consec++;
        }
      } catch (e) {
        const msg = e.message;
        console.log(`[FAIL] ${it.case_number} ${msg.slice(0, 80)}`);
        fail++;
        // 사진 자체가 없는 매물은 detail 버튼이 안 떠서 매번 같은 throw — 차단 아님
        if (!/no-detail-btn|missing-jiwonNm-or-caseno/.test(msg)) consec++;
      }
      if (consec >= 3) { console.log('3건 연속 차단성 실패 → 중단'); break; }
      await sleep(rand(3000, 5000));
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
  console.log(`완료: ok=${ok} fail=${fail}`);
}
main().catch(e => { console.error(e); process.exit(1); });
