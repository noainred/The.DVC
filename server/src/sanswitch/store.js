/**
 * sanswitch/store.js — 이 노드가 수집한 최신 스냅샷 보관(v2.410, storage/store.js 와 동일 철학).
 * deviceId → NormalizedSwitchSnapshot. 재시작 후에도 마지막 화면이 비지 않게 파일로 영속
 * (자격증명 없음 — 정규화 스냅샷만. 그래도 0600).
 *
 * ⚠ 포트 목록이 커서(디렉터 512포트) 파일이 커진다 — 그래서 **중앙 push 에는 포트 목록을
 *   요약해 보낸다**(push.js 참조). 여기 로컬 파일은 상세 화면용으로 전체를 들고 있는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'sanswitch-latest.json');
let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 손상 시 다음 폴링이 재구축
  return _map;
}
function flush() { atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }

export function putSnapshot(snap) { load().set(snap.deviceId, snap); flush(); }
export function localSnapshots() { return [...load().values()]; }
export function getSnapshot(deviceId) { return load().get(deviceId) || null; }
export function dropSnapshot(deviceId) { if (load().delete(deviceId)) flush(); }
export function _resetForTest() { _map = null; }
