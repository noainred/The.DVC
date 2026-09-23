/**
 * auth/scopeStatus.js — 폴러 상태(`lastResult`)를 범위 계정에 맞게 깎는다(v2.583 — 감사 확정).
 *
 * 왜: v2.574 SEC-07(vmseries)·SEC-05(curuser activity) 가 같은 유형을 한 곳씩 고쳤는데 **형제 라우트가 남았다**
 * — `/tools/curuser`·`/tools/curuser/settings`·`/tools/curuser/activity`(inFlight 만 걸렀다) ·
 * `/tools/guest-disk`·`/tools/guest-disk/status`. 반증 에이전트 실측: vc 1개 범위 operator 가
 * `lastResult.users`(전 법인 접속 사용자 수 — `/history` 는 같은 값을 403 으로 막는다)·`vcenters=11`·
 * 범위 밖 vCenter id 와 수집 오류 문구를 받았다.
 *
 * 규칙(한 곳에서): 범위 계정이면 `lastResult` 에서 **vCenter id 가 붙은 목록만 걸러** 남기고, 전 법인 합계는
 * **싣지 않는다**(보이는 것만으로 다시 셀 수 있는 것만 다시 센다). 뺀 사실은 `scoped:true` 로 밝힌다.
 * 전체 범위(allowed === null)는 원본 그대로다.
 */
const vcOf = (x) => String(x?.vcenterId ?? x?.deviceId ?? x?.id ?? '');

export function scopePollerStatus(st, allowed, { lists = ['errors', 'skippedVcenters', 'per', 'skipped', 'authStopped'], keep = ['at', 'trigger', 'ms', 'mock', 'paused'] } = {}) {
  if (!st || typeof st !== 'object' || !allowed) return st;
  const out = { ...st, scoped: true };
  if (Array.isArray(st.inFlight)) out.inFlight = st.inFlight.filter((x) => allowed.has(vcOf(x)));
  const lr = st.lastResult;
  if (lr && typeof lr === 'object') {
    const next = {};
    for (const k of keep) if (lr[k] !== undefined) next[k] = lr[k];
    for (const k of lists) if (Array.isArray(lr[k])) next[k] = lr[k].filter((x) => x && typeof x === 'object' && allowed.has(vcOf(x)));
    next.scoped = true;
    out.lastResult = next;
  }
  return out;
}

/** DB 상태의 파일 경로는 관리자에게만(operator 는 tools 를 기본 보유 — '거부 기본값'). */
export function scopeDbStatus(db, user) {
  if (!db || typeof db !== 'object') return db;
  if (user?.role === 'admin') return db;
  const { path, ...rest } = db;
  void path;
  return rest;
}
