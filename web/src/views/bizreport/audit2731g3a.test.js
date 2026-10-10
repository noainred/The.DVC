// v2.731 r1 G3a(A2-01) — VM 가용성: 이벤트 수집이 멈춘 vCenter 의 꼬리를 '가동' 으로 세지 않았다는 사실을 화면이 말한다.
// 서버 판정(availability/analyze.js)의 실제 출력으로 문구를 만든다(번들 경계 — 필드 이름이 어긋나면 여기서 깨진다).
import { describe, it, expect } from 'vitest';
import { analyzeAvailability } from '../../../../server/src/availability/analyze.js';
import { coverageNote } from './availText.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;
const vm = (name, vc = 'vc1') => ({ id: `${vc}:${name}`, name, vcenterId: vc, cluster: 'C1', powerState: 'POWERED_ON' });

describe('A2-01 가용성 측정 끝 안내', () => {
  it('수집이 멈춰 측정 끝을 자른 vCenter — 몇 곳·몇 대·얼마나 전부터인지와 그 뒤를 모른다는 사실을 말한다', () => {
    const r = analyzeAvailability([], [vm('a'), vm('b')], { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 10 * DAY }) });
    const n = coverageNote({ coverage: r.coverage, logs: { enabled: true, minSeverity: 'info' } });
    expect(n).toMatch(/이벤트 수집이 멈춘 vCenter 1곳의 VM 2대는/);
    expect(n).toMatch(/10일 전/);
    expect(n).toMatch(/그 뒤의 정지는 알 수 없습니다/);
    // 수집 성공 기록이 없어 마지막으로 받은 이벤트 시각을 썼다는 사실
    expect(n).toMatch(/마지막으로 받은 이벤트 시각/);
  });
  it('수집 성공 시각으로 자른 경우에는 마지막 이벤트 대체 문구를 붙이지 않는다', () => {
    const r = analyzeAvailability([], [vm('a')], { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 4 * DAY, okAt: NOW - 3 * DAY }) });
    const n = coverageNote({ coverage: r.coverage });
    expect(n).toMatch(/3일 전/);
    expect(n).not.toMatch(/마지막으로 받은 이벤트 시각/);
  });
  it('수집이 측정 기간 시작 전에 멈춘 VM 은 판정하지 않았다고 말한다(100% 가 아니다)', () => {
    const r = analyzeAvailability([], [vm('a')], { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 40 * DAY }) });
    const n = coverageNote({ coverage: r.coverage });
    expect(n).toMatch(/측정 기간 시작 전에 멈춘 vCenter 의 VM 1대는 판정하지 않았습니다/);
  });
  it('정상 수집이면 아무 말도 더하지 않는다 · 문구에 백틱·별표가 없다', () => {
    const r = analyzeAvailability([], [vm('a')], { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW }) });
    expect(coverageNote({ coverage: r.coverage })).toBeNull();
    const n = coverageNote({ coverage: { staleTail: 3, tailVcenters: 2, tailMaxAgeMs: 5 * H, tailFromLastEvent: 1, stoppedEarly: 1 } });
    expect(n).not.toMatch(/[`*]/);
    expect(n).toMatch(/2곳의 VM 3대/);
  });
});
