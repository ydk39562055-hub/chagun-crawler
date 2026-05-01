import 'dotenv/config';
const today = new Date().toISOString().slice(0,10);
const seven = new Date(Date.now() + 7*86400000).toISOString().slice(0,10);
// 임박 7일 + atSale + 사진 있는 매물 1개 (가장 완성도 높은 케이스)
const url = `${process.env.SUPABASE_URL}/rest/v1/auction_items?select=id,case_number,auction_date,thumbnail_url&source=eq.court_auction&category=eq.real_estate&auction_date=gte.${today}&auction_date=lte.${seven}&raw_data->_detail->dspslGdsSpcfcPdf=not.is.null&raw_data->_detail->rgstSummary->seniorRight=not.is.null&thumbnail_url=not.is.null&limit=3`;
const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
const data = await r.json();
console.log('완성도 높은 매물 샘플:');
data.forEach(d => console.log(`  ${d.case_number} (id=${d.id}) 매각일 ${d.auction_date}`));
