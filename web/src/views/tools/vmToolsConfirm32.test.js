// 전체 점검 32회차 F3: Tools 업그레이드 확인 문구는 실제로 보낼 대수로 묻는다(앞 2,000개만 보내면서 'VM N대' 라고 묻지 않는다).
import { describe, it, expect } from 'vitest';
import { vmToolsConfirmText } from './VmInfoTools.jsx';

describe('vmToolsConfirmText', () => {
  it('보낼 대수 · 상한 · 뺀 대수를 밝힌다', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `vc:vm-${i}`);
    const t = vmToolsConfirmText({ version: '12352', count: 2600, upgradable: 2288, ids, idsTruncated: true });
    expect(t).toContain('켜진 VM 2,000대');
    expect(t).toContain('대상 2,288대 중 처음 2,000대');
    expect(t).toContain('꺼진 VM · 템플릿 312대');
  });
  it('보낼 VM 이 없거나 미수집 행이면 null(버튼 잠금)', () => {
    expect(vmToolsConfirmText({ version: '12352', count: 3, upgradable: 0, ids: [] })).toBeNull();
    expect(vmToolsConfirmText({ version: '(수집 안 됨)', unread: true, count: 3, ids: ['x'] })).toBeNull();
  });
  it('잘리지 않았고 전부 켜진 VM 이면 덧붙임 없이', () => {
    const t = vmToolsConfirmText({ version: '11365', count: 2, upgradable: 2, ids: ['a', 'b'] });
    expect(t).toBe('Tools 버전 ‘11365’ 의 켜진 VM 2대를 업그레이드할까요? (재부팅이 필요할 수 있음)');
  });
});
