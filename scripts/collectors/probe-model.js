import fs from 'node:fs';

const url = 'https://api.encar.com/search/car/list/general?count=true&q=' +
  encodeURIComponent('(And.Hidden.N._.(C.CarType.Y._.Manufacturer.현대.))') +
  '&inav=%7CMetadata%7CSort%7CModel';

(async () => {
  const r = await fetch(url, { headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
    'Referer': 'http://www.encar.com/',
    'Origin': 'http://www.encar.com',
  }});
  const t = await r.text();
  fs.writeFileSync('tmp/catalog/probe-hyundai.json', t);
  const j = JSON.parse(t);
  const nodes = j?.iNav?.Nodes ?? [];
  console.log('nodes:', nodes.length);
  nodes.forEach(n => console.log(`  ${n.Name}: ${(n.Facets||[]).length}`));
  const m = nodes.find(n => n.Name === 'Model');
  if (m) {
    console.log('\nModel facets:');
    (m.Facets || []).slice(0, 10).forEach(f => console.log(`  - ${f.DisplayValue || f.Value} (${f.Count})`));
  }
})();
