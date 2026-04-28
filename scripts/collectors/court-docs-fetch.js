// 감정평가서 원본 PDF 수집 (kapanet 직링크)
//
// 배경: 현황조사서·감정평가서 JSON은 이미 _detail.curstExmn / _detail.aeeWevlInfo 에
// 수집되어 있음. 추가로 필요한 건 감정평가서 PDF 원본뿐.
//
// 흐름:
//   1) _detail.aeeWevlInfo.dma_ordTsIndvdAeeWevlInf 에서
//      { cortOfcCd, csNo, ordTsCnt, aeeWevlNo, wrtYmd } 추출
//   2) GET https://ca.kapanet.or.kr/view/{cort6}/{csNo}/{ordTsCnt}/{aeeWevlNo}/{wrtYmd}
//   3) 응답 HTML 내 script 에서 .pdf 경로 추출 → 절대 URL 조립
//   4) PDF 다운로드 → Supabase auction-pdfs 업로드
//   5) raw_data._detail.aeeWevlPdf = { path, bytes, captured_at, sourceUrl }
//
// 매각물건명세서는 뷰어 XML이 placeholder 라서 별도 probe 필요 (현재 미지원).
// 실행:
//   node collectors/court-docs-fetch.js --case 2025타경748
//   node collectors/court-docs-fetch.js --upload --case 2025타경748
//   node collectors/court-docs-fetch.js --upload --limit 30

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const argOf = (f, fb) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '10'), 10) || 10;
const CASE_NUMBER = argOf('--case', null);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COURT_REFERER = 'https://www.courtauction.go.kr/';

async function resolveKapaPdfUrl(inf) {
  if (!inf?.aeeWevlNo || !inf?.cortOfcCd || !inf?.csNo || !inf?.wrtYmd) throw new Error('missing-fields');
  const cort6 = String(inf.cortOfcCd).replace(/^[A-Z]/, ''); // B000210 → 000210
  const viewUrl = `https://ca.kapanet.or.kr/view/${cort6}/${inf.csNo}/${inf.ordTsCnt}/${inf.aeeWevlNo}/${inf.wrtYmd}`;
  const res = await fetch(viewUrl, { headers: { 'User-Agent': UA, 'Referer': COURT_REFERER } });
  if (!res.ok) throw new Error(`view-${res.status}`);
  const html = await res.text();
  const m = html.match(/\.src\s*=\s*['"]([^'"]+\.pdf)['"]/);
  if (!m) throw new Error('no-pdf-in-view');
  return `https://ca.kapanet.or.kr${m[1]}`;
}

async function downloadPdf(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://ca.kapanet.or.kr/', 'Accept': 'application/pdf,*/*' },
  });
  if (!res.ok) throw new Error(`pdf-${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('pdf') && !ct.includes('octet')) throw new Error(`ct-${ct}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length < 10000) throw new Error(`too-small-${buf.length}`);
  return buf;
}

async function processItem(supabase, item) {
  const raw = item.raw_data ?? {};
  const det = raw._detail ?? {};
  const inf = det.aeeWevlInfo?.dma_ordTsIndvdAeeWevlInf;
  if (!inf) return { ok: false, reason: 'no-aeeWevlInfo' };
  if (det.aeeWevlPdf?.path) return { ok: false, reason: 'already-has-pdf' };

  const cortOfcCd = inf.cortOfcCd;
  const csNo = inf.csNo;
  const maemulSer = String(raw.maemulSer || 1);

  const pdfUrl = await resolveKapaPdfUrl(inf);
  const pdfBuf = await downloadPdf(pdfUrl);

  const meta = {
    bytes: pdfBuf.length,
    captured_at: new Date().toISOString(),
    sourceUrl: pdfUrl,
  };

  if (DO_UPLOAD) {
    const storagePath = `${cortOfcCd}/${csNo}/${maemulSer}/aee-wevl.pdf`;
    const { error: upErr } = await supabase.storage.from('auction-pdfs').upload(storagePath, pdfBuf, {
      contentType: 'application/pdf', upsert: true,
    });
    if (upErr) throw new Error('storage-' + upErr.message);
    meta.path = storagePath;

    const newRaw = { ...raw };
    newRaw._detail = { ...(newRaw._detail ?? {}), aeeWevlPdf: meta };
    const { error: dbErr } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', item.id);
    if (dbErr) throw new Error('db-' + dbErr.message);
  }

  return { ok: true, bytes: pdfBuf.length, path: meta.path };
}

async function main() {
  console.log(`Court Docs Fetch — 감정평가서 PDF (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE env missing'); process.exit(1); }
  const supabase = createClient(url, key);

  // 매각일 미래(아직 안 끝난 건)부터 가까운 순. 60일 롤링 윈도우.
  // 이미 매각 끝난 건은 kapanet 이 PDF 내림 → view-404 → 3연속 가드 발동 위험
  const todayIso = new Date().toISOString().slice(0, 10);
  const window60 = new Date(); window60.setDate(window60.getDate() + 60);
  const window60Iso = window60.toISOString().slice(0, 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data, auction_date')
    .eq('source', 'court_auction').eq('category', 'real_estate')
    .not('raw_data->_detail->aeeWevlInfo', 'is', null)
    .gte('auction_date', todayIso)
    .lte('auction_date', window60Iso)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 8);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error('DB:', error.message); process.exit(1); }

  // 미리 거르기: 이미 PDF 있거나 필수 필드 누락이면 후보에서 제외
  // (3연속 실패 가드를 의미 없는 SKIP 이 발화시키지 않도록)
  const targets = items.filter(it => {
    const det = it.raw_data?._detail ?? {};
    if (det.aeeWevlPdf?.path) return false;
    const inf = det.aeeWevlInfo?.dma_ordTsIndvdAeeWevlInf;
    if (!inf?.aeeWevlNo || !inf?.cortOfcCd || !inf?.csNo || !inf?.wrtYmd) return false;
    return true;
  }).slice(0, LIMIT);
  const skipped = items.length - targets.length;
  console.log(`후보 ${items.length}건 → 시도 ${targets.length}건 (이미 받음·필드누락 ${skipped}건 제외)`);
  if (!targets.length) return;

  let ok = 0, fail = 0, consec = 0;
  for (const it of targets) {
    console.log(`\n[${ok + fail + 1}/${targets.length}] ${it.case_number}`);
    try {
      const r = await processItem(supabase, it);
      if (r.ok) { console.log(`  OK ${Math.round(r.bytes/1024)}KB → ${r.path || '(dry-run)'}`); ok++; consec = 0; }
      else {
        console.log(`  SKIP: ${r.reason}`); fail++;
        // 사전필터로 already-has/missing-fields 는 안 들어오지만 안전망
        if (!/already-has-pdf|missing-fields|no-aeeWevlInfo/.test(r.reason || '')) consec++;
      }
    } catch (e) {
      const msg = e.message.split('\n')[0];
      console.log(`  FAIL: ${msg}`); fail++;
      // 데이터 누락(404·no-pdf·too-small)은 차단 아님 → consec 카운트 제외
      if (!/^view-404|^pdf-404|no-pdf-in-view|too-small/.test(msg)) consec++;
    }
    if (consec >= 5) { console.log('\n5건 연속 차단성 실패 — 중단'); break; }
    if (ok + fail < targets.length) await sleep(rand(2500, 4500));
  }
  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
