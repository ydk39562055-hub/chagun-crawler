// 법원경매 물건 상세 수집기 (courtauction.go.kr) — 순수 fetch 버전
// court-stealth.js의 collectDetails를 Playwright 없이 재구현
// 엔드포인트: POST /pgj/pgj15B/selectAuctnCsSrchRslt.on
// 대상: auction_items에서 thumbnail_url IS NULL인 물건
// 실행:
//   node collectors/court-detail-collect.js                  (미리보기)
//   node collectors/court-detail-collect.js --upsert         (Supabase 저장)
//   node collectors/court-detail-collect.js --upsert --limit 100
//
// 안정성: UA 풀 로테이션, 2~3초 랜덤 딜레이, 재시도 3회+지수백오프

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const DETAIL_URL = 'https://www.courtauction.go.kr/pgj/pgj15B/selectAuctnCsSrchRslt.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];
const UA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
const itemDelay = () => 2000 + Math.random() * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const DO_UPSERT = args.includes('--upsert');
const LIMIT = parseInt(argOf('--limit', '50'), 10) || 50;
const CATEGORY = argOf('--category', 'all'); // all | real_estate | vehicle
const CASE_NUMBER = argOf('--case', null);

async function fetchCookie() {
  const res = await fetch(HOME_URL, {
    headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

const CURST_URL = 'https://www.courtauction.go.kr/pgj/pgj15B/selectCurstExmndc.on';
const AEWEVL_URL = 'https://www.courtauction.go.kr/pgj/pgj15B/selectAeeWevlInfo.on';

async function fetchDetail(cookie, payload, url = DETAIL_URL, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
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
      const json = await res.json();
      return json;
    } catch (e) {
      lastErr = e;
      console.log(`    재시도 (${i}/${attempts}): ${e.message.split('\n')[0]}`);
      if (i < attempts) await sleep(2000 * Math.pow(2, i - 1)); // 지수 백오프: 2s, 4s
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`Court Auction 상세 수집기 시작 (upsert=${DO_UPSERT}, limit=${LIMIT})`);

  // Supabase 초기화 (미리보기 모드에서도 대상 조회 필요)
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1); }
  const supabase = createClient(url, key);

  // thumbnail_url IS NULL인 물건 조회 (매각일 90일 이내 롤링 윈도우)
  const todayIso = new Date().toISOString().slice(0, 10);
  const window90 = new Date(); window90.setDate(window90.getDate() + 90);
  const window90Iso = window90.toISOString().slice(0, 10);
  let q = supabase
    .from('auction_items')
    .select('id, case_number, category, raw_data')
    .eq('source', 'court_auction')
    .is('thumbnail_url', null)
    .gte('auction_date', todayIso)
    .lte('auction_date', window90Iso)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT);
  if (CATEGORY !== 'all') q = q.eq('category', CATEGORY);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error: qErr } = await q;

  if (qErr) { console.error('DB 조회 실패:', qErr.message); process.exit(1); }
  console.log(`상세 수집 대상 ${items.length}건 (thumbnail_url IS NULL)`);
  if (!items.length) { console.log('수집 대상 없음'); return; }

  const cookie = await fetchCookie();
  console.log('세션 쿠키 확보');

  let ok = 0, blocked = 0, errors = 0;

  for (const it of items) {
    const raw = it.raw_data ?? {};
    const payload = {
      dma_srchGdsDtlSrch: {
        cortOfcCd: raw.boCd,
        csNo: String(raw.saNo),
        dspslGdsSeq: Number(raw.maemulSer || 1),
        pgmId: 'PGJ15BA00',
      },
    };

    try {
      const r = await fetchDetail(cookie, payload);

      if (r.status !== 200 || /차단|비정상/.test(r.message || '')) {
        console.log(`  ${it.case_number} BLOCKED:`, (r.message || '').slice(0, 80));
        blocked++;
        if (blocked >= 3) {
          console.log('\n3건 연속 차단 — 중단');
          break;
        }
        await sleep(10000);
        continue;
      }

      const d = r.data?.dma_result ?? {};

      // 사진 추출
      const photos = (d.csPicLst ?? []).map((p, i) => ({
        order: i,
        url: p.picFileUrl ? `https://www.courtauction.go.kr${p.picFileUrl}${p.picTitlNm}` : null,
        title: p.picTitlNm,
        type_code: p.cortAuctnPicDvsCd,
      })).filter(p => p.url);

      // 상세 정보 추출
      const goods = d.dspslGdsDxdyInfo ?? {};
      const base = d.csBaseInfo ?? {};

      // 현황조사서 API (임차인 + 점유현황)
      let curstExmn = null;
      try {
        const cr = await fetchDetail(cookie, { dma_srchCurstExmn: { cortOfcCd: raw.boCd, csNo: String(raw.saNo), auctnInfOriginDvsCd: '2', ordTsCnt: '' } }, CURST_URL, 1);
        if (cr.status === 200) curstExmn = cr.data;
      } catch {}
      await sleep(2000);

      // 감정평가서 API (감정사·감정일)
      let aeeWevl = null;
      try {
        const ar = await fetchDetail(cookie, { dma_srchAeeWevl: { cortOfcCd: raw.boCd, csNo: String(raw.saNo), auctnInfOriginDvsCd: '2', ordTsCnt: '' } }, AEWEVL_URL, 1);
        if (ar.status === 200) aeeWevl = ar.data;
      } catch {}

      // 기존 supabase-hosted _photos가 있으면 보존 (court-photo-rehost 결과 덮어쓰기 방지)
      const existingPhotos = Array.isArray(raw._photos) ? raw._photos : [];
      const isRehosted = existingPhotos.some(p => String(p?.url ?? '').startsWith(process.env.SUPABASE_URL || 'https://oykzyilxxfmttcudqojf.supabase.co'));
      const keepPhotos = isRehosted ? existingPhotos : photos;
      const keepThumb = isRehosted ? (existingPhotos[0]?.url ?? null) : (photos[0]?.url ?? null);

      if (DO_UPSERT) {
        const { error: upErr } = await supabase.from('auction_items').update({
          raw_data: {
            ...raw,
            _photos: keepPhotos,
            _detail: {
              ...(raw._detail ?? {}), // 기존 PDF 참조·요약(dspslGdsSpcfcPdf, rgstSummary, rgstRcrdPdf 등) 보존
              base,
              goods,
              dstrtDemnInfo: d.dstrtDemnInfo ?? [],
              picDvsIndvdCnt: d.picDvsIndvdCnt ?? [],
              gdsDspslDxdyLst: d.gdsDspslDxdyLst ?? [],
              gdsDspslObjctLst: d.gdsDspslObjctLst ?? [],
              aeeWevlMnpntLst: d.aeeWevlMnpntLst ?? [],
              rgltLandLstAll: d.rgltLandLstAll ?? [],
              bldSdtrDtlLstAll: d.bldSdtrDtlLstAll ?? [],
              gdsNotSugtBldLsstAll: d.gdsNotSugtBldLsstAll ?? [],
              gdsRletStLtnoLstAll: d.gdsRletStLtnoLstAll ?? [],
              curstExmn: curstExmn ?? {},
              aeeWevlInfo: aeeWevl ?? {},
              fetched_at: new Date().toISOString(),
            },
          },
          thumbnail_url: keepThumb,
        }).eq('id', it.id);

        if (upErr) {
          console.error(`  ${it.case_number} update 실패:`, upErr.message);
          errors++;
          continue;
        }
      }

      ok++;
      blocked = 0;
      console.log(`  [${ok}/${items.length}] ${it.case_number} · 사진 ${photos.length} · 비고 ${(goods.dspslGdsRmk || '').slice(0, 30)}`);
    } catch (e) {
      console.error(`  ${it.case_number} 에러:`, e.message);
      errors++;
    }

    await sleep(itemDelay());
  }

  console.log(`\n완료: 성공 ${ok}건, 차단 ${blocked}건, 에러 ${errors}건`);
  if (!DO_UPSERT) console.log('(미리보기 - DB 저장 안 됨. --upsert 플래그로 저장)');
}

main().catch(e => { console.error(e); process.exit(1); });
