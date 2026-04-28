// courtauction.go.kr API 직접 호출 (Playwright 없이)
// 먼저 홈페이지 한번 GET해서 세션 쿠키 얻고, 그 쿠키로 POST
// 실행: node collectors/court-direct.js

const SEARCH_URL = 'https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

async function getSessionCookies() {
  const res = await fetch(HOME_URL, { headers: { 'User-Agent': UA } });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function buildPayload({ pageNo = 1, pageSize = 10, cortOfcCd = '', fromDate, toDate }) {
  const today = new Date();
  const future = new Date(); future.setDate(future.getDate() + 30);
  return {
    dma_pageInfo: {
      pageNo, pageSize, bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: '',
    },
    dma_srchGdsDtlSrchInfo: {
      rletDspslSpcCondCd: '',
      bidDvsCd: '000331',
      mvprpRletDvsCd: '00031R',            // R = 부동산
      cortAuctnSrchCondCd: '0004601',
      rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
      rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
      mvprpDspslPlcAdongSdCd: '', mvprpDspslPlcAdongSggCd: '', mvprpDspslPlcAdongEmdCd: '',
      rdDspslPlcAdongSdCd: '', rdDspslPlcAdongSggCd: '', rdDspslPlcAdongEmdCd: '',
      cortOfcCd,                           // 법원 (빈값=전체)
      jdbnCd: '', execrOfcDvsCd: '',
      lclDspslGdsLstUsgCd: '', mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '',
      cortAuctnMbrsId: '',
      aeeEvlAmtMin: '', aeeEvlAmtMax: '',
      lwsDspslPrcRateMin: '', lwsDspslPrcRateMax: '',
      flbdNcntMin: '', flbdNcntMax: '',
      objctArDtsMin: '', objctArDtsMax: '',
      mvprpArtclKndCd: '', mvprpArtclNm: '',
      mvprpAtchmPlcTypCd: '',
      notifyLoc: 'off', lafjOrderBy: '',
      pgmId: 'PGJ151F01',
      csNo: '',
      cortStDvs: '1',
      statNum: 1,
      bidBgngYmd: fromDate ?? ymd(today),
      bidEndYmd: toDate ?? ymd(future),
      dspslDxdyYmd: '',
      fstDspslHm: '', scndDspslHm: '', thrdDspslHm: '', fothDspslHm: '',
      dspslPlcNm: '',
      lwsDspslPrcMin: '', lwsDspslPrcMax: '',
      grbxTypCd: '', gdsVendNm: '', fuelKndCd: '',
      carMdyrMax: '', carMdyrMin: '', carMdlNm: '',
      sideDvsCd: '',
    },
  };
}

async function search(opts) {
  const cookie = await getSessionCookies();
  const payload = buildPayload(opts);
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': HOME_URL,
      'Origin': 'https://www.courtauction.go.kr',
      ...(cookie ? { 'Cookie': cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function main() {
  console.log('1) 세션 쿠키 획득 중...');
  const cookie = await getSessionCookies();
  console.log('   쿠키:', cookie || '(없음)');

  console.log('\n2) 부동산 매각물건 검색 (전국, 30일 이내)');
  const r = await search({ pageNo: 1, pageSize: 10 });
  console.log(`   HTTP ${r.status}`);

  let json;
  try { json = JSON.parse(r.text); } catch { console.log(r.text.slice(0, 500)); process.exit(1); }

  if (json.status !== 200) {
    console.log('   서버 에러:', json.message);
    process.exit(1);
  }

  const info = json.data.dma_pageInfo;
  const list = json.data.dlt_srchResult ?? [];
  console.log(`   총 ${info.totalCnt}건, 이번 페이지 ${list.length}건`);

  console.log('\n3) 첫 3건 미리보기:');
  list.slice(0, 3).forEach((it, i) => {
    console.log(`   [${i + 1}] ${it.srnSaNo} | 감정가 ${Number(it.gamevalAmt).toLocaleString()}원 | 최저 ${Number(it.minmaePrice).toLocaleString()}원 | 유찰 ${it.yuchalCnt}회 | 조회 ${it.inqCnt}`);
  });

  // 필드 키 스키마
  if (list[0]) {
    console.log('\n4) 반환 필드 목록:');
    console.log('   ' + Object.keys(list[0]).join(', '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
