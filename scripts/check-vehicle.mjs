import 'dotenv/config';
const today = new Date().toISOString().slice(0,10);
async function count(filter, base = `auction_date=gte.${today}`) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/auction_items?select=id&source=eq.court_auction&category=eq.vehicle&${base}&${filter}`;
  const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Range: '0-0', Prefer: 'count=exact' } });
  return parseInt(r.headers.get('content-range').split('/')[1]);
}
const pool = await count('id=not.is.null');
const detail = await count('raw_data->_detail->base=not.is.null');
const thumb = await count('thumbnail_url=not.is.null');
const photos = await count('raw_data->_photos=not.is.null');
const docsSnap = await count('raw_data->_detail->docsSnapPdf=not.is.null');
const spcfc = await count('raw_data->_detail->dspslGdsSpcfcPdf=not.is.null');
console.log('=== 차량 매물 진척도 ===');
console.log(`풀(매각일 ≥ today): ${pool}`);
console.log(`detail 받힘:        ${detail}`);
console.log(`썸네일:             ${thumb}  (${pool > 0 ? (thumb/pool*100).toFixed(1) : 0}%)`);
console.log(`_photos 배열 있음:  ${photos}`);
console.log(`문건/송달 PDF:      ${docsSnap}`);
console.log(`매각PDF:            ${spcfc}`);

// 차량 매물 1건 raw_data 샘플
const url = `${process.env.SUPABASE_URL}/rest/v1/auction_items?select=case_number,thumbnail_url,raw_data&source=eq.court_auction&category=eq.vehicle&auction_date=gte.${today}&order=auction_date.asc&limit=2`;
const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
const data = await r.json();
console.log('\n=== 샘플 매물 2건 ===');
data.forEach(d => {
  const photos = d.raw_data?._photos ?? [];
  const detail = d.raw_data?._detail;
  console.log(`\n${d.case_number}`);
  console.log(`  thumbnail_url: ${d.thumbnail_url ?? 'NULL'}`);
  console.log(`  _photos: ${photos.length}장`);
  if (photos.length > 0) {
    photos.slice(0,2).forEach(p => console.log(`    - ${p.url?.slice(0,100)}`));
  }
  console.log(`  _detail: ${detail ? '있음' : '없음'}`);
});
