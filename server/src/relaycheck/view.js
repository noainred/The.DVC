/**
 * HAProxy 경로 점검 응답의 역할별 축약(v2.500 감사 M1) — 순수 함수.
 *
 * 왜 필요한가: v2.478(S9)은 `targets[].host/port` 만 admin 전용으로 가렸다. 그런데 라우트가
 * `relayCheckStatus()` 를 `...st` 로 그대로 펼쳐 내보내서 **같은 정보가 두 경로로 다시 나갔다**:
 *   · `settings.hosts[]` — 등록된 중계 엣지 호스트 전량
 *   · `results[].target.host/.port` — 점검 결과에 박힌 접속처
 *   · `targets[].key` 가 `"<host>:<port>"` — 가린 두 필드를 키에서 복원할 수 있었다
 *   · `results[].remedy/error/detail/got` — 조치 안내 문구에 내부 IP·포트가 들어간다
 * `GET /api/tools/relaycheck` 는 `requirePerm('tools')` 이고 operator 는 tools 를 기본 보유하므로,
 * operator 계정 하나로 전 사이트 중계 엣지 내부 IP·포워딩 포트 지도를 얻을 수 있었다.
 *
 * 규칙(relaytopo `stripCfg` 와 같은 '거부 기본값'): 비-admin 에게는 **무엇이 어떤 상태인가**만
 * 준다 — 라벨·사이트·종류·정상여부·응답시간. 어디로 붙는지(host/port)와 조치 안내(내부 주소 포함)는
 * admin 전용이다. 키는 원문을 해시해 상관관계만 유지한다(화면이 targets↔results 를 잇는 데 필요).
 *
 * 정직성: 가린 것은 숨기지 않고 `redacted: true` 로 알린다 — 화면이 "admin 권한이 필요합니다" 로
 * 설명할 수 있어야 사용자가 '기능이 고장났다'고 오해하지 않는다.
 */

import crypto from 'node:crypto';

/** 원문 키(host:port)를 되돌릴 수 없는 짧은 상관키로. 같은 입력 → 같은 출력(화면 상관관계 유지). */
export function opaqueKey(key) {
  return crypto.createHash('sha1').update(String(key || '')).digest('hex').slice(0, 12);
}

/** 비-admin 에게 줄 결과 1건. target 은 라벨 계열만 남긴다. */
function scrubResult(r = {}) {
  const t = r.target || {};
  return {
    // 상태(전이 판정)는 그대로 — failStreak/state 는 주소 정보가 없다.
    state: r.state, fails: r.fails, ok: r.ok, phase: r.phase, ms: r.ms, at: r.at,
    lastOkAt: r.lastOkAt, lastFailAt: r.lastFailAt,
    target: { key: opaqueKey(t.key), kind: t.kind, label: t.label, site: t.site },
    redacted: true,        // error/detail/remedy/host/port 를 뺐다는 사실을 밝힌다
  };
}

/**
 * 역할별 응답 조립.
 * @param st relayCheckStatus() 결과
 * @param targets buildTargets() 결과
 * @param isAdmin admin 인가
 */
export function relayCheckView(st = {}, targets = [], isAdmin = false) {
  if (isAdmin) {
    return {
      last: st.last, busy: st.busy, settings: st.settings, results: st.results, kinds: st.kinds,
      targets, redacted: false,
    };
  }
  const settings = st.settings || {};
  return {
    last: st.last,
    busy: st.busy,
    // hosts(등록 호스트 전량)를 빼고 개수만. 주기·프로필 포트는 구성 정보라 남긴다(주소가 아님).
    settings: {
      enabled: settings.enabled, intervalMs: settings.intervalMs, timeoutMs: settings.timeoutMs,
      failStreak: settings.failStreak, alerts: settings.alerts,
      profile: settings.profile, hostCount: Array.isArray(settings.hosts) ? settings.hosts.length : 0,
    },
    results: (st.results || []).map(scrubResult),
    kinds: st.kinds,
    targets: targets.map((t) => ({
      key: opaqueKey(t.key), kind: t.kind, label: t.label, site: t.site,
    })),
    redacted: true,
  };
}
