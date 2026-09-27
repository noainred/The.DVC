// v2.628 — 감사 LEFT2628-01·02·03·04·12 웹 회귀.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samplerWithheldNote, normalizeWithheld } from './samplerWithheldText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

describe('LEFT2628-01 samplerWithheldNote', () => {
  it('제외가 없으면 null', () => {
    expect(samplerWithheldNote(null)).toBe(null);
    expect(samplerWithheldNote({ at: 1, rows: 3, hostsWithTemp: 2 })).toBe(null);
    expect(samplerWithheldNote({ staleVcenters: 0, totalWithheld: false, totalPartial: false, maintenanceExcluded: 0, vmStatsSkipped: 0 })).toBe(null);
  });
  it('lastRun 원본과 서버 요약이 같은 문구가 된다', () => {
    const lastRun = { at: 5, staleSkipped: { vcenters: 2, byReason: { maintenance: 1, stale: 1 } }, vmperfStale: { vcenters: 1, maintenanceExcluded: 1, totalPartial: true, totalWithheld: false }, vmStatsSkipped: 7 };
    const summary = { at: 5, staleVcenters: 2, byReason: { maintenance: 1, stale: 1 }, totalWithheld: false, totalPartial: true, maintenanceExcluded: 1, vmStatsSkipped: 7 };
    expect(normalizeWithheld(lastRun)).toEqual(normalizeWithheld(summary));
    const t = samplerWithheldNote(lastRun);
    expect(t).toContain('vCenter 2곳');
    expect(t).toContain('점검중 1');
    expect(t).toContain('위임 보고 낡음 1');
    expect(t).toContain('부분 합');
    expect(t).toContain('VM 7대');
    expect(t).not.toMatch(/[`*]/);
  });
  it('합계 보류가 부분 합보다 먼저 · vCenter 추이 화면에는 합계 문구를 붙이지 않는다', () => {
    const x = { staleVcenters: 1, byReason: { unreachable: 1 }, totalWithheld: true, totalPartial: false };
    expect(samplerWithheldNote(x)).toContain('전체 합계는 이번 주기에 적재하지 않았습니다');
    expect(samplerWithheldNote(x, { totalView: false })).not.toContain('전체 합계');
  });
});

describe('LEFT2628 화면 소스', () => {
  it('01 MetricsSettings·CapacityTools 가 적재 제외 문구를 그린다', () => {
    expect(read('MetricsSettings.jsx')).toMatch(/samplerWithheldNote\(/);
    const cap = read('tools/CapacityTools.jsx');
    expect(cap).toMatch(/samplerWithheldNote\(d\.sampler/);
  });
  it('12 CapacityTools 추이는 오류 객체를 그대로 ErrorBox 에 넘긴다(403 권한 안내)', () => {
    const cap = read('tools/CapacityTools.jsx');
    expect(cap).not.toMatch(/waste\/history[^\n]*setErr\(e\.message\)/);
    expect(cap).toMatch(/waste\/history[^\n]*setErr\(e\)/);
  });
  it('02 CurrentUsers 가 partialRows 를 말한다', () => {
    expect(read('tools/CurrentUsers.jsx')).toMatch(/partialRows/);
  });
  it('03 NsxAdmin 은 오류 객체를 유지하고 범위 밖 개수를 말한다', () => {
    const s = read('NsxAdmin.jsx');
    expect(s).not.toMatch(/setError\(e\.message\)/);
    expect(s).toMatch(/omittedOutOfScope/);
  });
  it('04 PhysicalGpuManager 는 오류 객체를 유지하고 범위 밖·함대 수치 숨김을 말한다', () => {
    const s = read('gpu-guest/PhysicalGpuManager.jsx');
    expect(s).not.toMatch(/setLoadErr\(e\?\.message/);
    expect(s).toMatch(/omittedOutOfScope/);
    expect(s).toMatch(/fleetCountsHidden/);
  });
});
