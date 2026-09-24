import { describe, it, expect } from 'vitest';
import { licenseScopeNote } from './licenseScopeText.js';

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
