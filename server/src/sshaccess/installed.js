/**
 * sshaccess/installed.js — 서버에서 읽은 `~/.ssh/authorized_keys` 의 **공개키 지문**(v3.9.0 · 설계 docs/design/ssh-access §9).
 *
 * 파일 `CONFIG_DIR/ssh-access-installed.json`(0600 · 원자적 쓰기 · 손상 보존 — 비밀 없음 · 지문 · 종류 · 설명만):
 *   { servers: { [OS 등록 항목 id]: { at, by, host, port, username, file, keys:[{fingerprint,type,comment,portal,hasOptions}], truncated, error } } }
 * 접속 판정에 쓰지 않는다(화면 표시 · 키 고르기의 ‘이 서버에 들어 있음’ 뿐) — 그래서 손상되면 보존하고 빈 기록으로 간다(키 접속을 멈추지 않는다).
 * 상태 파일(state.js)과 나눈 까닭: 서버 수 × 키 줄이 커지면 사건 하나 쓸 때마다 큰 파일을 다시 쓰고(점검 D-6 · C-7), 이 기록의 손상이
 * 사용 중지 판정(fail-closed)까지 멈추게 했다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';

export const INSTALLED_FILE_NAME = 'ssh-access-installed.json';
// 상태 파일(화면용 기록) — v3.10.0 부터 키 작업이 서버마다 쓴다. 설정 변경 자동 백업 · 지문에 넣지 않는다(2회차 D2-1 — 작업 잡음이 자동 보관 슬롯을 밀어냈다).
registerStateFile(INSTALLED_FILE_NAME);
const FILE = () => path.join(config.configDir, 'ssh-access-installed.json');   // = INSTALLED_FILE_NAME
export const MAX_INSTALLED_KEYS = 200;
const MAX_SERVERS = 5000;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

let cache = null;
let loadFailed = false;

function normKey(k) {
  if (!isObj(k)) return null;
  const fingerprint = t(k.fingerprint, 80);
  if (!FP_RE.test(fingerprint)) return null;
  return Object.freeze({ fingerprint, type: t(k.type, 40), comment: t(k.comment, 120), portal: k.portal === true, hasOptions: k.hasOptions === true });
}
function normRec(v) {
  return Object.freeze({
    at: num(v.at), by: t(v.by, 64), host: t(v.host, 256), port: Number(v.port) > 0 ? Math.round(Number(v.port)) : 22, username: t(v.username, 128),
    file: t(v.file, 200), error: t(v.error, 300), truncated: num(v.truncated),
    keys: Object.freeze((Array.isArray(v.keys) ? v.keys : []).map(normKey).filter(Boolean).slice(0, MAX_INSTALLED_KEYS)),
  });
}
function load() {
  if (cache) return cache;
  cache = new Map();
  try {
    if (!fs.existsSync(FILE())) return cache;
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    for (const [id, v] of Object.entries(isObj(j?.servers) ? j.servers : {}).slice(0, MAX_SERVERS)) { const sid = t(id, 64); if (sid && isObj(v)) cache.set(sid, normRec(v)); }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadFailed = true; cache = new Map(); }
  return cache;
}
function persist(next) {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify({ servers: Object.fromEntries(next) }), { mode: 0o600 });
  } catch (e) { return { ok: false, code: 'write-failed', status: 500, reason: `읽은 결과를 저장하지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` }; }
  cache = next; loadFailed = false;
  return { ok: true };
}
export function _resetInstalledForTest() { cache = null; loadFailed = false; }
export function installedLoadFailed() { load(); return loadFailed; }

export function noteInstalled(serverId, rec = {}, { now = Date.now() } = {}) {
  const id = t(serverId, 64);
  if (!id) return { ok: false, code: 'bad-id', reason: '서버가 없습니다.' };
  const next = new Map(load());
  next.delete(id);
  next.set(id, normRec({ ...rec, at: now }));
  while (next.size > MAX_SERVERS) next.delete(next.keys().next().value);   // 가장 오래 전에 읽은 것부터(삽입 순서)
  return persist(next);
}
/** 읽기 전용 기록(얼린 객체 — 복사하지 않는다. 고치지 말 것). 없으면 null. */
export function installedOf(serverId) { return load().get(t(serverId, 64)) || null; }
/** 등록부에서 지워진 서버의 기록 정리(ids = 지금 있는 서버 id 집합). 바뀐 것이 없으면 쓰지 않는다. */
export function pruneInstalled(ids) {
  const cur = load();
  const next = new Map([...cur].filter(([id]) => ids.has(id)));
  return next.size === cur.size ? { ok: true, removed: 0 } : persist(next);
}
