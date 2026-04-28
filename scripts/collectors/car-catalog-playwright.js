// 엔카 검색 페이지에서 실제 제조사·모델·세부모델 API 호출 캡처
import { chromium } from 'playwright';
import fs from 'node:fs';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    locale: 'ko-KR',
  });
  const page = await ctx.newPage();

  const calls = [];
  page.on('response', async r => {
    const u = r.url();
    if (/api\.encar\.com/.test(u)) {
      try {
        const body = await r.text();
        calls.push({ url: u, status: r.status(), bodyLen: body.length });
      } catch {}
    }
  });

  console.log('1) 엔카 검색 페이지 로드');
  await page.goto('http://www.encar.com/dc/dc_carsearchlist.do?carType=kor', { waitUntil: 'networkidle', timeout: 60000 });
  await wait(3000);

  console.log('2) 제조사 메뉴 클릭 시도');
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('a, button, li, span, div')).find(e => (e.textContent || '').trim() === '제조사');
    t?.click();
  });
  await wait(3000);

  console.log('3) 현대 클릭 시도');
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('a, button, li, span, div')).find(e => (e.textContent || '').trim() === '현대');
    t?.click();
  });
  await wait(3000);

  fs.writeFileSync('tmp/catalog/playwright-calls.json', JSON.stringify(calls, null, 2));
  console.log(`\n총 캡처 ${calls.length}건 엔카 API:`);
  calls.forEach((c, i) => {
    console.log(`  [${i}] ${c.url.slice(0, 150)}`);
  });

  // 가장 최근 iNav 응답 찾기
  const big = calls.filter(c => c.bodyLen > 50000).slice(-2);
  console.log('\n대용량 응답:', big.map(b => b.url.slice(0,150)));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
