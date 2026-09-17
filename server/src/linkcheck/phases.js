/**
 * linkcheck/phases.js — 단계 판정과 문구(순수, v2.552).
 *
 * 사용자 선택: 점검 **단계별 전체**(TCP → TLS → HTTP → 인증 → 정체). "이슈가 있을 때 분석하는
 * 자료" 가 목적이므로 **어느 단계에서 막혔는지**가 기록의 핵심이다.
 *
 * ⚠ `relaycheck/checks.js` 가 이미 같은 계열의 phase 를 쓴다(`refused|timeout|unreach|tls|http|
 *   identity|auth|hq|banner|ok`). 그 이름을 **그대로 따른다** — 두 화면이 다른 낱말로 같은 상태를
 *   말하면 사용자가 둘 중 어느 것을 믿을지 모른다(CLAUDE.md '코어는 하나다' 의 문구 버전).
 *   다만 relaycheck 는 HAProxy 포트 프로파일 전용이라 실행기는 공유하지 않는다.
 */
const t = (v) => String(v ?? '').trim();

/**
 * 단계 순서 — **이 순서가 계약이다**. 앞 단계가 실패하면 뒤 단계는 시도하지 않고 `null`(미시도)이다.
 * ⚠ 미시도를 '실패' 로 세지 말 것 — TCP 가 막혀 TLS 를 못 한 것은 TLS 문제가 아니다.
 */
/*
 * ⚠ v2.553: `ssh`·`smtp`·`port` 는 **HTTP 를 대신하는 마지막 단계**다(설정 전수 점검 —
 *   SSH 9종·SMTP 1종·LDAP 1종). HTTP 단계와 **동시에 쓰이지 않으므로** 순서상 같은 자리에
 *   둔다. `judge()` 는 존재하는 키만 보므로 섞여도 안전하다.
 */
export const PHASES = Object.freeze(['dns', 'tcp', 'tls', 'ssh', 'smtp', 'port', 'http', 'auth', 'identity']);

export const PHASE_LABEL = Object.freeze({
  ssh: 'SSH 협상',
  smtp: 'SMTP 대화',
  port: '포트 열림',
  dns: 'DNS', tcp: 'TCP', tls: 'TLS', http: 'HTTP', auth: '인증', identity: '정체 대조',
});

/**
 * 실패 종류 — 조치가 **정반대**인 것을 한 낱말로 덮지 않는다(v2.517 규약).
 * `ok` 외에는 전부 실패이고, `skipped` 는 '이번에 하지 않았다'(실패가 아니다).
 */
export const FAIL_KINDS = Object.freeze({
  'dns-fail': { phase: 'dns', label: '이름 해석 실패', fix: 'DNS·hosts 를 확인하세요. 이름이 바뀌었거나 그 망에서 해석되지 않습니다.' },
  'dns-blocked': { phase: 'dns', label: '차단 대역', fix: '해석된 주소가 링크로컬·루프백 등 차단 대역입니다(SSRF 가드). 등록된 주소를 확인하세요.' },
  refused: { phase: 'tcp', label: '연결 거부', fix: '상대 포트가 닫혀 있습니다 — 서비스가 내려갔거나 포트가 다릅니다(방화벽이면 보통 타임아웃입니다).' },
  unreach: { phase: 'tcp', label: '경로 없음', fix: '라우팅·방화벽에서 막혔습니다(EHOSTUNREACH/ENETUNREACH).' },
  timeout: { phase: 'tcp', label: '타임아웃', fix: '패킷이 버려집니다 — 방화벽 차단이나 상대 과부하입니다. 고RTT 구간이면 시한을 늘려 보세요.' },
  reset: { phase: 'tcp', label: '연결 끊김', fix: '상대나 중간 장비가 연결을 끊었습니다(ECONNRESET) — 중계·로드밸런서를 보세요.' },
  'tls-fail': { phase: 'tls', label: 'TLS 실패', fix: 'TLS 핸드셰이크가 실패했습니다 — 프로토콜·암호군 불일치이거나 상대가 TLS 가 아닙니다.' },
  'tls-expired': { phase: 'tls', label: '인증서 만료', fix: '상대 인증서가 만료됐습니다 — 갱신해야 합니다.' },
  'http-error': { phase: 'http', label: 'HTTP 오류', fix: '연결·TLS 는 됐는데 응답이 오류입니다 — 상태 코드와 본문 조각을 보세요.' },
  'not-portal': { phase: 'http', label: '포탈이 아님', fix: '응답이 이 포탈의 형식이 아닙니다 — 포트포워딩이 다른 서비스로 갑니다.' },
  auth: { phase: 'auth', label: '토큰 거부', fix: '토큰이 틀리거나 상대에 설정되지 않았습니다(401/403). ⚠ 반복 시도는 결과가 같습니다.' },
  identity: { phase: 'identity', label: '상대가 다름', fix: '응답한 쪽이 등록된 대상이 아닙니다 — 포워딩이 다른 엣지로 가거나 자기등록 URL 이 중계를 가리킵니다.' },
  'old-version': { phase: 'http', label: '버전 부족', fix: '상대 포탈이 이 점검을 지원하지 않는 버전입니다 — 업그레이드하면 채워집니다.' },
  // v2.553 — 설정 전수 점검의 비-HTTP 경로
  'ssh-kex': { phase: 'ssh', label: 'SSH 협상 실패', fix: '키 교환·호스트키 알고리즘이 맞지 않습니다(구형 장비). **자격증명 문제가 아닙니다** — 상대 펌웨어나 우리 쪽 허용 알고리즘을 보세요.' },
  'smtp-refused': { phase: 'smtp', label: 'SMTP 거부', fix: '연결은 됐지만 서버가 대화를 거부했습니다(220 아님·EHLO 거부) — 릴레이 제한이나 IP 차단입니다.' },
  unknown: { phase: 'http', label: '원인 미상', fix: '분류하지 못한 오류입니다 — 상세 로그의 원문을 보세요.' },
});

/** node 오류 코드 → 실패 종류. ⚠ 한 낱말로 덮지 않는다(조치가 다르다). */
export function failKindOfCode(code, message = '') {
  const c = t(code).toUpperCase();
  const m = t(message);
  if (c === 'ECONNREFUSED') return 'refused';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'unreach';
  // ⚠ `socket hang up` 은 코드가 비어 오는 경우가 많다(undici) — 문구로도 잡는다.
  if (c === 'ECONNRESET' || c === 'EPIPE' || /socket hang up|connection closed/i.test(m)) return 'reset';
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || /timeout|timed out|aborted/i.test(m)) return 'timeout';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'dns-fail';
  if (c === 'ESSRFBLOCKED') return 'dns-blocked';
  if (/CERT_HAS_EXPIRED/i.test(c) || /certificate has expired/i.test(m)) return 'tls-expired';
  if (/^ERR_TLS|^ERR_SSL|EPROTO|WRONG_VERSION|SSL/i.test(c) || /tls|ssl|handshake/i.test(m)) return 'tls-fail';
  return 'unknown';
}

/**
 * 단계 결과 묶음 → 한 줄 판정.
 * @param {object} steps `{ dns:{ok,ms,...}, tcp:{...}, ... }` — 미시도는 키가 없다
 * @returns {{ok:boolean, phase:string, failKind:string|null, totalMs:number, reached:string}}
 *   `reached` = **도달한 마지막 단계**(이슈 분석에서 가장 자주 보는 값이다)
 */
export function judge(steps = {}) {
  let totalMs = 0;
  let reached = '';
  for (const p of PHASES) {
    const s = steps[p];
    if (!s) continue;                     // 미시도 — 뒤 단계도 안 했다는 뜻
    if (Number.isFinite(Number(s.ms))) totalMs += Number(s.ms);
    reached = p;
    if (s.ok === false) {
      return { ok: false, phase: p, failKind: t(s.failKind) || 'unknown', totalMs, reached };
    }
  }
  if (!reached) return { ok: false, phase: 'dns', failKind: 'unknown', totalMs: 0, reached: '' };
  return { ok: true, phase: 'ok', failKind: null, totalMs, reached };
}

/**
 * 사람이 읽는 한 줄. ⚠ `**` 를 쓰지 않는다 — 이 문구는 알림·로그로도 나간다(v2.548 규약).
 */
export function summaryText(link = {}, verdict = {}, steps = {}) {
  const where = `${t(link.from) || '?'} → ${t(link.to) || '?'}`;
  if (verdict.ok) {
    const parts = PHASES.filter((p) => steps[p]).map((p) => `${PHASE_LABEL[p]} ${Math.round(steps[p].ms || 0)}ms`);
    return `${where} 정상 (${parts.join(' · ')})`;
  }
  const fk = FAIL_KINDS[verdict.failKind] || FAIL_KINDS.unknown;
  return `${where} ${PHASE_LABEL[verdict.phase] || verdict.phase} 단계 실패 — ${fk.label}`;
}

/** 조치 안내(화면용). 없으면 빈 문자열. */
export function fixHint(failKind) {
  const fk = FAIL_KINDS[t(failKind)];
  return fk ? fk.fix : '';
}

/**
 * 단계별 ms 를 '어디서 시간을 썼나' 로 요약한다. 이슈 분석에서 **느린 단계**를 바로 보게 한다.
 * ⚠ 미시도 단계를 0ms 로 만들지 않는다(0 은 '빨랐다' 로 읽힌다).
 */
export function slowestPhase(steps = {}) {
  let best = null;
  for (const p of PHASES) {
    const s = steps[p];
    if (!s || !Number.isFinite(Number(s.ms))) continue;
    if (!best || Number(s.ms) > best.ms) best = { phase: p, ms: Number(s.ms) };
  }
  return best;
}
