import { describe, it, expect } from 'vitest';
import { unplacedRows, corpNoteText, physNoteText } from './overviewServerText.js';

const pbc = {
  total: 20, physicalOnly: 9, physicalOnlyUnassigned: 5, physicalOnlyNoDatacenter: 2,
  unplacedByDatacenter: { 'dc-b': 2, 'dc-c': 1 }, datacenterNames: { 'dc-b': '법인B' },
  matchedBy: { datacenter: 3, assigned: 1 }, byVcenterPhysicalOnly: { 'vc-a': 4 },
};

describe('overviewServerText (v2.583)', () => {
  it('미배치 법인 행과 법인 미귀속 행을 만든다 — 합이 미귀속 전체와 같다', () => {
    const rows = unplacedRows(pbc);
    expect(rows.map((r) => r.name)).toEqual(['법인B · vCenter 미지정', 'dc-c · vCenter 미지정', '법인 미귀속']);
    expect(rows.reduce((a, r) => a + r.physOnly, 0)).toBe(pbc.physicalOnlyUnassigned);
    expect(rows.every((r) => r.hosts === null && r.vms === null)).toBe(true);
  });
  it('구버전 서버(필드 없음)면 미귀속 전체를 한 행으로 보인다', () => {
    const rows = unplacedRows({ physicalOnlyUnassigned: 503 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '법인 미귀속', physOnly: 503 });
  });
  it('0 이면 행을 만들지 않는다', () => {
    expect(unplacedRows({ physicalOnlyUnassigned: 0, physicalOnlyNoDatacenter: 0, unplacedByDatacenter: {} })).toEqual([]);
    expect(unplacedRows(null)).toEqual([]);
  });
  it('문구가 귀속 근거와 미배치 개수를 밝힌다', () => {
    const t = corpNoteText(pbc);
    expect(t).toContain('법인(DataCenter)의 vCenter 로 3대');
    expect(t).toContain('관리자 지정으로 1대');
    expect(t).toContain("vCenter 를 정하지 못한 서버 3대");
    expect(t).toContain('법인도 모르는 서버 2대');
    expect(physNoteText(pbc)).toBe('iDRAC 등록 20대 중 가상화 호스트로 확인되지 않은 서버 · vCenter 미지정 3대 · 법인 미귀속 2대');
  });
});
