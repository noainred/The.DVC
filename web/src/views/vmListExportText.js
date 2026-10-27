/**
 * views/vmListExportText.js — VM 목록 내보내기 창(필요한 항목만 고르기 · 내 저장값) 도우미(순수, v2.798).
 *
 * 사용자 요청: "메모, TAG, 디스크 파티션 종류 등 구성 정보에서 내가 필요한 것만 선택해서 export" + "지금 설정을 기본값으로 · 이름1~5 다섯 칸 · 저장하는 값을 지정".
 * 시안 https://claude.ai/artifact/FS8Uk5piEnbFJE7qvLRWQW. 항목 목록·빠른 조합은 서버(GET /veeam/vm-list/catalog — veeam/vmListCatalog.js)가 준다 — 여기서 복제하지 않는다.
 * v2.800(사용자 지시 "vCenter 화면은 전체 VM, 백업 현황은 백업 — 분리"): 이 창은 **백업 현황 › Detail 의 CSV 버튼**(백업 내보내기)이다.
 *   전체 VM 구성은 'VM 전체 정보 내보내기'(tools/vmExportText.js) — 파티션 한 줄 반복(multi)은 파티션 열과 함께 없앴다.
 */
export const SLOT_COUNT = 5;   // 서버 vmListPrefs.SLOT_COUNT 와 같은 값(테스트 대조)
export const NAME_MAX = 30;
export const SAVE_WHAT = Object.freeze([
  ['cols', '고른 항목과 순서', true],
  ['fmt', '형식(CSV/엑셀)', false],
  ['tagCols', '태그 열 나누기', false],
  ['target', '대상(폴더)', false],
]);

/** VM 의 폴더 단계 — 서버 vmListCsv.folderParts · 화면 buildFolderTree 와 같은 규칙('/' 로 나누고 숨은 'vm' 을 뺀다). */
export const folderParts = (folder) => String(folder || 'vm').split('/').filter((p) => p && p !== 'vm');
const codeCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 고를 수 있는 폴더(상위 폴더 포함) — [{ path:'Prod/Web', depth, count(하위 포함 VM 수) }], 트리와 같은 코드 단위 순서. */
export function folderOptions(vms) {
  const count = new Map();
  for (const v of vms || []) {
    const ps = folderParts(v?.folder);
    for (let i = 1; i <= ps.length; i++) { const k = ps.slice(0, i).join('/'); count.set(k, (count.get(k) || 0) + 1); }
  }
  return [...count.entries()].map(([path, n]) => ({ path, depth: path.split('/').length, count: n }))
    .sort((a, b) => { const pa = a.path.split('/'); const pb = b.path.split('/'); for (let i = 0; i < Math.min(pa.length, pb.length); i++) { const c = codeCmp(pa[i], pb[i]); if (c) return c; } return pa.length - pb.length; });
}
/** 그 폴더(하위 폴더 포함)의 VM. path '' 이면 전체. */
export function vmsInFolder(vms, path) {
  const want = folderParts(path || 'vm');
  if (!want.length) return [...(vms || [])];
  return (vms || []).filter((v) => { const ps = folderParts(v?.folder); return want.every((w, i) => ps[i] === w); });
}

/** 항목 상태 배지 — 카탈로그 avail + 그 vCenter 의 실제 수집 상태(status). 모르면 avail 그대로. */
export function availBadge(item, status = {}) {
  const k = item?.key;
  if (['tags', 'custom'].includes(k) && status.tags && !['ok', 'stale'].includes(status.tags)) {
    return { text: status.tags === 'unsupported' ? '이 vCenter 미지원' : status.tags === 'error' ? '수집 실패' : '수집 전', tone: 'warn' };
  }
  return ({ snap: { text: '항상', tone: 'ok' }, cache: { text: '캐시', tone: 'run' } })[item?.avail] || { text: '', tone: 'none' };
}

/** 열 순서 바꾸기 — dir -1(앞으로) · +1(뒤로). 끝이면 그대로. */
export function moveCol(cols, key, dir) {
  const a = [...(cols || [])]; const i = a.indexOf(key); const j = i + dir;
  if (i < 0 || j < 0 || j >= a.length) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}
/** 체크 토글 — 켜면 끝에 붙는다(고른 순서 = 열 순서). */
export const toggleCol = (cols, key) => ((cols || []).includes(key) ? cols.filter((k) => k !== key) : [...(cols || []), key]);
/** 묶음 모두 켜기 — 이미 고른 것은 자리를 지킨다. */
export const addCols = (cols, keys) => [...(cols || []), ...(keys || []).filter((k) => !(cols || []).includes(k))];
export const dropCols = (cols, keys) => (cols || []).filter((k) => !(keys || []).includes(k));

/**
 * 저장할 값 — what 에서 고른 항목만 싣는다(고르지 않은 것은 불러올 때 지금 화면 값을 그대로 둔다). cols 는 항상.
 * @param {{cols:string[], fmt:string, tagCols:boolean, target:string, folder:string}} st
 */
export function valueToSave(st, what = {}, name = '') {
  const v = { name: String(name || '').slice(0, NAME_MAX), cols: [...(st.cols || [])] };
  if (what.fmt) v.fmt = st.fmt;
  if (what.tagCols) v.tagCols = !!st.tagCols;
  if (what.target) v.folder = st.target === 'folder' ? String(st.folder || '') : '';
  return v;
}
/** 저장값 불러오기 — 있는 항목만 바꾼다. folder '' 는 '화면 전체'. */
export function applyValue(st, v) {
  if (!v) return st;
  const next = { ...st, cols: Array.isArray(v.cols) ? [...v.cols] : st.cols };
  if (v.fmt) next.fmt = v.fmt;
  if (typeof v.tagCols === 'boolean') next.tagCols = v.tagCols;
  if (typeof v.folder === 'string') { next.target = v.folder ? 'folder' : 'screen'; next.folder = v.folder; }
  return next;
}
/** 창을 열 때 — 내 기본값, 없으면 '기본' 조합. */
export function initialState(catalog, prefs) {
  const base = { cols: [...(catalog?.presets?.find((p) => p.id === 'base')?.keys || [])], fmt: 'csv', tagCols: false, target: 'screen', folder: '' };
  return prefs?.def ? applyValue(base, prefs.def) : base;
}

/** 칸 버튼 글자. */
export function slotLabel(slot, i) {
  return slot ? { no: String(i + 1), name: slot.name || `이름${i + 1}`, empty: false, cols: slot.cols?.length || 0 } : { no: String(i + 1), name: `이름${i + 1} — 비어 있음`, empty: true, cols: 0 };
}
/** 기본값 한 줄. */
export function defaultLine(prefs) {
  const d = prefs?.def;
  if (!d) return '기본값: 포탈 기본 조합 — ‘지금 설정을 기본값으로’ 를 누르면 다음부터 그 설정으로 시작합니다';
  const from = Number.isInteger(d.from) ? `${d.from}번 ‘${prefs.slots?.[d.from - 1]?.name || d.name}’` : '지금 설정(이름 없음)';
  return `기본값: ${from} · ${d.cols?.length || 0}개 항목${d.droppedCols ? ` · 없어진 항목 ${d.droppedCols}개 뺌` : ''} — 이 창을 열면 기본값으로 시작합니다 · 내 계정에 저장(다른 PC 에서도 같음)`;
}
/** 저장 결과 문구. */
export function savedText(slot, v, alsoDefault) {
  const parts = [`${v.cols.length}개 항목`];
  if (v.fmt) parts.push('형식'); if (v.tagCols !== undefined) parts.push('태그 열 나누기'); if (v.folder !== undefined) parts.push('대상 폴더');
  return slot === 'default' ? `기본값으로 저장했습니다(${parts.join(' · ')}).` : `${slot}번 ‘${v.name || `이름${slot}`}’ 에 저장했습니다(${parts.join(' · ')})${alsoDefault ? ' · 기본값으로도 씁니다' : ''}.`;
}

/**
 * 백업 현황 화면 기준 대상 — 지금 보이는 VM id(보기·검색 반영 — backupViewText.visibleVmIds). 상한을 넘으면 보내지 않고 이유를 준다.
 * 0대면 빈 목록 그대로(전체를 보내지 않는다 — 서버는 ids 가 있으면 그 교집합만).
 */
export function backupScreenRequest(ids, max) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length > max) return { body: null, count: list.length, error: `지금 화면의 VM 이 ${list.length.toLocaleString()}대라 한 번에 내보낼 수 있는 ${max.toLocaleString()}대를 넘습니다 — 보기를 좁히거나 폴더를 고르세요.` };
  return { body: { ids: [...list], view: 'detail' }, count: list.length };
}

/**
 * 내려받기 본문 — 대상(화면: backupScreenRequest 결과 · 폴더: 그 폴더 VM id)에 고른 항목을 붙인다.
 * @param {{body:object|null, count:number, error?:string}} screenReq
 */
export function exportBody(st, screenReq, folderVms) {
  const sel = { cols: [...st.cols], tagCols: !!st.tagCols };
  if (st.target === 'folder') return { body: { ids: (folderVms || []).map((v) => v.id), view: 'folder', ...sel }, count: (folderVms || []).length };   // 파일 이름에 'folder'
  if (!screenReq?.body) return { body: null, count: screenReq?.count || 0, error: screenReq?.error || '' };
  return { body: { ...screenReq.body, ...sel }, count: screenReq.count };
}
