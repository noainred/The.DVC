/**
 * sanswitch/testDiag.js — 연결 테스트 진단(v2.421, 사용자 요구 '연결 테스트가 멈출 때 왜 안되는지
 * 구체적으로 로그를 볼 수 있게, 자세히 버튼이면 ssh -vvv 처럼 어디서 안되는지 추적').
 *
 * 순수 함수만 둔다(테스트로 고정). 실패 메시지를 **단계(phase)** 와 **원인 안내(hint)** 로 분류한다 —
 * 단계는 dns → tcp → ssh-handshake → ssh-auth → exec → parse 순이며, 어느 단계에서 멈췄는지가 곧
 * '어디를 봐야 하는지' 다(예: tcp 에서 멈추면 계정이 아니라 방화벽/경로 문제).
 */

export const PHASES = {
  dns: 'DNS 이름 해석',
  tcp: 'TCP 연결',
  'ssh-handshake': 'SSH 핸드셰이크(알고리즘 협상·호스트키)',
  'ssh-auth': 'SSH 인증',
  exec: '명령 실행',
  parse: '출력 해석',
  rest: 'REST 호출',
  timeout: '전체 타임아웃',
};

/** 추적 로그 누적기 — 시작 시각 기준 경과 ms 와 메시지. 상한을 넘으면 마지막 줄에 생략 표시. */
export function makeTracer(startedAt = Date.now(), { limit = 600 } = {}) {
  const lines = [];
  let dropped = 0;
  const push = (msg, level = 'info') => {
    if (lines.length >= limit) { dropped++; return; }
    lines.push({ t: Date.now() - startedAt, msg: String(msg).slice(0, 2000), level });
  };
  return { push, lines, get dropped() { return dropped; } };
}

/**
 * 실패 메시지 → { phase, hint }. 메시지에 단계 정보가 없으면 호출자가 준 phase 를 쓴다.
 * 안내 문구는 추측을 사실처럼 쓰지 않는다 — "…일 가능성이 큽니다 / 확인하세요" 형태.
 */
export function classifyFailure(message, phase = '', { agentDelegated = false, ranOn = '중앙' } = {}) {
  const m = String(message || '');
  const where = ranOn === '중앙' ? '중앙 포탈 서버' : `엣지(${ranOn})`;
  const edgeNote = agentDelegated
    ? ''
    : ' 이 스위치가 엣지 망 안에 있다면(중앙에서 직접 닿지 않는 IP) 등록 화면의 "수집 주체"를 해당 법인 엣지로 바꾸세요 — 그러면 테스트도 그 엣지가 실행합니다.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
    return { phase: 'dns', hint: `${where}가 host 를 IP 로 해석하지 못했습니다. 호스트명 오타이거나 ${where}의 DNS 에 없는 이름입니다. IP 로 등록하거나 DNS 를 확인하세요.` };
  }
  if (/ECONNREFUSED/i.test(m)) {
    return { phase: 'tcp', hint: `대상이 TCP 연결을 거부(RST)했습니다 — 장비까지는 도달했지만 그 포트에 SSH/HTTPS 서비스가 없습니다. 포트 번호(SSH 22 / REST 443)와 장비에서 해당 서비스가 켜져 있는지 확인하세요.` };
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(m)) {
    return { phase: 'tcp', hint: `${where}에서 대상 IP 로 가는 경로가 없습니다(라우팅/게이트웨이).${edgeNote}` };
  }
  if (/TCP 연결 타임아웃|ETIMEDOUT|connect ETIMEDOUT/i.test(m)) {
    return { phase: 'tcp', hint: `TCP SYN 에 응답이 없습니다 — ${where}와 장비 사이 방화벽이 포트를 막고 있거나, IP 가 틀리거나, 장비가 꺼져 있습니다. "멈춘 것처럼" 보이는 대표 원인입니다.${edgeNote}` };
  }
  if (/Timed out while waiting for handshake|handshake.*timed out/i.test(m)) {
    return { phase: 'ssh-handshake', hint: 'TCP 는 연결됐지만 SSH 배너/키 교환이 제한 시간 안에 끝나지 않았습니다. 포트에 SSH 가 아닌 다른 서비스가 있거나, 장비 CPU 가 매우 느리거나, 중간 장비가 세션을 끊는 경우입니다. "자세히 테스트"로 마지막 프로토콜 단계를 확인하세요.' };
  }
  if (/no matching (key exchange|host key|cipher|MAC|compression)|Handshake failed/i.test(m)) {
    return { phase: 'ssh-handshake', hint: `장비와 공통 SSH 알고리즘이 없습니다(${m.match(/no matching [^.,;]+/i)?.[0] || '알고리즘 불일치'}). 구형 Fabric OS 는 diffie-hellman-group1-sha1 / ssh-dss / aes-cbc 만 제공하는 경우가 있습니다. 포탈은 1회 자동으로 구형 알고리즘까지 열어 재시도합니다(추적 로그에 표시) — 그래도 실패하면 장비의 sshd 설정(FOS: sshutil / seccryptocfg)에서 제공 알고리즘을 확인하세요.` };
  }
  if (/All configured authentication methods failed|Authentication failure|인증 실패|permission denied/i.test(m)) {
    return { phase: 'ssh-auth', hint: '장비가 계정/비밀번호를 거부했습니다. 계정·비밀번호·(VF 장비면 계정의 컨텍스트 권한)를 확인하세요. 비밀번호를 바꾸지 않고 host 만 바꿔 테스트하면 저장된 비밀번호는 이월되지 않습니다(보안 규칙) — 다시 입력하세요.' };
  }
  if (/keyboard-interactive|too many authentication failures/i.test(m)) {
    return { phase: 'ssh-auth', hint: '장비가 인증 시도 횟수를 초과했다고 응답했습니다. 잠금 해제 후 다시 시도하세요.' };
  }
  if (/SSH exec 타임아웃/i.test(m)) {
    return { phase: 'exec', hint: '접속·인증은 됐지만 명령이 제한 시간 안에 끝나지 않았습니다. 계정의 로그인 셸이 대화형 메뉴(예: 제한 셸)이거나, 장비가 명령 응답을 멈춘 상태입니다. CLI 원문에서 마지막으로 성공한 명령을 확인하세요.' };
  }
  if (/SSH exec 출력 상한/i.test(m)) {
    return { phase: 'exec', hint: '명령 출력이 상한(기본 4MB)을 넘었습니다. 장비가 화면을 무한 갱신하는 상태일 수 있습니다.' };
  }
  if (/수집기 미구현/.test(m)) return { phase: 'parse', hint: '이 장비 타입의 수집기가 아직 없습니다.' };
  if (/switchshow/.test(m) && /없습니다|명령이 없/.test(m)) {
    return { phase: 'exec', hint: '접속은 됐지만 계정에 switchshow 가 없습니다. FOS CLI 셸을 받는 admin 계정(또는 user 권한 이상)으로 등록하세요.' };
  }
  if (/인증 실패\(401\)/.test(m)) return { phase: 'rest', hint: 'REST 로그인 401 — 계정/비밀번호를 확인하세요.' };
  if (/\/rest 없음\(404\)/.test(m)) return { phase: 'rest', hint: 'FOS 8.2.1 미만에는 REST API 가 없습니다. 수집 방식을 SSH 로 바꾸세요.' };
  if (/certificate|CERT_|self.signed|TLS|SSL/i.test(m)) return { phase: 'rest', hint: 'TLS 협상 실패 — 장비 인증서/암호 스위트 문제입니다. 추적 로그의 오류 원문을 확인하세요.' };
  if (/테스트 타임아웃|수집 타임아웃|취소\(타임아웃\)/.test(m)) {
    return { phase: phase || 'timeout', hint: `전체 제한 시간 안에 끝나지 않았습니다. 추적 로그에서 **마지막으로 찍힌 단계**가 멈춘 곳입니다 — TCP 연결 단계에서 멈췄다면 방화벽/경로, 인증 뒤에서 멈췄다면 명령 응답 지연입니다.${edgeNote}` };
  }
  if (/엣지가 .*가져가지|엣지 응답 없음|pull/.test(m)) {
    return { phase: 'edge', hint: '엣지가 테스트 요청을 가져가지 않았습니다. 엣지 포탈이 켜져 있고 중앙과 통신(설정 pull)이 되는지 — 설정 › 수집 서버 › 엣지 상태에서 마지막 pull 시각을 확인하세요.' };
  }
  return { phase: phase || 'unknown', hint: '분류되지 않은 오류입니다. 추적 로그의 오류 원문과 마지막 단계를 확인하세요. "자세히 테스트"를 켜면 SSH 프로토콜 단계별 로그(ssh -vvv 상당)가 함께 남습니다.' };
}

/** 추적 로그를 사람이 읽는 텍스트로(복사용). */
export function traceText(lines = []) {
  return lines.map((l) => `[+${(Number(l.t) / 1000).toFixed(3)}s] ${l.level === 'error' ? '✖ ' : l.level === 'debug' ? '  · ' : ''}${l.msg}`).join('\n');
}
