// 물건상세검색 버튼 클릭 → 실제 목록 조회 API 포착
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('./tmp/court');
fs.mkdirSync(OUT_DIR, { recursive: true });

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
    if (r.method() === 'POST' && r.url().includes('courtauction.go.kr')) {
      posts.push({ url: r.url(), postData: r.postData() });
    }
  });
  const responses = [];
  page.on('response', async r => {
    if (r.request().method() === 'POST' && r.url().includes('.on')) {
      try {
        const body = await r.text();
        responses.push({ url: r.url(), status: r.status(), body: body.slice(0, 3000) });
      } catch {}
    }
  });

  console.log('1) 홈 로드');
  await page.goto('https://www.courtauction.go.kr/', { waitUntil: 'networkidle', timeout: 30000 });
  await wait(1500);

  console.log('2) "물건상세검색" 링크 클릭');
  // WebSquare에서는 부모 창에서 네비게이션 - 여러 선택자 시도
  const clicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button, [onclick]'));
    const target = links.find(a => (a.textContent || '').trim() === '물건상세검색');
    if (target) {
      target.click();
      return true;
    }
    return false;
  });
  console.log('   클릭 결과:', clicked);
  await wait(3000);

  console.log('3) 현재 URL:', page.url());
  await page.screenshot({ path: path.join(OUT_DIR, '04-search-page.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT_DIR, '04-search-page.html'), await page.content());

  // 검색 버튼 찾아서 클릭
  console.log('4) "검색" 버튼 클릭 시도 (기본 조건으로 전체 조회)');
  posts.length = 0; // 초기화
  responses.length = 0;
  const searched = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], a'));
    const target = all.find(el => {
      const t = (el.textContent || el.value || '').trim();
      return t === '검색' || t === '조회';
    });
    if (target) { target.click(); return true; }
    return false;
  });
  console.log('   클릭:', searched);
  await wait(6000);
  await page.screenshot({ path: path.join(OUT_DIR, '05-search-result.png'), fullPage: true });

  console.log('\n5) 검색 중 발생한 POST 호출:');
  posts.forEach(p => console.log(`   POST ${p.url}`));
  fs.writeFileSync(path.join(OUT_DIR, '05-posts.json'), JSON.stringify(posts, null, 2));

  console.log('\n6) 응답 본문 (앞부분):');
  responses.forEach(r => {
    console.log(`\n--- ${r.url} [${r.status}] ---`);
    console.log(r.body.slice(0, 600));
  });
  fs.writeFileSync(path.join(OUT_DIR, '05-responses.json'), JSON.stringify(responses, null, 2));

  await browser.close();
  console.log('\n완료.');
}

main().catch(e => { console.error(e); process.exit(1); });
