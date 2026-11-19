/**
 * serverinfo/store.js — 서버 정보 **마지막 읽은 값** 보관(서버당 한 줄 · CONFIG_DIR/server-info.json · 비밀 없음).
 *  · 원자 쓰기 · 읽기 단계를 가른다: 없음(ENOENT) = 빈 값 · **읽기 오류(EACCES · EMFILE …) = 표지만 · 원본 그대로 · 이 프로세스에서는 쓰지 않는다**(지난 값을 빈 목록으로 덮지 않게) ·
 *    모양 오류(parse) = 원본을 `.corrupt.<ts>` 로 보존하고 빈 값(수집 사본이라 다시 읽으면 채워진다 — 화면이 보관 파일 상태를 말한다).
 *  · 디바운스 저장(2초 — 일괄 읽기 30대가 30번 쓰지 않게) · 종료 때 동기 저장.
 *  · 원문 출력은 싣지 않는다 — 해석한 칸(base · disks · fs)과 출처(os · via · 계정 이름 · 시각 · 소요)만.
 *  · 등록부에서 지워진 서버의 줄은 목록 응답에서 빼고(prune), 다음 저장 때 지운다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';

export const SERVER_INFO_FILE = 'server-info.json';
const FILE = () => path.join(config.configDir, 'server-info.json');   // 이름은 글자로(설정 파일 문서 생성기 · 복원 분류표가 소스에서 찾는다) — SERVER_INFO_FILE 과 같다
const MAX_ROWS = 2000;

let map = null;
let timer = null;
let loadError = '';
let retryAt = 0;
/** 읽기 오류(EMFILE 등) 뒤 다시 읽는 간격 — 일시 오류가 재시작까지 굳지 않게(반증 F11). 그동안 쌓은 새 결과는 다시 읽은 값 위에 얹는다. */
export const READ_RETRY_MS = 30_000;

function load() {
  if (map && loadError && loadError !== 'corrupt' && Date.now() >= retryAt) {
    const pending = map; map = null; loadError = '';
    const m = load();
    if (!loadError) { for (const [k, v] of pending) m.set(k, v); if (pending.size) persistSoon(); }
    else { for (const [k, v] of pending) m.set(k, v); }
    return m;
  }
  if (map) return map;
  map = new Map();
  let txt = null;
  try { txt = fs.readFileSync(FILE(), 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') { loadError = String(e?.code || 'read-error'); retryAt = Date.now() + READ_RETRY_MS; } return map; }
  try {
    const j = JSON.parse(txt);
    for (const [k, v] of Object.entries(j?.servers && typeof j.servers === 'object' ? j.servers : {})) if (v && typeof v === 'object' && map.size < MAX_ROWS) map.set(k, v);
  } catch {
    preserveCorrupt(FILE(), 'server-info 손상');
    loadError = 'corrupt';
  }
  return map;
}
function writeNow() {
  if (loadError && loadError !== 'corrupt') { console.warn(`[serverinfo] 보관 파일을 읽지 못해(${loadError}) 쓰지 않습니다 — 원본을 그대로 둡니다.`); return; }
  try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, servers: Object.fromEntries(load()) }), { mode: 0o600 }); } catch (e) { console.warn(`[serverinfo] 저장 실패: ${String(e?.code || e?.message || e).slice(0, 80)}`); }
}
function persistSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; writeNow(); }, 2000);
  timer.unref?.();
}
registerExitFlush('serverinfo/store', () => { if (!timer) return; clearTimeout(timer); timer = null; writeNow(); });

/** 한 서버의 마지막 결과를 바꾼다(실패도 남긴다 — 마지막 성공 값은 lastOk 로 함께 둔다: 실패 한 번에 화면이 비지 않게, 그러나 ‘지금 값’ 처럼 보이지 않게 시각을 따로). */
export function putResult(serverId, row) {
  const m = load();
  const id = String(serverId || '').slice(0, 64);
  if (!id) return;
  const prev = m.get(id) || null;
  const next = row.ok ? { ...row } : { ...row, lastOk: prev?.ok ? stripLast(prev) : (prev?.lastOk || null) };
  if (!m.has(id) && m.size >= MAX_ROWS) return;
  m.set(id, next);
  persistSoon();
}
const stripLast = (r) => { const { lastOk, ...rest } = r; void lastOk; return rest; };

export function getResult(serverId) { return load().get(String(serverId || '')) || null; }
export function listResults() { return load(); }
/** 등록부에 없는 서버 줄 지우기(목록 응답 때) — 바뀌었으면 저장. */
export function pruneTo(ids) {
  const keep = new Set(ids);
  const m = load(); let n = 0;
  for (const k of [...m.keys()]) if (!keep.has(k)) { m.delete(k); n += 1; }
  if (n) persistSoon();
  return n;
}
export const storeLoadError = () => (load(), loadError);
/** 시험용. */
export function _resetServerInfoStoreForTest({ retryNow = false } = {}) { if (retryNow) { retryAt = 0; return; } map = null; loadError = ''; retryAt = 0; if (timer) { clearTimeout(timer); timer = null; } }
