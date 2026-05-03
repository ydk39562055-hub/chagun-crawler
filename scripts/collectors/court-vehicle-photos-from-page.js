// 차량 상세 페이지(PGJ154M00)에서 "관련사진" 영역의 base64 PNG 직접 수집.
// PDF 추출(court-vehicle-photos-from-pdf.js) 폴백 — 페이지 직접이 더 빠르고 누락 적음.
//
// 페이지 구조 (probe 확인):
//   라벨: #mf_wfm_mainFrame_gen_picTbox_0_tbx_picDvsCdNm  → "관련사진(N)"
//   img:  #mf_wfm_mainFrame_gen_pic_{N}_img_reltPic        → src = data:image/png;base64,...
//   캐러셀: 처음엔 5장만 DOM, ▶ 클릭으로 lazy load
//
// 저장: auction-photos/{boCd}/{saNo}/page-photo-{NN}.png
// DB:   raw_data._photos = [{ url, path, source: 'detail_page', page_index }, ...]
//       raw_data._photos_source = 'detail_page'
//       raw_data._photos_extracted_at
//
// 실행:
//   node collectors/court-vehicle-photos-from-page.js --case 2025타경100761 --upload
//   node collectors/court-vehicle-photos-from-page.js --upload --limit 10

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '10'), 10) || 10;
const CASE_NUMBER = argOf('--case', null);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a)) + a;

function parseCaseNo(caseNumber) {
  const m = String(caseNumber).match(/^(\d{4})타경(\d+)$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), csNum: parseInt(m[2], 10) };
}

async function fetchPagePhotos(ctx, { jiwonNm, year, csNum }) {
  const page = await ctx.newPage();
  page.on('dialog', async d => { try { await d.accept(); } catch {} });
  try {
    await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    await page.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ154M00.xml', { waitUntil: 'networkidle' });
    await sleep(2500);

    await page.selectOption('#mf_wfm_mainFrame_sbx_carTmidCortOfc', { label: jiwonNm });
    await sleep(250);
    await page.selectOption('#mf_wfm_mainFrame_sbx_carTmidCsNo', { value: String(year) });
    await sleep(250);
    await page.fill('#mf_wfm_mainFrame_ibx_csNo', String(csNum));
    await sleep(250);
    await page.click('#mf_wfm_mainFrame_btn_srchCarTmid');
    await sleep(8000);
    // 결과 행이 들어올 때까지 polling (최대 12초). 빈 표만 있으면 retry 1회.
    const waitForResultRow = async () => {
      for (let i = 0; i < 12; i++) {
        const ok = await page.evaluate(() => {
          const grd = document.querySelector('#mf_wfm_mainFrame_grd_gdsDtlSrchResult');
          const a = grd?.querySelector('a[onclick]');
          return !!(a && (a.innerText || '').trim().length > 5);
        });
        if (ok) return true;
        await sleep(1000);
      }
      return false;
    };
    if (!(await waitForResultRow())) {
      // 검색 결과가 비어있으면 그냥 종료. PGJ154M00 검색은 GH Actions/지원 사건에서
      // 자주 빈 결과로 끝나므로 retry click 은 timeout 만 잡아먹는다.
      // docs-fetch 의 aeeWevl PDF 폴백이 사진을 채워주는 구조.
      await sleep(3000);
      if (!(await waitForResultRow())) return [];
    }

    // 검색 결과의 사용본거지 링크를 텍스트 셀렉터로 클릭 (probe 검증).
    // CSS `a[onclick]` 직접 click 은 onclick 핸들러는 트리거되지만 카드 펼침 이벤트가 빠짐.
    // 텍스트로 a 안 child 잡으면 mousedown/mouseup 까지 다 발사됨.
    const diag = await page.evaluate(() => {
      const grd = document.querySelector('#mf_wfm_mainFrame_grd_gdsDtlSrchResult');
      const a = grd ? grd.querySelector('a[onclick]') : null;
      const allA = grd ? grd.querySelectorAll('a').length : -1;
      const txt = grd ? (grd.innerText || '').slice(0, 80) : 'no-grid';
      return { gridFound: !!grd, allA, hasOnclick: !!a, linkText: a ? (a.innerText || '').trim().slice(0, 40) : null, gridTxt: txt };
    });
    console.log(`    [debug] ${JSON.stringify(diag)}`);
    if (!diag.linkText) throw new Error('no-result-row');
    const linkText = diag.linkText;
    try {
      await page.locator(`text=${linkText}`).first().click({ force: true, timeout: 5000 });
    } catch (e) { throw new Error('click-fail: ' + e.message.slice(0, 60)); }
    await sleep(7000);
    try {
      await page.waitForSelector('[id*="picTbox"]', { timeout: 12000 });
    } catch {}

    // "관련사진(N)" 라벨에서 총 개수 추출
    const total = await page.evaluate(() => {
      const el = document.querySelector('#mf_wfm_mainFrame_gen_picTbox_0_tbx_picDvsCdNm');
      if (el) return { from: 'fixed', text: (el.innerText || '').slice(0, 30) };
      // 폴백: 모든 picTbox 패턴
      const all = document.querySelectorAll('[id*="picTbox"]');
      const list = [];
      for (const e of all) list.push({ id: e.id, text: (e.innerText || '').slice(0, 30) });
      return { from: 'fallback', list };
    });
    console.log(`    [debug] picTbox=${JSON.stringify(total).slice(0, 200)}`);
    const totalNum = (() => {
      if (total?.from === 'fixed') {
        const m = total.text.match(/(\d+)/); return m ? parseInt(m[1], 10) : 0;
      }
      if (total?.list?.length) {
        for (const e of total.list) { const m = e.text.match(/(\d+)/); if (m) return parseInt(m[1], 10); }
      }
      return 0;
    })();
    if (!totalNum) return [];

    // 캐러셀 ▶ 버튼: 한 번에 1장씩 보이는 카드 5장(viewport)을 통째 회전.
    // 단순 전략: ▶ 를 2N 번 클릭 (충분히 회전), 매번 visible img src 수집 후 dedupe.
    const collected = new Map(); // src(앞 200자 키) → { src, w, h, pageIndex }
    const harvest = async () => {
      const imgs = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[id^="mf_wfm_mainFrame_gen_pic_"][id$="_img_reltPic"]')) {
          const src = el.src || '';
          if (!src.startsWith('data:image/')) continue;
          const r = el.getBoundingClientRect();
          const idMatch = el.id.match(/gen_pic_(\d+)_/);
          out.push({ src, w: Math.round(r.width), h: Math.round(r.height), idx: idMatch ? parseInt(idMatch[1], 10) : -1 });
        }
        return out;
      });
      for (const im of imgs) {
        const key = im.src.slice(0, 120);
        if (!collected.has(key)) collected.set(key, im);
      }
    };

    await harvest();

    // 다음 버튼 후보 셀렉터 — 캐러셀 ▶
    const nextSelectors = [
      '#mf_wfm_mainFrame_btn_picTbNext',
      '[id*="picTb"][id*="Next"]',
      '[class*="next"]:visible',
    ];
    let nextSel = null;
    for (const s of nextSelectors) {
      const c = await page.locator(s).count().catch(() => 0);
      if (c > 0) { nextSel = s; break; }
    }

    if (nextSel && totalNum > collected.size) {
      for (let i = 0; i < totalNum + 4 && collected.size < totalNum; i++) {
        try { await page.locator(nextSel).first().click({ force: true, timeout: 2500 }); }
        catch { break; }
        await sleep(700);
        await harvest();
      }
    }

    return Array.from(collected.values()).sort((a, b) => a.idx - b.idx);
  } finally {
    await page.close().catch(() => {});
  }
}

async function processOne(ctx, supabase, item) {
  const raw = item.raw_data ?? {};
  const jiwonNm = raw.jiwonNm || raw._detail?.base?.cortOfcNm;
  const parsed = parseCaseNo(item.case_number);
  const boCd = raw.boCd;
  const saNo = String(raw.saNo || '');
  if (!jiwonNm || !parsed || !boCd || !saNo) return { ok: false, reason: 'missing-ids' };

  const photos = await fetchPagePhotos(ctx, { jiwonNm, year: parsed.year, csNum: parsed.csNum });
  if (!photos.length) return { ok: false, reason: 'no-photos' };

  if (!DO_UPLOAD) return { ok: true, dry: true, count: photos.length };

  const publicBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/auction-photos/`;
  const photoMeta = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const m = p.src.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) continue;
    const [, mime, b64] = m;
    const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 800) continue; // 너무 작으면 placeholder
    const key = `${boCd}/${saNo}/page-photo-${String(i + 1).padStart(2, '0')}.${ext}`;
    const { error } = await supabase.storage.from('auction-photos').upload(key, buf, { contentType: mime, upsert: true });
    if (error) { console.log(`    upload err ${key}: ${error.message}`); continue; }
    photoMeta.push({ url: publicBase + key, path: key, width: p.w, height: p.h, source: 'detail_page', page_index: i });
  }

  if (!photoMeta.length) return { ok: false, reason: 'all-decode-fail' };

  const newRaw = { ...(raw ?? {}) };
  newRaw._photos = photoMeta;
  newRaw._photos_source = 'detail_page';
  newRaw._photos_extracted_at = new Date().toISOString();

  // 실제 DB 컬럼 thumbnail_url 도 함께 업데이트 (이전에는 raw_data.thumbnailUrl camelCase 만 박혀 list에 반영 안 됐음)
  const dbPatch = { raw_data: newRaw };
  if (photoMeta[0]) dbPatch.thumbnail_url = photoMeta[0].url;
  const { error } = await supabase.from('auction_items').update(dbPatch).eq('id', item.id);
  if (error) return { ok: false, reason: 'db-' + error.message };
  return { ok: true, count: photoMeta.length };
}

async function main() {
  console.log(`Court Vehicle Photos from Page (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
  const future = new Date(); future.setDate(future.getDate() + 30);

  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data, auction_date, created_at')
    .eq('source', 'court_auction').eq('category', 'vehicle')
    .not('raw_data->boCd', 'is', null)
    .gte('auction_date', tomorrow.toISOString())
    .lte('auction_date', future.toISOString())
    .order('created_at', { ascending: false });   // 신규 매물 우선
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  // detail_page 가 아닌 매물은 모두 대상 — _photos_source IS NULL 또는 aeeWevl_pdf(흐릿한 PDF 사진을 진짜 페이지 사진으로 교체)
  else q = q.or('raw_data->_photos_source.is.null,raw_data->_photos_source.eq."aeeWevl_pdf"');
  const { data, error } = await q.limit(LIMIT * 3);
  if (error) { console.error(error); process.exit(1); }
  console.log(`대상 ${data.length}건`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2400 } });

  let ok = 0, fail = 0, consec = 0;
  try {
    for (const it of data) {
      if (ok >= LIMIT) break;
      try {
        const r = await processOne(ctx, supabase, it);
        if (r.ok) {
          console.log(`[OK] ${it.case_number} ${r.count}장`);
          ok++; consec = 0;
        } else {
          console.log(`[SKIP] ${it.case_number} ${r.reason}`);
          fail++;
          if (!/no-photos|missing-ids/.test(r.reason)) consec++;
        }
      } catch (e) {
        console.log(`[FAIL] ${it.case_number} ${e.message.slice(0, 80)}`);
        fail++; consec++;
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
