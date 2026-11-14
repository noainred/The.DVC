/**
 * sshaccess/inflight.js — 키 작업(키 로그인 설정 · 키 거두기)이 **지금 바꾸고 있는 서버**의 기록(v3.10.0 · 1회차 점검 B7).
 *
 * 작업은 메모리에만 있어, 바꾸는 도중 포탈이 재시작(자동 업그레이드 포함)하면 사건 · 작업 기록이 모두 사라지고
 * 그 서버의 줄은 확인도 되돌림도 없이 남았다. 그래서 바꾸는 명령을 보내기 전에 여기 적고, 그 서버가 끝나면 지운다.
 * 기동 때 남은 것이 있으면 `peekLeftovers()` 가 돌려주고, service 가 ‘중단’ 사건으로 남긴 뒤 `clearLeftovers()` 로 그 항목만 지운다.
 *
 * 파일 `CONFIG_DIR/ssh-key-jobs-inflight.json`(0600 · 원자적 쓰기 · 비밀 없음 — 작업 id · 종류 · 키 이름 · 서버 이름 · 법인 · 시각만).
 * 못 읽으면(손상) 옆으로 치우고 빈 것으로 본다(이 파일은 기록용이다 — 판정에 쓰지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'ssh-key-jobs-inflight.json');
const MAX = 50;
const t = (v, max = 128) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (!fs.existsSync(FILE())) { cache = []; return cache; }
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = Array.isArray(j?.items) ? j.items.filter((x) => x && typeof x === 'object').slice(-MAX) : [];
  } catch {
    try { preserveCorrupt(FILE()); } catch { /* */ }
    cache = [];
  }
  return cache;
}
function save() {
  try {
    if (!cache.length) { if (fs.existsSync(FILE())) fs.rmSync(FILE(), { force: true }); return true; }
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify({ items: cache }), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** 그 서버를 바꾸기 시작함(같은 작업 · 같은 서버는 하나). */
export function markStart({ jobId, kind, keyName, sid, server, corp, by }, { now = Date.now() } = {}) {
  load();
  // 같은 작업 · 같은 서버(등록부 id — 이름은 법인끼리 겹칠 수 있다)는 하나.
  cache = cache.filter((x) => !(x.jobId === t(jobId, 24) && x.sid === t(sid, 64)));
  cache.push({ jobId: t(jobId, 24), kind: t(kind, 16), keyName: t(keyName, 64), sid: t(sid, 64), server: t(server), corp: t(corp), by: t(by, 64), at: now });
  if (cache.length > MAX) cache = cache.slice(-MAX);
  return save();
}
/** 그 서버가 끝남(성공 · 실패 무관 — 결과는 작업 기록에 있다). */
export function markEnd({ jobId, sid }) {
  load();
  const before = cache.length;
  cache = cache.filter((x) => !(x.jobId === t(jobId, 24) && x.sid === t(sid, 64)));
  return before === cache.length ? true : save();
}
/** 기동 때 — 남은 기록(지난 실행이 바꾸던 중에 멈춘 서버)을 돌려준다. 비우지 않는다 — 사건을 쓴 뒤에 clearLeftovers(1회차 반증 10 — 먼저 비워 사건 쓰기가 실패하면 기록이 사라졌다). */
export function peekLeftovers() { cache = null; return load().slice(); }
/** 사건으로 옮긴 뒤 그 항목들만 지운다(그 사이 새로 생긴 기록은 남긴다). */
export function clearLeftovers(items) {
  load();
  const gone = new Set((Array.isArray(items) ? items : []).map((x) => `${x.jobId}|${x.sid}`));
  cache = cache.filter((x) => !gone.has(`${x.jobId}|${x.sid}`));
  return save();
}
export function _resetInflightForTest() { cache = null; }
