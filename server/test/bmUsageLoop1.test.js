/**
 * 베어메탈 사용률 점검 반복 1회차(기준판 55d8e121) — 확정 6건 + 의심 2건을 재현한 입력으로 고정한다(D6 · D2 는 bmPerfStage6Health ② · bmTop8bBudget ①③).
 *   D1 같은 키의 OS 등록 주소가 다른 장비로 바뀌면 이전 장비 누적 카운터와 차분 → 가짜 값(재현: disk_busy 100 · net 8.7 GB/s) — 장비 식별(접속처 · btime · 호스트 이름)
 *   D3 대상 해석이 등록부 enabled:false 를 보지 않음(끈 계정으로 iDRAC Basic · SSH 로그인) — idrac-disabled · os-disabled
 *   D4 OS 등록의 agent(bmstor 엣지 위임)를 보지 않아 중앙이 엣지 법인 서버에 직접 SSH — 엣지 등록은 그 엣지 위임(다른 중앙 경로가 없을 때)
 *   D5 사유가 원인을 잘못 말함 — (a) exec 시한 · 채널 오류가 not-linux (b) iDRAC 403 · 지표 id 없음 · 인증서 불신이 unreachable
 *   의심 1 hostKey 의 /\/+$/(O(n²)) · 의심 2 물리서버 폴더 사유 색인이 키 하나(같은 키의 ESXi 행이 덮음)
 *
 * D3 · D4 불변식의 ‘기준판’ 은 **enabled · agent 칸을 지운 같은 입력**이다 — 기준판 targets.js 는 두 칸을 읽지 않으므로 그 결과가 곧 기준판 결과이고,
 *   새 판정은 두 칸이 있을 때만 갈린다. 이 동치는 작업 때 기준판 targets.js(55d8e121)를 같은 생성 입력 4,000건으로 돌려 전체 결과가 같음을 대조했다.
 * 기준 시각: 정시 −30분(docs/rules/common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop1-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

// 폴러 시험이 쓰는 등록부 — bmstor 등록부는 프로세스 첫 읽기를 캐시하므로 처음에 한 번 쓴다(바꿀 때는 실제 saveBmServer).
fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [
  { id: 'idr-1', name: 'TAG01-host', host: 'https://10.0.0.11', username: 'root', password: 'calvin', serviceTag: 'TAG01', enabled: false },   // D3: 사람이 끈 등록
] }));
fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
  { id: 'o-d1', name: 'bm-d1', host: '10.0.0.1', port: 22, username: 'mon', password: 'pw', mounts: ['/'] },                 // D1
  { id: 'o-1', name: 'TAG01-host', host: '10.0.1.11', port: 22, username: 'mon', password: 'pw', mounts: ['/'], enabled: false },   // D3
  { id: 'o-2', name: 'db02', host: '10.0.1.12', port: 22, username: 'mon', password: 'pw', mounts: ['/'], agent: 'edge-pl' },       // D4
] }));

const OS = await import('../src/bmusage/collectors/osSsh.js');
const U = await import('../src/bmusage/usage.js');
const T = await import('../src/bmusage/targets.js');
const MR = await import('../src/bmusage/missReason.js');

/* ── D1 ─────────────────────────────────────────────────────────────────── */
const linuxOut = ({ cpu, ticks, rx, tx, btime, hn }) => ['##STAT', `cpu  ${cpu} 0 ${cpu} ${cpu * 50} 0 0 0 0 0 0`, `btime ${btime}`, 'ctxt 5000',
  '##MEM', 'MemTotal: 1000000 kB', 'MemAvailable: 500000 kB',
  '##DISK', `   8       0 sda 1000 0 2000 300 500 0 1000 200 0 ${ticks} 500 0 0 0 0`,
  '##NET', 'Inter-|   Receive', ' face |bytes', `  eth0: ${rx} 10 0 0 0 0 0 0 ${tx} 20 0 0 0 0 0 0`,
  '##NETINFO', 'eth0 10000 up 1', '##HOST', `Linux ${hn} 5.14.0`, '##END'].join('\n');
const DEV_A = { cpu: 1000, ticks: 4000, rx: 1e6, tx: 2e6, btime: 1_700_000_000, hn: 'host-a' };
const DEV_B = { cpu: 9e7, ticks: 9e9, rx: 2e12, tx: 3e12, btime: 1_710_000_000, hn: 'host-b' };   // 유휴 장비 — 누적값만 크다
const shaped = (o) => ({ ...OS.shapeLinux(linuxOut(o), []), ok: true });
const tgt = (host, port = 22) => ({ key: 'K1', name: 'bm-d1', osHost: { host, port } });

test('D1 ① 순수 — 접속처 · 재부팅 · 호스트 이름이 바뀌면 첫 표본(null — 0 아님) · 같은 장비는 값 · 식별 없는 직전 표본은 예전처럼', () => {
  const t0 = NOW - 300_000;
  const a1 = U.buildUsage({ target: tgt('10.0.0.1'), os: shaped(DEV_A), now: t0 });
  assert.deepEqual(a1.next.osDev, { ep: '10.0.0.1:22', boot: 1_700_000_000, hn: 'host-a' }, '다음 주기용 식별(비밀 · 원문 없음)');
  // 재현 꼴: 같은 키 · 다른 장비(주소 변경) — 예전에는 disk_busy 100 · net_bps 1.6e10
  const b = U.buildUsage({ target: tgt('10.0.0.2'), os: shaped(DEV_B), prev: a1.next, now: NOW });
  for (const c of ['cpu_pct', 'disk_busy_pct', 'net_bps', 'net_pct']) assert.equal(b.row[c], null, `${c} 는 첫 표본(null)`);
  assert.equal(b.row.mem_pct, 50, '순간값은 그대로');
  assert.equal(b.detail.osDeviceChange, 'endpoint'); assert.equal(b.detail.firstSample, true);
  assert.match(b.notes[0], /OS 접속처\(등록 주소 · 포트\)가 달라/);
  assert.deepEqual(b.next.osDev.ep, '10.0.0.2:22', '새 장비가 다음 주기 기준');
  // 식별이 없는 직전 표본(업그레이드 직후 — 예전 상태)은 예전처럼 차분한다(모름을 ‘다른 장비’ 로 단정하지 않는다) — 기준판 동작이 이것이다
  const { osDev, ...legacy } = a1.next;
  const old = U.buildUsage({ target: tgt('10.0.0.2'), os: shaped(DEV_B), prev: legacy, now: NOW });
  assert.equal(old.row.disk_busy_pct, 100, '기준판 꼴: 다른 장비 누적과 차분하면 가짜 100%');
  assert.ok(old.row.net_bps > 1e10, `기준판 꼴: 가짜 처리량 ${old.row.net_bps}`);
  // 같은 장비 · 같은 부팅 → 값(btime 이 몇 초 흔들려도 같은 부팅)
  const a2 = U.buildUsage({ target: tgt('10.0.0.1'), os: shaped({ ...DEV_A, cpu: 1300, ticks: 34_000, rx: 3e6, tx: 4e6, btime: DEV_A.btime + 2 }), prev: a1.next, now: NOW });
  assert.equal(a2.detail.osDeviceChange, ''); assert.equal(a2.row.disk_busy_pct, 10); assert.ok(a2.row.cpu_pct > 0 && a2.row.net_bps > 0);
  // 재부팅(같은 주소 · btime 이 허용 폭 넘게 바뀜) · 같은 주소에 다른 장비(호스트 이름) — 둘 다 첫 표본
  const rb = U.buildUsage({ target: tgt('10.0.0.1'), os: shaped({ ...DEV_A, cpu: 5000, ticks: 900_000, btime: DEV_A.btime + 86_400 }), prev: a1.next, now: NOW });
  assert.equal(rb.detail.osDeviceChange, 'reboot'); assert.equal(rb.row.disk_busy_pct, null); assert.match(rb.notes[0], /다시 부팅/);
  const hn = U.buildUsage({ target: tgt('10.0.0.1'), os: shaped({ ...DEV_A, cpu: 5000, ticks: 900_000, hn: 'other' }), prev: a1.next, now: NOW });
  assert.equal(hn.detail.osDeviceChange, 'hostname'); assert.equal(hn.row.disk_busy_pct, null);
  // 포트만 바뀌어도 다른 접속처
  assert.equal(U.osDeviceChange(a1.next.osDev, U.osDeviceOf(tgt('10.0.0.1', 2222), shaped(DEV_A))), 'endpoint');
  assert.equal(U.osDeviceChange(null, U.osDeviceOf(tgt('10.0.0.1'), shaped(DEV_A))), '', '직전 식별 없음 = 모름(예전처럼)');
});

test('D1 ② iDRAC — 등록 id · 주소가 바뀌면 NIC · FC 누적을 차분하지 않는다(같은 등록이면 값)', () => {
  const nic = (bytes, at) => ({ ok: true, nics: [{ iface: 'NIC.1', rxBytes: bytes, txBytes: bytes, bitsPerSec: 10e9, at }], fcs: [] });
  const ti = (regId, host) => ({ key: 'K2', name: 'x', idrac: { regId, host } });
  const p1 = U.buildUsage({ target: ti('r1', 'https://10.0.0.21'), idrac: nic(1e6, NOW - 300_000), now: NOW - 300_000 });
  assert.deepEqual(p1.next.idracDev, { reg: 'r1', host: 'https://10.0.0.21' });
  const moved = U.buildUsage({ target: ti('r1', 'https://10.0.0.22'), idrac: nic(5e12, NOW), prev: p1.next, now: NOW });
  assert.equal(moved.row.net_bps, null, '다른 iDRAC 의 누적과 차분하지 않는다');
  assert.ok(moved.notes.some((x) => /iDRAC 등록\(id · 주소\)이 달라/.test(x)));
  const same = U.buildUsage({ target: ti('r1', 'https://10.0.0.21'), idrac: nic(1e6 + 3e8, NOW), prev: p1.next, now: NOW });
  assert.ok(same.row.net_bps > 0, `같은 등록이면 값(${same.row.net_bps})`);
  const legacy = U.buildUsage({ target: ti('r1', 'https://10.0.0.22'), idrac: nic(5e12, NOW), prev: { at: p1.next.at, idrac: p1.next.idrac }, now: NOW });
  assert.ok(legacy.row.net_bps > 1e9, '기준판 꼴(식별 없음): 다른 장비 누적과 차분한 가짜 처리량');
});

test('D1 ③ 실제 폴러 — 같은 등록의 주소를 다른 장비로 바꾼 뒤 주기: 최신값 · 원시에 가짜 값이 없다 · 다음 주기부터 값', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const P = await import('../src/bmusage/poller.js');
  const R = await import('../src/bmstor/registry.js');
  const DB = await import('../src/bmusage/db.js');
  (await import('../src/bmusage/settings.js'))._resetForTest();
  P._resetForTest();
  P._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-d1', name: 'bm-d1', serviceTag: 'DTAG1', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  const seen = [];
  P._setOsCollectorForTest(async (h) => { seen.push(h.host); return { ...shaped(h.host === '10.0.0.2' ? DEV_B : DEV_A), peak: { windowS: 0 } }; });
  t.after(() => { P._setOsCollectorForTest(null); P._setFleetForTest(null); P._resetForTest(); });
  assert.equal((await P.pollBmUsageOnce({ trigger: 'manual' })).ok, true);
  await new Promise((r) => setTimeout(r, 1_100));   // 누적 차분의 최소 간격(rates.MIN_SPAN_MS 1초)
  // 사람이 같은 등록(o-d1)의 주소를 다른 장비로 바꾼다(실제 등록부 쓰기 — 주소가 바뀌면 비밀번호는 다시 넣는다)
  const sv = R.saveBmServer({ id: 'o-d1', name: 'bm-d1', host: '10.0.0.2', port: 22, username: 'mon', password: 'pw', mounts: ['/'] });
  assert.equal(sv.ok, true, JSON.stringify(sv));
  assert.equal((await P.pollBmUsageOnce({ trigger: 'manual' })).ok, true);
  assert.deepEqual(seen, ['10.0.0.1', '10.0.0.2']);
  const row = (await DB.latestUsage()).find((x) => x.key === 'DTAG1');
  assert.ok(row, '최신값 행');
  assert.equal(row.disk_busy_pct, null, '예전: 100(가짜)'); assert.equal(row.net_bps, null, '예전: 1.6e10 B/s(가짜)'); assert.equal(row.cpu_pct, null);
  assert.equal(row.mem_pct, 50);
  assert.match((P.usageDetailFor('DTAG1')?.detail?.notes || []).join(' '), /OS 접속처/, '상세가 첫 표본인 까닭을 말한다');
  // 다음 주기(같은 새 장비 — 유휴: 누적값 그대로)는 값이 나온다(0 — 실제로 변화 없음)
  await new Promise((r) => setTimeout(r, 1_100));
  await P.pollBmUsageOnce({ trigger: 'manual' });
  const row2 = (await DB.latestUsage()).find((x) => x.key === 'DTAG1');
  assert.equal(row2.disk_busy_pct, 0); assert.equal(row2.net_bps, 0);
});

/* ── D3 · D4 ────────────────────────────────────────────────────────────── */
const RC = { readable: true, names: new Map([['c1', 'edge-a']]), byId: new Map([['c1', { id: 'c1', name: 'edge-a' }], ['edge-pl-id', { id: 'edge-pl-id', name: 'edge-pl' }]]),
  byName: new Map([['edge-a', { id: 'c1', name: 'edge-a' }], ['edge-pl', { id: 'edge-pl-id', name: 'edge-pl' }]]), firstAlias: new Map(), urlById: new Map() };
const ST = { corps: { vcA: true }, idracTelemetry: true, osSsh: true };
const resolve = (o) => T.resolveTargets({ settings: ST, remoteCollectors: RC, ...o });
const by = (r) => ({ t: Object.fromEntries(r.targets.map((x) => [x.key, x])), s: Object.fromEntries(r.skipped.map((x) => [x.key, x])) });

test('D3 ① 순수 — ‘사용 안 함’ 등록은 경로로 쓰지 않고 사유로 밝힌다(iDRAC · OS · 가상화 호스트 · 같은 주소 OS 중복은 켜진 것 · 태그로 고른 꺼진 등록은 갈아타지 않음)', () => {
  const bm = [{ serverId: 'idr-1', name: 'TAG01-host', serviceTag: 'TAG01', vcenterId: 'vcA' }];
  const reg = (o = {}) => [{ id: 'idr-1', host: 'https://10.0.0.11', username: 'u', password: 'p', ...o }];
  const osr = (o = {}) => [{ id: 'o-1', name: 'TAG01-host', host: '10.0.1.11', username: 'r', password: 'p', ...o }];
  // 기준판 재현 꼴: 둘 다 꺼짐 → 예전 paths ['idrac','os']
  const both = by(resolve({ bareMetal: bm, registry: reg({ enabled: false }), bmServers: osr({ enabled: false }) }));
  assert.equal(both.t.TAG01, undefined, '끈 계정으로 접속하지 않는다');
  assert.equal(both.s.TAG01.reason, 'os-disabled'); assert.equal(both.s.TAG01.idracIssue, 'idrac-disabled'); assert.equal(both.s.TAG01.osIssue, 'os-disabled');
  const io = by(resolve({ bareMetal: bm, registry: reg({ enabled: false }), bmServers: osr() })).t.TAG01;
  assert.deepEqual(io.paths, ['os']); assert.deepEqual(io.missing, ['idrac-disabled']); assert.equal(io.idrac, null);
  const oo = by(resolve({ bareMetal: bm, registry: reg(), bmServers: osr({ enabled: false }) })).t.TAG01;
  assert.deepEqual(oo.paths, ['idrac']); assert.deepEqual(oo.missing, ['os-disabled']); assert.equal(oo.osHost, null);
  // 고르는 순서는 그대로 — 태그로 고른 등록(같은 태그면 목록 뒤 항목)이 꺼졌으면 다른 등록으로 갈아타지 않는다(공통 태그면 남의 iDRAC — 대상을 늘리지 않는다)
  const tagBm = [{ serverId: 'x9', name: 'n9', serviceTag: 'TAG09', vcenterId: 'vcA' }];
  const regs = [{ id: 'r-on', serviceTag: 'TAG09', host: 'https://10.0.0.91', username: 'u', password: 'p' }, { id: 'r-off', serviceTag: 'TAG09', host: 'https://10.0.0.92', username: 'u', password: 'p', enabled: false }];
  assert.equal(by(resolve({ bareMetal: tagBm, registry: regs, bmServers: [] })).s.TAG09.reason, 'idrac-disabled');
  assert.equal(by(resolve({ bareMetal: tagBm, registry: [...regs].reverse(), bmServers: [] })).t.TAG09.idrac.regId, 'r-on', '켜진 등록이 고른 등록이면 예전 그대로');
  // 같은 주소의 OS 등록 둘(꺼진 것이 앞) — 켜진 것(예전: 앞 항목 = 꺼진 등록)
  const dup = by(resolve({ bareMetal: bm, registry: [], bmServers: [...osr({ id: 'o-off', enabled: false }), ...osr({ id: 'o-on' })] })).t.TAG01;
  assert.equal(dup.osHost.id, 'o-on');
  // 가상화 호스트도(iDRAC 하나)
  const v = by(T.resolveTargets({ settings: { ...ST, includeVirtualization: true }, vcenters: [{ id: 'vcA' }], registry: [{ id: 'idr-v', host: 'https://10.0.0.31', username: 'u', password: 'p', enabled: false }],
    virtHosts: [{ name: 'esx1', vcenterId: 'vcA', idracServerId: 'idr-v', serviceTag: 'VTAG1' }] }));
  assert.equal(v.s.VTAG1.reason, 'idrac-disabled'); assert.equal(v.t.VTAG1, undefined);
  for (const c of ['idrac-disabled', 'os-disabled', 'os-edge']) assert.ok(T.NO_PATH_REASON[c], `사유 문구 ${c}`);
});

test('D3 ② 엣지 위임 판정(v2.961)과 모순 없음 — 꺼진 등록만 있는 원격 출처 서버는 그 엣지 위임 · 켜진 등록이 있으면 예전 그대로', () => {
  const rb = [{ serverId: 'remote:c1:5', name: 'db05', serviceTag: 'TAG05', vcenterId: 'vcA', source: 'remote', collectorId: 'c1' }];
  const off = by(resolve({ bareMetal: rb, registry: [{ id: 'remote:c1:5', host: 'https://10.0.0.15', username: 'u', password: 'p', enabled: false }], bmServers: [{ id: 'o5', name: 'db05', host: '10.0.1.15', username: 'r', password: 'p', enabled: false }] }));
  assert.equal(off.s.TAG05.reason, 'edge-delegated'); assert.equal(off.s.TAG05.agent, 'edge-a'); assert.equal(off.s.TAG05.delegatedBy, 'collector');
  const on = by(resolve({ bareMetal: rb, registry: [], bmServers: [{ id: 'o5', name: 'db05', host: '10.0.1.15', username: 'r', password: 'p' }] }));
  assert.deepEqual(on.t.TAG05.paths, ['os'], '켜진 등록이 있으면 이 노드 대상(v2.961 불변식)');
  // 등록부를 못 읽은 동안은 위임으로 단정하지 않는다(반증 F1 그대로)
  const unread = by(resolve({ bareMetal: rb, registry: [], bmServers: [], registryUnread: { idrac: true, os: false } }));
  assert.notEqual(unread.s.TAG05.reason, 'edge-delegated');
});

test('D4 ① 순수 — agent 있는 OS 등록은 그 엣지의 등록: 다른 중앙 경로가 없으면 엣지 위임(이름 정규화) · 있으면 그 경로 + os-edge · 엣지 노드는 자기 이름만', () => {
  const bm = [{ serverId: 'x2', name: 'db02', serviceTag: 'TAG02', vcenterId: 'vcA' }];
  const osr = (agent) => [{ id: 'o-2', name: 'db02', host: '10.0.1.12', username: 'r', password: 'p', agent }];
  // 재현 1 꼴: 예전 paths ['os'] · osHost 10.0.1.12(중앙이 엣지 법인 사설 주소로 직접 SSH)
  const d = by(resolve({ bareMetal: bm, registry: [], bmServers: osr('edge-pl') }));
  assert.equal(d.t.TAG02, undefined);
  assert.deepEqual([d.s.TAG02.reason, d.s.TAG02.agent, d.s.TAG02.delegatedBy], ['edge-delegated', 'edge-pl', 'os-registry']);
  assert.equal(by(resolve({ bareMetal: bm, registry: [], bmServers: osr('EDGE-PL-ID') })).s.TAG02.agent, 'edge-pl', '등록부 이름으로 맞춘다(canonicalAgentRef — id 일치)');
  assert.equal(by(resolve({ bareMetal: bm, registry: [], bmServers: osr('edge-x') })).s.TAG02.agent, 'edge-x', '등록부에 없는 이름은 받은 그대로');
  // 법인 꺼짐이어도 위임(v2.961 순서 — 수집 여부는 그 엣지가 정한다)
  assert.equal(by(T.resolveTargets({ settings: { ...ST, corps: {} }, bareMetal: bm, registry: [], bmServers: osr('edge-pl'), remoteCollectors: RC })).s.TAG02.reason, 'edge-delegated');
  // 중앙 iDRAC 경로가 있으면 iDRAC 으로 수집 · OS 는 os-edge 로 밝힌다
  const ir = by(resolve({ bareMetal: bm, registry: [{ id: 'x2', host: 'https://10.0.0.12', username: 'u', password: 'p' }], bmServers: osr('edge-pl') })).t.TAG02;
  assert.deepEqual(ir.paths, ['idrac']); assert.deepEqual(ir.missing, ['os-edge']); assert.equal(ir.osHost, null);
  // iDRAC 등록부를 못 읽은 동안은 ‘다른 경로 없음’ 을 모른다 — 위임으로 단정하지 않는다
  const ur = by(resolve({ bareMetal: bm, registry: [], bmServers: osr('edge-pl'), registryUnread: { idrac: true, os: false } })).s.TAG02;
  assert.equal(ur.reason, 'no-idrac'); assert.equal(ur.osIssue, 'os-edge');
  // 엣지 노드: 자기 이름 등록(또는 빈 값)은 쓴다 · 다른 엣지 이름은 쓰지 않는다
  const e1 = T.resolveTargets({ settings: ST, bareMetal: bm, registry: [], bmServers: osr('edge-pl'), isEdge: true, agentName: 'EDGE-PL' });
  assert.deepEqual(e1.targets.map((x) => x.paths), [['os']]);
  const e2 = T.resolveTargets({ settings: ST, bareMetal: bm, registry: [], bmServers: osr('edge-q'), isEdge: true, agentName: 'edge-pl' });
  assert.equal(e2.targets.length, 0); assert.equal(e2.skipped[0].agent, 'edge-q');
  assert.equal(T.osEntryIssue({ agent: '' }, {}), ''); assert.equal(T.osEntryIssue({ agent: 'a', enabled: false }, {}), 'os-disabled', '꺼짐이 먼저');
});

/** 생성 입력(시드 고정 — 실행마다 같다). */
function* genInputs(count) {
  let seed = 20261115; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const VC = ['vcA', 'vcB', ''];
  for (let it = 0; it < count; it += 1) {
    const n = 1 + Math.floor(rnd() * 6); const bareMetal = []; const registry = []; const bmServers = [];
    for (let i = 0; i < n; i += 1) {
      const remote = rnd() < 0.3; const name = pick(['db01', 'db02', 'db03', 'app1']); const tag = pick(['', 'T1', 'T2', `T${i}`]);
      bareMetal.push({ serverId: remote ? `remote:c1:${i}` : `s${i}`, name, serviceTag: tag, vcenterId: pick(VC), ...(remote ? { source: 'remote', collectorId: pick(['c1', 'c9']) } : {}), ...(rnd() < 0.1 ? { remoteAgent: 'edge-z' } : {}) });
      if (rnd() < 0.6) registry.push({ id: rnd() < 0.8 ? `s${i}` : `r${i}`, serviceTag: rnd() < 0.5 ? tag : pick(['T1', 'T2', '']), host: pick([`https://10.0.0.${i}`, '', 'https://10.0.0.9']), username: pick(['u', '']), password: pick(['p', '']), ...(rnd() < 0.3 ? { enabled: false } : {}) });
      if (rnd() < 0.7) bmServers.push({ id: `o${i}`, name: pick([name, 'db01', `10.0.0.${i}`]), host: pick([`10.0.0.${i}`, `10.0.1.${i}`, '10.0.0.9']), username: 'r', password: 'p', vcenterId: pick(VC), ...(rnd() < 0.25 ? { enabled: false } : {}), ...(rnd() < 0.25 ? { agent: pick(['edge-a', 'edge-b']) } : {}) });
    }
    const isEdge = rnd() < 0.15;
    yield { bareMetal, registry, bmServers, settings: { corps: { vcA: true, vcB: rnd() < 0.5 }, idracTelemetry: rnd() < 0.8, osSsh: rnd() < 0.8, includeUnassigned: rnd() < 0.5 },
      isEdge, agentName: isEdge ? pick(['edge-a', 'edge-z']) : '', remoteCollectors: RC, registryUnread: rnd() < 0.1 ? { idrac: rnd() < 0.5, os: rnd() < 0.5 } : null };
  }
}

test('D3 · D4 ③ 불변식(생성 입력 2,000) — 켜진 · agent 없는 등록으로 수집하던 대상은 그대로 · 새 대상은 꺼진/엣지 등록 상대가 빠져 풀린 키 충돌뿐 · 꺼진/남의 등록을 쓰지 않는다', () => {
  let kept = 0; let moved = 0; let released = 0;
  for (const input of genInputs(2000)) {
    const strip = { ...input, registry: input.registry.map(({ enabled, ...r }) => r), bmServers: input.bmServers.map(({ enabled, agent, ...r }) => r) };
    const base = T.resolveTargets(strip);   // = 기준판 결과(머리말)
    const now = T.resolveTargets(input);
    const nk = new Map(now.targets.map((x) => [`${x.role}|${x.key}`, x]));
    const regOn = (id) => { const r = input.registry.find((x) => String(x.id) === id); return !r || r.enabled !== false; };
    const osOf = (id) => input.bmServers.find((x) => x.id === id);
    for (const x of base.targets) {
      const o = x.osHost ? osOf(x.osHost.id) : null;
      const usable = (!o || !T.osEntryIssue(o, input)) && (!x.idrac || regOn(x.idrac.regId));
      const y = nk.get(`${x.role}|${x.key}`);
      if (usable) { kept += 1; assert.ok(y, `빠짐 ${x.key}`); assert.deepEqual(y.paths, x.paths); assert.equal(y.osHost?.id, x.osHost?.id); assert.equal(y.idrac?.regId, x.idrac?.regId); } else moved += 1;
    }
    const bk = new Set(base.targets.map((x) => `${x.role}|${x.key}`));
    const bconf = new Set(base.skipped.filter((s) => s.reason === 'key-conflict').map((s) => s.key));
    for (const x of now.targets) {
      if (!bk.has(`${x.role}|${x.key}`)) { assert.ok(bconf.has(x.key), `새 대상 ${x.key}`); released += 1; }
      if (x.osHost) assert.equal(T.osEntryIssue(osOf(x.osHost.id), input), '', '꺼진 · 남의 OS 등록을 쓰지 않는다');
      if (x.idrac) assert.ok(regOn(x.idrac.regId), '꺼진 iDRAC 등록을 쓰지 않는다');
    }
  }
  assert.ok(kept > 300 && moved > 300, `두 갈래가 실제로 돌았다(그대로 ${kept} · 바뀜 ${moved} · 풀린 충돌 ${released})`);
});

test('D3 · D4 ④ 실제 등록부 → currentTargets(재현 꼴) · 집중 모니터링 분마다 다시 해석도 같은 판정', async (t) => {
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: true }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 'idr-1', name: 'TAG01-host', serviceTag: 'TAG01', vcenterId: 'vcA' },
    { serverId: 'x2', name: 'db02', serviceTag: 'TAG02', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  t.after(() => P._setFleetForTest(null));
  const tg = await P.currentTargets();
  const s = Object.fromEntries(tg.skipped.map((x) => [x.key, x]));
  assert.ok(!tg.targets.some((x) => x.key === 'TAG01' || x.key === 'TAG02'), JSON.stringify(tg.targets.map((x) => [x.key, x.paths])));
  assert.equal(s.TAG01.reason, 'os-disabled'); assert.equal(s.TAG01.idracIssue, 'idrac-disabled');
  assert.equal(s.TAG02.reason, 'edge-delegated'); assert.equal(s.TAG02.agent, 'edge-pl');
  // 집중 모니터링: 세션 중 등록이 꺼지면 다음 분부터 접속하지 않는다(authErrorCode — missReason cred-config)
  const F = await import('../src/bmusage/focus/run.js');
  const off = await F.refreshFocusOsHost({ id: 'o-1', host: '10.0.1.11', port: 22, username: 'mon', password: 'pw' });
  assert.equal(off.authErrorCode, 'disabled'); assert.equal(off.password, '');
  const edge = await F.refreshFocusOsHost({ id: 'o-2', host: '10.0.1.12', port: 22, username: 'mon', password: 'pw' });
  assert.equal(edge.authErrorCode, 'edge-registry');
  assert.equal(MR.osMissOf({ ok: false, authErrorCode: 'disabled' }), 'cred-config');
});

/* ── D5 ─────────────────────────────────────────────────────────────────── */
test('D5 ① 순수 — exec 오류 종류 · iDRAC 403 · 지표 id 없음 · 인증서 불신은 각자 사유(예전: not-linux · unreachable)', async () => {
  assert.equal(OS.execErrorKind(new Error('SSH exec 타임아웃(34s): export LC_ALL=C; …')), 'timeout');
  assert.equal(OS.execErrorKind(new Error('SSH exec 출력 상한(3840KB) 초과: x')), 'output-limit');
  assert.equal(OS.execErrorKind(new Error('(SSH) Channel open failure: open failed')), 'channel');
  assert.equal(MR.osMissOf({ ok: false, execError: 'timeout', error: OS.EXEC_ERROR_TEXT.timeout }), 'timeout');
  assert.equal(MR.osMissOf({ ok: false, execError: 'channel', error: OS.EXEC_ERROR_TEXT.channel }), 'ssh-error');
  assert.equal(MR.osMissOf({ ok: false, execError: 'output-limit', error: OS.EXEC_ERROR_TEXT['output-limit'] }), 'error');
  assert.equal(MR.osMissOf({ ok: false, error: 'Linux(/proc)·Windows(PowerShell) 어느 형식으로도 읽지 못했습니다 — 셸이 제한적일 수 있습니다.' }), 'not-linux', '표지 0개 출력은 그대로 not-linux');
  for (const v of Object.values(OS.EXEC_ERROR_TEXT)) assert.ok(!/Linux|어느 형식으로도/.test(v), '문구가 not-linux 로 읽히지 않는다');
  assert.equal(MR.idracMissOf({ ok: false, kind: 'forbidden', error: 'HTTP 403' }), 'forbidden');
  assert.equal(MR.idracMissOf({ ok: false, kind: 'ids-unmatched', error: 'x' }), 'ids-unmatched');
  assert.equal(MR.idracMissOf({ ok: false, kind: 'unreachable', error: '장비 인증서를 신뢰할 수 없어 연결을 끊었습니다 [ERR_TLS_PEER_UNTRUSTED]' }), 'cert-untrusted');
  assert.equal(MR.idracMissOf({ ok: false, kind: 'unreachable', error: 'connect ECONNREFUSED' }), 'unreachable');
  // 열거 — 수집 건강 · 집중 모니터링 · 중앙 정제(공용 열거) · 중앙 집중 인출(소스) 모두
  const CH = await import('../src/bmusage/collectHealth.js');
  const F = await import('../src/bmusage/focus/run.js');
  const pull = fs.readFileSync(new URL('../src/central/bmPerfOpsPull.js', import.meta.url), 'utf8');
  for (const c of ['forbidden', 'ids-unmatched', 'cert-untrusted']) {
    assert.ok(CH.HEALTH_REASON_CODES.includes(c) && F.FOCUS_MISS.includes(c), c);
    assert.match(pull, new RegExp(`const MISS = new Set\\(\\[[^\\]]*'${c}'`), `bmPerfOpsPull MISS ${c}`);
  }
  const s = CH.summarizeCycle({ results: [{ ok: false, target: { key: 'a', vcenterId: 'vcA', paths: ['idrac'] }, idrac: { ok: false, kind: 'forbidden' } }], startedAt: NOW, endedAt: NOW + 1, intervalMs: 300_000, concurrency: 4, now: NOW });
  assert.deepEqual(s.node.reasons.map((x) => `${x.path}:${x.code}`), ['idrac:forbidden']);
  // 중앙 정제: 새 code 는 남고 모르는 code 는 버린다(구버전 중앙도 깨지지 않는다 — 그 줄만 버린다)
  const { sanitizeCollectHealth } = await import('../src/central/bmCollectHealthSanitize.js');
  const san = sanitizeCollectHealth({ node: { at: NOW, servers: 1, ok: 0, fail: 1, reasons: [{ path: 'idrac', code: 'cert-untrusted', n: 1 }, { path: 'idrac', code: 'zzz-new', n: 1 }] } }, NOW + 1000);
  assert.deepEqual(san.node.reasons.map((x) => x.code), ['cert-untrusted']);
});

/* D5 ② 실제 collectOsUsage — 자식 프로세스(ssh2 Client 만 가짜: 로컬 dash · bmTop8bBudget ③ 과 같은 방식) */
const SSH2 = pathToFileURL(createRequire(fileURLToPath(new URL('../src/proxy/sshExec.js', import.meta.url))).resolve('ssh2')).href;
const OS_URL = new URL('../src/bmusage/collectors/osSsh.js', import.meta.url).href;
const MR_URL = new URL('../src/bmusage/missReason.js', import.meta.url).href;
const CHILD = `
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
const FAKE = process.env.L1_FAKEBIN;
class FakeClient extends EventEmitter {
  connect() { setImmediate(() => this.emit('ready')); }
  exec(cmd, a, b) {
    const cb = typeof a === 'function' ? a : b;
    if (process.env.L1_FAIL_ALL === '1') { setImmediate(() => cb(new Error('(SSH) Channel open failure: open failed'))); return; }
    const ch = spawn('/bin/dash', ['-c', cmd], { env: { ...process.env, PATH: FAKE + ':' + process.env.PATH }, detached: true });
    const st = new EventEmitter(); st.stderr = new EventEmitter();
    ch.stdout.on('data', (d) => st.emit('data', d)); ch.stderr.on('data', (d) => st.stderr.emit('data', d));
    ch.on('close', (code) => st.emit('close', code));
    st.close = () => { try { process.kill(-ch.pid, 'SIGKILL'); } catch {} }; st.destroy = st.close; st.signal = () => {};
    setImmediate(() => cb(null, st));
  }
  end() { setImmediate(() => this.emit('close')); }
}
mock.module(${JSON.stringify(SSH2)}, { namedExports: { Client: FakeClient } });
const OS = await import(${JSON.stringify(OS_URL)});
const MR = await import(${JSON.stringify(MR_URL)});
const t0 = Date.now();
const r = await OS.collectOsUsage({ host: '10.9.9.8', username: 'u', password: 'p', mounts: [] }, {});
process.stdout.write('@@' + JSON.stringify({ ms: Date.now() - t0, ok: r.ok, error: r.error || null, execError: r.execError || null, miss: MR.osMissOf(r) }) + '\\n');
process.exit(0);
`;
function runChild(env) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bmloop1-cfg-'));
  try {
    const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--experimental-sqlite', '--no-warnings', '--input-type=module', '-e', CHILD],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env } });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, `자식 출력 없음: ${String(r.stderr || '').slice(0, 600)}`);
    return JSON.parse(line.slice(2));
  } finally { fs.rmSync(cfg, { recursive: true, force: true }); }
}

test('D5 ② 실제 collectOsUsage — 주 명령 exec 시한 → timeout(예전 not-linux) · 채널 오류 → ssh-error · 오류 원문(명령 전문)은 싣지 않는다', { timeout: 120_000 }, async (t) => {
  if (!fs.existsSync('/bin/dash')) return t.skip('dash 없음');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bmloop1-bin-'));
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nexec sleep 100\n', { mode: 0o755 });   // ##HOST 의 uname(시한 없음)이 멈춘다 → 주 명령이 exec 시한
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const r = runChild({ L1_FAKEBIN: bin, BMUSAGE_CMD_TIMEOUT_MS: '6000' });   // 시험만 exec 시한을 6초로(운영 34초 · 한 시도 최소 5초 — MIN_SLICE_MS)
  assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.execError, 'timeout', JSON.stringify(r)); assert.equal(r.miss, 'timeout', `사유(${r.error})`);
  assert.ok(!/LC_ALL|##STAT/.test(r.error), '명령 전문을 싣지 않는다');
  const c = runChild({ L1_FAKEBIN: bin, L1_FAIL_ALL: '1' });
  assert.equal(c.execError, 'channel'); assert.equal(c.miss, 'ssh-error');
});

/* ── 의심 1 · 2 ─────────────────────────────────────────────────────────── */
test('의심 1 — hostKey 끝 슬래시 제거는 선형(재현: 슬래시 4만 자 + 글자 하나 855ms · O(n²)) · 뜻은 그대로', () => {
  const time = (n) => { const s = `${'/'.repeat(n)}a`; let best = Infinity; for (let i = 0; i < 3; i += 1) { const t0 = process.hrtime.bigint(); T.hostKey(s); best = Math.min(best, Number(process.hrtime.bigint() - t0)); } return best; };
  time(1000);
  const small = Math.max(time(20_000), 50_000); const big = time(160_000);   // 8배 입력 — 선형이면 약 8배, O(n²) 면 약 64배
  assert.ok(big / small < 24, `8배 입력 시간 비 ${(big / small).toFixed(1)}(O(n²) 면 약 64)`);
  for (const [v, k] of [['https://10.0.0.1/', '10.0.0.1'], ['HTTPS://Host.EX:443//', 'host.ex'], ['[fe80::1]:22', 'fe80::1'], ['10.0.0.1', '10.0.0.1'], ['/', ''], ['', '']]) assert.equal(T.hostKey(v), k, v);
  assert.doesNotMatch(fs.readFileSync(new URL('../src/bmusage/targets.js', import.meta.url), 'utf8'), /replace\(\/\\\/\+\$\//, '금지 패턴(/\\/+$/)이 남지 않았다');
});

test('의심 2 — 물리서버 폴더 사유 색인: 같은 키의 가상화 호스트(다른 법인 · 공통 태그) 행이 베어메탈 사유를 덮지 않는다((법인, 키) 쌍)', async () => {
  const W = await import('../src/bmfolders/usageWhy.js');
  const tag = 'To Be Filled By O.E.M.';
  const r = T.resolveTargets({ bareMetal: [{ serverId: 's1', name: 'wb-db01', serviceTag: tag, vcenterId: 'vcA' }], virtHosts: [{ name: 'esx-b1', serviceTag: tag, vcenterId: 'vcB', fleetId: 'x' }],
    vcenters: [{ id: 'vcA' }, { id: 'vcB' }], registry: [], bmServers: [], settings: { corps: { vcB: true }, idracTelemetry: true, osSsh: true, includeVirtualization: true } });
  const key = T.idOf({ serverId: 's1', serviceTag: tag }).key;
  assert.deepEqual(r.skipped.filter((s) => s.key === key).map((s) => [s.role || 'bm', s.vcenterId, s.reason]), [['bm', 'vcA', 'corp-off'], ['virt', 'vcB', 'no-idrac']], '같은 키 두 행(재현 입력)');
  const ix = W.whyIndexOf({ ...r, settings: { enabled: true } });
  assert.equal(W.usageWhyOf({ kind: 'bm', corp: 'vcA', usageKey: key, usage: { state: 'unread' } }, ix).code, 'corp-off', '예전: no-idrac(ESXi 행)');
  // 가상화 호스트 행은 같은 법인 · 같은 키여도 베어메탈 구성원의 사유가 아니다(구성원 행이 대상 해석에 아직 없으면 ‘확인 못 함’ — 단정하지 않는다)
  const ixV = W.whyIndexOf({ settings: { enabled: true }, skipped: [{ key: 'KV', role: 'virt', vcenterId: 'vcA', reason: 'no-idrac' }], targets: [{ key: 'KT', role: 'virt', vcenterId: 'vcA' }] });
  assert.equal(W.usageWhyOf({ kind: 'bm', corp: 'vcA', usageKey: 'KV', usage: { state: 'unread' } }, ixV).code, 'unknown');
  assert.equal(W.usageWhyOf({ kind: 'bm', corp: 'vcA', usageKey: 'KT', usage: { state: 'unread' } }, ixV).code, 'unknown');
  // 법인 칸 없는 행(남의 엣지 위임)은 키로 찾는다 · 대상은 쌍 → 키 순
  const ix2 = W.whyIndexOf({ settings: { enabled: true }, skipped: [{ key: 'E1', reason: 'edge-delegated', agent: 'edge-a' }], targets: [{ key: 'T1', vcenterId: 'vcA', role: 'bm' }] });
  assert.equal(W.usageWhyOf({ kind: 'bm', corp: 'vcA', usageKey: 'E1', usage: { state: 'unread' } }, ix2).code, 'edge-no-record');
  assert.equal(W.usageWhyOf({ kind: 'bm', corp: 'vcA', usageKey: 'T1', usage: { state: 'unread' } }, ix2).code, 'no-record');
});
