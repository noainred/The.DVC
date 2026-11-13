import { describe, it, expect } from 'vitest';
import { autoOptionText, matchNote, saveText } from './collectorDcText.js';

const dcs = [{ id: 'oc2', name: 'OC2 본사' }, { id: 'nj', name: 'NJ' }];
describe('collectorDcText', () => {
  it('자동 선택지 — 이름 맞춤 결과가 있으면 그 법인 이름', () => {
    expect(autoOptionText({ id: 'oc2', via: 'name' }, dcs)).toBe('자동 — 이름 맞춤: OC2 본사');
    expect(autoOptionText({ id: 'nj', via: 'manual' }, dcs)).toBe('자동 — 맞는 법인 없음');
    expect(autoOptionText({ id: '', via: '' }, dcs)).toBe('자동 — 맞는 법인 없음');
    expect(autoOptionText(null, dcs)).toBe('자동 — 맞는 법인 없음');
  });
  it('상태 한 줄 — 사용자 매칭 · 지워진 법인 · 이름 맞춤 · 모름', () => {
    expect(matchNote({ id: 'nj', via: 'manual' }, dcs)).toEqual({ tone: 'ok', text: '사용자 매칭 → NJ' });
    expect(matchNote({ id: 'oc2', via: 'name', stale: true }, dcs).tone).toBe('warn');
    expect(matchNote({ id: 'oc2', via: 'name' }, dcs).text).toBe('이름 맞춤 → OC2 본사');
    expect(matchNote({ id: '', via: '' }, dcs).text).toMatch(/법인 미지정/);
  });
  it('저장 문구 — 실패 본문은 던진다', () => {
    expect(saveText({ ok: true, changed: true, collector: { datacenterId: 'nj' } }, 'pl-edge', dcs)).toMatch(/'pl-edge' 를 법인 'NJ' 로 매칭/);
    expect(saveText({ ok: true, changed: true, collector: {} }, 'pl-edge', dcs)).toMatch(/해제/);
    expect(saveText({ ok: true, changed: false }, 'x', dcs)).toMatch(/이미 같은/);
    expect(() => saveText({ ok: false, reason: '없는 법인' }, 'x', dcs)).toThrow('없는 법인');
  });
});

import { selectValue, matchSortText } from './collectorDcText.js';
describe('collectorDcText — 선택 값 · 정렬(v2.972 반증 F6)', () => {
  it('지워진 법인 매칭은 그 id 를 값으로 — 자동을 고르면 change 가 나서 해제된다', () => {
    expect(selectValue({ id: 'nj', via: 'manual' })).toBe('nj');
    expect(selectValue({ id: 'nj', via: 'name', stale: true, picked: 'pl' })).toBe('pl');
    expect(selectValue({ id: 'nj', via: 'name' })).toBe('');
    expect(selectValue(null)).toBe('');
  });
  it('정렬은 지금 쓰이는 법인 이름', () => {
    expect(matchSortText({ id: 'oc2', via: 'name' }, dcs)).toBe('OC2 본사');
    expect(matchSortText({ id: '', via: '' }, dcs)).toBe('');
  });
});

import { conflictChoices, assignFailText } from './collectorDcText.js';
describe('collectorDcText — 불일치 선택지(v2.986 · 반증 D1 · D3 · D6)', () => {
  const m = { id: 'oc2', via: 'name', conflicts: [{ vcenterId: 'vc-1', vcenterName: 'vcenter-1', datacenterId: 'nj', datacenterName: 'NJ', serverDatacenterId: 'pl', serverDatacenterName: 'Poland', servers: 3 }] };
  it('A 는 서버 분석이 실제로 쓰는 법인(serverDatacenterId) — 수집 서버 수준 매칭(oc2)이 아니다', () => {
    const [c] = conflictChoices(m, dcs);
    expect(c.text).toMatch(/서버 3대: 서버 분석은 ‘Poland’, 전력 분석 · 통합 인벤토리는 vCenter ‘vcenter-1\(vc-1\)’ 의 할당 법인 ‘NJ’/);
    expect(c.toCollector).toEqual({ label: '수집 서버를 ‘NJ’ 로 매칭', datacenterId: 'nj' });
    expect(c.toVcenter.datacenterId).toBe('pl'); expect(c.toVcenter.vcenterId).toBe('vc-1');
    expect(c.toVcenter.confirm).toMatch(/vCenter ‘vcenter-1\(vc-1\)’ 의 법인 할당을 ‘NJ’ → ‘Poland’/);
  });
  it('불일치가 없으면 빈 목록', () => {
    expect(conflictChoices({ id: 'oc2', via: 'name' }, dcs)).toEqual([]);
    expect(conflictChoices(null, dcs)).toEqual([]);
  });
  it('할당 저장 응답 — ok 여도 바뀐 것이 없으면 실패 문구', () => {
    expect(assignFailText({ ok: true, changed: 1 })).toBe(null);
    expect(assignFailText({ ok: true, changed: 0, unknownDatacenter: 1 })).toMatch(/없는 법인/);
    expect(assignFailText({ ok: true, changed: 0 })).toMatch(/바뀐 것이 없습니다/);
    expect(assignFailText({ ok: false, reason: '거절' })).toBe('거절');
  });
});
