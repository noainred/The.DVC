// v2.803 ESXi 호스트 화면 '엑셀 수준 상세' — 열 묶음 · 저장값 · 점검 열 글자 · 요약 · 칩(승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1 ①).
//   '—' 는 못 읽은 값(0 이 아님) · 묶음을 못 읽었으면 칩 수는 null · 구성·보안 판정은 hostCfgFindings 하나 · 기본 묶음은 끌 수 없다.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COL_GROUPS, COLUMNS, FIXED_GROUP, parseColPrefs, stringifyColPrefs, visibleColumns, secCountsOf, secText, secTone, uplinkDownOf, nicLinkDownOf, deadPathsOf,
  uptimeDays, coresText, gbText, kwText, ratioText, hwCell, bootCell, veeamCell, hostKpis, CHECK_CHIPS, chipCounts, matchesChip, filterHostsExt, focusLabelExt, reasonBadges,
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
