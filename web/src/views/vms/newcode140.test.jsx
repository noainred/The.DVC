// 새 코드 점검 140회차 — VM 분석 보기(VmInsight)의 ‘분포’ 묶음이 부르는 /hosts/corp 는 서버가 inv.hosts 로 막는다(routes/api/hostCorp.js).
//   VM 탭(inv.vms)만 있는 역할(권한 화면에서 inv.hosts 를 뺀 역할)에는 부르지 않는다 — 예전에는 분석 보기를 열 때마다 403 을 만들었다(v2.616 과 같은 꼴).
//   환산(‘호스트 약 N대분’)은 값이 없으면 생략하는 규칙 그대로라 화면은 바뀌지 않는다.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { vmInsightOf } = await import('../../../../server/src/inventory/vmInsight.js');
const { signalContext } = await import('../../../../server/src/inventory/vmSignals.js');

const vm = (vc, name, o = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', template: false, guestOS: 'Ubuntu Linux (64-bit)',
  cpuCount: 2, memMB: 4096, storageGB: 100, cpuUsagePct: 15, memUsagePct: 25, toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent',
  hwVersion: 'vmx-19', connectionState: 'connected', snapshotCount: 0, snapshotSizeGB: 0, ...o,
});
const vcOf = (id, region) => ({ id, name: `법인-${id}`, status: 'connected', location: { region, city: `${id}-city` } });
const RESP = { ok: true, generatedAt: '2026-11-19T00:00:00Z', initial: false, region: null,
  ...(await vmInsightOf({ vcenters: [vcOf('va', '유럽'), vcOf('vb', '아시아')], vms: [vm('va', 'a1'), vm('vb', 'b1')], ctx: signalContext({ snapAgeDays: 7 }, Date.now()) })) };

const perm = { hosts: true };
const lazy = [];
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/vms/insight' ? { data: RESP, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => true, hasRole: () => true, can: (k) => (k === 'inv.hosts' ? perm.hosts : true) };
});
vi.mock('../insight/useInsight.js', () => ({
  useFolded: () => [{}, () => {}],   // 묶음은 전부 펼침(처음 상태)
  useLazyJson: (path, params, enabled = true) => { lazy.push({ path, enabled: !!enabled }); return { data: null, error: null, loading: false, reload: () => {} }; },
}));
const { default: VmInsight } = await import('./VmInsight.jsx');
const render = () => renderToStaticMarkup(React.createElement(VmInsight, { filters: {}, onScopeIds: () => {} }));
const hostCorpCalls = () => lazy.filter((x) => x.path === '/hosts/corp');

describe('140회차 — VM 분석 보기의 /hosts/corp 는 inv.hosts 가 있을 때만', () => {
  it('inv.hosts 가 없으면 요청하지 않는다(enabled false) · 분포 묶음은 그대로 그린다', () => {
    perm.hosts = false; lazy.length = 0;
    const html = render();
    expect(hostCorpCalls().length).toBeGreaterThan(0);
    expect(hostCorpCalls().every((x) => x.enabled === false)).toBe(true);
    expect(html).toContain('회수 · 정리 후보');   // 분포 묶음(펼침)은 그대로 — 환산만 생략
  });
  it('inv.hosts 가 있고 분포 묶음이 펼쳐져 있으면 요청한다(기존 동작)', () => {
    perm.hosts = true; lazy.length = 0;
    render();
    expect(hostCorpCalls().some((x) => x.enabled === true)).toBe(true);
  });
});
