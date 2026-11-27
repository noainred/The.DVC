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
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)

export const INSTALLED_FILE_NAME = 'ssh-access-installed.json';
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
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE(), { parse: (t) => t, preserve: false, tag: 'ssh-access-installed' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function installedWriteRefusal() {
  load();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `SSH 키 설치 기록 파일(${path.basename(FILE())})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}
function load() {
  if (cache) return cache;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return new Map(); }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  cache = new Map();
  try {
    if (rr.kind !== 'ok') return cache;
    const j = JSON.parse(rr.value);
    for (const [id, v] of Object.entries(isObj(j?.servers) ? j.servers : {}).slice(0, MAX_SERVERS)) { const sid = t(id, 64); if (sid && isObj(v)) cache.set(sid, normRec(v)); }
  } catch (e) { preserveCorrupt(FILE(), e?.message); loadFailed = true; cache = new Map(); }
  return cache;
}
function persist(next) {
  { const no = installedWriteRefusal(); if (no) return no; }   // 107회차: 읽기 오류 중에는 빈 기록 위에 쓰지 않는다
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify({ servers: Object.fromEntries(next) }), { mode: 0o600 });
  } catch (e) { return { ok: false, code: 'write-failed', status: 500, reason: `읽은 결과를 저장하지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)}).` }; }
  cache = next; loadFailed = false;
  return { ok: true };
}
export function _resetInstalledForTest() { cache = null; loadFailed = false; _reader.reset(); _readErr = ''; }
export function installedLoadFailed() { load(); return loadFailed || !!_readErr; }

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
