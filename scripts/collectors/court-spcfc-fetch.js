// 매각물건명세서 원본 PDF 수집 (법원경매 → ecfs StreamDocs 파일저장 자동화)
//
// 배경: 매각물건명세서 본문 텍스트는 JSON API 없음(뷰어 placeholder). 대신 ecfs 뷰어에
//       "파일저장" 버튼이 있어 원본 PDF(%PDF-1.4) 다운로드 가능. Playwright로 UI 자동화.
//
// 흐름:
//   1) DB에서 raw_data.boCd/saNo/maemulSer 있는 부동산 사건 조회
//   2) 각 사건마다 Playwright로 deepLink(PGJ15BA00) 이동
//   3) 매각물건명세서 버튼(#..._btn_gdsSpcfc) enabled 확인
//   4) click → ecfs 팝업 오픈
//   5) 팝업 내 #mf_btn_save(파일저장) click → confirm 있으면 "확인"
//   6) download 이벤트로 PDF 받아서 Supabase auction-pdfs 업로드
//   7) raw_data._detail.dspslGdsSpcfcPdf = { path, bytes, filename, captured_at }
//
// 실행:
//   node collectors/court-spcfc-fetch.js --case 2023타경3842 --dry
//   node collectors/court-spcfc-fetch.js --case 2023타경3842 --upload
//   node collectors/court-spcfc-fetch.js --upload --limit 10

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const DRY_RUN = args.includes('--dry') || !DO_UPLOAD;
const LIMIT = parseInt(argOf('--limit', '10'), 10) || 10;
const CASE_NUMBER = argOf('--case', null);
const CATEGORY = argOf('--category', 'real_estate'); // 'real_estate' | 'vehicle' | 'all'

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const tmpDl = await fs.mkdtemp(path.join(os.tmpdir(), 'spcfc-dl-'));
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 2400 },
    locale: 'ko-KR',
    acceptDownloads: true,
  });
  return { browser, ctx, tmpDl };
}

async function fetchPdfForCase(ctx, { jiwonNm, year, csNum }, tmpDl) {
  const page = await ctx.newPage();
  let downloaded = null;
  let downloadErr = null;

  const saveDownload = async d => {
    try {
      const to = path.join(tmpDl, `${Date.now()}-${d.suggestedFilename()}`);
      await d.saveAs(to);
      downloaded = { file: to, filename: d.suggestedFilename(), url: d.url() };
    } catch (e) { downloadErr = e.message; }
  };
  // 모든 페이지(현재 + 미래)에 download listener 부착 — GH Actions에서 popup이 아닌 main page 다운로드 사례 발견
  const onAnyPage = newPage => {
    newPage.on('download', saveDownload);
    newPage.on('dialog', d => d.accept().catch(() => {}));
  };
  ctx.on('page', onAnyPage);
  page.on('download', saveDownload);
  page.on('dialog', d => d.accept().catch(() => {}));

  try {
    // 쿠키 준비
    await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // 물건상세검색 화면
    await page.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml', { waitUntil: 'networkidle' });
    await sleep(2500);

    // 검색 조건 입력
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { value: jiwonNm });
    await sleep(200);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear', { value: String(year) });
    await sleep(200);
    await page.fill('#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo', String(csNum));
    await sleep(300);
    await page.click('#mf_wfm_mainFrame_btn_auctnCsSrchBtn');
    await sleep(8000); // GH Actions 느림 대비 6s→8s

    // 매각물건명세서 버튼 존재·활성 확인 (첫 행)
    const btnInfo = await page.evaluate(() => {
      const el = document.querySelector('input[id$="_btn_gdsSpcfc"]');
      return el ? { id: el.id, disabled: el.disabled || el.className.includes('disabled') } : null;
    });
    if (!btnInfo) throw new Error('no-btn');
    if (btnInfo.disabled) throw new Error('btn-disabled');

    // 클릭
    await page.locator(`#${btnInfo.id}`).first().click({ force: true, timeout: 10000 });

    // ecfs 팝업 뜰 때까지 대기 (GH Actions 느림 — 15s→30s)
    await Promise.race([
      ctx.waitForEvent('page', { timeout: 30000 }).catch(() => null),
      sleep(30000).then(() => null),
    ]);
    const pages = ctx.pages();
    const ecfs = pages.find(p => p.url().includes('ecfs.scourt.go.kr'));
    if (!ecfs) throw new Error('no-ecfs-popup');

    // ecfs 뷰어 로드 대기 — 8s
    // GH Actions Ubuntu runner는 한국 IP보다 느려 충분한 마진 필요
    await sleep(8000);

    // 새 sgvo 뷰어: 문서 목록 체크박스 먼저 선택해야 "파일저장" 활성화됨
    // 첫 번째 행 체크박스 클릭 시도 (체크박스 셀렉터 다양화)
    const checkboxSelectors = [
      'input[type="checkbox"][id*="chk"]:not([id*="all"])',
      'input[type="checkbox"][id*="row"]',
      'input[type="checkbox"][id*="grd"]',
      'tbody input[type="checkbox"]',
    ];
    for (const sel of checkboxSelectors) {
      const cb = await ecfs.$(sel);
      if (cb) { await cb.click({ force: true, timeout: 5000 }).catch(() => {}); break; }
    }
    await sleep(1500);

    // 파일저장 버튼 폴링 (셀렉터 다양화)
    let saveSelector = null;
    for (let i = 0; i < 30; i++) {
      if (await ecfs.$('#mf_btn_save')) { saveSelector = '#mf_btn_save'; break; }
      if (await ecfs.$('input[id*="body_btn_save"]')) { saveSelector = 'input[id*="body_btn_save"]'; break; }
      if (await ecfs.$('input[id*="btn_save"]')) { saveSelector = 'input[id*="btn_save"]'; break; }
      if (await ecfs.$('input[id*="btnSave"]')) { saveSelector = 'input[id*="btnSave"]'; break; }
      if (await ecfs.$('button[id*="save"]')) { saveSelector = 'button[id*="save"]'; break; }
      if (await ecfs.$('input[value="파일저장"]')) { saveSelector = 'input[value="파일저장"]'; break; }
      await sleep(500);
    }
    if (!saveSelector) {
      // 디버그 캡처 (GH Actions artifact 용)
      const debugDir = process.env.SPCFC_DEBUG_DIR || tmpDl;
      try {
        await ecfs.screenshot({ path: path.join(debugDir, `ecfs-no-save-btn-${Date.now()}.png`), fullPage: true });
        const html = await ecfs.content();
        await fs.writeFile(path.join(debugDir, `ecfs-no-save-btn-${Date.now()}.html`), html);
        console.log(`    [debug] ecfs popup dump → ${debugDir}`);
      } catch {}
      throw new Error('no-save-btn');
    }
    await ecfs.locator(saveSelector).click({ force: true, timeout: 10000 }).catch(() => {});

    // 확인 모달 있으면 처리 (dialog 자동 accept는 위에서 등록됨)
    await sleep(2000);
    const okBtn = await ecfs.$('input[value="확인"]:visible');
    if (okBtn) await okBtn.click({ force: true, timeout: 6000 }).catch(() => {});

    // 다운로드 대기 (60s→180s — GH Actions Ubuntu runner는 한국 IP 아니라
    // streamdocs PDF 생성/응답이 매우 느림. HTML title도 "다운로드 받기까지 다소 시간이 소요"
    const deadline = Date.now() + 180000;
    while (!downloaded && Date.now() < deadline) await sleep(500);
    if (!downloaded) {
      // 디버그 캡처: 파일저장 클릭 후에도 download 이벤트 없으면 popup 상태 dump
      const debugDir = process.env.SPCFC_DEBUG_DIR || tmpDl;
      try {
        const ts = Date.now();
        await ecfs.screenshot({ path: path.join(debugDir, `ecfs-dl-timeout-${ts}.png`), fullPage: true });
        const html = await ecfs.content();
        await fs.writeFile(path.join(debugDir, `ecfs-dl-timeout-${ts}.html`), html);
        // 모든 페이지 URL 기록 (확인 모달이 다른 페이지로 나왔는지)
        const allPages = ctx.pages().map(p => p.url()).join('\n');
        await fs.writeFile(path.join(debugDir, `ecfs-dl-timeout-${ts}-pages.txt`), allPages);
        console.log(`    [debug] download-timeout dump → ${debugDir}`);
      } catch {}
      throw new Error(downloadErr || 'download-timeout');
    }

    const buf = await fs.readFile(downloaded.file);
    if (!buf.slice(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('not-pdf-magic');
    if (buf.length < 5000) throw new Error(`too-small-${buf.length}`);
    return { buf, filename: downloaded.filename, url: downloaded.url };
  } finally {
    ctx.off('page', onAnyPage);
    await page.close().catch(() => {});
    for (const p of ctx.pages()) { if (p !== page) await p.close().catch(() => {}); }
  }
}

function parseCaseNo(s) {
  // "2023타경3842" → { year: '2023', csNum: '3842' }
  const m = String(s || '').match(/^(\d{4})\D+(\d+)/);
  return m ? { year: m[1], csNum: m[2] } : null;
}

async function processCaseGroup(ctx, supabase, caseKey, items, tmpDl) {
  const first = items[0];
  const raw = first.raw_data ?? {};
  // jiwonNm: real_estate는 list에서, vehicle은 _detail.base.cortOfcNm에서 (cortSptNm이 있으면 지원이 우선)
  const jiwonNm = raw.jiwonNm
    || raw._detail?.base?.cortSptNm
    || raw._detail?.base?.cortOfcNm
    || null;
  const parsed = parseCaseNo(first.case_number);
  if (!jiwonNm || !parsed) return { ok: false, reason: `missing-ids (jiwonNm=${!!jiwonNm}, parsed=${!!parsed})` };

  const { buf, filename, url } = await fetchPdfForCase(ctx, { jiwonNm, year: parsed.year, csNum: parsed.csNum }, tmpDl);

  const meta = {
    bytes: buf.length,
    filename,
    captured_at: new Date().toISOString(),
    sourceUrl: url,
  };

  if (DO_UPLOAD) {
    const boCd = raw.boCd;
    const saNo = String(raw.saNo || '');
    const storagePath = `${boCd}/${saNo}/dspsl-gds-spcfc.pdf`;
    const { error: upErr } = await supabase.storage.from('auction-pdfs').upload(storagePath, buf, {
      contentType: 'application/pdf', upsert: true,
    });
    if (upErr) throw new Error('storage-' + upErr.message);
    meta.path = storagePath;

    // 같은 사건의 모든 물건 row 에 동일 PDF 참조 저장
    for (const it of items) {
      const newRaw = { ...(it.raw_data ?? {}) };
      newRaw._detail = { ...(newRaw._detail ?? {}), dspslGdsSpcfcPdf: meta };
      const { error: dbErr } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', it.id);
      if (dbErr) throw new Error('db-' + dbErr.message);
    }
  }

  return { ok: true, bytes: buf.length, filename, path: meta.path, rowsUpdated: items.length };
}

async function main() {
  console.log(`Court Spcfc Fetch — 매각물건명세서 (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE env missing'); process.exit(1); }
  const supabase = createClient(url, key);

  // 법원은 매각 7일 전쯤 매각물건명세서 공개. 매각 당일 이후는 이미 닫힘.
  // 하한을 내일로: 오늘 매각 끝난 건은 btn-disabled만 반환됨 → 자동중단 유발했던 버그
  // 상한 10일: 7일 전 공개되지만, 우리 cron 늦게 돌 때 대비 +3일 마진 (8~10일 건은
  // btn-disabled 받겠지만 consec 카운트 제외(line 241~)라 안전장치 오발 안 함)
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
  const twoWeeks = new Date(); twoWeeks.setDate(twoWeeks.getDate() + 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data, auction_date')
    .eq('source', 'court_auction')
    .not('raw_data->boCd', 'is', null)
    .gte('auction_date', tomorrow.toISOString())
    .lte('auction_date', twoWeeks.toISOString())
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 8);
  if (CATEGORY !== 'all') q = q.eq('category', CATEGORY);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error('DB:', error.message); process.exit(1); }

  // 사건 단위 그룹핑 (boCd|saNo). 이미 PDF 있는 row 제외
  const byCase = new Map();
  for (const it of (items || [])) {
    if (it.raw_data?._detail?.dspslGdsSpcfcPdf?.path) continue;
    const raw = it.raw_data ?? {};
    const key = `${raw.boCd}|${raw.saNo}`;
    if (!byCase.has(key)) byCase.set(key, []);
    byCase.get(key).push(it);
  }
  const caseGroups = Array.from(byCase.entries()).slice(0, LIMIT);
  console.log(`대상 ${caseGroups.length}건 (물건 row ${caseGroups.reduce((a,[,v])=>a+v.length,0)}개)`);
  if (!caseGroups.length) return;

  const { browser, ctx, tmpDl } = await openBrowser();
  let ok = 0, fail = 0, consec = 0;
  try {
    let idx = 0;
    for (const [key, group] of caseGroups) {
      idx++;
      const cn = group[0].case_number;
      console.log(`\n[${idx}/${caseGroups.length}] ${cn} (${key}, rows=${group.length})`);
      try {
        const r = await processCaseGroup(ctx, supabase, key, group, tmpDl);
        if (r.ok) { console.log(`  OK ${Math.round(r.bytes/1024)}KB — ${r.filename} → ${r.path || '(dry-run)'} (rows=${r.rowsUpdated ?? 0})`); ok++; consec = 0; }
        else {
          console.log(`  SKIP: ${r.reason}`); fail++;
          if (!/missing-ids|btn-disabled|no-btn/.test(r.reason || '')) consec++;
        }
      } catch (e) {
        const msg = String(e.message || e).split('\n')[0];
        console.log(`  FAIL: ${msg}`); fail++;
        // btn-disabled / no-btn 은 법원 정책(비활성)이지 차단이 아님 — consec 증가 X
        if (!/btn-disabled|no-btn/.test(msg)) consec++;
      }
      if (consec >= 3) { console.log('\n3건 연속 "차단성" 실패 — 중단'); break; }
      if (idx < caseGroups.length) await sleep(rand(3000, 5500));
    }
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await fs.rm(tmpDl, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
