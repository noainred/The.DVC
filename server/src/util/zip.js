/**
 * 단일 파일 ZIP 생성기 — 의존성 없이(zlib만) 한 파일을 deflate 압축한 .zip 버퍼를 만든다.
 * 대용량 내보내기를 zip으로 압축해 전송할 때 사용(에어갭 Rocky9에서 외부 패키지 불필요).
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** name 한 파일을 담은 .zip(Buffer). data는 string|Buffer. */
export function zipSingle(name, data) {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const comp = zlib.deflateRawSync(content);
  const crc = crc32(content);
  const nameBuf = Buffer.from(name, 'utf8');

  const lf = Buffer.alloc(30);
  lf.writeUInt32LE(0x04034b50, 0);  // local file header sig
  lf.writeUInt16LE(20, 4);          // version needed
  lf.writeUInt16LE(0, 6);           // flags
  lf.writeUInt16LE(8, 8);           // method: deflate
  lf.writeUInt16LE(0, 10); lf.writeUInt16LE(0, 12); // mtime/mdate
  lf.writeUInt32LE(crc, 14);
  lf.writeUInt32LE(comp.length, 18);
  lf.writeUInt32LE(content.length, 22);
  lf.writeUInt16LE(nameBuf.length, 26);
  lf.writeUInt16LE(0, 28);
  const localPart = Buffer.concat([lf, nameBuf, comp]);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);  // central dir sig
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);          // external attrs
  cd.writeUInt32LE(0, 42);          // local header offset
  const centralPart = Buffer.concat([cd, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

/**
 * 여러 파일을 담은 .zip(Buffer) — v2.497. entries: [{ name, data }] (data 는 string|Buffer).
 * 낭비 리소스 엑셀 내보내기(xlsx + reports/*.html)처럼 **파일 여러 개를 한 번에** 내려줄 때 쓴다.
 * 형식은 zipSingle 과 같은 최소 ZIP(로컬 헤더 연쇄 → 중앙 디렉터리 → EOCD). 차이점:
 *  - general purpose flag bit 11(0x800) = 파일명 UTF-8 — 한글 파일명이 Windows 기본 해제기에서 깨지지
 *    않게 한다(zipSingle 은 0 — 기존 출력과의 바이트 호환을 위해 그대로 둔다).
 *  - 중앙 디렉터리 각 항목에 로컬 헤더 오프셋을 기록한다(단일 파일은 항상 0 이었다).
 * 상한: 항목 수 maxEntries(기본 2000)·원본 합계 maxBytes(기본 256MB) — 넘으면 throw(호출부가 상한을
 * 먼저 자르는 것이 원칙이고, 이것은 실수 방지용 마지막 방어선).
 * ZIP64 는 지원하지 않는다(4GB·65,535 항목 초과 불가 — 이 포탈의 내보내기 규모에서는 도달하지 않는다).
 */
export function zipMany(entries, { maxEntries = 2000, maxBytes = 256 * 1024 * 1024 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > maxEntries) throw new Error(`zip 항목 수 ${list.length} — 상한 ${maxEntries} 초과`);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;
  const seen = new Set();
  for (const e of list) {
    const name = String(e?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name) throw new Error('zip 항목 이름이 비어 있습니다');
    if (seen.has(name)) throw new Error(`zip 항목 이름 중복: ${name}`);
    seen.add(name);
    const content = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e?.data ?? ''));
    total += content.length;
    if (total > maxBytes) throw new Error(`zip 원본 합계 ${total} 바이트 — 상한 ${maxBytes} 초과`);
    const comp = zlib.deflateRawSync(content);
    const crc = crc32(content);
    const nameBuf = Buffer.from(name, 'utf8');

    const lf = Buffer.alloc(30);
    lf.writeUInt32LE(0x04034b50, 0);
    lf.writeUInt16LE(20, 4);
    lf.writeUInt16LE(0x0800, 6);      // flags: UTF-8 파일명
    lf.writeUInt16LE(8, 8);           // deflate
    lf.writeUInt16LE(0, 10); lf.writeUInt16LE(0, 12);
    lf.writeUInt32LE(crc, 14);
    lf.writeUInt32LE(comp.length, 18);
    lf.writeUInt32LE(content.length, 22);
    lf.writeUInt16LE(nameBuf.length, 26);
    lf.writeUInt16LE(0, 28);
    const localPart = Buffer.concat([lf, nameBuf, comp]);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);     // 이 항목의 로컬 헤더 오프셋
    centrals.push(Buffer.concat([cd, nameBuf]));
    locals.push(localPart);
    offset += localPart.length;
  }
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8); eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralPart, eocd]);
}

export const ZIP_THRESHOLD = 1 * 1024 * 1024; // 1MB 초과 시 zip 압축

/** content가 임계치 초과면 zip으로, 아니면 원본으로 전송. baseName 예: 'gpu-2026-06-25.csv'. */
export function sendMaybeZip(res, baseName, content, mime) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buf.length > ZIP_THRESHOLD) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);
    return res.send(zipSingle(baseName, buf));
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}"`);
  return res.send(buf);
}
