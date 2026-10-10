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
function writeFile() { atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }

/*
 * v2.732(감사 B6-02): **장비마다 파일 전체를 다시 쓰지 않는다** — 주기 끝 1회 flush + 안전 상한 타이머 + 종료 flush.
 *   예전 live 는 putSnapshot 마다 전 장비를 JSON.stringify + 원자 쓰기(fsync 2회)했다 — 정지 1회는 O(N)(86대 p50 54.6ms)이고
 *   한 주기 합은 O(N²)(86대 약 5초). 2초 디바운스는 live 에서 거의 묶지 못한다(장비 완료 간격이 대부분 2초보다 길다) — 그래서
 *   **폴러가 풀을 다 돈 뒤 `flushSnapshotsNow()` 를 한 번** 부르고, 그 사이 put 은 표시(dirty)만 한다.
 *   주기 끝 flush 를 부르지 않는 경로(인증 정지 기록·데모 시드·주기가 길게 늘어진 경우)는 **안전 상한 타이머**가 덮는다 —
 *   첫 dirty put 에서 한 번 무장하고 다음 put 이 미루지 않는다(디바운스가 아니다 — 낡음 상한이 고정된다).
 *   mock 은 예전과 같은 2초다(I/O 없는 데모라 완료가 몰린다). 파일 형식은 그대로(되돌림 설치 호환).
 *   ⚠ 비정상 종료(kill -9·정전) 때는 마지막 flush 뒤의 스냅샷을 잃는다 — 캐시 성격이라 다음 폴링이 재구축한다(정직 기록).
 *   ⚠ 삭제(dropSnapshot)는 즉시 쓴다 — 지운 장비가 재시작 뒤 유령으로 되살아나지 않게.
 */
export const SNAPSHOT_FLUSH_MAX_MS = 30_000;
const MOCK_FLUSH_MS = 2_000;
let _dirty = false;
let _flushTimer = null;
let _save = { writes: 0, failures: 0, lastFlushAt: null, lastErrorAt: null, lastErrorCode: null };
const isMock = () => { try { return getDataSource() === 'mock'; } catch { return false; } };

function armFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flushSnapshotsNow(); }, isMock() ? MOCK_FLUSH_MS : SNAPSHOT_FLUSH_MAX_MS);
  _flushTimer.unref?.();
}

/**
 * 대기 중인 변경을 지금 파일에 쓴다(바뀐 것이 없으면 쓰지 않는다). 폴러가 주기 끝에 부른다.
 * 실패는 조용히 넘기지 않는다 — 콘솔에 남기고 상태(`snapshotStoreStatus`)에 싣고, dirty 를 유지한 채 타이머를 다시 건다.
 * @returns {{ok:boolean, wrote:boolean, error?:string}}
 */
export function flushSnapshotsNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_dirty) return { ok: true, wrote: false };
  try {
    writeFile();
    _dirty = false;
    _save = { ..._save, writes: _save.writes + 1, lastFlushAt: Date.now() };
    return { ok: true, wrote: true };
  } catch (e) {
    _save = { ..._save, failures: _save.failures + 1, lastErrorAt: Date.now(), lastErrorCode: String(e?.code || 'error') };
    console.warn(`[sanswitch] 스냅샷 저장 실패: ${e?.message || e} — 다음 저장 때 다시 씁니다`);
    armFlush();
    return { ok: false, wrote: false, error: e?.message || String(e) };
  }
}
/** 저장 상태(파일 경로·오류 원문은 싣지 않는다 — 오류 코드만). */
export function snapshotStoreStatus() { return { pending: _dirty, ..._save }; }

registerExitFlush('sanswitch-latest', () => {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_dirty) { writeFile(); _dirty = false; }
});
export function putSnapshot(snap) { load().set(snap.deviceId, snap); _dirty = true; armFlush(); }
export function localSnapshots() { return [...load().values()]; }
export function getSnapshot(deviceId) { return load().get(deviceId) || null; }
export function dropSnapshot(deviceId) {
  if (!load().delete(deviceId)) return;
  _dirty = true;
  flushSnapshotsNow();
}
export function _resetForTest() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _map = null; _dirty = false;
  _save = { writes: 0, failures: 0, lastFlushAt: null, lastErrorAt: null, lastErrorCode: null };
}
