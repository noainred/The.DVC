/**
 * views/runtimeBannerText.js — 서버 Node 런타임 불일치 배너 문구(검토 I-06). 순수 모듈.
 *
 * 입력은 GET /api/health 의 runtime 필드(server/src/util/runtimeCheck.js runtimeForHealth):
 *   · 관리자(전체 범위): { state, node, major, supported, code, releaseRelation, contract:{…, engines}, selfCheck:{ state, code, … } }
 *   · 그 밖의 계정:       { state } 만
 *   · 구버전 서버:        필드 없음 → 배너 없음(판정하지 않는다).
 *
 * 왜 배너인가: 비지원 major 에서는 전역 fetch + undici Agent 조합이 실패해 vCenter·iDRAC·Horizon·스토리지 수집이 전부
 * '연결 실패' 처럼 보인다. 그 화면만 보면 사용자는 **장비 장애**를 의심한다 — 원인이 포탈 런타임이라는 사실을 먼저 말한다.
 *
 * 규칙:
 *   · mismatch(통신 불일치 확인) — 모든 계정에 보인다(장비 장애 오판을 막는 것이 목적). 상세는 관리자 응답에만 있다.
 *   · unsupported(계약 밖 버전, 통신 자가 점검은 통과했거나 아직) · error(판정 불가) — 관리자 응답(상세 필드)이 있을 때만.
 *   · ok · checking · unchecked · 모르는 값 — 배너 없음(없는 문제를 만들지 않는다).
 * ⚠ 문구에 백틱 금지(BoldText 는 강조 표기만 해석한다) — 값 인용은 홑화살괄호. 버전 숫자 뒤에 조사를 붙이지 않는다.
 */

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const q = (v) => `‘${v}’`;

/**
 * @param {object|null|undefined} health /api/health 응답
 * @returns {null | { tone:'bad'|'warn', title:string, text:string, state:string }}
 */
export function runtimeBanner(health) {
  const rt = health && typeof health === 'object' ? health.runtime : null;
  if (!rt || typeof rt !== 'object') return null;
  const state = str(rt.state);
  const full = typeof rt.node === 'string'; // 관리자(전체 범위) 응답만 버전·계약·상세를 싣는다
  const node = str(rt.node);
  const engines = str(rt.contract?.engines);
  const release = str(rt.contract?.releaseVersion);
  const scCode = str(rt.selfCheck?.code);
  const contractText = engines ? `지원 범위 ${q(engines)}${release ? `, 검증 버전 ${q(release)}` : ''}` : '지원 범위';
  const nodeTag = node ? `Node(${q(node)})` : 'Node'; // 조사는 괄호 뒤에 — 'Node' 의 소리로 고른다
  const fixText = release ? `설치 패키지에 든 Node(검증 버전 ${q(release)})로 포탈을 다시 시작하세요` : '설치 패키지에 든 Node 로 포탈을 다시 시작하세요';

  if (state === 'mismatch') {
    if (!full) {
      return {
        tone: 'bad', state, title: '포탈 서버 런타임 불일치',
        text: '포탈 서버의 Node 런타임이 지원 범위와 맞지 않아 장비 통신(HTTPS 수집)이 실패하고 있을 수 있습니다. vCenter·iDRAC·스토리지 등의 수집 실패를 장비 장애로 판단하기 전에 관리자에게 알리세요.',
      };
    }
    return {
      tone: 'bad', state, title: '포탈 서버 런타임 불일치',
      text: `포탈 서버의 ${nodeTag}에서 통신 자가 점검이 실패했습니다${scCode ? `(${q(scCode)})` : ''} — 전역 fetch 와 undici 디스패처가 맞지 않습니다(${contractText}). `
        + `지금 보이는 vCenter·iDRAC·Horizon·스토리지 수집 실패는 장비 장애가 아닐 수 있습니다. ${fixText}.`,
    };
  }
  if (!full) return null; // 아래 둘은 확인된 장애가 아니다 — 관리자에게만 알린다

  if (state === 'unsupported') {
    const code = str(rt.code);
    const why = code === 'below-minimum' ? '내장 SQLite 가 없는 버전이라 시계열 저장이 NDJSON 폴백으로 동작합니다'
      : code === 'unparsed' ? '버전을 읽지 못했습니다'
        : '검증하지 않은 런타임입니다';
    const sc = str(rt.selfCheck?.state);
    const scText = sc === 'ok' ? ' 통신 자가 점검은 통과했지만' : sc === 'error' || sc === 'timeout' ? ' 통신 자가 점검도 판정하지 못했고' : '';
    return {
      tone: 'warn', state, title: '지원 범위 밖 Node 런타임',
      text: `포탈 서버의 ${nodeTag}는 ${engines ? `지원 범위(${q(engines)})` : '지원 범위'} 밖입니다.${scText} ${why}. ${fixText}.`,
    };
  }
  if (state === 'error') {
    return {
      tone: 'warn', state, title: '런타임 통신 자가 점검 판정 불가',
      text: `포탈 서버 ${nodeTag}의 통신 자가 점검을 판정하지 못했습니다${scCode ? `(${q(scCode)})` : ''} — 루프백 통신이 막혔거나 점검이 시한을 넘겼습니다. `
        + '장비 수집 실패가 함께 보이면 특수 기능 › 다빈치 서비스 점검의 Node 런타임 호환성 행을 확인하세요.',
    };
  }
  return null;
}
