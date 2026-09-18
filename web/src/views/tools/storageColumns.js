/**
 * storageColumns.js — 스토리지 타입별 표 컬럼 정의(v2.406, 사용자 요구
 * 'PowerStore 전용 컬럼을 포함해 각각의 스토리지 전용 컬럼').
 *
 * 왜 순수 모듈로 분리했나: 웹 테스트가 node 환경(DOM 없음)이라 컴포넌트 렌더는 테스트할 수
 * 없다. 그래서 **어떤 타입에 어떤 컬럼이 나오고 각 칸의 값이 무엇인지**(순수 계산)를 여기 두고
 * 회귀로 고정한다. 실제 셀 그리기(막대·배지)는 StorageMonTool 이 key 로 분기해 담당한다
 * (components/accessDeniedText.js 와 같은 패턴).
 *
 * ── 설계 ─────────────────────────────────────────────────────────────────────
 * 컬럼 = 공통 왼쪽(장비·법인·수집·버전) + 타입 전용 + 공통 오른쪽(상태·작업).
 * '타입' 컬럼은 표가 단일 타입일 때 생략한다 — 표 제목에 이미 타입이 있고, 그 컬럼이
 * 약 148px 을 먹어 좁은 화면에서 오른쪽 '작업' 열이 잘리는 직접 원인이었다(v2.403 실측).
 *
 * ⚠ 값이 없으면 0 이 아니라 null 을 돌려준다 — 렌더가 '—' 로 그린다. 수집 실패를 0 으로
 *   위장하면 '용량 0' 처럼 사실과 다른 화면이 된다(types.js 정직 표기 규칙과 같은 이유).
 */

/** 공통 왼쪽/오른쪽 컬럼(모든 타입). */
const LEFT = [
  { key: 'device', label: '장비' },
  { key: 'type', label: '타입', onlyMixed: true },
  { key: 'dc', label: '법인' },
  { key: 'collect', label: '수집' },
  { key: 'version', label: '버전' },
];
// ⚠ `status` 는 **수집 성패**다(장비 부품 상태가 아니다). 라벨이 그냥 '상태' 였던 v2.566 까지는
// 노드 1대가 고장난 장비의 행이 초록 '정상' 으로 보였다 — **색과 글자가 반대말을 하는**
// v2.526 `healthBadge` 와 같은 결함이고, v2.567 의 '장애 장비만' 필터를 켜면 그 행만 남으므로
// 화면이 "장애 1대" 라고 말한 바로 옆에서 "정상" 이라고 말한다. 사람은 색을 먼저 읽는다.
// 라벨을 되돌리지 말 것 — 장비 장애는 `노드`·`health` 열과 '장애 장비' 카드가 말한다.
const RIGHT = [
  { key: 'status', label: '수집 상태' },
  { key: 'actions', label: '작업', align: 'right' },
];

/**
 * 타입 전용 컬럼.
 * - isilon : 기존 화면 유지(사용률 + HDD/SSD 풀) — 운영자가 isi status 와 대조하는 열이다.
 * - powerstore : 사용자가 지정한 열(전체/사용/가용/Physical/Logical/Data Reduction).
 * - unity/vmax/powermax : 용량 3종 + 그 타입의 구성 단위(풀·어레이).
 * - xtremio : 전량 플래시라 HDD/SSD 구분이 무의미 — 물리 용량 + 감축률(XtremIO 의 핵심 지표).
 * - vplex/metronode : **자체 물리 용량이 없다**(뒤단 어레이를 가상화). 용량 열을 만들지 않고
 *   클러스터·디렉터·헬스를 보여준다 — 빈 용량 열을 두면 '용량 0' 으로 오독된다.
 */
const BY_TYPE = {
  isilon: [
    { key: 'usage', label: '사용률(전체)', minWidth: 140 },
    { key: 'hdd', label: 'HDD 풀', minWidth: 120 },
    { key: 'ssd', label: 'SSD 풀', minWidth: 120 },
    { key: 'nodes', label: '노드', align: 'right' },
    { key: 'accounts', label: '계정', align: 'right' },
  ],
  powerstore: [
    { key: 'usage', label: '사용률', minWidth: 130 },
    { key: 'capTotal', label: '전체 용량', align: 'right' },
    { key: 'capUsed', label: '사용 용량', align: 'right' },
    { key: 'capFree', label: '가용 용량', align: 'right' },
    { key: 'physical', label: 'Physical', align: 'right' },
    { key: 'logical', label: 'Logical', align: 'right' },
    { key: 'dataReduction', label: 'Data Reduction', align: 'right' },
    { key: 'nodes', label: '노드', align: 'right' },
  ],
  unity480: [
    { key: 'usage', label: '사용률', minWidth: 130 },
    { key: 'capTotal', label: '전체 용량', align: 'right' },
    { key: 'capUsed', label: '사용 용량', align: 'right' },
    { key: 'capFree', label: '가용 용량', align: 'right' },
    { key: 'pools', label: '풀', align: 'right' },
    { key: 'nodes', label: 'SP', align: 'right' },
    { key: 'accounts', label: '계정', align: 'right' },
  ],
  xtremio: [
    { key: 'usage', label: '물리 사용률', minWidth: 130 },
    { key: 'capTotal', label: '물리 전체', align: 'right' },
    { key: 'capUsed', label: '물리 사용', align: 'right' },
    { key: 'capFree', label: '물리 가용', align: 'right' },
    { key: 'dataReduction', label: 'Data Reduction', align: 'right' },
    { key: 'bricks', label: 'Brick', align: 'right' },
    { key: 'nodes', label: 'SC', align: 'right' },
  ],
  vmax: [
    { key: 'usage', label: '사용률', minWidth: 130 },
    { key: 'capTotal', label: '전체 용량', align: 'right' },
    { key: 'capUsed', label: '사용 용량', align: 'right' },
    { key: 'capFree', label: '가용 용량', align: 'right' },
    { key: 'arrays', label: '어레이', align: 'right' },
    { key: 'accounts', label: '계정', align: 'right' },
  ],
  vplex: [
    { key: 'clusters', label: '클러스터', align: 'right' },
    { key: 'nodes', label: '디렉터', align: 'right' },
    { key: 'storageVolumes', label: '스토리지 볼륨', align: 'right' },
    { key: 'health', label: 'Health' },
    { key: 'accounts', label: '계정', align: 'right' },
  ],
};
BY_TYPE.powermax = BY_TYPE.vmax;
BY_TYPE.metronode = BY_TYPE.vplex;

/** 타입을 모르거나 표에 여러 타입이 섞였을 때 쓰는 최소 공통 열(어느 타입에나 값이 있다). */
export const MIXED_COLUMNS = [
  { key: 'usage', label: '사용률', minWidth: 130 },
  { key: 'capTotal', label: '전체 용량', align: 'right' },
  { key: 'capUsed', label: '사용 용량', align: 'right' },
  { key: 'capFree', label: '가용 용량', align: 'right' },
  { key: 'nodes', label: '노드', align: 'right' },
  { key: 'accounts', label: '계정', align: 'right' },
];

/**
 * 그 표에 쓸 컬럼 목록.
 * @param type  단일 타입이면 그 타입, 여러 타입이 섞였으면 null
 */
export function columnsFor(type) {
  const mid = type ? (BY_TYPE[type] || MIXED_COLUMNS) : MIXED_COLUMNS;
  const left = LEFT.filter((c) => !(c.onlyMixed && type)); // 단일 타입 표는 '타입' 열 생략
  return [...left, ...mid, ...RIGHT];
}

/** 이 타입에 전용 컬럼 정의가 있는지(없으면 공통 열을 쓴다 — 화면 안내용). */
export const hasTypeColumns = (type) => Boolean(BY_TYPE[type]);

/**
 * 한 칸의 값(순수). 렌더에 필요한 '숫자/문자'만 돌려주고, 막대·배지 그리기는 호출부가 한다.
 * 값이 없으면 null(렌더가 '—'). 0 은 '진짜 0' 일 때만 돌려준다.
 */
export function cellValue(key, row) {
  const s = row?.snap || null;
  const ex = s?.extra || {};
  const cap = s?.capacity || null;
  // ⚠ null/'' 을 먼저 걸러야 한다 — Number(null)===0 이 유한값이라 미수집이 '0%'·'0 TB' 로 둔갑한다
  //   (모듈 머리말 규칙 위반 사례 — v2.416 리뷰 확정).
  const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

  switch (key) {
    case 'usage': return num(cap?.pct);
    case 'capTotal': return num(cap?.totalBytes) || null;
    case 'capUsed': return num(cap?.usedBytes) ?? null;
    // 가용 = 전체 − 사용. 전체를 모르면 계산하지 않는다(음수/0 로 위장 금지).
    case 'capFree': {
      const t = num(cap?.totalBytes);
      const u = num(cap?.usedBytes);
      return t && u != null ? Math.max(0, t - u) : null;
    }
    case 'physical': return num(ex.space?.physicalUsed) ?? null;
    case 'logical': return num(ex.space?.logicalUsed) ?? null;
    case 'dataReduction': {
      // PowerStore 는 숫자(3.1), XtremIO 는 문자열('3.1:1') 로 온다 — 둘 다 숫자로 통일한다.
      const v = ex.space?.dataReduction ?? ex.dataReduction;
      if (v == null || v === '') return null;
      const m = /^([\d.]+)/.exec(String(v));
      return m ? Number(m[1]) : null;
    }
    case 'hdd': return s?.media?.hdd || null;
    case 'ssd': return s?.media?.ssd || null;
    case 'pools': return s ? (s.pools || []).length : null;
    case 'nodes': return s ? (s.nodes?.count ?? 0) : null;
    case 'accounts': return s ? (s.accounts?.length ?? 0) : null;
    case 'arrays': return Array.isArray(ex.arrays) ? ex.arrays.length : null;
    case 'bricks': return num(ex.numBricks);
    case 'clusters': return Array.isArray(ex.clusters) ? ex.clusters.length : null;
    case 'storageVolumes': return num(ex.storageVolumes?.count);
    case 'health': return ex.healthState || ex.clusterHealth || null;
    default: return null;
  }
}

/**
 * 표 정렬 값(v2.514) — **헤더 클릭 정렬이 장비 표에서 통째로 동작하지 않던 버그의 수정**.
 *
 * 사용자 신고(2026-09-15, 스크린샷): "법인 클릭해도 소팅 안되는 버그 · 표 전체에서 소팅 안되는 버그".
 *
 * 원인: `StorageMonTool` 이 셀에 `data-sort={cellValue(key,row)}` 를 실어 STable 에 정렬 값을
 * 주고 있었는데(v2.425), **`cellValue` 는 타입 전용 열만 계산한다** — 공통 열
 * (`device`·`type`·`dc`·`collect`·`version`·`status`)은 `default: return null` 로 떨어져
 * 전부 빈 값이 됐다. STable 은 빈 값을 '항상 뒤로' 규칙에 따라 **원래 순서 그대로** 두므로
 * 그 열들은 눌러도 순서가 변하지 않았다(브라우저 실측: `aria-sort` 만 바뀌고 DOM 행 순서 불변).
 * 스냅샷이 아직 없는 장비만 있는 화면에서는 타입 전용 열도 전부 null 이라 **표 전체**가 그랬다.
 *
 * 그래서 정렬 값은 `cellValue` 가 아니라 이 함수가 소유한다 — **화면에 보이는 것과 같은 값**으로
 * 정렬해야 하기 때문이다(장비=표시명, 법인=표시명, 수집=엣지 이름, 버전=스냅샷 버전).
 *
 * ⚠ 지킬 것:
 *  · 공통 열을 여기서 빼면 그 열이 **조용히 정렬 불가**가 된다(오류가 아니라 '눌러도 안 되는' 상태라
 *    사용자만 알아챈다 — 이 버그가 정확히 그랬다). `storageColumns.test.js` 가 전 열을 고정한다.
 *  · 표시가 이름(법인·타입)인 열은 **표시명으로** 정렬한다. 원시 id(`dc-wa`)로 정렬하면 화면의
 *    글자 순서와 달라 사용자가 '정렬이 틀렸다' 고 본다. 그래서 라벨 함수를 주입받는다.
 *  · 값이 없으면 `''` 를 돌려준다 — STable 이 방향과 무관하게 뒤로 보낸다(CLAUDE.md 규칙).
 *
 * @param {string} key   컬럼 key
 * @param {object} row   장비 행(= 레지스트리 항목 + `snap`)
 * @param {{typeLabel?:(t:string)=>string, dcName?:(id:string)=>string}} [labels] 표시명 변환
 * @returns {string} STable 이 인식하는 정렬 문자열(숫자·단위·날짜는 STable 이 해석한다)
 */
export function sortValue(key, row, labels = {}) {
  const s = row?.snap || null;
  const typeLabel = labels.typeLabel || ((t) => String(t ?? ''));
  const dcName = labels.dcName || ((id) => String(id ?? ''));
  switch (key) {
    // 화면은 **장비가 보고한 이름을 우선** 보여준다(v2.530 — Cell 'device' 와 같은 규칙,
    // 사용자 요청 "hostname 에서 획득한 장비 명"). 여기를 등록명 우선으로 되돌리면
    // 정렬 기준과 보이는 글자가 어긋나 사용자가 '정렬이 틀렸다' 고 본다.
    case 'device': return String(s?.name || row?.name || row?.host || '');
    case 'type': return String(typeLabel(row?.type) || '');
    case 'dc': return String(dcName(row?.datacenterId) || '');
    // 수집 주체 — 중앙은 엣지보다 앞(빈 문자열은 '뒤로' 규칙에 걸리므로 '중앙' 을 쓴다).
    case 'collect': return String(row?.agent || '중앙');
    case 'version': return String(s?.version || '');
    // 상태 — 실패(0) < 수집 전(1) < 부분(2) < 정상(3). 오름차순에서 문제 장비가 먼저 온다.
    case 'status': {
      if (!s) return '1';
      if (!s.ok) return '0';
      const partial = Object.values(s.sections || {}).some((v) => /오류/.test(String(v)));
      return partial ? '2' : '3';
    }
    case 'actions': return '';
    // HDD/SSD 풀은 **객체**다(`{usedBytes,totalBytes,pct}`) — 그대로 String() 하면
    // 모든 행이 '[object Object]' 가 되어 정렬이 통째로 죽는다(v2.514 테스트가 잡은 결함).
    // 화면(MediaCell)이 그리는 것은 사용률 막대이므로 정렬도 pct 로 한다.
    case 'hdd': case 'ssd': {
      const m = cellValue(key, row);
      const pct = m && typeof m === 'object' ? m.pct : null;
      return pct == null ? '' : String(pct);
    }
    default: {
      const v = cellValue(key, row);
      // 객체가 새로 생기면 '[object Object]' 로 조용히 정렬이 죽으므로 빈 값으로 떨군다
      // (정렬이 안 되는 것이 '전부 같은 값' 으로 보이는 것보다 낫다 — 후자는 원인을 못 찾는다).
      if (v != null && typeof v === 'object') return '';
      return v == null ? '' : String(v);
    }
  }
}
