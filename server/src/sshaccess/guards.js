/**
 * sshaccess/guards.js — 보호 장치 판정(v3.10.0 · 설계 docs/design/ssh-access §8 S10 · S11).
 *  · 두 사람 승인: 상태 파일의 guards.twoPerson(기본 켬). **인증을 끈 설치(AUTH_ENABLED=false)** 에서는 계정이 없어 둘을 가를 수 없으므로 적용하지 않는다.
 *  · 상태 파일을 못 읽으면 켠 것으로 본다(state.getGuards — 엄한 쪽).
 *  · ‘승인해 줄 다른 설정 소유자’ = 유효 소유자 가운데 요청자가 아니고 **실제로 승인 라우트를 통과할 수 있는** 계정(otherOwners):
 *      로컬 계정이면 관리자 역할 · 전체 범위 · 로그인 수단(비밀번호 또는 OTP)이 있을 것 · 데모 아님.
 *      로컬 계정이 아니면 AD 로그인이 켜져 있을 때만 센다(AD 계정일 수 있다 — 모르면 세지 않는다).
 *    예전 판(첫 구현)은 이름만 셌다 — 로그인 수단 없이 시드되는 noainred 와 범위 소유자까지 세어, 소유자가 실제로 한 명인 포탈이 두 사람 승인을 끌 수 없었다(테스트 ⑥-b).
 *    0 명이면 보호 장치를 끄는 요청만 본인 OTP 로 바로 통과시킨다 — 승인할 사람이 없는 설치가 영영 잠기지 않게.
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

/** 이 계정이 두 사람 승인의 승인자가 될 수 있는가(설정 소유자 목록에 있다는 전제). 못 읽으면 false. */
function canApprove(name, users, adOn) {
  const u = users.find((x) => String(x.username || '').toLowerCase() === name.toLowerCase());
  if (!u) return adOn;
  if (u.demo || !ADMIN_ROLES.has(String(u.role || ''))) return false;
  const sc = normalizedScope(u);   // 범위 계정은 소유자 등급 라우트가 403(requireSettingsOwner) — 승인할 수 없다
  if (sc.vcenters.length || sc.regions.length) return false;
  return !!(u.passwordHash || u.totpEnabled);
}
/** 유효 소유자 목록에서 요청자(같은 신원 — AD 별칭 포함)를 뺀 이름들. 같은 신원의 다른 꼴은 하나로 센다(점검 A2). */
function ownersBut(by) {
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  const me = identityKey(by);
  const seen = new Set(); const out = [];
  for (const raw of owners) {
    const x = String(raw || '').trim(); const id = identityKey(x);
    if (!x || !id || id === me || seen.has(id)) continue;
    seen.add(id); out.push(x);
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
/**
 * 목록에 이름이 있는 다른 소유자(지금 승인할 수 있든 없든) — 시드 계정(noainred)이 로그인 수단이 없으면 뺀다.
 * ‘승인자 0명이면 본인 OTP 로 끄기’ 지름길은 **이 수도 0** 일 때만 연다(점검 A1): 다른 소유자를 강등 · 범위 지정 · 차단 · 삭제해 ‘승인 불가’ 로 만든 뒤
 * 바로 끄는 길을 막는다 — 그 계정을 소유자 목록에서 빼는 것(소유자 + OTP · 감사 · 별도 기록)이 먼저여야 한다. 못 읽으면 ‘있다’ 고 본다(엄한 쪽).
 */
export function listedOtherOwners(by) {
  let users = [];
  try { users = loadUsers() || []; } catch { return ['(계정 파일을 읽지 못함)']; }
  return ownersBut(by).filter((x) => {
    if (identityKey(x) !== 'noainred') return true;
    const u = users.find((v) => identityKey(v.username) === 'noainred');
    return !!(u && (u.passwordHash || u.totpEnabled));
  });
}
/** 7b 등 다른 화면의 키 변경 라우트가 쓰는 거절 — 두 사람 승인이 켜져 있으면 승인 절차가 있는 화면으로 보낸다(우회 금지). */
export function twoPersonRedirect() {
  return twoPersonOn() ? { ok: false, code: 'two-person-required', status: 409,
    reason: '두 사람 승인이 켜져 있어 여기서는 키를 등록 · 교체 · 삭제할 수 없습니다 — 설정 › 보안 › SSH 공용 접속에서 요청하면 다른 설정 소유자의 승인 뒤 실행됩니다.' } : null;
}
