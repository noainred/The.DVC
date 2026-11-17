/**
 * 대역(subnet/range) 단위 IP 정책 저장소 — IP 단위 override(overrides.js)와 '평행'한
 * 저장소다. 한 대역(예: /24)을 통째로 'DHCP 풀'·'예약'·'폐기예정'으로 지정해, 254개를
 * 일일이 등록하지 않고 대역 기본 관리상태를 부여한다. 정책은 ledger 행을 '생성'하지 않고
 * 기존 행에 '오버레이'만 한다(목록 폭증 방지). 우선순위: IP override > 대역 정책 > 자동발견.
 *
 * 저장 위치: CONFIG_DIR/ipam-range-policies.json  { policies: [ {id, spec, ...} ] }
 *   - 같은 spec에 복수 정책을 허용하기 위해 spec이 아니라 'id'를 키로 한다.
 *   - spec은 저장 시 numeric [specLo, specHi]로 정규화해 영속(매칭 시 재파싱 불필요).
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { STATUSES, DEVICE_TYPES } from './overrides.js';
import { checkRangeSpec } from './rangeSyntax.js'; // v2.639 — 대역 문법 판정 코어 하나(scan.js 와 같은 판정)

const FILE = path.join(config.configDir, 'ipam-range-policies.json');
const MAX_POLICIES = 1000;     // 정책 수 상한
const IGNORE_CAP = 1024;       // status='ignored'(대역 통째 숨김) 허용 최대 IP 수(실수로 /16,/8 숨김 방지)

// 정책 상태 enum = override STATUSES와 동일(일관성). 'static'은 대역 정책에선 큰 의미 없지만 호환 유지.
export const POLICY_STATUSES = STATUSES;


/**
 * "10.0.0.0/24" | "10.0.0.1-10.0.0.50" | "10.0.0.1-50" | "10.0.0.5" → {lo,hi,size} (없으면 null). scan.js 규칙과 동일 —
 * CIDR 은 /31·/32 만 전체이고 그 외는 네트워크·브로드캐스트를 뺀다(/24 → .1~.254, size 254). 뒤집힌 범위는 null.
 * v2.639: 판정은 `rangeSyntax.checkRangeSpec` 하나다 — 예전 자체 파서는 `10.0.0.0/24.5`·`10.0.0.250-300` 같은 줄을
 * scan.js 와 다르게 읽어, 저장은 통과하고 중앙 `/ip-scan-result` 는 거부하는 어긋남을 만들었다.
 */
export function specToRange(spec) {
  const r = checkRangeSpec(spec, { reversed: 'error' });
  if (!r.ok) return null;
  const lo = r.kind === 'cidr' && r.size > 2 ? r.lo + 1 : r.lo;
  const hi = r.kind === 'cidr' && r.size > 2 ? r.hi - 1 : r.hi;
  return { lo, hi, size: hi - lo + 1 };
}

let cache = null;
let rev = 0;
/*
 * 115회차(107 F3 반증 — 재현): '다시 읽히면 리비전을 올려 캐시를 버린다' 는 load() 가 불려야 일어난다. 대장 재구성은 이 리비전(캐시 키)과
 *   매칭 인덱스(compileIndex — 캐시가 있으면 load 를 부르지 않는다)만 보므로, 정책 화면을 열거나 IP 스캔이 돌기 전까지 다시 읽힌 뒤에도 빈 정책으로
 *   계속 판정했다. 읽기 오류 중에는 리비전 조회 · 인덱스 조회도 load() 를 거친다(디스크는 30초 간격 — reader).
 */
export function policiesRev() { if (_readErr) load(); return rev; }
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'ipam-range-policies' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function rangePoliciesWriteRefusal() {
  load();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `IP 대역 정책 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}

function load() {
  if (cache) return cache;
  const was = _readErr;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return { policies: [] }; }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  cache = { policies: [] };
  try {
    if (rr.kind === 'ok') {
      const j = JSON.parse(rr.value);
      if (j && Array.isArray(j.policies)) cache = { policies: j.policies };
    }
  } catch (e) { preserveCorrupt(FILE, e.message); cache = { policies: [] }; }
  if (was) { rev++; _idx = null; _idxRev = -1; }   // 107회차: 읽기 오류 동안 빈 정책으로 만든 매칭 인덱스 · 대장 캐시를 버린다
  return cache;
}

function persist(data) {
  { const no = rangePoliciesWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다
  atomicWriteFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  cache = data; rev++;
  _idx = null; _idxRev = -1; // 컴파일 인덱스 무효화
}

const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

function clean(partial = {}) {
  const out = {};
  if (partial.status !== undefined) { const s = String(partial.status || '').trim().toLowerCase(); out.status = POLICY_STATUSES.includes(s) ? s : ''; }
  if (partial.owner !== undefined) out.owner = String(partial.owner || '').trim().slice(0, 200);
  if (partial.label !== undefined) out.label = String(partial.label || '').trim().slice(0, 200);
  if (partial.deviceType !== undefined) { const d = String(partial.deviceType || '').trim().toLowerCase(); out.deviceType = DEVICE_TYPES.includes(d) ? d : ''; }
  if (partial.note !== undefined) out.note = String(partial.note || '').trim().slice(0, 1000);
  if (partial.claimedVcenterId !== undefined) out.claimedVcenterId = String(partial.claimedVcenterId || '').trim().slice(0, 120);
  if (partial.priority !== undefined) out.priority = clampInt(partial.priority, 0, 1000, 100);
  if (partial.enabled !== undefined) out.enabled = partial.enabled !== false;
  return out;
}

/** 전체 정책 목록(복제). */
export function getPolicies() { return load().policies.map((p) => ({ ...p })); }
/** 한 정책(id). */
export function getPolicy(id) { return load().policies.find((p) => p.id === id) || null; }

/**
 * 정책 생성/수정. id가 있으면 수정(생성 필드 보존), 없으면 신규(uuid 부여).
 * spec은 필수·유효해야 하고, status='ignored'는 IGNORE_CAP 이하 대역만 허용.
 * { ok, policy } 또는 { ok:false, reason }.
 */
export function setPolicy(partial = {}, user) {
  { const no = rangePoliciesWriteRefusal(); if (no) return no; }   // 107회차
  const data = load();
  const spec = String(partial.spec ?? '').trim();
  const id = partial.id ? String(partial.id) : '';
  const existing = id ? data.policies.find((p) => p.id === id) : null;
  if (id && !existing) return { ok: false, reason: '대상 정책을 찾을 수 없습니다.' };

  // spec 결정(수정 시 미지정이면 기존 유지)
  const effSpec = spec || existing?.spec || '';
  const range = specToRange(effSpec);
  if (!range) return { ok: false, reason: '유효한 대역(CIDR/범위/IP)이 아닙니다.' };

  const fields = clean(partial);
  const next = {
    id: existing?.id || crypto.randomUUID(),
    spec: effSpec, specLo: range.lo, specHi: range.hi, specSize: range.size,
    status: fields.status ?? existing?.status ?? '',
    priority: fields.priority ?? existing?.priority ?? 100,
    claimedVcenterId: fields.claimedVcenterId ?? existing?.claimedVcenterId ?? '',
    owner: fields.owner ?? existing?.owner ?? '',
    label: fields.label ?? existing?.label ?? '',
    deviceType: fields.deviceType ?? existing?.deviceType ?? '',
    note: fields.note ?? existing?.note ?? '',
    enabled: fields.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    createdBy: existing?.createdBy || (user?.username || 'unknown'),
    updatedAt: new Date().toISOString(),
    updatedBy: user?.username || 'unknown',
  };
  if (next.status === 'ignored' && next.specSize > IGNORE_CAP) {
    return { ok: false, reason: `대역 통째 숨김(ignored)은 ${IGNORE_CAP}개 이하 대역만 허용합니다(현재 ${next.specSize}개).` };
  }
  if (!existing && data.policies.length >= MAX_POLICIES) return { ok: false, reason: `정책은 최대 ${MAX_POLICIES}개까지입니다.` };

  const policies = existing
    ? data.policies.map((p) => (p.id === next.id ? next : p))
    : [...data.policies, next];
  persist({ policies });
  return { ok: true, policy: next };
}

/** 정책 삭제(id). */
export function deletePolicy(id) {
  { const no = rangePoliciesWriteRefusal(); if (no) return no; }   // 107회차
  const data = load();
  const policies = data.policies.filter((p) => p.id !== id);
  if (policies.length === data.policies.length) return { ok: false, reason: '없는 정책' };
  persist({ policies });
  return { ok: true };
}

// ---- 매칭 인덱스(컴파일) ----------------------------------------------------
// policiesRev() 기준 메모이즈 — 정책이 바뀔 때만 재컴파일. lo asc → specSize asc → priority desc.
let _idx = null;
let _idxRev = -1;
function compileIndex() {
  if (_readErr) load();   // 115회차: 읽기 오류 중 만든 빈 인덱스에 머물지 않는다(다시 읽히면 load 가 rev 를 올리고 인덱스를 버린다)
  if (_idx && _idxRev === rev) return _idx;
  _idx = load().policies.filter((p) => p.enabled !== false && Number.isInteger(p.specLo))
    .map((p) => ({ lo: p.specLo, hi: p.specHi, size: p.specSize, priority: p.priority ?? 100, policy: p }))
    .sort((a, b) => (a.lo - b.lo) || (a.size - b.size) || (b.priority - a.priority));
  _idxRev = rev;
  return _idx;
}

/**
 * 이 IP 가 **어떤 활성 정책이든** 덮는지(vCenter 귀속 무관, v2.287 확정 버그 #11).
 * findPolicy(ip, '') 는 claimedVcenterId 가 붙은(특정 법인 귀속) 정책을 스코프 불일치로 건너뛰므로,
 * '이 IP 가 운영자 관리 대상인가'(스캔 결과/이력 보존 판단)를 물을 때 쓰면 귀속 정책으로만
 * 관리되는 IP 가 '미관리'로 오판돼 보존기간 후 스캔 결과·이력이 삭제된다. 관리 여부 판단에는
 * 이 함수(귀속 무시)를 쓴다.
 */
export function isCoveredByAnyPolicy(ipNum) {
  if (ipNum == null) return false;
  for (const it of compileIndex()) {
    if (it.lo > ipNum) break;          // lo asc 정렬 → 이후 전부 불일치
    if (ipNum <= it.hi) return true;   // 귀속(claimedVcenterId) 여부와 무관하게 커버되면 관리 대상
  }
  return false;
}

/**
 * 한 IP(ipNum)에 적용할 '단일 승자' 정책을 반환(없으면 null).
 * 겹치는 정책은 '좁은 대역 우선 → priority 높은 것' tiebreak로 결정적 단일 승자.
 * vcenterId 스코프: 전역('') 정책은 항상, 귀속 정책은 그 vCenter 뷰에서만.
 */
export function findPolicy(ipNum, vcenterId) {
  if (ipNum == null) return null;
  const idx = compileIndex();
  let best = null; let bestScore = -Infinity;
  for (const it of idx) {
    if (it.lo > ipNum) break;            // lo asc 정렬 → 이후 전부 불일치
    if (ipNum > it.hi) continue;         // 이 정책 위쪽이지만 더 넓은 정책이 뒤에 올 수 있음
    const p = it.policy;
    if (p.claimedVcenterId && p.claimedVcenterId !== vcenterId) continue; // 스코프 불일치(전역 '' 은 통과)
    // 좁을수록·priority 높을수록 큰 점수(specSize<=2^24, priority<=1000 → 안전)
    const score = (0x40000000 - it.size) * 2000 + it.priority;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

/**
 * 정책 요약(상태별·vCenter별·커버 IP 수) — 대시보드/관리 UI용.
 * `list` 를 주면 그 목록으로 집계한다(범위 제한 계정에 스코프된 정책만 요약해 byVcenter 로 타
 * vCenter id·전역 정책 수가 열거되지 않게 — 라우트가 필터한 목록을 넘긴다). 미지정=전체(기존).
 */
export function policiesSummary(list = null) {
  if (!list) list = load().policies;
  const byStatus = {}; const byVcenter = {};
  let coverageIps = 0; let enabledN = 0;
  for (const p of list) {
    if (p.status) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    const vk = p.claimedVcenterId || '(전역)';
    byVcenter[vk] = (byVcenter[vk] || 0) + 1;
    if (p.enabled !== false) { coverageIps += (p.specSize || 0); enabledN++; }
  }
  return { total: list.length, enabled: enabledN, byStatus, byVcenter, coverageIps };
}
