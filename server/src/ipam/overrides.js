/**
 * Per-IP 수동 관리(override) 저장소 — vCenter/스캔으로 자동 발견되는 정보와 별개로,
 * 운영자가 IP 단위로 직접 부여하는 '관리 상태'를 보관한다. 스냅샷 새로고침과 무관하게
 * 영속되며(주석/메모와 동일 패턴), IP 대장(ledger)이 병합해 표시한다.
 *
 * 저장 위치: CONFIG_DIR/ipam-overrides.json, IP 주소를 키로 한다.
 * 레코드 필드:
 *   status        '' | 'active' | 'reserved' | 'deprecated' | 'dhcp' | 'static' | 'ignored'
 *                 (ignored = 대장에서 숨김. 그 외는 배지로 표시)
 *   owner         담당자/팀
 *   label         사용자 지정 이름(자동 hostname 대신 표시)
 *   deviceType    'vm'|'host'|'switch'|'router'|'firewall'|'storage'|'idrac'|'printer'|'server'|'other'
 *   hostnameOverride  자동 hostname을 덮어쓸 이름
 *   reservedUntil ISO 문자열 — 예약 만료 시각(없으면 무기한)
 *   note          한 줄 비고(메모/태그는 annotations.js가 담당, 여기는 상태성 비고)
 *   updatedAt/updatedBy
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { isIpv4 } from './scan.js';
import { canonIp } from '../util/ipv4.js';
import { DAY_MS, DAY_OFFSET_MIN, dayStartMs, dayKey } from '../util/dayKey.js';


const FILE = path.join(config.configDir, 'ipam-overrides.json');
const MAX_BATCH = 10_000; // 일괄 적용 IP 상한(대량 입력 DoS/오염 방지)

export const STATUSES = ['active', 'reserved', 'deprecated', 'dhcp', 'static', 'ignored'];
export const DEVICE_TYPES = ['vm', 'host', 'switch', 'router', 'firewall', 'storage', 'idrac', 'printer', 'server', 'loadbalancer', 'appliance', 'other'];

let cache = null;
let rev = 0; // override 변경 리비전(대장 캐시 무효화 키)
export function overridesRev() { return rev; }

function load() {
  if (cache) return cache;
  cache = {};
  try { if (fs.existsSync(FILE)) cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { preserveCorrupt(FILE, e.message); cache = {}; }
  return cache;
}

/** 전체 맵 { ip: {status, owner, label, deviceType, hostnameOverride, reservedUntil, note, updatedAt, updatedBy} }. */
export function getOverrides() { return load(); }

/** 한 IP의 override, 없으면 null. */
export function getOverride(ip) { const d = load(); return d[canonIp(ip) || String(ip)] || d[String(ip)] || null; }

/**
 * 예약 만료 입력 → ISO(v2.630 A2-05). 화면은 날짜만(<input type=date> 'YYYY-MM-DD') 보낸다. ECMAScript 는 그 형태를
 * **UTC 자정**으로 읽어 한국 시각 오전 9시에 '만료' 가 됐다. '10/1 까지 예약' 은 그 날 끝까지이므로
 * **포탈 오프셋(util/dayKey) 기준 다음 날 00:00** 으로 저장한다(ledger 의 `due < now` 가 그 날 하루 동안 예약으로 본다).
 * 시각까지 준 값(ISO 등)은 예전처럼 그대로 해석한다. 읽지 못하면 null.
 */
export function reservedUntilIso(v, offsetMin = DAY_OFFSET_MIN) {
  const str = String(v ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) {
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const back = new Date(utc);
    if (Number.isNaN(utc) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
    return new Date(dayStartMs(utc / DAY_MS + 1, offsetMin)).toISOString();
  }
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/**
 * 저장된 예약 만료(ISO) → 사람이 고른 '그 날'('YYYY-MM-DD', 포탈 오프셋 기준) — v2.631(감사 R2631-02·A6-2631-02).
 * reservedUntilIso 는 '그 날 끝 = 다음 날 00:00' 을 저장하므로 **저장 시각 − 1ms** 의 포탈 날짜가 입력한 날이다.
 * 화면이 ISO 를 slice(0,10)(UTC 날짜)로 되읽으면 오프셋 ≤ 0 현장에서 저장할 때마다 하루씩 밀렸다. 읽지 못하면 ''.
 * 이미 'YYYY-MM-DD' 면 그대로(구 저장값·입력값).
 */
export function reservedUntilDay(v, offsetMin = DAY_OFFSET_MIN) {
  if (v == null || v === '') return '';
  const str = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const t = Date.parse(str);
  if (!Number.isFinite(t)) return '';
  return dayKey(t - 1, offsetMin) || '';
}

function clean(partial = {}) {
  const out = {};
  if (partial.status !== undefined) {
    const s = String(partial.status || '').trim().toLowerCase();
    out.status = STATUSES.includes(s) ? s : '';
  }
  if (partial.owner !== undefined) out.owner = String(partial.owner || '').trim().slice(0, 200);
  if (partial.label !== undefined) out.label = String(partial.label || '').trim().slice(0, 200);
  if (partial.deviceType !== undefined) {
    const d = String(partial.deviceType || '').trim().toLowerCase();
    out.deviceType = DEVICE_TYPES.includes(d) ? d : '';
  }
  if (partial.hostnameOverride !== undefined) out.hostnameOverride = String(partial.hostnameOverride || '').trim().slice(0, 253);
  if (partial.claimedVcenterId !== undefined) out.claimedVcenterId = String(partial.claimedVcenterId || '').trim().slice(0, 120);
  if (partial.note !== undefined) out.note = String(partial.note || '').trim().slice(0, 1000);
  if (partial.reservedUntil !== undefined) {
    const v = partial.reservedUntil;
    if (!v) out.reservedUntil = null;
    else out.reservedUntil = reservedUntilIso(v);
  }
  return out;
}

// 의미 있는 값이 하나도 없으면 레코드를 제거(빈 껍데기 방지).
function isEmpty(rec) {
  return !rec || (!rec.status && !rec.owner && !rec.label && !rec.deviceType
    && !rec.hostnameOverride && !rec.note && !rec.reservedUntil && !rec.claimedVcenterId);
}

function persist(data) {
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  cache = data; rev++;
}

/**
 * 한 IP의 override를 생성/수정/삭제. 부분 업데이트(주어진 필드만 갱신).
 * 모든 필드가 비면 레코드 삭제. { ok, override } 반환.
 */
export function setOverride(ip, partial = {}, user) {
  const raw = String(ip || '').trim();
  const key = canonIp(raw);
  if (!key) return { ok: false, reason: '유효한 IPv4 주소가 아닙니다.' };
  const data = load();
  const prev = data[key] || (raw !== key ? data[raw] : null) || {};
  if (raw !== key && data[raw]) delete data[raw];   // 예전에 원문 키로 저장된 유령 항목을 정규 키로 옮긴다
  const next = { ...prev, ...clean(partial) };
  delete next.updatedAt; delete next.updatedBy;
  if (isEmpty(next)) {
    if (data[key]) { delete data[key]; persist(data); }
    return { ok: true, override: null };
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = user?.username || 'unknown';
  data[key] = next;
  persist(data);
  return { ok: true, override: next };
}

/** 한 IP의 override 완전 삭제. */
export function clearOverride(ip) {
  const raw = String(ip || '').trim();
  const key = canonIp(raw) || raw;
  const data = load();
  let hit = false;
  for (const k of new Set([raw, key])) if (data[k]) { delete data[k]; hit = true; }
  if (hit) persist(data);
  return { ok: true };
}

/** v2.744(감사 WEB-02): 무효 토큰 목록을 응답에 실을 때의 상한(전체 개수는 invalidCount 로 따로 밝힌다). */
export const INVALID_SHOW_MAX = 50;

/**
 * v2.744(감사 WEB-02 — 재현): 일괄 적용 대상 판정 — 라우트(사전 거부)·setOverrideBatch·웹 사본(web/src/views/tools/ipamBulkText.js)이
 * 같은 규칙을 쓴다. 토큰 = 공백·쉼표로 나눈 조각(배열 입력은 원소마다 다듬는다). 정규형(canonIp — 단건 PUT 과 같은 판정)이 null 이면
 * 무효다. 예전에는 무효 토큰을 filter(Boolean) 으로 조용히 버리고 나머지만 적용해, 화면은 '성공' 으로 창을 닫았다
 * (10.250.1.300 · 10.250.1 같은 오타 IP 에 예약 기록이 남지 않는다 — 다른 사람이 같은 주소를 할당할 수 있다).
 * @returns {{tokens:string[], ips:string[], invalid:string[]}} tokens = 다듬은 원문 전부(중복 포함), ips = 정규형·중복 제거,
 *   invalid = 무효 원문·중복 제거(입력 순서)
 */
export function splitBatchIps(ips) {
  const tokens = (Array.isArray(ips) ? ips : String(ips ?? '').split(/[\s,]+/))
    .map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  const seen = new Set(); const ipsOut = []; const bad = new Set();
  for (const t of tokens) {
    const k = canonIp(t);
    if (!k) { bad.add(t); continue; }
    if (!seen.has(k)) { seen.add(k); ipsOut.push(k); }
  }
  return { tokens, ips: ipsOut, invalid: [...bad] };
}

/** v2.744(감사 WEB-02): 무효 토큰이 있으면 전체를 거부하는 응답 본문(라우트·setOverrideBatch rejectInvalid 공용). 없으면 null. */
export function invalidBatchResult(invalid) {
  // 각 토큰은 64자로 줄여 싣는다(붙여넣은 긴 문자열이 응답·화면을 덮지 않게 — 개수는 그대로 밝힌다).
  const list = (Array.isArray(invalid) ? invalid : []).map((t) => { const v = String(t); return v.length > 64 ? `${v.slice(0, 63)}…` : v; });
  if (!list.length) return null;
  const head = list.slice(0, 5).join(', ');
  const more = list.length > 5 ? ` 외 ${list.length - 5}개` : '';
  return {
    ok: false,
    reason: `IPv4 주소가 아닌 값이 ${list.length}개 있습니다(${head}${more}). 고친 뒤 다시 적용하세요 — 전체를 적용하지 않았습니다.`,
    invalid: list.slice(0, INVALID_SHOW_MAX), invalidCount: list.length,
  };
}

/**
 * 여러 IP에 같은 변경을 일괄 적용(예: 한 대역을 모두 'reserved'로). 단일 쓰기.
 * ips: string[] | "a,b\nc" — 반환 { ok, changed }(무효 토큰이 있었으면 invalid·invalidCount 도 — 조용히 버리지 않는다).
 * v2.744(감사 WEB-02): opts.rejectInvalid 면 무효 토큰이 하나라도 있을 때 아무것도 쓰지 않고 거부한다(라우트는 이 판정을 먼저 한다).
 */
export function setOverrideBatch(ips, partial = {}, user, opts = {}) {
  const { ips: list, invalid } = splitBatchIps(ips); // 유효 IPv4만(정규형 — v2.594), 중복 제거
  if (opts?.rejectInvalid) { const bad = invalidBatchResult(invalid); if (bad) return bad; }
  if (!list.length) return { ok: false, reason: '유효한 대상 IP가 없습니다.', ...(invalid.length ? { invalid: invalid.slice(0, INVALID_SHOW_MAX), invalidCount: invalid.length } : {}) };
  if (list.length > MAX_BATCH) return { ok: false, reason: `한 번에 ${MAX_BATCH}개까지만 일괄 적용할 수 있습니다.` };
  const data = load();
  const patch = clean(partial);
  const now = new Date().toISOString();
  const by = user?.username || 'unknown';
  let changed = 0;
  for (const ip of list) {
    const prev = data[ip] || {};
    const next = { ...prev, ...patch };
    delete next.updatedAt; delete next.updatedBy;
    if (isEmpty(next)) { if (data[ip]) { delete data[ip]; changed++; } continue; }
    next.updatedAt = now; next.updatedBy = by;
    data[ip] = next; changed++;
  }
  if (changed) persist(data);
  return { ok: true, changed, ...(invalid.length ? { invalid: invalid.slice(0, INVALID_SHOW_MAX), invalidCount: invalid.length } : {}) };
}

/**
 * v2.636: IP 마다 **다른** 변경을 한 번에 적용(CSV 가져오기). setOverride 를 행마다 부르면 행마다 파일을 원자 쓰기한다
 * (1만 행 = 1만 번 fsync) — 여기서는 메모리에서 모두 적용하고 **한 번** 쓴다. 규칙은 setOverride 와 같다(부분 갱신,
 * 비면 레코드 삭제, 정규형 키, 원문 키 유령 이전). 판정(값 검증·범위)은 호출부(manageCsv.analyzeManageImport)가 끝낸 뒤다.
 * @param {{ip:string, partial:object}[]} entries
 * @returns {{ok:true, changed:number, removed:number}}
 */
export function setOverridesMany(entries, user) {
  const data = load();
  const now = new Date().toISOString();
  const by = user?.username || 'unknown';
  let changed = 0; let removed = 0;
  for (const e of entries || []) {
    const raw = String(e?.ip || '').trim();
    const key = canonIp(raw);
    if (!key) continue;
    const prev = data[key] || (raw !== key ? data[raw] : null) || {};
    if (raw !== key && data[raw]) delete data[raw];
    const next = { ...prev, ...clean(e.partial || {}) };
    delete next.updatedAt; delete next.updatedBy;
    if (isEmpty(next)) { if (data[key]) { delete data[key]; removed++; } continue; }
    next.updatedAt = now; next.updatedBy = by;
    data[key] = next; changed++;
  }
  if (changed || removed) persist(data);
  return { ok: true, changed, removed };
}

/** 관리 상태 요약(상태별·디바이스별 개수) — 대시보드용. */
/**
 * override 요약(총계·상태/디바이스 분포). `includeFn(ip, rec)` 를 주면 그 조건을 통과한 override
 * 만 집계한다 — 범위 제한 계정에 자기 범위 밖 override 의 집계(총계/분포)까지 흘리지 않기 위함
 * (policiesSummary 의 스코프 목록 전달과 대칭). 미지정=전체(admin/기존 동작).
 */
export function overridesSummary(includeFn = null) {
  const data = load();
  const byStatus = {}; const byDevice = {};
  let total = 0;
  for (const [ip, rec] of Object.entries(data)) {
    if (includeFn && !includeFn(ip, rec)) continue;
    total++;
    if (rec.status) byStatus[rec.status] = (byStatus[rec.status] || 0) + 1;
    if (rec.deviceType) byDevice[rec.deviceType] = (byDevice[rec.deviceType] || 0) + 1;
  }
  return { total, byStatus, byDevice };
}
