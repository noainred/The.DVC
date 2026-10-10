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
import { getDataSource } from '../runtime-settings.js';   // mock 판정(sanswitch/store.js 와 같은 판정 — 순환을 피해 직접 읽는다)
import { registerExitFlush } from '../util/exitFlush.js';

const FILE = path.join(config.configDir, 'storage-latest.json');
let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 손상 시 다음 폴링이 재구축(preserveCorrupt 불필요)
  return _map;
}
function writeFile() { atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }

/*
 * v2.733(감사 C4-03): **장비마다 파일 전체를 다시 쓰지 않는다** — 주기 끝 1회 flush + 안전 상한 타이머 + 종료 flush.
 *   v2.732 B6-02 의 SAN 판(sanswitch/store.js)과 같은 구조다. 예전에는 putSnapshot 마다 전 장비를 JSON.stringify + 원자 쓰기
 *   (fsync 2회)했다 — 스냅샷이 Unity CLI 원문·Isilon 노드 목록을 담아 장비 수에 비례해 커지므로 한 주기 합이 O(N²)
 *   (재현: 80대 1.37MB · 주기 합 0.6~0.8초, 200대 3.2~3.5초).
 *   ⚠⚠ 더 나쁜 것은 **실패 모드**였다: 쓰기가 실패하면(ENOSPC·EROFS·EIO) putSnapshot 이 던져 그 장비의 용량 적재·인증 정지 처리·
 *   작업 로그가 건너뛰어지고, poolRun 이 주기 전체를 거부해 폴러 상태가 갱신되지 않았으며, adaptiveTimer 가 그 오류를 로그 없이
 *   삼켰다(재현: 17대 중 3대만 시도 · 작업 로그 0건 · 상태 at:0 · 콘솔 0줄). 이제 put 은 메모리 갱신 + 표시(dirty)만 하고 던지지
 *   않는다. 파일 쓰기 실패는 **수집을 멈추지 않는다** — 메모리 스냅샷(화면·엣지 push 의 원천)은 이미 새 값이고, 디스크 기록은
 *   대기분을 유지한 채 안전 타이머로 다시 시도한다. 실패는 콘솔과 상태(`snapshotStoreStatus` → 폴러 상태 `snapshotSave`)에 남긴다.
 *   · 첫 dirty put 에서 안전 타이머를 한 번 무장하고 다음 put 이 미루지 않는다(디바운스가 아니다 — 낡음 상한이 고정된다).
 *     mock 은 2초다(I/O 없는 데모라 완료가 몰린다). 파일 형식은 그대로(되돌림 설치 호환).
 *   · 같은 사유의 연속 실패는 콘솔을 덮지 않는다 — 실패가 시작될 때·사유가 바뀔 때·10분마다 한 줄, 복구되면 한 줄.
 *     상태 카운터(failures)는 매번 센다.
 *   ⚠ 비정상 종료(kill -9·정전) 때는 마지막 flush 뒤의 스냅샷을 잃는다 — 캐시 성격이라 다음 폴링이 재구축한다(정직 기록).
 *   ⚠ 삭제(dropSnapshot)는 즉시 쓴다 — 지운 장비가 재시작 뒤 유령으로 되살아나지 않게. 그 쓰기도 실패하면 던지지 않고
 *     같은 규칙(상태·콘솔·재시도)을 탄다 — 예전에는 던져 장비 삭제 라우트가 500 이 됐다.
 */
export const SNAPSHOT_FLUSH_MAX_MS = 30_000;
const MOCK_FLUSH_MS = 2_000;
const WARN_REPEAT_MS = 600_000;
let _dirty = false;
let _flushTimer = null;
let _save = { writes: 0, failures: 0, lastFlushAt: null, lastErrorAt: null, lastErrorCode: null };
let _streak = 0;          // 연속 실패 횟수(복구 줄과 반복 억제에 쓴다)
let _warnedAt = 0;
let _warnedCode = null;
const isMock = () => { try { return getDataSource() === 'mock'; } catch { return false; } };

function armFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flushSnapshotsNow(); }, isMock() ? MOCK_FLUSH_MS : SNAPSHOT_FLUSH_MAX_MS);
  _flushTimer.unref?.();
}

/**
 * 대기 중인 변경을 지금 파일에 쓴다(바뀐 것이 없으면 쓰지 않는다). 폴러가 주기 끝·단건 수집 끝에 부른다.
 * **던지지 않는다** — 실패는 콘솔에 남기고 상태(`snapshotStoreStatus`)에 싣고, dirty 를 유지한 채 타이머를 다시 건다.
 * @returns {{ok:boolean, wrote:boolean, error?:string}}
 */
export function flushSnapshotsNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_dirty) return { ok: true, wrote: false };
  try {
    writeFile();
    _dirty = false;
    _save = { ..._save, writes: _save.writes + 1, lastFlushAt: Date.now() };
    if (_streak > 0) {
      console.log(`[storage] 스냅샷 저장 복구 — 실패 ${_streak}회 뒤 파일에 기록했습니다`);
      _streak = 0; _warnedCode = null; _warnedAt = 0;
    }
    return { ok: true, wrote: true };
  } catch (e) {
    const now = Date.now();
    const code = String(e?.code || 'error');
    _save = { ..._save, failures: _save.failures + 1, lastErrorAt: now, lastErrorCode: code };
    _streak += 1;
    if (_streak === 1 || code !== _warnedCode || now - _warnedAt >= WARN_REPEAT_MS) {
      _warnedAt = now; _warnedCode = code;
      console.warn(`[storage] 스냅샷 저장 실패(${code}): ${e?.message || e} — 수집은 계속하고 다음 저장 때 다시 씁니다`
        + `(연속 실패 ${_streak}회 · 같은 사유는 10분에 한 번만 적습니다)`);
    }
    armFlush();
    return { ok: false, wrote: false, error: e?.message || String(e) };
  }
}
/** 저장 상태(파일 경로·오류 원문은 싣지 않는다 — 오류 코드만). */
export function snapshotStoreStatus() { return { pending: _dirty, ..._save }; }

registerExitFlush('storage-latest', () => {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_dirty) { writeFile(); _dirty = false; }
});
export function putSnapshot(snap) { load().set(snap.deviceId, snap); _dirty = true; armFlush(); }
export function localSnapshots() { return [...load().values()]; }
export function dropSnapshot(deviceId) {
  if (!load().delete(deviceId)) return;
  _dirty = true;
  flushSnapshotsNow();
}
export function _resetForTest() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _map = null; _dirty = false;
  _save = { writes: 0, failures: 0, lastFlushAt: null, lastErrorAt: null, lastErrorCode: null };
  _streak = 0; _warnedAt = 0; _warnedCode = null;
}
