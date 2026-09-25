/**
 * 베어메탈 사용률(v2.550) 회귀 — 사용자 요청 "여기에 분류된 서버들만 CPU memory disk Network HBA
 * 사용율을 수집하고 싶어"(서버 분석 › 구분 › Baremetal).
 *
 * 고정하는 것은 **정직성 규칙과 산수**다:
 *  · 첫 표본·카운터 리셋·간격 비정상은 `null`(0 이 아니다).
 *  · 빈 문자열이 0 으로 둔갑하지 않는다(v2.550 초판의 실제 결함).
 *  · 링크 속도를 모르면 사용률(%)을 내지 않는다.
 *  · '없는 것'(FC 없음)과 '못 읽은 것'을 구분한다.
 *  · 대상 해석에서 엣지 위임·법인 미선택·계정 없음이 **사유별로** 갈린다.
 *  · 일 롤업에서 `null` 지표는 평균의 분모에 들어가지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { perSecond, cpuPctFromJiffies, busyPct, linkPct, maxOrNull, sumStrict, MAX_SPAN_MS } from '../src/bmusage/rates.js';
import { splitSections, parseProcStat, parseMemInfo, parseDiskstats, parseNetDev, parseNetInfo, parseFcHosts, isWholeDisk } from '../src/bmusage/parse/linuxProc.js';
import { parseWinPerf, parseKv } from '../src/bmusage/parse/winPerf.js';
import { resolveTargets, publicTarget, indexOsHosts, hostKey, NO_PATH_REASON } from '../src/bmusage/targets.js';
import { buildUsage } from '../src/bmusage/usage.js';
import { normalizeSettings, DEFAULTS } from '../src/bmusage/settings.js';
import { linuxCommand, winCommand, shapeLinux, WIN_PS } from '../src/bmusage/collectors/osSsh.js';
import { dayKey, METRICS } from '../src/bmusage/db.js';
import { applyScope } from '../src/routes/api/bmUsage.js';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

// ── 환산 코어 ────────────────────────────────────────────────────────────────
test('첫 표본·리셋·간격 비정상은 0 이 아니라 null', () => {
  assert.equal(perSecond(null, 100, null, 1_000), null, '첫 표본');
  assert.equal(perSecond(1_100, 100, 0, 1_000), null, '카운터 리셋(음수 델타)');
  assert.equal(perSecond(100, 200, 0, MAX_SPAN_MS + 1), null, '간격 상한 초과');
  assert.equal(perSecond(100, 200, 1_000, 500), null, '시계 역행');
  assert.equal(perSecond(100, 1_100, 0, 1_000), 1_000, '정상 — 초당 1,000');
});

test('CPU 는 iowait 를 idle 쪽에 넣는다', () => {
  // idle 만 세면 디스크 대기 중인 서버가 CPU 100% 로 보인다.
  const prev = { total: 1_000, idle: 900 };
  const cur = { total: 2_000, idle: 1_700 };
  assert.equal(cpuPctFromJiffies(prev, cur), 20);
  assert.equal(cpuPctFromJiffies(null, cur), null);
  assert.equal(cpuPctFromJiffies(cur, prev), null, '리셋은 판정 보류');
  assert.equal(cpuPctFromJiffies(cur, cur), null, '같은 표본은 판정 보류');
});

test('속도를 모르면 사용률(%)을 지어내지 않는다', () => {
  assert.equal(linkPct(125e6, null), null);
  assert.equal(linkPct(125e6, 0), null);
  assert.equal(linkPct(125e6, 10e9), 10);
  assert.equal(linkPct(null, 10e9), null);
});

test('디스크 busy 는 io_ticks 증가 / 경과', () => {
  assert.equal(busyPct(0, 500, 0, 1_000), 50);
  assert.equal(busyPct(500, 0, 0, 1_000), null, '리셋');
  assert.equal(busyPct(0, 5_000, 0, 1_000), 100, '상한 100');
});

test('전부 null 이면 합·최대도 null — 부분 합을 만들지 않는다', () => {
  assert.equal(maxOrNull([null, null]), null);
  assert.equal(maxOrNull([null, 5, 9]), 9);
  assert.equal(sumStrict([1, null, 3]), null, '일부가 null 이면 합하지 않는다');
  assert.equal(sumStrict([1, 2]), 3);
  assert.equal(sumStrict([]), null);
});

// ── Linux 파서 ───────────────────────────────────────────────────────────────
test('/proc/meminfo — MemAvailable 이 없으면 폴백하고 출처를 밝힌다', () => {
  const a = parseMemInfo(['MemTotal: 100 kB', 'MemAvailable: 40 kB']);
  assert.equal(a.availSource, 'MemAvailable');
  assert.equal(a.usedPct, 60);
  const b = parseMemInfo(['MemTotal: 100 kB', 'MemFree: 10 kB', 'Buffers: 5 kB', 'Cached: 25 kB']);
  assert.equal(b.availSource, 'MemFree+Buffers+Cached');
  assert.equal(b.usedPct, 60);
  assert.equal(parseMemInfo(['MemTotal: 100 kB']), null, '가용을 모르면 만들지 않는다');
});

test('diskstats — 파티션·loop 를 빼고 물리 디스크만 센다', () => {
  const names = new Set(['sda', 'sda1', 'nvme0n1', 'nvme0n1p1', 'dm-0', 'loop0']);
  assert.equal(isWholeDisk('sda', names), true);
  assert.equal(isWholeDisk('sda1', names), false, '부모가 있으면 파티션');
  assert.equal(isWholeDisk('nvme0n1p1', names), false);
  assert.equal(isWholeDisk('nvme0n1', names), true);
  assert.equal(isWholeDisk('dm-0', names), true);
  assert.equal(isWholeDisk('loop0', names), false);
  const rows = parseDiskstats(['   8 0 sda 1 0 2000 3 4 0 4000 6 0 1500 9', '   8 1 sda1 1 0 2 3 4 0 5 6 0 7 8', '   7 0 loop0 0 0 0 0 0 0 0 0 0 0 0']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].readBytes, 2000 * 512, '섹터는 항상 512B');
  assert.equal(rows[0].ioTicksMs, 1500);
});

test('net/dev 는 lo 를 뺀다 · 링크 속도 -1 은 null', () => {
  const nets = parseNetDev(['  lo: 1 2 0 0 0 0 0 0 1 2', '  eth0: 5000 1 0 0 0 0 0 0 7000 2']);
  assert.equal(nets.length, 1);
  assert.equal(nets[0].iface, 'eth0');
  const info = parseNetInfo(['eth0 10000 up', 'eth1 -1 down']);
  assert.equal(info.eth0.bitsPerSec, 10e9);
  assert.equal(info.eth1.bitsPerSec, null, '-1 은 모른다(0 이 아니다)');
});

test('FC — 16진 words 를 4바이트로 · unknown 속도는 null', () => {
  const fc = parseFcHosts(['host5|Online|16 Gbit|0x1f4|500', 'host6|Linkdown|unknown||']);
  assert.equal(fc[0].bitsPerSec, 16e9);
  assert.equal(fc[0].txBytes, 0x1f4 * 4);
  assert.equal(fc[0].rxBytes, 500 * 4);
  assert.equal(fc[1].bitsPerSec, null);
  assert.equal(fc[1].txBytes, null, '빈 값은 0 이 아니다');
});

test("shapeLinux — '없는 것(absent)' 과 '못 읽은 것(missing)' 을 구분한다", () => {
  const base = ['##STAT', 'cpu  1 2 3 400 5', '##MEM', 'MemTotal: 100 kB', 'MemAvailable: 40 kB',
    '##DISK', '8 0 sda 1 0 2 3 4 0 5 6 0 7 8', '##NET', '  eth0: 1 2 0 0 0 0 0 0 3 4',
    '##NETINFO', 'eth0 1000 up', '##FC', '##TICK', '100', '##DF', '##HOST', 'Linux 5.14 bm-01'];
  const a = shapeLinux(base.join('\n'), []);
  assert.ok(a.absent.includes('hba'), 'FC 디렉터리가 비었으면 absent');
  assert.ok(a.absent.includes('diskspace'), '마운트를 등록하지 않았으면 absent');
  assert.deepEqual(a.missing, [], '이 경우 missing 은 없다');
  const b = shapeLinux(base.join('\n'), ['/']);
  assert.ok(b.missing.includes('diskspace'), '마운트를 등록했는데 df 가 비면 missing');
  assert.equal(shapeLinux('bash: syntax error', []), null, '구획 표지가 없으면 형식 미인식');
});

test('Linux 명령은 sanitize 된 마운트만 넣는다', () => {
  const cmd = linuxCommand(['/', '/data']);
  assert.ok(cmd.includes('df -P -k -- / /data'));
  assert.ok(cmd.includes('##STAT') && cmd.includes('##FC') && cmd.includes('##NETINFO'));
  assert.ok(!linuxCommand([]).includes('df -P -k --'), '마운트가 없으면 df 를 부르지 않는다');
});

test('Windows 는 -EncodedCommand(UTF-16LE base64) 로 보낸다 — 인용부호 사고가 구조적으로 없다', () => {
  const cmd = winCommand();
  assert.ok(cmd.startsWith('powershell -NoProfile -NonInteractive -EncodedCommand '));
  const b64 = cmd.split(' ').pop();
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), WIN_PS, 'base64 왕복 일치');
  assert.ok(!/["']/.test(cmd), '셸에 넘기는 문자에 인용부호가 없다');
});

// ── Windows 파서 ─────────────────────────────────────────────────────────────
test('⚠ 빈 문자열이 0 으로 둔갑하지 않는다 (v2.550 초판의 실제 결함)', () => {
  // `Number('') === 0` 이라 그냥 두면 '여유 공간 미상' 이 **디스크 100% 가득**으로 계산됐다.
  const r = parseWinPerf('DISK=C:|12|500107862016|120000000000\nDISK=D:|3|2000398934016|\nNIC=eth|12500000|0');
  assert.equal(r.disks[0].usedPct, 76);
  assert.equal(r.disks[1].freeBytes, null);
  assert.equal(r.disks[1].usedPct, null, "여유를 모르면 사용률도 모른다 — 100% 라고 말하면 오류 없이 틀린 값이다");
  assert.equal(r.nics[0].bitsPerSec, null, '대역폭 0 은 카운터 기본값 = 모른다');
  assert.equal(r.nics[0].pct, null);
});

test('Windows — 읽은 항목/못 읽은 항목을 밝힌다', () => {
  const r = parseWinPerf('CPU_PCT=37\nMEM_TOTAL_KB=100\nMEM_FREE_KB=40');
  assert.deepEqual(r.read.sort(), ['cpu', 'mem']);
  assert.deepEqual(r.missing.sort(), ['disk', 'hba', 'net']);
  assert.equal(r.mem.usedPct, 60);
});

test('parseKv — 같은 키가 반복되면 배열, 값 안의 = 는 자르지 않는다', () => {
  const kv = parseKv('A=1\nA=2\nB=x=y');
  assert.deepEqual(kv.A, ['1', '2']);
  assert.equal(kv.B, 'x=y');
});

// ── 대상 해석 ────────────────────────────────────────────────────────────────
const BM = [
  { serverId: 's1', fleetId: 'f1', name: 'bm-01', serviceTag: 'ABC1234', vcenterId: 'vc1' },
  { serverId: 'host:vc1:esx-9', fleetId: 'esx-9', name: 'esx-9', serviceTag: '', vcenterId: 'vc1' },
  { serverId: 's3', fleetId: 'f3', name: 'bm-03', serviceTag: 'ZZZ9', vcenterId: 'vc2' },
  { serverId: 's4', fleetId: 'f4', name: 'bm-04', serviceTag: 'QQQ1', vcenterId: 'vc1', remoteAgent: 'SEOUL' },
  { serverId: 's5', fleetId: 'f5', name: 'bm-05', serviceTag: 'NOVC1', vcenterId: '' },
];
const REG = [{ id: 's1', host: '10.0.0.1', username: 'root', password: 'x', serviceTag: 'ABC1234' },
  { id: 's3', host: '10.0.0.3', username: 'root', password: 'x', serviceTag: 'ZZZ9' },
  { id: 's5', host: '10.0.0.5', username: 'root', password: '', serviceTag: 'NOVC1' }];
const OSH = [{ id: 'b1', host: '10.0.0.1', name: 'bm-01', username: 'root', password: 'y', mounts: ['/', '/data'] }];

test('대상 해석 — 사유가 갈린다(한 문구로 덮지 않는다)', () => {
  const r = resolveTargets({ bareMetal: BM, registry: REG, bmServers: OSH,
    settings: { corps: { vc1: true }, osSsh: true, idracTelemetry: true }, isEdge: false, agentName: 'CENTRAL' });
  assert.equal(r.targets.length, 1);
  assert.deepEqual(r.targets[0].paths, ['idrac', 'os'], 'OS·iDRAC 둘 다 있는 서버');
  const by = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
  assert.equal(by['esx-9'], 'no-idrac', '수동 태그로 베어메탈이 된 ESXi 호스트');
  assert.equal(by['bm-03'], 'corp-off');
  assert.equal(by['bm-04'], 'edge-delegated');
  assert.equal(by['bm-05'], 'unassigned', '법인 귀속 없음은 기본 제외');
  for (const s of r.skipped) assert.ok(NO_PATH_REASON[s.reason], `사유 문구 없음: ${s.reason}`);
  assert.equal(r.counts.both, 1);
});

test('엣지는 자기 것만, 중앙은 위임 아닌 것만 — 같은 서버를 두 곳에서 찌르지 않는다', () => {
  const opt = { bareMetal: BM, registry: [...REG, { id: 's4', host: '10.0.0.4', username: 'root', password: 'x', serviceTag: 'QQQ1' }],
    bmServers: OSH, settings: { corps: { vc1: true, vc2: true }, osSsh: true, idracTelemetry: true } };
  const edge = resolveTargets({ ...opt, isEdge: true, agentName: 'SEOUL' });
  assert.deepEqual(edge.targets.map((x) => x.name), ['bm-04'], '엣지는 자기 agent 것만');
  const central = resolveTargets({ ...opt, isEdge: false, agentName: 'CENTRAL' });
  assert.ok(!central.targets.some((x) => x.name === 'bm-04'), '중앙은 위임 서버를 가져가지 않는다');
});

test('publicTarget 은 자격증명을 싣지 않는다', () => {
  const r = resolveTargets({ bareMetal: BM, registry: REG, bmServers: OSH,
    settings: { corps: { vc1: true }, osSsh: true, idracTelemetry: true }, isEdge: false, agentName: 'C' });
  const pub = publicTarget(r.targets[0]);
  const json = JSON.stringify(pub);
  assert.ok(!json.includes('"password"'), 'password 키가 없어야 한다');
  assert.ok(!json.includes('"x"') && !json.includes('"y"'), '비밀번호 값이 없어야 한다');
  assert.equal(pub.idrac, undefined);
  assert.equal(pub.osHost, undefined);
  assert.equal(pub.idracHost, '10.0.0.1');
  assert.equal(pub.osMounts, 2);
});

test('⚠ iDRAC host 의 스킴을 떼고 OS 계정을 찾는다 (v2.550 실화면 검증에서 발견한 결함)', () => {
  // `idrac/registry.js` 는 `https://10.0.0.1` 로, `bmstor` 는 `10.0.0.1` 로 저장한다 —
  // 그대로 비교하면 **OS 경로가 영원히 붙지 않는다**(디스크·네트워크·HBA 를 못 읽는다).
  assert.equal(hostKey('https://10.0.0.1'), '10.0.0.1');
  assert.equal(hostKey('http://10.0.0.1:443/'), '10.0.0.1');
  assert.equal(hostKey('HTTPS://Host.Local/'), 'host.local');
  assert.equal(hostKey('https://[fd00::1]:443'), 'fd00::1', 'IPv6 리터럴');
  assert.equal(hostKey(''), '');

  const r = resolveTargets({
    bareMetal: [{ serverId: 'x1', fleetId: 'fx', name: 'srv-a', serviceTag: 'TAGA', vcenterId: 'vc1' }],
    registry: [{ id: 'x1', host: 'https://10.9.9.9', username: 'root', password: 'p', serviceTag: 'TAGA' }],
    bmServers: [{ id: 'o1', host: '10.9.9.9', name: 'something-else', username: 'root', password: 'q', mounts: ['/'] }],
    settings: { corps: { vc1: true }, osSsh: true, idracTelemetry: true }, isEdge: false, agentName: 'C',
  });
  assert.deepEqual(r.targets[0].paths, ['idrac', 'os'], '스킴을 떼면 host 로 OS 계정을 찾는다');
  assert.deepEqual(r.targets[0].missing, [], 'OS 계정이 붙었으므로 누락이 없다');
});

test('OS 계정 색인 — host 중복은 처음 것을 쓰고 개수를 밝힌다', () => {
  const idx = indexOsHosts([{ host: 'H1', name: 'a', mounts: [] }, { host: 'h1', name: 'b', mounts: [] }]);
  assert.equal(idx.duplicates, 1);
  assert.equal(idx.byHost.get('h1').name, 'a');
});

test('키 등급 — 서비스태그 > fleetId > serverId', () => {
  const r = resolveTargets({ bareMetal: BM, registry: REG, bmServers: OSH,
    settings: { corps: { vc1: true, vc2: true }, osSsh: true, idracTelemetry: true }, isEdge: false, agentName: 'C' });
  const t1 = r.targets.find((x) => x.name === 'bm-01');
  assert.equal(t1.key, 'ABC1234');
  assert.equal(t1.keyKind, 'serviceTag');
  const esx = r.skipped.find((x) => x.name === 'esx-9');
  assert.equal(esx.keyKind, 'fleetId', '서비스태그가 없으면 fleetId');
});

// ── 합성 ─────────────────────────────────────────────────────────────────────
const C1 = { cpu: { total: 1_000, idle: 900 }, disks: [{ name: 'sda', ioTicksMs: 0 }],
  nets: [{ iface: 'eth0', rxBytes: 0, txBytes: 0, bitsPerSec: 10e9, state: 'up' }],
  hbas: [{ host: 'host5', txBytes: 0, rxBytes: 0, bitsPerSec: 16e9, speedRaw: '16 Gbit', state: 'Online' }] };
const C2 = { cpu: { total: 2_000, idle: 1_700 }, disks: [{ name: 'sda', ioTicksMs: 500 }],
  nets: [{ iface: 'eth0', rxBytes: 62_500_000, txBytes: 62_500_000, bitsPerSec: 10e9, state: 'up' }],
  hbas: [{ host: 'host5', txBytes: 1e8, rxBytes: 1e8, bitsPerSec: 16e9, speedRaw: '16 Gbit', state: 'Online' }] };
const TG = { key: 'ABC1', name: 'bm-01', vcenterId: 'vc1' };

test('Linux 첫 주기 — 메모리만 나오고 나머지는 null, 화면 문구가 그 사실을 말한다', () => {
  const os = { ok: true, osKind: 'linux', counters: C1, mem: { usedPct: 39.1 }, mounts: [{ mount: '/', usedPct: 40 }], read: [], missing: [], absent: [] };
  const r = buildUsage({ target: TG, os, prev: null, now: 1_000 });
  assert.equal(r.row.mem_pct, 39.1, '메모리는 순간값이라 첫 주기부터 나온다');
  assert.equal(r.row.disk_used_pct, 40, 'df 도 순간값');
  assert.equal(r.row.cpu_pct, null);
  assert.equal(r.row.disk_busy_pct, null);
  assert.equal(r.row.net_pct, null);
  assert.equal(r.row.hba_pct, null);
  assert.ok(r.notes.some((x) => x.includes('첫 수집')), '기다리면 되는지를 말한다');
  assert.equal(r.detail.firstSample, true);
});

test('Linux 둘째 주기 — 산수가 맞는다', () => {
  const os1 = { ok: true, osKind: 'linux', counters: C1, mem: { usedPct: 39.1 }, mounts: [], read: [], missing: [], absent: [] };
  const a = buildUsage({ target: TG, os: os1, prev: null, now: 1_000 });
  const b = buildUsage({ target: TG, os: { ...os1, counters: C2 }, prev: a.next, now: 2_000 });
  assert.equal(b.row.cpu_pct, 20, '(1000 총증가 - 800 idle증가)/1000');
  assert.equal(b.row.disk_busy_pct, 50, '500ms busy / 1000ms 경과');
  // v2.590 F9: 사용률은 전이중 방향별 max(rx, tx) ÷ 링크 속도 — rx·tx 가 반씩이면 합(125MB/s)이 아니라 62.5MB/s 기준.
  assert.equal(b.row.net_pct, 5, 'max(rx,tx)=62.5MB/s × 8 / 10Gb');
  assert.equal(b.row.net_bps, 125_000_000, '처리량은 여전히 rx+tx 합');
  assert.equal(b.row.hba_pct, 5, 'max(rx,tx)=100MB/s × 8 / 16Gb');
  assert.equal(b.row.src, 'os');
});

test('OS 가 실패하면 iDRAC 이 빈 칸만 채우고 출처를 밝힌다', () => {
  const r = buildUsage({ target: TG, os: { ok: false, error: '연결 거부' },
    idrac: { ok: true, cpuPct: 31, memPct: 55, ioPct: 8, usedIds: { cpuPct: 'CPUUsage' } }, now: 3_000 });
  assert.equal(r.row.cpu_pct, 31);
  assert.equal(r.srcOf.cpu, 'idrac');
  assert.equal(r.row.io_pct, 8);
  assert.equal(r.row.disk_busy_pct, null, 'iDRAC 에는 디스크 개별 사용률이 없다');
  assert.equal(r.row.hba_pct, null);
  assert.equal(r.detail.osError, '연결 거부');
});

test('OS 가 있으면 OS 가 이긴다 — 두 값이 다를 수 있으므로 출처를 남긴다', () => {
  const os1 = { ok: true, osKind: 'windows', cpuPct: 12, mem: { usedPct: 30 }, disks: [], nics: [], hbas: [], read: ['cpu', 'mem'], missing: [] };
  const r = buildUsage({ target: TG, os: os1, idrac: { ok: true, cpuPct: 99, memPct: 99 }, now: 1 });
  assert.equal(r.row.cpu_pct, 12);
  assert.equal(r.srcOf.cpu, 'os');
  assert.equal(r.srcOf.mem, 'os');
});

test('Windows 는 첫 주기부터 값이 나온다(순간값)', () => {
  const os1 = { ok: true, osKind: 'windows', cpuPct: 37, mem: { usedPct: 68.8 },
    disks: [{ name: 'C:', busyPct: 12, usedPct: 76 }], nics: [{ iface: 'e', bytesPerSec: 1e6, bitsPerSec: 1e9, pct: 0.8 }],
    hbas: [], read: ['cpu', 'mem', 'disk', 'net'], missing: ['hba'] };
  const r = buildUsage({ target: TG, os: os1, prev: null, now: 1 });
  assert.equal(r.row.cpu_pct, 37);
  assert.equal(r.row.disk_busy_pct, 12);
  assert.equal(r.row.net_pct, 0.8);
  assert.equal(r.next, null, 'Windows 는 다음 주기용 누적값이 필요 없다');
});

test('⚠ exec 시한은 위치 인자다 — 객체를 넘기면 NaN 이 되어 항상 즉시 타임아웃된다', () => {
  /*
   * `proxy/sshExec.js:87` 의 `exec(conn, command, timeoutMs)` 는 **위치 인자**이고
   * `setTimeout(fn, Math.max(1000, timeoutMs))` 을 쓴다. 객체를 넘기면 `Math.max` 가 **NaN** 이 되고
   * `setTimeout(fn, NaN)` 은 **즉시 발화**한다(실측 8ms) — OS SSH 수집이 항상 즉시 실패한다.
   * 목 데이터로는 드러나지 않아 자체 재검토에서 잡았다. 소스를 검사해 재발을 막는다.
   */
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/bmusage/collectors/osSsh.js'), 'utf8');
  // ⚠ 정규식이 첫 `)` 에서 멈추면 `exec(linuxCommand(mounts)` 만 잡힌다 — **줄 단위**로 본다.
  const calls = src.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('await exec('));
  assert.ok(calls.length >= 2, `exec 호출을 찾지 못했다: ${calls.length}`);
  for (const c of calls) {
    assert.ok(!/\{\s*timeoutMs/.test(c), `객체를 넘기고 있다(NaN → 즉시 타임아웃): ${c}`);
    /*
     * ⚠ 요구는 '**숫자**를 위치 인자로' 다 — 상수 이름으로 좁히면 안 된다. v2.550.3 이 시한을
     *   세션 예산 기반 `slice()`(남은 시간, 숫자 반환)로 바꾸자 이 검사가 깨졌다. 규칙의 의도는
     *   "객체를 넘기면 NaN 이 된다" 이고 `slice()` 는 그 의도를 만족한다.
     */
    assert.match(c, /,\s*(?:[A-Z_]+|slice\(\))\s*\);$/, `시한을 숫자 위치 인자로 넘겨야 한다: ${c}`);
  }
  // NaN 이 즉시 발화한다는 사실 자체도 고정한다(근거를 문서가 아니라 테스트가 갖는다).
  assert.ok(Number.isNaN(Math.max(1000, { timeoutMs: 30_000 })));
});

test('⚠ 작업 로그의 host 는 내부 target 필드를 읽는다 — publicTarget 전용 필드를 읽으면 빈 칸이 된다', () => {
  // `idracHost` 는 `publicTarget()` 이 만드는 **응답용** 필드다(targets.js:160). 폴러가 그것을
  // 읽으면 iDRAC 전용 서버의 작업 로그 host 가 항상 비어 '어느 장비였나' 를 알 수 없다.
  /* ⚠ **주석을 먼저 지운다** — 규칙을 설명하는 주석에 그 문자열이 들어 있으면 검사가 자기
     주석을 잡는다(v2.550 에서 실제로 그랬다. `secAudit2535.test.js` 와 같은 규약). */
  const raw = fs.readFileSync(path.join(import.meta.dirname, '../src/bmusage/poller.js'), 'utf8');
  const src = stripComments(raw);   // v2.613 TESTDOC2613-08
  assert.ok(!/target\.idracHost/.test(src), 'publicTarget 전용 필드를 폴러가 읽고 있다');
  assert.match(src, /target\.idrac\?\.host/, '내부 target 의 idrac.host 를 읽어야 한다');
});

// ── 설정·DB·scope ────────────────────────────────────────────────────────────
test('설정 — 하한·상한을 서버가 강제하고 켠 법인만 남긴다', () => {
  const s = normalizeSettings({ intervalMs: 5, corps: { a: true, b: false }, rawRetentionDays: 9_999, dailyRetentionDays: 1 });
  assert.equal(s.intervalMs, 60_000, '하한 60초');
  assert.deepEqual(Object.keys(s.corps), ['a'], 'false 를 쌓아 두지 않는다');
  assert.equal(s.rawRetentionDays, 365, '상한');
  assert.equal(s.dailyRetentionDays, 30, '하한');
  assert.equal(normalizeSettings({}).enabled, false, '기본 꺼짐(opt-in)');
  assert.equal(DEFAULTS.intervalMs, 5 * 60_000, '사용자가 고른 기본 주기 5분');
  assert.equal(DEFAULTS.rawRetentionDays, 90);
  assert.equal(DEFAULTS.dailyRetentionDays, 365 * 5);
});

test('DB open 은 진행 중인 시도를 공유한다 — 동시 호출이 거짓 "SQLite 미지원" 을 만들지 않는다', async () => {
  // v2.550 실화면 검증에서 잡은 결함: `_tried=true` 를 await 앞에 세워 두 번째 동시 호출이
  // `available:false` 를 받았고, 화면이 "이 Node 는 SQLite 를 지원하지 않습니다" 라는 **틀린 원인**을 말했다.
  const db = await import('../src/bmusage/db.js');
  db._resetForTest();
  const r = await Promise.all(Array.from({ length: 8 }, () => db.available()));
  assert.equal(new Set(r).size, 1, `동시 호출의 답이 갈렸다: ${r.join(',')}`);
});

test('하루 경계는 한국 시각(UTC+9) — UTC 로 자르면 오전 9시에 날이 바뀐다', () => {
  assert.equal(dayKey(Date.parse('2026-09-17T00:00:00Z')), '2026-09-17');
  assert.equal(dayKey(Date.parse('2026-09-17T14:59:59Z')), '2026-09-17');
  assert.equal(dayKey(Date.parse('2026-09-17T15:00:00Z')), '2026-09-18', 'KST 자정');
});

test('지표 열 계약 — 사용자가 지정한 다섯 지표가 모두 있다', () => {
  const cols = METRICS.map((m) => m.col);
  for (const need of ['cpu_pct', 'mem_pct', 'disk_busy_pct', 'net_pct', 'hba_pct']) {
    assert.ok(cols.includes(need), `빠진 지표: ${need}`);
  }
  assert.equal(new Set(cols).size, cols.length, '열 이름 중복 없음');
});

test('scope — 범위 계정에는 그 법인만, 귀속 없는 것은 숨긴다', () => {
  const list = [{ vcenterId: 'vc1' }, { vcenterId: 'vc2' }, { vcenterId: '' }];
  assert.equal(applyScope(list, null).length, 3, '전체 범위 계정은 전량');
  const scoped = applyScope(list, ['vc1']);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].vcenterId, 'vc1');
});

test('⚠ 사유별 개수도 scope 를 탄다 — 범위 밖 법인의 서버 대수가 새지 않는다', () => {
  // v2.550 자체 재검토에서 잡은 결함: `counts.byReason` 을 그대로 내보내 범위 계정이
  // 다른 법인의 서버 대수를 알 수 있었다. 라우트는 **보이는 목록에서 다시 센다**.
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/routes/api/bmUsage.js'), 'utf8');
  assert.ok(/const skippedCounts = allowed/.test(src), '범위 계정은 개수를 다시 세야 한다');
  assert.ok(/const counts = allowed/.test(src), 'KPI 개수도 다시 세야 한다');
  assert.ok(!/skippedCounts: tg\.counts\.byReason/.test(src), '무스코프 개수를 그대로 내보내면 안 된다');
});

test('⚠ 추이 조회의 agent 키가 적재 키와 같다 — 엣지에서 추이가 비지 않게', () => {
  /*
   * `poller.js` 는 `insertUsage(rows, config.agent?.name || '')` 로 적재한다(엣지=AGENT_NAME).
   * 라우트가 조회를 `''` 로 굳히면 **엣지에서 추이가 영원히 빈다** — 수집은 되는데 상세가 비어
   * '저장이 안 된다' 로 보인다. 두 파일이 같은 식을 쓰는지 소스로 고정한다.
   */
  const route = fs.readFileSync(path.join(import.meta.dirname, '../src/routes/api/bmUsage.js'), 'utf8');
  const poller = fs.readFileSync(path.join(import.meta.dirname, '../src/bmusage/poller.js'), 'utf8');
  assert.match(poller, /insertUsage\(rows, config\.agent\?\.name \|\| ''\)/, '적재 키');
  assert.match(route, /const agent = config\.agent\?\.name \|\| '';/, '조회 키가 적재 키와 같아야 한다');
  assert.ok(!/const agent = tg\.isEdge \? '' : ''/.test(route), "'' 로 굳힌 코드가 남아 있다");
});
