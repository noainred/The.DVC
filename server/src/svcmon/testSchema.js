/**
 * 점검 필드의 **단일 정의** — `store.js cleanTest`, CSV 가져오기/내보내기, 샘플 CSV 생성,
 * 템플릿 항목 검증이 모두 이 표에서 파생된다.
 *
 * 왜 표로 두는가: 같은 필드 목록을 네 곳에 복사해 두면 필드를 추가한 날 한 곳만 갱신되고
 * 나머지는 조용히 그 값을 버린다(`ipam/record.js` 와 같은 원칙 — 컬럼 정의를 워커에 복사해
 * 뒀다가 INSERT 만 밀린 사례가 있었다).
 *
 * 이 모듈은 **순수 데이터·순수 함수만** 둔다(파일·소켓·설정 접근 없음) — 워커 스레드와
 * 프런트 빌드 어느 쪽에서 읽어도 부작용이 없어야 한다.
 */

export const TEST_TYPES = ['ping', 'trace', 'tcp', 'udp', 'http', 'soap', 'dns', 'cert', 'ntp',
  'smtp', 'pop3', 'imap', 'ssh', 'ldap', 'domain'];
export const KINDS = ['infra', 'service'];

/**
 * 점검 필드표. 순서 = CSV 컬럼 순서.
 *
 *  key       저장 객체의 키
 *  col       CSV 컬럼명(영문 스네이크 — 엑셀에서 손으로 타이핑하지 않고 샘플을 받아 쓴다)
 *  kind      'text' | 'int' | 'bool' | 'enum' | 'port'
 *  max/min   text=글자수 상한, int=값 범위
 *  dflt      값이 없을 때 채우는 기본값(없으면 미지정으로 남긴다)
 *  dfltByType 유형별 기본값(`*` 는 그 외 전부)
 *  optional  true 면 값이 없을 때 키를 만들지 않는다(미지정)
 *  requiredFor 이 유형들에서는 필수(비면 오류)
 *  usedBy    이 필드가 의미를 갖는 유형(문서·샘플·UI 용. 검증에는 쓰지 않는다 —
 *            과거 데이터에 남은 값을 지우면 되돌릴 수 없다)
 *  host      true 면 호스트 형식 + SSRF 가드를 적용한다(실제 목적지가 되는 필드)
 *  subst     true 면 템플릿 치환 변수({host} 등)를 넣을 수 있는 문자열 필드
 */
export const TEST_FIELDS = [
  { key: 'name', col: 'test_name', kind: 'text', max: 80, label: '점검 이름', subst: true },
  { key: 'type', col: 'type', kind: 'enum', values: TEST_TYPES, label: '유형' },
  { key: 'intervalSec', col: 'interval_sec', kind: 'int', min: 10, max: 86400, dflt: 60, label: '주기(초)' },
  { key: 'enabled', col: 'test_enabled', kind: 'bool', dflt: true, label: '사용' },
  { key: 'port', col: 'port', kind: 'port', requiredFor: ['tcp', 'udp'], label: '포트' },
  { key: 'url', col: 'url', kind: 'text', max: 500, optional: true, requiredFor: ['http', 'soap'], usedBy: ['http', 'soap'], subst: true, label: 'URL' },
  { key: 'keyword', col: 'keyword', kind: 'text', max: 200, optional: true, usedBy: ['http', 'soap', 'smtp', 'pop3', 'imap', 'ssh'], subst: true, label: '포함 문자열' },
  { key: 'expectStatus', col: 'expect_status', kind: 'int', min: 100, max: 599, optional: true, usedBy: ['http', 'soap'], label: '기대 상태코드' },
  { key: 'insecure', col: 'insecure', kind: 'bool', dflt: false, usedBy: ['http', 'soap'], label: '자체서명 허용' },
  { key: 'record', col: 'record', kind: 'text', max: 253, optional: true, host: true, usedBy: ['dns', 'domain'], subst: true, label: '조회 이름' },
  { key: 'server', col: 'server', kind: 'text', max: 253, optional: true, host: true, usedBy: ['dns', 'ntp'], subst: true, label: '질의 서버' },
  { key: 'expect', col: 'expect', kind: 'text', max: 64, optional: true, usedBy: ['dns'], subst: true, label: '기대 결과' },
  { key: 'payload', col: 'payload', kind: 'text', max: 200, optional: true, usedBy: ['udp'], subst: true, label: '보낼 페이로드' },
  { key: 'send', col: 'send', kind: 'text', max: 200, optional: true, usedBy: ['smtp', 'pop3', 'imap', 'ssh'], subst: true, label: '연결 후 보낼 명령' },
  { key: 'body', col: 'body', kind: 'text', max: 4000, optional: true, usedBy: ['soap'], subst: true, label: '요청 본문(XML)' },
  { key: 'soapAction', col: 'soap_action', kind: 'text', max: 200, optional: true, usedBy: ['soap'], subst: true, label: 'SOAPAction' },
  { key: 'warnDays', col: 'warn_days', kind: 'int', min: 1, max: 365, dfltByType: { domain: 60, '*': 30 }, usedBy: ['cert', 'domain'], label: '경고 D-일' },
  { key: 'warnMs', col: 'warn_ms', kind: 'int', min: 1, max: 600000, optional: true, usedBy: ['http', 'soap', 'ntp'], label: '경고 임계(ms)' },
  { key: 'badMs', col: 'bad_ms', kind: 'int', min: 1, max: 600000, optional: true, usedBy: ['ntp'], label: '실패 임계(ms)' },
  { key: 'maxHops', col: 'max_hops', kind: 'int', min: 1, max: 64, optional: true, usedBy: ['trace'], label: '최대 홉' },
];

/**
 * 대상 필드표 — CSV 앞부분 5열. `tests` 는 행 그룹핑으로 만들므로 컬럼이 없다.
 * `order`/`id`/`batch` 는 **일부러 제외**한다:
 *   id    cleanTarget 이 입력 id 를 읽지 않고 항상 새로 발급한다(왕복에서 무의미).
 *   order 빈 칸이 0 이 되어 전 행이 같아지면 수동 정렬이 무너진다.
 *   batch 서버가 발급하는 태그 — 사용자 입력으로 받으면 남의 배치에 태그가 붙는다.
 */
export const TARGET_FIELDS = [
  { key: 'kind', col: 'kind', kind: 'enum', values: KINDS, label: '구분' },
  { key: 'path', col: 'path', kind: 'text', max: 620, label: '트리 경로' },
  { key: 'name', col: 'target_name', kind: 'text', max: 120, label: '대상 이름' },
  { key: 'host', col: 'host', kind: 'text', max: 253, host: true, label: '호스트/IP' },
  { key: 'enabled', col: 'target_enabled', kind: 'bool', dflt: true, label: '사용' },
];

/** CSV 컬럼 순서 = 대상 5열 + 점검 20열. */
export const CSV_COLUMNS = [...TARGET_FIELDS, ...TEST_FIELDS].map((f) => f.col);

export const TEST_FIELD_BY_KEY = new Map(TEST_FIELDS.map((f) => [f.key, f]));
export const TEST_FIELD_BY_COL = new Map(TEST_FIELDS.map((f) => [f.col, f]));
export const TARGET_FIELD_BY_COL = new Map(TARGET_FIELDS.map((f) => [f.col, f]));

/** 템플릿 치환이 가능한 문자열 필드 키 목록. */
export const SUBST_KEYS = TEST_FIELDS.filter((f) => f.subst).map((f) => f.key);

/** 유형별 필수 필드(오류 메시지·UI 표시용). */
export function requiredFieldsFor(type) {
  return TEST_FIELDS.filter((f) => f.requiredFor?.includes(type));
}

/** 그 유형에서 의미를 갖는 필드(문서·샘플·미리보기용). usedBy 가 없으면 전 유형 공통. */
export function fieldsFor(type) {
  return TEST_FIELDS.filter((f) => !f.usedBy || f.usedBy.includes(type));
}
