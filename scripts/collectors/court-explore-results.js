// 매각결과검색 (과거 낙찰가 아카이브) 엔드포인트 캡처
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('./tmp/court');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  const posts = [];
  page.on('request', r => {
    if (r.method() === 'POST' && /courtauction\.go\.kr.*\.on/.test(r.url())) {
      posts.push({ url: r.url(), postData: r.postData() });
    }
  });
  const responses = [];
  page.on('response', async r => {
    if (r.request().method() === 'POST' && /\.on$/.test(r.url())) {
      try {
        const body = await r.text();
        responses.push({ url: r.url(), body: body.slice(0, 2500) });
      } catch {}
    }
  });

  console.log('1) 홈 + 매각결과검색 클릭');
  await page.goto('https://www.courtauction.go.kr/', { waitUntil: 'networkidle', timeout: 30000 });
  await wait(1500);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('a')).find(a => (a.textContent || '').trim() === '매각결과검색');
    t?.click();
  });
  await wait(3500);

  console.log('2) URL:', page.url());

  console.log('3) 검색 버튼 클릭');
  posts.length = 0; responses.length = 0;
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('button, input[type="button"], a')).find(el => {
      const txt = (el.textContent || el.value || '').trim();
      return txt === '검색' || txt === '조회';
    });
    t?.click();
  });
  await wait(6000);

  console.log('\n4) POST 호출:');
  posts.forEach(p => console.log(`   ${p.url}\n      body: ${(p.postData || '').slice(0, 200)}`));

  console.log('\n5) 응답 미리보기:');
  responses.forEach(r => {
    console.log(`\n   ${r.url.split('/').slice(-2).join('/')}`);
    console.log('   ', r.body.slice(0, 500));
  });

  fs.writeFileSync(path.join(OUT, '07-results-posts.json'), JSON.stringify(posts, null, 2));
  fs.writeFileSync(path.join(OUT, '07-results-responses.json'), JSON.stringify(responses, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
