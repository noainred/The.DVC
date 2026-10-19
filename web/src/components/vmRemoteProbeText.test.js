// v2.744 최종 검토 리드 — VM 원격 접속 사전 점검: 범위 거부(403·404)를 '도달 불가 — 방화벽 확인' 으로 안내하지 않는다.
// v2.744 적대적 검토 VD: 거부는 종류(denyKind)로 나눈다 — 범위 밖은 서버가 범위 사유({ok:false, reason})로 준 403·404 뿐이다.
//   점검을 하지 못한 결과(ok:false)는 '도달 불가' 가 아니라 '점검 못 함' 이다(상세 회귀는 audit2744vd.test.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { probeFailState, probeRow, probeTip, probeColor } from './vmRemoteProbeText.js';

// web/src/api.js HttpError 와 같은 모양 — 범위 거부는 서버 본문 {ok:false, reason}(server/src/routes/remote.js /probe).
const deny = (reason, status = 403) => Object.assign(new Error(reason), { status, serverReason: reason, body: { ok: false, reason } });

describe('vmRemoteProbeText', () => {
  it('범위 사유 403·404 는 denied(scope), 그 밖의 실패는 점검 요청 실패', () => {
    expect(probeFailState(deny('범위 밖 대상'))).toEqual({ loading: false, ok: false, denied: true, denyKind: 'scope', reason: '범위 밖 대상', status: 403 });
    expect(probeFailState(deny('범위 밖 vCenter', 404)).denied).toBe(true);
    const t = probeFailState(new Error('ETIMEDOUT'));
    expect(t.denied).toBeUndefined();
    expect(t.requestFailed).toBe(true);
  });
  it('행 글자 — 거부는 도달 불가가 아니다', () => {
    expect(probeRow({ loading: false, denied: true, denyKind: 'scope' }).label).toMatch(/범위 밖/);
    expect(probeRow({ loading: false, denied: true, denyKind: 'scope' }).label).not.toMatch(/도달 불가/);
    expect(probeRow({ loading: false, ok: true }).label).toBe('도달 불가');
    expect(probeRow({ loading: false, ok: false }).label).toMatch(/^점검 못 함/);
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
    const mixed = { '10.0.0.1': probeFailState(deny('x')), '10.0.0.2': { loading: false, ok: true } };
    const t2 = probeTip({ canRemote: true, ips, probes: mixed, probePort: 22 });
    expect(t2).toMatch(/방화벽/);
    expect(t2).toMatch(/1개 IP 는 점검 요청이 거부돼 확인하지 못했습니다\(범위 밖 대상 1\)/);
    expect(probeColor({ canRemote: true, ips, probes: mixed })).toBe('#f87171');
    expect(probeTip({ canRemote: true, ips, probes: { ...mixed, '10.0.0.2': { portOpen: true } }, probePort: 22 })).toMatch(/접속 가능 IP: 10\.0\.0\.2/);
  });
  it('컴포넌트가 이 모듈을 쓴다(인라인 판정 금지)', () => {
    const src = fs.readFileSync(path.join(HERE, 'VmRemote.jsx'), 'utf8');
    expect(src).toMatch(/probeFailState\(e\)/);
    expect(src).toMatch(/probeRow\(p\)/);
    expect(src).not.toMatch(/reason: e\.message \}/);
  });
});
