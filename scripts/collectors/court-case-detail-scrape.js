// 경매사건검색(PGJ159M00) 결과 페이지 스크레이퍼
//
// 목적: 법원 PDF 3종으로 커버되지 않는 사건 전체 정보 수집
//   - 물건상태(매각준비/공고/예정/종결)
//   - 기일정보, 최근입찰결과
//   - 목록내역: 목록번호, 소재지, 등기기록열람 URL, 목록구분, 비고
//   - 당사자내역: 채권자/채무자/가압류권자/임차인 등
//
// 저장: raw_data._detail.caseInfo = { status, schedule, targets, parties, scrapedAt }
//
// 실행:
//   node collectors/court-case-detail-scrape.js --upload --case 2024타경136561
//   node collectors/court-case-detail-scrape.js --upload --limit 3

import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

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

async function scrapeOne(ctx, item) {
  const raw = item.raw_data ?? {};
  const cortNm = raw._detail?.goods?.cortOfcNm || raw._detail?.base?.cortOfcNm;
  const caseYear = String(raw.saNo).slice(0, 4);
  const caseNumMatch = item.case_number?.match(/타경(\d+)/);
  const caseNum = caseNumMatch ? caseNumMatch[1] : String(raw.saNo).slice(-6);

  if (!cortNm) return { ok: false, reason: 'no-cortOfcNm' };

  const page = await ctx.newPage();
  try {
    await page.goto('https://www.courtauction.go.kr/pgj/index.on', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(rand(1500, 2500));
    await page.goto('https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml', { waitUntil: 'networkidle', timeout: 60000 });
    await sleep(rand(2500, 3500));

    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCortOfc', { value: cortNm }).catch(() => {});
    await sleep(300);
    await page.selectOption('#mf_wfm_mainFrame_sbx_auctnCsSrchCsYear', { value: caseYear }).catch(() => {});
    await sleep(300);
    await page.fill('#mf_wfm_mainFrame_ibx_auctnCsSrchCsNo', caseNum);
    await sleep(500);
    await page.click('#mf_wfm_mainFrame_btn_auctnCsSrchBtn');
    await sleep(6000);
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}

    // 사건 기본정보(키-값 쌍)
    const info = await page.evaluate(() => {
      const out = {};
      // th 텍스트 → 인접 td 의 텍스트 매핑
      const rows = document.querySelectorAll('tr');
      rows.forEach(tr => {
        const ths = tr.querySelectorAll('th');
        const tds = tr.querySelectorAll('td');
        if (ths.length && tds.length) {
          for (let i = 0; i < ths.length && i < tds.length; i++) {
            const k = (ths[i].textContent || '').trim();
            const v = (tds[i].textContent || '').trim().replace(/\s+/g, ' ');
            if (k && v && k.length < 30 && !out[k]) out[k] = v;
          }
        }
      });
      return out;
    });

    // 목록내역 테이블
    const targets = await page.evaluate(() => {
      const out = [];
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const hdrs = Array.from(t.querySelectorAll('thead th, thead td')).map(h => (h.textContent || '').trim());
        const hasMokrok = hdrs.some(h => h.includes('목록번호')) && hdrs.some(h => h.includes('소재지'));
        if (!hasMokrok) continue;
        const rows = t.querySelectorAll('tbody tr');
        rows.forEach(r => {
          const cells = Array.from(r.querySelectorAll('td')).map(c => (c.textContent || '').trim().replace(/\s+/g, ' '));
          if (cells.length >= 2 && cells[0]) {
            // 등기기록 열람 링크 URL
            const link = r.querySelector('a[href], [onclick]');
            const href = link?.href || '';
            const onclick = link?.getAttribute?.('onclick') || '';
            out.push({
              no: cells[0],
              address: cells[1] || '',
              registryLink: href,
              registryOnclick: onclick.slice(0, 120),
              category: cells[3] || cells[2] || '',
              note: cells[4] || '',
            });
          }
        });
        break;
      }
      return out;
    });

    // 당사자내역 테이블 (채권자, 채무자 등)
    const parties = await page.evaluate(() => {
      const out = [];
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const hdrs = Array.from(t.querySelectorAll('thead th, thead td')).map(h => (h.textContent || '').trim());
        const hasDngsja = hdrs.some(h => h.includes('당사자구분'));
        if (!hasDngsja) continue;
        const rows = t.querySelectorAll('tbody tr');
        rows.forEach(r => {
          const cells = Array.from(r.querySelectorAll('td')).map(c => (c.textContent || '').trim().replace(/\s+/g, ' '));
          // 당사자구분 | 당사자명 | 당사자구분 | 당사자명 (2쌍/행)
          if (cells.length >= 2 && cells[0]) out.push({ role: cells[0], name: cells[1] });
          if (cells.length >= 4 && cells[2]) out.push({ role: cells[2], name: cells[3] });
        });
        break;
      }
      return out;
    });

    return {
      ok: true,
      data: {
        status: info['물건상태'] || info['사건상태'] || null,
        schedule: info['기일정보'] || null,
        recentBid: info['최근입찰결과'] || null,
        endTerm: info['배당요구종기'] || null,
        receivedAt: info['사건접수'] || null,
        claimAmount: info['청구금액'] || null,
        rawInfo: info,
        targets,
        parties,
        scrapedAt: new Date().toISOString(),
      },
    };
  } finally {
    await page.close();
  }
}

async function main() {
  console.log(`Court Case Detail Scrape (upload=${DO_UPLOAD}, limit=${LIMIT})`);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction').eq('category', 'real_estate')
    .not('raw_data->_detail', 'is', null)
    .limit(LIMIT * 2);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  const { data: items, error } = await q;
  if (error) { console.error(error.message); process.exit(1); }

  const targets = items.filter(it => !it.raw_data?._detail?.caseInfo).slice(0, LIMIT);
  console.log(`대상 ${targets.length}건`);
  if (!targets.length) return;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 1800 },
  });

  let ok = 0, fail = 0, consec = 0;
  for (const it of targets) {
    console.log(`\n[${ok + fail + 1}/${targets.length}] ${it.case_number}`);
    try {
      const r = await scrapeOne(ctx, it);
      if (!r.ok) { console.log(`  FAIL: ${r.reason}`); fail++; consec++; }
      else {
        const d = r.data;
        console.log(`  OK · 상태=${d.status} · 목록 ${d.targets.length} · 당사자 ${d.parties.length}`);
        if (DO_UPLOAD) {
          const newRaw = { ...it.raw_data };
          newRaw._detail = { ...(newRaw._detail ?? {}), caseInfo: d };
          const { error: upErr } = await supabase.from('auction_items').update({ raw_data: newRaw }).eq('id', it.id);
          if (upErr) { console.log(`  update err: ${upErr.message}`); fail++; consec++; continue; }
        }
        ok++; consec = 0;
      }
    } catch (e) { console.log(`  ERR: ${e.message.split('\n')[0]}`); fail++; consec++; }
    if (consec >= 3) { console.log('\n3건 연속 실패 — 중단'); break; }
    if (ok + fail < targets.length) await sleep(rand(8000, 12000));
  }
  await browser.close();
  console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
