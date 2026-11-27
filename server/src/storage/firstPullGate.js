/**
 * storage/firstPullGate.js — '엣지의 첫 설정 pull 이 끝났는가' 를 폴러에 알려 주는 작은 관문(v3.41.1 버그 점검 2회차).
 *
 * 왜: 중앙이 배포한 값(수집 주기 · PowerScale SSH 명령 대기)은 엣지 **메모리에만** 있어 재시작 직후에는 env·기본값이다. 주기는 늦게 먹어도
 *   탈이 없지만 **시한**은 다르다 — 중앙이 5분으로 올려 둔 느린 클러스터가 첫 수집을 기본 3분으로 돌면 '실패' 로 남는다(다음 수집 주기까지).
 *   1회차는 엣지의 첫 수집을 통째로 40초로 미뤘는데, 그러면 첫 push(45초)·첫 노드 부하 표본(40초)과 순서가 뒤집혀 새 스냅샷이 push 한 주기
 *   늦게 올라가고 첫 표본이 건너뛰어졌다(2회차 N1·N2). 그래서 **평소에는 예전 시각(15초) 그대로** 두고, 첫 pull 이 아직 안 끝났을 때만
 *   그 끝(또는 상한)을 기다린다.
 *
 * 폴러가 `agent/storageConfigPull.js` 를 직접 import 하면 순환이다(그쪽이 폴러의 collectDeviceNow 를 쓴다) — 그래서 둘 사이에 이 파일을 둔다.
 * 아무것도 import 하지 않는다.
 */
let _settled = false;
const _waiters = new Set();

/** 첫 설정 pull 시도가 끝났다(성공·실패 무관 — 실패면 기다려도 값은 오지 않는다). 여러 번 불러도 된다. */
export function markFirstConfigPullSettled() {
  if (_settled) return;
  _settled = true;
  for (const w of [..._waiters]) { try { w(); } catch { /* 대기자 하나가 나머지를 막지 않게 */ } }
  _waiters.clear();
}

/** 첫 pull 이 끝났으면 곧바로 true, 아니면 끝날 때 true · `capMs` 가 먼저 지나면 false(기다리다 수집을 영영 못 하는 일이 없게 — 상한 필수). */
export function whenFirstConfigPullSettled(capMs) {
  if (_settled) return Promise.resolve(true);
  const cap = Number.isFinite(Number(capMs)) && Number(capMs) > 0 ? Number(capMs) : 0;
  if (!cap) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(true); };
    // unref 하지 않는다 — 이 대기를 await 하는 쪽(폴러의 첫 틱)이 반드시 풀려야 한다(다른 핸들이 없는 프로세스에서는 unref 한 타이머만 남으면
    //   이벤트 루프가 끝나 await 가 영영 풀리지 않는다 — 테스트에서 재현). 상한이 짧아(수십 초) 종료를 붙잡을 일도 없다.
    const t = setTimeout(() => { _waiters.delete(done); resolve(false); }, cap);
    _waiters.add(done);
  });
}

export function firstConfigPullSettled() { return _settled; }
/** 테스트 전용 */
export function _resetForTest() { _settled = false; _waiters.clear(); }
