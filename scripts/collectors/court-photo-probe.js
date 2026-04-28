// 법원경매 상세 페이지의 실제 사진 URL 역추적 프로브
//
// 배경: csPicLst의 picFileUrl+picTitlNm 조합 URL이 404 반환.
// Playwright로 상세 진입 → <img> 태그 src + 이미지 GET 요청 로그 수집.
//
// 실행: node collectors/court-photo-probe.js
// 로컬 IP 차단 위험 → GH Actions에서 실행 권장.

import { chromium } from 'playwright';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await s.from('auction_items').select('case_number, raw_data').eq('source', 'court_auction').eq('category', 'real_estate').not('raw_data->_photos', 'is', null).limit(1);
  const row = data?.[0];
  if (!row) { console.error('테스트 대상 없음'); process.exit(1); }
  const raw = row.raw_data;
  const { boCd, saNo, maemulSer } = raw;
  console.log(`테스트: ${row.case_number} (boCd=${boCd}, saNo=${saNo}, ser=${maemulSer})`);
  console.log(`저장된 첫 사진 URL: ${raw._photos?.[0]?.url}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
  });

  // 이미지 GET 전부 로깅
  const imgRequests = [];
  ctx.on('requestfinished', async req => {
    const url = req.url();
    if (!/courtauction\.go\.kr/.test(url)) return;
    if (!/\.(jpg|jpeg|png|gif)($|\?)/i.test(url) && !/image|pic|photo|nas_e/i.test(url)) return;
    try {
      const res = await req.response();
      imgRequests.push({ url, status: res?.status(), ct: res?.headers()['content-type'], size: res?.headers()['content-length'] });
    } catch {}
  });

  const page = await ctx.newPage();

  // 상세 페이지 딥링크
  const deepLink = `https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ15BA00.xml&cortOfcCd=${boCd}&csNo=${saNo}&dspslGdsSeq=${maemulSer || 1}&pgmId=PGJ15BA00`;
  console.log(`\n진입: ${deepLink}`);
  await page.goto(deepLink, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(5000);

  // DOM의 img 태그 전부 수집
  const imgs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map(i => ({
      src: i.src,
      naturalW: i.naturalWidth,
      naturalH: i.naturalHeight,
      loaded: i.complete && i.naturalWidth > 0,
    })).filter(i => i.src && !i.src.startsWith('data:'));
  });

  console.log(`\n=== DOM <img> ${imgs.length}건 ===`);
  imgs.filter(i => !/icon|logo|btn|arrow|dot/i.test(i.src)).forEach(i => {
    console.log(`  [${i.loaded ? 'OK' : 'FAIL'} ${i.naturalW}x${i.naturalH}] ${i.src}`);
  });

  console.log(`\n=== Network 이미지 요청 ${imgRequests.length}건 ===`);
  imgRequests.forEach(r => console.log(`  [${r.status}] ${r.ct || '?'} ${r.size || '?'} ${r.url}`));

  // iframe 속 img도 체크
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      const frameImgs = await f.evaluate(() =>
        Array.from(document.querySelectorAll('img')).map(i => ({ src: i.src, loaded: i.complete && i.naturalWidth > 0 })).filter(i => i.src && !i.src.startsWith('data:'))
      );
      if (frameImgs.length) {
        console.log(`\n=== iframe(${f.url().slice(0, 60)}) img ${frameImgs.length}건 ===`);
        frameImgs.forEach(i => console.log(`  [${i.loaded ? 'OK' : 'FAIL'}] ${i.src}`));
      }
    } catch {}
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
