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

/**
 * Parse a USTAR/GNU tar buffer into [{name, data}] (regular files + hard links).
 *
 * v2.591(감사 P4 — 게시 번들로 재현): 예전엔 일반 파일(typeflag 0)만 남기고 **하드링크(1)** 를 버려, npm 이
 * 하드링크로 담는 `ssh2/.../build/Release/sshcrypto.node` 가 in-app 업그레이드마다 사라졌다(ssh2 네이티브 crypto →
 * JS 폴백으로 조용히 성능 저하 · 새 설치(cp -a)와 결과가 달라짐). 이제 하드링크는 **앞서 나온 대상 파일의 사본**으로
 * 풀고, 실행 비트는 `data.exec`(Buffer 속성)로 싣는다(applyPackage 가 0755/0644 로 쓴다 — setuid 등 다른 비트는
 * 옮기지 않는다).
 * ⚠ 심링크(2)는 **계속 건너뛴다** — 심링크 멤버 뒤에 그 아래 경로의 파일이 오면 `path.resolve` 검사를 통과한 채
 *   스테이징 **밖**에 쓰게 된다(zip slip 의 심링크 변형). 빠지는 것은 node_modules/.bin 편의 링크뿐이다.
 */
export function parseTar(buf) {
  const entries = [];
  const byName = new Map();
  let offset = 0;
  let longName = null;
  let longLink = null;
  // v2.593(감사 R2593-02 — 재현): 하드링크는 헤더 크기가 0 이라 gunzip 의 maxOutputLength 가 원본 **한 번**만 센다.
  //   사본을 다 만든 뒤 collectMembers 가 누적을 재면 이미 늦다(20KB tgz → 사본 60개 · 1.22GB 상주).
  //   만드는 **동안** 누적 바이트·개수를 세어 상한을 넘기 전에 던진다(v2.488 L-1 '압축 해제에는 상한' 의 연장).
  let total = 0;
  const account = (n) => {
    total += n;
    if (total > MAX_BUNDLE_BYTES || entries.length >= MAX_MEMBERS) {
      throw new Error(`아카이브가 너무 큽니다 — 풀린 크기·개수 상한(${MAX_BUNDLE_BYTES}B · ${MAX_MEMBERS}개)을 넘었습니다(하드링크 사본 포함)`);
    }
  };

  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end; one zero block: stop safely.
    let allZero = true;
    for (let i = 0; i < 512; i++) if (block[i] !== 0) { allZero = false; break; }
    if (allZero) break;

    const name = cstr(block, 0, 100);
    const mode = parseInt((cstr(block, 100, 8).trim() || '0'), 8) || 0;
    const size = parseInt((cstr(block, 124, 12).trim() || '0'), 8) || 0;
    const linkName = cstr(block, 157, 100);
    const typeflag = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    const prefix = cstr(block, 345, 155);
    offset += 512;

    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {                 // GNU long name extension
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'K') {                 // GNU long link-name extension
      longLink = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') continue; // PAX headers — skip

    const fullName = longName || (prefix ? `${prefix}/${name}` : name);
    const target = longLink || linkName;
    longName = null; longLink = null;
    if (typeflag === '0' || typeflag === '7') {
      account(data.length);
      const b = Buffer.from(data);
      if (mode & 0o111) b.exec = true;
      entries.push({ name: fullName, data: b });
      byName.set(fullName, b);
    } else if (typeflag === '1') {
      // 하드링크 — 대상은 이 아카이브에서 **앞서 나온** 일반 파일이어야 한다(없으면 버린다: 밖을 가리킬 수 없다).
      const src = byName.get(target);
      if (src) {
        account(src.length);
        const b = Buffer.from(src);
        if (src.exec || (mode & 0o111)) b.exec = true;
        entries.push({ name: fullName, data: b });
        byName.set(fullName, b);
      }
    }
    // '2'(심링크)·'5'(디렉터리)·그 밖은 건너뛴다 — 위 머리말 참조.
  }
  return entries;
}

/** Decompress a .tar.gz / .tgz buffer and parse it. */
export function parseTarGz(buf) {
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  // ⚠ 보안(L-1, 2026-09-12): 압축 폭탄 방어 — `maxOutputLength` 없이 gunzip 하면 수 MB gzip 이
  // 수 GB 로 팽창해 힙을 고갈시킨다(누적 크기 검사는 압축 해제가 끝난 뒤라 늦다). 여기서 상한을
  // 걸어 초과 시 ERR_BUFFER_TOO_LARGE 로 즉시 실패시킨다.
  return parseTar(isGzip ? zlib.gunzipSync(buf, { maxOutputLength: MAX_BUNDLE_BYTES }) : buf);
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
    // 보안(L-1): zip 엔트리도 압축 해제 출력 상한을 건다(zip bomb 방어).
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: MAX_BUNDLE_BYTES });
    else throw new Error(`Unsupported ZIP compression method ${method}`);
    entries.push({ name, data });
  }
  return entries;
}
