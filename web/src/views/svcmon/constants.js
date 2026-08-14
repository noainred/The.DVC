/**
 * svcmon/constants.js — 성능점검 화면 상수 카탈로그(v2.295, 1차 감사 확정 #1·#5 의 전제).
 * SvcMonitor.jsx 21~122·243행에서 그대로 이동(React 무의존 순수 데이터/함수).
 * 분리 이유: TestWizard(분리 모듈)가 ADD_MENU·TYPE_META·EMPTY_TEST 를 쓰는데 셸에서 가져오면
 * 셸↔마법사 순환 import 가 된다 — 상수는 독립 파일이 소유하고 양쪽이 단방향으로 import.
 * ⚠ statusOf 는 서버 status.js 판정과 정렬된 클라 판정(state 우선 → enabled → result) —
 *   tree.js 집계·셸 목록 필터가 공유한다. 한쪽만 고치면 KPI 와 트리가 어긋난다.
 */

export const STATUS = {
  ok: { label: 'Ok', cls: 'pc-ok' },
  warn: { label: 'Warning', cls: 'pc-warn' },
  bad: { label: 'No answer', cls: 'pc-bad' },
  disabled: { label: 'Disabled', cls: 'pc-off' },
  // '중지'와 구분해야 하는 두 상태 — 감시 공백을 의도적 중지로 보이게 하면 안 된다.
  pending: { label: '점검 대기', cls: 'pc-pending' },
  stale: { label: '갱신 안 됨', cls: 'pc-stale' },
  none: { label: '—', cls: 'pc-off' },
};
export const METHOD = {
  ping: 'ping (timeout - 4000 ms)', trace: 'traceroute', tcp: 'TCP port', udp: 'UDP probe',
  http: 'HTTP/URL', soap: 'SOAP/XML', dns: 'DNS query', cert: 'SSL certificate expiry',
  ntp: 'NTP offset', smtp: 'SMTP banner', pop3: 'POP3 banner', imap: 'IMAP banner',
  ssh: 'SSH banner', ldap: 'LDAP bind', domain: 'Domain expiry (whois)',
};

/** 계단식 추가 메뉴 — HostMonitor 의 Test→Add 계층을 우리 구현 가능 범위로 정리. */
export const ADD_MENU = [
  { label: '📡 Ping / Trace', items: [
    { type: 'ping', label: 'Ping (ICMP RTT)' },
    { type: 'trace', label: 'Trace (경로·홉 수)' },
  ] },
  { label: '🔌 TCP / UDP / 포트', items: [
    { type: 'tcp', label: 'TCP 포트 열림' },
    { type: 'udp', label: 'UDP 응답' },
    { type: 'ssh', label: 'SSH 배너 (22)' },
  ] },
  { label: '🌐 Web / 인증서', items: [
    { type: 'http', label: 'HTTP / URL (코드·키워드)' },
    { type: 'soap', label: 'SOAP / XML (POST)' },
    { type: 'cert', label: 'SSL 인증서 만료' },
    { type: 'domain', label: '도메인 만료 (whois)' },
  ] },
  { label: '✉️ E-Mail', items: [
    { type: 'smtp', label: 'SMTP 배너 (25/587)' },
    { type: 'pop3', label: 'POP3 배너 (110/995)' },
    { type: 'imap', label: 'IMAP 배너 (143/993)' },
  ] },
  { label: '🧭 이름·시간·디렉터리', items: [
    { type: 'dns', label: 'DNS 질의' },
    { type: 'ntp', label: 'NTP 오프셋' },
    { type: 'ldap', label: 'LDAP bind (389/636)' },
  ] },
];
/** 다음 단계 예정(엔진 미구현) — 메뉴에 회색으로 노출해 어떤 기능이 올지 보이게 한다. */
export const ADD_MENU_PLANNED = [
  'SNMP Get / Table / Trap', 'IPMI / Redfish 센서', 'Cisco·Juniper·F5·Netscaler',
  'NetApp·QNAP·Synology (NAS)', 'UPS·프린터', 'Database 세션(ODBC/MSSQL/Oracle)',
];

/** 유형별 설명·파라미터 정의 — 마법사 3단계 폼을 이 표에서 생성한다(한 곳만 고치면 됨). */
const F = (key, label, opts = {}) => ({ key, label, ...opts });
export const TYPE_META = {
  ping: { desc: 'ICMP 로 도달성·왕복시간(RTT)을 봅니다. CLI 프로세스를 쓰므로 대량 등록 시 TCP 병용 권장.', fields: [] },
  trace: { desc: '경로(홉)를 추적해 홉 수와 완주 여부를 봅니다. 경로 변화 감시용 — 주기를 길게 두세요.',
    fields: [F('maxHops', '최대 홉', { ph: '15', hint: '이 값을 넘으면 주의' })] },
  tcp: { desc: '포트에 TCP 연결만 시도하고 바이트를 보내지 않습니다. 사내 서비스 가동 판정에 가장 안전.',
    fields: [F('port', '포트', { ph: '8080', req: true })] },
  udp: { desc: '패킷을 보내고 응답이 오는지 봅니다. 무응답이 정상인 서비스(단방향 syslog 등)는 부적합.',
    fields: [F('port', '포트', { ph: '161', req: true }), F('payload', '보낼 문자열', { ph: '(비우면 CRLF)' })] },
  http: { desc: '상태코드와 본문 키워드로 판정합니다. 리다이렉트는 추적하지 않습니다(302·401 = 살아있음).',
    fields: [F('url', 'URL', { ph: 'http://10.0.0.5:8080/health', req: true }),
      F('keyword', '본문 키워드', { ph: 'ok — 없으면 주의' }),
      F('expectStatus', '기대 상태코드', { ph: '200 (비우면 500 미만 정상)' }),
      F('warnMs', '느림 임계(ms)', { ph: '3000' })] },
  soap: { desc: 'POST + text/xml 로 SOAP 요청을 보내고 응답 XML 을 키워드로 확인합니다.',
    fields: [F('url', 'URL', { ph: 'https://host/svc', req: true }), F('soapAction', 'SOAPAction'),
      F('body', '요청 본문(XML)', { area: true }), F('keyword', '응답 키워드')] },
  dns: { desc: '대상(또는 지정 서버)을 네임서버로 보고 A/AAAA 질의를 합니다. 기대 IP 와 다르면 주의.',
    fields: [F('record', '조회할 이름', { ph: 'portal.example.com', req: true }),
      F('server', 'DNS 서버', { ph: '(비우면 대상 호스트)' }), F('expect', '기대 IP', { ph: '10.0.0.9' })] },
  cert: { desc: 'TLS 핸드셰이크로 인증서 만료일을 읽습니다. 만료 임박은 주의, 만료는 실패.',
    fields: [F('port', '포트', { ph: '443' }), F('warnDays', '경고 임계(일)', { ph: '30' })] },
  domain: { desc: 'whois(TCP 43) 로 도메인 만료일을 확인합니다. TLD 별 형식 차이로 파싱 실패가 있을 수 있어 주기는 1일 권장.',
    fields: [F('record', '도메인', { ph: 'example.com — 비우면 대상 호스트' }), F('warnDays', '경고 임계(일)', { ph: '60' })] },
  ntp: { desc: 'SNTP 로 서버 시각과의 오프셋을 봅니다. 시간 오차는 인증·OTP 실패의 흔한 원인입니다.',
    fields: [F('server', 'NTP 서버', { ph: '(비우면 대상 호스트)' }),
      F('warnMs', '주의 임계(ms)', { ph: '1000' }), F('badMs', '실패 임계(ms)', { ph: '5000' })] },
  smtp: { desc: '연결 후 220 인사말을 확인합니다. 포트만 열린 좀비 프로세스를 걸러냅니다.',
    fields: [F('port', '포트', { ph: '25' }), F('send', '보낼 명령', { ph: 'EHLO test' }), F('keyword', '응답 키워드')] },
  pop3: { desc: '연결 후 +OK 인사말을 확인합니다. 995(TLS) 는 배너가 암호화되어 TCP 점검을 권장.',
    fields: [F('port', '포트', { ph: '110' }), F('keyword', '응답 키워드')] },
  imap: { desc: '연결 후 * OK 인사말을 확인합니다. 993(TLS) 는 TCP 점검을 권장.',
    fields: [F('port', '포트', { ph: '143' }), F('keyword', '응답 키워드')] },
  ssh: { desc: 'SSH-2.0 배너를 확인합니다. 응답값에 버전 문자열이 남아 패치 추적에도 쓸 수 있습니다.',
    fields: [F('port', '포트', { ph: '22' }), F('keyword', '응답 키워드')] },
  ldap: { desc: '익명 simple bind 로 디렉터리 서버 응답을 확인합니다(익명 금지 서버도 응답하면 정상 판정).',
    fields: [F('port', '포트', { ph: '389' })] },
};

// 서버가 계산한 state 를 그대로 쓴다 — 낡음 판정 기준(주기×3)을 화면에 또 두면 갈라지고,
// 브라우저 시계가 틀린 경우 판정이 달라진다. state 가 없는 응답(구버전)만 폴백한다.
export const statusOf = (t, x) => x.state
  || ((t.enabled === false || x.enabled === false) ? 'disabled' : (x.result?.status || 'pending'));
export const methodText = (t, x) => {
  const base = METHOD[x.type] || x.type;
  if (x.type === 'tcp') return `${base} ${x.port || ''}`.trim();
  if (x.type === 'http') return `${base} (${x.url})`;
  if (x.type === 'dns') return `${base} (${x.record || ''} @ ${x.server || t.host})`;
  return `${base} (${t.host})`;
};

export const EMPTY_TEST = { name: '', type: 'ping', intervalSec: 60, port: '', url: '', keyword: '', record: '', server: '' };
