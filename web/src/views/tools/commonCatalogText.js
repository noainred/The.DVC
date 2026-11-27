/**
 * 포탈 점검 › 공통 기능 — 화면 판정 · 문구(순수, v3.10). 설계 docs/design/common-catalog.
 *
 * 화면(`CommonCatalogView.jsx`)은 서버가 준 목록(`GET /tools/portal-check/common`)을 거르고 보여 주기만 한다 —
 * 거르기 · 세기 · 문구는 전부 여기 둔다(DOM 없이 테스트한다).
 *
 * 규칙:
 *  · **'못 읽은 값' 은 0 이 아니다** — 개수가 null 이면 ‘—’ 이고, ‘사용처 0’·‘테스트 0’ 은 **정확히 0 인 것**만 센다.
 *  · 문구에 백틱을 쓰지 않는다(값 인용은 ‘ ’).
 *  · ‘사용처 0’·‘테스트 0’ 은 판정이 아니다 — 살펴볼 후보라는 말을 숫자 옆에 둔다.
 */
import { numOrNull } from '../../numOrNull.js';

/** 구분(서버 `portalcheck/commonCatalog.js COMMON_SCOPES` 와 같은 집합 · 같은 순서 — 테스트가 대조). */
export const SCOPE_IDS = Object.freeze(['server-util', 'web-components', 'web-hooks', 'web-util', 'web-top', 'outside']);
export const SCOPE_LABEL = Object.freeze({
  'server-util': '서버 유틸',
  'web-components': '웹 컴포넌트',
  'web-hooks': '웹 훅',
  'web-util': '웹 유틸',
  'web-top': '웹 최상위',
  outside: '공용 위치 밖',
});
/** 구분 말고도 거를 수 있는 조건 — 숫자 카드가 누르면 건다. */
export const EXTRA_FILTERS = Object.freeze(['all', 'common', 'unused', 'notest', 'twin']);

export const scopeLabel = (id) => SCOPE_LABEL[id] || '구분 모름';
const isCommon = (m) => m?.scope !== 'outside';
const cnt = (v) => { const n = numOrNull(v); return n !== null && n >= 0 ? n : null; };

/**
 * 머리 주석 요약 → 화면 글자(순수). 요약은 소스 주석의 Markdown 그대로라 `**강조**` 와 백틱 코드 표기가 들어 있다 —
 * v3.10 Chromium 판독에서 표와 서랍에 별표 · 백틱이 그대로 보였다. 별표는 떼고, 백틱 짝은 ‘ ’ 로 바꾸고, 짝 없는 백틱은 뗀다.
 * (문서 docs/COMMON.md 는 Markdown 으로 렌더되므로 원문을 그대로 둔다 — 화면에서만 바꾼다.)
 */
export function summaryText(s) {
  return String(s ?? '')
    .replace(/\*\*/g, '')
    .replace(/`([^`\n]+)`/g, '‘$1’')
    .replace(/`/g, '');
}

/** 경로 → 파일 이름 · 폴더(끝에 ‘/’). */
export function baseName(file) { return String(file ?? '').split('/').pop() || ''; }
export function dirName(file) {
  const parts = String(file ?? '').split('/');
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

/** 숫자 칸 글자 — 못 읽었으면 ‘—’(0 이 아니다). */
export function countText(v) {
  const n = cnt(v);
  return n === null ? '—' : n.toLocaleString('en-US');
}

/**
 * 숫자 카드 5개의 값. ‘사용처 0’·‘테스트 0’ 은 **공용 위치의 모듈**만 센다(문서 `docs/COMMON.md` 의 요약 표와 같은 기준 —
 * 공용 위치 밖 모듈은 ‘널리 쓰여서’ 실린 것이라 사용처 0 일 수 없다).
 */
export function kpiOf(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const common = list.filter(isCommon);
  const outside = list.filter((m) => m?.scope === 'outside');
  return {
    total: list.length,
    common: common.length,
    outside: outside.length,
    outsideServer: outside.filter((m) => String(m.file ?? '').startsWith('server/')).length,
    outsideWeb: outside.filter((m) => String(m.file ?? '').startsWith('web/')).length,
    unused: common.filter((m) => cnt(m.users) === 0).length,
    notest: common.filter((m) => cnt(m.tests) === 0).length,
    // 두 벌은 ‘짝’ 으로 센다(서버 · 웹 두 줄이 한 벌).
    twins: Math.floor(common.filter((m) => m.twin).length / 2),
    twinNames: [...new Set(common.filter((m) => m.twin).map((m) => baseName(m.file).replace(/\.\w+$/, '')))].sort(),
  };
}

/** 구분 칩의 개수(전체 + 구분 6개). */
export function chipCounts(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const out = { all: list.length };
  for (const id of SCOPE_IDS) out[id] = 0;
  for (const m of list) if (m?.scope in out) out[m.scope] += 1;
  return out;
}

/** 찾기 — 모듈 경로 · 내보내는 이름 · 설명에서 대소문자 구분 없이 부분 일치. 빈 검색어는 전부. */
export function matchesQuery(m, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  if (String(m?.file ?? '').toLowerCase().includes(needle)) return true;
  if (String(m?.summary ?? '').toLowerCase().includes(needle)) return true;
  return (Array.isArray(m?.exports) ? m.exports : []).some((e) => String(e).toLowerCase().includes(needle));
}

/** 거르기 조건 하나(구분 id 또는 EXTRA_FILTERS). 모르는 조건은 전부(잘못된 값으로 표가 비지 않게). */
export function matchesFilter(m, filter) {
  if (SCOPE_IDS.includes(filter)) return m?.scope === filter;
  if (filter === 'common') return isCommon(m);
  if (filter === 'unused') return isCommon(m) && cnt(m.users) === 0;
  if (filter === 'notest') return isCommon(m) && cnt(m.tests) === 0;
  if (filter === 'twin') return isCommon(m) && !!m.twin;
  return true;
}

/** 조건 + 검색어로 거른다. 정렬은 표(`STable`)가 한다 — 기본 순서는 사용처 많은 순(못 읽은 값은 뒤). */
export function applyFilter(modules, { filter = 'all', q = '' } = {}) {
  const list = (Array.isArray(modules) ? modules : []).filter((m) => matchesFilter(m, filter) && matchesQuery(m, q));
  return list.sort((a, b) => {
    const ua = cnt(a.users); const ub = cnt(b.users);
    if (ua === null || ub === null) return (ua === null ? 1 : 0) - (ub === null ? 1 : 0) || String(a.file).localeCompare(String(b.file));
    return ub - ua || String(a.file).localeCompare(String(b.file));
  });
}

/** 내보내는 이름 칸 — 앞의 몇 개와 ‘외 N’. */
export function exportsView(exports, max = 4) {
  const list = Array.isArray(exports) ? exports : [];
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max), total: list.length };
}

/** 영역 이름 — ‘server:storage’ → ‘storage’(접두는 폴더 구분용이라 화면에는 뺀다). */
export function areaLabel(area) {
  const s = String(area ?? '');
  const i = s.indexOf(':');
  return i === -1 ? s : s.slice(i + 1);
}

/** 영역 폴더 설명 한 줄 — 그 모듈이 서버 것인지 웹 것인지에 따라. */
export function areaNote(file) {
  const f = String(file ?? '');
  if (f.startsWith('server/')) return '영역 = server/src 아래 폴더. 파일 목록은 싣지 않고 영역별 개수만 보여 줍니다.';
  if (f.startsWith('web/')) return '영역 = web/src 아래 폴더(도구 화면은 views/tools). 파일 목록은 싣지 않고 영역별 개수만 보여 줍니다.';
  return '파일 목록은 싣지 않고 영역별 개수만 보여 줍니다.';
}

/** 안내 줄의 둘째 문장 — 언제 · 무엇으로 만든 목록인가. 못 읽은 값은 지어내지 않고 뺀다. */
export function builtText({ version, fileCount } = {}) {
  const v = String(version ?? '').trim();
  const n = cnt(fileCount);
  const when = v ? `v${v.replace(/^v/i, '')} 빌드 때` : '빌드할 때';
  const from = n === null ? '소스에서' : `소스 ${n.toLocaleString('en-US')}개 파일에서`;
  return `${when} ${from} 만든 목록 · 이 포탈에서 다시 만들 수 없습니다`;
}

/** 표 아래 설명 — 세는 방식과 한계. */
export function footnoteText(dynamicUnknown) {
  const n = cnt(dynamicUnknown?.count);
  const dyn = n === null ? '경로를 런타임에 조합하는 동적 import 는 세지 못합니다'
    : n === 0 ? '경로를 런타임에 조합하는 동적 import 는 없었습니다'
      : `경로를 런타임에 조합하는 동적 import ${n}건은 세지 못했습니다`;
  return `사용처 = 그 모듈을 import 하는 파일 수(테스트 제외) · 영역 = 사용처가 속한 폴더 수 · 테스트 = 그 모듈을 가리키는 테스트 파일 수. ${dyn} — ‘사용처 0’ · ‘테스트 0’ 은 판정이 아니라 살펴볼 후보입니다.`;
}

/** 목록이 없는 상태(서버 status) → 제목 · 본문. ok 면 null. */
export function statusView(status) {
  if (status === 'ok') return null;
  if (status === 'missing') {
    return {
      tone: 'gray',
      title: '이 설치본에는 공통 기능 목록이 실려 있지 않습니다',
      body: '목록은 빌드할 때 소스에서 만들어 설치본에 함께 싣습니다. 파일이 없습니다 — 같은 버전을 다시 설치하거나 버전을 올리면 보입니다.',
    };
  }
  // unreadable 과 모르는 상태 — 둘 다 ‘읽지 못했다’ 이지 ‘모듈이 0개’ 가 아니다.
  return {
    tone: 'red',
    title: '공통 기능 목록 파일을 읽지 못했습니다',
    body: '형식이 맞지 않거나 읽을 수 없습니다. 모듈이 0개라는 뜻이 아닙니다 — 설치본 파일이 손상됐을 수 있으니 같은 버전을 다시 설치해 보십시오.',
  };
}

/** 찾는 것이 없을 때 — ‘없다’ 고 단정하지 않고 찾은 범위를 밝힌다. */
export function emptyView({ q = '', filter = 'all', kpi } = {}) {
  const needle = String(q ?? '').trim();
  const where = filter === 'all'
    ? `공용 위치 밖 ${countText(kpi?.outside)}개도 함께 찾았습니다`
    : `지금 건 조건(${filterLabel(filter)}) 안에서만 찾았습니다`;
  return {
    title: needle ? `‘${needle}’ 와 맞는 공용 모듈이 없습니다` : '이 조건에 맞는 모듈이 없습니다',
    body: `모듈 이름 · 내보내는 이름 · 설명에서 찾았고, ${where}. 도메인 폴더 안에만 있는 모듈은 이 목록에 없을 수 있습니다.`,
  };
}

/** 조건의 이름(칩 · 숫자 카드 · 빈 결과 문구가 같은 말을 쓴다). */
export function filterLabel(filter) {
  if (SCOPE_IDS.includes(filter)) return scopeLabel(filter);
  if (filter === 'common') return '공용 모듈';
  if (filter === 'unused') return '사용처 0';
  if (filter === 'notest') return '테스트 0';
  if (filter === 'twin') return '서버 · 웹 두 벌';
  return '전체';
}

/** 표 아래 ‘몇 개 중 몇 개’. */
export function shownText({ total, matched, shown }) {
  if (matched === total) return shown < matched ? `${countText(total)}개 중 ${countText(shown)}개 표시 · 제목을 누르면 정렬` : `${countText(total)}개 · 제목을 누르면 정렬`;
  return shown < matched
    ? `${countText(total)}개 중 ${countText(matched)}개가 맞고 ${countText(shown)}개 표시`
    : `${countText(total)}개 중 ${countText(matched)}개`;
}
