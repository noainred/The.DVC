/**
 * bareos/setupLocks.js — Bareos 서버에 root 로 쓰는 작업의 잠금(v2.845 — routes/api/bareosBackup.js 에서 옮김).
 *
 * Director 마다 한 번에 하나 + **같은 원격 주소도 하나**(v2.823 검토 S6·P10 — 서로 다른 Director 편집이 같은 서버의 공용 파일을 동시에 고치지 않게).
 * 자동 설정(bareosBackup) · v2.845 법인별 설정·계정(bareosManage) · 완전 설치(install/job — v2.844 반증 L3)가 같은 표를 쓴다.
 * 단일 프로세스 메모리 표시다(포탈은 한 프로세스).
 */
const _busy = new Set();
const _hosts = new Map();   // 주소(소문자) → 소유 키

export const hostKeyOf = (h) => String(h || '').trim().toLowerCase();

/** 잡혀 있으면 사유 문자열('' = 비어 있음). */
export function setupBusyReason(dirId, host = '') {
  if (dirId && _busy.has(dirId)) return '이 Director 의 다른 자동 설정 · 설정 변경이 진행 중입니다 — 끝난 뒤 다시 시도하세요.';
  const hk = hostKeyOf(host);
  if (hk && _hosts.has(hk) && _hosts.get(hk) !== dirId) return '같은 서버에 다른 자동 설정 · 설정 변경 · 설치가 진행 중입니다 — 끝난 뒤 다시 시도하세요.';
  return '';
}
/** 잡는다 — 이미 잡혀 있으면 false(아무것도 바꾸지 않는다). */
export function claimSetup(dirId, host = '') {
  if (setupBusyReason(dirId, host)) return false;
  if (dirId) _busy.add(dirId);
  const hk = hostKeyOf(host);
  if (hk) _hosts.set(hk, dirId || `host:${hk}`);
  return true;
}
export function releaseSetupLock(dirId, host = '') {
  if (dirId) _busy.delete(dirId);
  for (const [h, id] of _hosts) if (id === dirId || (host && h === hostKeyOf(host) && id === `host:${h}`)) _hosts.delete(h);
}
export const isSetupBusy = (dirId) => _busy.has(dirId);
export function _resetForTest() { _busy.clear(); _hosts.clear(); }
