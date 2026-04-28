// 사건상세조회 → 등기기록열람 경로 탐색 (1회용 probe)
//
// 목적: 실제 DOM/네트워크 캡처해서 아래를 확정.
//   1. 물건상세검색(PGJ151F00) 페이지의 "사건상세조회" 버튼 진짜 ID
//   2. 사건상세 페이지의 "등기기록열람" 버튼 진짜 ID
//   3. 등기기록열람 클릭 시 응답 (점검 메시지? 팝업? 실제 PDF?)
//   4. 법원경매 홈의 다수조회/관심 리스트 API 경로
//
// 실행: GitHub Actions 에서 1회.
//   node collectors/court-probe-case.js --case 2024타경143316 --court 000272
//
// 출력: collectors/probe-out/ 에 HTML·스크린샷·네트워크 로그 저장 → artifact.

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const idx = (f) => args.indexOf(f);
const CASE = args[idx('--case') + 1] || '2024타경143316';
const COURT = args[idx('--court') + 1] || '000272';
const SA_NO = args[idx('--saNo') + 1] || CASE.replace(/[^0-9]/g, '');

const OUT = 'collectors/probe-out';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (name, body) => fs.writeFileSync(path.join(OUT, name), body);
const log = [];
const push = (msg) => { console.log(msg); log.push(`[${new Date().toISOString()}] ${msg}`); };

async function dumpButtons(page, tag) {
  const found = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('input[type="button"], button, a').forEach(el => {
      const label = (el.value || el.textContent || el.title || '').trim().slice(0, 40);
      if (!label) return;
      // 관심 키워드만
      if (!/(사건|등기|열람|기록|조회|상세|첨부|문건|목록)/.test(label)) return;
      const id = el.id || '';
      const key = `${id}|${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ tag: el.tagName, id, name: el.name || '', value: el.value || '', text: label, onclick: (el.getAttribute('onclick') || '').slice(0, 80) });
    });
    return out;
  });
  push(`[${tag}] 버튼 ${found.length}개`);
  found.forEach(b => push(`  - <${b.tag}> id=${b.id} value="${b.value}" text="${b.text}"`));
  return found;
}

async function main() {
  push(`probe 시작 — case=${CASE} court=${COURT} saNo=${SA_NO}`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 1800 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });

  const netLog = [];
  ctx.on('response', async (res) => {
    const u = res.url();
    if (u.includes('courtauction.go.kr') && (u.includes('.on') || u.includes('.json'))) {
      const rec = { url: u, status: res.status(), ts: Date.now() };
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text')) {
          const body = (await res.text()).slice(0, 400);
          rec.sample = body;
        }
      } catch {}
      netLog.push(rec);
    }
  });

  // 팝업 전부 캡처
  const popups = [];
  ctx.on('page', p => { popups.push(p); push(`팝업 열림: ${p.url().slice(0, 100)}`); });

  // ---------- Step A: 홈 — 다수조회/관심 리스트 ----------
  push('\n=== A. 홈(다수조회/관심) ===');
  const home = await ctx.newPage();
  try {
    await home.goto('https://www.courtauction.go.kr/', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(5000);
    save('A_home.html', await home.content());
    await home.screenshot({ path: path.join(OUT, 'A_home.png'), fullPage: true });

    const mainApis = await home.evaluate(() => {
      const scripts = Array.from(document.scripts).map(s => s.textContent || '').join('\n');
      const matches = scripts.match(/[a-zA-Z][a-zA-Z0-9]*\.(on|laf)(\?[^\s"'`]*)?/g) || [];
      return Array.from(new Set(matches)).slice(0, 50);
    });
    push('홈에서 발견한 .on/.laf 엔드포인트:');
    mainApis.forEach(u => push('  ' + u));

    const lists = await home.evaluate(() => {
      const out = [];
      document.querySelectorAll('a, button').forEach(el => {
        const txt = (el.textContent || '').trim();
        if (/다수(조회|관심)|오늘의|신건|추천/.test(txt)) {
          out.push({ text: txt.slice(0, 30), href: el.getAttribute('href') || '', onclick: (el.getAttribute('onclick') || '').slice(0, 100) });
        }
      });
      return out;
    });
    push('홈의 다수조회/관심 관련 링크:');
    lists.forEach(l => push(`  "${l.text}" href=${l.href} onclick=${l.onclick}`));
  } catch (e) {
    push(`홈 실패: ${e.message}`);
  }

  // ---------- Step B: 물건상세검색 PGJ151F00 ----------
  push('\n=== B. PGJ151F00 (물건상세검색/사건뷰) ===');
  const casePage = await ctx.newPage();
  try {
    const url = `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&cortOfcCd=${COURT}&csNo=${SA_NO}&pgmId=PGJ151F00`;
    await casePage.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    await casePage.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(6000);
    save('B_case_before.html', await casePage.content());
    await casePage.screenshot({ path: path.join(OUT, 'B_case_before.png'), fullPage: true });
    await dumpButtons(casePage, 'B-before');

    // "사건상세조회" 버튼 찾아 클릭
    push('\n-- 사건상세조회 버튼 클릭 시도 --');
    const clicked = await casePage.evaluate(() => {
      const sels = [
        'input[value*="사건상세"]',
        'button:has-text("사건상세")',
        'a[onclick*="csDtlSrch"]',
      ];
      for (const s of sels) {
        try {
          const el = document.querySelector(s);
          if (el) { el.click(); return { selector: s, id: el.id, text: el.value || el.textContent }; }
        } catch {}
      }
      // value 텍스트 fallback
      const all = Array.from(document.querySelectorAll('input[type="button"], button, a'));
      const hit = all.find(e => /사건상세조회/.test(e.value || e.textContent || ''));
      if (hit) { hit.click(); return { selector: 'text-fallback', id: hit.id, text: hit.value || hit.textContent }; }
      return null;
    });
    push(`클릭 결과: ${JSON.stringify(clicked)}`);
    await sleep(8000);
    save('B_case_after.html', await casePage.content());
    await casePage.screenshot({ path: path.join(OUT, 'B_case_after.png'), fullPage: true });
    await dumpButtons(casePage, 'B-after');
  } catch (e) {
    push(`PGJ151F00 실패: ${e.message}`);
  }

  // ---------- Step C: 사건상세 페이지에서 등기기록열람 버튼 찾기 ----------
  push('\n=== C. 등기기록열람 버튼 탐색 ===');
  // casePage 가 그대로 있을 수도, 팝업으로 새로 뜨거나, 전환됐을 수 있음
  const candidates = [casePage, ...popups];
  for (const p of candidates) {
    if (p.isClosed?.()) continue;
    try {
      const u = p.url();
      push(`- 페이지 검사: ${u.slice(0, 120)}`);
      const btns = await dumpButtons(p, `C-${u.slice(-30)}`);
      const hit = btns.find(b => /등기.*열람|등기기록/.test(b.text));
      if (hit) {
        push(`★ 등기기록열람 버튼 발견: id=${hit.id} text="${hit.text}"`);
        // 클릭 시도
        const result = await p.evaluate((id) => {
          const el = id ? document.getElementById(id) : null;
          if (el) { el.click(); return 'clicked-by-id'; }
          const all = Array.from(document.querySelectorAll('input[type="button"], button, a'));
          const h = all.find(e => /등기.*열람|등기기록/.test(e.value || e.textContent || ''));
          if (h) { h.click(); return 'clicked-by-text'; }
          return 'not-found';
        }, hit.id);
        push(`클릭: ${result}`);
        await sleep(8000);
        save(`C_reg_click_${Date.now()}.html`, await p.content());
        await p.screenshot({ path: path.join(OUT, `C_reg_click_${Date.now()}.png`), fullPage: true });
      }
    } catch (e) { push(`검사 실패: ${e.message}`); }
  }

  // ---------- Step D: 네트워크 로그 저장 ----------
  save('D_network.json', JSON.stringify(netLog, null, 2));
  save('Z_log.txt', log.join('\n'));

  // 점검 메시지(nrsMessageValue) 포함된 응답 있으면 강조
  const maintErrs = netLog.filter(r => r.sample && /점검|이용 가능 시간대/.test(r.sample));
  if (maintErrs.length) {
    push('\n★ 점검 메시지 응답 발견:');
    maintErrs.forEach(r => push(`  ${r.url} -> ${r.sample.slice(0, 200)}`));
  }

  await browser.close();
  push(`\n완료. ${OUT}/ 확인.`);
  save('Z_log.txt', log.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
