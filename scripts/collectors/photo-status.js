import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// thumbnail_url 있는 것 / _photos 있는 것 전체 분포
const { count: total } = await sb.from('auction_items')
  .select('id', { count: 'exact', head: true })
  .eq('source', 'court_auction').eq('category', 'real_estate');
const { count: withThumb } = await sb.from('auction_items')
  .select('id', { count: 'exact', head: true })
  .eq('source', 'court_auction').eq('category', 'real_estate')
  .not('thumbnail_url', 'is', null);
const { count: withDetail } = await sb.from('auction_items')
  .select('id', { count: 'exact', head: true })
  .eq('source', 'court_auction').eq('category', 'real_estate')
  .not('raw_data->_detail', 'is', null);
console.log(`부동산 ${total}건, _detail 있음 ${withDetail}건, thumbnail_url 있음 ${withThumb}건`);

// 샘플 3건 전체 URL
const { data } = await sb.from('auction_items')
  .select('id, case_number, thumbnail_url, raw_data')
  .eq('source', 'court_auction').eq('category', 'real_estate')
  .not('thumbnail_url', 'is', null)
  .limit(3);

for (const it of data) {
  console.log(`\n[${it.case_number}]`);
  console.log(`  thumbnail_url: ${it.thumbnail_url}`);
  const photos = it.raw_data?._photos ?? [];
  console.log(`  _photos.length: ${photos.length}`);
  photos.slice(0, 2).forEach((p, i) => {
    console.log(`    [${i}] ${p.url}`);
  });
}
