// 법원경매 사진 재호스팅 — 순수 fetch 버전
//
// 발견 사실: csPicLst[].picFileUrl 은 실제 존재하지 않는 경로(404).
// 실제 이미지 바이트는 같은 응답의 picFile 필드에 base64 로 embedded 되어 있음.
// 따라서 Playwright 불필요 — 상세 API 재호출 → base64 디코드 → Storage 업로드.
//
// 저장 경로: auction-photos/{boCd}/{saNo}/{maemulSer}/{order}.jpg
// DB: raw_data._photos[i].url = https://.../storage/v1/object/public/auction-photos/...
//     thumbnail_url 도 갱신
//
// 실행:
//   node collectors/court-photo-rehost.js --limit 5                 (미리보기)
//   node collectors/court-photo-rehost.js --upload --limit 5        (업로드)
//   node collectors/court-photo-rehost.js --upload --case 2024타경136561

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const DETAIL_URL = 'https://www.courtauction.go.kr/pgj/pgj15B/selectAuctnCsSrchRslt.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const UA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

const args = process.argv.slice(2);
const argOf = (flag, fb) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '5'), 10) || 5;
const CASE_NUMBER = argOf('--case', null);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

async function fetchCookie() {
  const res = await fetch(HOME_URL, {
    headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

async function fetchDetail(cookie, payload) {
  const res = await fetch(DETAIL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': UA(),
      'Accept': 'application/json',
      'Referer': HOME_URL,
      'Origin': 'https://www.courtauction.go.kr',
      'Cookie': cookie,
    },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

async function rehostOne(cookie, supabase, item) {
  const raw = item.raw_data ?? {};
  const { boCd, saNo, maemulSer } = raw;
  if (!boCd || !saNo) return { ok: false, reason: 'missing-id' };

  // 상세 API 재호출 → picFile 확보
  const r = await fetchDetail(cookie, {
    dma_srchGdsDtlSrch: {
      cortOfcCd: boCd,
      csNo: String(saNo),
      dspslGdsSeq: Number(maemulSer || 1),
      pgmId: 'PGJ15BA00',
    },
  });
  if (r.status !== 200) return { ok: false, reason: `api-${r.status}-${(r.message || '').slice(0, 40)}` };

  const pics = r.data?.dma_result?.csPicLst ?? [];
  if (pics.length === 0) return { ok: false, reason: 'no-photos' };

  const uploaded = [];
  for (let i = 0; i < pics.length; i++) {
    const p = pics[i];
    if (!p.picFile) { console.log(`  [${i}] no picFile`); continue; }
    try {
      const buf = Buffer.from(p.picFile, 'base64');
      if (buf.length < 2000) { console.log(`  [${i}] too-small ${buf.length}B`); continue; }

      const storagePath = `${boCd}/${saNo}/${maemulSer || 1}/${i}.jpg`;
      if (DO_UPLOAD) {
        const { error: upErr } = await supabase.storage.from('auction-photos').upload(storagePath, buf, {
          contentType: 'image/jpeg', upsert: true,
        });
        if (upErr) { console.log(`  [${i}] upload err: ${upErr.message}`); continue; }
      }
      uploaded.push({
        order: i,
        path: storagePath,
        bytes: buf.length,
        title: p.picTitlNm,
        type_code: p.cortAuctnPicDvsCd,
      });
    } catch (e) {
      console.log(`  [${i}] decode err: ${e.message.split('\n')[0]}`);
    }
  }

  if (DO_UPLOAD && uploaded.length > 0) {
    const baseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/auction-photos`;
    const newPhotos = uploaded.map(u => ({
      order: u.order,
      url: `${baseUrl}/${u.path}`,
      title: u.title ?? null,
      type_code: u.type_code ?? null,
      rehosted_at: new Date().toISOString(),
      bytes: u.bytes,
    }));
    const newRaw = { ...raw, _photos: newPhotos };
    const { error } = await supabase.from('auction_items')
      .update({ raw_data: newRaw, thumbnail_url: newPhotos[0]?.url ?? null })
      .eq('id', item.id);
    if (error) return { ok: false, reason: 'db-' + error.message };
  }

  return {
    ok: uploaded.length > 0,
    count: uploaded.length,
    totalKB: Math.round(uploaded.reduce((s, u) => s + u.bytes, 0) / 1024),
  };
}

async function main() {
  console.log(`Court Photo Rehost (base64, upload=${DO_UPLOAD}, limit=${LIMIT})`);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 90일 롤링 윈도우
  const todayIso = new Date().toISOString().slice(0, 10);
  const window90 = new Date(); window90.setDate(window90.getDate() + 90);
  const window90Iso = window90.toISOString().slice(0, 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction')
    .eq('category', 'real_estate')
    .not('raw_data->_photos', 'is', null)
    .gte('auction_date', todayIso)
    .lte('auction_date', window90Iso)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 3);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }

  // 이미 supabase 호스팅된 건 제외
  const baseUrl = process.env.SUPABASE_URL;
  const targets = items.filter(it => {
    const p = it.raw_data?._photos?.[0];
    return p && !String(p.url ?? '').startsWith(baseUrl);
  }).slice(0, LIMIT);
  console.log(`대상 ${targets.length}건 (전체 ${items.length})`);
  if (!targets.length) return;

  const cookie = await fetchCookie();
  console.log('세션 쿠키 확보');

  let ok = 0, fail = 0, consec = 0, totalKB = 0;
  for (const it of targets) {
    console.log(`\n[${ok + fail + 1}/${targets.length}] ${it.case_number}`);
    try {
      const r = await rehostOne(cookie, supabase, it);
      if (r.ok) { console.log(`  OK ${r.count}장 · ${r.totalKB}KB`); ok++; consec = 0; totalKB += r.totalKB; }
      else { console.log(`  FAIL: ${r.reason}`); fail++; consec++; }
    } catch (e) { console.log(`  ERR: ${e.message.split('\n')[0]}`); fail++; consec++; }
    if (consec >= 3) { console.log('\n3연속 실패 — 중단'); break; }
    if (ok + fail < targets.length) await sleep(rand(3000, 5000));
  }

  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}, 총 ${totalKB}KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
