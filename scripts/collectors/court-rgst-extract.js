// 매각물건명세서 PDF → 등기 요약 파싱 → raw_data._detail.rgstSummary 저장
//
// 매각물건명세서가 법원이 무료 공개하는 "등기 요약" 원천. pdf-parse 로 추출.
// 6항목 분석:
//   1. 말소기준권리 (seniorRight)
//   2. 임차인 권리 (occupants[].hasOpposability/hasPriority/assumedAmount)
//   3. 인수 특수권리 (surviveRights.tags)
//   4. 점유 상태 (occupants[].kind)
//   5. 채권 총액 — 등기부등본 필요, 매각물건명세서엔 없음 (사용자 PDF 업로드 흐름)
//   6. 위반건축물·대지권 미등기 (remarks.flags)
//
// 저장 구조:
//   seniorRight:   { date, kind } — 말소기준권리
//   bngDemandDue:  배당요구종기 (YYYY-MM-DD)
//   surviveRights: { text, has, tags: ['유치권','법정지상권',...] }
//   surfaceRight:  { text, has } — 매각으로 설정된 지상권 개요
//   remarks:       { text, flags: { illegalBuilding, noLandRight, ... } }
//   occupants:     [{ name, part, kind, moveInDate, confirmedDate, deposit,
//                     monthlyRent, bngDemand, hasOpposability, hasPriority, raw }]
//   analysis:      { tenantOpposable, totalAssumedDeposit, hasSpecialRights, riskLevel }
//   source:        { kind, pdf_path, parsed_at }

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PDFParse } from 'pdf-parse';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '20'), 10) || 20;
const CASE_NUMBER = argOf('--case', null);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cleanWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function toIsoDate(y, m, d) {
  if (!y || !m || !d) return null;
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

// 한국식 금액 → 숫자 (예: "1억2천만원", "150,000,000")
function parseAmount(s) {
  if (!s || /미상|불명|없음|해당\s*없음/.test(s)) return null;
  const t = String(s).replace(/[,\s원]/g, '');
  let total = 0;
  const eok = t.match(/(\d+)억/);     if (eok) total += parseInt(eok[1]) * 1e8;
  const ch  = t.match(/(\d+)천만/);   if (ch)  total += parseInt(ch[1])  * 1e7;
  const bm  = t.match(/(\d+)백만/);   if (bm)  total += parseInt(bm[1])  * 1e6;
  const mm  = t.match(/(\d+)만/);     if (mm)  total += parseInt(mm[1])  * 1e4;
  if (total > 0) return total;
  const pure = t.match(/^\d{4,}/);
  return pure ? parseInt(pure[0]) : null;
}

// 인수 특수권리 키워드 → 자동 분류
const SURVIVE_TAGS = [
  { tag: '유치권', re: /유치권/ },
  { tag: '법정지상권', re: /법정지상권|관습\s*지상권/ },
  { tag: '분묘기지권', re: /분묘\s*기지권|분묘/ },
  { tag: '선순위전세권', re: /선순위\s*전세권|전세권/ },
  { tag: '가등기', re: /(?:소유권|이전|담보)?\s*가등기/ },
  { tag: '가처분', re: /가처분/ },
  { tag: '지상권', re: /(?<!법정\s*)지상권/ },
  { tag: '대지권미등기', re: /대지권\s*미등기/ },
];

function classifySurvive(text) {
  const t = String(text || '');
  if (!t || /^없음$/.test(t.trim())) return { text: t.trim(), has: false, tags: [] };
  const tags = [];
  for (const { tag, re } of SURVIVE_TAGS) if (re.test(t)) tags.push(tag);
  return { text: t.trim(), has: true, tags };
}

function classifyRemarks(text) {
  const t = String(text || '');
  return {
    text: t.trim(),
    flags: {
      illegalBuilding: /위반\s*건축물/.test(t),
      noLandRight: /대지권\s*미등기|대지권\s*없음/.test(t),
      cosmeticChange: /증축|개축|용도\s*변경/.test(t),
      shareSale: /지분\s*매각|공유\s*지분/.test(t),
      tenantTakeover: /임차인.*인수|보증금.*인수/.test(t),
    },
  };
}

// 점유자 raw 텍스트에서 보증금·차임·확정일자·배당요구 추출
function enrichOccupant(o) {
  const raw = String(o.raw || '');
  // 날짜 후보 모두 추출 (전입·확정 후보)
  const dates = [];
  const re = /(\d{4})[\.\-](\d{1,2})[\.\-](\d{1,2})/g;
  let m;
  while ((m = re.exec(raw)) !== null) dates.push(toIsoDate(m[1], m[2], m[3]));
  // 첫 날짜 = 전입(이미 추출되어 있으면 유지), 두 번째 = 확정일자 후보
  const moveInDate = o.moveInDate ?? dates[0] ?? null;
  const confirmedDate = dates.find(d => d && d !== moveInDate) ?? null;
  // 보증금 후보: "보 100,000,000" "보증금 1억" 등
  const dep = raw.match(/보(?:증금)?\s*[:=]?\s*([\d,]+(?:억|천만|백만|만)?[\d,]*)/);
  const deposit = dep ? parseAmount(dep[1]) : null;
  // 월차임: "차 500,000" "차임 50만"
  const ch = raw.match(/차\s*(?:임)?\s*[:=]?\s*([\d,]+(?:억|천만|백만|만)?[\d,]*)/);
  const monthlyRent = ch ? parseAmount(ch[1]) : null;
  // 배당요구
  const bngDemand = /배당\s*요구\s*있음|배당\s*요구\s*함/.test(raw) ? '있음'
                  : /배당\s*요구\s*없음|배당\s*요구\s*안함/.test(raw) ? '없음' : null;
  return { ...o, moveInDate, confirmedDate, deposit, monthlyRent, bngDemand };
}

function judgeOpposability(occ, seniorDate) {
  if (!seniorDate || !occ.moveInDate) {
    return { ...occ, hasOpposability: null, hasPriority: null, assumedAmount: null };
  }
  // 대항력: 전입일이 말소기준일보다 빠르면 ✓ (전입일 다음날 0시부터 효력이지만 1차는 비교만)
  const hasOpposability = occ.moveInDate < seniorDate;
  // 우선변제권: 확정일자 < 말소기준일 && 배당요구 있음
  const hasPriority = occ.confirmedDate && occ.confirmedDate < seniorDate && occ.bngDemand === '있음';
  // 인수금액 추정: 대항력 있고 우선변제권 없거나 배당받지 못할 가능성
  const assumedAmount = hasOpposability && !hasPriority ? (occ.deposit ?? null) : null;
  return { ...occ, hasOpposability, hasPriority, assumedAmount };
}

function parseSpcfc(text) {
  const t = text.replace(/[ \t]+/g, ' ');
  const res = {
    seniorRight: null,
    bngDemandDue: null,
    surviveRights: { text: '없음', has: false, tags: [] },
    surfaceRight: { text: '없음', has: false },
    remarks: { text: '', flags: {} },
    occupants: [],
    analysis: null,
  };

  // 1. 최선순위 설정 (말소기준권리)
  // 단순 형식: "최선순위 설정 2024.01.05. 근저당권"
  let senior = t.match(/최선순위\s*\n?\s*설정\s*\n?\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*([가-힣]+)?/);
  if (senior) {
    res.seniorRight = {
      date: toIsoDate(senior[1], senior[2], senior[3]),
      kind: senior[4] || null,
    };
  } else {
    // 다중 필지/건물 형식: "최선순위 설정 [토지] 381-37: 2019.07.01. 근저당권 [건물] 2021.02.26. 근저당권 배당요구종기..."
    // "배당요구종기" 직전까지의 블록에서 모든 일자+권리 추출 후 가장 빠른 일자를 말소기준으로
    const blockMatch = t.match(/최선순위\s*\n?\s*설정([\s\S]+?)(?:배당요구종기|부동산의\s*점유자)/);
    if (blockMatch) {
      const dateRe = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*([가-힣]+)?/g;
      const candidates = [];
      let m;
      while ((m = dateRe.exec(blockMatch[1]))) {
        const isoDate = toIsoDate(m[1], m[2], m[3]);
        if (isoDate) candidates.push({ date: isoDate, kind: m[4] || null });
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.date.localeCompare(b.date));
        // raw 텍스트(브래킷 → 괄호 변환, 공백 정리)
        const rawText = blockMatch[1]
          .replace(/\[/g, '(').replace(/\]/g, ')')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
        res.seniorRight = {
          date: candidates[0].date,
          kind: candidates[0].kind,
          raw: rawText,
          parts: candidates, // 모든 등기 일자 후보
        };
      }
    }
  }
  const due = t.match(/배당요구종기\s*\n?\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (due) res.bngDemandDue = toIsoDate(due[1], due[2], due[3]);

  // 3, 6. 인수권리 / 비고란 파싱
  const hdrPattern = /등기된\s*부동산에\s*관한\s*권리\s*또는\s*가처분으로\s*매각으로\s*그\s*효력이\s*소멸되지\s*아니하는\s*것\s*\n?\s*매각에\s*따라\s*설정된\s*것으로\s*보는\s*지상권의\s*개요\s*\n?\s*비고란\s*\n/;
  const hdrMatch = text.match(hdrPattern);
  if (hdrMatch) {
    const after = text.slice(hdrMatch.index + hdrMatch[0].length);
    const endIdx = after.search(/\n\s*사건\s+\d{4}타경/);
    const valuesBlock = (endIdx >= 0 ? after.slice(0, endIdx) : after).trim();
    const parts = valuesBlock.split(/\n(?=\S)/).map(s => cleanWs(s)).filter(Boolean);
    let surviveText = '없음', surfaceText = '없음', remarksText = '';
    if (parts.length === 1) {
      remarksText = parts[0];
    } else if (parts.length === 2) {
      surviveText = parts[0];
      remarksText = parts[1];
    } else if (parts.length >= 3) {
      surviveText = parts[0];
      surfaceText = parts[1];
      remarksText = parts.slice(2).join(' ');
    }
    res.surviveRights = classifySurvive(surviveText);
    res.surfaceRight = { text: surfaceText.trim(), has: !/^없음$/.test(surfaceText.trim()) };
    res.remarks = classifyRemarks(remarksText);
  }

  // 2, 4. 점유자 테이블
  const occHdr = text.match(/점유자\s*\n?\s*성\s*명[\s\S]*?배당\s*요구여부[\s\S]*?\n/);
  if (occHdr) {
    const after = text.slice(occHdr.index + occHdr[0].length);
    const endIdx = after.search(/개인정보유출주의|\n\s*--\s*\d/);
    const occBlock = (endIdx >= 0 ? after.slice(0, endIdx) : after).trim();
    const lines = occBlock.split(/\n/).map(s => s.trim()).filter(Boolean);
    let cur = null;
    for (const l of lines) {
      if (/^[가-힣]{2,4}\s/.test(l) || /^[가-힣]{2,4}$/.test(l)) {
        if (cur) res.occupants.push(cur);
        cur = { raw: l };
      } else if (cur) {
        cur.raw += ' ' + l;
      }
    }
    if (cur) res.occupants.push(cur);
    res.occupants = res.occupants.map(o => {
      const raw = o.raw;
      const name = (raw.match(/^([가-힣]{2,4})/) || [])[1] || null;
      const part = (raw.match(/([A-Z]?\d{2,4}호)/) || [])[1] || null;
      const moveIn = (raw.match(/(\d{4})[\.\-](\d{1,2})[\.\-](\d{1,2})/) || []).slice(1);
      const kind = /주거\s*임차인/.test(raw) ? '주거임차인'
                 : /상가\s*임차인/.test(raw) ? '상가임차인'
                 : /임차인/.test(raw) ? '임차인'
                 : /채무자|소유자/.test(raw) ? '채무자' : null;
      const base = {
        name, part, kind,
        moveInDate: moveIn.length === 3 ? toIsoDate(moveIn[0], moveIn[1], moveIn[2]) : null,
        raw,
      };
      const enriched = enrichOccupant(base);
      return judgeOpposability(enriched, res.seniorRight?.date);
    });
  }

  // 종합 분석
  const tenantOpposable = res.occupants.filter(o => o.hasOpposability === true).length;
  const totalAssumedDeposit = res.occupants.reduce((sum, o) =>
    sum + (typeof o.assumedAmount === 'number' ? o.assumedAmount : 0), 0);
  const hasSpecialRights = res.surviveRights.has || res.surviveRights.tags.length > 0;
  const flagSet = Object.entries(res.remarks.flags).filter(([_, v]) => v).map(([k]) => k);
  // 위험도: 인수 권리/대항력 임차인/위반건축물 등 가중
  let risk = 0;
  if (hasSpecialRights) risk += 2;
  if (tenantOpposable > 0) risk += 2;
  if (totalAssumedDeposit > 0) risk += 1;
  if (res.remarks.flags.illegalBuilding) risk += 1;
  if (res.remarks.flags.noLandRight) risk += 2;
  const riskLevel = risk >= 4 ? 'high' : risk >= 2 ? 'mid' : 'low';

  res.analysis = {
    tenantOpposable,
    totalAssumedDeposit: totalAssumedDeposit > 0 ? totalAssumedDeposit : null,
    hasSpecialRights,
    specialRightTags: res.surviveRights.tags,
    flags: flagSet,
    riskLevel,
  };
  return res;
}

async function processOne(item) {
  const pdfMeta = item.raw_data?._detail?.pdfs?.['매각물건명세서']
                ?? item.raw_data?._detail?.dspslGdsSpcfcPdf;
  if (!pdfMeta?.path) return { ok: false, reason: 'no-pdf' };

  const { data: blob, error: dlErr } = await supabase.storage.from('auction-pdfs').download(pdfMeta.path);
  if (dlErr) return { ok: false, reason: 'dl-' + dlErr.message };
  const buf = Buffer.from(await blob.arrayBuffer());

  const parser = new PDFParse({ data: buf });
  const parsed = await parser.getText();
  const summary = parseSpcfc(parsed.text);
  summary.source = { kind: 'dspsl-gds-spcfc', pdf_path: pdfMeta.path, parsed_at: new Date().toISOString() };

  if (DO_UPLOAD) {
    const newRaw = { ...(item.raw_data ?? {}) };
    const existingRgst = newRaw._detail?.rgstSummary ?? {};
    // atAppraisal(임차인) 보존, atSale(매각물건명세서) 자리에 별도 저장
    newRaw._detail = {
      ...(newRaw._detail ?? {}),
      rgstSummary: { ...existingRgst, atSale: summary, ...summary },
    };
    const { error } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', item.id);
    if (error) return { ok: false, reason: 'db-' + error.message };
  }
  return { ok: true, summary };
}

async function main() {
  console.log(`Rgst Extract (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  // 90일 롤링 윈도우
  const todayIso = new Date().toISOString().slice(0, 10);
  const window90 = new Date(); window90.setDate(window90.getDate() + 90);
  const window90Iso = window90.toISOString().slice(0, 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction')
    .gte('auction_date', todayIso)
    .lte('auction_date', window90Iso)
    .limit(LIMIT * 3);
  const FORCE = process.argv.includes('--force');
  if (CASE_NUMBER) {
    q = q.eq('case_number', CASE_NUMBER);
  } else if (FORCE) {
    // 강제 재처리: 매각PDF 있는 모든 매물 (이미 처리된 것도 다시)
    q = q.or('raw_data->_detail->dspslGdsSpcfcPdf.not.is.null,raw_data->_detail->pdfs->매각물건명세서.not.is.null');
  } else {
    // 기본: 매각PDF 있고 atSale 없는 매물
    q = q.or('raw_data->_detail->dspslGdsSpcfcPdf.not.is.null,raw_data->_detail->pdfs->매각물건명세서.not.is.null')
         .is('raw_data->_detail->rgstSummary->atSale', null);
  }
  const { data, error } = await q;
  if (error) { console.error(error); process.exit(1); }
  console.log(`대상 ${data.length}건`);

  let ok = 0, fail = 0;
  for (const it of data) {
    if (ok >= LIMIT) break;
    try {
      const r = await processOne(it);
      if (r.ok) {
        const s = r.summary;
        const a = s.analysis;
        console.log(`\n[OK] ${it.case_number}  risk=${a.riskLevel}`);
        console.log(`  senior: ${s.seniorRight?.date ?? '-'} ${s.seniorRight?.kind ?? ''}`);
        console.log(`  bngDue: ${s.bngDemandDue ?? '-'}`);
        console.log(`  survive: tags=[${s.surviveRights.tags.join(',')}] has=${s.surviveRights.has}`);
        console.log(`  flags: ${a.flags.join(',') || '-'}`);
        console.log(`  occupants: ${s.occupants.length}명, 대항력 ${a.tenantOpposable}, 인수예상 ${a.totalAssumedDeposit ?? '-'}`);
        s.occupants.slice(0, 3).forEach(o =>
          console.log(`    - ${o.name ?? '?'} ${o.kind ?? ''} 전입${o.moveInDate ?? '-'} 확정${o.confirmedDate ?? '-'} 보${o.deposit ?? '-'} 대항력=${o.hasOpposability ?? '?'}`));
        ok++;
      } else if (r.reason === 'no-pdf') {
        // 조용히 스킵
      } else {
        console.log(`\n[SKIP] ${it.case_number} ${r.reason}`); fail++;
      }
    } catch (e) { console.log(`\n[FAIL] ${it.case_number} ${e.message}`); fail++; }
  }
  console.log(`\n완료: ok=${ok} fail=${fail}`);
}
main().catch(e => { console.error(e); process.exit(1); });
