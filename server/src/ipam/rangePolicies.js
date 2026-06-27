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
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { STATUSES, DEVICE_TYPES } from './overrides.js';

const FILE = path.join(config.configDir, 'ipam-range-policies.json');
const MAX_POLICIES = 1000;     // 정책 수 상한
const IGNORE_CAP = 1024;       // status='ignored'(대역 통째 숨김) 허용 최대 IP 수(실수로 /16,/8 숨김 방지)

// 정책 상태 enum = override STATUSES와 동일(일관성). 'static'은 대역 정책에선 큰 의미 없지만 호환 유지.
export const POLICY_STATUSES = STATUSES;

const ipToNum = (s) => { const p = String(s).split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) : null; };

/** "10.0.0.0/24" | "10.0.0.1-10.0.0.50" | "10.0.0.1-50" | "10.0.0.5" → {lo,hi,size} (없으면 null). scan.js 규칙과 동일. */
export function specToRange(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  if (s.includes('/')) {
    const [base, bitsStr] = s.split('/');
    const bits = Number(bitsStr); const b = ipToNum(base);
    if (b == null || !(Number.isInteger(bits) && bits >= 8 && bits <= 32)) return null;
    const size = 2 ** (32 - bits);
    const net0 = b & (size === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0));
    const start = bits >= 31 ? 0 : 1;          // /31·/32는 전체, 그 외는 네트워크/브로드캐스트 제외
    const end = bits >= 31 ? size : size - 1;  // exclusive upper index
    const lo = (net0 + start) >>> 0;
    const hi = (net0 + end - 1) >>> 0;
    return { lo, hi, size: hi - lo + 1 };
  }
  if (s.includes('-')) {
    const [a, bRaw] = s.split('-').map((x) => x.trim());
    const an = ipToNum(a); let bn = ipToNum(bRaw);
    if (bn == null && /^\d{1,3}$/.test(bRaw) && an != null) bn = (an & 0xffffff00) + Number(bRaw); // a.b.c.d-e 단축형
    if (an == null || bn == null || bn < an) return null;
    return { lo: an, hi: bn, size: bn - an + 1 };
  }
  const n = ipToNum(s);
  if (n == null) return null;
  return { lo: n, hi: n, size: 1 };
}

let cache = null;
let rev = 0;
export function policiesRev() { return rev; }

function load() {
  if (cache) return cache;
  cache = { policies: [] };
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (j && Array.isArray(j.policies)) cache = { policies: j.policies };
    }
  } catch { cache = { policies: [] }; }
  return cache;
}

function persist(data) {
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
  if (_idx && _idxRev === rev) return _idx;
  _idx = load().policies.filter((p) => p.enabled !== false && Number.isInteger(p.specLo))
    .map((p) => ({ lo: p.specLo, hi: p.specHi, size: p.specSize, priority: p.priority ?? 100, policy: p }))
    .sort((a, b) => (a.lo - b.lo) || (a.size - b.size) || (b.priority - a.priority));
  _idxRev = rev;
  return _idx;
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

/** 정책 요약(상태별·vCenter별·커버 IP 수) — 대시보드/관리 UI용. */
export function policiesSummary() {
  const list = load().policies;
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
