/**
 * views/tools/sanPortsScopeText.js — 엣지 스위치의 **포트 전송 범위** 안내 문구(v2.517, 순수 모듈).
 *
 * 사용자 요청 "전체 포트 보는 것으로 기능 개선" 으로 엣지 push 기본이 전체 포트가 됐다
 * (`server/src/sanswitch/push.js` 머리말 — gzip 실측 근거: 128포트 × 8대 = 원본 408KB · gzip 12KB).
 *
 * ⚠ **'전체를 받았다' 고 단정하지 말 것.** 세 경우가 다르고, 화면은 그것을 구분해야 한다:
 *   ① 구버전 엣지 — `portsScope` 필드 자체가 없다. 문제 포트만 왔고 **엣지를 올려야** 전체가 온다.
 *   ② 현장이 되돌림 — 그 엣지가 `SANSW_PUSH_PORTS=problem` 이다(회선이 좁은 법인의 탈출구).
 *   ③ 크기 가드 — 전체가 1회 전송 상한을 넘어 그 장비만 자동으로 떨어졌다(`portsScopeReason`).
 * ①②는 겉으로 같아 보이지만 조치가 다르다. 사유가 오면 그것을 그대로 보여준다.
 *
 * 중앙 직접 수집 장비(`agent` 없음)는 축약 자체가 없으므로 배너를 띄우지 않는다.
 */

/**
 * @param {object} p
 * @param {string} p.agent        이 스위치를 수집하는 엣지 이름(없으면 중앙 직접)
 * @param {object} p.ports        스냅샷의 ports 요약 { portsScope, portsOmitted, portsScopeReason, total }
 * @returns {null | { tone:'info'|'warn', text:string, action:string|null }}
 *   null = 배너를 띄우지 않는다(정상 — 전체를 받았거나 중앙 직접 수집)
 */
export function portsScopeNote({ agent = '', ports = null } = {}) {
  const a = String(agent || '').trim();
  const p = ports || {};
  const omitted = Number(p.portsOmitted) || 0;
  const scope = p.portsScope || null;

  // 중앙 직접 수집은 축약 경로를 타지 않는다.
  if (!a) return null;
  // 전체를 받았고 뺀 것이 없으면 알릴 것이 없다.
  if (scope === 'full' && omitted === 0) return null;
  // 뺀 것도 없고 범위도 모르면(구버전 엣지가 문제 포트 0개를 보낸 경우) 단정하지 않는다.
  if (omitted === 0 && !scope) return null;

  if (p.portsScopeReason) {
    return {
      tone: 'warn',
      text: `⚠ 이 스위치는 엣지 '${a}' 가 수집하는데, ${p.portsScopeReason} — 정상 포트 ${omitted}개는 여기 표에 없습니다(요약 수치는 전체 기준으로 정확합니다).`,
      action: '포트 수가 많은 장비입니다. 그 엣지의 SANSW_PUSH_DEVICE_MAX_BYTES 를 올리면 전체가 올라옵니다.',
    };
  }
  if (scope === 'problem') {
    return {
      tone: 'warn',
      text: `⚠ 이 스위치는 엣지 '${a}' 가 **문제 포트만** 올리도록 설정돼 있습니다 — 정상 포트 ${omitted}개는 여기 표에 없습니다(요약 수치는 전체 기준으로 정확합니다).`,
      action: `전체 포트를 보려면 엣지 '${a}' 의 portal.env 에서 SANSW_PUSH_PORTS 를 지우고 재시작하세요(기본이 전체입니다).`,
    };
  }
  // scope 필드가 없다 = 구버전 엣지. '설정 때문' 이라 단정하지 않는다.
  return {
    tone: 'warn',
    text: `⚠ 이 스위치는 엣지 '${a}' 가 수집합니다. 중앙에는 **문제 포트만** 올라왔습니다 — 정상 포트 ${omitted}개는 여기 표에 없습니다(요약 수치는 전체 기준으로 정확합니다).`,
    action: `엣지 '${a}' 의 포탈이 v2.517 미만이면 전체 포트를 보내지 않습니다. 그 엣지를 업그레이드하면 다음 push 부터 전체가 올라옵니다.`,
  };
}
