// 법원경매 문서 XHR 캡처 (매각물건명세서·현황조사서·감정평가서)
//
// 전 버전은 검색 결과 행 클릭이 실제 상세 진입을 못 트리거해 목록에서 멈춤.
// 이번 버전:
//   1. 검색 후 grid row의 "a" 태그(사건번호 링크) + 더블클릭 폴백 + popup 핸들링
//   2. 상세(팝업 or 같은 페이지) 에서 "매각물건명세서" 등 텍스트의 가장 가까운 클릭 요소 탐색
//   3. 팝업까지 캡처 리스너 부착
//   4. 문서 관련 키워드만 필터해 콘솔 출력, 전체는 파일로 저장
//
// 실행(로컬 IP 차단 주의):
//   node collectors/capture-detail-apis.js
// GH Actions 일회성 실행 권장.

import { chromium } from 'playwright';
import fs from 'node:fs';

const LOG_PATH = 'collectors/capture-detail-apis.log.json';
const SHOT_DIR = 'collectors/capture-shots';
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

async function snap(p, name) {
  try {
    await p.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
    const html = await p.content();
    fs.writeFileSync(`${SHOT_DIR}/${name}.html`, html, 'utf-8');
  } catch (e) {
    console.log(`  snap ${name} 실패: ${e.message}`);
  }
}

const DOC_KEY = /등기|rgst|lien|임차|tenant|명세|bllt|감정|wevl|현황|insp|file|atch|pdf|ecdoc|dspslGdsSpcfc/i;

const captures = [];

function attachCapture(p, label) {
  p.on('request', req => {
    if (!/courtauction|scourt\.go\.kr/.test(req.url())) return;
    if (req.method() !== 'POST') return;
    let body = null; try { body = req.postData(); } catch {}
    captures.push({ ts: Date.now(), page: label, kind: 'req', url: req.url(), body });
    if (DOC_KEY.test(req.url() + (body || ''))) {
      console.log(`[${label} REQ★] ${req.url()}`);
      if (body) console.log('   body=' + body.slice(0, 600));
    }
  });
  p.on('response', async res => {
    if (!/courtauction|scourt\.go\.kr/.test(res.url())) return;
    if (res.request().method() !== 'POST') return;
    let text = ''; try { text = await res.text(); } catch {}
    captures.push({ ts: Date.now(), page: label, kind: 'res', url: res.url(), status: res.status(), body: text.slice(0, 8000) });
    if (DOC_KEY.test(res.url())) {
      console.log(`[${label} RES★ ${res.status()}] ${res.url()} len=${text.length}`);
    }
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  ctx.on('page', p => attachCapture(p, `popup-${ctx.pages().length}`));

  const page = await ctx.newPage();
  attachCapture(page, 'main');

  console.log('홈 진입');
  await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await snap(page, '01-home');

  console.log('\n물건상세검색');
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '물건상세검색')?.click();
  }).catch(() => {});
  await sleep(5000);
  await snap(page, '02-search-form');

  console.log('\n검색 실행');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button,a,input[type=button],span[role=button]'));
    const searchBtn = btns.find(b => /^\s*검색\s*$/.test((b.textContent || b.value || '').trim()));
    searchBtn?.click();
  }).catch(() => {});
  await sleep(8000);
  await snap(page, '03-search-result');

  console.log('\n첫 행 진입 시도 — moveDtlPage(0) 직접 호출');
  // 같은 페이지 뷰 전환 또는 팝업 둘 다 대응
  const popupPromise = ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null);

  const clicked = await page.evaluate(() => {
    // 1순위: moveDtlPage 전역 함수 직접 호출 (HTML에서 확인된 핸들러)
    for (const f of [window, window.top, window.frames?.[0]]) {
      if (f && typeof f.moveDtlPage === 'function') {
        try { f.moveDtlPage(0); return 'moveDtlPage(0) called'; } catch (e) { return 'err: ' + e.message; }
      }
    }
    // 2순위: a[onclick*="moveDtlPage"] 클릭
    const a = document.querySelector('a[onclick*="moveDtlPage"]');
    if (a) { a.click(); return 'a[onclick*=moveDtlPage].click() done'; }
    // 3순위: iframe 내부 탐색
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument;
        const a2 = doc?.querySelector('a[onclick*="moveDtlPage"]');
        if (a2) { a2.click(); return 'iframe a.click() done'; }
      } catch {}
    }
    return 'no moveDtlPage found';
  });
  console.log('  result:', clicked);

  const popup = await popupPromise;
  const target = popup ?? page;
  if (popup) { console.log('  팝업 감지됨 → 팝업 페이지로 전환'); await popup.waitForLoadState('domcontentloaded').catch(() => {}); }
  await sleep(6000);
  await snap(target, '04-detail-entered');

  // 문서 탭/버튼 순차 클릭 — WebSquare input[type=button]은 textContent 대신 value를 씀
  const docButtons = [
    { key: '매각물건명세서', ids: ['btn_dspslGdsSpcfc1', 'btn_dspslGdsSpcfc'] },
    { key: '현황조사서', ids: ['btn_curstExmndcTop', 'btn_curstExmndc'] },
    { key: '감정평가서', ids: ['btn_aeeWevl1', 'btn_aeeWevl'] },
  ];
  let snapIdx = 5;
  for (const { key, ids } of docButtons) {
    console.log(`\n"${key}" 클릭 시도`);
    const found = await target.evaluate(({ ids, key }) => {
      for (const id of ids) {
        const el = document.querySelector(`#mf_wfm_mainFrame_${id}`) || document.querySelector(`input[id$="_${id}"]`);
        if (el) { el.click(); return 'id:' + id; }
      }
      const byVal = Array.from(document.querySelectorAll('input[type=button],button'))
        .find(b => (b.value || b.textContent || '').trim() === key);
      if (byVal) { byVal.click(); return 'value:' + key; }
      return null;
    }, { ids, key }).catch(() => null);
    console.log('  found:', found);
    // 매각물건명세서는 ecfs.scourt.go.kr로 이동하므로 긴 대기
    await sleep(key === '매각물건명세서' ? 25000 : 6000);
    await snap(target, `${String(snapIdx++).padStart(2, '0')}-after-${key}`);
  }

  console.log('\n프레임별 문서 링크 탐색');
  for (const f of target.frames()) {
    const hits = await f.evaluate(() => {
      const res = [];
      document.querySelectorAll('a,button,span,td').forEach(el => {
        const t = (el.textContent || '').trim();
        if (t.length < 30 && /매각물건명세서|현황조사서|감정평가서|등기사항|전입세대/.test(t)) {
          res.push({ tag: el.tagName, text: t, id: el.id, onclick: (el.getAttribute('onclick') || '').slice(0, 150) });
        }
      });
      return res.slice(0, 30);
    }).catch(() => []);
    if (hits.length) {
      console.log(`  frame ${f.url().slice(0, 80)}:`);
      hits.forEach(h => console.log('    ', JSON.stringify(h)));
    }
  }

  fs.writeFileSync(LOG_PATH, JSON.stringify(captures, null, 2), 'utf-8');
  console.log(`\n총 ${captures.length}건 캡처 → ${LOG_PATH}`);

  const relevant = captures.filter(c =>
    c.kind === 'req' && c.body && DOC_KEY.test(c.url + (c.body || ''))
  );
  console.log(`\n=== 문서 관련 POST ${relevant.length}건 ===`);
  relevant.forEach(r => { console.log(`[${r.page}] ${r.url}`); console.log('  body:', (r.body || '').slice(0, 500)); });

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
