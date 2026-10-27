/**
 * veeam/vmListPrefs.js — VM 목록 내보내기 '내 저장값'(계정별, v2.798 — 사용자 결정 '계정에 저장').
 *
 * 사용자 요청: "지금 설정을 기본값으로 저장하기, 지금 설정을 저장하기/저장하기 이름1,2,3,4,5 이렇게 5개 설정값을 저장할 수 있고, 저장하는 값을 지정".
 *  · CONFIG_DIR/vm-list-prefs.json = { v:1, users: { 'u:<계정>': { def, slots:[5], at } } } — 키 앞의 'u:' 는 계정 이름이 '__proto__' 같아도 객체 키가 되지 않게.
 *  · 값 = { name, cols(필수 — 고른 열과 순서), fmt?, tagCols?, ynDays?(v2.801 '여부' 기준 일수), folder? }(v2.801: multi(파티션 한 줄 반복)는 파티션 열과 함께 없앴다 — 예전 값의 multi 는 저장할 때 버린다) — 사람이 '저장할 내용' 에서 고르지 않은 항목은 아예 싣지 않는다
 *    (불러올 때 그 항목은 지금 화면 값을 그대로 둔다). def 는 값 그대로 + from(그 값을 가져온 칸 번호 — 화면 표시용).
 *  · 계정은 **인증된 req.user.username** 으로만 고른다(라우트) — 본문의 이름을 믿지 않는다(남의 저장값을 읽거나 덮지 못하게).
 *  · 원자적 쓰기(0600) · 로드 손상은 옆에 보존하고 쓰기를 거부한다(503 — 빈 값 위에 덮어 전 계정 저장값을 잃지 않게) · 상한(계정 2,000 · 이름 30자).
 *  · 비밀은 없다(열 이름·폴더 경로뿐).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { resolveCols, knownKeys } from './vmListCatalog.js';
import { YN_DAYS } from './backupStatus.js';

const FILE = () => path.join(config.configDir, 'vm-list-prefs.json');
export const SLOT_COUNT = 5;
export const MAX_USERS = 2000;
export const NAME_MAX = 30;
const FMTS = ['csv', 'xlsx'];

let cache = null;
let unreadable = false;

function load() {
  if (cache) return cache;
  cache = {};
  const f = FILE();
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!d || typeof d !== 'object' || Array.isArray(d) || !d.users || typeof d.users !== 'object' || Array.isArray(d.users)) throw new Error('형식 오류');
      cache = d.users;
    }
  } catch (e) { preserveCorrupt(f, e.message); cache = {}; unreadable = true; }
  return cache;
}
export function prefsUnreadable() { load(); return unreadable; }
const ukey = (username) => `u:${String(username || '').slice(0, 128)}`;
const cleanName = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, NAME_MAX); // eslint-disable-line no-control-regex

/**
 * 값 하나 검증·정리. cols 는 필수(빈 목록 거절). 그 밖은 있으면 형식만 본다.
 * @returns {{ok:true, value:object} | {ok:false, reason:string}}
 */
export function normalizeValue(v, { slotNo = null } = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: '저장할 값 형식이 잘못됐습니다.' };
  const c = resolveCols(Array.isArray(v.cols) ? v.cols : []);
  if (!c.ok) return c;
  const out = { name: cleanName(v.name) || (slotNo ? `이름${slotNo}` : '기본값'), cols: c.keys };
  if (v.fmt !== undefined) { if (!FMTS.includes(v.fmt)) return { ok: false, reason: '형식은 CSV 또는 엑셀입니다.' }; out.fmt = v.fmt; }
  if (v.tagCols !== undefined) out.tagCols = v.tagCols === true;
  if (v.ynDays !== undefined) { if (!YN_DAYS.includes(v.ynDays)) return { ok: false, reason: '‘여부’ 기준 일수가 잘못됐습니다.' }; out.ynDays = v.ynDays; }   // v2.801
  if (v.folder !== undefined) {
    if (typeof v.folder !== 'string' || v.folder.length > 512 || /[\x00-\x1f\x7f]/.test(v.folder)) return { ok: false, reason: '폴더 경로 형식이 잘못됐습니다.' }; // eslint-disable-line no-control-regex
    out.folder = v.folder;
  }
  return { ok: true, value: out };
}

/** 저장된 값을 내보낼 때 — 사라진 열은 빼고 그 수를 알린다(조용히 바꾸지 않는다). */
function viewValue(v) {
  if (!v || typeof v !== 'object') return null;
  const k = knownKeys(v.cols);
  return { ...v, cols: k.keys, ...(k.dropped ? { droppedCols: k.dropped } : {}) };
}

/** 이 계정의 저장값 — { def, slots[5], at }. 없으면 빈 칸들. */
export function getPrefs(username) {
  const e = load()[ukey(username)] || null;
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => viewValue(e?.slots?.[i]));
  return { def: viewValue(e?.def), slots, at: e?.at || null, unreadable: unreadable || undefined };
}

function write(next) {
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, users: next }, null, 2), { mode: 0o600 });
  cache = next;
}

/**
 * 저장 — slot: 1~5 또는 'default'. alsoDefault(칸에 저장할 때 기본값으로도) · 칸 값의 이름은 비면 '이름N'.
 * @returns {{ok:true, prefs:object} | {ok:false, status:number, reason:string, code?:string}}
 */
export function setPref(username, slot, value, { alsoDefault = false, now = Date.now() } = {}) {
  if (!username) return { ok: false, status: 400, reason: '계정을 알 수 없습니다.' };
  const isDef = slot === 'default';
  const n = Number(slot);
  if (!isDef && !(Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT)) return { ok: false, status: 400, reason: `저장 칸은 1~${SLOT_COUNT} 또는 기본값입니다.` };
  const nv = normalizeValue(value, { slotNo: isDef ? null : n });
  if (!nv.ok) return { ok: false, status: 400, reason: nv.reason };
  load();
  if (unreadable) return { ok: false, status: 503, code: 'prefsUnreadable', reason: '저장값 파일을 읽지 못해 저장하지 않습니다(손상 사본은 설정 폴더에 남았습니다).' };
  const k = ukey(username);
  const next = { ...cache };
  if (!next[k] && Object.keys(next).length >= MAX_USERS) return { ok: false, status: 400, reason: `저장값을 가진 계정이 ${MAX_USERS}개를 넘었습니다.` };
  const cur = next[k] && typeof next[k] === 'object' ? next[k] : {};
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => (Array.isArray(cur.slots) ? cur.slots[i] || null : null));
  let def = cur.def || null;
  if (isDef) def = { ...nv.value };
  else {
    slots[n - 1] = nv.value;
    if (alsoDefault) def = { ...nv.value, from: n };
    else if (def?.from === n) def = { ...nv.value, from: n };   // 그 칸에서 온 기본값은 칸과 같이 바뀐다(칸 번호로 묶였다)
  }
  next[k] = { def, slots, at: new Date(now).toISOString() };
  write(next);
  return { ok: true, prefs: getPrefs(username) };
}

/** 칸 비우기(1~5) 또는 기본값 지우기('default' — 창은 포탈 기본 조합으로 시작). */
export function clearPref(username, slot) {
  if (!username) return { ok: false, status: 400, reason: '계정을 알 수 없습니다.' };
  const isDef = slot === 'default';
  const n = Number(slot);
  if (!isDef && !(Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT)) return { ok: false, status: 400, reason: `저장 칸은 1~${SLOT_COUNT} 또는 기본값입니다.` };
  load();
  if (unreadable) return { ok: false, status: 503, code: 'prefsUnreadable', reason: '저장값 파일을 읽지 못해 바꾸지 않습니다(손상 사본은 설정 폴더에 남았습니다).' };
  const k = ukey(username);
  if (!cache[k]) return { ok: true, prefs: getPrefs(username) };
  const next = { ...cache };
  const cur = { ...next[k], slots: [...(next[k].slots || [])] };
  if (isDef) cur.def = null;
  else { cur.slots[n - 1] = null; if (cur.def?.from === n) cur.def = { ...cur.def, from: undefined }; }
  next[k] = cur;
  write(next);
  return { ok: true, prefs: getPrefs(username) };
}

export function _resetVmListPrefsForTest() { cache = null; unreadable = false; }
