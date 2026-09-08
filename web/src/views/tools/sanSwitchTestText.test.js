import { describe, it, expect } from 'vitest';
import { statusText, traceText, isActive, phaseLabel } from './sanSwitchTestText.js';

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
