// 현황조사서 JSON → 임차인 정보 추출 → raw_data._detail.rgstSummary.atAppraisal 저장
//
// 배경: 감정평가서 PDF 에는 등기부등본 별첨이 없는 것으로 확인됨 (실측 0/2건).
//   → court-rgst-from-appraisal.js 폐기.
// 1차 권리분석 자료는 현황조사서의 임차인 명단으로 대체.
// 매각물건명세서 atSale 분석은 매각 7일 전부터 가능하므로 그 전까진 임차인만 표시,
// 매각 임박 시점에 atSale 들어오면 atAppraisal vs atSale 비교 가능.
//
// 저장 구조:
//   raw_data._detail.rgstSummary.atAppraisal = {
//     tenants: [{ name, moveInDate, deposit, monthlyRent, part, usage, registryCheck, raw }, ...],
//     tenantCount,
//     totalDeposit,         // 보증금 숫자 합계 (미상 제외)
//     hasUnknownDeposit,    // "미상" 보증금 1개 이상이면 true
//     occupancyNote,        // dlt_ordTsRlet[*].gdsPossCtt 점유관계 설명 합본
//     source: { kind: 'curst-exmn', exam_date, parsed_at }
//   }
//
// 실행:
//   node collectors/court-tenant-from-curst.js --case 2024타경62131
//   node collectors/court-tenant-from-curst.js --upload --limit 30

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '30'), 10) || 30;
const CASE_NUMBER = argOf('--case', null);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function parseDate(s) {
  if (!s || /미상/.test(s)) return null;
  const m = String(s).match(/(\d{4})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
}

// 보증금/월세 파싱: 한국식 "1억 2천만원" or 숫자 or "미상"
function parseAmount(s) {
  if (!s || /미상|불명|없음/.test(s)) return null;
  const t = String(s).replace(/[,\s원]/g, '');
  let total = 0;
  const eok = t.match(/(\d+)억/);          if (eok)   total += parseInt(eok[1]) * 1e8;
  const ch  = t.match(/(\d+)천만/);        if (ch)    total += parseInt(ch[1])  * 1e7;
  const cm  = t.match(/(\d+)천(?!만)/);    if (cm)    total += parseInt(cm[1])  * 1e3;
  const bm  = t.match(/(\d+)백만/);        if (bm)    total += parseInt(bm[1])  * 1e6;
  const mm  = t.match(/(\d+)만/);          if (mm)    total += parseInt(mm[1])  * 1e4;
  if (total > 0) return total;
  const pure = t.match(/^\d{4,}/);
  return pure ? parseInt(pure[0]) : null;
}

function summarize(curst) {
  const lserList = Array.isArray(curst?.dlt_ordTsLserLtn) ? curst.dlt_ordTsLserLtn : [];
  const rletList = Array.isArray(curst?.dlt_ordTsRlet) ? curst.dlt_ordTsRlet : [];

  const tenants = lserList.map(r => ({
    name: r.intrpsNm || null,
    moveInDate: parseDate(r.mvinDtlCtt),
    moveInRaw: r.mvinDtlCtt || null,
    deposit: parseAmount(r.lesDposDts),
    depositRaw: r.lesDposDts || null,
    monthlyRent: parseAmount(r.mmrntAmtDts),
    monthlyRentRaw: r.mmrntAmtDts || null,
    part: r.lesPartCtt || null,
    usage: r.lesUsgDts || null,
    registryCheck: r.rgstryCrtcpCfmtnCtt || null,
  }));

  const knownDeposits = tenants.map(t => t.deposit).filter(v => typeof v === 'number');
  const totalDeposit = knownDeposits.length ? knownDeposits.reduce((a,b)=>a+b,0) : null;
  const hasUnknownDeposit = tenants.some(t => t.deposit === null && t.depositRaw);

  const occupancyNote = rletList
    .map(r => (r.gdsPossCtt || '').replace(/<br\s*\/?>/g, '\n').replace(/\r/g, '').trim())
    .filter(Boolean).join('\n---\n') || null;

  return {
    tenants,
    tenantCount: tenants.length,
    totalDeposit,
    hasUnknownDeposit,
    occupancyNote,
    source: {
      kind: 'curst-exmn',
      exam_date: curst?.dma_curstExmnMngInf?.exmnDtDts || null,
      parsed_at: new Date().toISOString(),
    },
  };
}

async function processOne(item) {
  const curst = item.raw_data?._detail?.curstExmn;
  if (!curst) return { ok: false, reason: 'no-curst' };

  const summary = summarize(curst);

  if (DO_UPLOAD) {
    const newRaw = { ...(item.raw_data ?? {}) };
    const existingRgst = newRaw._detail?.rgstSummary ?? {};
    newRaw._detail = {
      ...(newRaw._detail ?? {}),
      rgstSummary: { ...existingRgst, atAppraisal: summary },
    };
    const { error } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', item.id);
    if (error) return { ok: false, reason: 'db-' + error.message };
  }
  return { ok: true, summary };
}

async function main() {
  console.log(`Tenant from curstExmn (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source','court_auction')
    .eq('category','real_estate')
    .not('raw_data->_detail->curstExmn','is',null)
    .limit(LIMIT * 3);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  else q = q.is('raw_data->_detail->rgstSummary->atAppraisal', null);
  const { data, error } = await q;
  if (error) { console.error(error); process.exit(1); }
  console.log(`대상 ${data.length}건`);

  let ok = 0, withTenant = 0, fail = 0;
  for (const it of data) {
    if (ok >= LIMIT) break;
    try {
      const r = await processOne(it);
      if (r.ok) {
        const s = r.summary;
        if (s.tenantCount > 0) withTenant++;
        console.log(`\n[OK] ${it.case_number}  임차인 ${s.tenantCount}명, 보증금합계 ${s.totalDeposit ?? '-'}${s.hasUnknownDeposit ? ' (미상포함)' : ''}`);
        s.tenants.slice(0, 3).forEach(t =>
          console.log(`    - ${t.name ?? '?'}  전입 ${t.moveInDate ?? '-'}  보증금 ${t.deposit ?? t.depositRaw ?? '-'}  ${t.part ?? ''}`));
        ok++;
      } else {
        fail++;
      }
    } catch (e) { console.log(`[FAIL] ${it.case_number} ${e.message}`); fail++; }
  }
  console.log(`\n완료: ok=${ok} (임차인있음 ${withTenant}) fail=${fail}`);
}
main().catch(e => { console.error(e); process.exit(1); });
