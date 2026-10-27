/**
 * views/tools/vmExportText.js — 특수 기능 'VM 전체 정보 내보내기' 화면 도우미(순수, v2.799 — vitest 가 고정).
 *
 * 사용자 요청: "VM 전체 정보 CSV 버그 수정 · 추가할 수 있는 정보 · 클로드 디자인으로 멋지게 · vm list export(v2.798) 참고".
 * 시안 https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC 승인. 항목·묶음·빠른 조합은 서버 카탈로그(GET /tools/vm-export/catalog —
 * server/src/vcenter/vmExportCatalog.js)가 준다 — 여기서 복제하지 않는다. 여기는 배지·상태 타일·저장값·요청 본문만.
 */
export const SLOT_COUNT = 5;   // 서버 util/exportPrefs.SLOT_COUNT 와 같은 값
export const NAME_MAX = 30;    // 서버 util/exportPrefs.NAME_MAX 와 같은 값
export const MISSING = '수집 안 됨';          // 서버 vmExportCatalog.MISSING
export const LIVE_LATER = '내려받을 때 조회';  // 서버 vmExportCatalog.LIVE_LATER
export const SAVE_WHAT = Object.freeze([
  ['cols', '고른 항목과 순서', true],
  ['fmt', '형식(CSV/엑셀)', false],
  ['view', '표기 방식', false],
  ['live', '실시간 보강', false],
  ['target', '대상(켜진 VM · 폴더)', false],
]);

/** 배지 색 이름 → 글자색·테두리(시안 Main). */
export const TONE = Object.freeze({
  ok: { color: '#86efac', border: '#14532d' },
  cache: { color: '#93c5fd', border: '#1e3a8a' },
  both: { color: '#a5b4fc', border: '#312e81' },
  live: { color: '#c4b5fd', border: '#4c1d95' },
  opt: { color: '#fcd34d', border: '#713f12' },
  no: { color: '#fca5a5', border: '#7f1d1d' },
  none: { color: 'var(--text-dim)', border: 'var(--border-soft)' },
});

const liveOk = (status) => status?.live?.state === 'ok';
const TAG_BAD = Object.freeze({ unsupported: '이 vCenter 미지원', error: '수집 실패', 'not-collected': '수집 전' });

/**
 * 항목 출처 배지 — 카탈로그 src + 그 vCenter 의 실제 상태(status) + 실시간 보강 켬/끔.
 * @returns {{text:string, tone:string}}
 */
export function badgeOf(item, status = {}, liveOn = true) {
  const src = item?.src;
  if (src === 'snap') return { text: '항상', tone: 'ok' };
  if (src === 'cache') return { text: '캐시', tone: 'cache' };
  if (src === 'both') return liveOn && liveOk(status) ? { text: '캐시 · 실시간', tone: 'both' } : { text: liveOn ? '캐시로 대체' : '캐시', tone: 'cache' };
  if (src === 'live') {
    if (!liveOn) return { text: '실시간 끔', tone: 'opt' };
    return liveOk(status) ? { text: '실시간', tone: 'live' } : { text: '이 vCenter 불가', tone: 'no' };
  }
  if (src === 'parts') {
    if (liveOn && liveOk(status)) return { text: '실시간', tone: 'live' };
    return status?.parts?.on === false ? { text: '수집 꺼짐', tone: 'opt' } : { text: '수집 켜야 함', tone: 'opt' };
  }
  if (src === 'tags') {
    const st = status?.tags?.state;
    return TAG_BAD[st] ? { text: TAG_BAD[st], tone: 'opt' } : { text: '캐시', tone: 'cache' };
  }
  return { text: '', tone: 'none' };
}

/** 'N초 전' · 'N분 전' · 'N시간 전' · 'N일 전'. 모르면 ''. */
export function agoText(at, now = Date.now()) {
  const t = typeof at === 'number' ? at : Date.parse(at || '');
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86_400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86_400)}일 전`;
}

/**
 * 출처 상태 타일 5장(시안 Main 머리) — 모르는 수는 '—'(0 이 아니다).
 * @returns {Array<{key:string, name:string, value:string, meta:string, tone:string, dot:string}>}
 */
export function sourceTiles(status = {}, { liveOn = true, now = Date.now() } = {}) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—');
  const total = status.vmTotal;
  const inv = { key: 'inv', name: '인벤토리', value: `${n(total)}대`, meta: [`켜짐 ${n(status.vmOn)} · 템플릿 ${n(status.templates)}`, agoText(status.invAt, now) && `마지막 ${agoText(status.invAt, now)}`].filter(Boolean).join(' · '), tone: 'ok', dot: '#22c55e' };
  const missCfg = typeof total === 'number' && typeof status.cfgVms === 'number' ? total - status.cfgVms : null;
  const cfg = { key: 'cfg', name: '구성 · 장치 캐시', value: `${n(status.cfgVms)} / ${n(total)}`,
    meta: `주기 수집 · 장치 ${n(status.devVms)}대${missCfg > 0 ? ` · 아직 못 읽은 VM ${missCfg.toLocaleString()}대` : ''}`, tone: 'cache', dot: '#3b82f6' };
  const ls = status.live?.state;
  const live = !liveOn
    ? { key: 'live', name: '실시간 조회', value: '끔', meta: '캐시 값만 씁니다 — 빠릅니다', tone: 'opt', dot: '#5d6b85' }
    : ls === 'ok'
      ? { key: 'live', name: '실시간 조회', value: '가능', meta: '직접 접속 vCenter · 내려받을 때 한 번 로그인', tone: 'live', dot: '#a855f7' }
      : { key: 'live', name: '실시간 조회', value: ls === 'demo' ? '데모' : '쓸 수 없음', meta: status.live?.reason || '이 vCenter 에는 실시간 보강을 하지 않습니다', tone: 'no', dot: '#ef4444' };
  const p = status.parts || {};
  const parts = { key: 'parts', name: '게스트 파티션', value: typeof p.vms === 'number' ? `${p.vms.toLocaleString()}대` : '—',
    meta: [p.on === true ? '수집 켜짐 · Tools 가 도는 VM 만' : p.on === false ? '수집 꺼짐(설정에서 켭니다)' : '수집 설정을 읽지 못함', agoText(p.at, now)].filter(Boolean).join(' · '),
    tone: 'opt', dot: '#f59e0b' };
  const tg = status.tags || {};
  const tagOk = tg.state === 'ok' || tg.state === 'stale';
  const tags = { key: 'tags', name: 'vSphere 태그', value: tagOk ? `카테고리 ${n(tg.categories)}` : (TAG_BAD[tg.state] || '—'),
    meta: tagOk ? `${tg.state === 'stale' ? '마지막 수집 실패 — 직전 값 · ' : ''}${agoText(tg.at, now) ? `마지막 수집 ${agoText(tg.at, now)}` : '수집 시각 모름'}` : '태그 칸은 ‘수집 안 됨’ 으로 씁니다',
    tone: tagOk ? 'cache' : 'opt', dot: tagOk ? '#3b82f6' : '#5d6b85' };
  return [inv, cfg, live, parts, tags];
}

/** 열 순서 바꾸기 — dir -1(앞으로) · +1(뒤로). 끝이면 그대로. */
export function moveCol(cols, key, dir) {
  const a = [...(cols || [])]; const i = a.indexOf(key); const j = i + dir;
  if (i < 0 || j < 0 || j >= a.length) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}
/** 끌어 놓기 — from 을 to 자리로(to 앞에 끼운다). */
export function dropCol(cols, from, to) {
  const a = (cols || []).filter((k) => k !== from);
  const i = a.indexOf(to);
  if (!(cols || []).includes(from) || from === to || i < 0) return [...(cols || [])];
  a.splice(i, 0, from);
  return a;
}
/** 체크 토글 — 켜면 끝에 붙는다(고른 순서 = 열 순서). */
export const toggleCol = (cols, key) => ((cols || []).includes(key) ? cols.filter((k) => k !== key) : [...(cols || []), key]);
/** 묶음 모두 켜기 — 이미 고른 것은 자리를 지킨다. */
export const addCols = (cols, keys) => [...(cols || []), ...(keys || []).filter((k) => !(cols || []).includes(k))];
export const dropCols = (cols, keys) => (cols || []).filter((k) => !(keys || []).includes(k));

/** 화면 상태 기본값 — 내 기본값, 없으면 서버가 정한 기본 조합. */
export function initialState(catalog, prefs) {
  const preset = catalog?.presets?.find((p) => p.id === catalog?.defaultPreset) || catalog?.presets?.[0];
  const base = { cols: [...(preset?.keys || [])], fmt: 'csv', disk: 'slots', tagCols: false, live: true, target: 'all', folder: '', tmpl: true };
  return prefs?.def ? applyValue(base, prefs.def) : base;
}

/**
 * 저장할 값 — what 에서 고른 것만 싣는다(고르지 않은 것은 불러올 때 지금 화면 값을 그대로 둔다). cols 는 항상.
 * @param {{cols:string[], fmt:string, disk:string, tagCols:boolean, live:boolean, target:string, folder:string, tmpl:boolean}} st
 */
export function valueToSave(st, what = {}, name = '') {
  const v = { name: String(name || '').slice(0, NAME_MAX), cols: [...(st.cols || [])] };
  if (what.fmt) v.fmt = st.fmt;
  if (what.view) { v.disk = st.disk; v.tagCols = !!st.tagCols; }
  if (what.live) v.live = !!st.live;
  if (what.target) { v.target = st.target; v.folder = st.target === 'folder' ? String(st.folder || '') : ''; v.tmpl = st.tmpl !== false; }
  return v;
}
/** 저장값 불러오기 — 있는 것만 바꾼다. */
export function applyValue(st, v) {
  if (!v) return st;
  const next = { ...st, cols: Array.isArray(v.cols) ? [...v.cols] : st.cols };
  if (v.fmt === 'csv' || v.fmt === 'xlsx') next.fmt = v.fmt;
  if (v.disk === 'slots' || v.disk === 'join') next.disk = v.disk;
  if (typeof v.tagCols === 'boolean') next.tagCols = v.tagCols;
  if (typeof v.live === 'boolean') next.live = v.live;
  if (['all', 'on', 'folder'].includes(v.target)) { next.target = v.target; next.folder = v.target === 'folder' ? String(v.folder || '') : ''; }
  if (typeof v.tmpl === 'boolean') next.tmpl = v.tmpl;
  return next;
}

/** 칸 버튼 글자. */
export function slotLabel(slot, i) {
  return slot ? { no: String(i + 1), name: slot.name || `이름${i + 1}`, empty: false, cols: slot.cols?.length || 0 } : { no: String(i + 1), name: `이름${i + 1} — 비어 있음`, empty: true, cols: 0 };
}
/** 기본값 한 줄. */
export function defaultLine(prefs) {
  const d = prefs?.def;
  if (!d) return '기본값: 포탈 기본 조합(자산 대장) — ‘지금 설정을 기본값으로’ 를 누르면 다음부터 그 설정으로 시작합니다';
  const from = Number.isInteger(d.from) ? `${d.from}번 ‘${prefs.slots?.[d.from - 1]?.name || d.name}’` : '지금 설정(이름 없음)';
  return `기본값: ${from} · ${d.cols?.length || 0}개 항목${d.droppedCols ? ` · 없어진 항목 ${d.droppedCols}개 뺌` : ''} — 이 화면을 열면 기본값으로 시작합니다 · 내 계정에 저장(다른 PC 에서도 같음)`;
}
/** 저장 결과 문구. */
export function savedText(slot, v, alsoDefault) {
  const parts = [`${v.cols.length}개 항목`];
  if (v.fmt) parts.push('형식');
  if (v.disk) parts.push('표기 방식');
  if (typeof v.live === 'boolean') parts.push('실시간 보강');
  if (v.target) parts.push('대상');
  return slot === 'default' ? `기본값으로 저장했습니다(${parts.join(' · ')}).` : `${slot}번 ‘${v.name || `이름${slot}`}’ 에 저장했습니다(${parts.join(' · ')})${alsoDefault ? ' · 기본값으로도 씁니다' : ''}.`;
}

/** 내려받기·미리보기 본문. */
export function exportBody(st, prefName = '') {
  return {
    cols: [...(st.cols || [])], live: st.live !== false, disk: st.disk === 'join' ? 'join' : 'slots', tagCols: !!st.tagCols,
    target: st.target || 'all', ...(st.target === 'folder' ? { folder: String(st.folder || '') } : {}), tmpl: st.tmpl !== false,
    ...(prefName ? { prefName: String(prefName).slice(0, NAME_MAX) } : {}),
  };
}

/** 대상 수(화면 라디오 옆) — 서버 상태 값(모르면 '—'). */
export function targetCount(status, target, folder) {
  if (target === 'on') return status?.vmOn;
  if (target === 'folder') return (status?.folders || []).find((f) => f.path === folder)?.count;
  return status?.vmTotal;
}

/** 실시간 전용 항목 중 이 vCenter 에서 쓸 수 없는 수(아래 막대 경고). */
export function liveMissCount(cols, itemOf, status, liveOn) {
  if (liveOn && liveOk(status)) return 0;
  return (cols || []).filter((k) => itemOf.get(k)?.src === 'live').length;
}

/** 아래 막대 왼쪽 글자. colsCount 는 미리보기 머리 수(모르면 null). */
export function footerText({ items, colsCount, rows }) {
  const c = typeof colsCount === 'number' ? `${colsCount.toLocaleString()}열` : '열 수 계산 중';
  const r = typeof rows === 'number' ? `${rows.toLocaleString()}대` : '—대';
  return `${items}개 항목 · ${c} · ${r}`;
}

/** 미리보기 칸 모양 — 수집 안 됨(주황) · 내려받을 때 조회(보라 기울임) · 그 밖. */
export function cellKind(v) {
  if (v === MISSING) return 'missing';
  if (v === LIVE_LATER) return 'later';
  return '';
}
