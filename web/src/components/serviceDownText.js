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
