// 법원경매 4종 문서 HTML→PDF 캡처 (c1 방식)
//
// Playwright 로 물건 상세 진입 → 각 문서 버튼 클릭 → ecfs.scourt.go.kr StreamDocs
// 렌더 대기 → page.pdf() 저장 → Supabase Storage(auction-pdfs) 업로드.
//
// 대상 문서: 매각물건명세서 / 현황조사서 / 감정평가서 / 사건상세조회
// (등기사항전부증명서는 IROS 유료 서비스로 별도 경로. 현 스크립트 대상 아님)
// 각각 상세 페이지의 버튼이 새 팝업/새 탭을 연다는 가정. 팝업이 같은 컨텍스트
// 에서 열리므로 context.on('page') 로 받아서 렌더 후 pdf() 호출.
//
// 실행:
//   node collectors/court-pdf-capture.js --limit 3               (미리보기)
//   node collectors/court-pdf-capture.js --upload --limit 3
//   node collectors/court-pdf-capture.js --upload --case 2024타경143316
//   node collectors/court-pdf-capture.js --upload --docs 매각물건명세서,등기기록
//
// 차단 방지: 기본 limit 5, 항목 간 20~30초, 문서 간 5초, 3건 연속 실패 중단.

import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(args[args.indexOf('--limit') + 1] ?? '5', 10) || 5;
const CASE_NUMBER = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
const DOCS_ARG = args.includes('--docs') ? args[args.indexOf('--docs') + 1] : null;
const CATEGORY = args.includes('--category') ? args[args.indexOf('--category') + 1] : 'all';

// 문서 정의
//  - pageType: 'gds'(PGJ15BA00 물건상세) | 'case'(PGJ151F00 물건상세검색=사건 뷰)
//  - 매각물건명세서·현황조사서·감정평가서: 물건 단위 → PGJ15BA00
//  - 등기기록열람: 사건 단위(사건 전체 등기부) → PGJ151F00
const DOC_DEFS = [
  {
    label: '매각물건명세서',
    fileName: 'dspsl-gds-spcfc.pdf',
    pageType: 'case',
    selectors: [
      'input[id$="_btn_gdsSpcfc"]',
      'input[value="매각물건명세서"]',
    ],
  },
  {
    label: '현황조사서',
    fileName: 'curst-exmndc.pdf',
    pageType: 'case',
    selectors: [
      '#mf_wfm_mainFrame_btn_curstExmndc',
      'input[id$="_btn_curstExmndc"]',
      'input[value="현황조사서"]',
    ],
  },
  {
    label: '감정평가서',
    fileName: 'aee-wevl.pdf',
    pageType: 'case',
    selectors: [
      '#mf_wfm_mainFrame_btn_aeeWevl',
      'input[id$="_btn_aeeWevl"]',
      'input[value="감정평가서"]',
    ],
  },
  {
    // 물건상세검색(PGJ151F00) → "사건상세조회" 버튼 → 사건기록 페이지
    // → 그 안의 "등기" 첨부파일 링크를 순차 클릭해 각 PDF 를 개별 캡처.
    // (IROS 유료 "등기기록 열람" 버튼은 사용 안 함)
    label: '사건상세조회',
    fileName: '사건상세조회.pdf',
    pageType: 'case',
    navSelectors: [
      '#mf_wfm_mainFrame_btn_csDtlSrch',
      '#mf_wfm_mainFrame_btn_csBaseSrch',
      'input[id$="_btn_csDtlSrch"]',
      'input[id$="_btn_csBaseSrch"]',
      'input[value="사건상세조회"]',
      'button:has-text("사건상세조회")',
      'a:has-text("사건상세조회")',
    ],
    // 사건상세조회 페이지 안에서 추가로 클릭할 등기 관련 첨부 링크
    childLinks: [
      'a:has-text("등기")',
      'a:has-text("등기사항")',
      'a:has-text("등기부")',
      'a:has-text("부동산등기")',
    ],
    childFileName: (idx, linkText) => `사건기록_등기_${idx}_${linkText.replace(/[^가-힣0-9]/g, '')}.pdf`,
    selectors: [
      '#mf_wfm_mainFrame_btn_csDtlSrch',
      'input[id$="_btn_csDtlSrch"]',
      'input[value="사건상세조회"]',
      'button:has-text("사건상세조회")',
    ],
  },
];

const ENABLED_DOCS = DOCS_ARG
  ? DOC_DEFS.filter(d => DOCS_ARG.split(',').map(s => s.trim()).includes(d.label))
  : DOC_DEFS;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const OUT_DIR = 'collectors/pdf-out';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 버튼 클릭: 텍스트 기반 locator 우선 → CSS querySelector fallback
async function tryClick(detailPage, sel) {
  try {
    if (sel.includes(':has-text(')) {
      const loc = detailPage.locator(sel).first();
      if (await loc.count() === 0) return false;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 5000 });
      return true;
    }
    // 순수 CSS → querySelector로 클릭 (WebSquare 동적 id 대응)
    return await detailPage.evaluate(s => {
      const el = document.querySelector(s);
      if (el) { el.click(); return true; }
      return false;
    }, sel).catch(() => false);
  } catch { return false; }
}

// StreamDocs lazy-load 강제 렌더: 전체 스크롤
async function forceLoadAll(page) {
  try {
    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const c = document.scrollingElement || document.body;
      const max = c.scrollHeight;
      for (let y = 0; y < max; y += 400) {
        window.scrollTo(0, y);
        await sleep(150);
      }
      window.scrollTo(0, 0);
      await sleep(500);
    });
  } catch {}
}

// 팝업이 iframe 뷰어를 품고 있으면 iframe src로 직접 이동
async function enterIframeIfAny(popup) {
  try {
    const src = await popup.evaluate(() => {
      const f = document.querySelector('iframe');
      return f?.src ?? null;
    });
    if (src && src.startsWith('http')) {
      await popup.goto(src, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    }
  } catch {}
}

// 상세 페이지에서 버튼 클릭 → 팝업 PDF 캡처
async function captureOne(detailPage, ctx, doc) {
  // WebSquare 핸들러 바인딩 대기
  try { await detailPage.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
  await sleep(1500);

  const [popup] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 40000 }).catch(() => null),
    (async () => {
      for (const sel of doc.selectors) {
        const ok = await tryClick(detailPage, sel);
        if (ok) return;
      }
      throw new Error(`btn-not-found: ${doc.label}`);
    })(),
  ]);

  const target = popup ?? detailPage;
  try { await target.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
  // 팝업이면 iframe 진입 시도
  if (popup) await enterIframeIfAny(popup);
  try { await target.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
  // StreamDocs 초기 렌더 대기
  await sleep(15000);
  // 전체 스크롤로 lazy-load 강제
  await forceLoadAll(target);
  await sleep(2000);

  const pdfBuf = await target.pdf({
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });
  if (popup) { try { await popup.close(); } catch {} }
  return pdfBuf;
}

async function capturePdf(ctx, supabase, item) {
  const raw = item.raw_data ?? {};
  const boCd = raw.boCd, saNo = String(raw.saNo), maemulSer = String(raw.maemulSer || 1);
  if (!boCd || !saNo) return { ok: false, reason: 'missing-id' };

  const gdsPage = await ctx.newPage();
  let casePage = null;
  const captured = {};
  // saNo 포맷: 20240130136561 → year=2024, csNum=136561 (중간 '0130' 등 담당계 코드 제거)
  const caseYear = saNo.slice(0, 4);
  const caseNumMatch = item.case_number?.match(/타경(\d+)/);
  const caseNum = caseNumMatch ? caseNumMatch[1] : saNo.slice(-6);
  const pageOf = async (pageType) => {
    if (pageType === 'gds') return gdsPage;
    if (!casePage) {
      casePage = await ctx.newPage();
      // 1) 홈 쿠키 확보
      await casePage.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(rand(1500, 2500));
      // 2) 경매사건검색(PGJ159M00) — 법원·연도·사건번호만으로 간단 검색
      await casePage.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml', { waitUntil: 'networkidle', timeout: 60000 });
      await sleep(rand(2500, 4000));
      // 3) 폼 채우기: 법원(한글명) · 연도 · 사건번호
      const cortNm = raw._detail?.goods?.cortOfcNm || raw._detail?.base?.cortOfcNm;
      if (cortNm) {
        await casePage.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { value: cortNm })
          .catch(() => casePage.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { label: cortNm }).catch(() => {}));
      }
      await sleep(300);
      await casePage.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear', { value: caseYear }).catch(() => {});
      await sleep(300);
      await casePage.fill('#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo', caseNum);
      await sleep(500);
      // 4) 검색 버튼 클릭
      await casePage.click('#mf_wfm_mainFrame_btn_auctnCsSrchBtn');
      // 5) 결과 로딩 대기 (매각물건명세서 버튼 나타날 때까지)
      try {
        await casePage.locator('button:has-text("매각물건명세서"), a:has-text("매각물건명세서"), input[value="매각물건명세서"]').first().waitFor({ timeout: 20000 });
      } catch {
        console.log(`    ${item.case_number}: 검색결과 버튼 대기 타임아웃, 계속 시도`);
      }
      await sleep(rand(1500, 2500));
    }
    return casePage;
  };
  try {
    // 홈 → 물건상세(gds) 진입
    await gdsPage.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(rand(2000, 3500));

    const detailUrl = `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15BA00.xml` +
      `&cortOfcCd=${boCd}&csNo=${saNo}&dspslGdsSeq=${maemulSer}&pgmId=PGJ15BA00`;
    await gdsPage.goto(detailUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(rand(4000, 6000));

    // 이미 저장된 문서는 건너뜀 (증분 업데이트)
    const existing = raw._detail?.pdfs ?? {};
    const targets = ENABLED_DOCS.filter(d => !existing[d.label]);
    if (targets.length === 0) return { ok: false, reason: 'all-captured' };

    for (const doc of targets) {
      try {
        const basePage = await pageOf(doc.pageType);
        const pdfBuf = await captureOne(basePage, ctx, doc);
        const localFile = path.join(OUT_DIR, `${item.case_number.replace(/[^0-9A-Za-z가-힣-]/g, '_')}_${doc.fileName}`);
        fs.writeFileSync(localFile, pdfBuf);

        let storagePath = null;
        if (DO_UPLOAD) {
          storagePath = `${boCd}/${saNo}/${maemulSer}/${doc.fileName}`;
          const { error: upErr } = await supabase.storage.from('auction-pdfs').upload(storagePath, pdfBuf, {
            contentType: 'application/pdf', upsert: true,
          });
          if (upErr) { console.log(`    ${doc.label} upload err: ${upErr.message}`); continue; }
        }
        captured[doc.label] = {
          path: storagePath,
          localFile,
          bytes: pdfBuf.length,
          captured_at: new Date().toISOString(),
        };
        console.log(`    ${doc.label} OK ${Math.round(pdfBuf.length / 1024)}KB`);
        await sleep(rand(4000, 6000));
      } catch (e) {
        console.log(`    ${doc.label} FAIL: ${e.message.split('\n')[0]}`);
      }
    }

    if (DO_UPLOAD && Object.keys(captured).length > 0) {
      const newRaw = { ...raw };
      newRaw._detail = newRaw._detail ?? {};
      newRaw._detail.pdfs = { ...(newRaw._detail.pdfs ?? {}) };
      for (const [label, meta] of Object.entries(captured)) {
        if (meta.path) {
          newRaw._detail.pdfs[label] = { path: meta.path, bytes: meta.bytes, captured_at: meta.captured_at };
        }
      }
      const { error: updErr } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', item.id);
      if (updErr) return { ok: false, reason: 'db-' + updErr.message };
    }

    return { ok: Object.keys(captured).length > 0, captured };
  } finally {
    try { await gdsPage.close(); } catch {}
    if (casePage) { try { await casePage.close(); } catch {} }
  }
}

async function main() {
  console.log(`Court PDF Capture (upload=${DO_UPLOAD}, limit=${LIMIT}, category=${CATEGORY}, docs=${ENABLED_DOCS.map(d => d.label).join('/')})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1); }
  const supabase = createClient(url, key);

  let q = supabase
    .from('auction_items')
    .select('id, case_number, category, raw_data')
    .eq('source', 'court_auction')
    .not('raw_data->_detail', 'is', null)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 2);
  if (CATEGORY !== 'all') q = q.eq('category', CATEGORY);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error('DB:', error.message); process.exit(1); }

  // 활성 문서 전부가 이미 저장된 건 제외
  const targets = items.filter(it => {
    const pdfs = it.raw_data?._detail?.pdfs ?? {};
    return ENABLED_DOCS.some(d => !pdfs[d.label]);
  }).slice(0, LIMIT);
  console.log(`대상 ${targets.length}건`);
  if (!targets.length) return;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 1800 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });

  let ok = 0, fail = 0, consecFail = 0;
  for (const it of targets) {
    console.log(`\n[${ok + fail + 1}/${targets.length}] ${it.case_number}`);
    try {
      const r = await capturePdf(ctx, supabase, it);
      if (r.ok) { ok++; consecFail = 0; }
      else { console.log(`  SKIP/FAIL: ${r.reason}`); fail++; consecFail++; }
    } catch (e) { console.log(`  ERR: ${e.message.split('\n')[0]}`); fail++; consecFail++; }
    if (consecFail >= 3) { console.log('\n3건 연속 실패 — 중단'); break; }
    if (ok + fail < targets.length) await sleep(rand(20000, 30000));
  }

  await browser.close();
  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
