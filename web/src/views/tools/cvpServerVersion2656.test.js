// v2.656: 장비가 속한 CVP 서버의 버전 — 장비 EOS 와 다른 축이다.
import { describe, it, expect } from 'vitest';
import { cvpServerVersionMap, cvpServerVersionOf, cvpVersionChips, cvpVersionLabel } from './cvpOverviewText.js';

const servers = [
  { id: 'a', status: { cvpVersion: '2023.1.1' } },
  { id: 'b', status: { cvpVersion: ' 2024.2.0 ' } },
  { id: 'c', status: {} },
  null, 'x',
];
describe('CVP 서버 버전', () => {
  const m = cvpServerVersionMap(servers);
  it('cvpId 로 붙이고 못 읽은 서버는 빈 값', () => {
    expect(cvpServerVersionOf({ cvpId: 'a' }, m)).toBe('2023.1.1');
    expect(cvpServerVersionOf({ cvpId: 'b' }, m)).toBe('2024.2.0');
    expect(cvpServerVersionOf({ cvpId: 'c' }, m)).toBe('');
    expect(cvpServerVersionOf({ cvpId: 'zz' }, m)).toBe('');
    expect(cvpServerVersionOf(null, m)).toBe('');
    expect(cvpVersionLabel('')).toBe('(CVP 버전 미상)');
  });
  it('칩은 새 버전 먼저 · 미상 마지막 · 한 종류뿐이면 칩을 만들지 않는다', () => {
    const rows = [{ cvpId: 'a' }, { cvpId: 'b' }, { cvpId: 'b' }, { cvpId: 'c' }];
    expect(cvpVersionChips(rows, m)).toEqual([{ ver: '2024.2.0', count: 2 }, { ver: '2023.1.1', count: 1 }, { ver: '', count: 1 }]);
    expect(cvpVersionChips([{ cvpId: 'a' }, { cvpId: 'a' }], m)).toEqual([]);
  });
});

import { faultEventText, closeReasonText } from './cvpText.js';
describe('v2.656 no-link 닫힘 문구', () => {
  it('고쳐졌다고 말하지 않는다', () => {
    expect(closeReasonText('no-link')).toMatch(/링크 없음 — 판정 대상 아님/);
    expect(faultEventText({ event: 'close', closeReason: 'no-link' })).toMatch(/고쳐졌다는 뜻이 아닙니다/);
  });
});
