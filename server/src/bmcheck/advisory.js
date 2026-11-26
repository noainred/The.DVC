/**
 * bmcheck/advisory.js — 물리서버 **펌웨어 보안 권고 대조**(v3.49 · 설계 docs/design/bm-feature-proposals ④). 순수.
 *
 *  · 권고 표는 **사람이 확인해 올린 것**이다(bm-advisories.json — 전체 범위 관리자가 CSV 로). 포탈은 인터넷에서 가져오지 않고, 권고 번호 · 고친 버전을
 *    코드에 박아 두지 않는다(지어내지 않는다 — 시안도 비워 두었다). 표가 비어 있으면 **대조하지 않았다**고 말한다(‘해당 없음’ 이 아니다).
 *  · 대조 = 이미 읽는 펌웨어 목록(v3.45 `judgeFirmware` 의 줄 — 종류 · 이름 · 설치 버전) × 권고 줄(종류 · 모델 일부 · 구성요소 이름 일부 · 고친 버전).
 *    설치 버전 < 고친 버전이면 ‘걸림’. 숫자 . 꼴이 아닌 버전은 순서를 지어내지 않는다 — ‘모름’ 으로 따로 센다(util/cmpVersion → null).
 *  · 모델 · 구성요소 칸은 **소문자 일부 일치**(비우면 전부). 글자는 이미 길이가 잘려 있다(store.js · 선형 includes).
 */
import { cmpVersion } from '../util/cmpVersion.js';
import { FW_TYPES } from './fw.js';
import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';
import { ADVISORY_SEVS, ADVISORY_ROWS_MAX } from './store.js';

export const ADVISORY_COLUMNS = Object.freeze(['advisory_id', 'severity', 'component_type', 'model', 'component', 'fixed_version', 'title', 'url']);
const ALIAS = Object.freeze({
  advisory_id: 'advisory_id', '권고 번호': 'advisory_id', 권고번호: 'advisory_id', id: 'advisory_id',
  severity: 'severity', 심각도: 'severity', component_type: 'component_type', 종류: 'component_type', type: 'component_type',
  model: 'model', 모델: 'model', component: 'component', 구성요소: 'component', fixed_version: 'fixed_version', '고친 버전': 'fixed_version', fixed: 'fixed_version',
  title: 'title', 제목: 'title', url: 'url', 링크: 'url',
});
const SEV_ALIAS = Object.freeze({ critical: 'critical', 위험: 'critical', 긴급: 'critical', high: 'high', 높음: 'high', medium: 'medium', moderate: 'medium', 보통: 'medium', low: 'low', 낮음: 'low' });
const TYPE_OF = Object.freeze(Object.fromEntries(FW_TYPES.map((t) => [t.toLowerCase(), t])));
const cell = (v, n) => unguardCell(String(v ?? '')).trim().slice(0, n);
// 표 조회는 자기 열쇠만 — ‘constructor’ · ‘__proto__’ 같은 칸이 객체 원형 값으로 참이 되지 않게(v3.49 반증 A8)
const own = (map, k) => (Object.hasOwn(map, k) ? map[k] : '');

/**
 * 권고 CSV → { rows, errors:[{ line, reason }], present }. 머리글은 별칭(한글)도 받는다 · 빈 줄 건너뜀.
 * line 은 **표의 행 번호**(머리글 = 1)다 — 따옴표 안에 줄바꿈이 있는 칸이 있으면 파일의 줄 번호와 다를 수 있다(화면도 ‘행’ 이라 쓴다 · 반증 A12).
 * 필수: 권고 번호 · 종류(BIOS · iDRAC · NIC · Storage · HBA) · 고친 버전(숫자 . 꼴).
 */
export function parseAdvisoryCsv(text) {
  let table;
  try { table = parseCsvRows(String(text ?? ''), { maxRows: ADVISORY_ROWS_MAX + 2, maxCell: 2000, keepBlank: true }); } catch (e) { return { rows: [], errors: [{ line: 0, reason: `CSV 를 읽지 못했습니다 — ${String(e?.message || e).slice(0, 120)}` }] }; }
  if (!Array.isArray(table) || !table.length) return { rows: [], errors: [{ line: 0, reason: '빈 파일입니다.' }] };
  const head = table[0].map((h) => own(ALIAS, cell(h, 40).replace(/^﻿/, '').toLowerCase()) || own(ALIAS, cell(h, 40).replace(/^﻿/, '')));
  for (const need of ['advisory_id', 'component_type', 'fixed_version']) if (!head.includes(need)) return { rows: [], errors: [{ line: 1, reason: `머리글에 ${need} 열이 없습니다.` }] };
  const at = (r, k) => { const i = head.indexOf(k); return i >= 0 ? r[i] : ''; };
  const rows = []; const errors = []; const seen = new Set();
  for (let i = 1; i < table.length; i += 1) {
    const r = table[i]; const line = i + 1;
    if (!Array.isArray(r) || r.every((x) => !String(x ?? '').trim())) continue;
    if (rows.length >= ADVISORY_ROWS_MAX) { errors.push({ line, reason: `줄이 너무 많습니다(최대 ${ADVISORY_ROWS_MAX}줄).` }); break; }
    const id = cell(at(r, 'advisory_id'), 64);
    const type = own(TYPE_OF, cell(at(r, 'component_type'), 16).toLowerCase());
    const fixed = cell(at(r, 'fixed_version'), 48);
    const sevRaw = cell(at(r, 'severity'), 16).toLowerCase();
    const sev = sevRaw ? own(SEV_ALIAS, sevRaw) : 'medium';
    const url = cell(at(r, 'url'), 300);
    if (!id) { errors.push({ line, reason: '권고 번호가 비었습니다.' }); continue; }
    if (!type) { errors.push({ line, reason: `종류는 ${FW_TYPES.join(' · ')} 중 하나여야 합니다.` }); continue; }
    if (!fixed || cmpVersion(fixed, fixed) == null) { errors.push({ line, reason: '고친 버전이 숫자 . 꼴이 아닙니다(순서를 정할 수 없습니다).' }); continue; }
    if (!sev) { errors.push({ line, reason: `심각도는 ${ADVISORY_SEVS.join(' · ')} 중 하나여야 합니다.` }); continue; }
    if (url && !/^https?:\/\//i.test(url)) { errors.push({ line, reason: '링크는 http · https 주소여야 합니다.' }); continue; }
    const k = `${id.toLowerCase()}\u0000${type}\u0000${cell(at(r, 'model'), 120).toLowerCase()}\u0000${cell(at(r, 'component'), 120).toLowerCase()}`;
    if (seen.has(k)) { errors.push({ line, reason: '같은 권고 · 종류 · 모델 · 구성요소가 두 번 나옵니다.' }); continue; }
    seen.add(k);
    rows.push({ id, sev, type, model: cell(at(r, 'model'), 120).toLowerCase(), comp: cell(at(r, 'component'), 120).toLowerCase(), fixed, title: cell(at(r, 'title'), 200), url });
  }
  return { rows, errors };
}

/** 권고 표 → CSV(내려받기 · 다시 올리기와 같은 열). */
export function advisoriesToCsv(rows = []) {
  return CSV_BOM + [csvLine(ADVISORY_COLUMNS), ...rows.map((r) => csvLine([r.id, r.sev, r.type, r.model, r.comp, r.fixed, r.title, r.url]))].join('\r\n') + '\r\n';
}
/** 빈 양식(머리글 + 설명 줄 없음 — 권고 번호를 지어내지 않는다). */
export const sampleAdvisoryCsv = () => CSV_BOM + csvLine(ADVISORY_COLUMNS) + '\r\n';

/**
 * 서버 한 대 대조.
 * @param {{ model:string, rows:Array<{type:string, label:string, installed:string|null, mixed?:boolean}> }} server  펌웨어 판정 줄(judgeFirmware rows)
 * @param {Array} table 권고 표(store rows)
 * @returns {{ state:'no-table'|'no-fw'|'unmatched'|'unknown'|'clear'|'hit', hits:Array, total:number, unknown:number, checked:number }}
 *   no-table = 표가 비어 대조하지 않음 · no-fw = 펌웨어 목록을 못 읽음 · unmatched = 이 모델 · 구성요소에 맞는 권고 줄이 없음 ·
 *   unknown = 맞는 줄은 있으나 모두 순서를 정할 수 없음 · clear = 견준 줄이 있고 걸린 것 없음(checked − unknown 줄) · hit = 걸린 것 있음
 *   hits 는 앞 50개까지 · total = 자르기 전 걸린 수(반증 A7) · unknown = 순서를 정할 수 없는 줄(숫자 꼴이 아닌 버전 · 한 서버 안에서 섞인 구성요소 — 반증 A6)
 */
export function advisoriesFor(server, table) {
  const list = Array.isArray(table) ? table : [];
  if (!list.length) return { state: 'no-table', hits: [], total: 0, unknown: 0, checked: 0 };
  const fw = Array.isArray(server?.rows) ? server.rows : null;
  if (!fw || !fw.length) return { state: 'no-fw', hits: [], total: 0, unknown: 0, checked: 0 };
  const model = String(server?.model || '').toLowerCase();
  const hits = []; let unknown = 0; let checked = 0;
  for (const a of list) {
    if (a.model && !model.includes(a.model)) continue;
    for (const r of fw) {
      if (!r || r.type !== a.type) continue;
      if (a.comp && !String(r.label || '').toLowerCase().includes(a.comp)) continue;
      checked += 1;
      if (r.mixed) { unknown += 1; continue; }   // 같은 구성요소가 서버 안에서 버전이 섞였다 — 어느 것이 걸리는지 모른다(‘걸린 것 없음’ 이 아니다)
      const c = cmpVersion(r.installed, a.fixed);
      if (c == null) { unknown += 1; continue; }
      if (c < 0) hits.push({ id: a.id, sev: a.sev, type: r.type, label: r.label, installed: r.installed, fixed: a.fixed, title: a.title, url: a.url });
    }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  hits.sort((x, y) => (order[x.sev] ?? 9) - (order[y.sev] ?? 9) || String(x.id).localeCompare(String(y.id)));
  // clear 는 실제로 견준 줄이 있을 때만 — 맞는 권고 줄이 없으면 unmatched(이 모델 · 구성요소에 해당하는 권고 없음), 모두 ‘모름’ 이면 unknown(반증 B2)
  const state = hits.length ? 'hit' : checked === 0 ? 'unmatched' : checked - unknown <= 0 ? 'unknown' : 'clear';
  return { state, hits: hits.slice(0, 50), total: hits.length, unknown, checked };
}
