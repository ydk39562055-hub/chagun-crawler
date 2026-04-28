// 법원경매 자동차/중기 검색 API 리버스 (2차)
// 자동차 탭을 iframe 포함 적극 탐색해 XHR 캡처
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const LOG_PATH = 'scripts/collectors/capture-vehicle-api.log.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const page = await ctx.newPage();

  const captures = [];
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('courtauction.go.kr')) return;
    if (req.method() !== 'POST') return;
    let body = null; try { body = req.postData(); } catch {}
    captures.push({ ts: Date.now(), kind: 'req', url, body });
    if (/srchControll|selectGds|srch|Cntls|Car|Auto|pgj15/i.test(url)) {
      console.log(`[REQ] ${url}`);
      if (body) console.log('  body=' + body.slice(0, 600));
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('courtauction.go.kr')) return;
    if (res.request().method() !== 'POST') return;
    let text = ''; try { text = await res.text(); } catch {}
    captures.push({ ts: Date.now(), kind: 'res', url, status: res.status(), body: text.slice(0, 3000) });
  });

  await page.goto('https://www.courtauction.go.kr/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  console.log('\n--- 프레임 구조 ---');
  for (const f of page.frames()) console.log('frame:', f.url().slice(0, 100));

  console.log('\n--- 모든 프레임 내 "자동차" 텍스트 요소 탐색 ---');
  for (const f of page.frames()) {
    try {
      const hits = await f.evaluate(() => {
        const res = [];
        document.querySelectorAll('*').forEach(el => {
          if (el.children.length) return;
          const t = (el.textContent || '').trim();
          if (/자동차.*중기|자동차\/중기|자동차ㆍ중기/.test(t) && t.length < 40) {
            res.push({ tag: el.tagName, text: t, id: el.id, class: el.className?.toString().slice(0, 60), onclick: el.getAttribute('onclick')?.slice(0, 80) });
          }
        });
        return res.slice(0, 20);
      });
      if (hits.length) {
        console.log(`  frame ${f.url().slice(0, 80)}:`);
        hits.forEach(h => console.log('    ', h));
      }
    } catch {}
  }

  console.log('\n--- "자동차/중기" 클릭 시도 (모든 프레임) ---');
  let clicked = false;
  for (const f of page.frames()) {
    try {
      const ok = await f.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const el = all.find(e => !e.children.length && /자동차.*중기|자동차\/중기|자동차ㆍ중기/.test((e.textContent || '').trim()));
        if (!el) return false;
        let target = el;
        for (let i = 0; i < 4; i++) {
          target.click?.();
          if (target.parentElement) target = target.parentElement; else break;
        }
        return true;
      });
      if (ok) { console.log('  clicked in', f.url().slice(0, 80)); clicked = true; break; }
    } catch {}
  }
  if (!clicked) console.log('  ❌ 자동차/중기 링크 없음');
  await sleep(6000);

  console.log('\n--- 검색 버튼 클릭 시도 ---');
  for (const f of page.frames()) {
    try {
      await f.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button,a,input[type=button],input[type=submit],span[role=button]'))
          .find(b => /^\s*검색\s*$|^\s*조회\s*$/.test(b.textContent || b.value || ''));
        btn?.click();
      });
    } catch {}
  }
  await sleep(8000);

  console.log('\n--- 방문한 URL (최근 10) ---');
  console.log('page.url:', page.url());
  for (const f of page.frames()) console.log('frame:', f.url().slice(0, 100));

  fs.writeFileSync(LOG_PATH, JSON.stringify(captures, null, 2), 'utf-8');
  console.log(`\n총 ${captures.length}건 캡처 → ${LOG_PATH}`);

  const vehicleReqs = captures.filter(c => c.kind === 'req' && /(searchControll|selectGds|pgj15|Cntls)/i.test(c.url) && c.body);
  console.log(`\n=== 검색 관련 POST ${vehicleReqs.length}건 ===`);
  vehicleReqs.forEach(r => {
    console.log(r.url);
    if (r.body) console.log('  ', r.body.slice(0, 400));
  });

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
