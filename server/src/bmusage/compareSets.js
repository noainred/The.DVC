/**
 * bmusage/compareSets.js — 리눅스 성능 6단계 **저장된 비교 세트**(사용자별 · 중앙 저장 · 설계 PROFILES §15 ‘저장된 세트(사용자별 · 서버 키 목록 · 범위 설정 포함)’).
 *
 * 파일 `bm-perf-compare-sets.json`(이 노드 — 화면을 내주는 노드가 중앙이면 중앙). 비밀 없음(서버 키 · 이름 · 법인 간 허용 여부만).
 * 파일 스토어 규약(perf-db.md v2.582): 원자 쓰기 · 손상 보존(preserveCorrupt) · 손상이면 **읽기 503 · 쓰기 거부**(settingsLoadError — 빈 목록으로 덮어
 *   다른 사용자의 세트를 지우지 않는다 · 관리자가 서비스 점검에서 ‘기본값으로 확정’ 해야 풀린다).
 * ⚠ 읽기-수정-쓰기는 **한 동기 구간**이다(load → 수정 → atomicWrite 사이에 await 없음) — 같은 프로세스의 동시 요청이 서로의 저장을 덮지 않는다
 *   (5단계 반증 F1 ‘상태 파일 읽기-수정-쓰기 경쟁’ 을 처음부터 피한다).
 * 사용자 이름은 객체 키로 쓰지 않는다(`__proto__` 같은 이름) — 배열 `{ user, sets }` 로 둔다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';

const FILE = () => path.join(config.configDir, 'bm-perf-compare-sets.json');
export const SETS_PER_USER = 20;
export const SET_NAME_MAX = 60;
export const KEY_MAX_LEN = 256;
/** 한 세트의 서버 수 상한의 바깥 한계(실제 상한은 설정 compare.maxServers — 저장 때 라우트가 넘긴다). */
export const SET_KEYS_HARD_MAX = 8;
const CTRL_SRC = '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]';
const CTRL_RE = new RegExp(CTRL_SRC, 'g');
const CTRL_ONE = new RegExp(CTRL_SRC);

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 저장된 비교 세트', confirm: () => writeAll({ v: 1, users: [] }) });
function fail(status, code, reason) { const e = new Error(reason); e.status = status; e.code = code; return e; }
export function cleanSetName(v) {
  const s = String(typeof v === 'string' ? v : '').replace(CTRL_RE, '').replace(/\s+/g, ' ').trim();
  return s.length >= 1 ? s.slice(0, SET_NAME_MAX) : '';
}
function writeAll(obj) {
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  _err.ok();
}
/** 동기 로드 — 손상이면 보존 후 throw(503). 파일 없음이면 빈 판(보존본만 남은 ‘못 읽음’ 이면 throw). */
function loadAll() {
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') throw fail(503, 'settingsUnreadable', '비교 세트 파일을 읽지 못했습니다.');
    _err.missing();
    if (_err.get()) throw fail(503, 'settingsUnreadable', _err.get().reason);
    return { v: 1, users: [] };
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.users)) throw new Error('형식이 다릅니다');
    _err.ok();
    return { v: 1, users: o.users.filter((u) => u && typeof u === 'object' && typeof u.user === 'string' && Array.isArray(u.sets)) };
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] bm-perf-compare-sets.json 을 읽지 못했습니다 — 손상본을 보존했고, 확정 전까지 비교 세트 읽기 · 저장을 멈춥니다');
    throw fail(503, 'settingsUnreadable', _err.get()?.reason || '비교 세트 파일을 읽지 못했습니다.');
  }
}
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
/** 다음 점검 ①: 세트의 서버 = (법인, 키) 쌍 — vcenterIds 는 keys 와 같은 순서(빈 칸 = 법인 모름 · 이 필드가 없는 예전 세트는 키만 — 열 때 해석이 정한다). */
const pubSet = (s) => {
  const keys = (Array.isArray(s.keys) ? s.keys : []).map(String);
  const vcs = Array.isArray(s.vcenterIds) ? s.vcenterIds.map((v) => (typeof v === 'string' && VC_RE.test(v) ? v : '')) : [];
  return { id: String(s.id), name: String(s.name), keys, ...(vcs.some(Boolean) ? { vcenterIds: keys.map((_, i) => vcs[i] || '') } : {}), cross: s.cross === true, at: Number(s.at) || 0 };
};

/** 이 사용자의 세트(사본). */
export function listCompareSets(user) {
  const u = String(user || '');
  const all = loadAll();
  return (all.users.find((x) => x.user === u)?.sets || []).map(pubSet);
}
/**
 * 저장(새로 · 같은 id 면 고침). 형식 밖은 400 · 상한 409. keys 는 **범위 검사를 하지 않는다**(정정 — 반증 의심 항목: 예전 주석은 ‘라우트가 범위 검사를 마친 것’ 이라 했지만
 *   라우트 setsWrite 는 키 범위를 보지 않는다). 세트는 저장한 사람에게만 돌려주는 자기 입력(키 글자)이라 새는 것이 없고, 세트를 열 때 비교 조회가 그 사람의 범위로 다시 판정한다
 *   (범위 밖 · 없는 키는 ‘없음’ 열). 범위 계정은 cross 세트를 저장하지 못한다(라우트 400).
 * @param {{user:string, id?:string, name:string, keys:string[], cross?:boolean, maxServers?:number}} p
 */
export function saveCompareSet({ user, id = '', name, keys, vcenterIds = [], cross = false, maxServers = 5, now = Date.now() } = {}) {
  const u = String(user || '');
  if (!u) throw fail(400, 'bad-request', '사용자를 알 수 없습니다.');
  const nm = cleanSetName(name);
  if (!nm) throw fail(400, 'bad-name', '세트 이름이 필요합니다.');
  const cap = Math.max(2, Math.min(SET_KEYS_HARD_MAX, Math.floor(Number(maxServers)) || 5));
  if (!Array.isArray(keys)) throw fail(400, 'bad-keys', '서버 목록이 필요합니다.');
  if (vcenterIds != null && !Array.isArray(vcenterIds)) throw fail(400, 'bad-keys', '법인 목록 형식이 다릅니다.');
  const vin = Array.isArray(vcenterIds) ? vcenterIds : [];
  if (vin.some((v) => v != null && v !== '' && !(typeof v === 'string' && VC_RE.test(v.trim())))) throw fail(400, 'bad-keys', '법인(vCenter id) 형식이 다릅니다.');
  // 같은 쌍은 한 번(같은 키 · 다른 법인은 다른 서버 — 다음 점검 ①)
  const seen = new Set(); const ks = []; const vs = [];
  keys.forEach((k0, i) => {
    const k = String(typeof k0 === 'string' ? k0 : '').trim();
    const v = typeof vin[i] === 'string' ? vin[i].trim() : '';
    if (!k || seen.has(`${v}|${k}`)) return;
    seen.add(`${v}|${k}`); ks.push(k); vs.push(v);
  });
  if (ks.length < 2 || ks.length > cap) throw fail(400, 'bad-keys', `서버는 2~${cap}대여야 합니다.`);
  if (ks.some((k) => k.length > KEY_MAX_LEN || CTRL_ONE.test(k))) throw fail(400, 'bad-keys', '서버 키 형식이 다릅니다.');
  // ── 동기 구간 시작(load → 수정 → 쓰기 · await 없음) ──
  const all = loadAll();
  let rec = all.users.find((x) => x.user === u);
  if (!rec) { rec = { user: u, sets: [] }; all.users.push(rec); }
  const sid = String(id || '');
  let set = sid ? rec.sets.find((s) => String(s.id) === sid) : null;
  if (sid && !set) throw fail(404, 'not-found', '그 세트를 찾지 못했습니다.');
  if (!set) {
    if (rec.sets.length >= SETS_PER_USER) throw fail(409, 'cap', `세트는 사용자당 ${SETS_PER_USER}개까지입니다.`);
    set = { id: crypto.randomBytes(6).toString('hex') };
    rec.sets.push(set);
  }
  Object.assign(set, { name: nm, keys: ks, cross: cross === true, at: now });
  if (vs.some(Boolean)) set.vcenterIds = vs; else delete set.vcenterIds;
  writeAll(all);
  return pubSet(set);
}
export function deleteCompareSet({ user, id } = {}) {
  const u = String(user || ''); const sid = String(id || '');
  const all = loadAll();
  const rec = all.users.find((x) => x.user === u);
  const i = rec ? rec.sets.findIndex((s) => String(s.id) === sid) : -1;
  if (i < 0) throw fail(404, 'not-found', '그 세트를 찾지 못했습니다.');
  rec.sets.splice(i, 1);
  writeAll(all);
  return { ok: true };
}
export function compareSetsLoadError() { try { loadAll(); } catch { /* get 이 말한다 */ } return _err.get(); }
export function _resetCompareSetsForTest() { _err.ok(); }
