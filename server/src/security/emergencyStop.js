/**
 * 긴급중단(Emergency Stop) — 2인 승인(관리자 2명 OTP)으로만 켜고/끄는 전역 수집 정지 스위치.
 *
 * 켜지면 모든 백그라운드 수집(메인 vCenter 폴링·GPU 게스트 수집·iDRAC 전력 폴링 등)이
 * 다음 주기부터 즉시 멈춘다(이미 수집된 스냅샷은 그대로 유지). 상태는 CONFIG_DIR/
 * emergency-stop.json(0600)에 영속화돼 재시작 후에도 유지된다.
 *
 * 2인 승인(two-person rule)은 라우트(admin.js)에서 검증하고, 이 모듈은 상태만 관리한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'emergency-stop.json');

let state = null;

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (p && typeof p === 'object') { state = p; return state; }
    }
  } catch { /* fall through to default */ }
  state = { active: false, by: [], at: null };
  return state;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  } catch (e) { console.error(`[emergency-stop] persist 실패: ${e.message}`); }
}

/** 수집을 멈춰야 하는가? 폴러들이 매 주기 호출. */
export function isStopped() { return !!load().active; }

/** 현재 상태(웹/배지용). */
export function getEmergencyStatus() {
  const s = load();
  return { active: !!s.active, by: s.by || [], at: s.at || null };
}

/**
 * 긴급중단 토글. approvers = 승인한 관리자 2명의 username 배열(감사 기록용).
 * 검증(2인·관리자·OTP)은 호출 측에서 끝낸 상태로 들어온다.
 */
export function setEmergencyStop(active, approvers = []) {
  state = { active: !!active, by: active ? approvers.slice(0, 2) : [], at: Date.now(), lastBy: approvers.slice(0, 2), lastAt: Date.now() };
  persist();
  console.warn(`[emergency-stop] ${active ? '긴급중단 ON' : '해제'} — 승인: ${approvers.join(' + ')}`);
  return getEmergencyStatus();
}
