/**
 * bareos/setupLocks.js — Bareos 서버에 root 로 쓰는 작업의 잠금(v2.845 — routes/api/bareosBackup.js 에서 옮김).
 *
 * Director 마다 한 번에 하나 + **같은 원격 주소도 하나**(v2.823 검토 S6·P10 — 서로 다른 Director 편집이 같은 서버의 공용 파일을 동시에 고치지 않게).
 * 자동 설정(bareosBackup) · v2.845 법인별 설정·계정(bareosManage) · 완전 설치(install/job — v2.844 반증 L3 · v2.846 C-3 그룹 잠금)가 같은 표를 쓴다.
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

/*
 * v2.846(Bareos 버그 점검 C-3 — 재현): 완전 설치는 `claimSetup('install:<id>', SSH 주소)` 하나만 쥐어 **Director id 와 러너가 읽은 서버 주소(hostAddr)**
 * 를 쥐지 않았다 — 재설치 원격 단계가 도는 수십 분 동안 같은 Director 의 자동 설정(주소 = hostAddr)과 Director 저장·삭제가 통과했다.
 * 그룹 잠금은 Director 여럿 · 주소 여럿을 **한 소유 키**로 한 번에 쥔다(하나라도 잡혀 있으면 아무것도 잡지 않는다). 위 단건 API 는 그대로다
 * (자동 설정 · 법인별 설정은 지금 시그니처로 그대로 막힌다 — 그룹이 쥔 Director 는 `_busy`, 주소는 소유 키가 달라 `setupBusyReason` 이 사유를 낸다).
 */
const _groups = new Map();   // 소유 키 → { dirs:Set, hosts:Set }
const SAME_HOST = '같은 서버에 다른 자동 설정 · 설정 변경 · 설치가 진행 중입니다 — 끝난 뒤 다시 시도하세요.';
const keysOf = ({ dirIds = [], hosts = [] } = {}) => ({ dirs: [...new Set(dirIds.filter(Boolean).map(String))], hks: [...new Set(hosts.map(hostKeyOf).filter(Boolean))] });
/** 그룹으로 잡을 수 있나 — 잡혀 있으면 사유('' = 비어 있음). */
export function setupGroupBusyReason(keys, owner = '') {
  const { dirs, hks } = keysOf(keys);
  for (const d of dirs) if (_busy.has(d) && !_groups.get(owner)?.dirs.has(d)) return setupBusyReason(d);
  // 그 그룹 자신이 쥔 주소만 비어 있는 것으로 본다(단건 claimSetup 이 같은 글자의 키로 쥔 주소는 남이 쥔 것)
  for (const h of hks) if (_hosts.has(h) && !_groups.get(owner)?.hosts.has(h)) return SAME_HOST;
  return '';
}
/** Director 여럿 · 주소 여럿을 owner 하나로 잡는다 — 이미 잡혀 있으면 false(아무것도 바꾸지 않는다). */
export function claimSetupGroup(owner, keys) {
  if (!owner || _groups.has(owner) || setupGroupBusyReason(keys)) return false;
  const { dirs, hks } = keysOf(keys);
  for (const d of dirs) _busy.add(d);
  for (const h of hks) _hosts.set(h, owner);
  _groups.set(owner, { dirs: new Set(dirs), hosts: new Set(hks) });
  return true;
}
/** 잡고 있는 그룹에 Director 를 더한다(완전 설치 4단계가 새 Director 를 등록한 순간) — 남이 쥐고 있으면 false. */
export function addSetupGroupDirector(owner, dirId) {
  const g = _groups.get(owner);
  if (!g || !dirId) return false;
  if (g.dirs.has(dirId)) return true;
  if (_busy.has(dirId)) return false;
  _busy.add(dirId); g.dirs.add(dirId);
  return true;
}
export function releaseSetupGroup(owner) {
  const g = _groups.get(owner);
  if (!g) return;
  for (const d of g.dirs) _busy.delete(d);
  for (const h of g.hosts) if (_hosts.get(h) === owner) _hosts.delete(h);
  _groups.delete(owner);
}
export function _resetForTest() { _busy.clear(); _hosts.clear(); _groups.clear(); }
