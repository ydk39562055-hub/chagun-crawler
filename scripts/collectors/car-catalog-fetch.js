// 엔카 Meta API에서 제조사→모델→세부모델 트리 추출
// 출력: app/src/data/carCatalog.json

import fs from 'node:fs';
import path from 'node:path';

const META_URL = 'https://api.encar.com/search/car/list/general?count=false&q=(And.Hidden.N._.CarType.A.)&inav=%7CMeta';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

async function main() {
  const res = await fetch(META_URL, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': 'http://www.encar.com/',
      'Origin': 'http://www.encar.com',
    },
  });
  const text = await res.text();
  fs.writeFileSync('tmp/catalog/encar-meta-raw.json', text);
  console.log('응답 크기:', text.length, 'bytes');

  const j = JSON.parse(text);
  // 구조 탐색
  fs.writeFileSync('tmp/catalog/encar-meta-keys.json', JSON.stringify(Object.keys(j), null, 2));
  console.log('top keys:', Object.keys(j));

  // iNav 검색
  const nav = j.iNav || j.inav || j.INav;
  if (nav) {
    console.log('nav keys:', Object.keys(nav));
    fs.writeFileSync('tmp/catalog/encar-meta-nav.json', JSON.stringify(nav, null, 2).slice(0, 5000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
