// ipmsRangeText.js — IPMS 대역 문법 판정(웹, 순수 · v2.637).
// ⚠ 서버 `server/src/ipam/rangeSyntax.js` 와 **같은 규칙의 사본**이다(번들 경계 — 웹은 서버 소스를 import 할 수 없다).
//   `ipmsRangeText.test.js` 가 두 구현을 같은 입력으로 대조한다 — 한쪽만 고치면 테스트가 깨진다.
//   화면은 저장 전에 같은 판정으로 오류 줄을 보여 주고, 서버는 저장 시 다시 판정한다(400 + invalid).

const OCTET = /^\d+$/;
function ipToNum(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return null;
  const parts = String(s).trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!OCTET.test(p)) return null;
    const x = Number(p);
    if (x > 255) return null;
    n = n * 256 + x;
  }
  return n >>> 0;
}
function numToIp(n) {
  const v = Number(n) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

export const MIN_MASK = 8;
const MASK_RE = /^\d{1,2}$/;
const OCTET_RE = /^\d{1,3}$/;

/**
 * 한 줄 판정.
 * @returns {{ ok: true, lo: number, hi: number, size: number, kind: 'cidr'|'range'|'ip', warn: string|null }
 *          | { ok: false, reason: string }}
 */
export function checkRangeSpec(spec, opt = {}) {
  const s = String(spec ?? '').trim();
  if (!s) return { ok: false, reason: '빈 줄' };
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return { ok: false, reason: '‘/’ 가 두 번 이상 있습니다' };
    const [b, m] = parts.map((x) => x.trim());
    const base = ipToNum(b);
    if (base == null) return { ok: false, reason: `‘${b || '(비어 있음)'}’ 는 IPv4 주소가 아닙니다` };
    if (!m) return { ok: false, reason: '‘/’ 뒤 마스크가 비어 있습니다 — 비워 두면 전체 주소(/0)로 읽힐 수 있어 받지 않습니다' };
    if (!MASK_RE.test(m)) return { ok: false, reason: `마스크 ‘${m}’ 는 숫자가 아닙니다` };
    const mask = Number(m);
    if (mask > 32) return { ok: false, reason: `마스크 /${mask} 는 32 를 넘습니다` };
    if (mask < MIN_MASK) return { ok: false, reason: `마스크 /${mask} 는 너무 넓습니다(/${MIN_MASK} 이상만 받습니다)` };
    const size = 2 ** (32 - mask);
    const lo = Math.floor(base / size) * size;
    const warn = lo !== base ? `네트워크 경계가 아닙니다 — ${numToIp(lo)}/${mask} 로 읽습니다` : null;
    return { ok: true, lo, hi: lo + size - 1, size, kind: 'cidr', warn };
  }
  if (s.includes('-')) {
    const parts = s.split('-');
    if (parts.length !== 2) return { ok: false, reason: '‘-’ 가 두 번 이상 있습니다' };
    const [a, bRaw] = parts.map((x) => x.trim());
    const lo = ipToNum(a);
    if (lo == null) return { ok: false, reason: `시작 ‘${a || '(비어 있음)'}’ 는 IPv4 주소가 아닙니다` };
    let hi = ipToNum(bRaw);
    if (hi == null && OCTET_RE.test(bRaw) && Number(bRaw) <= 255) hi = Math.floor(lo / 256) * 256 + Number(bRaw); // a.b.c.d-e
    if (hi == null) return { ok: false, reason: `끝 ‘${bRaw || '(비어 있음)'}’ 는 IPv4 주소(또는 마지막 옥텟)가 아닙니다` };
    if (hi < lo) {
      // 무시·분류 목록은 예전부터 뒤집힌 범위를 바꿔 읽었다(저장된 옛 값이 조용히 빠지지 않게 유지) — 경고로 밝힌다.
      // 스캔 대역은 `rangeSize` 가 거부하므로 오류다(opt.reversed === 'error').
      if (opt.reversed === 'error') return { ok: false, reason: `끝 ${numToIp(hi)} 이 시작 ${numToIp(lo)} 보다 작습니다` };
      return { ok: true, lo: hi, hi: lo, size: lo - hi + 1, kind: 'range', warn: `시작과 끝이 뒤바뀌었습니다 — ${numToIp(hi)}-${numToIp(lo)} 로 읽습니다` };
    }
    return { ok: true, lo, hi, size: hi - lo + 1, kind: 'range', warn: null };
  }
  const n = ipToNum(s);
  if (n == null) return { ok: false, reason: `‘${s.length > 40 ? `${s.slice(0, 40)}…` : s}’ 는 CIDR·범위·IP 형식이 아닙니다` };
  return { ok: true, lo: n, hi: n, size: 1, kind: 'ip', warn: null };
}

/** 적용용 파서 — 판정을 통과한 줄만 {lo,hi}. 저장된 옛 값(검증 전 저장분)도 같은 규칙이다. */
export function parseRangeSpec(spec) {
  const r = checkRangeSpec(spec);
  return r.ok ? { lo: r.lo, hi: r.hi } : null;
}

/**
 * 목록 판정. 빈 줄은 오류가 아니다(무시한다). 줄 번호는 1부터, **빈 줄을 포함한 원래 줄** 기준이다(화면이 그 줄을 가리키게).
 * @param {string[]|string} list
 * @param {{ scanCap?: number, reversed?: 'swap'|'error' }} [opt] scanCap 이 있으면 한 줄이 그보다 크면 경고(스캔은 앞 N개만 돈다).
 */
export function checkRangeList(list, opt = {}) {
  const lines = Array.isArray(list) ? list.map((x) => String(x ?? '')) : String(list ?? '').split(/\r?\n/);
  const valid = []; const invalid = []; const warnings = [];
  const seen = new Map();
  let total = 0;
  lines.forEach((raw, i) => {
    const v = raw.trim();
    if (!v) return;
    const r = checkRangeSpec(v, opt);
    if (!r.ok) { invalid.push({ line: i + 1, value: v.slice(0, 80), reason: r.reason }); return; }
    const key = `${r.lo}-${r.hi}`;
    if (seen.has(key)) warnings.push({ line: i + 1, value: v.slice(0, 80), reason: `${seen.get(key)}행과 같은 대역입니다` });
    else seen.set(key, i + 1);
    if (r.warn) warnings.push({ line: i + 1, value: v.slice(0, 80), reason: r.warn });
    if (opt.scanCap && r.size > opt.scanCap) warnings.push({ line: i + 1, value: v.slice(0, 80), reason: `${r.size.toLocaleString()}개 — 스캔은 앞 ${opt.scanCap.toLocaleString()}개만 돕니다(/24 단위로 나누세요)` });
    total += r.size;
    valid.push(v);
  });
  return { valid, invalid, warnings, ipCount: total };
}

/* ── 화면 문구(v2.637) ─────────────────────────────────────────────────────── */

export const FIELD_LABEL = {
  global: '전체 무시 대역',
  vcenters: 'vCenter별 무시 대역',
  publicRanges: '공인 대역',
  privateRanges: '사설 대역',
  scanRanges: '스캔 대역',
};

/** 빈 줄을 뺀 정리본 — 초안(빈 줄 포함)과 서버 값(정리본)을 같은 기준으로 비교하려고 쓴다. */
export const cleanLines = (list) => (Array.isArray(list) ? list : String(list ?? '').split(/\r?\n/)).map((x) => String(x ?? '').trim()).filter(Boolean);

/** 설정 객체 정리본(무시·분류 목록 + vCenter별) — '실제로 바뀐 것이 있나' 판정용. */
export function normIpmsSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const vcenters = {};
  for (const [k, v] of Object.entries(s.vcenters || {})) { const c = cleanLines(v); if (c.length) vcenters[k] = c; }
  return { global: cleanLines(s.global), publicRanges: cleanLines(s.publicRanges), privateRanges: cleanLines(s.privateRanges), vcenters };
}

/** 두 설정의 정리본이 같은가(빈 줄·공백 차이는 무시). */
export function sameIpmsSettings(a, b) {
  return JSON.stringify(normIpmsSettings(a)) === JSON.stringify(normIpmsSettings(b));
}

/** 이 vCenter 의 무시 대역이 서버 값과 다른가. */
export function vcDirty(value, base, vcId) {
  return JSON.stringify(cleanLines(value?.vcenters?.[vcId])) !== JSON.stringify(cleanLines(base?.vcenters?.[vcId]));
}

/**
 * 저장을 막을 오류 전부 — 화면이 저장 버튼을 잠그고 무엇을 고칠지 말한다(서버도 같은 판정으로 400 을 준다).
 * vCenter별 목록은 **모든 vCenter** 를 본다(선택기에 지금 보이는 하나만 보면 다른 vCenter 의 오류를 놓친다).
 */
export function ipmsSettingsErrors(s, vcName = (id) => id) {
  if (!s) return [];
  const out = [];
  const add = (field, list, vcenterId) => {
    for (const x of checkRangeList(list || []).invalid) out.push({ field, vcenterId, ...x, where: vcenterId != null ? `${FIELD_LABEL[field]} · ${vcName(vcenterId)}` : FIELD_LABEL[field] });
  };
  add('global', s.global);
  add('publicRanges', s.publicRanges);
  add('privateRanges', s.privateRanges);
  for (const [k, v] of Object.entries(s.vcenters || {})) add('vcenters', v, k);
  return out;
}

/** 목록 요약 한 줄 — '유효 3줄 · 약 1,024 IP'. 빈 목록은 '비어 있음'. */
export function listSummaryText(check) {
  if (!check || !check.valid.length) return check?.invalid?.length ? '유효한 줄 없음' : '비어 있음';
  return `유효 ${check.valid.length}줄 · 약 ${check.ipCount.toLocaleString()} IP`;
}

/** 서버가 준 오류 항목 한 줄 — '3행 ‘abc’ — 형식이 아닙니다'. */
export function lineIssueText(x) {
  return `${x.line}행 ‘${x.value}’ — ${x.reason}`;
}

/** 서버 400(invalid) 항목을 어디의 몇 행인지로 — vCenter 는 이름으로. */
export function serverInvalidText(x, vcName = (id) => id) {
  const where = x.vcenterId != null && x.vcenterId !== '' ? `${FIELD_LABEL[x.field] || x.field} · ${vcName(x.vcenterId)}` : (FIELD_LABEL[x.field] || x.field || '');
  return `${where} — ${lineIssueText(x)}`;
}

/**
 * vCenter 선택 목록 — 등록된 vCenter + **설정에만 남은(삭제된) vCenter**. 예전 선택기는 등록 목록만 보여 줘서
 * 삭제된 vCenter 에 남은 무시 대역을 보거나 지울 길이 없었다.
 * @returns {{ id: string, name: string, orphan: boolean, ignoreCount: number, dirty: boolean }[]}
 */
export function vcenterOptions(vcs, value, base, orphanIds = []) {
  const out = [];
  const seen = new Set();
  const push = (id, name, orphan) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name || id, orphan, ignoreCount: cleanLines(value?.vcenters?.[id]).length, dirty: vcDirty(value, base, id) });
  };
  for (const v of vcs || []) push(v.id, v.name, false);
  for (const id of orphanIds || []) push(id, id, true);
  // 초안에만 있는 키(삭제된 vCenter 에 입력하던 것) — 사라지면 저장 시 조용히 함께 나간다.
  for (const id of Object.keys(value?.vcenters || {})) if (cleanLines(value.vcenters[id]).length) push(id, id, true);
  return out;
}

/** 선택지 표시 글 — '● vc-seoul (무시 3)' · 삭제된 vCenter 는 '(삭제됨)'. */
export function vcenterOptionLabel(o) {
  return `${o.dirty ? '● ' : ''}${o.name}${o.orphan ? ' (삭제된 vCenter)' : ''}${o.ignoreCount ? ` · 무시 ${o.ignoreCount}` : ''}`;
}
