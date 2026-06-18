/**
 * Minimal, dependency-free archive readers for the auto-upgrade pipeline.
 *
 * Mirrors the reference implementation's "standard library only" rule: we use
 * Node's built-in `zlib` for gzip and hand-written USTAR tar + ZIP parsers, so
 * there are no native modules to build. Only what the upgrader needs is
 * implemented (regular files, stored/deflate), with traversal and size guards.
 */

import zlib from 'node:zlib';

// Extraction caps — guard against corrupt or hostile (zip/tar bomb) archives.
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
export const MAX_MEMBERS = 20000;

/** Read a NUL-terminated field from a buffer slice. */
function cstr(buf, start, len) {
  let end = start;
  const limit = start + len;
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('utf8', start, end);
}

/** Parse a USTAR/GNU tar buffer into [{name, type, data}] (regular files only). */
export function parseTar(buf) {
  const entries = [];
  let offset = 0;
  let longName = null;

  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end; one zero block: stop safely.
    let allZero = true;
    for (let i = 0; i < 512; i++) if (block[i] !== 0) { allZero = false; break; }
    if (allZero) break;

    const name = cstr(block, 0, 100);
    const size = parseInt((cstr(block, 124, 12).trim() || '0'), 8) || 0;
    const typeflag = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    const prefix = cstr(block, 345, 155);
    offset += 512;

    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {                 // GNU long name extension
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') continue; // PAX headers — skip

    const fullName = longName || (prefix ? `${prefix}/${name}` : name);
    longName = null;
    const type = typeflag === '0' ? 'file' : typeflag === '5' ? 'dir' : 'other';
    if (type === 'file') entries.push({ name: fullName, data: Buffer.from(data) });
  }
  return entries;
}

/** Decompress a .tar.gz / .tgz buffer and parse it. */
export function parseTarGz(buf) {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return parseTar(isGzip ? zlib.gunzipSync(buf) : buf);
}

/** Parse a ZIP buffer (stored + deflate) into [{name, data}] via the central directory. */
export function parseZip(buf) {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  const LFH_SIG = 0x04034b50;

  // Locate the End Of Central Directory record (scan back over any comment).
  let p = buf.length - 22;
  const minP = Math.max(0, buf.length - 22 - 0xffff);
  while (p >= minP && buf.readUInt32LE(p) !== EOCD_SIG) p--;
  if (p < minP) throw new Error('ZIP EOCD record not found');

  const count = buf.readUInt16LE(p + 10);
  let o = buf.readUInt32LE(p + 16);
  const entries = [];

  for (let i = 0; i < count && o + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(o) !== CDH_SIG) break;
    const method = buf.readUInt16LE(o + 10);
    const compSize = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const commentLen = buf.readUInt16LE(o + 32);
    const localOffset = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nameLen);
    o += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (buf.readUInt32LE(localOffset) !== LFH_SIG) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`Unsupported ZIP compression method ${method}`);
    entries.push({ name, data });
  }
  return entries;
}
