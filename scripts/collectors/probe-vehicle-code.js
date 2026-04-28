// 법원경매 자동차/유체동산 API 코드 탐색 (court-collect.js와 동일 헤더·URL 사용)
import 'dotenv/config';

const SEARCH_URL = 'https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on';
const HOME_URL = 'https://www.courtauction.go.kr/pgj/index.on';
const UA = () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCookie() {
  const res = await fetch(HOME_URL, { headers: { 'User-Agent': UA(), 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' } });
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return raw.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function ymd(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }

function payload(mvprpCode) {
  const today = new Date();
  const plus30 = new Date(Date.now() + 30*24*60*60*1000);
  return {
    dma_pageInfo: { pageNo: 1, pageSize: 40, bfPageNo:'', startRowNo:'', totalCnt:'', totalYn:'Y', groupTotalCount:'' },
    dma_srchGdsDtlSrchInfo: {
      rletDspslSpcCondCd: '', bidDvsCd: '000331', mvprpRletDvsCd: mvprpCode, cortAuctnSrchCondCd: '0004601',
      rprsAdongSdCd:'', rprsAdongSggCd:'', rprsAdongEmdCd:'',
      rdnmSdCd:'', rdnmSggCd:'', rdnmNo:'',
      mvprpDspslPlcAdongSdCd:'', mvprpDspslPlcAdongSggCd:'', mvprpDspslPlcAdongEmdCd:'',
      rdDspslPlcAdongSdCd:'', rdDspslPlcAdongSggCd:'', rdDspslPlcAdongEmdCd:'',
      cortOfcCd:'', jdbnCd:'', execrOfcDvsCd:'',
      lclDspslGdsLstUsgCd:'', mclDspslGdsLstUsgCd:'', sclDspslGdsLstUsgCd:'',
      cortAuctnMbrsId:'',
      aeeEvlAmtMin:'', aeeEvlAmtMax:'',
      lwsDspslPrcRateMin:'', lwsDspslPrcRateMax:'',
      flbdNcntMin:'', flbdNcntMax:'',
      objctArDtsMin:'', objctArDtsMax:'',
      mvprpArtclKndCd:'', mvprpArtclNm:'',
      mvprpAtchmPlcTypCd:'',
      notifyLoc:'off', lafjOrderBy:'',
      pgmId: 'PGJ151F01',
      csNo:'', cortStDvs:'1', statNum: 1,
      bidBgngYmd: ymd(today), bidEndYmd: ymd(plus30),
      dspslDxdyYmd:'', fstDspslHm:'', scndDspslHm:'', thrdDspslHm:'', fothDspslHm:'',
      dspslPlcNm:'', lwsDspslPrcMin:'', lwsDspslPrcMax:'',
      grbxTypCd:'', gdsVendNm:'', fuelKndCd:'',
      carMdyrMax:'', carMdyrMin:'', carMdlNm:'', sideDvsCd:'',
    },
  };
}

async function probe(cookie, code) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': UA(),
      'Accept': 'application/json',
      'Referer': HOME_URL,
      'Origin': 'https://www.courtauction.go.kr',
      'Cookie': cookie,
    },
    body: JSON.stringify(payload(code)),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  return { httpStatus: res.status, json };
}

(async () => {
  const cookie = await fetchCookie();
  console.log(`쿠키: ${cookie.slice(0,60)}...\n`);

  const candidates = ['00031R','00031M','00031C','00031V','00031A','00031S','00031E'];

  for (const code of candidates) {
    try {
      const { httpStatus, json } = await probe(cookie, code);
      const total = json?.data?.dma_pageInfo?.totalCnt;
      const items = json?.data?.dlt_srchResult ?? [];
      const sample = items[0];
      console.log(`[${code}] http=${httpStatus} apiStatus=${json.status} total=${total} items=${items.length} msg=${json.message ?? ''}`);
      if (sample) {
        const keys = Object.keys(sample);
        console.log(`  sample용도=${sample.dspslUsgNm || sample.mvprpArtclKndNm || '?'} keys(${keys.length})=${keys.slice(0, 8).join(',')}`);
      }
      if (!json.status && json._raw) console.log(`  raw=${json._raw.slice(0,300)}`);
      if (httpStatus !== 200) console.log(`  body=${text.slice(0,300)}`);
    } catch (e) {
      console.log(`[${code}] error=${e.message}`);
    }
    await sleep(600);
  }
})();
