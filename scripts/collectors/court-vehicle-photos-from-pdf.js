// 차량 감정평가서 PDF에서 차량 사진(embedded XObject) 추출 → auction-photos 업로드.
//
// 법원경매 사이트는 차량 사진을 별도로 공개하지 않고 감정평가서 PDF 내부에만 존재.
// pdfjs-dist 로 각 페이지의 이미지 XObject 를 꺼내 sharp 로 JPEG 정규화 후 업로드.
//
// 필터: 400x300 이상 이미지만 차량 사진으로 간주 (로고·아이콘·썸네일 제외).
// 저장: auction-photos/{boCd}/{saNo}/photo-{idx}.jpg
// DB:   raw_data._photos = [{ url, width, height }, ...]
//
// 실행:
//   node collectors/court-vehicle-photos-from-pdf.js --case 2025타경73228 --upload
//   node collectors/court-vehicle-photos-from-pdf.js --upload --limit 10

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const args = process.argv.slice(2);
const argOf = (f, fb) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const DO_UPLOAD = args.includes('--upload');
const LIMIT = parseInt(argOf('--limit', '5'), 10) || 5;
const CASE_NUMBER = argOf('--case', null);
const MIN_W = parseInt(argOf('--min-width', '400'), 10) || 400;
const MIN_H = parseInt(argOf('--min-height', '300'), 10) || 300;

async function getImgObject(page, name) {
  return new Promise((resolve) => {
    try {
      // pdfjs 3.x: objs.get(name, callback) - callback is called when resolved
      page.objs.get(name, (obj) => resolve(obj));
    } catch {
      resolve(null);
    }
  });
}

// 이미지 XObject → JPEG Buffer
async function imgToJpeg(img) {
  // img 구조(pdfjs-dist 3.x):
  //  - { width, height, kind, data }   (raw pixel)
  //  - { bitmap } ImageBitmap (브라우저 전용)
  //  - kind: 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP
  if (!img || !img.width || !img.height) return null;
  const { width, height, kind, data } = img;
  if (!data) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data);

  // RGB raw → JPEG
  if (kind === 2 || (!kind && buf.length === width * height * 3)) {
    return sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  }
  if (kind === 3 || (!kind && buf.length === width * height * 4)) {
    return sharp(buf, { raw: { width, height, channels: 4 } }).jpeg({ quality: 85 }).toBuffer();
  }
  if (kind === 1 || (!kind && buf.length === width * height)) {
    return sharp(buf, { raw: { width, height, channels: 1 } }).jpeg({ quality: 85 }).toBuffer();
  }
  // JPEG 스트림 그대로 (header 시작이 FFD8)
  if (buf[0] === 0xff && buf[1] === 0xd8) return buf;
  // 알 수 없으면 sharp 에 추정 맡김
  try {
    return await sharp(buf).jpeg({ quality: 85 }).toBuffer();
  } catch {
    return null;
  }
}

export async function extractFromPdf(pdfBuf, { minW = 400, minH = 300 } = {}) {
  const MIN_W_LOCAL = minW, MIN_H_LOCAL = minH;
  return _extractFromPdf(pdfBuf, MIN_W_LOCAL, MIN_H_LOCAL);
}

export async function uploadExtractedPhotos(supabase, { boCd, saNo, photos }) {
  const publicBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/auction-photos/`;
  const photoMeta = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const key = `${boCd}/${saNo}/photo-${String(i + 1).padStart(2, '0')}.jpg`;
    const { error: upErr } = await supabase.storage.from('auction-photos').upload(key, p.buf, {
      contentType: 'image/jpeg', upsert: true,
    });
    if (upErr) continue;
    photoMeta.push({ url: publicBase + key, path: key, width: p.width, height: p.height, source: 'aeeWevlPdf', page: p.page });
  }
  return photoMeta;
}

async function _extractFromPdf(pdfBuf, MIN_W, MIN_H) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuf),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  const results = [];
  const seenKeys = new Set();

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (
        fn !== pdfjs.OPS.paintImageXObject &&
        fn !== pdfjs.OPS.paintJpegXObject &&
        fn !== pdfjs.OPS.paintInlineImageXObject
      ) continue;
      const name = ops.argsArray[i][0];
      let img = null;
      try {
        if (fn === pdfjs.OPS.paintInlineImageXObject) {
          img = ops.argsArray[i][0];
        } else {
          img = page.commonObjs.has?.(name)
            ? await getImgObject({ objs: page.commonObjs }, name)
            : await getImgObject(page, name);
        }
      } catch {}
      if (!img || !img.width || !img.height) continue;
      const key = `${img.width}x${img.height}:${img.data?.byteLength || img.data?.length || 0}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (img.width < MIN_W || img.height < MIN_H) continue;
      const jpeg = await imgToJpeg(img).catch(() => null);
      if (!jpeg || jpeg.length < 8000) continue;
      results.push({ page: p, width: img.width, height: img.height, buf: jpeg });
    }
  }
  await doc.destroy().catch(() => {});
  return results;
}

async function processOne(supabase, item) {
  const raw = item.raw_data ?? {};
  const pdfMeta = raw._detail?.aeeWevlPdf;
  const boCd = raw.boCd;
  const saNo = String(raw.saNo || '');
  if (!pdfMeta?.path || !boCd || !saNo) return { ok: false, reason: 'no-pdf-meta' };

  const { data: file, error } = await supabase.storage.from('auction-pdfs').download(pdfMeta.path);
  if (error) return { ok: false, reason: 'pdf-download: ' + error.message };
  const buf = Buffer.from(await file.arrayBuffer());

  const photos = await extractFromPdf(buf, { minW: MIN_W, minH: MIN_H });
  console.log(`    추출: ${photos.length}장 (${photos.map(p => `${p.width}x${p.height}`).join(', ')})`);
  if (photos.length === 0) return { ok: false, reason: 'no-photos' };
  if (!DO_UPLOAD) return { ok: true, dry: true, count: photos.length };

  const publicBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/auction-photos/`;
  const photoMeta = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const key = `${boCd}/${saNo}/photo-${String(i + 1).padStart(2, '0')}.jpg`;
    const { error: upErr } = await supabase.storage.from('auction-photos').upload(key, p.buf, {
      contentType: 'image/jpeg', upsert: true,
    });
    if (upErr) { console.log(`    up err: ${upErr.message}`); continue; }
    photoMeta.push({ url: publicBase + key, path: key, width: p.width, height: p.height, source: 'aeeWevlPdf', page: p.page });
  }
  if (photoMeta.length === 0) return { ok: false, reason: 'upload-all-failed' };

  const newRaw = { ...raw };
  newRaw._photos = photoMeta;
  newRaw._photos_source = 'aeeWevl_pdf';
  newRaw._photos_extracted_at = new Date().toISOString();
  const { error: dbErr } = await supabase.from('auction_items')
    .update({ raw_data: newRaw, thumbnail_url: photoMeta[0]?.url ?? null })
    .eq('id', item.id);
  if (dbErr) return { ok: false, reason: 'db: ' + dbErr.message };
  return { ok: true, count: photoMeta.length };
}

async function main() {
  console.log(`Vehicle Photos Extract (upload=${DO_UPLOAD}, limit=${LIMIT}${CASE_NUMBER ? ', case=' + CASE_NUMBER : ''}, min=${MIN_W}x${MIN_H})`);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE env missing'); process.exit(1); }
  const supabase = createClient(url, key);

  let q = supabase.from('auction_items')
    .select('id, case_number, raw_data')
    .eq('source', 'court_auction').eq('category', 'vehicle')
    .not('raw_data->_detail->aeeWevlPdf', 'is', null);
  if (CASE_NUMBER) q = q.eq('case_number', CASE_NUMBER);
  else q = q.limit(LIMIT);
  const { data, error } = await q;
  if (error) { console.error(error); process.exit(1); }

  // 이미 _photos 있는 건 스킵 (--case 지정 시는 재실행 허용)
  const items = CASE_NUMBER ? data : data.filter(it => !it.raw_data?._photos?.length);
  console.log(`대상 ${items.length}건`);

  let ok = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    console.log(`\n[${i + 1}/${items.length}] ${it.case_number}`);
    try {
      const r = await processOne(supabase, it);
      if (r.ok) { console.log(`  OK count=${r.count}${r.dry ? ' (dry)' : ''}`); ok++; }
      else { console.log(`  SKIP ${r.reason}`); fail++; }
    } catch (e) {
      console.log(`  FAIL: ${String(e.message || e).split('\n')[0]}`);
      fail++;
    }
  }
  console.log(`\n완료: ok=${ok} fail=${fail}`);
}

const isDirectRun = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isDirectRun) main().catch(e => { console.error(e); process.exit(1); });
