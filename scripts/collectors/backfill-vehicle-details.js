// 법원경매 차량 매물 vehicle_details 백필
// raw_data.carNm/carYrtype/fuelKindcd + raw_data._detail.parsedVehicle 결과를 vehicle_details에 upsert.
//
// 실행:
//   node collectors/backfill-vehicle-details.js              (dry-run)
//   node collectors/backfill-vehicle-details.js --upsert     (실제 저장)
//   node collectors/backfill-vehicle-details.js --upsert --limit 200

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const FUEL_MAP = {
  '0001001': 'gasoline', '0001002': 'diesel', '0001003': 'lpg',
  '0001004': 'hybrid', '0001005': 'gasoline', '0001006': 'ev', '0001009': 'other',
};

// carNm 첫 단어로 maker 간단 추출 (충분치 않은 경우 NULL)
const KNOWN_MAKERS = ['현대','기아','제네시스','쌍용','르노','쉐보레','GM','BMW','벤츠','메르세데스','아우디','폭스바겐','포르쉐','마칸','파나메라','카이엔','볼보','도요타','토요타','렉서스','혼다','포드','지프','캐딜락','테슬라','마세라티','페라리','람보르기니','롤스로이스','벤틀리','맥라렌','애스턴마틴','BYD'];

function extractMaker(carNm) {
  if (!carNm) return null;
  for (const m of KNOWN_MAKERS) {
    if (carNm.includes(m)) return m;
  }
  return null;
}

const args = process.argv.slice(2);
const DO_UPSERT = args.includes('--upsert');
const LIMIT = parseInt(args[args.indexOf('--limit') + 1] || '1000', 10) || 1000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  console.log(`Vehicle Details Backfill (upsert=${DO_UPSERT}, limit=${LIMIT})`);
  if (!process.env.SUPABASE_URL) { console.error('SUPABASE env missing'); process.exit(1); }

  const { data: items, error } = await supabase
    .from('auction_items')
    .select('id, raw_data')
    .eq('category', 'vehicle')
    .eq('source', 'court_auction')
    .limit(LIMIT);
  if (error) { console.error(error); process.exit(1); }
  console.log(`대상 ${items.length}건`);

  let ok = 0, skip = 0, fail = 0;
  for (const it of items) {
    const raw = it.raw_data || {};
    const parsed = raw._detail?.parsedVehicle || {};

    const carNm = raw.carNm || parsed.carType || null;
    const yr = raw.carYrtype || parsed.year || null;
    const fuelCd = raw.fuelKindcd || null;
    const fuel = fuelCd ? FUEL_MAP[fuelCd] : (parsed.fuel || null);
    const mileage = (typeof parsed.mileage === 'number' && parsed.mileage > 0) ? parsed.mileage : null;
    const vin = parsed.vin || null;
    const maker = extractMaker(carNm);

    if (!carNm) { skip++; continue; }

    const vd = {
      auction_item_id: it.id,
      maker: maker,
      model: carNm.slice(0, 100),
      year: typeof yr === 'number' ? yr : (yr ? parseInt(yr, 10) || null : null),
      fuel_type: fuel,
      mileage_km: mileage,
      vin: vin,
    };

    if (DO_UPSERT) {
      const { error: upErr } = await supabase
        .from('vehicle_details')
        .upsert(vd, { onConflict: 'auction_item_id' });
      if (upErr) { console.log(`  fail ${it.id} ${upErr.message}`); fail++; continue; }
    }
    ok++;
    if (ok <= 5) console.log(`  [${ok}] ${carNm} | ${yr}년 | ${fuel || '-'} | ${maker || '-'}`);
  }

  console.log(`\n완료: 처리 ${ok}, 스킵(carNm 없음) ${skip}, 실패 ${fail}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
