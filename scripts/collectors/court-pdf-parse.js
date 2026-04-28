// 법원경매 4종 PDF (매각물건명세서·현황조사서·감정평가서·사건상세조회) 텍스트 추출·파싱
//
// 전제: court-pdf-capture.js 로 PDF 가 auction-pdfs 버킷에 저장되어 있음.
// 이 스크립트는 Storage 에서 PDF 를 내려받아 pdf-parse 로 텍스트 추출 →
// 당사자·점유자·등기권리·감정요약 정규식 파싱 →
// raw_data._detail.pdf_text (전문) + parsed_notice (구조화) 저장.
//
// 실행:
//   node collectors/court-pdf-parse.js --limit 5               (미리보기)
//   node collectors/court-pdf-parse.js --upsert --limit 5      (DB 저장)
//   node collectors/court-pdf-parse.js --upsert --case 2024타경143316

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
// pdf-parse v2 는 ESM default import 가 object 를 줄 수도 있어 호환 처리
import pdfParseModule from 'pdf-parse';
const pdfParse = pdfParseModule.default ?? pdfParseModule;

const args = process.argv.slice(2);
const DO_UPSERT = args.includes('--upsert');
const LIMIT = parseInt(args[args.indexOf('--limit') + 1] ?? '10', 10) || 10;
const CASE_NUMBER = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;

const DOC_TYPES = ['매각물건명세서', '현황조사서', '감정평가서', '사건상세조회'];

// ===== 텍스트 정리 =====
function cleanText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ===== 매각물건명세서 파싱 =====
// 표 구조 (법원 공통): 부동산표시 / 최선순위설정 / 배당요구종기일 /
//   점유자(임차인) 표 / 등기 권리(소멸·인수) / 지상권 / 비고
function parseNotice(text) {
  const out = {
    채권자: null, 채무자: null, 소유자: null,
    말소기준: null, 배당요구종기: null,
    임차인: [],       // 점유자 표
    등기권리: [],     // 전체 권리 라인
    토지등기: [],     // "토지"가 맥락에 있는 권리
    건물등기: [],     // "건물"이 맥락에 있는 권리
    소멸안됨: [],     // 매각으로 소멸되지 않는 등기
    지상권: null,    // 매각에 따라 설정된 것으로 보는 지상권
    주의사항: [],    // 일괄매각·제시외건물 등 자동 감지
    특기사항: null,  // 비고란 전문
  };
  if (!text) return out;

  // 사건 헤더 단서로 당사자 추출
  const creditor = text.match(/채권자\s*[::]\s*([^\n]+)/);
  const debtor = text.match(/채무자\s*[::]\s*([^\n]+)/);
  const owner = text.match(/소유자\s*[::]\s*([^\n]+)/);
  if (creditor) out.채권자 = creditor[1].trim().slice(0, 100);
  if (debtor) out.채무자 = debtor[1].trim().slice(0, 100);
  if (owner) out.소유자 = owner[1].trim().slice(0, 100);

  // 최선순위 설정 (말소기준권리)
  const base = text.match(/최선순위\s*설정[^\n]*?[::]?\s*([^\n]+)/);
  if (base) out.말소기준 = base[1].trim().slice(0, 200);

  // 배당요구종기일
  const dstrt = text.match(/배당요구\s*종기[일]?\s*[::]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
  if (dstrt) out.배당요구종기 = dstrt[1];

  // 점유자 표: 성명 / 전입일 / 확정일 / 배당요구 / 보증금
  const occupantMatches = text.matchAll(
    /([가-힣]{2,5})\s+(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})[^\n]*?(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})?[^\n]*?(배당요구)?/g,
  );
  for (const m of occupantMatches) {
    const name = m[1];
    if (/[가-힣]{2,5}/.test(name) && !/법원|지원|경매|채권|채무|소유|주식|회사/.test(name)) {
      out.임차인.push({
        성명: name,
        전입일: m[2] || null,
        확정일: m[3] || null,
        배당요구: !!m[4],
      });
      if (out.임차인.length >= 20) break;
    }
  }

  // 등기 권리 — 라인 단위. 토지·건물 맥락 감지.
  const lines = text.split('\n');
  const rightKw = /(근저당|저당권|가압류|가처분|전세권|지상권|지역권|임차권|유치권|경매개시|소유권|압류)/;
  let ctxLandBld = null; // 'land' | 'bld' | null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/토지\s*등기|토지부분/.test(l)) ctxLandBld = 'land';
    else if (/건물\s*등기|건물부분|집합건물/.test(l)) ctxLandBld = 'bld';
    if (!rightKw.test(l)) continue;
    const dateM = l.match(/(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
    const amountM = l.match(/([\d,]{5,})\s*원/);
    const typeM = l.match(rightKw);
    const holderM = l.match(/(?:권리자|명의|권리자명)\s*[::]?\s*([가-힣A-Za-z0-9().\s]{2,30})/);
    const rec = {
      종류: typeM ? typeM[1] : null,
      일자: dateM ? dateM[1] : null,
      권리자: holderM ? holderM[1].trim() : null,
      금액: amountM ? amountM[1].replace(/,/g, '') : null,
      원문: l.trim().slice(0, 200),
    };
    out.등기권리.push(rec);
    if (ctxLandBld === 'land') out.토지등기.push(rec);
    else if (ctxLandBld === 'bld') out.건물등기.push(rec);
    if (out.등기권리.length >= 60) break;
  }

  // 매각으로 소멸되지 아니하는 등기부권리
  const nonExt = text.match(/매각으로\s*그?\s*효력이\s*소멸되지\s*아[니]?한?\s*[것등]?[^\n]*\n([\s\S]{0,600}?)(?=\n{2,}|매각에\s*따라|비\s*고|작성|담임|$)/);
  if (nonExt) {
    const block = nonExt[1];
    const items = block.split(/\n/).map(s => s.trim()).filter(s => s && !/^(해당\s*없음|없음|-)$/.test(s));
    out.소멸안됨 = items.slice(0, 20);
  }

  // 매각에 따라 설정된 것으로 보는 지상권
  const gs = text.match(/매각에\s*따라\s*설정된\s*것으로\s*보는\s*지상권[^\n]*\n([\s\S]{0,400}?)(?=\n{2,}|비\s*고|작성|담임|$)/);
  if (gs) {
    const t = gs[1].trim();
    if (t && !/^(해당\s*없음|없음|-)$/.test(t)) out.지상권 = t.slice(0, 400);
  }

  // 주의사항 자동 감지 (PDF 전문에서 키워드 감지)
  const warnings = [];
  if (/일괄\s*매각/.test(text)) warnings.push('일괄매각');
  if (/제시\s*외\s*건물/.test(text)) warnings.push('제시외 건물 포함');
  if (/유치권/.test(text)) warnings.push('유치권 신고');
  if (/법정지상권/.test(text)) warnings.push('법정지상권 성립 여지');
  if (/분묘/.test(text)) warnings.push('분묘기지권');
  if (/지분\s*매각/.test(text)) warnings.push('지분매각');
  if (/대항력/.test(text)) warnings.push('대항력 있는 임차인');
  if (/농지취득자격/.test(text)) warnings.push('농지취득자격증명 필요');
  if (/위반\s*건축물/.test(text)) warnings.push('위반건축물');
  if (/토지별도등기/.test(text)) warnings.push('토지별도등기');
  out.주의사항 = warnings;

  // 비고란 전문
  const rmk = text.match(/비\s*고[^\n]*\n([\s\S]{0,800}?)(?=\n{2,}|작성|담임|$)/);
  if (rmk) out.특기사항 = rmk[1].trim();

  return out;
}

// ===== 현황조사서 파싱 =====
function parseCurst(text) {
  const out = { 조사일: null, 점유관계: null, 임차관계: null };
  if (!text) return out;
  const date = text.match(/조사일[시]?\s*[::]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
  if (date) out.조사일 = date[1];
  const occ = text.match(/점유관계[^\n]*\n([\s\S]{0,600}?)(?=\n{2,}|임차|관계인|$)/);
  if (occ) out.점유관계 = occ[1].trim();
  const lease = text.match(/임차관계[^\n]*\n([\s\S]{0,800}?)(?=\n{2,}|조사|$)/);
  if (lease) out.임차관계 = lease[1].trim();
  return out;
}

// ===== 감정평가서 파싱 =====
function parseAeeWevl(text) {
  const out = { 감정사: null, 감정평가액: null, 가격시점: null, 감정일: null };
  if (!text) return out;
  const m1 = text.match(/감정평가사[^\n]*?([가-힣]{2,10})/);
  if (m1) out.감정사 = m1[1];
  const m2 = text.match(/감정평가액[\s\S]{0,50}?([\d,]{6,})\s*원/);
  if (m2) out.감정평가액 = m2[1].replace(/,/g, '');
  const m3 = text.match(/가격시점\s*[::]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
  if (m3) out.가격시점 = m3[1];
  const m4 = text.match(/(?:조사|실사|감정)일\s*[::]?\s*(\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/);
  if (m4) out.감정일 = m4[1];
  return out;
}

// ===== 메인 =====
async function processOne(supabase, item) {
  const raw = item.raw_data ?? {};
  const pdfs = raw._detail?.pdfs ?? {};
  const result = { pdf_text: {}, parsed_notice: null, parsed_curst: null, parsed_aeewevl: null };

  for (const docType of DOC_TYPES) {
    const meta = pdfs[docType];
    if (!meta?.path) continue;
    try {
      const { data: file, error } = await supabase.storage.from('auction-pdfs').download(meta.path);
      if (error) { console.log(`  ${docType} 다운로드 실패: ${error.message}`); continue; }
      const buf = Buffer.from(await file.arrayBuffer());
      const parsed = await pdfParse(buf);
      const text = cleanText(parsed.text);
      result.pdf_text[docType] = text.slice(0, 60000);
      console.log(`  ${docType} ${Math.round(buf.length / 1024)}KB · ${text.length}자`);

      if (docType === '매각물건명세서') result.parsed_notice = parseNotice(text);
      if (docType === '현황조사서') result.parsed_curst = parseCurst(text);
      if (docType === '감정평가서') result.parsed_aeewevl = parseAeeWevl(text);
    } catch (e) {
      console.log(`  ${docType} 파싱 에러: ${e.message.split('\n')[0]}`);
    }
  }

  if (Object.keys(result.pdf_text).length === 0) return { ok: false, reason: 'no-pdf' };

  if (DO_UPSERT) {
    const newRaw = { ...raw };
    newRaw._detail = { ...(newRaw._detail ?? {}) };
    newRaw._detail.pdf_text = result.pdf_text;
    if (result.parsed_notice) newRaw._detail.parsed_notice = result.parsed_notice;
    if (result.parsed_curst) newRaw._detail.parsed_curst = result.parsed_curst;
    if (result.parsed_aeewevl) newRaw._detail.parsed_aeewevl = result.parsed_aeewevl;
    newRaw._detail.parsed_at = new Date().toISOString();
    const { error } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', item.id);
    if (error) return { ok: false, reason: 'db-' + error.message };
  }
  return { ok: true, docs: Object.keys(result.pdf_text) };
}

async function main() {
  console.log(`Court PDF Parse (upsert=${DO_UPSERT}, limit=${LIMIT})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락'); process.exit(1); }
  const supabase = createClient(url, key);

  let q = supabase
    .from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction')
    .eq('category', 'real_estate')
    .not('raw_data->_detail->pdfs', 'is', null)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }

  // 이미 파싱된 것 제외 (parsed_at 존재 & PDF 캡처 이후)
  const targets = items.filter(it => {
    const d = it.raw_data?._detail ?? {};
    return d.pdfs && Object.keys(d.pdfs).length > 0;
  });
  console.log(`대상 ${targets.length}건`);
  if (!targets.length) return;

  let ok = 0, fail = 0;
  for (const it of targets) {
    console.log(`\n[${ok + fail + 1}/${targets.length}] ${it.case_number}`);
    try {
      const r = await processOne(supabase, it);
      if (r.ok) { console.log(`  OK [${r.docs.join(', ')}]`); ok++; }
      else { console.log(`  SKIP: ${r.reason}`); fail++; }
    } catch (e) { console.log(`  ERR: ${e.message.split('\n')[0]}`); fail++; }
  }

  console.log(`\n완료: 성공 ${ok}, 실패/스킵 ${fail}`);
  if (!DO_UPSERT) console.log('(미리보기 - --upsert 플래그로 DB 저장)');
}

main().catch(e => { console.error(e); process.exit(1); });
