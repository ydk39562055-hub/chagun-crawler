// 차량 매각물건명세서 PDF → 차량 상세 파싱 → raw_data._detail.parsedSpcfc 저장
//
// PDF 구조 (법원경매 매각물건명세서 [자동차]):
//   Page 1: 비고 (연식·연료·주행거리), 최선순위 설정/배당요구종기, 점유자 테이블
//   Page 2: 자동차의 표시 (차명·등록번호·사용본거지·차대번호·원동기·최초등록일·보관장소·보관방법),
//           감정평가액, 회차별 기일/최저매각가격/보증금 테이블
//
// 실행:
//   node collectors/court-vehicle-spcfc-extract.js --case 2025타경73228 --upload
//   node collectors/court-vehicle-spcfc-extract.js --upload --limit 20

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PDFParse } from 'pdf-parse';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '10'), 10) || 10;
const CASE_NUMBER = argOf('--case', null);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cleanWs(s) { return String(s || '').replace(/[ \t\u00a0]+/g, ' ').trim(); }
function toIsoDate(y, m, d) {
  if (!y || !m || !d) return null;
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function parseSpcfcVehicle(text) {
  // PDF 텍스트 내 tab(\t) 문자 정리
  const t = text.replace(/\t+/g, ' ').replace(/ +/g, ' ');

  const res = {
    carName: null,
    licensePlate: null,
    baseAddress: null,
    vin: null,
    engineModel: null,
    firstRegistered: null,
    specMgmtNo: null,
    storagePlace: null,
    storageMethod: null,
    appraisalAmount: null,
    mileage: null,
    mileageText: null,
    fuel: null,
    year: null,
    seniorRight: null,
    bngDemandDue: null,
    auctionSchedule: [], // [{ round, date, minPrice, deposit }]
    occupantsRaw: null,
    remarks: '',
  };

  // 차 명
  const carName = t.match(/차\s*명\s*:\s*([^\n]+)/);
  if (carName) res.carName = cleanWs(carName[1]);
  // 등록번호
  const plate = t.match(/등\s*록\s*번\s*호\s*:\s*([^\n]+)/);
  if (plate) res.licensePlate = cleanWs(plate[1]);
  // 사용 본거지
  const base = t.match(/사용\s*본거지\s*:\s*([^\n]+)/);
  if (base) res.baseAddress = cleanWs(base[1]);
  // 차대번호
  const vin = t.match(/차대번호\s*:\s*([A-Z0-9]+)/);
  if (vin) res.vin = vin[1];
  // 원동기형식
  const eng = t.match(/원동기형식\s*:\s*([^\n]+)/);
  if (eng) res.engineModel = cleanWs(eng[1]);
  // 최초등록일
  const firstReg = t.match(/최초등록일\s*:\s*(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (firstReg) res.firstRegistered = toIsoDate(firstReg[1], firstReg[2], firstReg[3]);
  // 제원관리번호
  const spec = t.match(/제원관리번호\s*:\s*([^\n]+)/);
  if (spec) res.specMgmtNo = cleanWs(spec[1]);
  // 보관장소
  const sp = t.match(/보관장소\s*:\s*([^\n]+)/);
  if (sp) res.storagePlace = cleanWs(sp[1]);
  // 보관방법
  const sm = t.match(/보관방법\s*:\s*([^\n]+)/);
  if (sm) res.storageMethod = cleanWs(sm[1]);

  // 감정평가액
  const ap = t.match(/감정평가액\s*([0-9,]+)/);
  if (ap) res.appraisalAmount = parseInt(ap[1].replace(/,/g, ''), 10);

  // 비고란 내 연식·연료·주행거리
  const yearM = t.match(/연식\s*:\s*(\d{4})년?/);
  if (yearM) res.year = parseInt(yearM[1], 10);
  const fuelM = t.match(/연료\s*:\s*([가-힣A-Za-z]+)/);
  if (fuelM) res.fuel = cleanWs(fuelM[1]);
  const mile = t.match(/주행거리\s*:\s*([^\n]+)/);
  if (mile) {
    res.mileageText = cleanWs(mile[1]);
    const mn = res.mileageText.match(/([\d,]+)\s*km/i);
    if (mn) res.mileage = parseInt(mn[1].replace(/,/g, ''), 10);
  }

  // 최선순위 설정 / 배당요구종기
  // "2017.11.22. 근저당권 배당요구종기 2025. 11. 10."
  const senior = t.match(/설정\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*([가-힣]+)?/);
  if (senior) {
    res.seniorRight = {
      date: toIsoDate(senior[1], senior[2], senior[3]),
      kind: senior[4] || null,
    };
  }
  const due = t.match(/배당요구종기\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (due) res.bngDemandDue = toIsoDate(due[1], due[2], due[3]);

  // 회차별 매각일정: "1회 2026.04.22 30,000,000 3,000,000"
  const schedLines = t.match(/(\d+)회\s+(\d{4})\.(\d{1,2})\.(\d{1,2})\s+([\d,]+)\s+([\d,]+)/g) || [];
  for (const line of schedLines) {
    const m = line.match(/(\d+)회\s+(\d{4})\.(\d{1,2})\.(\d{1,2})\s+([\d,]+)\s+([\d,]+)/);
    if (m) {
      res.auctionSchedule.push({
        round: parseInt(m[1], 10),
        date: toIsoDate(m[2], m[3], m[4]),
        minPrice: parseInt(m[5].replace(/,/g, ''), 10),
        deposit: parseInt(m[6].replace(/,/g, ''), 10),
      });
    }
  }

  // 점유자
  if (/조사된\s*임차내역없음/.test(t)) {
    res.occupantsRaw = '없음';
  }

  return res;
}

async function processOne(item) {
  const pdfMeta = item.raw_data?._detail?.dspslGdsSpcfcPdf;
  if (!pdfMeta?.path) return { ok: false, reason: 'no-pdf' };

  const { data: blob, error: dlErr } = await supabase.storage.from('auction-pdfs').download(pdfMeta.path);
  if (dlErr) return { ok: false, reason: 'dl-' + dlErr.message };
  const buf = Buffer.from(await blob.arrayBuffer());

  const parser = new PDFParse({ data: buf });
  const parsed = await parser.getText();
  const summary = parseSpcfcVehicle(parsed.text);
  summary.source = { kind: 'dspsl-gds-spcfc-vehicle', pdf_path: pdfMeta.path, parsed_at: new Date().toISOString() };

  if (DO_UPLOAD) {
    const newRaw = { ...(item.raw_data ?? {}) };
    // parsedVehicle이 이미 case API에서 채워져 있으면 PDF 파싱 결과로 덮어쓰기/보완
    const prev = newRaw._detail?.parsedVehicle || {};
    newRaw._detail = {
      ...(newRaw._detail ?? {}),
      parsedSpcfc: summary,
      parsedVehicle: {
        ...prev,
        carType: prev.carType || summary.carName,
        vin: summary.vin || prev.vin,
        engineModel: summary.engineModel || prev.engineModel,
        year: summary.year || parseInt(prev.year, 10) || prev.year,
        firstRegistered: summary.firstRegistered || prev.firstRegistered,
        storagePlace: summary.storagePlace || prev.storagePlace,
        storageMethod: summary.storageMethod || prev.storageMethod,
        mileage: summary.mileage,
        fuel: summary.fuel,
        licensePlate: summary.licensePlate,
        baseAddress: summary.baseAddress,
        specMgmtNo: summary.specMgmtNo,
      },
    };
    const { error } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', item.id);
    if (error) return { ok: false, reason: 'db-' + error.message };
  }
  return { ok: true, summary };
}

async function main() {
  console.log(`Vehicle Spcfc Extract (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''})`);
  // 90일 롤링 윈도우
  const todayIso = new Date().toISOString().slice(0, 10);
  const window90 = new Date(); window90.setDate(window90.getDate() + 90);
  const window90Iso = window90.toISOString().slice(0, 10);
  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction').eq('category', 'vehicle')
    .not('raw_data->_detail->dspslGdsSpcfcPdf', 'is', null)
    .gte('auction_date', todayIso)
    .lte('auction_date', window90Iso)
    .limit(LIMIT);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data, error } = await q;
  if (error) { console.error(error); process.exit(1); }
  console.log(`대상 ${data.length}건`);

  let ok = 0, fail = 0;
  for (const it of data) {
    try {
      const r = await processOne(it);
      if (r.ok) {
        const s = r.summary;
        console.log(`\n[OK] ${it.case_number}`);
        console.log(`  차명=${s.carName} 등록번호=${s.licensePlate}`);
        console.log(`  VIN=${s.vin} 원동기=${s.engineModel}`);
        console.log(`  연식=${s.year} 연료=${s.fuel} 주행=${s.mileage}km (${s.mileageText})`);
        console.log(`  감정가=${(s.appraisalAmount || 0).toLocaleString()}원`);
        console.log(`  보관=${s.storagePlace} / ${s.storageMethod}`);
        console.log(`  최선순위=${s.seniorRight?.date} ${s.seniorRight?.kind || ''} / 배당요구종기=${s.bngDemandDue}`);
        console.log(`  매각일정=${s.auctionSchedule.length}회차`);
        s.auctionSchedule.forEach(sc => console.log(`    ${sc.round}회 ${sc.date} 최저=${sc.minPrice.toLocaleString()} 보증=${sc.deposit.toLocaleString()}`));
        ok++;
      } else {
        console.log(`\n[SKIP] ${it.case_number} ${r.reason}`); fail++;
      }
    } catch (e) {
      console.log(`\n[FAIL] ${it.case_number} ${e.message}`);
      fail++;
    }
  }
  console.log(`\n완료: ok=${ok} fail=${fail}`);
}
main().catch(e => { console.error(e); process.exit(1); });
