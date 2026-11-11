// v2.975 — ESXi 호스트 드로어(시안 docs/design/host-drawer): 렌더(모달의 값 · 단추가 빠지지 않는다 · 점검 묶음 확인 중 · 끊긴 호스트) + 소스 스윕
//   (모달 → 드로어 위임 · vCenter 트리 · 호스트 표 '빠른 확인' · 훅은 조기 return 위 · 폴링 없음).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';
import { HOST_OBJ_TABS } from '../vcd/objTabs.js';

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: () => ({ data: null, error: null, loading: true }), toolAllowed: () => true, hasRole: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const host = (o = {}) => ({
  id: 'vc-a:host-1', vcenterId: 'vc-a', name: 'esx-a-01', cluster: 'CL-A', vcDatacenter: 'DC-A', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 76800, cpuUsageMhz: 76032, cpuUsagePct: 99, memTotalMB: 262144, memUsageMB: 154624, memUsagePct: 59,
  vmCount: 14, version: '8.0.3', build: '24022510', vendor: 'Dell Inc.', model: 'PowerEdge R760', serviceTag: 'ABC1234', cpuModel: 'AMD EPYC 9354 32-Core Processor',
  hbas: [{ name: 'vmhba1', type: 'FibreChannel', model: 'QLE2692', speedGbps: 16, wwn: '20:00:00:24:ff:1a:b4:78' }], gpus: [],
  nics: [{ device: 'vmnic0', link: true }, { device: 'vmnic3', link: false }],
  powerWatts: 458, powerSource: 'idrac', tempC: 36.9, tempMaxC: 67.8, bootTime: NOW - 2 * 24 * HOUR - HOUR,
  hcfg: {
    at: NOW - HOUR, ntpServers: ['10.0.0.1'], services: { ntpd: { running: true }, ssh: { running: false, policy: 'off' }, shell: { running: false } }, syslogHost: 'udp://log:514',
    acceptance: 'partner', lockFailures: 5, mob: false, lockdown: 'normal', shellTimeout: 900, diagPartition: true, bsodTimeout: 120,
    mp: { luns: 14, shared: 12, paths: 48, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [] },
    net: { switches: [{ name: 'DSwitch-Prod', kind: 'dvs', pgs: 2, uplinks: ['vmnic0', 'vmnic3'] }], pgs: [] },
  },
  ...o,
});
const CHECKS = { 'vc-a:host-1': { hw: { state: 'ok', bad: 0, health: 'OK' }, boot: null, vm: { n: 13, on: 12, templates: 1, vcpu: 50, memMB: 221184, vcpuUnknown: 0, memUnknown: 0 }, veeam: { y: 9, n: 4, unknown: 0, total: 13 } } };
const render = async (props) => {
  const { default: HostDrawer } = await import('./HostDrawer.jsx');
  return renderToStaticMarkup(React.createElement(HostDrawer, { onClose: () => {}, onMove: () => {}, rows: [], ...props }));
};

describe('HostDrawer — 렌더', () => {
  it('머리 · 사유 배지 · 타일 · 신호 · 하드웨어 · 단추 · 탭 바로가기(모달의 값이 빠지지 않는다)', async () => {
    const h = host();
    const html = await render({ host: h, rows: [{ id: 'x' }, h, { id: 'y' }], checks: CHECKS });
    expect(html).toContain('aria-label="호스트 상세 — esx-a-01"');
    expect(html).toContain('목록 2/3');
    for (const t of ['CPU 99%', '쓰는 스위치의 업링크 끊김', 'Veeam 최근 백업 없는 VM']) expect(html).toContain(t);
    expect(html).toContain('신호 3 — 봐야 할 것');
    expect(html).toContain('DSwitch-Prod/vmnic3');
    expect(html).toContain('VM 13대 중 4대 · 있음 9');
    // 타일 4칸
    expect(html).toContain('76.0 / 76.8 GHz');
    expect(html).toContain('151 / 256 GB');
    for (const t of ['켜짐 12 · 꺼짐 1', '템플릿 1', 'vCPU 50 할당', '코어 대비 1.6 : 1']) expect(html).toContain(`<span class="s">${t}</span>`);
    expect(html).toContain('iDRAC 실측');
    expect(html).toContain('36.9℃ · 최고 67.8℃');
    // 모달 HostBasicRows 의 값
    for (const t of ['Dell Inc. / PowerEdge R760', 'ABC1234', '8.0.3 (build 24022510)', '2소켓 · 32코어 / 64스레드', 'AMD EPYC 9354 32-Core', 'CL-A', 'DC-A', 'vc-a:host-1']) expect(html).toContain(t);
    // 단추 · 바로가기
    expect(html).toContain('VM 14대 보기');
    expect(html).toContain('개체 보기');
    expect(html).toMatch(/<a href="#\/hosts\/vc-a%3Ahost-1"[^>]*>전체 페이지 상세<\/a>/);   // 아래 바로가기 줄(단추 줄은 4개 — 한 줄)
    for (const t of HOST_OBJ_TABS) expect(html).toContain(`href="#/vcenters/vc-a/host/vc-a%3Ahost-1/${t.k}"`);
    expect(html).toContain('Esc 닫기 · ↑↓ 이전/다음 호스트');
    // 섹션(기존 컴포넌트) · 읽은 값은 접힘
    expect(html).toContain('구성·보안');
    expect(html).toMatch(/<details class="vmh-more"><summary>읽은 값 \d+개 펼치기<\/summary>/);
    expect(html).toContain('스토리지 어댑터 (HBA)');
    expect(html).not.toContain('확인 중');   // 점검 묶음을 받은 채 열었다
    expect(html).not.toContain('받지 못한 묶음');
  });
  it('점검 묶음 없이 열면 첫 렌더는 확인 중 — 받기 전에는 없음으로 말하지 않는다 · 인벤토리 사유는 바로 보인다', async () => {
    const html = await render({ host: host() });
    expect(html).toContain('신호 2 — 봐야 할 것 · 점검 묶음 확인 중');
    expect(html).toContain('iDRAC 부품 · 재부팅 · Veeam 대조를 확인하는 중입니다');
    expect(html).toContain('켜짐 · 할당 확인 중…');
    expect(html).not.toContain('신호 없음');
    expect(html).not.toContain('class="pos"');   // rows 가 없으면 목록 위치를 말하지 않는다
    expect((html.match(/class="vmh-icon-btn"[^>]*disabled/g) || []).length).toBe(2);   // ‹ › 잠김
  });
  it('신호가 없고 묶음을 다 받았으면 무엇을 봤는지 한 줄', async () => {
    const h = host({ cpuUsagePct: 40, nics: [{ device: 'vmnic0', link: true }, { device: 'vmnic3', link: true }] });
    const html = await render({ host: h, checks: { [h.id]: { ...CHECKS[h.id], veeam: { y: 13, n: 0, unknown: 0, total: 13 } } } });
    expect(html).toContain('신호 0 — 봐야 할 것');
    expect(html).toContain('신호 없음 — 점검 모드 · 끊김 · CPU 초과');
  });
  it('권한으로 빠진 묶음은 따로 말한다(이상 없음이 아니다)', async () => {
    const h = host({ cpuUsagePct: 40 });
    const html = await render({ host: h, checks: { [h.id]: { vm: CHECKS[h.id].vm, veeam: { y: 13, n: 0, unknown: 0, total: 13 } } } });
    expect(html).toContain('확인 못 한 묶음 2');
    expect(html).toContain('받지 못한 묶음: iDRAC 부품 상태(관리자 판본) · 재부팅 판정(구성 점검 도구 권한) — 이상 없음이 아닙니다.');
    expect(html).not.toContain('신호 없음 —');
  });
  it('끊긴 호스트 — 사용률 · 추이를 그리지 않는다(— · 단위 없음)', async () => {
    const html = await render({ host: host({ connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0 }), checks: CHECKS });
    expect(html).toContain('끊긴 호스트는 사용률이 없습니다');
    expect(html).not.toContain('24시간 추이');
    expect(html).not.toContain('vmh-spark');
    expect(html).not.toMatch(/>0<small>%<\/small>/);
    expect(html).toContain('끊김');
  });
  it('host 가 없으면 아무것도 그리지 않는다', async () => {
    expect(await render({ host: null })).toBe('');
  });
});

describe('소스 스윕', () => {
  it('EntityDetail 은 호스트를 드로어로 위임한다(동적 import · rows 없음) — 호스트 모달 본문은 없다 · 데이터스토어 모달은 그대로', () => {
    const s = read('../../components/EntityDetail.jsx');
    expect(s).toMatch(/const HostDrawer = React\.lazy\(\(\) => import\('\.\.\/views\/hosts\/HostDrawer\.jsx'\)\)/);
    expect(s).toMatch(/if \(type === 'host'\) return <Lazy><HostDrawer host=\{item\} rows=\{\[\]\} onClose=\{onClose\}/);
    expect(s).not.toMatch(/type === 'host' &&/);
    expect(s).not.toMatch(/<HostMetricButton|<IdracTrendLinkButton|<HostPowerPanel|<HostGpuPanel/);
    expect(s).toMatch(/<DsBrowseSection item=\{item\} \/>/);
    expect(s).toMatch(/export function HostBasicRows/);   // 개체 보기 요약 · 전체 페이지가 쓴다(지우지 않는다)
    expect(s).toMatch(/export function HostCfgSection\(\{ host, foldValues = false \}\)/);
  });
  it('옛 호스트 모달을 열던 곳은 여전히 EntityDetail 을 거친다(드로어가 자동으로 적용된다)', () => {
    for (const rel of ['../Alarms.jsx', '../Explore.jsx', '../tools/IdracTrendTool.jsx', '../tools/IpamCore.jsx']) expect(read(rel)).toMatch(/<EntityDetail /);
  });
  it('vCenter 트리 — 호스트 클릭은 드로어 · 순서는 treeHostRows · 개체 보기로 가면 닫는다', () => {
    const s = read('../VCenterDetail.jsx');
    expect(s).not.toMatch(/setSel\(\{ type: 'host'/);
    expect((s.match(/setHostDrawer\(h\)/g) || []).length).toBeGreaterThanOrEqual(3);   // 트리 · 검색 결과 · onMove
    expect(s).toMatch(/treeHostRows\(\{ view, query, hostMatches, cap: SEARCH_CAP, clusters \}\)/);
    expect(s).toMatch(/<HostDrawer host=\{hostDrawerCur\} rows=\{treeHosts\}/);
    expect(s).toMatch(/if \(r\.obj\) \{ setVmDrawer\(null\); setHostDrawer\(null\); \}/);
    expect(s).toMatch(/setSel\(\{ type: 'datastore'/);   // 데이터스토어 모달은 그대로(범위 밖)
  });
  it("호스트 표 — 이름은 개체 보기 그대로 · 옆에 '빠른 확인' · 순서는 표가 그린 행 · 표가 가진 점검 묶음을 넘긴다", () => {
    const s = read('../Hosts.jsx');
    expect(s).toMatch(/href=\{vcHash\(h\.vcenterId, \{ type: 'host', id: h\.id \}\)\}/);
    expect(s).toMatch(/className="ht-quick" onClick=\{\(\) => setDrawer\(h\)\}/);
    expect(s).toMatch(/onVisible=\{\(r\) => \{ shownRef\.current = r; \}\}/);
    expect(s).toMatch(/rows=\{shownRef\.current\} checks=\{byId\}/);
    expect(s.indexOf('const [drawer, setDrawer] = useState(null)')).toBeLessThan(s.indexOf('if (hostId) {'));   // 훅은 조기 return 위
    expect(fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8')).toMatch(/\.ht-quick \{/);
  });
  it('드로어 — 훅은 조기 return 위 · 폴링 없음 · 추이는 호스트 경로로 잠깐 기다렸다 · 점검 묶음은 vCenter 마다 1회', () => {
    const s = read('./HostDrawer.jsx');
    const ret = s.indexOf('if (!host) return null');
    expect(ret).toBeGreaterThan(0);
    for (const hook of ['useDaySeries(host?.id', 'useHostChecks(host?.vcenterId, !!host && !checks)', 'useMemo(() => (host ? secCountsOf(host) : null)', 'useEffect(() => { setShowVms(false); }']) {
      expect(s.indexOf(hook)).toBeGreaterThan(0);
      expect(s.indexOf(hook)).toBeLessThan(ret);
    }
    expect(s).toMatch(/\{ entity: 'host', delayMs: SERIES_DELAY_MS \}/);
    expect(s).not.toMatch(/setInterval|usePolling/);
    expect(s).toMatch(/asked\.current\.has\(vcenterId\)/);
    expect(s).toMatch(/fetchJson\('\/hosts\/checks', \{ vcenterId \}, ac\.signal/);
    expect(s).toMatch(/<HostCfgSection host=\{host\} foldValues \/>/);
    // 성능 그래프 보기 바로 뒤 통합 성능 모니터링(v2.676 순서 — 예전에는 모달에서 봤다)
    const a = s.indexOf('<HostMetricButton'); const b = s.indexOf('<IdracTrendLinkButton');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    expect(s).toMatch(/<HostMetricButton hostId=\{host\.id\} hostName=\{host\.name\} vcenterId=\{host\.vcenterId\} onBefore=\{onClose\} \/>/);
    // 임계값 숫자를 화면에 박지 않는다(글자 모듈이 CPU_ATTENTION_PCT 로 만든다)
    expect(s).not.toMatch(/90%/);
    expect(read('./hostDrawerText.js')).not.toMatch(/90%/);
  });
  it('useDaySeries — 호스트 경로 · 지연 조회(기다리는 동안 id 가 바뀌면 요청이 나가지 않는다) · VM 기본값은 그대로', () => {
    const s = read('../vms/vmSeries.jsx');
    expect(s).toMatch(/export function useDaySeries\(vmId, enabled, \{ entity = 'vm', delayMs = 0 \} = \{\}\)/);
    expect(s).toMatch(/entity === 'host' \? 'hosts' : 'vms'/);
    expect(s).toMatch(/const timer = delayMs > 0 \? setTimeout\(run, delayMs\) : null/);
    expect(s).toMatch(/if \(timer\) clearTimeout\(timer\)/);
    expect(read('../vms/VmDrawer.jsx')).toMatch(/useDaySeries\(vm\?\.id, on\)/);
  });
});
