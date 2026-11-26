/**
 * bmcheck/advisory.js — 물리서버 **펌웨어 보안 권고 대조**(v3.50 · 설계 docs/design/bm-feature-proposals ④). 순수.
 *
 *  · 권고 표는 **사람이 확인해 올린 것**이다(bm-advisories.json — 전체 범위 관리자가 CSV 로). 포탈은 인터넷에서 가져오지 않고, 권고 번호 · 고친 버전을
 *    코드에 박아 두지 않는다(지어내지 않는다 — 시안도 비워 두었다). 표가 비어 있으면 **대조하지 않았다**고 말한다(‘해당 없음’ 이 아니다).
 *  · 대조 = 이미 읽는 펌웨어 목록(v3.45 `judgeFirmware` 의 줄 — 종류 · 이름 · 설치 버전) × 권고 줄(종류 · 모델 일부 · 구성요소 이름 일부 · 고친 버전).
 *    설치 버전 < 고친 버전이면 ‘걸림’. 숫자 . 꼴이 아닌 버전은 순서를 지어내지 않는다 — ‘모름’ 으로 따로 센다(util/cmpVersion → null).
 *  · 모델 칸은 **제조사 · 제품군 낱말을 뺀 모델 낱말이 서버 모델과 같을 때만**(R740xd 줄이 R740xd2 · DL380 Gen10 줄이 DL380 Gen10 Plus · SR650 줄이 SR650 V2 에 걸리지 않게 —
 *    디버깅 1 · 2회차 판정 #6 · #8). 구성요소 칸은 소문자 일부 일치. 둘 다 비우면 전부. 글자는 이미 길이가 잘려 있다(store.js · 선형 includes).
 */
import { cmpVersion, parseVersion, cmpParsed } from '../util/cmpVersion.js';
import { FW_TYPES } from './fw.js';
import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';
import { ADVISORY_SEVS, ADVISORY_ROWS_MAX } from './store.js';
/** 모델 낱말(글자 · 숫자 덩어리) — 제조사 · 제품군 낱말은 뺀다(‘PowerEdge R740xd’ = ‘R740xd’). */
const MODEL_NOISE = new Set(['dell', 'emc', 'poweredge', 'hpe', 'hp', 'proliant', 'lenovo', 'thinksystem', 'supermicro', 'server', 'system', 'inc', 'technologies', 'enterprise']);
const toks = (x) => [...new Set(String(x || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !MODEL_NOISE.has(w)))];
/** 권고 줄의 모델 낱말 집합이 서버 모델 낱말 집합과 **같은가**(부분 집합이 아니다 — Gen10 줄이 Gen10 Plus 에 걸리지 않게). */
const sameModel = (have, need) => need.length > 0 && need.length === have.size && need.every((w) => have.has(w));
export function modelTokensMatch(serverModel, rowModel) { return sameModel(new Set(toks(serverModel)), toks(rowModel)); }


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
// 표 조회는 자기 열쇠만 — ‘constructor’ · ‘__proto__’ 같은 칸이 객체 원형 값으로 참이 되지 않게(v3.50 반증 A8)
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
//   성능(v3.52 디버깅 1회차 성능 P1): 목록 한 번에 서버 1,000대 × 권고 2,000줄 × 펌웨어 40줄을 훑으며 같은 버전을 매번 다시 파싱해 5~6초 멈췄다.
//   → 권고 표(배열 — 저장소 캐시가 같은 동안 같은 객체)마다 한 번 색인(모델 낱말 · 고친 버전 파싱)하고, 같은 (모델, 펌웨어 줄) 서명의 결과를 기억한다
//     (표가 바뀌면 새 배열이라 기억도 새로 — WeakMap). 결과 객체는 여러 서버가 함께 쓰므로 얼린다(받는 쪽은 읽기만).
const SEV_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const COLL = new Intl.Collator();
export const ADVISORY_MEMO_MAX = 4096;
const _tableIx = new WeakMap();
function tableIndex(list) {
  let ix = _tableIx.get(list);
  if (ix) return ix;
  ix = { rows: list.map((a) => ({ a, need: a.model ? toks(a.model) : null, fixed: parseVersion(a.fixed) })), memo: new Map() };
  _tableIx.set(list, ix);
  return ix;
}
const deepFreeze = (o) => { for (const h of o.hits) Object.freeze(h); Object.freeze(o.hits); return Object.freeze(o); };
export function advisoriesFor(server, table) {
  const list = Array.isArray(table) ? table : [];
  if (!list.length) return { state: 'no-table', hits: [], total: 0, unknown: 0, checked: 0 };
  const fw = Array.isArray(server?.rows) ? server.rows : null;
  if (!fw || !fw.length) return { state: 'no-fw', hits: [], total: 0, unknown: 0, checked: 0 };
  const model = String(server?.model || '').toLowerCase();
  const ix = tableIndex(list);
  const sig = `${model}\u0001${fw.map((r) => (r ? `${r.type}\u0002${r.label}\u0002${r.installed}\u0002${r.mixed ? 1 : 0}` : '')).join('\u0003')}`;
  const memo = ix.memo.get(sig);
  if (memo) return memo;
  // 펌웨어 줄을 종류별로 한 번 묶고(소문자 이름 · 설치 버전 파싱도 한 번) — 표 순서 × 그 종류 줄 순서로 도는 것은 예전과 같다
  const byType = new Map();
  for (const r of fw) {
    if (!r) continue;
    let arr = byType.get(r.type);
    if (!arr) { arr = []; byType.set(r.type, arr); }
    arr.push({ r, lc: String(r.label || '').toLowerCase(), ver: r.mixed ? null : parseVersion(r.installed) });
  }
  const have = new Set(toks(model));
  const hits = []; let unknown = 0; let checked = 0;
  for (const { a, need, fixed } of ix.rows) {
    // 모델은 낱말 집합이 같을 때만 — modelTokensMatch 와 같은 규칙(디버깅 1 · 2회차 판정 #6 · #8)
    if (a.model && !sameModel(have, need)) continue;
    const cand = byType.get(a.type);
    if (!cand) continue;
    for (const { r, lc, ver } of cand) {
      if (a.comp && !lc.includes(a.comp)) continue;
      checked += 1;
      if (r.mixed) { unknown += 1; continue; }   // 같은 구성요소가 서버 안에서 버전이 섞였다 — 어느 것이 걸리는지 모른다(‘걸린 것 없음’ 이 아니다)
      const c = cmpParsed(ver, fixed);
      if (c == null) { unknown += 1; continue; }
      if (c < 0) hits.push({ id: a.id, sev: a.sev, type: r.type, label: r.label, installed: r.installed, fixed: a.fixed, title: a.title, url: a.url });
    }
  }
  hits.sort((x, y) => (SEV_ORDER[x.sev] ?? 9) - (SEV_ORDER[y.sev] ?? 9) || COLL.compare(String(x.id), String(y.id)));
  // clear 는 실제로 견준 줄이 있을 때만 — 맞는 권고 줄이 없으면 unmatched(이 모델 · 구성요소에 해당하는 권고 없음), 모두 ‘모름’ 이면 unknown(반증 B2)
  const state = hits.length ? 'hit' : checked === 0 ? 'unmatched' : checked - unknown <= 0 ? 'unknown' : 'clear';
  const out = deepFreeze({ state, hits: hits.slice(0, 50), total: hits.length, unknown, checked });
  if (ix.memo.size >= ADVISORY_MEMO_MAX) ix.memo.clear();
  ix.memo.set(sig, out);
  return out;
}
