/**
 * 2026-10-09 검토 S-03 — AD 설정 화면의 보호 방식 판정·미리 알림(서버 auth/ad.js adTransportMode·adSaveIssue 와 같은 규칙).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { adModeOf, plainSaveBlocked, adWarningsText, AD_TRANSPORT_WARN, AD_MODE_LABEL } from './adTransportText.js';

describe('adModeOf', () => {
  it('스킴 + StartTLS', () => {
    expect(adModeOf({ url: 'ldaps://dc:636' })).toBe('ldaps');
    expect(adModeOf({ url: 'LDAP://dc:389', startTls: true })).toBe('starttls');
    expect(adModeOf({ url: 'ldap://dc:389' })).toBe('plain');
    expect(adModeOf({ url: 'ldap://dc:389', startTls: 'true' })).toBe('plain', '불리언 true 만 켠 것으로 본다(서버와 같다)');
    expect(adModeOf({ url: '' })).toBe('none');
    for (const m of ['ldaps', 'starttls', 'plain', 'none']) expect(AD_MODE_LABEL[m]).toBeTruthy();
  });
});

describe('plainSaveBlocked — 서버가 400 으로 거부할 조건을 저장 전에 말한다', () => {
  const saved = { url: 'ldap://dc01:389', enabled: true };
  it('이미 저장된 평문 설정의 다른 칸 수정은 막지 않는다', () => {
    expect(plainSaveBlocked({ ...saved, adminGroup: 'X' }, saved)).toBe(false);
  });
  it('URL 변경·새로 켜기·StartTLS 끄기는 막힌다', () => {
    expect(plainSaveBlocked({ ...saved, url: 'ldap://dc02:389' }, saved)).toBe(true);
    expect(plainSaveBlocked({ ...saved, enabled: true }, { ...saved, enabled: false })).toBe(true);
    expect(plainSaveBlocked({ url: 'ldap://dc01:389', startTls: false }, { url: 'ldap://dc01:389', startTls: true })).toBe(true);
  });
  it('LDAPS·StartTLS 는 막지 않는다', () => {
    expect(plainSaveBlocked({ url: 'ldaps://dc02:636', enabled: true }, saved)).toBe(false);
    expect(plainSaveBlocked({ url: 'ldap://dc02:389', startTls: true, enabled: true }, saved)).toBe(false);
  });
});

describe('경고 문구', () => {
  it('서버 경고 코드와 1:1 — 모르는 코드는 숨기지 않는다', () => {
    expect(Object.keys(AD_TRANSPORT_WARN).sort()).toEqual(['ca-invalid', 'plain-ldap', 'tls-verify-off']);
    expect(adWarningsText(['plain-ldap'])[0]).toMatch(/ldaps:\/\//);
    expect(adWarningsText(['zzz'])[0]).toMatch(/zzz/);
    expect(adWarningsText(null)).toEqual([]);
  });
  it('서버 경고 코드 목록(auth/ad.js adTransportStatus)과 같다', () => {
    const srv = fs.readFileSync(new URL('../../../server/src/auth/ad.js', import.meta.url), 'utf8');
    const fn = srv.slice(srv.indexOf('export function adTransportStatus'), srv.indexOf('/** 역할 결정에 영향을'));
    const codes = [...fn.matchAll(/warnings\.push\('([a-z-]+)'\)/g)].map((m) => m[1]).sort();
    expect(codes).toEqual(Object.keys(AD_TRANSPORT_WARN).sort());
  });
  it('화면 문구에 백틱이 없다(BoldText 는 **강조** 만 해석)', () => {
    for (const t of Object.values(AD_TRANSPORT_WARN)) expect(t).not.toMatch(/`/);
  });
});
