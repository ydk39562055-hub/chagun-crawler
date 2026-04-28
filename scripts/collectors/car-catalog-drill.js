// 엔카 Manufacturer/Model/Badge/BadgeDetail 전체 트리 수집
// 결과를 app/src/data/carCatalog.json 으로 저장

import fs from 'node:fs';

const BASE = 'https://api.encar.com/search/car/list/general';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json',
  'Referer': 'http://www.encar.com/',
  'Origin': 'http://www.encar.com',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiCall(q, inav) {
  const url = `${BASE}?count=false&q=${encodeURIComponent(q)}&inav=${encodeURIComponent(inav)}`;
  const res = await fetch(url, { headers: HEADERS });
  return await res.json();
}

function extractFacets(json, nodeName) {
  const nodes = json?.iNav?.Nodes ?? [];
  const node = nodes.find(n => n.Name === nodeName);
  return (node?.Facets ?? []).map(f => ({
    value: f.Value,
    display: f.DisplayValue,
    count: f.Count,
  }));
}

async function main() {
  // carType Y = 국산, N = 수입 - 모두 수집
  const result = {};

  for (const carType of ['Y', 'N']) {
    const carTypeLabel = carType === 'Y' ? '국산' : '수입';
    console.log(`\n=== ${carTypeLabel}차 제조사 ===`);

    const root = await apiCall(`(And.Hidden.N._.CarType.${carType}.)`, '|Metadata|Sort|Manufacturer');
    const makers = extractFacets(root, 'Manufacturer');
    console.log(`  ${makers.length}개 제조사`);

    for (const maker of makers) {
      if (maker.count < 50) continue; // 소수 매물은 스킵
      const makerName = maker.display || maker.value;
      console.log(`  - ${makerName} (${maker.count}건)`);
      result[makerName] = { carType: carTypeLabel, models: {} };

      const modelsQ = `(And.Hidden.N._.(C.CarType.${carType}._.Manufacturer.${maker.value}.))`;
      const modelResp = await apiCall(modelsQ, '|Metadata|Sort|Manufacturer|Model');
      const models = extractFacets(modelResp, 'Model');
      await sleep(400);

      for (const model of models) {
        if (model.count < 10) continue;
        const modelName = model.display || model.value;

        // Badge(세부모델) 조회
        const badgeQ = `(And.Hidden.N._.(C.CarType.${carType}._.(C.Manufacturer.${maker.value}._.Model.${model.value}.)))`;
        const badgeResp = await apiCall(badgeQ, '|Metadata|Sort|Manufacturer|Model|Badge');
        const badges = extractFacets(badgeResp, 'Badge');
        await sleep(300);

        result[makerName].models[modelName] = badges.map(b => ({
          name: b.display || b.value,
          count: b.count,
        }));
        console.log(`    · ${modelName} → ${badges.length} 세부모델`);
      }
    }
    await sleep(1000);
  }

  fs.mkdirSync('../app/src/data', { recursive: true });
  fs.writeFileSync('../app/src/data/carCatalog.json', JSON.stringify(result, null, 2));

  const totalMakers = Object.keys(result).length;
  const totalModels = Object.values(result).reduce((s, m) => s + Object.keys(m.models).length, 0);
  const totalBadges = Object.values(result).reduce((s, m) => s + Object.values(m.models).reduce((x, b) => x + b.length, 0), 0);
  console.log(`\n저장: ${totalMakers} 제조사 / ${totalModels} 모델 / ${totalBadges} 세부모델`);
}

main().catch(e => { console.error(e); process.exit(1); });
