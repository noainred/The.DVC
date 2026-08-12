/**
 * 활성 세션 레지스트리 (v2.280) — '단일 세션 강제'(ID 공유 금지)의 상태 저장소.
 *
 * 왜 필요한가: 이 포탈의 토큰은 무상태(JWT 유사) 서명 토큰이라, 한 계정으로 여러 곳에서 동시에
 * 로그인해도 서버가 알 수 없다(토큰만 유효하면 통과). 계정 하나를 여러 사람이 돌려 쓰는 것을
 * 막으려면 '이 계정의 현재 활성 세션은 하나'라는 서버측 사실을 기록해야 한다. 계정마다 마지막
 * 로그인의 세션 ID(sid)만 저장하고, `resolveTokenUser` 가 토큰의 sid 와 이 값을 대조한다.
 * 새 로그인이 sid 를 덮어쓰면(최신 로그인 우선) 이전 세션의 토큰은 즉시 무효가 된다.
 *
 * 설계 메모
 * - **인메모리 Map + 파일 영속**: `resolveTokenUser` 는 매 요청(및 WS 업그레이드)마다 호출되는
 *   핫패스라 조회는 반드시 O(1) 인메모리여야 한다(파일 read 금지). 변경(로그인) 시에만 원자적
 *   쓰기로 영속화한다 — 재시작해도 활성 세션이 유지돼, 재시작 직후 기존 로그인이 통째로 튕기거나
 *   반대로 강제가 풀리는 일이 없다.
 * - **저장은 원자적**(CLAUDE.md 불변조건): 직접 fs.writeFileSync 금지, atomicWriteFileSync 사용.
 * - sid 자체는 자격증명이 아니다(안다고 접근 불가 — 서명 토큰도 필요). 그래도 세션 식별자라 0600.
 * - 파일 손상/부재는 빈 레지스트리로 시작(안전) — 최악의 결과는 사용자가 한 번 재로그인.
 * - **단일 프로세스 가정**: 인메모리 Map 이 유일한 권위 소스다(현재 배포는 cluster/worker_threads
 *   미사용). 훗날 멀티 워커로 확장하면 워커마다 Map 이 갈라져(load 는 최초 1회만 파일을 읽음)
 *   무효화된 sid 를 다른 워커가 유효로 볼 수 있으니, 그때는 공유 저장소(파일 watch·DB·IPC)로
 *   바꿔야 단일 세션 강제가 유지된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'active-sessions.json');

// username -> { sid, at, ip }
let _map = null;

function load() {
  if (_map) return _map;
  _map = new Map();
  try {
    const obj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (obj && typeof obj === 'object') {
      for (const [u, rec] of Object.entries(obj)) {
        if (rec && typeof rec.sid === 'string' && rec.sid) _map.set(u, { sid: rec.sid, at: Number(rec.at) || 0, ip: String(rec.ip || '') });
      }
    }
  } catch { /* 부재/손상 → 빈 레지스트리(최악: 한 번 재로그인) */ }
  return _map;
}

function persist() {
  // 동기 원자적 쓰기 — 로그인/로그아웃은 드문 이벤트라(요청 핫패스 아님, users.json 영속과 동일
  // 빈도) 디바운스 없이 즉시 쓴다. 재시작 직후에도 활성 세션이 정확히 복원돼 강제가 일관된다.
  try {
    const obj = Object.create(null);
    for (const [u, rec] of load()) obj[u] = rec;
    atomicWriteFileSync(FILE, JSON.stringify(obj), { mode: 0o600 });
  } catch (e) { console.warn(`[sessions] 활성 세션 저장 실패: ${e?.message || e}`); }
}

/** 새 세션 ID — 로그인마다 발급하는 128비트 랜덤 hex. */
export function newSessionId() { return crypto.randomBytes(16).toString('hex'); }

/** 로그인 성공 시 이 계정의 활성 세션을 이 sid 로 교체한다(이전 세션 무효화 — 최신 로그인 우선). */
export function setActiveSession(username, sid, { at = Date.now(), ip = '' } = {}) {
  const u = String(username || '');
  if (!u || !sid) return;
  load().set(u, { sid: String(sid), at, ip: String(ip || '') });
  persist();
}

/**
 * 이 토큰의 sid 가 계정의 '현재 활성 세션' 과 일치하는지. 단일 세션 강제가 켜진 동안만 참조한다.
 * 기록이 없거나(레지스트리에 없음) sid 가 다르면(다른 로그인이 덮어씀·구식 무 sid 토큰) false →
 * 그 토큰은 무효 처리된다(재로그인 필요).
 */
export function isActiveSession(username, sid) {
  if (!sid) return false; // sid 없는(기능 도입 전) 토큰은 강제 대상에서 유효로 인정하지 않는다
  const rec = load().get(String(username || ''));
  return !!rec && rec.sid === sid;
}

/** 로그아웃/계정 폐기 시 활성 세션 제거(다음 로그인이 어차피 덮어쓰지만 명시적 정리용). */
export function clearActiveSession(username) {
  if (load().delete(String(username || ''))) persist();
}

/** 관리/디버그용 — 현재 활성 세션 요약(sid 자체는 노출하지 않는다). */
export function listActiveSessions() {
  return [...load().entries()].map(([username, r]) => ({ username, at: r.at, ip: r.ip }));
}

/** 테스트용 — 인메모리 캐시 리셋(파일에서 다시 로드하게). */
export function _resetSessions() { _map = null; }
