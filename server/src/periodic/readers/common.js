/**
 * periodic/readers/common.js — 리더 공용 도구(순수). 리더는 **저장된 것만 읽는다**(vCenter 로그인 · SSH · Director · 장비 호출 금지 —
 * periodicReport3320.test.js 가 readers/ 소스를 훑어 막는다).
 */
import { numOrNull } from '../../util/numOrNull.js';
import { unreadVcenterReasons } from '../../metrics/unreadVcenters.js';

/** 스냅샷을 vCenter 하나(또는 Set)로 자른다 — routes/api/shared.js scopeSlice 와 같은 거르기(사용자 범위 없이). 라우트 층을 import 하지 않으려고 둔다. */
export function sliceVc(snap, vc) {
  const picked = vc instanceof Set ? vc : new Set([String(vc)]);
  const pick = (arr) => (arr || []).filter((x) => picked.has(x?.vcenterId));
  return { ...snap, vcenters: (snap?.vcenters || []).filter((v) => picked.has(v.id)), hosts: pick(snap?.hosts), vms: pick(snap?.vms), datastores: pick(snap?.datastores), alarms: pick(snap?.alarms) };
}
/** 보고 대상 vCenter(꺼진 것 제외). */
export const activeVcs = (snap) => (snap?.vcenters || []).filter((v) => v && v.status !== 'disabled');
export const vcNameMap = (snap) => new Map((snap?.vcenters || []).map((v) => [v.id, v.name || v.id]));
const UNREAD_TEXT = Object.freeze({ maintenance: '점검중(수집 중단)', unreachable: '수집 실패', stale: '보고가 오래됨' });
/**
 * 수집 상태로 본 '이 vCenter 의 값을 믿을 수 없는 이유'(없으면 ''). 판정 본체는 공용 metrics/unreadVcenters.js 하나 — 사본을 두지 않는다.
 * 첫 수집 중(pending)은 공용 판정이 일부러 넣지 않는다(합계를 영원히 막지 않게) — 보고서에서는 '값이 아직 없다' 는 사유라 여기서 따로 붙인다.
 */
export function vcUnreadReason(v) {
  if (!v) return '등록에 없음';
  if (v.status === 'pending') return '첫 수집 중';
  const r = unreadVcenterReasons({ vcenters: [v] }).get(String(v.id));
  return r ? UNREAD_TEXT[r] || '수집 상태 확인 불가' : '';
}
/** 정수 표기(못 읽으면 '—'). */
export const n = (v) => { const x = numOrNull(v); return x == null ? '—' : x.toLocaleString('ko-KR'); };
/** 판정 하나 — 발견이 있으면 그 판정, 없고 확인 못 한 부분이 있으면 unknown(computeHealthReport withUnknown 과 같은 규칙), 아니면 ok. */
export function judge({ crit = 0, warn = 0, unknown = 0 } = {}) {
  if ((crit || 0) > 0) return 'crit';
  if ((warn || 0) > 0) return 'warn';
  if ((unknown || 0) > 0) return 'unknown';
  return 'ok';
}
/** 행 묶음 → 근거 글(나쁜 법인 수 · 확인 불가 수). */
export function rowsBasis(rows, noun = '법인') {
  const c = { crit: 0, warn: 0, unknown: 0, ok: 0 };
  for (const r of rows) if (c[r.status] != null) c[r.status]++;
  const parts = [];
  if (c.crit) parts.push(`이상 ${c.crit}곳`);
  if (c.warn) parts.push(`주의 ${c.warn}곳`);
  if (c.unknown) parts.push(`확인 불가 ${c.unknown}곳`);
  parts.push(`정상 ${c.ok}곳`);
  return `${noun} ${rows.length}곳 — ${parts.join(' · ')}`;
}
/** DataCenter(법인 등록) id → 법인 행 키. 리더는 { dc } 로 주면 assemble 이 그 법인의 vCenter 로 붙인다. */
export const dcRow = (dc, status, count, text) => ({ dc: dc || null, status, ...(count != null ? { count } : {}), text });
export const vcRow = (vc, status, count, text) => ({ vc, status, ...(count != null ? { count } : {}), text });
/** 가장 늦은 시각(못 읽으면 null). */
export const latest = (list) => { let m = null; for (const v of list) { const x = numOrNull(v); if (x != null && (m == null || x > m)) m = x; } return m; };
