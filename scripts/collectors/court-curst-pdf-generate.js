// 현황조사서 PDF 생성 — 법원은 원본 PDF를 배포하지 않아
// 이미 수집한 _detail.curstExmn JSON을 HTML로 렌더한 뒤 Playwright page.pdf() 로 PDF 스냅샷 생성.
// 법원 추가 호출 없음 → anti-block 정책 무관.
//
// 저장 경로: auction-pdfs/{boCd}/{saNo}/curst-exmn.pdf
// DB: _detail.curstExmnPdf = { path, bytes, generated_at, kind: 'json-rendered' }
//
// 실행:
//   node collectors/court-curst-pdf-generate.js --case 2023타경3842 --upload
//   node collectors/court-curst-pdf-generate.js --upload --limit 20

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const argOf = (flag, fb) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fb;
};
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '10'), 10) || 10;
const CASE_NUMBER = argOf('--case', null);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function htmlish(s) {
  // gdsPossCtt 같은 필드는 이미 <br /> 포함. 태그만 허용.
  return String(s ?? '').replace(/[<>&](?!br\s*\/?>)/gi, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[m]);
}

function fmtYmd(y) {
  if (!y || y.length !== 8) return y ?? '';
  return `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
}

// 임차인 필드 한글 라벨 (의미 있는 것만)
const TENANT_LABEL = {
  intrpsNm: '임차인',
  mvinDtlCtt: '전입일',
  lesPartCtt: '임대차 부분',
  lesUsgDts: '임대차 용도',
  lesDposDts: '보증금',
  mmrntAmtDts: '월차임',
  lesDtsRmk: '임대차 비고',
  rgstryCrtcpCfmtnCtt: '확정일자',
};
const TENANT_ORDER = ['intrpsNm', 'mvinDtlCtt', 'lesPartCtt', 'lesUsgDts', 'lesDposDts', 'mmrntAmtDts', 'rgstryCrtcpCfmtnCtt', 'lesDtsRmk'];

function buildHtml(curst, meta) {
  const mng = curst.dma_curstExmnMngInf ?? {};
  const units = Array.isArray(curst.dlt_ordTsRlet) ? curst.dlt_ordTsRlet : [];
  const pics = Array.isArray(curst.dlt_ordTsPicDvs) ? curst.dlt_ordTsPicDvs : [];
  const lsers = Array.isArray(curst.dlt_ordTsLserLtn) ? curst.dlt_ordTsLserLtn : [];

  const unitsHtml = units.map(u => {
    const picCount = pics.filter(p => p.dspslObjctSeq === u.dspslObjctSeq || p.objctSeq === u.objctSeq).length;
    const lserHits = lsers.filter(l => l.dspslObjctSeq === u.dspslObjctSeq || l.objctSeq === u.objctSeq);
    const lserHtml = lserHits.length
      ? `<div class="lser"><div class="h4">임차인 내역 (${lserHits.length}명)</div>${lserHits.map((l, i) => {
          const rows = TENANT_ORDER
            .filter(k => l[k] != null && l[k] !== '')
            .map(k => `<tr><th>${TENANT_LABEL[k]}</th><td>${esc(l[k])}</td></tr>`)
            .join('');
          return rows
            ? `<div class="tenant"><div class="tenant-idx">${i + 1}</div><table class="kv"><tbody>${rows}</tbody></table></div>`
            : '';
        }).join('')}</div>`
      : '';
    return `
      <section class="unit">
        <h3>${esc(u.printSt || (u.bldDtlDts ?? ''))}</h3>
        <table class="kv"><tbody>
          <tr><th>임차인 수</th><td>${esc(u.lesCnt ?? 0)}명</td></tr>
          ${picCount ? `<tr><th>현장 사진</th><td>${picCount}장</td></tr>` : ''}
          ${u.rletLstRmk ? `<tr><th>비고</th><td>${esc(u.rletLstRmk)}</td></tr>` : ''}
        </tbody></table>
        <div class="poss"><div class="h4">점유·임대차 상세</div><div class="poss-body">${htmlish(u.gdsPossCtt || '')}</div></div>
        ${lserHtml}
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>현황조사서 ${esc(mng.userCsNo || '')}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; color: #111; font-size: 11pt; line-height: 1.55; word-break: keep-all; overflow-wrap: break-word; }
  table { table-layout: fixed; word-break: keep-all; overflow-wrap: anywhere; }
  .tenant { margin: 6pt 0; padding: 8pt 10pt; border: 1px solid #e5e5e5; border-radius: 3pt; background: #fff; position: relative; }
  .tenant-idx { position: absolute; top: 6pt; right: 8pt; font-size: 9pt; color: #888; }
  h1 { text-align: center; font-size: 20pt; margin: 0 0 6pt; letter-spacing: 0.5pt; }
  .sub { text-align: center; color: #555; font-size: 9pt; margin-bottom: 18pt; }
  .meta { margin: 0 0 12pt; padding: 10pt 12pt; border: 1px solid #ccc; background: #fafafa; border-radius: 4pt; }
  .meta table { width: 100%; border-collapse: collapse; }
  .meta th, .meta td { text-align: left; padding: 4pt 6pt; font-size: 10pt; vertical-align: top; }
  .meta th { width: 28%; color: #666; font-weight: 600; }
  h2 { font-size: 13pt; margin: 16pt 0 8pt; padding-bottom: 3pt; border-bottom: 2px solid #222; }
  section.unit { margin: 0 0 14pt; padding: 10pt 12pt; border: 1px solid #ddd; border-radius: 4pt; page-break-inside: avoid; }
  section.unit h3 { font-size: 12pt; margin: 0 0 6pt; }
  .h4 { font-weight: 600; margin-top: 6pt; color: #333; }
  table.kv { width: 100%; border-collapse: collapse; margin: 2pt 0; }
  table.kv th, table.kv td { border-bottom: 1px solid #eee; padding: 3pt 6pt; font-size: 10pt; vertical-align: top; text-align: left; }
  table.kv th { width: 28%; color: #555; font-weight: 500; background: #f7f7f7; }
  .poss-body { font-size: 10pt; background: #f9f9f9; padding: 6pt 8pt; border-radius: 3pt; white-space: pre-wrap; }
  .footer { margin-top: 24pt; padding-top: 8pt; border-top: 1px solid #ccc; font-size: 8.5pt; color: #777; }
  .badge { display: inline-block; padding: 1pt 6pt; border: 1px solid #c88; color: #a33; background: #fff5f5; font-size: 8pt; border-radius: 10pt; margin-left: 6pt; vertical-align: middle; }
</style></head><body>
  <h1>현황조사서 <span class="badge">화면 스냅샷</span></h1>
  <div class="sub">대한민국 법원경매정보 (courtauction.go.kr) 현황조사 결과를 앱에서 구조화한 PDF</div>
  <div class="meta"><table><tbody>
    <tr><th>사건번호</th><td>${esc(mng.userCsNo || meta.caseNumber || '')}</td></tr>
    <tr><th>법원코드</th><td>${esc(mng.cortOfcCd || '')}</td></tr>
    <tr><th>조사일시</th><td>${esc((mng.exmnDtDts || '').trim())}</td></tr>
    <tr><th>현황조사서 송부일</th><td>${esc(fmtYmd(mng.exmndcSndngYmd))}</td></tr>
    <tr><th>현황조사서 접수일</th><td>${esc(fmtYmd(mng.exmndcRcptnYmd))}</td></tr>
  </tbody></table></div>
  <h2>호실별 임대차·점유 현황 (${units.length}개)</h2>
  ${unitsHtml || '<p>호실 정보 없음</p>'}
  <div class="footer">
    본 PDF는 법원경매정보의 현황조사 JSON 데이터를 차근경매가 구조화해 생성한 스냅샷입니다.<br />
    원본 현황조사서는 법원경매 웹사이트에서만 열람 가능하며, 공식 PDF 발급본이 아닙니다.<br />
    생성: ${new Date().toISOString()}
  </div>
</body></html>`;
}

async function main() {
  console.log(`현황조사서 PDF 생성 (upload=${DO_UPLOAD}, limit=${LIMIT})`);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction')
    .eq('category', 'real_estate')
    .not('raw_data->_detail->curstExmn->dlt_ordTsRlet', 'is', null)
    .order('auction_date', { ascending: false, nullsFirst: false })
    .limit(LIMIT * 3);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }

  // 사건 단위 dedup (같은 boCd|saNo 는 한 번만 생성)
  const seen = new Set();
  const targets = [];
  for (const it of items) {
    const key = `${it.raw_data?.boCd}|${it.raw_data?.saNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 이미 PDF 있으면 skip
    if (it.raw_data?._detail?.curstExmnPdf?.path) continue;
    targets.push(it);
    if (targets.length >= LIMIT) break;
  }
  console.log(`대상 ${targets.length}건`);
  if (!targets.length) { console.log('생성 대상 없음'); return; }

  const browser = await chromium.launch({ headless: true });
  let ok = 0, fail = 0, totalKB = 0;

  try {
    for (const it of targets) {
      const raw = it.raw_data ?? {};
      const curst = raw._detail?.curstExmn ?? {};
      const { boCd, saNo } = raw;
      console.log(`\n[${ok + fail + 1}/${targets.length}] ${it.case_number}`);
      try {
        const html = buildHtml(curst, { caseNumber: it.case_number });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        await page.emulateMedia({ media: 'print' });
        const buf = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
        });
        await page.close();

        const storagePath = `${boCd}/${saNo}/curst-exmn.pdf`;
        if (DO_UPLOAD) {
          const { error: upErr } = await supabase.storage.from('auction-pdfs').upload(storagePath, buf, {
            contentType: 'application/pdf', upsert: true,
          });
          if (upErr) throw new Error('upload: ' + upErr.message);

          // 같은 boCd|saNo row 전부 업데이트
          const { data: rows } = await supabase.from('auction_items')
            .select('id, raw_data')
            .eq('source', 'court_auction')
            .eq('raw_data->>boCd', boCd)
            .eq('raw_data->>saNo', String(saNo));
          for (const row of rows ?? []) {
            const newRaw = {
              ...row.raw_data,
              _detail: {
                ...(row.raw_data?._detail ?? {}),
                curstExmnPdf: {
                  path: storagePath,
                  bytes: buf.length,
                  generated_at: new Date().toISOString(),
                  kind: 'json-rendered',
                },
              },
            };
            await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', row.id);
          }
        }

        const kb = Math.round(buf.length / 1024);
        totalKB += kb;
        ok++;
        console.log(`  OK ${kb}KB · ${storagePath}`);
      } catch (e) {
        fail++;
        console.log(`  FAIL: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}, 총 ${totalKB}KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
