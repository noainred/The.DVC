/**
 * storage/store.js — 이 노드가 수집한 최신 스냅샷 보관(v2.302).
 * deviceId → NormalizedSnapshot. 재시작 후에도 마지막 뷰가 비지 않게 파일로 영속
 * (자격증명 없음 — 정규화 스냅샷만. 그래도 계정 목록이 있어 0600 + gitignore).
 * 시계열(용량 추이)은 후속 — v1 은 최신값만(릴리스 노트에 명시).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'storage-latest.json');
let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 손상 시 다음 폴링이 재구축(preserveCorrupt 불필요)
  return _map;
}
export function putSnapshot(snap) {
  load().set(snap.deviceId, snap);
  atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 });
}
export function localSnapshots() { return [...load().values()]; }
export function dropSnapshot(deviceId) { if (load().delete(deviceId)) atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }
export function _resetForTest() { _map = null; }
