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

const HOSTKEY_FIX = '장비 콘솔 등 별도 경로로 지문을 확인한 뒤 관리자가 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서)에서 승인해야 연결됩니다';
const HOSTKEY_NO_PW = '비밀번호는 보내지 않았습니다';

/**
 * v2.731(점검 1회차 A5-02·A1-03): 서버가 닫힘 **사유**(WebSocket close reason)로 보낸 코드 → 문구.
 * 게이트웨이(server/src/proxy/sshGateway.js·guacdTunnel.js)는 4403 하나를 권한·범위·매핑 삭제·대상 변경·**호스트키 거부**에 함께 쓴다.
 * 코드 숫자만 보면 호스트키가 승인되지 않은 장비를 '권한·범위가 바뀌어' 로 말해 사용자가 권한을 의심했다(실제 조치는 지문 승인).
 * 그래서 화면은 **사유가 있으면 사유로**, 모르는 사유면 null 을 돌려 코드 문구(sshCloseReasonText)로 떨어진다.
 * RDP 도 같은 사유를 쓴다 — Guacamole 터널은 닫힘 사유를 상태 메시지로 넘긴다(RemoteConsole.jsx RdpConsole tunnel.onerror).
 * 서버의 사유 코드와 1:1(웹 테스트가 서버 소스에서 코드를 뽑아 대조한다).
 */
const REMOTE_CLOSE_REASON_TEXT = new Map([
  ['host-key', `대상 서버의 SSH 호스트키를 신뢰할 수 없어 연결하지 않았습니다(${HOSTKEY_NO_PW}). ${HOSTKEY_FIX}.`],
  ['host-key-unknown', `대상 서버의 SSH 호스트키가 아직 승인되지 않아 연결하지 않았습니다(${HOSTKEY_NO_PW}). ${HOSTKEY_FIX}.`],
  ['host-key-changed', `대상 서버의 SSH 호스트키가 승인된 키와 달라 연결하지 않았습니다 — 장비 키가 교체됐거나 다른 서버로 연결됐을 수 있습니다(${HOSTKEY_NO_PW}). ${HOSTKEY_FIX}.`],
  ['host-key-rejected', `관리자가 거부한 SSH 호스트키라 연결하지 않았습니다(${HOSTKEY_NO_PW}). 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서)에서 거부 기록을 확인하세요.`],
  ['host-key-not-approved', `대상 서버의 SSH 호스트키가 관찰만 되고 승인되지 않아 연결하지 않았습니다 — 정책이 승인된 지문만 허용으로 바뀌었습니다(${HOSTKEY_NO_PW}). ${HOSTKEY_FIX}.`],
  ['host-key-bad-fingerprint', `대상 서버가 내민 SSH 호스트키를 읽지 못해 연결하지 않았습니다(${HOSTKEY_NO_PW}).`],
  ['host-key-internal', `포탈이 장비 신뢰 저장소를 확인하지 못해 연결하지 않았습니다(${HOSTKEY_NO_PW}). 잠시 뒤 다시 접속하고, 계속되면 관리자에게 알리세요.`],
  ['mapping-gone', '이 원격 접속 매핑이 삭제되었거나 다른 종류로 바뀌어 서버가 연결을 닫았습니다. 매핑을 다시 확인한 뒤 접속하세요.'],
  ['mapping-changed', '이 원격 접속 매핑의 대상(호스트·포트)이 바뀌어 서버가 연결을 닫았습니다. 바뀐 대상으로 다시 접속하세요.'],
  ['mapping-denied', '이 계정은 이 원격 접속 매핑을 쓸 수 없어 서버가 연결을 닫았습니다(소유자가 아니거나, 대상이 계정의 범위 밖입니다).'],
  ['mapping-not-found', '이 원격 접속 매핑을 찾을 수 없어 서버가 연결을 닫았습니다(삭제되었거나 바뀌었습니다).'],
  ['no-remote-access', '이 계정에 원격 접속 권한(remote.access)이 없어 서버가 연결을 닫았습니다.'],
  ['otp-enroll', 'OTP 등록을 마쳐야 원격 접속을 쓸 수 있어 서버가 연결을 닫았습니다.'],
  ['demo-guest', '데모 계정은 원격 접속을 쓸 수 없어 서버가 연결을 닫았습니다.'],
  ['revalidate-error', '서버가 이 연결의 권한을 다시 확인하지 못해 연결을 닫았습니다. 잠시 뒤 다시 접속하세요.'],
  ['session-invalid', '로그인 세션이 만료되었거나 로그아웃되어 서버가 연결을 닫았습니다. 다시 로그인한 뒤 접속하세요.'],
  ['revoked', '로그인 세션이 폐기되어(로그아웃·계정 변경 등) 서버가 연결을 닫았습니다. 다시 로그인한 뒤 접속하세요.'],
]);
/** 다른 표기의 사유(2.730 이하 서버의 'host key not trusted'·'forbidden' · 접속 시점 매핑 없음) — 같은 뜻의 코드로 읽는다. */
const CLOSE_REASON_ALIAS = new Map([
  ['host key not trusted', 'host-key'],
  ['forbidden', 'mapping-denied'],
  ['mapping not found', 'mapping-not-found'],
  ['rdp mapping not found', 'mapping-not-found'],
]);

/** 서버가 보낸 닫힘 사유 → 문구. 모르는 사유·빈 값이면 null(호출부가 코드 문구로 떨어진다). */
export function remoteCloseReasonText(reason) {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) return null;
  const key = CLOSE_REASON_ALIAS.get(r) || r;
  if (REMOTE_CLOSE_REASON_TEXT.has(key)) return REMOTE_CLOSE_REASON_TEXT.get(key);
  if (key.startsWith('host-key-')) return REMOTE_CLOSE_REASON_TEXT.get('host-key'); // 새 판정 사유가 늘어도 호스트키라는 사실은 말한다
  return null;
}

/**
 * WebSocket close 코드 → 사용자에게 보일 사유(없으면 null — 예전처럼 '[연결 종료]' 만).
 * 1009 = 프레임 상한 초과(서버가 닫음). ⚠ 4403 은 여러 원인이 함께 쓰는 코드다 — 서버 사유(remoteCloseReasonText)를 먼저 볼 것.
 */
export function sshCloseReasonText(code) {
  if (code === 1009) return '보낸 데이터가 한 번에 받을 수 있는 크기(256KB)를 넘어 서버가 연결을 닫았습니다. 붙여넣기를 나눠서 다시 접속해 보내세요.';
  // 2026-10-09 검토 S-04·I-07: 게이트웨이가 닫은 이유(서버 proxy/sshGateway.js closeAll 코드와 1:1)
  if (code === 4401) return '로그인 세션이 만료되었거나 로그아웃되어 서버가 연결을 닫았습니다. 다시 로그인한 뒤 접속하세요.';
  // v2.731(A5-02·A1-03): 사유를 모르는 4403 을 '권한·범위' 하나로 단정하지 않는다 — 같은 코드를 매핑·호스트키도 쓴다.
  if (code === 4403) return '서버가 이 연결을 허용하지 않아 닫았습니다 — 계정 권한·범위, 접속 매핑, 대상 서버 호스트키 중 하나가 원인입니다(터미널 위쪽 줄에 서버가 보낸 사유가 있습니다).';
  if (code === 4008) return '화면이 출력을 받지 못하는 상태가 오래 이어져 서버가 연결을 닫았습니다(브라우저 탭이 멈췄거나 네트워크가 느립니다).';
  if (code === 4009) return '받지 못한 출력이 너무 많이 쌓여 서버가 연결을 닫았습니다(대량 출력 — 다시 접속해 출력을 나눠 보세요).';
  if (code === 4000) return '입력이 없는 시간이 길어 서버가 세션을 닫았습니다(유휴 종료). 다시 접속하세요.';
  if (code === 4404) return '이 원격 접속 매핑을 찾을 수 없어 서버가 연결을 닫았습니다(삭제되었거나 바뀌었습니다).';
  if (code === 4429) return '동시에 열 수 있는 원격 콘솔 수를 넘었습니다 — 다른 콘솔을 닫고 다시 접속하세요.';
  return null;
}
