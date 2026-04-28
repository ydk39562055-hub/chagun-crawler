// courtauction.go.kr 구조 탐색 스크립트
// 목적: 매각물건 검색 페이지 URL, DOM 구조, 네트워크 호출 파악
// 실행: node collectors/court-explore.js

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('./tmp/court');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  // 네트워크 로그
  const requests = [];
  page.on('request', r => {
    const url = r.url();
    if (url.includes('courtauction.go.kr') && (url.includes('.do') || url.includes('.on') || url.includes('.xml') || url.includes('processService') || url.includes('Retrieve'))) {
      requests.push({ method: r.method(), url, postData: r.postData() });
    }
  });

  console.log('1) 홈페이지 로드...');
  await page.goto('https://www.courtauction.go.kr/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('2) 현재 URL:', page.url());
  await page.screenshot({ path: path.join(OUT_DIR, '01-home.png'), fullPage: true });
  fs.writeFileSync(path.join(OUT_DIR, '01-home.html'), await page.content());

  // 메뉴 찾기 시도
  console.log('3) 페이지 내 링크·메뉴 텍스트 추출');
  const links = await page.$$eval('a, button, [onclick]', els =>
    els.slice(0, 200).map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 60),
      href: el.getAttribute('href'),
      onclick: el.getAttribute('onclick'),
    })).filter(x => x.text && x.text.length > 1),
  );
  fs.writeFileSync(path.join(OUT_DIR, '02-links.json'), JSON.stringify(links, null, 2));
  console.log(`   → ${links.length}개 클릭 가능 요소`);

  // 부동산 검색 관련 텍스트 필터
  const reLinks = links.filter(l => /매각|물건|검색|경매|부동산/.test(l.text));
  console.log('4) 부동산·매각물건 관련 요소 (상위 20개):');
  reLinks.slice(0, 20).forEach(l => console.log(`   [${l.tag}] "${l.text}" onclick=${!!l.onclick} href=${l.href}`));

  // 네트워크 호출 기록
  fs.writeFileSync(path.join(OUT_DIR, '03-network.json'), JSON.stringify(requests, null, 2));
  console.log(`5) 기록된 백엔드 호출: ${requests.length}건`);

  await browser.close();
  console.log('\n완료. 결과: scripts/tmp/court/');
}

main().catch(e => { console.error(e); process.exit(1); });
