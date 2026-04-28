// 문건/송달내역 스냅샷 수집 (PDF + JSON)
//
// 배경: 법원경매 PGJ159M00 사건검색 결과 페이지는 탭 구성.
//       tabs1=사건기본내역 / tabs2=물건내역 / tabs3=문건/송달내역 / ...
//       tabs3 클릭 → 문건처리내역 + 송달내역 테이블 렌더됨.
//
// 저장:
//   - auction-pdfs/{boCd}/{saNo}/docs-snap.pdf   — 탭 렌더 후 PDF
//   - auction-pdfs/{boCd}/{saNo}/docs-snap.json  — 테이블 구조화
// DB:
//   - raw_data._detail.docsSnapPdf  = { path, bytes, captured_at }
//   - raw_data._detail.docsSnapJson = { path, docRcptCount, srvcDlvrCount, captured_at }
//
// 실행:
//   node collectors/court-docs-snap.js --case 2023타경3842 --dry
//   node collectors/court-docs-snap.js --case 2023타경3842 --upload
//   node collectors/court-docs-snap.js --upload --limit 10
//   node collectors/court-docs-snap.js --upload --category vehicle --limit 10

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const FORCE = args.includes('--force');
const LIMIT = parseInt(argOf('--limit', '10'), 10) || 10;
const CASE_NUMBER = argOf('--case', null);
const CATEGORY = argOf('--category', 'real_estate');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

const DOCS_TAB_ID = 'mf_wfm_mainFrame_tac_srchRsltDvs_tab_tabs3_tabHTML';

async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 2400 },
  });
  return { browser, ctx };
}

function parseCaseNo(s) {
  const m = String(s || '').match(/^(\d{4})\D+(\d+)/);
  return m ? { year: m[1], csNum: m[2] } : null;
}

async function extractDocsTables(page) {
  return await page.evaluate(() => {
    function headerKey(text) {
      const t = (text || '').replace(/\s+/g, '');
      if (/접수일|접수일자/.test(t)) return 'date';
      if (/^문건명$|접수내역/.test(t)) return 'docName';
      if (/제출자/.test(t)) return 'submitter';
      if (/송달일|송달일자/.test(t)) return 'deliveryDate';
      if (/받는사람|수취인/.test(t)) return 'receiver';
      if (/송달내용|송달내역/.test(t)) return 'content';
      if (/^결과$|송달결과|송달방법/.test(t)) return 'result';
      return null;
    }
    function parseTable(table) {
      const rows = Array.from(table.querySelectorAll('tr'));
      if (rows.length < 2) return { keys: [], rows: [] };
      const headers = Array.from(rows[0].querySelectorAll('th,td')).map(c => c.textContent.trim());
      const keys = headers.map(headerKey);
      const out = [];
      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('td,th')).map(c => c.textContent.trim());
        if (cells.every(v => !v)) continue;
        const rec = {};
        cells.forEach((v, idx) => {
          const k = keys[idx];
          if (k) rec[k] = v;
        });
        if (Object.keys(rec).length) out.push(rec);
      }
      return { keys, rows: out };
    }
    // tabs3 패널 스코프
    const tabPanel = document.querySelector('#mf_wfm_mainFrame_tac_srchRsltDvs_contents_tabs3, [id*="tabs3_contents"], [id*="tabs3Contents"]')
      || document.querySelector('[id*="tabs3"][id*="contents"]');
    const scope = tabPanel || document;
    const tables = Array.from(scope.querySelectorAll('table'));

    // 헤더 키 세트로 문건/송달 판정
    const DOC_KEYS = ['date', 'docName', 'submitter'];
    const DLV_KEYS = ['deliveryDate', 'content', 'result'];

    const result = { docRcpt: [], srvcDlvr: [] };
    for (const t of tables) {
      const { keys, rows } = parseTable(t);
      if (rows.length === 0) continue;
      const hit = new Set(keys.filter(Boolean));
      const docScore = DOC_KEYS.filter(k => hit.has(k)).length;
      const dlvScore = DLV_KEYS.filter(k => hit.has(k)).length;
      if (docScore >= 2 && docScore > dlvScore) {
        result.docRcpt.push(...rows);
      } else if (dlvScore >= 2 && dlvScore >= docScore) {
        result.srvcDlvr.push(...rows);
      }
    }
    return result;
  });
}

async function captureDocsForCase(ctx, { jiwonNm, year, csNum }) {
  const page = await ctx.newPage();
  try {
    // 쿠키 확보
    await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);

    // 사건 검색
    await page.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(2500);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { value: jiwonNm });
    await sleep(200);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear', { value: String(year) });
    await sleep(200);
    await page.fill('#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo', String(csNum));
    await sleep(300);
    await page.click('#mf_wfm_mainFrame_btn_auctnCsSrchBtn');
    await sleep(6000);

    // "문건/송달내역" 탭 클릭
    const tabExists = await page.evaluate((id) => !!document.getElementById(id), DOCS_TAB_ID);
    if (!tabExists) throw new Error('no-docs-tab');

    await page.locator(`#${DOCS_TAB_ID}`).first().click({ force: true, timeout: 6000 });
    await sleep(4000);

    // 탭 컨텐츠 렌더 대기
    const deadline = Date.now() + 20000;
    let tableCount = 0;
    while (Date.now() < deadline) {
      tableCount = await page.evaluate(() => {
        const panel = document.querySelector('[id*="tabs3"][id*="contents"], [id*="tabs3_contents"]');
        const scope = panel || document.body;
        return scope.querySelectorAll('table').length;
      }).catch(() => 0);
      if (tableCount >= 1) break;
      await sleep(1000);
    }
    await sleep(1500);

    const structured = await extractDocsTables(page).catch(() => ({ docRcpt: [], srvcDlvr: [] }));
    console.log(`    문건=${structured.docRcpt.length} 송달=${structured.srvcDlvr.length} tables=${tableCount}`);

    // PDF 스냅샷 — 탭 영역이 표시된 상태의 전체 페이지
    await page.emulateMedia({ media: 'print' }).catch(() => {});
    const pdfBuf = await page.pdf({
      width: '1200px',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      preferCSSPageSize: false,
    });
    if (!pdfBuf.slice(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('not-pdf-magic');
    if (pdfBuf.length < 2000) throw new Error(`pdf-too-small-${pdfBuf.length}`);

    return {
      pdfBuf,
      json: {
        captured_at: new Date().toISOString(),
        sourceUrl: page.url(),
        ...structured,
      },
      docRcptCount: structured.docRcpt.length,
      srvcDlvrCount: structured.srvcDlvr.length,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function processCaseGroup(ctx, supabase, items) {
  const first = items[0];
  const raw = first.raw_data ?? {};
  const jiwonNm = raw.jiwonNm
    || raw._detail?.base?.cortSptNm
    || raw._detail?.base?.cortOfcNm
    || null;
  const parsed = parseCaseNo(first.case_number);
  if (!jiwonNm || !parsed) return { ok: false, reason: `missing-ids (jiwonNm=${!!jiwonNm}, parsed=${!!parsed})` };

  const boCd = raw.boCd;
  const saNo = String(raw.saNo || '');
  if (!boCd || !saNo) return { ok: false, reason: 'no-boCd-saNo' };

  const { pdfBuf, json, docRcptCount, srvcDlvrCount } = await captureDocsForCase(ctx, { jiwonNm, year: parsed.year, csNum: parsed.csNum });

  const pdfMeta = { bytes: pdfBuf.length, captured_at: json.captured_at };

  if (DO_UPLOAD) {
    const pdfPath = `${boCd}/${saNo}/docs-snap.pdf`;
    const { error: e1 } = await supabase.storage.from('auction-pdfs').upload(pdfPath, pdfBuf, {
      contentType: 'application/pdf', upsert: true,
    });
    if (e1) throw new Error('pdf-storage-' + e1.message);
    pdfMeta.path = pdfPath;

    // JSON 은 DB raw_data 에 inline 저장 (bucket 이 application/pdf 만 허용)
    const docsData = {
      captured_at: json.captured_at,
      docRcpt: json.docRcpt,
      srvcDlvr: json.srvcDlvr,
      docRcptCount,
      srvcDlvrCount,
    };

    for (const it of items) {
      const newRaw = { ...(it.raw_data ?? {}) };
      newRaw._detail = { ...(newRaw._detail ?? {}), docsSnapPdf: pdfMeta, docsSnap: docsData };
      const { error: dbErr } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', it.id);
      if (dbErr) throw new Error('db-' + dbErr.message);
    }
  }

  return { ok: true, bytes: pdfBuf.length, docRcptCount, srvcDlvrCount, path: pdfMeta.path, rowsUpdated: items.length };
}

async function main() {
  console.log(`Court Docs Snap — 문건/송달내역 (upload=${DO_UPLOAD}, limit=${LIMIT}, category=${CATEGORY}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE env missing'); process.exit(1); }
  const supabase = createClient(url, key);

  // 매각일 미래 + 가까운 순. 이미 끝난 사건은 문건/송달 페이지가 닫힌 경우 있음 → 3연속 실패 가드 위험
  const todayIso = new Date().toISOString().slice(0, 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data, auction_date')
    .eq('source', 'court_auction').eq('category', CATEGORY)
    .not('raw_data->boCd', 'is', null)
    .gte('auction_date', todayIso)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 8);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error('DB:', error.message); process.exit(1); }

  const byCase = new Map();
  for (const it of (items || [])) {
    if (!FORCE && it.raw_data?._detail?.docsSnapPdf?.path) continue;
    const raw = it.raw_data ?? {};
    const k = `${raw.boCd}|${raw.saNo}`;
    if (!byCase.has(k)) byCase.set(k, []);
    byCase.get(k).push(it);
  }
  const groups = Array.from(byCase.entries()).slice(0, LIMIT);
  console.log(`대상 ${groups.length}건`);
  if (!groups.length) return;

  const { browser, ctx } = await openBrowser();
  let ok = 0, fail = 0, consec = 0;
  try {
    let idx = 0;
    for (const [k, group] of groups) {
      idx++;
      const cn = group[0].case_number;
      console.log(`\n[${idx}/${groups.length}] ${cn} (${k}, rows=${group.length})`);
      try {
        const r = await processCaseGroup(ctx, supabase, group);
        if (r.ok) {
          console.log(`  OK ${Math.round(r.bytes/1024)}KB 문건=${r.docRcptCount} 송달=${r.srvcDlvrCount} → ${r.path || '(dry)'}`);
          ok++; consec = 0;
        } else { console.log(`  SKIP ${r.reason}`); fail++; consec++; }
      } catch (e) { console.log(`  FAIL: ${String(e.message || e).split('\n')[0]}`); fail++; consec++; }
      if (consec >= 3) { console.log('\n3건 연속 실패 — 중단'); break; }
      if (idx < groups.length) await sleep(rand(3000, 5500));
    }
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
}

if (process.argv[1] && process.argv[1].endsWith('court-docs-snap.js')) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { captureDocsForCase, extractDocsTables };
