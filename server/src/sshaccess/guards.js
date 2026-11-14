/**
 * sshaccess/guards.js — 보호 장치 판정(v3.10.0 · 설계 docs/design/ssh-access §8 S10 · S11).
 *  · 두 사람 승인: 상태 파일의 guards.twoPerson(기본 켬). **인증을 끈 설치(AUTH_ENABLED=false)** 에서는 계정이 없어 둘을 가를 수 없으므로 적용하지 않는다.
 *  · 상태 파일을 못 읽으면 켠 것으로 본다(state.getGuards — 엄한 쪽).
 *  · ‘승인해 줄 다른 설정 소유자’ = 유효 소유자 가운데 요청자가 아니고 **실제로 승인 라우트를 통과할 수 있는** 계정(otherOwners):
 *      로컬 계정이면 관리자 역할 · 전체 범위 · 로그인 수단(비밀번호 또는 OTP)이 있을 것 · 데모 아님.
 *      로컬 계정이 아니면 AD 로그인이 켜져 있을 때만 센다(AD 계정일 수 있다 — 모르면 세지 않는다).
 *    예전 판(첫 구현)은 이름만 셌다 — 로그인 수단 없이 시드되는 noainred 와 범위 소유자까지 세어, 소유자가 실제로 한 명인 포탈이 두 사람 승인을 끌 수 없었다(테스트 ⑥-b).
 *    0 명이고 ‘승인할 수 있는 소유자 둘’ 을 본 적이 없는 설치(notePair)만 보호 장치를 끄는 요청을 본인 OTP 로 바로 통과시킨다 — 승인할 사람이 없는 설치가 영영 잠기지 않게.
 */
import { config } from '../config.js';
import { loadSessionSecurity } from '../security/securitySettings.js';
import { loadUsers, normalizedScope } from '../auth/auth.js';
import { loadAdConfig } from '../auth/ad.js';
import * as ST from './state.js';
import { identityKey } from '../approval/store.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
export function twoPersonOn() { return !!config.auth?.enabled && ST.getGuards().twoPerson === true; }
export function serverRestrictOn() { return ST.getGuards().serverRestrict === true; }

/**
 * 이 계정이 두 사람 승인의 승인자가 될 수 있는가(설정 소유자 목록에 있다는 전제). 못 읽으면 false.
 *  · 계정은 **글자 그대로** 찾는다 — `requireSettingsOwner` 가 정확 일치라서(1회차 A1 · A2 — 대소문자 무시 첫 일치가 앞의 viewer `Kim` 을 집어 진짜 승인자 `kim` 을 세지 않았다).
 *  · 대소문자만 다른 로컬 계정이 있는 이름은 AD 이름으로도 세지 않는다(그 철자로는 소유자 게이트를 통과할 세션이 없다).
 *  · 쓰기 범위도 무제한이어야 한다(1회차 A3 — SSH 공용 접속은 전 법인 서버를 바꾼다 · `isFullReadWriteScope` 와 같은 뜻).
 *  · localOnly: 로컬 계정만 센다(‘승인자 둘’ 표지 pairSeen 은 증거가 있는 계정으로만 — AD 이름은 소유자 게이트를 통과한 적이 있는지 알 수 없다).
 */
function canApprove(name, users, adOn, { localOnly = false } = {}) {
  const u = users.find((x) => String(x.username || '') === name) || null;
  if (!u) {
    if (users.some((x) => String(x.username || '').toLowerCase() === name.toLowerCase())) return false;
    return !localOnly && adOn;
  }
  if (u.demo || !ADMIN_ROLES.has(String(u.role || ''))) return false;
  const sc = normalizedScope(u);   // 범위 계정은 소유자 등급 라우트가 403(requireSettingsOwner) — 승인할 수 없다
  if (sc.vcenters.length || sc.regions.length || (sc.writeVcenters || []).length) return false;
  return !!(u.passwordHash || u.totpEnabled);
}
/**
 * 유효 소유자 목록에서 요청자(같은 신원 — AD 별칭 포함 · 점검 A2)를 뺀 이름들. 같은 글자(대소문자 무시)는 하나로 센다.
 * 신원(identityKey)으로 접지 않는다 — `jkim@corp` 와 `jkim@subsidiary` 처럼 다른 두 사람을 한 명으로 세어 혼자 끄던 것(1회차 A2).
 * (요청자와 같은 신원 글자인 다른 사람은 승인자에서 빠진다 — 자기 승인 판정과 같은 규칙. 막히는 쪽이라 안전하다.)
 */
function ownersBut(by) {
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  const me = by ? identityKey(by) : '';
  const seen = new Set(); const out = [];
  for (const raw of owners) {
    const x = String(raw || '').trim(); const lcx = x.toLowerCase();
    if (!x || (me && identityKey(x) === me) || seen.has(lcx)) continue;
    seen.add(lcx); out.push(x);
  }
  return out;
}
/** 요청자 말고 승인할 수 있는 설정 소유자 이름들(못 읽으면 빈 목록 — 승인자가 없다고 본다). */
export function otherOwners(by) {
  let users = []; let adOn = false;
  try { users = loadUsers() || []; } catch { return []; }
  try { const ad = loadAdConfig(); adOn = !!(ad && ad.enabled && ad.url); } catch { adOn = false; }
  return ownersBut(by).filter((x) => canApprove(x, users, adOn));
}
/** 승인할 수 있는 설정 소유자 전부(요청자 구분 없이 · 같은 신원은 하나로). 못 읽으면 빈 목록. */
export function approverNames() {
  let users = []; let adOn = false;
  try { users = loadUsers() || []; } catch { return []; }
  try { const ad = loadAdConfig(); adOn = !!(ad && ad.enabled && ad.url); } catch { adOn = false; }
  return ownersBut('').filter((x) => canApprove(x, users, adOn, { localOnly: true }));
}
/**
 * 승인할 수 있는 소유자가 둘 이상이면 상태 파일에 ‘쌍을 봤다’(pairSeen)를 세운다 — 기동 때 · 화면 · 요청 · 주기 점검에서 부른다.
 * ‘승인자 0명이면 본인 OTP 로 끄기’ 지름길은 **pairSeen 이 아닐 때만** 연다(반증 R3 — 목록 기준(listed)이었던 첫 수정은 다른 소유자를 목록에서 빼면
 * 혼자 끌 수 있었고(R3), 거꾸로 화면에서 뺄 수 없는 파일 · 중앙 배포 소유자가 있으면 영영 잠겼다(R4)). 소유자가 실제로 한 명인 설치는 계속 혼자 끌 수 있다.
 * 한계: 기동 전 · 첫 관측 전에 다른 소유자를 승인 불가로 만든 경우는 막지 못한다(기동 때 바로 본다).
 */
export function notePair({ by = '' } = {}) {
  try {
    const g = ST.getGuards();
    if (g.unreadable || g.pairSeen) return;
    if (approverNames().length >= 2) ST.markPairSeen({ by });
  } catch { /* 관측 실패는 판정을 바꾸지 않는다(pairSeen 은 엄한 쪽으로만 움직인다) */ }
}
/** 7b 등 다른 화면의 키 변경 라우트가 쓰는 거절 — 두 사람 승인이 켜져 있으면 승인 절차가 있는 화면으로 보낸다(우회 금지). */
export function twoPersonRedirect() {
  return twoPersonOn() ? { ok: false, code: 'two-person-required', status: 409,
    reason: '두 사람 승인이 켜져 있어 여기서는 키를 등록 · 교체 · 삭제할 수 없습니다 — 설정 › 보안 › SSH 공용 접속에서 요청하면 다른 설정 소유자의 승인 뒤 실행됩니다. 승인할 다른 소유자가 없으면 그 화면의 보호 장치에서 두 사람 승인을 끄거나(소유자가 한 명뿐인 설치) 승인할 소유자를 세우세요.' } : null;
}
