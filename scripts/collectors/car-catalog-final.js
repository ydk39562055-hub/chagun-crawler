// 엔카 전체 카탈로그 수집 (제조사 → 모델 → 세부모델)
// 실행: node collectors/car-catalog-final.js
// 출력: app/src/data/carCatalog.json

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.encar.com/search/car/list/general';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json',
  'Referer': 'http://www.encar.com/',
  'Origin': 'http://www.encar.com',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(q) {
  const url = `${BASE}?count=true&q=${encodeURIComponent(q)}&inav=%7CMetadata%7CSort`;
  const res = await fetch(url, { headers: HEADERS });
  return await res.json();
}

function findNode(json, name) {
  return (json?.iNav?.Nodes ?? []).find(n => n.Name === name);
}

function getFacets(json, name) {
  return (findNode(json, name)?.Facets ?? []).map(f => ({
    value: f.Value,
    display: f.DisplayValue,
    count: f.Count,
  }));
}

// 대표 제조사 리스트 (모든 Manufacturer를 자동 발견하기 어려움 — 정식 목록 하드코딩)
const KOREAN_MAKERS = ['현대', '기아', '제네시스', '쌍용', 'KG모빌리티', '르노코리아', '쉐보레(GM대우)'];
const IMPORT_MAKERS = [
  'BMW', '벤츠', '아우디', '폭스바겐', '미니', '볼보', '포르쉐', '테슬라',
  '렉서스', '토요타', '혼다', '포드', '크라이슬러', '지프', '캐딜락',
  '랜드로버', '재규어', '푸조', '시트로엥', '피아트', '링컨', '페라리',
  '람보르기니', '벤틀리', '롤스로이스', '마세라티', '알파로메오',
];

async function main() {
  const result = {};

  for (const [carType, makers] of [['Y', KOREAN_MAKERS], ['N', IMPORT_MAKERS]]) {
    const label = carType === 'Y' ? '국산' : '수입';
    console.log(`\n=== ${label}차 ===`);

    for (const maker of makers) {
      const q1 = `(And.Hidden.N._.(C.CarType.${carType}._.Manufacturer.${maker}.))`;
      let resp;
      try { resp = await call(q1); } catch (e) { console.log(`  ${maker}: 요청 실패`); continue; }
      const count = resp?.Count ?? 0;
      if (!count) { console.log(`  ${maker}: 매물 없음 (스킵)`); await sleep(300); continue; }

      const models = getFacets(resp, 'Model');
      console.log(`  ${maker} (${count.toLocaleString()}건) · ${models.length} 모델`);
      result[maker] = { carType: label, count, models: {} };

      for (const model of models.slice(0, 40)) { // 제조사당 최대 40 모델
        if (model.count < 5) continue;
        const q2 = `(And.Hidden.N._.(C.CarType.${carType}._.(C.Manufacturer.${maker}._.Model.${model.value}.)))`;
        let r2;
        try { r2 = await call(q2); } catch { continue; }
        const badges = getFacets(r2, 'Badge');
        result[maker].models[model.display || model.value] = badges.map(b => ({
          name: b.display || b.value,
          count: b.count,
        }));
        process.stdout.write('.');
        await sleep(350);
      }
      console.log('');
      await sleep(500);
    }
  }

  const outDir = path.resolve('../app/src/data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'carCatalog.json'), JSON.stringify(result, null, 2));

  const totalMakers = Object.keys(result).length;
  const totalModels = Object.values(result).reduce((s, m) => s + Object.keys(m.models).length, 0);
  const totalBadges = Object.values(result).reduce((s, m) => s + Object.values(m.models).reduce((x, b) => x + b.length, 0), 0);
  console.log(`\n저장 완료: ${totalMakers} 제조사 / ${totalModels} 모델 / ${totalBadges} 세부모델`);
  console.log(`경로: ${path.join(outDir, 'carCatalog.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
