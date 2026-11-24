/**
 * 전체 소스 점검 158회차 — 지표 샘플러가 긴급중단 동안 적재하지 않은 vCenter 를 사유로 말한다(서버 metrics/sampler.js samplingUnreadReasons 의 'stopped').
 *   문구 표에 없으면 사유 키('stopped')가 그대로 화면에 나온다.
 */
import { describe, it, expect } from 'vitest';
import { samplerWithheldNote, normalizeWithheld } from './samplerWithheldText.js';

describe('158회차 — 긴급중단으로 뺀 vCenter', () => {
  it('lastRun 원본(byReason.stopped) → ‘긴급중단 N’', () => {
    const lastRun = { at: 1, rows: 5, hostsWithTemp: 0, staleSkipped: { vcenters: 20, hosts: 650, datastores: 129, byReason: { stopped: 20 } }, vmperfStale: { vcenters: 20, totalWithheld: false } };
    const t = samplerWithheldNote(lastRun);
    expect(t).toContain('vCenter 20곳을 적재하지 않았습니다');
    expect(t).toContain('긴급중단 20');
    expect(t).not.toContain('stopped');
  });
  it('요약 모양(/tools/waste/history 의 sampler)도 같다 · 다른 사유와 함께', () => {
    const t = samplerWithheldNote({ at: 1, staleVcenters: 3, byReason: { stopped: 2, maintenance: 1 }, totalWithheld: true, totalPartial: false });
    expect(t).toContain('긴급중단 2'); expect(t).toContain('점검중 1');
    expect(normalizeWithheld({ staleVcenters: 2, byReason: { stopped: 2 } }).byReason).toEqual({ stopped: 2 });
  });
});
