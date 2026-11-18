// v2.805 ESXi 호스트 화면 '엑셀 수준 상세' — 열 묶음 · 저장값 · 점검 열 글자 · 요약 · 칩(승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1 ①).
//   '—' 는 못 읽은 값(0 이 아님) · 묶음을 못 읽었으면 칩 수는 null · 구성·보안 판정은 hostCfgFindings 하나 · 기본 묶음은 끌 수 없다.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COL_GROUPS, COLUMNS, FIXED_GROUP, parseColPrefs, stringifyColPrefs, visibleColumns, secCountsOf, secText, secTone, uplinkDownOf, nicLinkDownOf, deadPathsOf,
  uptimeDays, coresText, gbText, kwText, ratioText, hwCell, bootCell, veeamCell, hostKpis, CHECK_CHIPS, chipCounts, matchesChip, filterHostsExt, focusLabelExt, reasonBadges,
  vmAllocCells,
} from './hostChecksText.js';
import { HOST_CFG_CODES } from './hostcfg/hostCfgText.js';

const H = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / H) * H;
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(path.resolve(here, '..', p), 'utf8');
const hcfg = (over = {}) => ({
  at: NOW - H, lockdown: 'disabled', rebootRequired: false,
  services: { ssh: { running: false, policy: 'off' }, shell: { running: false, policy: 'off' }, ntpd: { running: true, policy: 'on' } },
  ntpServers: ['10.0.0.1'], dnsServers: ['10.0.0.53'], syslogHost: 'udp://10.0.0.60:514', lockFailures: 5, shellTimeout: 900, mob: false, acceptance: 'partner',
  certNotAfter: NOW + 200 * DAY, mp: { luns: 4, shared: 2, paths: 8, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [], policies: {} },
  net: { switches: [{ name: 'vSwitch0', kind: 'vss', uplinks: ['vmnic0', 'vmnic1'], pgs: 2 }], pgs: [{ name: 'Mgmt', vlan: 10, sw: 'vSwitch0', promisc: false }], pgsTotal: 1 },
  scratch: '/vmfs/volumes/ds1/.locker', logDir: '[] /scratch/log', diagPartition: true, bsodTimeout: 120, ...over,
});
const host = (id, over = {}) => ({ id: `vc:${id}`, vcenterId: 'vc', name: `esx${id}`, cluster: 'CL1', connectionState: 'CONNECTED', cpuUsagePct: 40, memUsagePct: 50, cpuCores: 32, cpuSockets: 2, cpuThreads: 64, memTotalMB: 262144, memUsageMB: 131072, bootTime: NOW - 10 * DAY, nics: [{ device: 'vmnic0', link: true }, { device: 'vmnic1', link: false }, { device: 'vmnic2', link: false }], hbas: [{}], vmCount: 10, powerWatts: 400, tempC: 30, hcfg: hcfg(), ...over });

describe('hostChecksText — 열 묶음·저장값', () => {
  it('묶음 9개 · 열 30개 · 모든 열은 아는 묶음에 속한다 · 기본 묶음은 끌 수 없다', () => {
    expect(COL_GROUPS.map((g) => g.key)).toEqual(['base', 'hw', 'esxi', 'use', 'vm', 'net', 'st', 'chk', 'bak']);
    expect(COLUMNS).toHaveLength(30);
    const keys = new Set(COL_GROUPS.map((g) => g.key));
    for (const c of COLUMNS) expect(keys.has(c.group)).toBe(true);
    expect(new Set(COLUMNS.map((c) => c.key)).size).toBe(30);
    expect(FIXED_GROUP).toBe('base');
    expect(parseColPrefs(JSON.stringify({ v: 1, off: ['base', 'hw', 'nope'] }))).toEqual({ hw: true });
    expect(parseColPrefs('{broken')).toEqual({});
    expect(parseColPrefs(null)).toEqual({});
    expect(JSON.parse(stringifyColPrefs({ hw: true, base: true, bak: true }))).toEqual({ v: 1, off: ['hw', 'bak'] });
    const vis = visibleColumns({ hw: true, bak: true });
    expect(vis.some((c) => c.group === 'hw')).toBe(false);
    expect(vis.some((c) => c.key === 'veeam')).toBe(false);
    expect(vis.some((c) => c.key === 'name')).toBe(true);
    expect(visibleColumns({}, { hw: false }).some((c) => c.key === 'idrac')).toBe(false);
    expect(visibleColumns({}).some((c) => c.key === 'idrac')).toBe(true);
  });
  it('Hosts.jsx 는 localStorage 를 try 안에서만 만지고(hostChecksText 경유) 묶음 버튼은 FIXED_GROUP 을 잠근다', () => {
    const s = src('views/Hosts.jsx');
    expect(s).not.toMatch(/localStorage\.(get|set|remove)Item/);
    expect(s).toMatch(/disabled=\{fixed\}/);
    const t = src('views/hostChecksText.js');
    expect(t).toMatch(/export function readColPrefs\(\) \{ try \{/);
    expect(t).toMatch(/export function writeColPrefs\(off\) \{ try \{/);
  });
});

describe('hostChecksText — 점검 열 글자(못 읽은 값은 0 이 아니다)', () => {
  it('구성·보안 — hcfg 없음·끊김은 null · 판정은 hostCfgFindings 하나', () => {
    expect(secCountsOf(host('a', { hcfg: undefined }))).toBe(null);
    expect(secCountsOf(host('a', { connectionState: 'DISCONNECTED' }))).toBe(null);
    const ok = secCountsOf(host('a'), NOW);
    expect(ok.crit + ok.warn + ok.info).toBe(ok.findings.length);
    expect(secTone({ crit: 0, warn: 0, info: 0 })).toBe('green');
    expect(secText({ crit: 0, warn: 0, info: 0 })).toBe('이상 없음');
    expect(secText({ crit: 1, warn: 2, info: 0 })).toBe('위험 1 · 주의 2');
    expect(secTone({ crit: 1, warn: 0, info: 0 })).toBe('red');
    const bad = secCountsOf(host('b', { hcfg: hcfg({ certNotAfter: NOW - DAY, services: { ssh: { running: true, policy: 'off' } } }) }), NOW);
    expect(bad.crit).toBeGreaterThanOrEqual(1);
    expect(bad.findings.some((f) => f.code === 'cert-expired')).toBe(true);
    expect(HOST_CFG_CODES['cert-expired']).toBe('crit');
  });
  it('업링크·링크·죽은 경로·업타임·코어·단위', () => {
    const h = host('a');
    expect(uplinkDownOf(h)).toBe(1, 'vSwitch0 업링크 vmnic1 만 — 쓰지 않는 vmnic2 는 안 센다');
    expect(nicLinkDownOf(h)).toBe(2);
    expect(uplinkDownOf(host('b', { hcfg: undefined }))).toBe(null);
    expect(nicLinkDownOf(host('b', { nics: [] }))).toBe(null);
    expect(deadPathsOf(h)).toBe(0);
    expect(deadPathsOf(host('b', { hcfg: undefined }))).toBe(null);
    expect(uptimeDays(h, NOW)).toBe(10);
    expect(uptimeDays(host('b', { connectionState: 'DISCONNECTED' }), NOW)).toBe(null);
    expect(coresText(h)).toBe('2 / 32 / 64');
    expect(coresText({ cpuCores: 32 })).toBe('— / 32 / —');
    expect(coresText({})).toBe('—');
    expect(gbText(262144)).toBe('256 GB'); expect(gbText(NaN)).toBe('—'); expect(gbText(0)).toBe('—');
    expect(kwText(412)).toBe('412 W'); expect(kwText(0)).toBe('—');
    expect(ratioText(64, 32)).toBe('2.0 : 1'); expect(ratioText(64, 0)).toBe('—');
  });
  it('iDRAC · 재부팅 · Veeam 칸', () => {
    expect(hwCell(null)).toMatchObject({ text: '—' });
    expect(hwCell({ hw: { state: 'warn', bad: 2 } })).toMatchObject({ text: '경고 2', tone: 'amber' });
    expect(hwCell({ hw: { state: 'none', bad: null } })).toMatchObject({ text: '등록 안 됨', tone: 'gray' });
    expect(hwCell({ hw: { state: 'error', bad: null } }).text).toBe('등록부 못 읽음');
    const h = host('a');
    expect(bootCell(null, h).text).toBe('—');
    expect(bootCell({}, h).text).toBe('권한 없음');
    expect(bootCell({ boot: null }, h, 30).text).toBe('30일 내 없음');
    expect(bootCell({ boot: null }, host('b', { bootTime: null }), 30).text).toBe('—');
    expect(bootCell({ boot: { kind: 'unexpected', bootTime: Date.UTC(2026, 8, 14, 3, 0) } }, h, 30)).toMatchObject({ tone: 'red' });
    expect(bootCell({ boot: { kind: 'planned', bootTime: NOW } }, h, 30).text).toMatch(/^계획된 재부팅 · \d\d-\d\d$/);
    expect(veeamCell(null).text).toBe('—');
    expect(veeamCell({ veeam: null }).text).toBe('수집 안 됨');
    expect(veeamCell({ veeam: { y: 0, n: 0, unknown: 0, total: 0 } }).text).toBe('VM 없음');
    expect(veeamCell({ veeam: { y: 3, n: 1, unknown: 0, total: 4 } })).toMatchObject({ text: '예 3 · 아니오 1', tone: 'amber' });
    expect(veeamCell({ veeam: { y: 3, n: 0, unknown: 2, total: 5 } })).toMatchObject({ text: '예 3 · 아니오 0 · 모름 2', tone: 'green' });
  });
});

describe('hostChecksText — 요약 8칸·칩·거르기', () => {
  const rows = [host('1'), host('2', { cluster: 'CL2', cpuSockets: null, memUsageMB: null }), host('3', { cluster: '', connectionState: 'DISCONNECTED', cpuUsagePct: 0, powerWatts: 0 })];
  const summary = { total: 3, connected: 2, maintenance: 0, disconnected: 1, physicalCores: 96, logicalCores: 192, vcoreAllocated: 192, memTotalGB: 768, memOvercommit: 0.5, powerKw: 0.8, esxiVersions: [{ version: '8.0.3', count: 2 }, { version: '7.0.3', count: 1 }] };
  it('요약 — 클러스터·소켓·사용 메모리는 표의 호스트에서 세고 못 읽은 것은 따로', () => {
    const k = hostKpis(summary, rows, NOW);
    expect(k.map((x) => x.key)).toEqual(['hosts', 'clusters', 'cores', 'vcore', 'mem', 'vms', 'power', 'ver']);
    expect(k[1].value).toBe('2'); expect(k[1].sub).toMatch(/독립 호스트 1/);
    expect(k[2].sub).toMatch(/소켓 4\(못 읽음 1\)/);
    expect(k[3].sub).toBe('vCore:물리 2.0 : 1');
    expect(k[4].value).toBe('0.8'); expect(k[4].unit).toBe('TB'); expect(k[4].sub).toMatch(/못 읽음 2/);
    expect(k[6].value).toBe('0.8'); expect(k[6].sub).toMatch(/읽은 호스트 2 \/ 3/);
    expect(k[7].value).toBe('2'); expect(k[7].versions).toHaveLength(2);
    const empty = hostKpis({}, [], NOW);
    expect(empty[4].value).toBe('—'); expect(empty[4].unit).toBe(''); expect(empty[6].value).toBe('—');
  });
  it('v3.19.0 할당 vCore · 메모리 할당 — 못 읽은 VM 이 있으면 부분 합(≥ · 수를 따로) · 없으면 예전 문구 그대로', () => {
    expect(hostKpis({ ...summary, vcpuUnknown: 0, vmemUnknown: 0 }, rows, NOW)[3].sub).toBe('vCore:물리 2.0 : 1');
    const k = hostKpis({ ...summary, vcpuUnknown: 3, vmemUnknown: 2 }, rows, NOW);
    expect(k[3].value).toBe('192');
    expect(k[3].sub).toBe('vCore:물리 ≥2.0 : 1(vCPU 못 읽은 VM 3대 제외 · 최소값)');
    expect(k[4].sub).toMatch(/할당 ≥0\.5 : 1\(메모리 못 읽은 VM 2대 제외\)/);
    expect(hostKpis(summary, rows, NOW)[4].sub).toMatch(/할당 0\.5 : 1$/);
    // 전부 못 읽음 — 서버가 합 · 비율을 null 로 준다: 값 '—' · 0 으로 보이지 않는다
    const none = hostKpis({ ...summary, vcoreAllocated: null, memOvercommit: null, vcpuUnknown: 4, vmemUnknown: 4 }, rows, NOW);
    expect(none[3].value).toBe('—');
    expect(none[3].sub).toBe('vCore:물리 —(vCPU 못 읽은 VM 4대)');
    expect(none[4].sub).toMatch(/할당 —\(메모리 못 읽은 VM 4대\)$/);
    // 6회차: 진짜 0(VM 0대 — 서버가 0 을 준다)은 '0 : 1' · 모름(null)과 다르다
    const zero = hostKpis({ ...summary, vcoreAllocated: 0, memOvercommit: 0, vmemAllocatedGB: 0, vcpuUnknown: 0, vmemUnknown: 0 }, rows, NOW);
    expect(zero[4].sub).toMatch(/할당 0 : 1$/);
    expect(zero[3].sub).toBe('vCore:물리 0.0 : 1');
    // 용량 못 읽은 호스트가 있으면(서버 null) vCore 칸과 같은 사유
    expect(hostKpis({ ...summary, memOvercommit: null, hostsCapacityUnknown: 1 }, rows, NOW)[4].sub).toMatch(/할당 —\(용량 못 읽은 호스트 1\)$/);
    // 사유 없는 null(옛 서버 등)은 그냥 '—'
    expect(hostKpis({ ...summary, memOvercommit: null, vmemUnknown: 0 }, rows, NOW)[4].sub).toMatch(/할당 —$/);
    // 호스트 용량을 못 읽었으면 그 사유가 먼저(예전 문구 그대로)
    expect(hostKpis({ ...summary, hostsCapacityUnknown: 1, vcpuUnknown: 3 }, rows, NOW)[3].sub).toBe('vCore:물리 —(용량 못 읽은 호스트 1)');
  });
  it('칩 — 묶음을 못 읽었으면 null(0 이 아니다) · 구성 칩은 findings 코드로 · 서버 칩은 checks 로', () => {
    const secOf = (h) => secCountsOf(h, NOW);
    const none = chipCounts(rows, { secOf, checks: null, access: null });
    expect(none.find((c) => c.kind === 'hw').n).toBe(null);
    expect(none.find((c) => c.kind === 'unexpected').n).toBe(null);
    expect(none.find((c) => c.kind === 'uplink').n).toBe(2, '끊긴 3번은 판정하지 않는다');
    const checks = { 'vc:1': { hw: { state: 'fault', bad: 1 }, boot: { kind: 'unexpected' }, veeam: { y: 1, n: 2, unknown: 0, total: 3 } }, 'vc:2': { hw: { state: 'ok' }, boot: null, veeam: { y: 2, n: 0, unknown: 0, total: 2 } }, 'vc:3': { veeam: null } };
    const got = chipCounts(rows, { secOf, checks, access: { hygiene: true, hw: true } });
    const by = Object.fromEntries(got.map((c) => [c.kind, c.n]));
    expect(by).toMatchObject({ hw: 1, unexpected: 1, 'veeam-n': 1, uplink: 2 });
    expect(chipCounts(rows, { secOf, checks, access: { hygiene: true, hw: false } }).find((c) => c.kind === 'hw')).toMatchObject({ n: null, why: '관리자 판본' });
    const noVeeam = chipCounts(rows, { secOf, checks: { 'vc:1': { veeam: null }, 'vc:2': { veeam: null }, 'vc:3': { veeam: null } }, access: { hygiene: true, hw: true } });
    expect(noVeeam.find((c) => c.kind === 'veeam-n').n).toBe(null);
    expect(matchesChip(rows[0], 'nope', {})).toBe(false);
    expect(CHECK_CHIPS.every((c) => c.label && c.tone)).toBe(true);
    // 거르기 — 칩 종류는 탭 위에 겹친다 · 모르는 종류는 시안 B filterHosts 그대로
    expect(filterHostsExt(rows, { tab: 'all', focus: { kind: 'hw' } }, { secOf, checks }).map((h) => h.id)).toEqual(['vc:1']);
    expect(filterHostsExt(rows, { tab: 'all', focus: { kind: 'uplink' } }, { secOf, checks }).map((h) => h.id)).toEqual(['vc:1', 'vc:2']);
    expect(filterHostsExt(rows, { tab: 'attention', focus: null }, { secOf, checks }).map((h) => h.id)).toEqual(['vc:3']);
    expect(filterHostsExt(rows, { tab: 'all', focus: { kind: 'down' } }, { secOf, checks }).map((h) => h.id)).toEqual(['vc:3']);
    expect(focusLabelExt({ kind: 'hw' })).toBe('iDRAC 부품 경고 · 장애');
    expect(focusLabelExt({ kind: 'down' })).toBe('끊김·무응답 호스트');
    const b = reasonBadges(rows[0], { sec: secOf(rows[0]), checks });
    expect(b.map((x) => x.kind)).toEqual(['uplink', 'unexpected', 'hw', 'veeam-n']);
  });
});

// v3.19.2 — 호스트 표 · 상세 · 드로어의 VM 할당 칸. '전부 못 읽음' 판정은 서버 vcenter/vmSums.js vmAllocOf 하나이고(서버가 null 을 준다 — server/test/hostVmAlloc3192.test.js),
//   웹은 그 null 을 '—'(단위 없음)로 그릴 뿐이다. v3.19.1 까지 서버가 원래 합 0 을 줘 표가 '0+?', 상세가 '0' · '0.0 : 1' 이었다.
describe('v3.19.2 VM 할당 칸(vmAllocCells) — 전부 못 읽음 · 일부 못 읽음 · VM 없음', () => {
  const host = { id: 'vc-a:h1', cpuCores: 8, memTotalMB: 65536 };
  const ALL = { n: 3, on: 2, templates: 1, vcpu: null, memMB: null, vcpuUnknown: 3, memUnknown: 3 };
  const PART = { n: 3, on: 3, templates: 0, vcpu: 6, memMB: 12288, vcpuUnknown: 1, memUnknown: 2 };
  const NONE = { n: 0, on: 0, templates: 0, vcpu: 0, memMB: 0, vcpuUnknown: 0, memUnknown: 0 };
  const FULL = { n: 2, on: 2, templates: 0, vcpu: 1200, memMB: 2 * 1024 * 1024, vcpuUnknown: 0, memUnknown: 0 };

  it('전부 못 읽음 — 세 칸 다 ‘—’(단위 · ‘+?’ 없음) · 정렬 값 null(항상 뒤) · 이유를 적는다', () => {
    const c = vmAllocCells(ALL, host);
    for (const k of ['vcpu', 'ratio', 'mem']) {
      expect(c[k].text).toBe('—');
      expect(c[k].sort).toBe(null);
      expect(c[k].partial).toBe(false);   // ‘—+?’ 가 되지 않는다
      expect(c[k].all).toBe(true);
    }
    expect(c.vcpu.title).toBe('VM 3대의 vCPU 를 모두 못 읽었습니다');
    expect(c.mem.title).toBe('VM 3대의 메모리를 모두 못 읽었습니다');
    expect(c.vcpu.note).toBe('VM 3대 모두 못 읽음');
    expect(c.ratio.title).toBe(c.vcpu.title);
  });

  it('일부 못 읽음 — 읽은 값의 합 + partial(화면이 ‘+?’ · ‘이상’ 을 붙인다) · 못 읽은 VM 수', () => {
    const c = vmAllocCells(PART, host);
    expect(c.vcpu).toMatchObject({ text: '6', sort: 6, partial: true, all: false, note: '못 읽은 VM 1' });
    expect(c.vcpu.title).toBe('vCPU 를 못 읽은 VM 1 — 읽은 VM 만의 합(최소값)');
    expect(c.ratio).toMatchObject({ text: '0.8 : 1', sort: 0.75, partial: true, all: false });
    expect(c.mem).toMatchObject({ text: '12 GB', sort: 12288, partial: true, all: false, note: '못 읽은 VM 2' });
    expect(c.mem.title).toBe('메모리를 못 읽은 VM 2 — 읽은 VM 만의 합(최소값)');
  });

  it('VM 없음 — 0 · ‘0 GB’(모름이 아니다 — ‘—’ 와 구분) · 표지 없음', () => {
    const c = vmAllocCells(NONE, host);
    expect(c.vcpu).toMatchObject({ text: '0', sort: 0, partial: false, all: false, title: '', note: '' });
    expect(c.ratio).toMatchObject({ text: '0.0 : 1', sort: 0, partial: false, all: false });
    expect(c.mem).toMatchObject({ text: '0 GB', sort: 0, partial: false, all: false, title: '', note: '' });
  });

  it('다 읽음 — 천 단위 구분 · 한쪽만 전부 못 읽으면 그 칸만 ‘—’', () => {
    const c = vmAllocCells(FULL, host);
    expect(c.vcpu.text).toBe('1,200'); expect(c.mem.text).toBe('2,048 GB'); expect(c.ratio.text).toBe('150.0 : 1');
    const cpuOnly = vmAllocCells({ ...PART, vcpu: null, vcpuUnknown: 3, memUnknown: 0 }, host);
    expect(cpuOnly.vcpu.text).toBe('—'); expect(cpuOnly.ratio.text).toBe('—'); expect(cpuOnly.mem).toMatchObject({ text: '12 GB', partial: false });
    const memOnly = vmAllocCells({ ...PART, memMB: null, memUnknown: 3, vcpuUnknown: 0 }, host);
    expect(memOnly.mem.text).toBe('—'); expect(memOnly.vcpu).toMatchObject({ text: '6', partial: false }); expect(memOnly.ratio.text).toBe('0.8 : 1');
  });

  it('점검 묶음을 아직 못 받았거나(vm 없음) 코어 수를 모르면 ‘—’ · 정렬 값 null — 0 으로 나누거나 0 으로 정렬하지 않는다', () => {
    for (const vm of [null, undefined, 'x']) {
      const c = vmAllocCells(vm, host);
      for (const k of ['vcpu', 'ratio', 'mem']) expect(c[k]).toMatchObject({ text: '—', sort: null, partial: false, all: false, title: '' });
    }
    for (const cores of [null, 0, undefined, '']) {
      const c = vmAllocCells(PART, { ...host, cpuCores: cores });
      expect(c.ratio).toMatchObject({ text: '—', sort: null, partial: false, all: false });
      expect(c.vcpu.text).toBe('6');
    }
    // 예전 식 v.vcpu / h.cpuCores 는 vcpu 가 null 이면 0 이 돼 ‘—’ 인 행이 오름차순 맨 앞에 섰다
    expect(vmAllocCells(ALL, host).ratio.sort).not.toBe(0);
  });

  it('문구에 백틱이 없다', () => {
    for (const vm of [ALL, PART, NONE]) for (const c of Object.values(vmAllocCells(vm, host))) expect(`${c.text}${c.title}${c.note}`.includes('`')).toBe(false);
  });

  it('소스 — 표 · 상세 · 드로어가 이 함수 하나를 쓰고, 웹에 ‘전부 못 읽음’ 판정(unknown 수 === n) 사본이 없다', async () => {
    const { stripComments } = await import('../test/_stripComments.js');
    const judge = /Unknown\s*={2,3}\s*[\w.?]*\bn\b|\bn\s*={2,3}\s*[\w.?]*Unknown/;
    for (const f of ['views/Hosts.jsx', 'views/HostDetail.jsx', 'views/hosts/hostDrawerText.js', 'views/hostChecksText.js']) {
      const code = stripComments(src(f));
      expect(code, f).toMatch(/vmAllocCells\(/);
      expect(judge.test(code), `${f} 에 판정 사본`).toBe(false);
    }
    // 원래 합을 직접 그리던 식이 되살아나지 않는다(null 이 '—+?' · 0 으로 정렬되던 자리)
    const hosts = stripComments(src('views/Hosts.jsx'));
    expect(hosts).not.toMatch(/numText\(v\.vcpu\)|gbText\(v\.memMB\)|v\.vcpu\s*\/\s*h\.cpuCores/);
    const detail = stripComments(src('views/HostDetail.jsx'));
    expect(detail).not.toMatch(/numText\(vmSum\.vcpu\)|gbText\(vmSum\.memMB\)|ratioText\(vmSum\./);
    expect(stripComments(src('views/hosts/hostDrawerText.js'))).not.toMatch(/fmt\(vm\.vcpu\)|ratioText\(vm\.vcpu/);
  });
});
