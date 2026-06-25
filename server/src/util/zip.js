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
