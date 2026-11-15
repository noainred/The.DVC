import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { licenseScopeNote, corpTag } from './licenseScopeText.js';

describe('licenseScopeNote (v2.603 AUTHZ-2603-01)', () => {
  it('범위 계정에서 뺀 NSX·Horizon 을 개수와 함께 말한다', () => {
    const t = licenseScopeNote({ scoped: true, omittedOutOfScope: { nsxManagers: 2, nsxLicenses: 3, horizon: true } });
    expect(t).toContain('NSX 매니저 2개(라이선스 3건)');
    expect(t).toContain('Horizon');
    expect(t).not.toContain('`');
  });
  it('뺀 것이 없거나 전체 범위면 null', () => {
    expect(licenseScopeNote({ scoped: true, omittedOutOfScope: { nsxManagers: 0, nsxLicenses: 0, horizon: false } })).toBeNull();
    expect(licenseScopeNote({ scoped: false, omittedOutOfScope: { nsxManagers: 1, horizon: true } })).toBeNull();
    expect(licenseScopeNote({})).toBeNull();
    expect(licenseScopeNote(null)).toBeNull();
  });
  it('Horizon 만 뺀 경우', () => {
    expect(licenseScopeNote({ scoped: true, omittedOutOfScope: { nsxManagers: 0, nsxLicenses: 0, horizon: true } })).toMatch(/^내 조회 범위 밖이라 제외: Horizon/);
  });
});

describe('v3.12.10 — corpTag: 솔루션 카드의 법인 글자', () => {
  it('‘법인’ 으로 끝나면 그대로 · 아니면 ‘법인 ○○’ · 빈 값은 빈 글자', () => {
    expect(corpTag('Ashburn 법인')).toBe('Ashburn 법인');
    expect(corpTag('KR-Seoul')).toBe('법인 KR-Seoul');
    expect(corpTag('  ')).toBe(''); expect(corpTag(null)).toBe('');
  });
  it('소스 계약 — 카드 머리가 corpTag 를 쓰고 gap · flexWrap', () => {
    const s = fs.readFileSync(new URL('./LicenseTools.jsx', import.meta.url), 'utf8');
    expect(s).toMatch(/ · \{corpTag\(it\.corp\)\}<\/span>/);
    expect(s).not.toMatch(/ · 법인 \{it\.corp\}/);
    expect(s).toMatch(/className="flex between" style=\{\{ marginBottom: 8, gap: '4px 12px', flexWrap: 'wrap' \}\}/);
  });
});
