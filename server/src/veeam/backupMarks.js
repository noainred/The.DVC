/**
 * veeam/backupMarks.js — 백업 세부내용의 사람이 정하는 표시(v2.784 — 사용자 요청 "업무 중요도 아이콘 · 백업 필요 아이콘 · 백업 관련 메모").
 *   VM 하나에 { crit: 'high'|'mid'|'low'|'' · need: 백업 필요 · memo } — 수집값(Veeam·스냅샷)과 따로 둔다(스냅샷이 바뀌어도 남는다).
 *   CONFIG_DIR/backup-marks.json · 키 = VM id(vcenterId:moref). 패턴은 ipam/annotations.js(rev · 원자적 쓰기 · 로드 손상 보존).
 *
 * ⚠ 파일을 못 읽었으면(손상) 빈 맵 위에 저장하지 않는다 — 쓰기는 거부(503)하고 읽기는 unreadable 을 알린다
 *   ('못 읽었으면 빈 목록을 내려보내지 않는다' · 원본은 preserveCorrupt 가 옆에 남긴다). 재시작하면 손상 사본만 남고 새 파일로 시작한다.
 *   v2.785(GR R-B2): 읽기 쪽도 수를 0 으로 내지 않는다 — 라우트가 marksUnreadable() 이면 행 marks 를 null(모름)로 둔다. 재시작 뒤에는
 *   '파일 없음' 으로 읽혀 조용히 빈 상태가 되므로 marksCorruptKept()(손상 사본 backup-marks.json.corrupt.* 가 남아 있는가)를 화면이 알린다 —
 *   veeam/snapEvents.js corruptKept 와 같은 규칙(쓰기는 막지 않는다 · 관리자가 사본을 치우면 안내가 사라진다).
 * ⚠ VM 을 다시 등록해 moref 가 바뀌면 표시는 따라가지 않는다(이름·vCenter 는 기록용으로 남긴다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'backup-marks.json');
export const CRIT_VALUES = Object.freeze(['high', 'mid', 'low']);
export const MEMO_MAX = 1000;
export const MAX_IDS_PER_REQUEST = 2000;
export const MAX_ENTRIES = 50_000;

let cache = null;
let rev = 0;
let unreadable = false;
/** 표시 변경 리비전 — 백업 화면 응답 캐시 키(저장 즉시 수가 바뀌게). */
export function marksRev() { return rev; }
export function marksUnreadable() { load(); return unreadable; }
/** v2.785(GR R-B2): 예전에 손상돼 옆에 보존된 표시 파일이 있는가 — snapEvents.js corruptKept 와 같은 판정(사본이 있는 동안 참). */
export function marksCorruptKept() {
  try { return fs.readdirSync(config.configDir).some((f) => f.startsWith('backup-marks.json.corrupt.')); } catch { return false; }
}

function load() {
  if (cache) return cache;
  cache = {};
  const f = FILE();
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an object');
      cache = d;
    }
  } catch (e) { preserveCorrupt(f, e.message); cache = {}; unreadable = true; }
  return cache;
}

/** 전체 맵 { vmId: { crit, need, memo, name, vcenterId, at, by } }. */
export function getMarks() { return load(); }

// 제어문자는 빼되 줄바꿈·탭은 둔다(메모 여러 줄)
// eslint-disable-next-line no-control-regex
const cleanMemo = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MEMO_MAX * 2).trim().slice(0, MEMO_MAX);

/**
 * 여러 VM 의 표시를 한 번에 바꾼다(파일 쓰기 1회). patch 의 **있는 키만** 바꾼다 — 일괄 적용에서 중요도만 바꿔도 메모가 지워지지 않게.
 * @param {Array<{id:string, name?:string, vcenterId?:string}>} vms  대상 VM(호출부가 인벤토리·범위로 확인한 것)
 * @param {{crit?:string, need?:boolean, memo?:string}} patch
 * @returns {{ok:true, changed:number, removed:number} | {ok:false, status:number, reason:string}}
 */
export function setMarks(vms, patch = {}, user) {
  const list = Array.isArray(vms) ? vms : [];
  if (!list.length) return { ok: false, status: 400, reason: 'VM 을 고르세요.' };
  if (list.length > MAX_IDS_PER_REQUEST) return { ok: false, status: 400, reason: `한 번에 ${MAX_IDS_PER_REQUEST}대까지입니다.` };
  const has = (k) => Object.prototype.hasOwnProperty.call(patch || {}, k);
  if (!has('crit') && !has('need') && !has('memo')) return { ok: false, status: 400, reason: '바꿀 값이 없습니다.' };
  if (has('crit') && patch.crit !== '' && patch.crit !== null && !CRIT_VALUES.includes(patch.crit)) return { ok: false, status: 400, reason: '중요도 값이 올바르지 않습니다.' };
  if (has('need') && typeof patch.need !== 'boolean') return { ok: false, status: 400, reason: '백업 필요 값이 올바르지 않습니다.' };
  if (has('memo') && list.length > 1) return { ok: false, status: 400, reason: '메모는 한 대씩 씁니다.' };
  if (has('memo') && patch.memo != null && typeof patch.memo !== 'string') return { ok: false, status: 400, reason: '메모 값이 올바르지 않습니다.' };
  const data = load();
  if (unreadable) return { ok: false, status: 503, reason: '백업 표시 파일을 읽지 못해 저장하지 않습니다(손상 사본은 설정 폴더에 남았습니다).', code: 'marksUnreadable' };
  const now = new Date().toISOString();
  const by = String(user?.username || 'unknown').slice(0, 64);
  let changed = 0; let removed = 0; let added = 0;
  const next = { ...data };
  for (const vm of list) {
    const id = String(vm?.id || '');
    if (!id) continue;
    const cur = next[id] || { crit: '', need: false, memo: '' };
    const m = {
      crit: has('crit') ? (patch.crit || '') : (cur.crit || ''),
      need: has('need') ? patch.need : cur.need === true,
      memo: has('memo') ? cleanMemo(patch.memo) : (cur.memo || ''),
    };
    if (!m.crit && !m.need && !m.memo) { if (next[id]) { delete next[id]; removed++; } continue; }
    if (!next[id]) added++;
    next[id] = { ...m, name: String(vm.name || cur.name || '').slice(0, 256), vcenterId: String(vm.vcenterId || cur.vcenterId || '').slice(0, 128), at: now, by };
    changed++;
  }
  if (Object.keys(data).length + added > MAX_ENTRIES && added > 0) return { ok: false, status: 400, reason: `표시는 모두 ${MAX_ENTRIES}대까지입니다.` };
  if (changed || removed) {
    const f = FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    atomicWriteFileSync(f, JSON.stringify(next));
    cache = next; rev++;
  }
  return { ok: true, changed, removed };
}

/**
 * 범위(전원·제외를 거친 목록) 안의 표시 수.
 *  needGap = 백업 필요로 표시했는데 Veeam 대상이 아닌 VM — Veeam 을 모르면(읽기 실패·첫 수집 전 서버가 있음) 0 이 아니라 null.
 * @param {Array} vms  범위 VM @param {object} marks getMarks() @param {object|null} byVm matchToVcenter byVm
 * @param {{veeamKnown:boolean, absentKnown?:boolean}} o
 */
export function markCounts(vms, marks, byVm, { veeamKnown, absentKnown = true } = {}) {
  const c = { high: 0, mid: 0, low: 0, need: 0, needGap: 0 };
  const gapKnown = !!veeamKnown && absentKnown !== false;
  for (const vm of Array.isArray(vms) ? vms : []) {
    const m = marks?.[vm.id];
    if (!m) continue;
    if (CRIT_VALUES.includes(m.crit)) c[m.crit]++;
    if (m.need === true) { c.need++; if (gapKnown && !byVm?.[vm.id]) c.needGap++; }
  }
  if (!gapKnown) c.needGap = null;
  return c;
}

/** VM 한 대의 표시(화면·CSV) — 없으면 undefined. */
export function markView(m) {
  if (!m) return undefined;
  return { crit: CRIT_VALUES.includes(m.crit) ? m.crit : '', need: m.need === true, memo: String(m.memo || ''), at: m.at || '', by: m.by || '' };
}

/** 테스트 전용 — 메모리 캐시를 버린다(다음 load 가 파일을 다시 읽는다). */
export function _resetMarksForTest() { cache = null; unreadable = false; }
