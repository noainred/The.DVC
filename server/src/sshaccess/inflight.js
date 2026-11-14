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
import { registerStateFile } from '../util/stateFiles.js';

export const INFLIGHT_FILE_NAME = 'ssh-key-jobs-inflight.json';
const FILE = () => path.join(config.configDir, 'ssh-key-jobs-inflight.json');   // = INFLIGHT_FILE_NAME
// 상태 파일 — 설정 변경 자동 백업 · 지문에 넣지 않고, 복원에서도 뺀다(되돌리면 끝난 작업이 ‘중단’ 사건이 된다 · 2회차 D2-1).
registerStateFile(INFLIGHT_FILE_NAME);
const MAX = 50;
const t = (v, max = 128) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
let cache = null;
let readFailedAt = 0;   // 마지막 읽기 오류 시각(3회차 C3-4 — 못 읽는 동안 ‘중단’ 기록이 조용히 꺼졌다: 화면 · 콘솔이 밝힌다)
/** 진행 기록 파일을 지금 읽을 수 있는가 — 못 읽으면 { at } (화면 키 점검 · 콘솔). */
export function inflightReadIssue() { if (!cache) load(); return cache ? null : (readFailedAt ? { at: readFailedAt } : null); }

/** → 기록 배열, 또는 읽기 오류면 null(그때는 기록하지 않는다 — 작업은 계속 돈다 · 원본을 덮지 않는다). */
function load() {
  if (cache) return cache;
  let text;
  try {
    if (!fs.existsSync(FILE())) { cache = []; return cache; }
    text = fs.readFileSync(FILE(), 'utf8');
  } catch { readFailedAt = Date.now(); return null; }   // 읽기 오류(권한 · EISDIR 등)는 손상이 아니다 — 원본을 두고 다음에 다시 읽는다(2회차 C2-8)
  try {
    const j = JSON.parse(text);
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
  // 못 읽으면 기록만 못 한다(2회차 반증 R2R-1 — cache 가 null 인 채 filter 를 불러 **모든 키 작업이 오류**로 끝났다. 긴급 거두기 포함).
  if (!load()) return false;
  // 같은 작업 · 같은 서버(등록부 id — 이름은 법인끼리 겹칠 수 있다)는 하나.
  cache = cache.filter((x) => !(x.jobId === t(jobId, 24) && x.sid === t(sid, 64)));
  cache.push({ jobId: t(jobId, 24), kind: t(kind, 16), keyName: t(keyName, 64), sid: t(sid, 64), server: t(server), corp: t(corp), by: t(by, 64), at: now });
  if (cache.length > MAX) cache = cache.slice(-MAX);
  return save();
}
/** 그 서버가 끝남(성공 · 실패 무관 — 결과는 작업 기록에 있다). */
export function markEnd({ jobId, sid }) {
  if (!load()) return false;
  const before = cache.length;
  cache = cache.filter((x) => !(x.jobId === t(jobId, 24) && x.sid === t(sid, 64)));
  return before === cache.length ? true : save();
}
/** 기동 때 — 남은 기록(지난 실행이 바꾸던 중에 멈춘 서버)을 돌려준다. 비우지 않는다 — 사건을 쓴 뒤에 clearLeftovers(1회차 반증 10 — 먼저 비워 사건 쓰기가 실패하면 기록이 사라졌다). */
export function peekLeftovers() { cache = null; return (load() || []).slice(); }
/** 사건으로 옮긴 뒤 그 항목들만 지운다(그 사이 새로 생긴 기록은 남긴다). */
export function clearLeftovers(items) {
  if (!load()) return false;
  const gone = new Set((Array.isArray(items) ? items : []).map((x) => `${x.jobId}|${x.sid}`));
  cache = cache.filter((x) => !gone.has(`${x.jobId}|${x.sid}`));
  return save();
}
export function _resetInflightForTest() { cache = null; readFailedAt = 0; }
