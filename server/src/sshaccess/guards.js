/**
 * sshaccess/guards.js — 보호 장치 판정(v3.10.0 · 설계 docs/design/ssh-access §8 S10 · S11).
 *  · 두 사람 승인: 상태 파일의 guards.twoPerson(기본 켬). **인증을 끈 설치(AUTH_ENABLED=false)** 에서는 계정이 없어 둘을 가를 수 없으므로 적용하지 않는다.
 *  · 상태 파일을 못 읽으면 켠 것으로 본다(state.getGuards — 엄한 쪽).
 *  · ‘승인해 줄 다른 설정 소유자’ = 유효 소유자 목록에서 요청자를 뺀 것(이름 비교는 소문자). 0 명이면 보호 장치를 끄는 요청만 본인 OTP 로 바로 통과시킨다 —
 *    승인할 사람이 없는 설치가 영영 잠기지 않게(그 밖의 요청은 승인 대기로 남고, 화면이 ‘승인할 사람이 없다’ 고 말한다).
 */
import { config } from '../config.js';
import { loadSessionSecurity } from '../security/securitySettings.js';
import * as ST from './state.js';

export function twoPersonOn() { return !!config.auth?.enabled && ST.getGuards().twoPerson === true; }
export function serverRestrictOn() { return ST.getGuards().serverRestrict === true; }
/** 요청자 말고 승인할 수 있는 설정 소유자 이름들(못 읽으면 빈 목록). */
export function otherOwners(by) {
  let owners = [];
  try { owners = loadSessionSecurity().settingsOwners || []; } catch { owners = []; }
  const me = String(by || '').trim().toLowerCase();
  return [...new Set(owners.map((x) => String(x || '').trim()).filter(Boolean))].filter((x) => x.toLowerCase() !== me);
}
/** 7b 등 다른 화면의 키 변경 라우트가 쓰는 거절 — 두 사람 승인이 켜져 있으면 승인 절차가 있는 화면으로 보낸다(우회 금지). */
export function twoPersonRedirect() {
  return twoPersonOn() ? { ok: false, code: 'two-person-required', status: 409,
    reason: '두 사람 승인이 켜져 있어 여기서는 키를 등록 · 교체 · 삭제할 수 없습니다 — 설정 › 보안 › SSH 공용 접속에서 요청하면 다른 설정 소유자의 승인 뒤 실행됩니다.' } : null;
}
