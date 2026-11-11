/**
 * fleetHwExportText.js — '서버 하드웨어 정보 내보내기' 창의 순수 로직(v2.966 — 승인 시안 docs/design/baremetal-hw-xlsx ②).
 * 값 목록(카탈로그)·법인 대수·기본 묶음은 서버 /insights/fleet/hardware-meta 가 준다 — 여기서 값 이름을 지어내지 않는다.
 */

export const FORMATS = Object.freeze([
  { key: 'xlsx', label: '엑셀 (.xlsx)', sub: '한 파일에 시트 여러 장 — 머리글 고정 · 필터 · 숫자 서식 · 법인 띠 색이 들어갑니다.' },
  { key: 'csv', label: 'CSV (.csv)', sub: '표 한 장 = 파일 하나. 표가 여러 개면(상세를 골랐거나 법인마다 나누면) ZIP 으로 묶습니다. 서식은 없고 UTF-8(BOM)입니다.' },
]);
export const KINDS = Object.freeze([
  { key: 'bm', label: '물리서버만 (베어메탈)' },
  { key: 'vh', label: '가상화 서버만 (ESXi 호스트)' },
  { key: 'both', label: '둘 다' },
]);
export const BANDS = Object.freeze([
  { key: 'band', label: '법인마다 띠로 묶기', sub: '맨 위 ‘포함된 법인’ 줄 + 법인이 바뀔 때마다 띠(이름 · 대수 · 소계). 띠 때문에 서버 요약에는 자동 필터를 걸지 않습니다.' },
  { key: 'sheet', label: '법인마다 시트(파일) 나누기', sub: '법인마다 서버 요약을 따로(CSV 는 파일마다). 상세는 한 장에 법인 열로.' },
  { key: 'col', label: '법인 열만', sub: '띠 없이 표 하나 — 자동 필터 · 정렬 · 피벗용.' },
]);
export const UNASSIGNED = '__none__';

const keysOf = (catalog, part) => (Array.isArray(catalog) ? catalog : []).flatMap((g) => (g[part] || []).map((f) => f.key));
const lockedOf = (catalog) => (Array.isArray(catalog) ? catalog : []).flatMap((g) => (g.sum || []).filter((f) => f.locked).map((f) => f.key));

/** 묶음 버튼 — 기본 · 하드웨어 전체 · 네트워크·펌웨어 · 모두 · 모두 빼기. 서버가 주지 않은 key 는 넣지 않는다. */
export function presetKeys(name, catalog, basicKeys = []) {
  const all = new Set([...keysOf(catalog, 'sum'), ...keysOf(catalog, 'det')]);
  const locked = lockedOf(catalog);
  const basic = (Array.isArray(basicKeys) ? basicKeys : []).filter((k) => all.has(k));
  const groupKeys = (gk, parts = ['sum', 'det']) => (catalog || []).filter((g) => gk.includes(g.key)).flatMap((g) => parts.flatMap((p) => (g[p] || []).map((f) => f.key)));
  let out;
  if (name === 'none') out = locked;
  else if (name === 'all') out = [...all];
  else if (name === 'hw') out = [...basic, ...groupKeys(['cpu', 'mem', 'disk', 'ctrl', 'gpu', 'psu', 'pcie'])];
  else if (name === 'net') out = [...basic, ...groupKeys(['nic', 'fw'])];
  else out = basic;
  return new Set([...locked, ...out].filter((k) => all.has(k)));
}
export const PRESETS = Object.freeze([
  { key: 'basic', label: '기본' }, { key: 'hw', label: '하드웨어 전체' }, { key: 'net', label: '네트워크 · 펌웨어' }, { key: 'all', label: '모두' }, { key: 'none', label: '모두 빼기' },
]);

/** 법인 칩의 대수(대상에 따라). */
export const corpCount = (c, kind) => (kind === 'bm' ? c.bm : kind === 'vh' ? c.vh : c.bm + c.vh) || 0;

/** 고른 것 요약 — 요약 열 수 · 상세 종류 수 · 표 수 · 결과 확장자 · 시트 수. */
export function selectionSummary({ catalog, sel, format, band, spec, corps, kind, corpSel }) {
  const picked = (corps || []).filter((c) => corpSel == null || corpSel.has(c.id));
  const servers = picked.reduce((a, c) => a + corpCount(c, kind), 0);
  const cols = keysOf(catalog, 'sum').filter((k) => sel.has(k)).length;
  const detGroups = (catalog || []).filter((g) => (g.det || []).some((f) => sel.has(f.key))).length;
  const summaries = band === 'sheet' ? Math.max(1, picked.filter((c) => corpCount(c, kind) > 0).length) : 1;
  const tables = summaries + detGroups;
  const xl = format === 'xlsx';
  const specSheets = xl && spec ? servers + 1 : 0;
  return {
    servers, cols, detGroups, tables, picked: picked.length,
    ext: xl ? 'xlsx' : tables > 1 ? 'zip' : 'csv',
    sheets: xl ? tables + 1 + specSheets : 0,
  };
}

/** 내려받기 쿼리. corpSel=null 이면 모든 법인(corps 를 싣지 않는다). 값은 카탈로그 순서로. */
export function hwExportQuery({ format, kind, band, spec, corpSel, sel, catalog }) {
  const p = new URLSearchParams();
  p.set('format', format === 'csv' ? 'csv' : 'xlsx');
  p.set('kind', ['bm', 'vh', 'both'].includes(kind) ? kind : 'bm');
  p.set('band', ['band', 'sheet', 'col'].includes(band) ? band : 'band');
  if (format !== 'csv' && spec) p.set('spec', '1');
  if (corpSel != null) p.set('corps', [...corpSel].join(','));
  const order = [...keysOf(catalog, 'sum'), ...keysOf(catalog, 'det')];
  p.set('fields', order.filter((k) => sel.has(k)).join(','));
  return `?${p.toString()}`;
}

/** 요약 한 줄(창 아래). */
export function summaryLine(s, format) {
  if (!s.picked) return '법인을 고르면 내려받을 수 있습니다.';
  const files = format === 'xlsx' ? `시트 ${s.sheets}장` : `CSV ${s.tables}개${s.ext === 'zip' ? ' → ZIP 한 개' : ''}`;
  return `서버 ${s.servers}대 · 요약 열 ${s.cols}개 · 상세 ${s.detGroups}종 · ${files}`;
}

/** 서버가 준 저장값(prefs.def) → 창 상태. 모르는 값은 버리고 기본값. */
export function stateFromPrefs(def, catalog, basicKeys) {
  const all = new Set([...keysOf(catalog, 'sum'), ...keysOf(catalog, 'det')]);
  const cols = Array.isArray(def?.cols) ? def.cols.filter((k) => all.has(k)) : null;
  return {
    format: def?.fmt === 'csv' ? 'csv' : 'xlsx',
    band: ['band', 'sheet', 'col'].includes(def?.band) ? def.band : 'band',
    spec: def?.spec === true,
    sel: cols && cols.length ? new Set([...lockedOf(catalog), ...cols]) : presetKeys('basic', catalog, basicKeys),
  };
}
