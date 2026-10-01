/**
 * statusBarText.js — 하단 상태바 개수(v2.675, 순수 — vitest).
 *
 * 첫 병합 전 골격(/health 의 initial — store.publishSkeleton)이면 호스트·VM·알람을 아직 하나도 읽지 않았다.
 * 예전에는 그 동안 '전체 호스트 0 · 전체 VM 0 (0 On) · 활성 알람 0' 이라고 말했다(v2.672 남은 일 — 첫 수집 중 화면의 0 표시).
 * /health 를 아직 받지 못한 경우도 0 이 아니라 '—' 다. 보고가 있으면 개수(카운터)는 0 이 정답이다.
 * App(개발 포탈·V4·V5 공용 상태바)과 V6 상태바가 같은 함수를 쓴다(판정을 두 벌 두지 않는다).
 */
export const FIRST_COLLECT_TITLE = '첫 수집 중 — 아직 읽지 않았습니다(끝나면 채워집니다)';

const f = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0).toLocaleString();

/** @returns {{hosts:string, vms:string, vmsOn:string, alarms:string, title:string|undefined, pending:boolean}} */
export function statusCounts(health) {
  if (!health || typeof health !== 'object') return { hosts: '—', vms: '—', vmsOn: '—', alarms: '—', title: undefined, pending: false };
  if (health.initial === true) return { hosts: '—', vms: '—', vmsOn: '—', alarms: '—', title: FIRST_COLLECT_TITLE, pending: true };
  return { hosts: f(health.hosts), vms: f(health.vms), vmsOn: f(health.vmsPoweredOn), alarms: f(health.alarms), title: undefined, pending: false };
}
