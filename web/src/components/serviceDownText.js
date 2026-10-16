/**
 * serviceDownText.js — '서비스 일시 미가용' 판정·문구(순수, v2.459).
 *
 * 왜 별도 처리인가: 업그레이드 중 재시작·게이트웨이 오류·서버 내부 오류를 빨간 "오류: Failed to
 * fetch" 로 보여주면 사용자가 자기 잘못이나 데이터 손실로 오해해 새로고침·재로그인을 반복하고
 * 장애 문의를 올린다. 403 을 AccessDenied 로 바꾼 것과 같은 이유·같은 패턴이다.
 * v2.458 의 헤더 'Upgrading…' 점멸 배지와는 상호 보완이다 — 배지는 전역 상태, 이건 본문 안내.
 *
 * 판정·문구를 여기(순수 함수)에 두는 이유: 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더
 * 테스트가 불가하다. 오탐이 나면 진짜 오류가 '5분 후 재시도' 로 감춰지므로 회귀로 고정한다.
 */

const NET_RE = /Failed to fetch|NetworkError|load failed|ERR_NETWORK|ERR_CONNECTION_(REFUSED|RESET)/i;
const TMO_RE = /AbortError|TimeoutError/;
const DOWN_STATUS = [500, 502, 503, 504];

/**
 * @param {string|Error} message  ErrorBox 가 받은 메시지(문자열 계약)
 * @param {object|null} http      httpInfoFor(message) 로 되찾은 원본 HttpError(있으면 상태코드 우선)
 * @returns {'gateway'|'internal'|'network'|'timeout'|null}
 */
export function serviceDownKind(message, http = null) {
  const status = Number(http?.status) || 0;
  // 4xx(권한·잘못된 요청·없음·충돌)는 재시도해도 결과가 같다 — 절대 이 안내로 바꾸지 않는다.
  if (status >= 400 && status < 500) return null;
  if (DOWN_STATUS.includes(status)) return status === 500 ? 'internal' : 'gateway';
  const m = typeof message === 'string' ? message : String(message?.message || '');
  if (!m) return null;
  // 사이드 채널이 만료된 뒤(5분)에도 판정되도록 메시지 원문도 본다.
  if (/->\s*500\b/.test(m)) return 'internal';
  if (/->\s*(502|503|504)\b/.test(m)) return 'gateway';
  if (NET_RE.test(m)) return 'network';
  if (TMO_RE.test(m)) return 'timeout';
  return null;
}

/**
 * 사용자에게 보이는 문구는 원인과 무관하게 **하나로 통일**한다.
 * 원인별로 문장을 나누면 사용자가 할 일(5분 후 재시도)은 같은데 화면만 복잡해진다.
 * 원인 구분은 '상세 정보' 안에만 둔다.
 */
export const SERVICE_DOWN_TEXT = {
  title: '서비스에 일시적으로 연결할 수 없습니다',
  sub: '포탈이 업그레이드 중이거나 내부 오류가 발생했습니다. 데이터가 손실된 것은 아니며, 작업을 다시 시도하면 됩니다.',
  act: '5분 후 다시 시도해 주세요.',
  esc: '계속되면 관리자에게 문의해 주세요.',
};

/**
 * 원인별 헤드라인(순수). **연결 자체가 안 되는 경우(network/timeout)** 는 서버가 응답을 아예 못 하는
 * 상태 — 대부분 업그레이드 적용 후 재시작으로 잠깐 내려간 것이라, '업데이트 재시작 중' 으로 안내하고
 * 화면이 스스로 재연결하게 한다(autoReconnect). 반면 5xx(gateway/internal)는 서버가 살아서 오류를
 * 돌려준 것이라 자동 새로고침하면 오류만 반복되므로 수동 재시도로 둔다.
 * @returns {{title, sub, act, esc, autoReconnect:boolean}}
 */
export function headlineFor(kind) {
  // v2.742(WEB-01): 시한 초과는 '연결 자체가 끊긴 것' 이 아닐 수 있다 — 서버는 살아 있는데 그 요청 하나가 늦은 경우가 흔하다.
  //   그래서 헤드라인을 '응답 지연' 으로 따로 두고(재시작 가능성은 함께 말한다), 서버 확인 결과(reconnectStatusText)가 뒤를 잇는다.
  if (kind === 'timeout') {
    return {
      title: '응답이 늦어지고 있습니다(재시작 중일 수 있습니다)',
      sub: '요청이 제한 시간 안에 끝나지 않았습니다. 포탈이 업데이트 후 재시작 중이거나, 그 요청이 오래 걸리는 중일 수 있습니다. 서버가 응답하는지 확인하고 있습니다.',
      act: '서버 응답을 확인하고 있습니다 — 재시작 중이었다면 준비되는 대로 자동으로 다시 연결합니다.',
      esc: '1~2분 넘게 계속되면 관리자에게 문의해 주세요.',
      autoReconnect: true,
    };
  }
  if (kind === 'network') {
    return {
      title: '업데이트 후 재시작 중입니다',
      sub: '새 버전을 적용하고 서비스를 다시 시작하는 중입니다. 데이터는 안전하며, 준비되면 이 화면이 자동으로 다시 연결합니다.',
      act: '자동으로 다시 연결을 시도하고 있습니다 — 잠시만 기다려 주세요.',
      esc: '1~2분 넘게 계속되면 관리자에게 문의해 주세요.',
      autoReconnect: true,
    };
  }
  return { ...SERVICE_DOWN_TEXT, autoReconnect: false };
}

/**
 * v2.742(WEB-01): 자동 재연결 확인 요청의 결과 분류(순수).
 *
 * 확인 요청은 '포탈 프로세스가 HTTP 로 답하는가' 만 본다. 401·403 도 **서버가 응답한 것**이다 — 토큰이 없거나 만료됐을 뿐
 * 포탈은 살아 있다. 예전에는 토큰 없이 /api/health 를 묻고 `res.ok` 만 살았다고 봐서, 인증을 켠 포탈(기본값)에서는 확인 요청이
 * 언제나 401 이라 서버가 살아나도 재연결이 끝나지 않았다. 502·503·504 는 앞단 프록시가 포탈에 닿지 못한 것(재시작 중)이고,
 * 500 은 포탈이 오류를 낸 것이라 '준비됨' 으로 보지 않는다(새로고침해도 같은 오류다). 연결 실패·시한은 down.
 * @param {{status?:number|null, error?:unknown}} r
 * @returns {'alive'|'down'}
 */
export const PROBE_ALIVE_STATUSES = Object.freeze([401, 403]);
export function probeOutcome(r = {}) {
  if (r?.error) return 'down';
  const st = Number(r?.status);
  if (!Number.isFinite(st) || st <= 0) return 'down';
  if (st >= 200 && st < 300) return 'alive';
  if (PROBE_ALIVE_STATUSES.includes(st)) return 'alive';
  return 'down';
}

/** 재연결 상태의 시작값 — phase: 'probing'(확인 중) | 'reload'(새로고침할 차례) | 'alive'(처음부터 살아 있었음). */
export const RECONNECT_INITIAL = Object.freeze({ phase: 'probing', sawDown: false, probes: 0 });

/**
 * v2.742(WEB-01): 확인 결과 한 번을 받아 다음 상태를 정한다(순수 — 화면 컴포넌트는 이것만 따른다).
 * 새로고침은 **확인 요청이 한 번 이상 연결 불가로 실패했다가 응답으로 바뀔 때만** 한다. 처음부터 살아 있었으면(그 요청 하나만
 * 실패했거나 늦었던 것) 새로고침하지 않고 'alive' 로 멈춘다 — 예전에는 인증을 끈 포탈에서 확인 요청이 늘 200 이라
 * 엔드포인트 하나가 실패하기만 해도 마운트하자마자 새로고침했고, 같은 실패가 나면 새로고침이 반복됐다.
 * 'reload'·'alive' 는 끝 상태다(다시 바뀌지 않는다).
 */
export function reconnectStep(state, outcome) {
  const s = state && typeof state === 'object' ? state : RECONNECT_INITIAL;
  if (s.phase !== 'probing') return s;
  const probes = (s.probes || 0) + 1;
  if (outcome === 'down') return { phase: 'probing', sawDown: true, probes };
  if (outcome === 'alive') return { phase: s.sawDown ? 'reload' : 'alive', sawDown: !!s.sawDown, probes };
  return { ...s, probes };
}

/**
 * 재연결 표시 줄 문구(순수). probing 은 경과 초와 함께, alive 는 '서버는 응답한다 — 다시 시도' 를 말한다.
 * @returns {{text:string, spinning:boolean}}
 */
export function reconnectStatusText(state, elapsedSec = 0) {
  const phase = state?.phase || 'probing';
  if (phase === 'alive') {
    return { spinning: false, text: '서버는 응답하고 있습니다 — 이 요청만 실패했거나 늦었습니다. 아래 다시 시도를 눌러 주세요.' };
  }
  if (phase === 'reload') return { spinning: true, text: '서버가 다시 응답합니다 — 화면을 새로 불러옵니다.' };
  const sec = Number.isFinite(Number(elapsedSec)) ? Math.max(0, Math.floor(Number(elapsedSec))) : 0;
  return { spinning: true, text: state?.sawDown ? `자동 재연결 시도 중 · ${sec}초 경과` : `서버 응답 확인 중 · ${sec}초 경과` };
}

const KIND_LABEL = {
  gateway: '게이트웨이 오류(서비스 재시작·중계 구간)',
  internal: '서버 내부 오류',
  network: '연결 실패(응답 없음)',
  timeout: '응답 지연(제한 시간 초과)',
};

/**
 * '상세 정보' 에 넣을 진단 항목 — 관리자에게 그대로 전달하면 되는 내용.
 * @returns [[label, value], ...]
 */
export function diagnosticLines(kind, message, http = null, at = new Date()) {
  const out = [['구분', KIND_LABEL[kind] || '알 수 없음']];
  if (http?.status) out.push(['HTTP 상태', String(http.status)]);
  if (http?.path) out.push(['요청 경로', String(http.path)]);
  out.push(['발생 시각', at.toLocaleString('ko-KR')]);
  const m = typeof message === 'string' ? message : String(message?.message || '');
  if (m) out.push(['원문 메시지', m]);
  return out;
}

/** 진단 항목을 관리자 문의용 평문으로. */
export function diagnosticText(lines) {
  return (lines || []).map(([k, v]) => `${k}: ${v}`).join('\n');
}
