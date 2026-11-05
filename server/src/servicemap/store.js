/**
 * servicemap/store.js — 서비스 인벤토리 저장소(v2.887, docs/design/service-map/README.md 시안 A 3차 + 4차 검토).
 *
 * 파일 둘(비밀 없음):
 *   CONFIG_DIR/service-map.json       — 트리·규칙·전역 카탈로그·설정. 사람이 가끔 바꾼다.
 *     { rev, corps: { [vcenterId]: { folders:[path], services:[{id,name,path,tier,owner,note,globalId}],
 *                                     folderRules:[{prefix,serviceId}], aliases:[{kind:'scan'|'tag',value,serviceId}],
 *                                     nameRules:[{match:'prefix'|'suffix'|'contains',value,serviceId}], tagEnabled } },
 *       globals:[{id,name,tier,owner,note}], settings:{ tagCategory } }
 *   CONFIG_DIR/service-map-pins.json  — 한 대씩 고정(수동 지정). 자주 바뀐다 — 변경 감시 백업에서 빼려고 나눴다(4차 반증 18).
 *     { rev, pins: { [memberKey]: { serviceId, corp, by, at, reviewed, reviewedAuto? } } }
 *     reviewedAuto = '고정 유지' 를 누른 순간의 자동 판정(서비스 id · 없으면 null). 자동 판정이 그와 다르면 드리프트로 다시 묻는다(5차 검토 R8).
 *
 * 저장 모델은 svcmon 식 하나다(4차 반증 12): **메모리가 진실** · 디바운스 200ms 로 한 번에 쓴다 · rev 는 단조 증가.
 *   외부 편집(사람·복원)은 재시작에 반영된다(복원은 stagedRestoreBoot 가 기동 때 적용한다). mtime 재읽기와 섞지 않는다 —
 *   섞으면 '메모리 반영 · 디스크는 200ms 뒤' 창에서 디스크본이 메모리본을 덮는다.
 *
 * ⚠ 손상(파싱 실패)이면 **빈 트리로 시작하지 않는다** — 빈 화면을 본 관리자가 '다 지워졌다' 고 판단해 다시 만들면 원본을
 *   되살릴 기회가 사라진다. 파일은 그대로 두고(덮어쓰지 않는다) `loadError` 를 세운다 → 라우트가 503 으로 말하고 쓰기를 막는다.
 *   복구는 백업 복원 또는 전체 범위 관리자의 '초기화'(손상본을 .corrupt.<ts> 로 옮기고 빈 저장소로 — 감사 로그).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';

const MAP_FILE = () => path.join(config.configDir, 'service-map.json');
const PIN_FILE = () => path.join(config.configDir, 'service-map-pins.json');

export const LIMITS = Object.freeze({
  servicesPerCorp: 500, foldersPerCorp: 500, folderRulesPerCorp: 500, aliasesPerCorp: 500, nameRulesPerCorp: 200,
  globals: 500, pins: 50_000, pinBatch: 500,
  name: 64, owner: 128, note: 256, prefix: 256, alias: 128, nameRule: 64, folderSeg: 60, folderDepth: 10,
});

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/;

/** 글자 하나 정리 — 앞뒤 공백 제거 · 제어 문자 거부 · 길이 상한. 실패면 { error }. */
export function cleanText(v, max, { allowEmpty = false, label = '값' } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string' && typeof v !== 'number') return { error: `${label}이(가) 글자가 아닙니다` };
  const s = String(v).trim();
  if (!s && !allowEmpty) return { error: `${label}이(가) 비어 있습니다` };
  if (s.length > max) return { error: `${label}은(는) ${max}자 이하입니다` };
  if (CTRL.test(s)) return { error: `${label}에 제어 문자가 있습니다` };
  return { value: s };
}

/** 포탈 폴더 경로('업무시스템\\개발') — '' 는 루트. svcmon SAFE_PATH 와 같은 규약(구분자 '\\', 세그먼트 60자, 최대 10단계). */
export function cleanFolderPath(v) {
  const s = String(v ?? '').trim();
  if (!s) return { value: '' };
  if (s.length > LIMITS.folderSeg * LIMITS.folderDepth + LIMITS.folderDepth) return { error: '폴더 경로가 너무 깁니다' };
  const segs = s.split('\\').map((x) => x.trim());
  if (segs.length > LIMITS.folderDepth) return { error: `폴더는 최대 ${LIMITS.folderDepth}단계입니다` };
  for (const g of segs) {
    if (!g) return { error: '빈 폴더 이름이 있습니다(구분자 \\ 가 연속되거나 끝에 있음)' };
    if (g.length > LIMITS.folderSeg) return { error: `폴더 이름은 ${LIMITS.folderSeg}자 이하입니다` };
    if (CTRL.test(g) || /[/:*?"<>|]/.test(g)) return { error: `폴더 이름에 쓸 수 없는 글자가 있습니다: ${g.slice(0, 20)}` };
  }
  return { value: segs.join('\\') };
}

/**
 * vCenter 폴더 규칙 접두 — `vmPlacement.folderPath` 모양('/ERP/prod': 선행 '/' · '/' 구분). 끝 '/' 는 뗀다(루트 '/' 는 그대로).
 *   ⚠ 화면용 `vm.folder`('ERP/prod' — 'vm'·'Datacenters' 이름 폴더를 어느 깊이에서든 뺀 값)와 다르다(4차 반증 1).
 */
export function cleanFolderPrefix(v) {
  const r = cleanText(v, LIMITS.prefix, { label: 'vCenter 폴더 경로' });
  if (r.error) return r;
  let s = r.value;
  if (!s.startsWith('/')) s = `/${s}`;
  let end = s.length;
  while (end > 1 && s.charCodeAt(end - 1) === 47) end -= 1;   // 끝 '/' 제거(선형 — 정규식 /\/+$/ 금지 규약)
  s = s.slice(0, end);
  if (s.includes('//')) return { error: "vCenter 폴더 경로에 빈 폴더('//')가 있습니다" };
  return { value: s };
}

const lc = (s) => String(s ?? '').toLowerCase();
export const newId = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

function emptyCorp() {
  return { folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false };
}
function emptyMap() { return { rev: 0, corps: {}, globals: [], settings: { tagCategory: '' } }; }
function emptyPins() { return { rev: 0, pins: {} }; }

/** 읽은 JSON 을 아는 모양으로만 받는다(모르는 키는 버린다 — 오래된/손으로 고친 파일 방어). 순수. */
export function normalizeMap(raw) {
  const out = emptyMap();
  if (!isObj(raw)) return out;
  out.rev = Number.isFinite(raw.rev) ? Math.max(0, Math.floor(raw.rev)) : 0;
  const tc = cleanText(raw.settings?.tagCategory, 128, { allowEmpty: true });
  out.settings.tagCategory = tc.error ? '' : tc.value;
  for (const g of Array.isArray(raw.globals) ? raw.globals.slice(0, LIMITS.globals) : []) {
    if (!isObj(g) || typeof g.id !== 'string') continue;
    const n = cleanText(g.name, LIMITS.name); if (n.error) continue;
    out.globals.push({ id: g.id.slice(0, 64), name: n.value, tier: tierOf(g.tier), owner: cleanText(g.owner, LIMITS.owner, { allowEmpty: true }).value || '', note: cleanText(g.note, LIMITS.note, { allowEmpty: true }).value || '' });
  }
  for (const [vc, c] of Object.entries(isObj(raw.corps) ? raw.corps : {})) {
    if (!vc || vc.length > 128 || !isObj(c)) continue;
    const corp = emptyCorp();
    corp.tagEnabled = c.tagEnabled === true;
    for (const f of Array.isArray(c.folders) ? c.folders.slice(0, LIMITS.foldersPerCorp) : []) { const p = cleanFolderPath(f); if (!p.error && p.value && !corp.folders.includes(p.value)) corp.folders.push(p.value); }
    const ids = new Set();
    for (const s of Array.isArray(c.services) ? c.services.slice(0, LIMITS.servicesPerCorp) : []) {
      if (!isObj(s) || typeof s.id !== 'string' || ids.has(s.id)) continue;
      const n = cleanText(s.name, LIMITS.name); if (n.error) continue;
      const p = cleanFolderPath(s.path);
      ids.add(s.id);
      corp.services.push({ id: s.id.slice(0, 64), name: n.value, path: p.error ? '' : p.value, tier: tierOf(s.tier),
        owner: cleanText(s.owner, LIMITS.owner, { allowEmpty: true }).value || '', note: cleanText(s.note, LIMITS.note, { allowEmpty: true }).value || '',
        globalId: typeof s.globalId === 'string' ? s.globalId.slice(0, 64) : '' });
    }
    for (const r of Array.isArray(c.folderRules) ? c.folderRules.slice(0, LIMITS.folderRulesPerCorp) : []) {
      const p = isObj(r) ? cleanFolderPrefix(r.prefix) : { error: 1 };
      if (!p.error && ids.has(r.serviceId)) corp.folderRules.push({ prefix: p.value, serviceId: r.serviceId });
    }
    for (const a of Array.isArray(c.aliases) ? c.aliases.slice(0, LIMITS.aliasesPerCorp) : []) {
      const v = isObj(a) ? cleanText(a.value, LIMITS.alias) : { error: 1 };
      if (!v.error && (a.kind === 'scan' || a.kind === 'tag') && ids.has(a.serviceId)) corp.aliases.push({ kind: a.kind, value: v.value, serviceId: a.serviceId });
    }
    for (const r of Array.isArray(c.nameRules) ? c.nameRules.slice(0, LIMITS.nameRulesPerCorp) : []) {
      const v = isObj(r) ? cleanText(r.value, LIMITS.nameRule) : { error: 1 };
      if (!v.error && ['prefix', 'suffix', 'contains'].includes(r.match) && ids.has(r.serviceId)) corp.nameRules.push({ match: r.match, value: v.value, serviceId: r.serviceId });
    }
    out.corps[vc] = corp;
  }
  return out;
}
/** 고정 한 건 정리(순수) — 모르는 모양이면 null. normalizePins 와 mutatePins(바뀐 키만)가 같은 함수를 쓴다(판정 복제 금지). */
export function normalizePin(k, p) {
  if (!k || typeof k !== 'string' || k.length > 256 || !isObj(p) || typeof p.serviceId !== 'string' || typeof p.corp !== 'string') return null;
  const o = { serviceId: p.serviceId.slice(0, 64), corp: p.corp.slice(0, 128), by: String(p.by || '').slice(0, 64), at: Number.isFinite(p.at) ? p.at : 0, reviewed: p.reviewed === true };
  if (o.reviewed && (p.reviewedAuto === null || typeof p.reviewedAuto === 'string')) o.reviewedAuto = p.reviewedAuto === null ? null : p.reviewedAuto.slice(0, 64);
  return o;
}
export function normalizePins(raw) {
  const out = emptyPins();
  if (!isObj(raw)) return out;
  out.rev = Number.isFinite(raw.rev) ? Math.max(0, Math.floor(raw.rev)) : 0;
  let n = 0;
  for (const [k, p] of Object.entries(isObj(raw.pins) ? raw.pins : {})) {
    if (n >= LIMITS.pins) break;
    const o = normalizePin(k, p);
    if (!o) continue;
    out.pins[k] = o;
    n += 1;
  }
  return out;
}
export function tierOf(v) { const n = Number(v); return n === 1 || n === 2 || n === 3 ? n : 2; }

// ───────── 메모리 상태 ─────────
const S = { map: null, pins: null, mapErr: null, pinErr: null, timer: null, dirtyMap: false, dirtyPins: false, mapMtime: null, pinMtime: null };

function readJson(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return { missing: true };
    return { error: `읽기 실패(${String(e?.code || e?.message || e).slice(0, 60)})` };
  }
  try { return { value: JSON.parse(txt) }; } catch (e) { return { error: `형식 오류(${safeLoadText(e, 120)})` }; }
}
const mtimeOf = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return null; } };
/**
 * 메모리 상태는 **깊게 동결**한다 — 읽기 경로(peekMap·peekPins)가 복사 없이 참조를 넘기므로, 누가 고치려 하면 조용히 상태가 바뀌는 대신
 * 즉시 던진다(ESM 은 엄격 모드). 지도 쓰기는 draft 깊은 복사 → normalize → 동결 순서다(5차 검토 R5: 요청마다 고정 5만 건 깊은 복사 114ms).
 * 고정 쓰기는 바뀐 키만 정리·동결한다(6차 8 — mutatePins 머리말).
 */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

function ensureLoaded() {
  // 손상 상태에서는 파일이 바뀌었으면(사람이 고쳤거나 복원) 다시 읽어 본다 — 그 밖에는 메모리가 진실이다.
  if (S.map && !(S.mapErr && mtimeOf(MAP_FILE()) !== S.mapMtime)) { /* keep */ } else {
    const r = readJson(MAP_FILE());
    S.mapMtime = mtimeOf(MAP_FILE());
    if (r.error) { S.mapErr = r.error; S.map = deepFreeze(emptyMap()); console.error(`[servicemap] service-map.json 을 읽지 못했습니다 — ${r.error}. 빈 트리로 시작하지 않고 쓰기를 막습니다(복원하거나 관리자 '초기화').`); }
    else { S.mapErr = null; S.map = deepFreeze(normalizeMap(r.missing ? null : r.value)); }
  }
  if (S.pins && !(S.pinErr && mtimeOf(PIN_FILE()) !== S.pinMtime)) { /* keep */ } else {
    const r = readJson(PIN_FILE());
    S.pinMtime = mtimeOf(PIN_FILE());
    if (r.error) { S.pinErr = r.error; S.pins = deepFreeze(emptyPins()); console.error(`[servicemap] service-map-pins.json 을 읽지 못했습니다 — ${r.error}. 고정 쓰기를 막습니다.`); }
    else { S.pinErr = null; S.pins = deepFreeze(normalizePins(r.missing ? null : r.value)); }
  }
}

/** 손상 상태 — 라우트가 503(`registryUnreadable` 규약)으로 말한다. 없으면 null. */
export function storeLoadError() {
  ensureLoaded();
  if (!S.mapErr && !S.pinErr) return null;
  return { map: S.mapErr, pins: S.pinErr };
}

function flush() {
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  let ok = true;
  if (S.dirtyMap && !S.mapErr) {
    try { atomicWriteFileSync(MAP_FILE(), JSON.stringify(S.map)); S.dirtyMap = false; S.mapMtime = mtimeOf(MAP_FILE()); }
    catch (e) { ok = false; console.error('[servicemap] service-map.json 저장 실패:', e?.message); }
  }
  if (S.dirtyPins && !S.pinErr) {
    try { atomicWriteFileSync(PIN_FILE(), JSON.stringify(S.pins)); S.dirtyPins = false; S.pinMtime = mtimeOf(PIN_FILE()); }
    catch (e) { ok = false; console.error('[servicemap] service-map-pins.json 저장 실패:', e?.message); }
  }
  return ok;
}
/** 쓰기 응답 직전에 부른다 — 실패를 200 으로 감추지 않는다(svcmon 규약). */
export function flushStore() { return flush(); }
function schedule() {
  if (S.timer) return;
  S.timer = setTimeout(flush, 200);
  S.timer.unref?.();
}

/** 읽기 사본(깊은 복사 — 호출부가 고쳐도 상태가 바뀌지 않는다). */
export function getMap() { ensureLoaded(); return JSON.parse(JSON.stringify(S.map)); }
export function getPins() { ensureLoaded(); return JSON.parse(JSON.stringify(S.pins)); }
export function storeRev() { ensureLoaded(); return `${S.map.rev}.${S.pins.rev}`; }
/** 읽기 전용 참조(동결 — 복사 없음). 판정·집계처럼 읽기만 하는 경로 전용. 고치려면 getMap/getPins 사본이나 mutate* 를 쓴다. */
export function peekMap() { ensureLoaded(); return S.map; }
export function peekPins() { ensureLoaded(); return S.pins.pins; }

/**
 * 변경 한 번 — fn(draft) 이 { error } 를 돌려주면 아무것도 바꾸지 않는다. 성공이면 rev 를 올리고 디바운스 저장.
 * @returns {{ok:true, result?:any} | {ok:false, status:number, error:string}}
 */
export function mutateMap(fn) {
  ensureLoaded();
  if (S.mapErr) return { ok: false, status: 503, error: `service-map.json 을 읽지 못해 쓰기를 막았습니다 — ${S.mapErr}` };
  const draft = JSON.parse(JSON.stringify(S.map));
  const r = fn(draft) || {};
  if (r.error) return { ok: false, status: r.status || 400, error: r.error };
  draft.rev = (S.map.rev || 0) + 1;
  S.map = deepFreeze(normalizeMap(draft));
  S.dirtyMap = true; schedule();
  return { ok: true, result: r.result };
}
/**
 * 고정 쓰기 — **바뀐 키만** 정리·동결한다(6차 8 — 실측: 고정 5만 건이면 예전 방식(전체 깊은 복사 → 전체 normalize → 전체 동결)이 쓰기 1건에
 * 이벤트 루프를 약 130ms 막았다). draft.pins 는 **얕은 사본**이고 그 안의 항목은 지금 상태의 동결 객체다 — fn 은 항목을 고치지 말고
 * 새 객체로 바꿔 넣거나(`d.pins[k] = { ...p, reviewed: true }`) 지운다(고치면 던진다 — ESM 엄격 모드). 바뀌지 않은 항목은 그대로 공유한다.
 * fn 이 오류를 돌려주거나 던지면 상태는 그대로다(사본만 버린다).
 */
export function mutatePins(fn) {
  ensureLoaded();
  if (S.pinErr) return { ok: false, status: 503, error: `service-map-pins.json 을 읽지 못해 쓰기를 막았습니다 — ${S.pinErr}` };
  const prev = S.pins.pins;
  const draft = { rev: S.pins.rev, pins: { ...prev } };
  const r = fn(draft) || {};
  if (r.error) return { ok: false, status: r.status || 400, error: r.error };
  // fn 이 draft.pins 를 통째로 바꿨으면(얕은 사본이 아니면) 그 객체를 고치지 않고 새로 담는다.
  const next = draft.pins === undefined || !isObj(draft.pins) ? {} : (Object.isFrozen(draft.pins) ? { ...draft.pins } : draft.pins);
  // 바뀐 키(새로 넣었거나 다른 객체로 바뀐 키)만 정리한다. 지운 키는 next 에 없으므로 할 일이 없다. 바뀌지 않은 항목은 이미 정리·동결된 지금 값이다.
  const keys = Object.keys(next);
  for (const k of keys) {
    const v = next[k];
    if (v === prev[k]) continue;
    const o = normalizePin(k, v);
    if (o) next[k] = Object.freeze(o); else delete next[k];
  }
  if (Object.keys(next).length > LIMITS.pins) return { ok: false, status: 400, error: `고정은 최대 ${LIMITS.pins}건입니다` };
  S.pins = Object.freeze({ rev: (S.pins.rev || 0) + 1, pins: Object.freeze(next) });
  S.dirtyPins = true; schedule();
  return { ok: true, result: r.result };
}

/** 손상 상태에서 빈 저장소로 — 손상본은 .corrupt.<ts> 로 보존. 전체 범위 관리자만 부른다(라우트 게이트). */
export function resetCorrupt() {
  ensureLoaded();
  const moved = [];
  if (S.mapErr) { const b = preserveCorrupt(MAP_FILE(), S.mapErr); if (b) moved.push(path.basename(b)); S.mapErr = null; S.map = deepFreeze(emptyMap()); S.dirtyMap = true; }
  if (S.pinErr) { const b = preserveCorrupt(PIN_FILE(), S.pinErr); if (b) moved.push(path.basename(b)); S.pinErr = null; S.pins = deepFreeze(emptyPins()); S.dirtyPins = true; }
  const ok = flush();
  return { ok, moved };
}

/** 법인 하나(없으면 빈 모양을 만들어 돌려준다 — draft 전용). */
export function corpOf(draft, vc) {
  if (!draft.corps[vc]) draft.corps[vc] = emptyCorp();
  return draft.corps[vc];
}
export const sameName = (a, b) => lc(a).trim() === lc(b).trim();

export function _resetForTest() { if (S.timer) clearTimeout(S.timer); Object.assign(S, { map: null, pins: null, mapErr: null, pinErr: null, timer: null, dirtyMap: false, dirtyPins: false, mapMtime: null, pinMtime: null }); }
