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
