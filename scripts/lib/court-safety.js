// 법원경매 수집 전 공통 안전 검사.
//
// 모든 court-* 수집기는 시작점에서 `await guard()` 호출.
// 다음 3단계 중 하나라도 걸리면 process.exit(0) 로 조용히 종료(차단 방지).
//
//   1. 하드코딩 운영시간 — 01:00~06:00 KST 점검시간
//   2. 수동 점검 일정 JSON — scripts/lib/court-maintenance.json
//      (연휴·임시 점검 사용자가 직접 입력. 날짜 범위나 단일 날짜)
//   3. 실시간 감지 — courtauction.go.kr 홈페이지 HTML에 점검 키워드
//
// 환경변수:
//   SKIP_SAFETY=1 → 체크 건너뜀 (긴급 수동 실행용)
//   SAFETY_DRY_RUN=1 → 감지만 하고 exit 안 함 (디버그)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAINT_JSON = path.join(__dirname, 'court-maintenance.json');

function nowKST() {
  // toLocaleString 은 24시간 형태로 반환하도록 강제
  const s = new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // "2026-04-19, 01:23"
  const m = s.match(/(\d{4})-(\d{2})-(\d{2}),?\s+(\d{2}):(\d{2})/);
  if (!m) throw new Error('KST parse fail: ' + s);
  const [, y, mo, d, h, mi] = m;
  return { ymd: `${y}-${mo}-${d}`, hour: +h, minute: +mi, iso: `${y}-${mo}-${d} ${h}:${mi} KST` };
}

function inMaintenanceHour(hour) {
  // 01~05 = 점검. 06:00 부터 정상.
  return hour >= 1 && hour < 6;
}

function inMaintenanceJson(ymd) {
  if (!fs.existsSync(MAINT_JSON)) return null;
  try {
    const entries = JSON.parse(fs.readFileSync(MAINT_JSON, 'utf-8'));
    for (const e of entries) {
      if (typeof e === 'string' && e === ymd) return e;
      if (typeof e === 'object') {
        const from = e.from || e.date;
        const to = e.to || e.date;
        if (from && to && ymd >= from && ymd <= to) return `${from}~${to} (${e.reason || ''})`;
      }
    }
  } catch (err) {
    console.warn(`[safety] maintenance.json 파싱 실패: ${err.message}`);
  }
  return null;
}

async function checkLive() {
  // 단순 GET. HTML 에 점검 키워드 있으면 점검중 판정.
  // Playwright 없이 fetch 만 사용 — 런타임 가벼움.
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 8000);
    const res = await fetch('https://www.courtauction.go.kr/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0' },
      signal: ac.signal,
    });
    clearTimeout(to);
    if (!res.ok) return `HTTP ${res.status}`;
    const body = await res.text();
    // nrsMessageValue 는 JSON 응답에만 나오지만, 홈페이지가 점검 안내 페이지로 바뀌는 경우가 있음
    if (/점검\s*중|이용\s*가능\s*시간대가?\s*아닙니다|nrsMessageValue/.test(body)) {
      return '홈페이지 HTML 에 점검 키워드';
    }
    // 정상 페이지 랜드마크
    if (!/법원경매|courtauction|auctnVtCtt/.test(body)) {
      return '예상 HTML 마커 없음 (점검 가능)';
    }
    return null;
  } catch (err) {
    return `live check 실패: ${err.message}`;
  }
}

/**
 * 수집 시작 전 호출.
 *
 * @param {Object} opts
 * @param {boolean} [opts.skipLive=false]  true면 네트워크 실시간 체크 생략
 * @param {boolean} [opts.allowMaintHour=false]  true면 01~06시도 통과 (아주 특수한 수동 실행)
 */
export async function guard(opts = {}) {
  if (process.env.SKIP_SAFETY === '1') {
    console.log('[safety] SKIP_SAFETY=1 — 검사 건너뜀');
    return;
  }

  const { ymd, hour, iso } = nowKST();
  const dry = process.env.SAFETY_DRY_RUN === '1';
  const bail = (reason) => {
    const msg = `[safety] ${reason} — ${iso}`;
    if (dry) { console.log(`${msg}  (DRY_RUN 이라 통과)`); return; }
    console.log(msg);
    process.exit(0);
  };

  // 1) 운영시간
  if (!opts.allowMaintHour && inMaintenanceHour(hour)) {
    return bail(`법원경매 점검시간(01~06 KST) — hour=${hour}`);
  }

  // 2) 수동 점검 JSON
  const maintMatch = inMaintenanceJson(ymd);
  if (maintMatch) return bail(`수동 점검 일정 매칭: ${maintMatch}`);

  // 3) 실시간 HTML 감지
  if (!opts.skipLive) {
    const live = await checkLive();
    if (live) return bail(`실시간 감지: ${live}`);
  }

  console.log(`[safety] OK — ${iso}`);
}
