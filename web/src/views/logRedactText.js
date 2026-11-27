/**
 * views/logRedactText.js — 포탈 콘솔 로그 줄 가림의 **한계 문구 하나**(보안 잔여 11-27 L8 · 순수 — vitest 로 고정).
 *
 * 서버의 줄 가림 판정은 하나(server/src/edgelog/redact.js redactLogLine)이고, 그 줄을 보여 주는 화면은 둘이다 —
 *   설정 › 진단 › 서버 로그(GET /admin/logs · 이 노드) · 특수 기능 › 엣지 로그(엣지 · 중앙 자신). 같은 판정의 한계를 두 화면이 따로 적으면
 *   문구가 갈라진다(엣지 쪽 문구는 'KEY=값 · Bearer 꼴만' 으로 낡아 있었다 — JSON · 주소 속 비밀번호 · 대문자 환경 변수 꼴이 더해졌다). 그래서 여기 하나.
 * ⚠ 이 문구를 지우지 말 것: '가렸다' 고만 말하고 한계를 숨기면 사용자가 로그를 그대로 밖에 옮긴다.
 * ⚠ BoldText 는 '**강조**' 만 그린다 — 문구에 백틱 금지(시험이 막는다).
 */

/** 줄 가림의 범위와 한계(두 화면 공용). */
export function logLineRedactLimit() {
  return '로그 줄은 자유 문자열이라 **꼴로 찾아** 가립니다(password · token · secret 같은 이름의 값, Bearer 토큰, 주소 속 비밀번호, 대문자 환경 변수의 KEY · PASS 값) — 다른 형태로 찍힌 값은 **남을 수 있으니** 로그를 밖으로 옮기기 전에 확인하세요.';
}

/**
 * 설정 › 진단 › 서버 로그 아래 안내. 서버가 가렸다고 밝힌 응답(redacted === true)일 때만 말한다 — 가리지 않는 옛 서버에 '가렸다' 고 말하지 않는다.
 * @param {{ redacted?: unknown, maskedShown?: unknown }} p maskedShown = 지금 화면에 그린 줄 중 가린 줄 수(양의 정수일 때만 개수를 말한다)
 * @returns {string|null}
 */
export function serverLogRedactNote({ redacted, maskedShown } = {}) {
  if (redacted !== true) return null;
  const n = typeof maskedShown === 'number' && Number.isInteger(maskedShown) && maskedShown > 0 ? maskedShown : null;
  const head = n != null ? `지금 보이는 줄 중 **${n.toLocaleString('ko-KR')}줄**에서 값을 가렸습니다. ` : '';
  return `${head}비밀처럼 보이는 값은 **[가림]** 으로 바꿔 보여 줍니다. ${logLineRedactLimit()} 호스트 저널(journalctl)에는 가리지 않은 원문이 남습니다.`;
}
