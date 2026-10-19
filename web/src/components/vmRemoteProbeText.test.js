// v2.744 최종 검토 리드 — VM 원격 접속 사전 점검: 범위 거부(403·404)를 '도달 불가 — 방화벽 확인' 으로 안내하지 않는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { probeFailState, probeRow, probeTip, probeColor } from './vmRemoteProbeText.js';

const deny = (reason) => Object.assign(new Error('forbidden'), { status: 403, serverReason: reason });

describe('vmRemoteProbeText', () => {
  it('403·404 는 denied, 그 밖의 실패는 예전처럼', () => {
    expect(probeFailState(deny('범위 밖 대상'))).toEqual({ loading: false, ok: false, denied: true, reason: '범위 밖 대상' });
    expect(probeFailState(Object.assign(new Error('x'), { status: 404, serverReason: '범위 밖 vCenter' })).denied).toBe(true);
    expect(probeFailState(new Error('ETIMEDOUT')).denied).toBeUndefined();
  });
  it('행 글자 — 거부는 도달 불가가 아니다', () => {
    expect(probeRow({ loading: false, denied: true }).label).toMatch(/범위 밖/);
    expect(probeRow({ loading: false, denied: true }).label).not.toMatch(/도달 불가/);
    expect(probeRow({ loading: false, ok: false }).label).toBe('도달 불가');
    expect(probeRow({ loading: false, portOpen: true, pingOk: true, pingMs: 3 }).label).toBe('접속 가능 · 포트 열림 · ping 3ms');
  });
  it('툴팁 — 전부 거부면 네트워크 안내를 하지 않고 서버 사유를 말한다', () => {
    const ips = ['10.0.0.1', '10.0.0.2'];
    const all = { '10.0.0.1': probeFailState(deny('허용 vCenter 밖 대상')), '10.0.0.2': probeFailState(deny('허용 vCenter 밖 대상')) };
    const t = probeTip({ canRemote: true, ips, probes: all, probePort: 22 });
    expect(t).not.toMatch(/방화벽/);
    expect(t).toMatch(/범위 밖/);
    expect(t).toMatch(/허용 vCenter 밖 대상/);
    expect(probeColor({ canRemote: true, ips, probes: all })).toBe('#94a3b8');
    const mixed = { '10.0.0.1': probeFailState(deny('x')), '10.0.0.2': { loading: false, ok: false } };
    const t2 = probeTip({ canRemote: true, ips, probes: mixed, probePort: 22 });
    expect(t2).toMatch(/방화벽/);
    expect(t2).toMatch(/1개 IP 는 계정 범위 밖/);
    expect(probeColor({ canRemote: true, ips, probes: mixed })).toBe('#f87171');
    expect(probeTip({ canRemote: true, ips, probes: { ...mixed, '10.0.0.2': { portOpen: true } }, probePort: 22 })).toMatch(/접속 가능 IP: 10\.0\.0\.2/);
  });
  it('컴포넌트가 이 모듈을 쓴다(인라인 판정 금지)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'VmRemote.jsx'), 'utf8');
    expect(src).toMatch(/probeFailState\(e\)/);
    expect(src).toMatch(/probeRow\(p\)/);
    expect(src).not.toMatch(/reason: e\.message \}/);
  });
});
