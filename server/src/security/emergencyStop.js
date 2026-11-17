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
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { readJsonFile, nowMs, READ_RETRY_MS } from '../util/jsonFileRead.js'; // 88회차 F2: 읽기 오류 ≠ 손상(판정은 readJsonFile 하나)
import { isAdminTier } from '../auth/roles.js';

const FILE = path.join(config.configDir, 'emergency-stop.json');

let state = null;
/*
 * 88회차 F2(재현 — EIO 한 번): 예전 load 는 읽기 오류(EACCES · EIO · EISDIR)도 손상과 같은 catch 로 받아 **원본을 .corrupt 로 옮기고**
 *   비활성으로 캐시했다 — 2인 승인으로 켠 긴급중단이 기동 때의 읽기 오류 한 번으로 풀렸고, 디스크가 돌아와도 · 재시작해도 원본이 옆으로
 *   치워져 있어 **다시 켜지지 않았다**(2인 승인 없이 해제된 셈). 이제(결정 78 ① 과 같은 규칙) 읽기 오류는 원본을 그대로 두고 · 캐시하지 않고
 *   30초마다 다시 읽는다(읽히는 순간 저장된 상태가 그대로 적용된다). 그동안의 값은 **멈춤**(91회차 fail-closed — 아래)이고 상태에 readError 를 싣는다.
 *   손상은 예전 그대로(보존 + 비활성 + 경고).
 */
//   공용 makeJsonFileReader 를 쓰지 않는 이유: 그 경고 문구는 '그동안 저장은 거절' 인데, 긴급중단은 읽기 오류 중에도 2인 승인으로 켜고 끌 수 있어야 한다
//   (안전 스위치를 파일 권한 때문에 막지 않는다 — 새 2인 결정이 읽지 못한 옛 파일을 덮는 것이 맞다).
let _readErr = null;
let _retryAt = 0;
export function _resetEmergencyStopForTest() { state = null; _readErr = null; _retryAt = 0; }

function load() {
  if (state) return state;
  // 91회차(88회차 결정 ③ — 권장안): 읽기 오류 동안은 **멈춤 쪽**(fail-closed). 마지막으로 읽은 값은 위 캐시(state)가 그대로 지킨다 —
  //   이 갈래는 이 프로세스가 한 번도 읽지 못했을 때(기동 때 읽기 오류)만 온다. 예전(88)은 비활성으로 보았는데, 2인 승인으로 켠 긴급중단이
  //   파일 권한 하나로 수집 · 상태 변경을 다시 돌리는 것은 이 스위치의 목적(온도 · 재난 · PM 중 장비를 건드리지 않음)에 반한다. 상태에 readError 를 싣고
  //   화면이 '읽지 못해 멈춤' 을 말한다. 해제는 파일을 고치거나(30초 안 다시 읽음) 2인 승인 해제(새 상태가 기준).
  const closedWhileUnreadable = () => ({ active: true, by: [], at: null, failClosed: true });
  if (_readErr && nowMs() < _retryAt) return closedWhileUnreadable();
  const r = readJsonFile(FILE, { parse: (t) => JSON.parse(t) });
  if (r.kind === 'read-error') {
    const code = String(r.error?.code || 'read-error').slice(0, 32);
    if (!_readErr) console.error(`[emergency-stop] 상태 파일을 읽지 못했습니다(${code}) — 손상이 아니라 원본은 그대로 둡니다. 읽힐 때까지 **긴급중단(멈춤)으로 보고** ${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽습니다(파일 소유자 · 권한 확인 — 91회차 fail-closed).`);
    _readErr = { at: _readErr?.at || Date.now(), code };
    _retryAt = nowMs() + READ_RETRY_MS;
    return closedWhileUnreadable();   // 캐시하지 않는다 — 간격 뒤 다시 읽는다
  }
  if (_readErr) console.warn('[emergency-stop] 상태 파일을 다시 읽었습니다(읽기 오류 풀림)');
  _readErr = null;
  if (r.kind === 'ok' && r.value && typeof r.value === 'object') { state = r.value; return state; }
  if (r.kind === 'corrupt') console.error('[emergency-stop] 상태 파일 손상 — 기본(비활성)으로 시작합니다. 긴급중단이 필요하면 다시 누르세요.'); // v2.479: 손상 시 조용한 해제 금지(보존+경고) — 보존은 readJsonFile
  state = { active: false, by: [], at: null };
  return state;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
  } catch (e) { console.error(`[emergency-stop] persist 실패: ${e.message}`); }
}

/** 수집을 멈춰야 하는가? 폴러들이 매 주기 호출. */
export function isStopped() { return !!load().active; }

/** 현재 상태(웹/배지용). */
export function getEmergencyStatus() {
  const s = load();
  return { active: !!s.active, by: s.by || [], at: s.at || null, ...(_readErr ? { readError: { at: _readErr.at, code: _readErr.code, failClosed: !!s.failClosed } } : {}) };
}

/**
 * 긴급중단 토글. approvers = 승인한 관리자 2명의 username 배열(감사 기록용).
 * 검증(2인·관리자·OTP)은 호출 측에서 끝낸 상태로 들어온다.
 */
export function setEmergencyStop(active, approvers = []) {
  state = { active: !!active, by: active ? approvers.slice(0, 2) : [], at: Date.now(), lastBy: approvers.slice(0, 2), lastAt: Date.now() };
  _readErr = null; _retryAt = 0;   // 88회차 F2: 2인 승인으로 정한 새 상태가 기준이다(읽지 못한 옛 파일을 덮는 것이 맞다)
  persist();
  console.warn(`[emergency-stop] ${active ? '긴급중단 ON' : '해제'} — 승인: ${approvers.join(' + ')}`);
  return getEmergencyStatus();
}

/**
 * 긴급중단 승인자 역할 판정(v2.674) — 저장 레코드(getUser)의 역할을 본다. super_admin(v2.643, noainred)도 관리자 등급이다.
 * 예전 라우트의 '!== admin' 비교는 super_admin 을 '관리자가 아닙니다' 로 거부했다(요청 문맥은 admin 으로 접히지만 저장값은 그대로다).
 * @returns {null|'missing'|'not-admin'}
 */
export function approverRoleIssue(u) {
  if (!u) return 'missing';
  return isAdminTier(String(u.role || '')) ? null : 'not-admin';
}
