/**
 * util/denyAuditGate.js — 무인증 거부의 감사 로그 요약(v2.583 — 감사 확정 · 검증 에이전트 권고).
 *
 * 왜: 무인증 요청 한 번이 감사 로그 한 줄이면, 한 출처가 분당 1,800회(전역 레이트리밋)로 감사 이력(상한 2만 줄)을
 * 약 11분에 밀어낼 수 있다 — 공격 흔적을 지우는 데 공격 자체를 쓰는 셈이다. 같은 출처(키)는 **창(기본 1분)당
 * 한 줄만** 쓰고 나머지는 세어 두었다가 다음 줄에 '직전에 합친 N건' 으로 붙인다. **버리지 않고 합친다** — 거부 사실과
 * 횟수는 남는다.
 *
 * 규칙: 게이트는 **이 파일 하나**다(publicapi 키 거부 · 로그인 실패 · 로그인 차단이 같은 구현을 쓴다 — 복사하지 말 것).
 * 잠금을 **발동시킨** 줄처럼 반드시 남아야 하는 줄은 호출부가 게이트를 거치지 않고 바로 쓴다.
 */
export function createDenyAuditGate({ windowMs = 60_000, maxKeys = 2_000 } = {}) {
  const by = new Map(); // key -> { at, folded }
  function gate(key, now = Date.now()) {
    const k = String(key || '?');
    const e = by.get(k);
    if (e && now - e.at < windowMs) { e.folded += 1; return { write: false, folded: 0 }; }
    const folded = e ? e.folded : 0;
    by.delete(k);
    by.set(k, { at: now, folded: 0 });
    while (by.size > maxKeys) by.delete(by.keys().next().value);
    return { write: true, folded };
  }
  gate.reset = () => by.clear();
  gate.size = () => by.size;
  return gate;
}

/** 합친 개수 꼬리표(0 이면 빈 문자열). */
export const foldedNote = (n) => (n ? ` · 같은 출처 ${n}건을 이 줄에 합침(1분 요약)` : '');
