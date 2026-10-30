/**
 * bareos/jobLocks.js — 백업 대상(원장 잡)마다 한 번에 하나(v2.822 B2 의 oneAtATime 잠금을 v2.830 에 공용으로 뺐다).
 *
 * 실행·복원·취소·활성 전환·삭제(라우트)와 백업 그룹 실행(groupRunner)이 **같은 잠금**을 쓴다 — 그룹이 실행을 보내는 사이
 * 같은 대상을 지우면(원장에서 사라진 잡에 pending 을 적거나, 지운 잡을 실행) 원장과 Director 가 어긋났다.
 * 단일 프로세스 메모리 표시다(포탈은 한 프로세스 — 원장 파일도 이 프로세스만 쓴다).
 */
const _busy = new Set();

/** 잡았으면 true(이미 잡혀 있으면 false — 줄 세우지 않는다). */
export function tryLockJob(id) {
  if (!id || _busy.has(id)) return false;
  _busy.add(id);
  return true;
}
export function unlockJob(id) { _busy.delete(id); }
export function isJobLocked(id) { return _busy.has(id); }
export function _resetJobLocksForTest() { _busy.clear(); }
