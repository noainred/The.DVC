/**
 * storage/authGuard.js — 인증 실패(401) 장비의 주기 수집 정지(v2.528).
 *
 * 사용자 신고(2026-09-16): PowerStore `PS-HG-2`(엣지 HG 위임)가 `인증 실패(401)`.
 * 사용자 선택: "401 이면 수집 중단 + 화면에 표시".
 *
 * ── 왜 멈추는가 ────────────────────────────────────────────────────────────────
 * 인증 실패는 **재시도해도 결과가 같다**. 그런데 주기 수집은 기본 10분마다 같은 자격증명으로
 * 계속 로그인을 시도하므로, 잠금 정책이 있는 배열(PowerStore·Unity 등)에서는 **계정이 잠긴다** —
 * 그러면 콘솔로도 못 들어가 복구가 더 어려워진다. CLAUDE.md 의 '대량 등록 자동 재시도 금지'
 * (`util/bulkRun.js`)와 같은 이유이고, 여기는 그 규칙이 빠져 있던 자리다.
 *
 * ── 반드시 지킬 것 ─────────────────────────────────────────────────────────────
 * 1. **조용히 멈추지 않는다.** 정지 사실·시각·사유를 스냅샷(`extra.authStopped`)에 실어 화면이
 *    말한다. 말없이 멈추면 사용자는 '수집이 되는 줄' 안다 — 이 기능이 만들 수 있는 최악의 거짓이다.
 * 2. **자격증명이 바뀌면 자동으로 재개한다**(`credHash` 비교). 비밀번호를 고치는 것이 곧 조치이고,
 *    그 뒤에도 사람이 버튼을 한 번 더 눌러야 한다면 '고쳤는데 왜 안 되지' 가 된다.
 * 3. **수동 실행('지금 수집'·연결 테스트)은 막지 않는다.** 사람이 1회 누르는 것은 잠금 위험이
 *    없고, 고쳤는지 확인할 길을 없애면 안 된다. 막는 것은 **주기 수집뿐**이다.
 * 4. **401/403 만 대상**이다. 타임아웃·연결 실패·형식 오류는 재시도로 해결되는 일이 많으므로
 *    멈추지 않는다(멈추면 일시적 네트워크 장애가 수집을 영구 정지시킨다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { credFingerprintParts } from '../util/credFingerprint.js';

const FILE = path.join(config.configDir, 'storage-auth-stops.json');

/**
 * 스냅샷이 '인증 실패' 인가. 수집기들이 던지는 문구는
 * `인증 실패(401) — 계정/비밀번호 확인`(restCommon) 또는 SSH 계열의 인증 거부다.
 * ⚠ 넓게 잡지 말 것 — '연결 실패' 까지 포함하면 네트워크 장애가 수집을 영구 정지시킨다.
 */
export function isAuthFailure(snap) {
  if (!snap || snap.ok) return false;
  const texts = [snap.error || '', ...Object.values(snap.sections || {}).map((v) => String(v || ''))];
  return texts.some((t) => /인증 실패|\b401\b|\b403\b|authentication fail|permission denied|invalid (?:user|password|credential)/i.test(t));
}

/** 이 장비 자격증명의 지문 해시 — 바뀌면 자동 재개의 신호다. */
export function credHashOf(dev) {
  const p = credFingerprintParts(dev?.username, dev?.password);
  return `${p.user}:${p.len}:${p.hash}`;
}

/* ── 저장소(캐시 성격) ──────────────────────────────────────────────────────────
   손상되면 `preserveCorrupt` 하지 않고 새로 시작한다 — 재생성 가능한 상태이고, 여기서 원본을
   보존해 봐야 쓸모없는 파일만 쌓인다(util/activityLog.js 와 같은 취급). */
let _mem = null;
function load() {
  if (_mem) return _mem;
  try { _mem = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch { _mem = {}; }
  if (!_mem || typeof _mem !== 'object') _mem = {};
  return _mem;
}
function persist() {
  try { atomicWriteFileSync(FILE, JSON.stringify(_mem || {}, null, 2), { mode: 0o600 }); }
  catch { /* 정지 상태를 못 써도 수집은 계속돼야 한다 */ }
}

/** 정지 기록. 같은 자격증명으로 반복 실패해도 `since` 는 처음 시각을 유지한다. */
export function markAuthStopped(deviceId, dev, reason) {
  const db = load();
  const credHash = credHashOf(dev);
  const prev = db[deviceId];
  db[deviceId] = {
    credHash,
    since: prev && prev.credHash === credHash ? prev.since : Date.now(),
    at: Date.now(),
    attempts: (prev && prev.credHash === credHash ? prev.attempts || 0 : 0) + 1,
    reason: String(reason || '인증 실패').slice(0, 200),
  };
  _mem = db; persist();
  return db[deviceId];
}

/** 성공했거나 사용자가 해제 — 기록 제거. */
export function clearAuthStop(deviceId) {
  const db = load();
  if (!db[deviceId]) return false;
  delete db[deviceId];
  _mem = db; persist();
  return true;
}

/**
 * 주기 수집에서 이 장비를 건너뛸 것인가.
 * @returns {null | {since:number, at:number, attempts:number, reason:string}}
 */
export function authStopFor(dev) {
  if (!dev?.id) return null;
  const rec = load()[dev.id];
  if (!rec) return null;
  // 자격증명이 바뀌었으면 자동 재개(규칙 2) — 기록을 지우고 이번 주기부터 다시 시도한다.
  if (rec.credHash !== credHashOf(dev)) { clearAuthStop(dev.id); return null; }
  return { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason };
}

export function _resetForTest() { _mem = null; try { fs.rmSync(FILE); } catch { /* 없음 */ } }
export function _fileForTest() { return FILE; }
