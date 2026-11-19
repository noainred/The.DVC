// 새 코드 점검 145회차(140 반증 · 139 의 ‘화면 코드 변경 불필요’ 반증) — 139회차가 바꾼 /hosts/insight 응답 꼴을 화면이 맞게 그리는가.
//   · 점검중(maintenance) vCenter 줄: stale:true + notCurrent('maintenance') — 합에서 빼고 ‘오래됨 N곳’ · 지도 칸 빗금.
//   · 로그 DB 를 못 읽음: reboots30d null + rebootsUnread(호스트 수) + 응답 rebootsUnreadable — ‘예기치 않은 재부팅’ 칸은 0 이 아니라 ‘—’ + 모름 N대.
//   응답은 서버 hostInsightOf 로 만든다(실제 모양 — 손으로 쓴 픽스처가 아니다).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { hostInsightOf } = await import('../../../../server/src/vcenter/hostInsight.js');

const GB = 1024;
const readable = (h) => h.connectionState !== 'DISCONNECTED' && h.connectionState !== 'NOT_RESPONDING';
const capKnown = (h) => !!h && [h.cpuCores, h.cpuTotalMhz, h.memTotalMB].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
const host = (vc, id, cluster, o = {}) => ({
  id: `${vc}:${id}`, vcenterId: vc, name: `${vc}-${id}`, cluster, clusterRef: `domain-${cluster}`,
  connectionState: 'CONNECTED', version: '8.0.2', vendor: 'Dell Inc.', model: 'PowerEdge R760', bootTime: Date.now() - 86_400_000 * 90,
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsagePct: 40, memTotalMB: 512 * GB, memUsagePct: 50, powerWatts: 400, ...o,
});
// va = 지금 값(40%) · vm = 점검중 vCenter(store 가 직전 캐시를 기한 없이 서빙) — 옛 값이 95%
const HOSTS = [host('va', 'h1', 'CL1'), host('va', 'h2', 'CL1'), host('vm', 'h1', 'MCL', { cpuUsagePct: 95 }), host('vm', 'h2', 'MCL', { cpuUsagePct: 95 }), host('vm', 'h3', 'MCL')];
const VCS = [
  { id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'va-city' } },
  { id: 'vm', name: '법인-vm', status: 'maintenance', location: { region: '유럽', city: 'vm-city' } },
];
const RESP = { ok: true, generatedAt: '2026-11-19T00:00:00Z', initial: false, region: null,
  ...(await hostInsightOf({ vcenters: VCS, hosts: HOSTS, vms: [], readable, capKnown, access: { cluster: false, hw: false, hygiene: true },
    checks: { access: { hw: false, hygiene: true }, byId: {} }, rebootsUnreadable: true, bootDays: 30 })) };

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/hosts/insight' ? { data: RESP, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => false, hasRole: () => true };
});
const { default: HostInsight } = await import('./HostInsight.jsx');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = () => text(renderToStaticMarkup(React.createElement(HostInsight, { filters: {}, onScopeIds: () => {} })));

describe('145회차 — 139회차 응답 꼴(점검중 줄 · 재부팅 못 읽음)을 화면이 맞게 그린다', () => {
  it('전제(서버): 점검중 줄은 stale:true + notCurrent · 재부팅은 null + 모름 + rebootsUnreadable', () => {
    const vm = RESP.rows.find((r) => r.id === 'vm');
    expect(vm.stale).toBe(true);
    expect(vm.notCurrent).toBe('maintenance');
    expect(RESP.rows.find((r) => r.id === 'va').reboots30d).toBe(null);
    expect(RESP.rows.find((r) => r.id === 'va').rebootsUnread).toBe(2);
    expect(RESP.rebootsUnreadable).toBe(true);
  });
  it('점검중 법인은 합에서 빠지고 ‘오래됨 1곳’ 으로 따로 · 전체 호스트 2(5 가 아니다)', () => {
    const t = render();
    expect(t).toMatch(/오래됨 1곳\(법인-vm\) — 값이 늦어 합에 넣지 않았습니다/);
    expect(t).toMatch(/전체 호스트 2 /);
  });
  it('재부팅 근거를 못 읽으면 ‘예기치 않은 재부팅’ 은 0 이 아니라 ‘—’ · 모름 2대(합에 든 법인의 호스트만)', () => {
    const t = render();
    expect(t).toMatch(/— 예기치 않은 재부팅\(30일\) 최근 30일 · 모름 2대/);
    expect(t).not.toMatch(/0 예기치 않은 재부팅/);
  });
  it('지도의 ‘지금 … N칸’ 은 오래된 법인의 칸을 세지 않는다(옛 값 95% 를 지금 경고로 세지 않음) — 따로 밝힌다', () => {
    const t = render();
    expect(t).toMatch(/지금 ‘가장 바쁜 호스트 CPU’ 기준으로 0칸입니다/);
    expect(t).toMatch(/오래된 값 1칸은 세지 않았습니다/);
  });
});
