import fs from 'node:fs';
import path from 'node:path';

/**
 * 원자적 파일 쓰기 — 임시파일에 기록 후 rename으로 교체한다. writeFileSync는 기록 도중
 * 크래시/정전 시 파일을 truncate/부분기록 상태로 남겨, 다음 로드에서 JSON 파싱 실패 →
 * 빈 값 반환 → 다음 저장이 손상본을 덮어쓰며 데이터가 영구 유실될 수 있다. rename은 같은
 * 파일시스템에서 원자적이므로 '온전한 이전본' 또는 '온전한 새본'만 남는다.
 */
/**
 * v2.689(G2 B3): Buffer·TypedArray 도 받는다(백업 gzip 아카이브). `fs.writeSync(fd, buf)` 는 쓴 바이트 수를 돌려줄 뿐
 * 전부 썼다고 보장하지 않으므로 바이너리는 끝까지 이어 쓴다. 문자열 경로는 예전과 같다.
 */
function writeAll(fd, data) {
  if (!ArrayBuffer.isView(data)) { fs.writeSync(fd, data); return; }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`atomicWrite: 쓰기가 진행되지 않습니다(${off}/${buf.length}바이트)`);
    off += n;
  }
}

export function atomicWriteFileSync(file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  try {
    // 임시파일 데이터를 디스크에 fsync한 뒤 rename — fsync 없이는 rename 메타데이터가 데이터보다
    // 먼저 디스크에 닿아, 정전 시 대상이 0바이트/부분 파일로 남을 수 있다(정전 안전성 확보).
    const fd = fs.openSync(tmp, 'w', mode);
    try { writeAll(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(tmp, mode); } catch { /* */ }
    fs.renameSync(tmp, file); // 같은 FS에서 원자적 교체
    // 디렉터리 엔트리(rename)도 fsync — 새 파일명이 정전에도 유실되지 않게. 미지원 플랫폼은 무시.
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* */ }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
}

/**
 * v2.744(리드 후속 RY): 파일 로드 오류 사유를 **원문 글자 없이** 분류한다(순수 — 판정은 이 함수 하나).
 *   V8 의 JSON.parse 오류는 오류 위치 앞뒤 원문 약 10자를 싣는다(짧은 파일은 내용 **전부**) — 손상된 파일이 자격증명·토큰 파일이면 그 조각이
 *   평문 비밀번호 일부다(재현: `"password": SuperSecret123!` → `Unexpected token 'S', ..."assword": SuperSecre"... is not valid JSON`).
 *   ⚠ 따옴표 쌍만 지우는 정규식으로는 부족하다 — 그 메시지의 따옴표는 짝이 맞지 않고(`..."assword": SuperSecre"...`), 조각이 여러 줄일 수도 있다.
 *   그래서 문장을 고쳐 쓰지 않고 **분류 + 숫자**만 남긴다:
 *     · kind 'parse' — JSON 형식 오류. 숫자(줄·칸·위치)만 옮긴다(V8 의 'Unexpected token X, "…"' 형식은 위치를 주지 않는다 — 그때는 분류만).
 *     · kind 'other' — 그 밖. `safeText` 는 따옴표·백슬래시·제어 문자가 없고 짧은(LOAD_REASON_SAFE_MAX) 사람 문장일 때만 원문(호출부가 직접 쓴
 *       '객체가 아님' 같은 사유), `sysCode` 는 EACCES 같은 시스템 오류 코드(경로는 옮기지 않는다).
 *   등록부 요약(util/registryCore.js summarizeRegistryError)도 이 함수로 판정한다 — 두 벌이면 한쪽만 고쳐진다.
 * @param {any} reason  오류 문자열 또는 Error(호출부가 넘기는 `e.message`·`e`)
 * @returns {{kind:'none'|'parse'|'other', line:(number|null), column:(number|null), position:(number|null), sysCode:(string|null), safeText:(string|null)}}
 */
export const LOAD_REASON_SAFE_MAX = 100;
const LOAD_PARSE_RE = /JSON|Unexpected (token|end|non-whitespace|number)|Bad (control|escaped|Unicode)|Expected |Unterminated /;
const LOAD_SYS_RE = /(?:^|[^A-Z])(E[A-Z]{2,15})(?![A-Za-z])/;
// 따옴표(ASCII·유니코드)·백슬래시·제어 문자 — 이것이 든 문장은 값이 끼어 있을 수 있다고 본다.
const LOAD_UNSAFE_RE = /["'`‘’‚‛“”„‟«»\\\u0000-\u001F\u007F]/;
const loadPosInt = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1e9 ? n : null;
};
function loadReasonRaw(reason) {
  try {
    const v = reason && typeof reason === 'object' && 'message' in reason ? reason.message : reason;
    if (v == null) return '';
    // 정규식 입력 상한 — 길이를 먼저 자른다(엣지가 보낸 글자도 지나간다).
    return (typeof v === 'string' ? v : String(v)).slice(0, 400);
  } catch { return ''; }
}
export function classifyLoadReason(reason) {
  const raw = loadReasonRaw(reason);
  const out = { kind: 'none', line: null, column: null, position: null, sysCode: null, safeText: null };
  if (!raw) return out;
  if (LOAD_PARSE_RE.test(raw)) {
    out.kind = 'parse';
    const lc = /\(line (\d{1,9}) column (\d{1,9})\)/.exec(raw);
    if (lc) { out.line = loadPosInt(lc[1]); out.column = loadPosInt(lc[2]); }
    const p = /at position (\d{1,9})/.exec(raw);
    if (p) out.position = loadPosInt(p[1]);
    return out;
  }
  out.kind = 'other';
  const s = LOAD_SYS_RE.exec(raw);
  if (s) out.sysCode = s[1];
  const t = raw.trim();
  if (t && t.length <= LOAD_REASON_SAFE_MAX && !LOAD_UNSAFE_RE.test(t)) out.safeText = t;
  return out;
}
/** 위치 문구(관리자·콘솔용) — 줄·칸이 있으면 그것, 없으면 위치, 둘 다 없으면 ''. */
export function loadReasonWhere({ line = null, column = null, position = null } = {}) {
  if (line != null && column != null) return `${line}번째 줄 ${column}번째 칸`;
  return position != null ? `위치 ${position}` : '';
}
/**
 * 로드 오류 사유의 **사람이 읽는 요약**(원문 조각 없음) — preserveCorrupt 콘솔 줄이 쓴다. 이 줄은 엣지 링 버퍼로 중앙 엣지 로그에 당겨지고
 *   로그 가림(edgelog/redact)은 `KEY=값` 꼴만 잡아 V8 조각을 지우지 못한다. 원문은 보존본 파일(`<file>.corrupt.<시각>`)에 그대로 있다.
 * @returns {string}  빈 사유면 ''
 */
export function summarizeLoadReason(reason) {
  const c = classifyLoadReason(reason);
  if (c.kind === 'none') return '';
  if (c.kind === 'parse') { const w = loadReasonWhere(c); return `JSON 형식 오류${w ? `(${w})` : ''}`; }
  if (c.safeText) return c.safeText;
  if (c.sysCode) return `읽기 오류(${c.sysCode})`;
  return '읽기 오류(사유 원문은 파일 내용이 들어갈 수 있어 싣지 않습니다 — 보존본 파일을 직접 여세요)';
}

/**
 * 손상된 자격증명/설정 파일을 `<file>.corrupt.<ts>`로 보존한다(로드 시 JSON 파싱 실패 대응).
 * 손상본을 조용히 빈 값으로 취급하면, 다음 저장이 '온전했던 원본'을 빈/축소 목록으로 덮어써
 * 자격증명이 영구 유실된다(과거 감사 지적 H11/H12). 파싱 실패한 파일을 먼저 옆으로 치워
 * 운영자가 수동 복구할 수 있게 하고, 실패해도(권한 등) best-effort로 넘어간다.
 * v2.744(리드 후속 RY): 콘솔 줄의 사유는 `summarizeLoadReason` 요약이다 — 예전에는 `reason`(대개 JSON.parse 오류 원문 = 파일 조각)을 그대로
 *   찍어 그 조각이 엣지 로그로 중앙에 당겨졌다. '파싱 실패' 문구와 파일 이름·보존본 이름은 그대로다(로그 분석 규칙·테스트가 그 문구를 본다).
 * @returns 보존에 성공하면 백업 경로, 아니면 null.
 */
export function preserveCorrupt(file, reason = '') {
  try {
    if (!fs.existsSync(file)) return null;
    const bak = `${file}.corrupt.${Date.now()}`;
    fs.renameSync(file, bak);
    const why = summarizeLoadReason(reason);
    console.error(`[atomicWrite] ${path.basename(file)} 파싱 실패${why ? `(${why})` : ''} — 손상본을 ${path.basename(bak)}로 보존하고 빈 값으로 시작합니다. 자동 재저장이 덮어쓰기 전 수동 복구하세요.`);
    return bak;
  } catch { return null; }
}
