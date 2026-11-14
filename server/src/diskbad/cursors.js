/**
 * diskbad/cursors.js — 이 노드가 서버마다 '지난번 읽은 가장 새 로그 항목' 을 기억한다(v3.8.0).
 *
 * 읽는 노드(엣지 · 중앙 직결)가 자기 파일로 갖는다 — 6시간마다 새 로그만 읽게 하는 유일한 장치다.
 * 상태 파일이라 설정 백업 · 설정 push 대상이 아니다(`registerStateFile`). 손상되면 처음부터 다시 읽는다(전량 — 중앙이 중복을 거른다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';

export const CURSOR_FILE = 'diskbad-cursors.json';
registerStateFile(CURSOR_FILE);
const FILE = () => path.join(config.configDir, CURSOR_FILE);
const MAX = 20_000;

let _mem = null;
function load() {
  if (_mem) return _mem;
  try { const j = JSON.parse(fs.readFileSync(FILE(), 'utf8')); _mem = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; }
  catch (e) {
    // 파일이 없으면 처음 — 손상이면 보존하고(다음 저장이 덮기 전에) 처음부터 다시 읽는다(전량 — 중앙이 중복을 거른다).
    if (e?.code !== 'ENOENT') { try { preserveCorrupt(FILE(), String(e?.message || e)); } catch { /* best effort */ } }
    _mem = {};
  }
  return _mem;
}

/** @returns {{entryId:string, created:number, complete:boolean, at:number}|null} */
export function cursorOf(serverId) {
  const c = load()[String(serverId || '')];
  return c && Number.isFinite(c.created) ? c : null;
}

/** 여러 서버를 한 번에 적는다(서버마다 쓰지 않는다 — 수십 대를 읽은 뒤 한 번). null 이면 그 서버의 커서를 지운다. */
export function saveCursors(map) {
  const m = load();
  for (const [id, c] of Object.entries(map || {})) {
    if (!id) continue;
    if (c == null) delete m[id];
    else m[id] = { entryId: String(c.entryId || '').slice(0, 64), created: c.created, complete: c.complete === true, at: Date.now() };
  }
  const keys = Object.keys(m);
  if (keys.length > MAX) for (const k of keys.sort((a, b) => (m[a].at || 0) - (m[b].at || 0)).slice(0, keys.length - MAX)) delete m[k];
  try { atomicWriteFileSync(FILE(), JSON.stringify(m)); } catch (e) { console.warn(`[diskbad] 커서 파일 저장 실패: ${String(e?.message || e).slice(0, 160)}`); }
}

export function _resetCursorsForTest() { _mem = null; }
