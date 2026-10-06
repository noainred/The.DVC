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
import { getDataSource } from '../runtime-settings.js';   // v2.708: mock 판정(flags.js 와 같은 판정 — 이 파일은 순환을 피해 직접 읽는다)
import { registerExitFlush } from '../util/exitFlush.js';

const FILE = path.join(config.configDir, 'sanswitch-latest.json');
let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 손상 시 다음 폴링이 재구축
  return _map;
}
function flush() { atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }

/**
 * v2.708 데모(mock): 데모 장비가 수십 대라 장비마다 파일 전체를 다시 쓰면(장비 수²) 시드·주기마다 수백 MB 를 동기로 쓴다.
 *   mock 에서만 2초 디바운스로 묶는다(이 파일은 캐시 성격 — 손상·유실 시 다음 폴링이 재구축). live 는 예전 그대로 즉시 쓴다.
 */
let _flushTimer = null;
function flushSoon() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; try { flush(); } catch (e) { console.warn(`[sanswitch] 스냅샷 저장 실패: ${e.message}`); } }, 2000);
  _flushTimer.unref?.();
}
const isMock = () => { try { return getDataSource() === 'mock'; } catch { return false; } };
registerExitFlush('sanswitch-latest', () => { if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; flush(); } });
export function putSnapshot(snap) { load().set(snap.deviceId, snap); if (isMock()) flushSoon(); else flush(); }
export function localSnapshots() { return [...load().values()]; }
export function getSnapshot(deviceId) { return load().get(deviceId) || null; }
export function dropSnapshot(deviceId) { if (load().delete(deviceId)) flush(); }
export function _resetForTest() { _map = null; }
