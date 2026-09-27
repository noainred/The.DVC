/**
 * v2.632(AX1-2632-07): SSH 웹 콘솔 전송 분할 + 닫힘 사유 문구 — 순수 모듈(서버 테스트도 import 한다).
 *
 * 서버 게이트웨이(server/src/proxy/sshGateway.js SSH_WS_MAX_PAYLOAD = 256KB)는 한 프레임이 상한을 넘으면 ws 가 1009 로 세션을
 * 통째로 닫는다. xterm onData 는 붙여넣기 전량을 한 번에 주므로 300KB 붙여넣기 한 번이 세션을 끊고, 화면은 사유 없이
 * '[연결 종료]' 만 보였다. 그래서 ① 붙여넣기를 여러 data 프레임으로 나눠 보내고 ② 그래도 1009 로 닫히면 사유를 말한다.
 *
 * 조각 크기는 **문자 수** 기준 32,768 이다 — JSON 이 제어 문자를 \\u00XX(6바이트)로 늘려도 32,768 × 6 = 192KB 로 상한(256KB) 안이고,
 * 한글(UTF-8 3바이트)이면 약 96KB 다. 서로게이트 쌍을 가르지 않는다(갈라진 반쪽은 대상에 깨진 글자로 간다).
 */
export const SSH_DATA_CHUNK_CHARS = 32_768;

/** data 문자열을 {type:'data'} JSON 프레임 배열로 나눈다. 빈 문자열은 프레임 0개. */
export function sshDataFrames(data, maxChars = SSH_DATA_CHUNK_CHARS) {
  const s = typeof data === 'string' ? data : String(data ?? '');
  const n = Math.max(2, Math.floor(Number(maxChars)) || SSH_DATA_CHUNK_CHARS);
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + n);
    if (end < s.length) {
      const c = s.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // 상위 서로게이트로 끝나면 그 글자를 다음 조각으로
    }
    out.push(JSON.stringify({ type: 'data', data: s.slice(i, end) }));
    i = end;
  }
  return out;
}

/**
 * WebSocket close 코드 → 사용자에게 보일 사유(없으면 null — 예전처럼 '[연결 종료]' 만).
 * 1009 = 프레임 상한 초과(서버가 닫음).
 */
export function sshCloseReasonText(code) {
  if (code === 1009) return '보낸 데이터가 한 번에 받을 수 있는 크기(256KB)를 넘어 서버가 연결을 닫았습니다. 붙여넣기를 나눠서 다시 접속해 보내세요.';
  return null;
}
