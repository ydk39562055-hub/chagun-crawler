// probe v2 — 물건 상세 페이지(PGJ15BA00) 전체 버튼 탐색
//
// 사용자 확인: 물건 상세 페이지 하나에 아래가 모두 있음
//   - 소재지 옆: 등기기록 열람 / 전자지도 / 씨리얼(토지이용계획)
//   - 사진
//   - 하단: 매각물건명세서 / 현황조사서 / 감정평가서
//   - 기타: 사건상세조회 / 부동산표시 / 건축물대장 / 문건/송달 등 (있을 수도)
//
// probe 목표: 각 버튼의 진짜 ID·onclick·클릭 시 응답 확인.
// 점검시간 응답(nrsMessageValue:서비스 점검 중...)도 자동 감지.
//
// 실행: node collectors/court-probe-case-v2.js --case 2024타경143316 --court 000272 --saNo 143316 --maemul 1

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const CASE = argOf('--case', '2024타경143316');
const COURT = argOf('--court', '000272');
const SA_NO = argOf('--saNo', CASE.replace(/[^0-9]/g, ''));
const MAEMUL = argOf('--maemul', '1');

const OUT = 'collectors/probe-out-v2';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const save = (n, b) => fs.writeFileSync(path.join(OUT, n), b);
const log = [];
const push = m => { console.log(m); log.push(`[${new Date().toISOString()}] ${m}`); };

// 관심 키워드 — 버튼·링크·span[onclick] 등에서 텍스트 매칭
const INTEREST_RE = /(사건|등기|열람|기록|조회|상세|첨부|문건|송달|내역|처리|부동산|건축|대장|매각|명세|현황|감정|평가|전자지도|씨리얼|토지이용|사진|씨:리얼)/;

async function dumpButtons(page, tag) {
  const found = await page.evaluate((pattern) => {
    const rx = new RegExp(pattern);
    const out = [];
    const seen = new Set();
    document.querySelectorAll('input[type="button"], input[type="submit"], button, a, span[onclick], div[onclick]').forEach(el => {
      const label = (el.value || el.textContent || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!label || !rx.test(label)) return;
      const id = el.id || '';
      const key = `${id}|${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        tag: el.tagName,
        id,
        name: el.name || '',
        value: el.value || '',
        text: label,
        onclick: (el.getAttribute('onclick') || '').slice(0, 160),
        href: el.getAttribute('href') || '',
      });
    });
    return out;
  }, INTEREST_RE.source);
  push(`[${tag}] 관심버튼 ${found.length}개`);
  found.forEach(b => push(`  <${b.tag}> id=${b.id} value="${b.value}" text="${b.text}" onclick="${b.onclick}"`));
  return found;
}

async function tryClickById(page, id) {
  return await page.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return { clicked: false };
    el.click();
    return { clicked: true, id: elId };
  }, id);
}

async function main() {
  push(`probe v2 — case=${CASE} court=${COURT} saNo=${SA_NO} maemul=${MAEMUL}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 2000 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });

  const netLog = [];
  const maintHits = [];
  ctx.on('response', async (res) => {
    const u = res.url();
    if (!/courtauction\.go\.kr|scourt\.go\.kr|iros\.go\.kr/.test(u)) return;
    if (!/\.(on|laf|json|do)(\?|$)/.test(u) && !u.includes('selectGds') && !u.includes('StreamDocs')) return;
    const rec = { url: u.slice(0, 250), status: res.status(), ts: Date.now() };
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('text') || ct.includes('html')) {
        const body = (await res.text()).slice(0, 800);
        rec.sample = body;
        if (/점검|이용 가능 시간대|nrsMessageValue/.test(body)) maintHits.push(rec);
      }
    } catch {}
    netLog.push(rec);
  });

  const popups = [];
  ctx.on('page', p => {
    popups.push(p);
    push(`popup(${popups.length}): ${p.url().slice(0, 100)}`);
  });

  // ---- Step 1 — PGJ15BA00 물건 상세 진입 ----
  push('\n=== 1. PGJ15BA00 물건 상세 진입 ===');
  const gds = await ctx.newPage();
  try {
    await gds.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3500);
    const url = `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15BA00.xml&cortOfcCd=${COURT}&csNo=${SA_NO}&dspslGdsSeq=${MAEMUL}&pgmId=PGJ15BA00`;
    await gds.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(8000); // WebSquare 렌더 대기
    save('1_gds.html', await gds.content());
    await gds.screenshot({ path: path.join(OUT, '1_gds.png'), fullPage: true });
  } catch (e) { push(`gds 진입 실패: ${e.message}`); }

  // ---- Step 2 — 관심 버튼 전체 덤프 ----
  push('\n=== 2. 버튼 전체 덤프 (PGJ15BA00 본문) ===');
  const buttons = await dumpButtons(gds, 'gds');

  // 덤프된 버튼 전체를 JSON 으로 저장
  save('2_buttons.json', JSON.stringify(buttons, null, 2));

  // ---- Step 3 — 카테고리별 대표 버튼 클릭 시도 ----
  const categories = [
    { name: '등기기록열람', match: /등기기록.?열람|등기.*열람|등기기록/ },
    { name: '전자지도', match: /전자지도/ },
    { name: '씨리얼', match: /씨리얼|씨:리얼|토지이용/ },
    { name: '매각물건명세서', match: /매각물건명세서/ },
    { name: '현황조사서', match: /현황조사서/ },
    { name: '감정평가서', match: /감정평가서/ },
    { name: '사건상세조회', match: /사건상세조회/ },
    { name: '건축물대장', match: /건축물대장/ },
    { name: '문건송달', match: /문건.*송달|문건처리|송달내역|문건내역/ },
    { name: '부동산표시', match: /부동산의? 표시|부동산표시/ },
  ];

  for (const c of categories) {
    const hit = buttons.find(b => c.match.test(b.text));
    push(`\n--- ${c.name}: ${hit ? `id=${hit.id} text="${hit.text}"` : '버튼 없음'} ---`);
    if (!hit) continue;

    const popupsBefore = popups.length;
    const r = await tryClickById(gds, hit.id);
    push(`  click: ${JSON.stringify(r)}`);
    await sleep(6000);

    // 새 팝업이 떴으면 그쪽 캡처
    let target = gds;
    if (popups.length > popupsBefore) {
      target = popups[popups.length - 1];
      push(`  새 팝업으로 전환: ${target.url().slice(0, 120)}`);
      try { await target.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
      await sleep(4000);
    } else {
      // 같은 페이지에서 전환되었을 수도 있음
      try { await gds.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
    }

    const safe = c.name.replace(/[^가-힣0-9]/g, '');
    try { save(`3_${safe}.html`, await target.content()); } catch {}
    try { await target.screenshot({ path: path.join(OUT, `3_${safe}.png`), fullPage: true }); } catch {}

    // 점검 메시지 체크
    try {
      const body = await target.content();
      if (/점검|이용 가능 시간대|nrsMessageValue/.test(body)) {
        push(`  ★ 점검/시간외 메시지 감지`);
      }
    } catch {}

    // 팝업이 떴으면 닫고 복귀
    if (target !== gds && !target.isClosed()) {
      try { await target.close(); } catch {}
    }
    await sleep(3500);
  }

  // ---- Step 4 — 다수조회/관심 ----
  push('\n=== 4. 다수조회/관심 API ===');
  const home = await ctx.newPage();
  try {
    await home.goto('https://www.courtauction.go.kr/', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(4000);
    // 헤더의 "다수조회물건" 링크 ID: mf_wfm_header_anc_mjrtyInqSrch (v1 에서 확인)
    const click = await tryClickById(home, 'mf_wfm_header_anc_mjrtyInqSrch');
    push(`다수조회 click: ${JSON.stringify(click)}`);
    await sleep(7000);
    save('4_manyinq.html', await home.content());
    await home.screenshot({ path: path.join(OUT, '4_manyinq.png'), fullPage: true });
    await dumpButtons(home, '4-manyinq');
  } catch (e) { push(`다수조회 실패: ${e.message}`); }

  // ---- finalize ----
  save('D_network.json', JSON.stringify(netLog, null, 2));
  save('D_maintenance_hits.json', JSON.stringify(maintHits, null, 2));
  save('Z_log.txt', log.join('\n'));
  push(`\n완료 — netLog ${netLog.length}건, 점검응답 ${maintHits.length}건`);
  save('Z_log.txt', log.join('\n'));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
