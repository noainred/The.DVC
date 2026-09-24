import { describe, it, expect } from 'vitest';
import { statusText, traceText, isActive, phaseLabel, testSnapView } from './sanSwitchTestText.js';

describe('sanSwitchTestText (v2.421)', () => {
  it('statusText: 상태별 문구 — 실행 중이면 마지막 추적 줄이 "지금 단계"', () => {
    expect(statusText({ status: 'queued', target: 'agent-WA', elapsedMs: 12_000 })).toMatch(/agent-WA.*12초/);
    expect(statusText({ status: 'dispatched', target: 'agent-WA', elapsedMs: 3000 })).toMatch(/현지에서 실행 중/);
    expect(statusText({ status: 'running', elapsedMs: 5000, trace: [{ t: 10, msg: 'TCP 연결 시도: 10.0.0.1:22' }] })).toMatch(/진행 중: TCP 연결 시도.*5초/);
    expect(statusText({ status: 'done', elapsedMs: 4000, result: { ok: true, ms: 3900 } })).toMatch(/연결 성공/);
    expect(statusText({ status: 'done', elapsedMs: 60_000, result: { ok: false, phase: 'tcp' } })).toMatch(/연결 실패 — TCP 연결 단계/);
  });
  it('traceText: 경과·레벨 표시', () => {
    const t = traceText([{ t: 1234, msg: 'a', level: 'info' }, { t: 2000, msg: 'b', level: 'error' }, { t: 2500, msg: 'c', level: 'debug' }]);
    expect(t.split('\n')).toEqual(['[+1.234s] a', '[+2.000s] ✖ b', '[+2.500s]   · c']);
  });
  it('isActive / phaseLabel', () => {
    expect(isActive({ status: 'running' })).toBe(true);
    expect(isActive({ status: 'done' })).toBe(false);
    expect(isActive(null)).toBe(false);
    expect(phaseLabel('ssh-auth')).toBe('SSH 인증');
    expect(phaseLabel('')).toBe('—');
  });
});

// v2.604(감사 CEN2604-05): 테스트 요약 스냅샷 표시 값 — 객체 값·ports 없음이 모달을 죽이지 않게.
describe('testSnapView (v2.604 CEN2604-05)', () => {
  it('객체 값은 — 로, ports 가 없어도 던지지 않는다', () => {
    const v = testSnapView({ name: { evil: 1 }, model: 'G620', domainId: 0, sections: { ns: 'ok', raslog: 'skip', bad: { x: 1 } } });
    expect(v.name).toBe('—');
    expect(v.model).toBe('G620');
    expect(v.domainId).toBe('0'); // 0 은 값이다
    expect(v.online).toBe('—');
    expect(v.usedPct).toBe('—'); // 값이 없으면 % 를 붙이지 않는다
    expect(v.missing).toEqual(['raslog(skip)']);
  });
  it('정상 값은 그대로, 사용률에 % 를 붙인다', () => {
    const v = testSnapView({ name: 'sw1', ports: { online: 10, licensed: 24, usedPct: 41.7, free: 14, total: 24 } });
    expect(v).toMatchObject({ name: 'sw1', online: '10', licensed: '24', usedPct: '41.7%', free: '14', total: '24' });
  });
  it('snap 이 객체가 아니어도 던지지 않는다', () => {
    expect(testSnapView(null).name).toBe('—');
    expect(testSnapView([1]).missing).toEqual([]);
  });
});
