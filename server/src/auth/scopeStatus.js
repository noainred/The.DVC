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

/**
 * 엣지 주소 가림(v2.595, 감사 AUTHZ-2595-01): svcmon 엣지 요약의 `sourceIp`·`portalPort`(전 법인 엣지의 출발 IP·포트)는
 * admin + 전체 범위 계정에게만 준다 — v2.574 `/ping/edge/overview` 가 택한 기준과 같다(routes/ping.js redactEdgeAddresses).
 * 라우트를 막지 않고 주소만 비우며, 가린 사실을 호출부가 `addressHidden` 으로 밝힌다.
 * @param {Array} edges edgeSummary() 결과
 * @param {boolean} full admin 이면서 전체 범위인가
 */
export function redactEdgeSummary(edges, full) {
  if (full || !Array.isArray(edges)) return edges;
  return edges.map((e) => (e && typeof e === 'object' ? { ...e, sourceIp: null, portalPort: null } : e));
}

/**
 * 작업 로그 파일 경로 가림(v2.598, 감사 AUTHZ-2598-04): `scopeDbStatus` 와 같은 기준 — 절대 경로는 admin 에게만.
 * 그 밖에는 파일 이름만 남기고(무엇을 쓰는지는 말한다) `pathHidden:true` 로 가린 사실을 밝힌다.
 * @param {object} info 경로 필드를 가진 상태 객체(예: `{ max, file }`)
 * @param {object} user req.user
 * @param {string[]} keys 경로가 담긴 필드 이름
 */
export function scopeFilePaths(info, user, keys = ['file']) {
  if (!info || typeof info !== 'object' || user?.role === 'admin') return info;
  const out = { ...info };
  let hid = false;
  for (const k of keys) {
    if (typeof out[k] === 'string' && out[k]) {
      out[k] = out[k].split(/[\\/]/).filter(Boolean).pop() || null;
      hid = true;
    }
  }
  if (hid) out.pathHidden = true;
  return out;
}

/**
 * 엣지 → 중앙 push·pull 상태 축약(v2.598, 감사 AUTHZ-2598-03 — v2.595 vmseries `scopeVmSeriesPush` 의 형제).
 * `centralUrl`(중앙 주소)과 실패 원문(`last.error`·`last.errors[]` — 주소·경로가 섞인다)은 admin 에게만 준다.
 * 성패·시각·개수는 그대로 둔다(화면이 '보고가 되는가' 를 말하는 근거다). 가린 사실은 `addressHidden`.
 * ⚠ `centralUrl` 을 담는 다른 *Status(inventoryPush·idracScanWorker·scanner …)를 라우트에 실을 때도 이 헬퍼를 쓸 것.
 */
export const ADMIN_ONLY_TEXT = '(관리자만 확인)';
export function redactPushStatus(p, user) {
  if (!p || typeof p !== 'object' || user?.role === 'admin') return p;
  const out = { ...p, centralUrl: null, addressHidden: true };
  const l = p.last;
  if (l && typeof l === 'object') {
    out.last = {
      ...l,
      ...(l.error ? { error: ADMIN_ONLY_TEXT } : {}),
      ...(Array.isArray(l.errors) ? { errors: l.errors.map(() => ADMIN_ONLY_TEXT) } : {}),
    };
  }
  return out;
}
