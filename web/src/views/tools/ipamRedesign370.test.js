// v3.7.0 IP 관리 재설계 묶음 라 — 스캔 속도 · 쉬는 시간 입력 · 시간표 글자 · 정기 보고 폼(순수).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { SPEED_PRESETS, durText, hhmm, intervalText, quietLabel, quietRowIssue, quietToBody, speedOf } from './scanScheduleText.js';
import { bodyOf, formOf, scheduleText, splitAddrs, targetText } from './ipamReportText.js';
import { IPAM_PAGES } from './ipamPages.js';
import { IPAM_RULES } from '../Alerts2.jsx';

describe('v3.7.0 스캔 속도 · 쉬는 시간', () => {
  it('속도는 동시 IP 수 · 응답 대기 두 칸의 이름이다(직접 값은 custom)', () => {
    expect(speedOf({ concurrency: 128, timeoutMs: 700 })).toBe('normal');
    expect(speedOf({ concurrency: '32', timeoutMs: '1000' })).toBe('slow');
    expect(speedOf({ concurrency: 100, timeoutMs: 700 })).toBe('custom');
    expect(SPEED_PRESETS.map((p) => p.k)).toEqual(['slow', 'normal', 'fast']);
  });
  it('쉬는 시간 줄 검사 · 저장 모양(매일이면 days 없음)', () => {
    expect(quietRowIssue({ from: '01:00', to: '05:00' })).toBe('');
    expect(quietRowIssue({ from: '1:00', to: '05:00' })).toMatch(/형식/);
    expect(quietRowIssue({ from: '01:00', to: '01:00' })).toMatch(/같습니다/);
    expect(quietRowIssue({ from: '01:00', to: '02:00', days: [] })).toMatch(/요일/);
    expect(quietToBody([{ from: '22:00', to: '06:00', days: [6, 5] }, { from: '01:00', to: '02:00', days: [0, 1, 2, 3, 4, 5, 6] }]))
      .toEqual([{ from: '22:00', to: '06:00', days: [5, 6] }, { from: '01:00', to: '02:00' }]);
    expect(quietLabel({ from: '22:00', to: '06:00', days: [5] })).toBe('22:00~06:00(금)');
  });
  it('시간표 글자', () => {
    expect(hhmm(730)).toBe('12:10'); expect(hhmm(1440)).toBe('00:00');
    expect(intervalText(3_600_000)).toBe('1시간'); expect(intervalText(90 * 60000)).toBe('90분'); expect(intervalText(null)).toBe('—');
    expect(durText(200_000)).toBe('3분 20초'); expect(durText(45_000)).toBe('45초'); expect(durText(undefined)).toBe('—');
  });
});

describe('v3.7.0 정기 보고 폼', () => {
  it('주소 나누기 · 폼 왕복 · 받는 사람도 시간대도 없는 법인은 싣지 않는다', () => {
    expect(splitAddrs('a@x.com, b@x.com;\nA@x.com ,')).toEqual(['a@x.com', 'b@x.com']);
    const f = formOf({ enabled: true, freq: 'weekly', days: [0], time: '09:00', clock: 'corp', to: ['a@x.com'], corps: { pl: { to: ['p@x.com'], tz: 'Europe/Warsaw' } }, sections: { scan: false } });
    expect(f.corps.pl).toEqual({ toText: 'p@x.com', tz: 'Europe/Warsaw' });
    const b = bodyOf({ ...f, corps: { ...f.corps, kr: { toText: '', tz: '' } } });
    expect(Object.keys(b.corps)).toEqual(['pl']); expect(b.to).toEqual(['a@x.com']); expect(b.sections.scan).toBe(false);
    expect(bodyOf({ ...f, freq: 'daily' }).days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scheduleText(f)).toBe('매주 일 09:00(법인 현지 시각)');
    expect(targetText('overall')).toBe('전체 종합'); expect(targetText('pl', { pl: '폴란드' })).toBe('폴란드');
  });
  it('페이지 · 규칙 등록', () => {
    expect(IPAM_PAGES.find((p) => p.k === 'report')).toMatchObject({ tab: 'setup', admin: true });
    expect(IPAM_PAGES.find((p) => p.k === 'schedule')).toMatchObject({ tab: 'scan', admin: true });
    expect(IPAM_RULES.map((r) => r.k)).toEqual(expect.arrayContaining(['ipamDuplicate', 'ipamSubnetFull', 'ipamScanStale']));
    const core = fs.readFileSync(new URL('./IpamCore.jsx', import.meta.url), 'utf8');
    expect(core).toMatch(/view === 'report' \? <IpamReport \/>/); expect(core).toMatch(/view === 'schedule' \? <IpamScanSchedule \/>/);
  });
  it('무거운 화면은 폴링하지 않는다 · 미리 보기는 샌드박스 iframe', () => {
    for (const f of ['./IpamReport.jsx', './IpamScanSchedule.jsx']) expect(fs.readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(/usePolling|setInterval/);
    expect(fs.readFileSync(new URL('./IpamReport.jsx', import.meta.url), 'utf8')).toMatch(/<iframe title="보고 메일 미리 보기" sandbox=""/);
  });
});
