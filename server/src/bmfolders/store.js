/**
 * bmfolders/store.js — 물리서버 폴더 저장소(v2.984, 설계 docs/design/bm-folders/README.md · 사용자 '기본값대로 구현').
 *
 * 파일 둘(비밀 없음) — 서비스 인벤토리(`servicemap/store.js`)와 같은 꼴:
 *   CONFIG_DIR/bm-folders.json         — 폴더 구조 · 자동 규칙 · 설정. 사람이 가끔 바꾼다(설정 변경 감시 대상).
 *     { rev, corps: { [vcenterId]: { folders: [path] } }, rules: [{ id, corp ('*' | vcenterId), value, path, by, at }], settings: { autoRules } }
 *   CONFIG_DIR/bm-folders-assign.json  — 서버 ↔ 폴더 등록(한 서버 한 폴더). 자주 바뀐다 — 변경 감시 백업에서 뺀다(service-map-pins.json 과 같은 이유).
 *     { rev, assign: { [memberKey]: { corp, path, name, addr?, by, at } } }
 *     memberKey = `st:<서비스태그 소문자>` | `fl:<fleetId sha1 16자>`(서비스 인벤토리 `bmKeyOf` 와 같은 키 — 같은 박스면 같은 키).
 *     name = 등록 순간의 이름(목록에서 사라진 서버를 '보류 · 없어짐' 으로 보일 때만 쓴다).
 *
 * 저장 모델(servicemap 과 같다): **메모리가 진실** · 디바운스 200ms 원자 쓰기 · rev 단조 증가 · 쓰기 응답 직전 flushStore().
 * ⚠ 손상(파싱 실패)이면 **빈 트리로 시작하지 않는다** — 파일을 덮어쓰지 않고 loadError 를 세운다 → 라우트가 503 으로 말하고 쓰기를 막는다.
 *   복구는 백업 복원 또는 전체 범위 관리자의 '초기화'(손상본을 .corrupt.<ts> 로 옮기고 빈 저장소로 — 감사 로그).
 * 폴더 경로 규약은 서비스 인벤토리 폴더와 같은 `cleanFolderPath`(구분자 '\\' · 세그먼트 60자 · 최대 10단계)를 쓴다(검증 코어 하나).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { cleanFolderPath, cleanText } from '../servicemap/store.js';

const MAIN_FILE = () => path.join(config.configDir, 'bm-folders.json');
const ASSIGN_FILE = () => path.join(config.configDir, 'bm-folders-assign.json');

export const LIMITS = Object.freeze({
  foldersPerCorp: 500, rules: 200, assign: 50_000, batch: 2_000,
  ruleValue: 64, name: 128, by: 64, includeTokens: 10, searchRows: 2_000,
});

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const t = (v) => (typeof v === 'string' ? v.trim() : '');
export const newRuleId = () => `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
/** 구성원 키 — 서비스 인벤토리와 같은 두 꼴만 받는다(그 밖의 문자열은 저장하지 않는다). */
// 서비스 태그에는 공백이 들어갈 수 있다('To Be Filled By O.E.M.' 같은 자리표시 — 반증 3: 예전 [^\s] 규칙이 그 키를 조용히 버렸다). 제어 문자만 막는다.
// eslint-disable-next-line no-control-regex
export const isMemberKey = (k) => typeof k === 'string' && k.length <= 160 && (/^st:[^\u0000-\u001f\u007f]{1,140}$/.test(k) || /^fl:[0-9a-f]{16}$/.test(k));

/** 폴더 경로의 조상(자기 자신 제외) — 'A\\B\\C' → ['A', 'A\\B']. */
export function ancestorsOf(p) {
  const segs = String(p || '').split('\\');
  const out = [];
  for (let i = 1; i < segs.length; i += 1) out.push(segs.slice(0, i).join('\\'));
  return out;
}
/** p 가 base 자신이거나 그 아래인가('\\' 경계 — 'DB' 는 'DB2' 의 조상이 아니다). */
export const underPath = (p, base) => p === base || String(p).startsWith(`${base}\\`);

export function emptyMain() { return { rev: 0, corps: {}, rules: [], settings: { autoRules: false } }; }
export function emptyAssign() { return { rev: 0, assign: {} }; }

/** 법인 하나의 폴더 집합(정리 · 조상 채움 · 중복 제거) — 상한 없이. 잘못된 경로는 버린다. */
function folderSet(list) {
  const set = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;   // 경로는 글자만(숫자 · 객체를 글자로 바꿔 받지 않는다)
    const r = cleanFolderPath(raw);
    if (r.error || !r.value) continue;
    set.add(r.value);
    for (const a of ancestorsOf(r.value)) set.add(a);
  }
  return set;
}
/** 법인 하나의 폴더 목록 — folderSet 을 정렬하고 상한으로 자른다(로드 경로 — 쓰기 경로는 mutateMain 이 넘침을 400 으로 막는다). */
function normFolders(list) {
  return [...folderSet(list)].sort((a, b) => a.localeCompare(b, 'ko')).slice(0, LIMITS.foldersPerCorp);
}
function normRule(r) {
  if (!isObj(r)) return null;
  const corp = t(r.corp);
  if (!corp || corp.length > 128) return null;
  const v = cleanText(r.value, LIMITS.ruleValue, { label: '규칙 값' });
  const p = cleanFolderPath(r.path);
  if (v.error || p.error || !p.value) return null;
  return { id: t(r.id) && t(r.id).length <= 40 ? t(r.id) : newRuleId(), corp, value: v.value, path: p.value, by: t(r.by).slice(0, LIMITS.by), at: Number.isFinite(r.at) ? r.at : 0 };
}
export function normalizeMain(raw) {
  const o = emptyMain();
  if (!isObj(raw)) return o;
  o.rev = Number.isFinite(raw.rev) ? raw.rev : 0;
  if (isObj(raw.corps)) {
    for (const [vc, c] of Object.entries(raw.corps)) {
      const id = t(vc);
      if (!id || id.length > 128 || !isObj(c)) continue;
      const folders = normFolders(c.folders);
      if (folders.length) o.corps[id] = { folders };
    }
  }
  const seen = new Set();
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    const n = normRule(r);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id); o.rules.push(n);
    if (o.rules.length >= LIMITS.rules) break;
  }
  o.settings = { autoRules: isObj(raw.settings) && raw.settings.autoRules === true };
  return o;
}
export function normalizeAssignEntry(k, v) {
  if (!isMemberKey(k) || !isObj(v)) return null;
  const corp = t(v.corp);
  const p = cleanFolderPath(v.path);
  if (!corp || corp.length > 128 || p.error || !p.value) return null;
  // addr = 등록 순간 이름이 관리 주소였다(목록에서 사라진 뒤에도 비관리자 판본에서 그 이름을 가린다)
  return { corp, path: p.value, name: t(v.name).slice(0, LIMITS.name), ...(v.addr === true ? { addr: true } : {}), by: t(v.by).slice(0, LIMITS.by), at: Number.isFinite(v.at) ? v.at : 0 };
}
export function normalizeAssign(raw) {
  const o = emptyAssign();
  if (!isObj(raw)) return o;
  o.rev = Number.isFinite(raw.rev) ? raw.rev : 0;
  if (isObj(raw.assign)) {
    let n = 0;
    for (const [k, v] of Object.entries(raw.assign)) {
      const e = normalizeAssignEntry(k, v);
      if (!e) continue;
      o.assign[k] = e;
      if ((n += 1) >= LIMITS.assign) break;
    }
  }
  return o;
}

// ───────── 메모리 상태 ─────────
const S = { main: null, assign: null, mainErr: null, assignErr: null, timer: null, dirtyMain: false, dirtyAssign: false, mainMtime: null, assignMtime: null };

function readJson(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return { missing: true };
    return { error: `읽기 실패(${String(e?.code || e?.message || e).slice(0, 60)})` };
  }
  try { return { value: JSON.parse(txt) }; } catch (e) { return { error: `형식 오류(${safeLoadText(e, 120)})` }; }
}
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

function ensureLoaded() {
  // 손상 상태에서는 파일이 바뀌었으면(사람이 고쳤거나 복원) 다시 읽어 본다 — 그 밖에는 메모리가 진실이다.
  if (!S.main || (S.mainErr && mtimeOf(MAIN_FILE()) !== S.mainMtime)) {
    const r = readJson(MAIN_FILE());
    S.mainMtime = mtimeOf(MAIN_FILE());
    if (r.error) { S.mainErr = r.error; S.main = deepFreeze(emptyMain()); console.error(`[bmfolders] bm-folders.json 을 읽지 못했습니다 — ${r.error}. 빈 트리로 시작하지 않고 쓰기를 막습니다(복원하거나 관리자가 초기화).`); }
    else { S.mainErr = null; S.main = deepFreeze(normalizeMain(r.missing ? null : r.value)); }
  }
  if (!S.assign || (S.assignErr && mtimeOf(ASSIGN_FILE()) !== S.assignMtime)) {
    const r = readJson(ASSIGN_FILE());
    S.assignMtime = mtimeOf(ASSIGN_FILE());
    if (r.error) { S.assignErr = r.error; S.assign = deepFreeze(emptyAssign()); console.error(`[bmfolders] bm-folders-assign.json 을 읽지 못했습니다 — ${r.error}. 등록 쓰기를 막습니다.`); }
    else { S.assignErr = null; S.assign = deepFreeze(normalizeAssign(r.missing ? null : r.value)); }
  }
}

/** 손상 상태 — 라우트가 503(`registryUnreadable` 규약)으로 말한다. 없으면 null. */
export function storeLoadError() {
  ensureLoaded();
  if (!S.mainErr && !S.assignErr) return null;
  return { main: S.mainErr, assign: S.assignErr };
}

function flush() {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  let ok = true;
  if (S.dirtyMain && !S.mainErr) {
    try { atomicWriteFileSync(MAIN_FILE(), JSON.stringify(S.main)); S.dirtyMain = false; S.mainMtime = mtimeOf(MAIN_FILE()); }
    catch (e) { ok = false; console.error('[bmfolders] bm-folders.json 저장 실패:', e?.message); }
  }
  if (S.dirtyAssign && !S.assignErr) {
    try { atomicWriteFileSync(ASSIGN_FILE(), JSON.stringify(S.assign)); S.dirtyAssign = false; S.assignMtime = mtimeOf(ASSIGN_FILE()); }
    catch (e) { ok = false; console.error('[bmfolders] bm-folders-assign.json 저장 실패:', e?.message); }
  }
  // 디스크 쓰기가 실패하면 메모리 변경은 남아 있다 — 다음 쓰기를 기다리지 않고 다시 시도한다(반증 10: 재시도가 '이미 그 폴더' 로 성공 응답만 하고 디스크에는 끝내 쓰지 않았다)
  if (!ok && !S.timer) { S.timer = setTimeout(flush, 5000); S.timer.unref?.(); }
  return ok;
}
/** 쓰기 응답 직전에 부른다 — 실패를 200 으로 감추지 않는다(svcmon · servicemap 규약). 바뀐 것이 없는 응답도 이것을 거친다(앞선 실패가 남아 있으면 여기서 드러난다). */
export function flushStore() { return flush(); }
function schedule() {
  if (S.timer) return;
  S.timer = setTimeout(flush, 200);
  S.timer.unref?.();
}

export function storeRev() { ensureLoaded(); return `${S.main.rev}.${S.assign.rev}`; }
/** 읽기 전용 참조(동결 — 복사 없음). 판정처럼 읽기만 하는 경로 전용. 고치려면 mutate* 를 쓴다. */
export function peekMain() { ensureLoaded(); return S.main; }
export function peekAssign() { ensureLoaded(); return S.assign.assign; }

/**
 * 폴더 · 규칙 · 설정 변경 한 번 — fn(draft) 이 { error } 를 돌려주면 아무것도 바꾸지 않는다. 성공이면 rev 를 올리고 디바운스 저장.
 * @returns {{ok:true, result?:any} | {ok:false, status:number, error:string}}
 */
export function mutateMain(fn) {
  ensureLoaded();
  if (S.mainErr) return { ok: false, status: 503, error: `bm-folders.json 을 읽지 못해 쓰기를 막았습니다 — ${S.mainErr}` };
  const draft = JSON.parse(JSON.stringify(S.main));
  const r = fn(draft) || {};
  if (r.error) return { ok: false, status: r.status || 400, error: r.error };
  // 넘침은 조용히 자르지 않고 거부한다(로드 경로의 slice 는 손으로 고친 파일 방어선일 뿐이다)
  for (const c of Object.values(draft.corps || {})) {
    if (folderSet(c?.folders).size > LIMITS.foldersPerCorp) return { ok: false, status: 400, error: `폴더는 법인당 최대 ${LIMITS.foldersPerCorp}개입니다` };
  }
  if (Array.isArray(draft.rules) && draft.rules.length > LIMITS.rules) return { ok: false, status: 400, error: `자동 규칙은 최대 ${LIMITS.rules}개입니다` };
  draft.rev = (S.main.rev || 0) + 1;
  S.main = deepFreeze(normalizeMain(draft));
  S.dirtyMain = true; schedule();
  return { ok: true, result: r.result };
}
/**
 * 등록 쓰기 — **바뀐 키만** 정리·동결한다(servicemap mutatePins 와 같은 이유: 5만 건 전체 복사·동결을 쓰기마다 하지 않는다).
 * draft.assign 은 얕은 사본이고 그 안의 항목은 지금 상태의 동결 객체다 — fn 은 항목을 고치지 말고 새 객체로 바꿔 넣거나 지운다.
 */
export function mutateAssign(fn) {
  ensureLoaded();
  if (S.assignErr) return { ok: false, status: 503, error: `bm-folders-assign.json 을 읽지 못해 쓰기를 막았습니다 — ${S.assignErr}` };
  const prev = S.assign.assign;
  const draft = { assign: { ...prev } };
  const r = fn(draft) || {};
  if (r.error) return { ok: false, status: r.status || 400, error: r.error };
  const next = isObj(draft.assign) ? (Object.isFrozen(draft.assign) ? { ...draft.assign } : draft.assign) : {};
  for (const k of Object.keys(next)) {
    const v = next[k];
    if (v === prev[k]) continue;
    const o = normalizeAssignEntry(k, v);
    if (o) next[k] = Object.freeze(o); else delete next[k];
  }
  if (Object.keys(next).length > LIMITS.assign) return { ok: false, status: 400, error: `등록은 최대 ${LIMITS.assign}건입니다` };
  S.assign = Object.freeze({ rev: (S.assign.rev || 0) + 1, assign: Object.freeze(next) });
  S.dirtyAssign = true; schedule();
  return { ok: true, result: r.result };
}

/** 손상 상태에서 빈 저장소로 — 손상본은 .corrupt.<ts> 로 보존. 전체 범위 관리자만 부른다(라우트 게이트). */
export function resetCorrupt() {
  ensureLoaded();
  const moved = [];
  if (S.mainErr) { const b = preserveCorrupt(MAIN_FILE(), S.mainErr); if (b) moved.push(path.basename(b)); S.mainErr = null; S.main = deepFreeze(emptyMain()); S.dirtyMain = true; }
  if (S.assignErr) { const b = preserveCorrupt(ASSIGN_FILE(), S.assignErr); if (b) moved.push(path.basename(b)); S.assignErr = null; S.assign = deepFreeze(emptyAssign()); S.dirtyAssign = true; }
  const ok = flush();
  return { ok, moved };
}

export function _resetForTest() {
  if (S.timer) clearTimeout(S.timer);
  Object.assign(S, { main: null, assign: null, mainErr: null, assignErr: null, timer: null, dirtyMain: false, dirtyAssign: false, mainMtime: null, assignMtime: null });
}
