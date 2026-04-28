// 차량 매매 사이트 카탈로그 크롤링
// 목표: 제조사 → 모델 → 세부모델(트림) 정보 수집
// 타겟: KCAR (케이카) / 엔카 중 하나 선택
// 실행: node collectors/car-catalog-crawl.js

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('./tmp/catalog');
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function probeEncar() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  const apiCalls = [];
  page.on('response', async r => {
    const u = r.url();
    if (/encar|dartist/.test(u) && /json|\.js$|api/i.test(r.headers()['content-type'] || u)) {
      try {
        const body = await r.text();
        if (body.length > 100 && body.length < 500_000) {
          apiCalls.push({ url: u, status: r.status(), size: body.length, preview: body.slice(0, 500) });
        }
      } catch {}
    }
  });

  console.log('엔카 메인 + 검색 페이지...');
  await page.goto('http://www.encar.com/', { waitUntil: 'networkidle', timeout: 60000 });
  await wait(2000);
  // 중고차 검색으로 이동
  await page.goto('http://www.encar.com/dc/dc_carsearchlist.do?carType=kor', { waitUntil: 'networkidle', timeout: 60000 }).catch(()=>{});
  await wait(3000);

  await page.screenshot({ path: path.join(OUT, 'encar.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT, 'encar-api-calls.json'), JSON.stringify(apiCalls, null, 2));
  console.log(`캡처 API 호출: ${apiCalls.length}건`);
  apiCalls.slice(0, 20).forEach(c => console.log(`  ${c.status} ${c.url.slice(0, 100)} (${c.size}B)`));

  await browser.close();
}

probeEncar().catch(e => { console.error(e); process.exit(1); });
