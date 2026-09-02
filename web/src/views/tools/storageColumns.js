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
const RIGHT = [
  { key: 'status', label: '상태' },
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
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

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
