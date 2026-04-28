// 법원경매 전체 파이프라인 래퍼 — 단일 사건 또는 누락 건 일괄 처리
// 단계:
//   1. court-detail-collect    (thumbnail_url IS NULL — 법원 호출)
//   2. court-photo-rehost       (사진 URL이 법원 404 — 법원 호출)
//   3. court-spcfc-fetch        (매각물건명세서 PDF — 법원 호출, Playwright)
//   4. court-curst-pdf-generate (현황조사서 JSON→PDF 렌더 — 법원 호출 0)
//   5. court-docs-fetch         (감정평가서 PDF, kapanet 직링크 — kapanet 호출)
//   6. court-rgst-extract       (매각물건명세서 PDF→rgstSummary 추출 — 법원 호출 0)
//   7. court-docs-snap          (문건/송달내역 캡처 — 법원 호출)
//
// anti-block: 법원 호출 단계 간 15~20초 랜덤 딜레이. 3연속 실패 시 중단.
//
// 실행:
//   node collectors/court-full-pipeline.js --case 2024타경63998           (단일 사건)
//   node collectors/court-full-pipeline.js --limit 5                      (누락 건 최대 5)
//   node collectors/court-full-pipeline.js --limit 5 --skip-detail        (이미 상세는 수집된 건 대상)
//   node collectors/court-full-pipeline.js --case X --skip-spcfc          (매각일 임박 아닌 건: spcfc 건너뛰기)

import 'dotenv/config';
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const CASE_NUMBER = argOf('--case', null);
const LIMIT = parseInt(argOf('--limit', '3'), 10) || 3;
const SKIP = {
  detail: args.includes('--skip-detail'),
  rehost: args.includes('--skip-rehost'),
  spcfc: args.includes('--skip-spcfc'),
  curstPdf: args.includes('--skip-curst-pdf'),
  aeeFetch: args.includes('--skip-aee-fetch'),
  rgstExtract: args.includes('--skip-rgst-extract'),
  docsSnap: args.includes('--skip-docs-snap'),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function runScript(scriptName, scriptArgs) {
  return new Promise((resolve) => {
    const proc = spawn('node', [`collectors/${scriptName}`, ...scriptArgs], { stdio: 'inherit' });
    proc.on('close', code => resolve(code ?? 1));
    proc.on('error', () => resolve(1));
  });
}

async function pickCaseNumbers(supabase) {
  if (CASE_NUMBER) return [CASE_NUMBER];
  // 매각일 90일 이내 롤링 윈도우 + _detail 미수집 건만, 임박순 (가장 가까운 매각일 우선).
  // 과거 thumbnail=null 일감처리 → 매각 끝난 사건 PDF 시도 → 전부 실패 버그 픽스.
  const today = new Date().toISOString();
  const window90 = new Date(); window90.setDate(window90.getDate() + 90);
  const { data } = await supabase
    .from('auction_items')
    .select('case_number, auction_date')
    .eq('source', 'court_auction')
    .eq('category', 'real_estate')
    .gte('auction_date', today)
    .lte('auction_date', window90.toISOString())
    .is('raw_data->_detail', null)
    .order('auction_date', { ascending: true, nullsFirst: false })
    .limit(LIMIT * 3);
  const seen = new Set();
  const out = [];
  for (const d of data ?? []) {
    if (seen.has(d.case_number)) continue;
    seen.add(d.case_number);
    out.push(d.case_number);
    if (out.length >= LIMIT) break;
  }
  return out;
}

async function main() {
  console.log(`[pipeline] 시작 (case=${CASE_NUMBER ?? '(auto)'}, limit=${LIMIT})`);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const cases = await pickCaseNumbers(supabase);
  if (!cases.length) { console.log('처리할 사건 없음'); return; }
  console.log(`대상 사건 ${cases.length}건: ${cases.join(', ')}`);

  const summary = { success: [], partial: [], fail: [] };

  for (const cn of cases) {
    console.log(`\n========= ${cn} =========`);
    const stages = [];

    // Stage 1: 상세 수집
    if (!SKIP.detail) {
      console.log('\n[1/7] 상세 수집');
      const c = await runScript('court-detail-collect.js', ['--upsert', '--case', cn]);
      stages.push({ stage: 'detail', ok: c === 0 });
      if (c === 0) await sleep(rand(15000, 20000));
    }

    // Stage 2: 사진 rehost
    if (!SKIP.rehost) {
      console.log('\n[2/7] 사진 rehost');
      const c = await runScript('court-photo-rehost.js', ['--upload', '--case', cn]);
      stages.push({ stage: 'rehost', ok: c === 0 });
      if (c === 0) await sleep(rand(15000, 20000));
    }

    // Stage 3: 매각물건명세서 PDF (매각일 임박 안 한 건은 실패 정상)
    if (!SKIP.spcfc) {
      console.log('\n[3/7] 매각물건명세서 PDF');
      const c = await runScript('court-spcfc-fetch.js', ['--upload', '--case', cn]);
      stages.push({ stage: 'spcfc', ok: c === 0 });
      if (c === 0) await sleep(rand(10000, 15000));
    }

    // Stage 4: 현황조사서 PDF 생성 (법원 호출 없음)
    if (!SKIP.curstPdf) {
      console.log('\n[4/7] 현황조사서 PDF 생성');
      const c = await runScript('court-curst-pdf-generate.js', ['--upload', '--case', cn]);
      stages.push({ stage: 'curstPdf', ok: c === 0 });
    }

    // Stage 5: 감정평가서 PDF (kapanet 직링크 — 법원 외부 호출)
    if (!SKIP.aeeFetch) {
      console.log('\n[5/7] 감정평가서 PDF (kapanet)');
      const c = await runScript('court-docs-fetch.js', ['--upload', '--case', cn]);
      stages.push({ stage: 'aeeFetch', ok: c === 0 });
      if (c === 0) await sleep(rand(10000, 15000));
    }

    // Stage 6: rgstSummary 파싱 (매각물건명세서 PDF 기반 — 법원 호출 0)
    if (!SKIP.rgstExtract) {
      console.log('\n[6/7] rgstSummary 파싱');
      const c = await runScript('court-rgst-extract.js', ['--upload', '--case', cn]);
      stages.push({ stage: 'rgstExtract', ok: c === 0 });
    }

    // Stage 7: 문건/송달 스냅샷 (법원 호출, Playwright)
    if (!SKIP.docsSnap) {
      console.log('\n[7/7] 문건/송달 스냅샷');
      const c = await runScript('court-docs-snap.js', ['--upload', '--case', cn]);
      stages.push({ stage: 'docsSnap', ok: c === 0 });
      if (c === 0) await sleep(rand(10000, 15000));
    }

    const okCount = stages.filter(s => s.ok).length;
    const failed = stages.filter(s => !s.ok).map(s => s.stage);
    if (okCount === stages.length) summary.success.push(cn);
    else if (okCount > 0) summary.partial.push({ cn, failed });
    else summary.fail.push(cn);
  }

  console.log('\n========= 전체 요약 =========');
  console.log(`완전 성공: ${summary.success.length}건`);
  if (summary.success.length) console.log('  ', summary.success.join(', '));
  console.log(`부분 성공: ${summary.partial.length}건`);
  for (const p of summary.partial) console.log(`   ${p.cn} — 실패: ${p.failed.join(',')}`);
  console.log(`전체 실패: ${summary.fail.length}건`);
  if (summary.fail.length) console.log('  ', summary.fail.join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
