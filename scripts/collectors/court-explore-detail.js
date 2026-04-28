// 상세 페이지 네트워크 캡처 — 사진·감정평가서·현황조사서 엔드포인트 발견
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('./tmp/court');
fs.mkdirSync(OUT, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 1000 },
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
    const u = r.url();
    if (/\.on$/.test(u) || /\.do$/.test(u) || /Image|Photo|File|Download|Pdf/i.test(u)) {
      try {
        const ct = r.headers()['content-type'] || '';
        const body = ct.includes('json') ? (await r.text()).slice(0, 5000) : `(${ct}, ${r.headers()['content-length'] || '?'} bytes)`;
        responses.push({ url: u, status: r.status(), ct, body });
      } catch {}
    }
  });

  console.log('1) 홈 로드 + 물건상세검색으로 이동');
  await page.goto('https://www.courtauction.go.kr/', { waitUntil: 'networkidle', timeout: 30000 });
  await wait(1500);
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('a')).find(a => (a.textContent || '').trim() === '물건상세검색');
    t?.click();
  });
  await wait(3000);

  console.log('2) 검색 실행');
  await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('button, input[type="button"], a')).find(el => {
      const txt = (el.textContent || el.value || '').trim();
      return txt === '검색' || txt === '조회';
    });
    t?.click();
  });
  await wait(5000);

  console.log('3) 첫 결과 행 클릭 시도 (docid 링크)');
  posts.length = 0; responses.length = 0;
  const clicked = await page.evaluate(() => {
    // 테이블 행/사건번호 링크 탐색
    const candidates = Array.from(document.querySelectorAll('a, td, tr'));
    // 사건번호 형식 텍스트 찾기 (2022타경xxxxx)
    const row = candidates.find(el => /\d{4}타경\d+/.test(el.textContent || ''));
    if (row) {
      const link = row.tagName === 'A' ? row : row.querySelector('a') || row.closest('a') || row;
      link.click();
      return (link.textContent || '').trim().slice(0, 80);
    }
    return null;
  });
  console.log('   클릭:', clicked);
  await wait(6000);

  await page.screenshot({ path: path.join(OUT, '06-detail.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT, '06-detail.html'), await page.content());

  console.log('\n4) 상세 전환 중 POST 호출:');
  posts.forEach(p => console.log(`   POST ${p.url.split('?')[0]}\n      body: ${(p.postData || '').slice(0, 200)}`));
  fs.writeFileSync(path.join(OUT, '06-posts.json'), JSON.stringify(posts, null, 2));

  console.log('\n5) 응답들 (앞부분):');
  responses.forEach(r => {
    console.log(`\n   ${r.status} ${r.url.slice(0, 90)}`);
    console.log(`   ${r.body.slice(0, 400)}`);
  });
  fs.writeFileSync(path.join(OUT, '06-responses.json'), JSON.stringify(responses, null, 2));

  // 추가: 탭들 클릭 (매각물건명세서 / 현황조사서 / 감정평가서 / 사진)
  console.log('\n6) 탭 클릭 시도 (명세서/현황/감정/사진)');
  for (const tabName of ['매각물건명세서', '현황조사서', '감정평가서', '사진', '물건사진']) {
    posts.length = 0; responses.length = 0;
    const ok = await page.evaluate((name) => {
      const t = Array.from(document.querySelectorAll('a, button, li, span, div')).find(el => (el.textContent || '').trim() === name);
      if (t) { t.click(); return true; }
      return false;
    }, tabName);
    await wait(2500);
    if (ok) {
      console.log(`\n   "${tabName}" 클릭 → POST ${posts.length}건`);
      posts.forEach(p => console.log(`      ${p.url.split('/').slice(-2).join('/')}  ${(p.postData || '').slice(0, 120)}`));
    } else {
      console.log(`   "${tabName}" 못 찾음`);
    }
  }

  await browser.close();
  console.log('\n완료. tmp/court/06-*.json 확인');
}

main().catch(e => { console.error(e); process.exit(1); });
