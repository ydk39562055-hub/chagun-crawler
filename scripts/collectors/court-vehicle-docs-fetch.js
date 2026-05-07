// 차량 사건의 현황조사서/감정평가서/매각공고 PDF 수집
//
// 경매사건검색(PGJ159M00) → 사건 검색 → 버튼 클릭 → direct download.
// WebSquare 특성상 한 페이지에서 연속 버튼 클릭은 실패하므로
// 부동산 court-spcfc-fetch.js 와 동일하게 **각 버튼마다 새 page+검색** 패턴을 사용.
//
// 저장:
//   auction-pdfs/{boCd}/{saNo}/aee-wevl.pdf           (감정평가서)
//   auction-pdfs/{boCd}/{saNo}/curst-exmn.pdf         (현황조사서)
//   auction-pdfs/{boCd}/{saNo}/dspsl-dxdy-pbanc.pdf   (매각기일공고)
//   auction-photos/{boCd}/{saNo}/detail.png           (상세 페이지 스크린샷)
//
// 실행:
//   node collectors/court-vehicle-docs-fetch.js --case 2025타경73228 --upload
//   node collectors/court-vehicle-docs-fetch.js --upload --limit 5
//   node collectors/court-vehicle-docs-fetch.js --upload --only aeeWevl   (특정 종류만)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractFromPdf, uploadExtractedPhotos } from './court-vehicle-photos-from-pdf.js';
import { captureDocsForCase } from './court-docs-snap.js';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '5'), 10) || 5;
const CASE_NUMBER = argOf('--case', null);
const ONLY = argOf('--only', null); // aeeWevl | curstExmn | dspslDxdyPbanc | detailSnap

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function parseCaseNo(s) {
  const m = String(s || '').match(/^(\d{4})\D+(\d+)/);
  return m ? { year: m[1], csNum: m[2] } : null;
}

async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const tmpDl = await fs.mkdtemp(path.join(os.tmpdir(), 'veh-docs-'));
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 2400 },
    locale: 'ko-KR',
    acceptDownloads: true,
  });
  return { browser, ctx, tmpDl };
}

/**
 * 새 page 열고 검색 → 버튼 1개 클릭 → PDF 또는 screenshot 반환.
 *
 * kind:
 *   - 'aeeWevl'         → #mf_wfm_mainFrame_btn_aeeWevl (direct download)
 *   - 'curstExmn'       → #mf_wfm_mainFrame_btn_curstExmndc (direct download)
 *   - 'dspslDxdyPbanc'  → #mf_wfm_mainFrame_gen_gdsDts_0_btn_dspslDxdyPbanc
 *   - 'detailSnap'      → 전체 페이지 스크린샷
 */
async function fetchOne(ctx, { jiwonNm, year, csNum, kind }, tmpDl) {
  const page = await ctx.newPage();
  let downloaded = null;
  let downloadErr = null;

  const saveDownload = async d => {
    try {
      const to = path.join(tmpDl, `${Date.now()}-${d.suggestedFilename()}`);
      await d.saveAs(to);
      downloaded = { file: to, filename: d.suggestedFilename() };
    } catch (e) { downloadErr = e.message; }
  };
  const onPopup = p => p.on('download', saveDownload);
  ctx.on('page', onPopup);
  page.on('download', saveDownload);
  page.on('dialog', async d => { try { await d.accept(); } catch {} });

  try {
    // GH runner는 한국 IP보다 느려 dropdown options이 30초 안에 안 차는 경우 빈발 → timeout 90s
    await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await page.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml', { waitUntil: 'networkidle' });
    await sleep(3000);

    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { value: jiwonNm }, { timeout: 90000 });
    await sleep(200);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear', { value: String(year) }, { timeout: 90000 });
    await sleep(200);
    await page.fill('#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo', String(csNum));
    await sleep(300);
    await page.click('#mf_wfm_mainFrame_btn_auctnCsSrchBtn');
    await sleep(8000);   // GH 느림 대비 5s→8s

    const hasError = await page.evaluate(() => (document.body.innerText || '').includes('잘못된 번호'));
    if (hasError) throw new Error('invalid-case-number');

    if (kind === 'detailSnap') {
      const snap = await page.screenshot({ type: 'png', fullPage: true });
      if (!snap || snap.length < 10000) throw new Error(`snap-too-small-${snap?.length}`);
      return { kind, buf: snap };
    }

    // 버튼 ID 후보
    const idCandidates = {
      aeeWevl: ['mf_wfm_mainFrame_btn_aeeWevl', 'mf_wfm_mainFrame_btn_aeeWevl2'],
      curstExmn: ['mf_wfm_mainFrame_btn_curstExmndc', 'mf_wfm_mainFrame_btn_curstExmndc2'],
      dspslDxdyPbanc: ['mf_wfm_mainFrame_gen_gdsDts_0_btn_dspslDxdyPbanc'],
    }[kind];
    if (!idCandidates) throw new Error(`unknown-kind-${kind}`);

    const btnInfo = await page.evaluate((ids) => {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && !el.disabled) return { id: el.id };
      }
      return null;
    }, idCandidates);
    if (!btnInfo) throw new Error(`no-btn ${idCandidates[0]}`);

    await page.locator(`#${btnInfo.id}`).first().click({ force: true, timeout: 6000 });

    // 바로 alert 체크
    await sleep(800);
    const alertMsg = await page.evaluate(() => {
      const els = document.querySelectorAll('[id$="_tbx_message"]');
      for (const el of els) {
        if (el.offsetParent !== null) {
          const t = (el.innerText || '').trim();
          if (t) return t;
        }
      }
      return null;
    }).catch(() => null);
    if (alertMsg) {
      await page.locator('[id$="_btn_confirm"]:visible').first().click({ force: true }).catch(() => {});
      throw new Error(`alert: ${alertMsg.slice(0, 60)}`);
    }

    // ecfs 팝업 여부 체크
    await sleep(3000);
    const ecfs = ctx.pages().find(p => p !== page && p.url().includes('ecfs.scourt.go.kr'));
    if (ecfs) {
      await sleep(3000);
      const hasSave = await ecfs.evaluate(() => !!document.querySelector('#mf_btn_save')).catch(() => false);
      if (hasSave) await ecfs.locator('#mf_btn_save').click({ force: true, timeout: 6000 }).catch(() => {});
      await sleep(1500);
      const okBtn = await ecfs.$('input[value="확인"]:visible');
      if (okBtn) await okBtn.click({ force: true, timeout: 4000 }).catch(() => {});
    }

    // 다운로드 대기 (최대 20초)
    const deadline = Date.now() + 20000;
    while (!downloaded && Date.now() < deadline) await sleep(500);
    if (!downloaded) throw new Error(downloadErr || 'download-timeout');

    const buf = await fs.readFile(downloaded.file);
    if (!buf.slice(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('not-pdf-magic');
    if (buf.length < 5000) throw new Error(`too-small-${buf.length}`);
    return { kind, buf, filename: downloaded.filename };
  } finally {
    ctx.off('page', onPopup);
    for (const p of ctx.pages()) { if (p !== page) await p.close().catch(() => {}); }
    await page.close().catch(() => {});
  }
}

async function processCase(ctx, supabase, item, tmpDl) {
  const raw = item.raw_data ?? {};
  const jiwonNm = raw.jiwonNm
    || raw._detail?.base?.cortSptNm
    || raw._detail?.base?.cortOfcNm;
  const parsed = parseCaseNo(item.case_number);
  const boCd = raw.boCd;
  const saNo = String(raw.saNo || '');
  if (!jiwonNm || !parsed || !boCd || !saNo) return { ok: false, reason: 'missing-ids' };

  // 차량엔 현황조사서(curstExmn)가 대부분 없음 → 기본 스킵. --with-curst 로 복귀.
  const INCLUDE_CURST = args.includes('--with-curst');
  const kinds = ONLY
    ? [ONLY]
    : INCLUDE_CURST
      ? ['aeeWevl', 'curstExmn', 'dspslDxdyPbanc', 'detailSnap']
      : ['aeeWevl', 'dspslDxdyPbanc', 'detailSnap'];

  const out = {};
  for (const kind of kinds) {
    try {
      const r = await fetchOne(ctx, { jiwonNm, year: parsed.year, csNum: parsed.csNum, kind }, tmpDl);
      out[kind] = r;
      if (kind === 'detailSnap') console.log(`    ${kind} OK ${Math.round(r.buf.length / 1024)}KB`);
      else console.log(`    ${kind} OK ${Math.round(r.buf.length / 1024)}KB → ${r.filename}`);
    } catch (e) {
      console.log(`    ${kind} SKIP: ${e.message.slice(0, 80)}`);
    }
    await sleep(rand(500, 1200));
  }

  if (Object.keys(out).length === 0) return { ok: false, reason: 'nothing-captured' };
  if (!DO_UPLOAD) return { ok: true, dry: true, captured: Object.keys(out) };

  const baseDir = `${boCd}/${saNo}`;
  const update = { ...(raw ?? {}) };
  update._detail = { ...(update._detail ?? {}) };

  async function uploadPdf(key, buf, filename) {
    const p = `${baseDir}/${key}.pdf`;
    const { error } = await supabase.storage.from('auction-pdfs').upload(p, buf, { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error(`${key}-${error.message}`);
    return { path: p, bytes: buf.length, filename, captured_at: new Date().toISOString() };
  }

  if (out.aeeWevl) {
    update._detail.aeeWevlPdf = await uploadPdf('aee-wevl', out.aeeWevl.buf, out.aeeWevl.filename);
    // 감정평가서 PDF 내부 사진 추출 → auction-photos 업로드
    // 단 thumbnail_url 은 박지 않음 — photos-from-page가 진짜 페이지 사진을 채울 때까지 양보
    try {
      const extracted = await extractFromPdf(out.aeeWevl.buf);
      if (extracted.length > 0) {
        const photoMeta = await uploadExtractedPhotos(supabase, { boCd, saNo, photos: extracted });
        if (photoMeta.length > 0) {
          update._photos = photoMeta;
          update._photos_source = 'aeeWevl_pdf';
          update._photos_extracted_at = new Date().toISOString();
          console.log(`    photos ${photoMeta.length}장 추출·업로드 (thumbnail_url은 진짜 사진 도착 대기)`);
        }
      } else {
        console.log(`    photos 0장 (PDF 내부에 사용 가능한 사진 없음)`);
      }
    } catch (e) {
      console.log(`    photos skip: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  if (out.curstExmn) update._detail.curstExmnPdf = await uploadPdf('curst-exmn', out.curstExmn.buf, out.curstExmn.filename);
  if (out.dspslDxdyPbanc) update._detail.dspslDxdyPbancPdf = await uploadPdf('dspsl-dxdy-pbanc', out.dspslDxdyPbanc.buf, out.dspslDxdyPbanc.filename);
  if (out.detailSnap) {
    const p = `${baseDir}/detail.png`;
    const { error } = await supabase.storage.from('auction-photos').upload(p, out.detailSnap.buf, { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`snap-${error.message}`);
    update._detail.detailSnap = { path: p, bytes: out.detailSnap.buf.length, captured_at: new Date().toISOString() };
  }

  // 문건/송달 스냅샷 (법원 호출)
  try {
    const { pdfBuf, json, docRcptCount, srvcDlvrCount } = await captureDocsForCase(ctx, {
      jiwonNm, year: parsed.year, csNum: parsed.csNum,
    });
    const docsPath = `${baseDir}/docs-snap.pdf`;
    const { error: dsErr } = await supabase.storage.from('auction-pdfs').upload(docsPath, pdfBuf, {
      contentType: 'application/pdf', upsert: true,
    });
    if (dsErr) throw new Error('docs-' + dsErr.message);
    update._detail.docsSnapPdf = { path: docsPath, bytes: pdfBuf.length, captured_at: json.captured_at };
    update._detail.docsSnap = {
      captured_at: json.captured_at,
      docRcpt: json.docRcpt, srvcDlvr: json.srvcDlvr,
      docRcptCount, srvcDlvrCount,
    };
    console.log(`    docsSnap OK 문건=${docRcptCount} 송달=${srvcDlvrCount}`);
  } catch (e) {
    console.log(`    docsSnap SKIP: ${String(e.message || e).slice(0, 80)}`);
  }

  const dbPatch = { raw_data: update };
  const { error: dbErr } = await supabase.from('auction_items').update(dbPatch).eq('id', item.id);
  if (dbErr) throw new Error('db-' + dbErr.message);

  return { ok: true, captured: Object.keys(out) };
}

async function main() {
  console.log(`Vehicle Docs Fetch (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''}${ONLY ? ', only=' + ONLY : ''})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE env missing'); process.exit(1); }
  const supabase = createClient(url, key);

  // 90일 롤링 윈도우
  const today = new Date().toISOString().slice(0, 10);
  const window90 = new Date(); window90.setDate(window90.getDate() + 90);
  const window90Iso = window90.toISOString().slice(0, 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data, auction_date')
    .eq('source', 'court_auction').eq('category', 'vehicle')
    .not('raw_data->boCd', 'is', null)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 2);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  else {
    q = q.gte('auction_date', today).lte('auction_date', window90Iso);
    // 이미 aeeWevl PDF가 다운된 매물은 skip — 가장 비싼 단계 회피.
    // --redo 옵션으로 강제 재처리 가능.
    if (!args.includes('--redo')) q = q.is('raw_data->_detail->aeeWevlPdf', null);
  }
  const { data, error } = await q;
  if (error) { console.error(error); process.exit(1); }

  const seen = new Set();
  const items = [];
  for (const it of data) {
    if (seen.has(it.case_number)) continue;
    seen.add(it.case_number);
    items.push(it);
    if (items.length >= LIMIT) break;
  }
  console.log(`대상 ${items.length}건`);

  const { browser, ctx, tmpDl } = await openBrowser();
  let ok = 0, fail = 0, consec = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      console.log(`\n[${i+1}/${items.length}] ${it.case_number}`);
      try {
        const r = await processCase(ctx, supabase, it, tmpDl);
        if (r.ok && (r.captured?.length || 0) > 0) {
          console.log(`  OK captured=${r.captured.join(',')}`); ok++; consec = 0;
        } else {
          console.log(`  SKIP ${r.reason || 'nothing-captured'}`); fail++; consec++;
        }
      } catch (e) {
        console.log(`  FAIL: ${String(e.message || e).split('\n')[0]}`);
        fail++; consec++;
      }
      if (consec >= 3) { console.log('\n3건 연속 실패 — 중단'); break; }
      if (i < items.length - 1) await sleep(rand(3500, 5500));
    }
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await fs.rm(tmpDl, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n완료: ok=${ok} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
