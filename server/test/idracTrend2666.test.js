// v2.666 — iDRAC 통합 추이: 가상화 서버 ↔ ESXi 호스트 매칭(서비스태그 또는 호스트네임 — 도메인 제거·대소문자 무시) +
// 매칭된 호스트의 vCenter CPU 사용률을 **별도 계열**(hostCpuPct)로 싣는다. iDRAC CPU(cpuPct)에는 섞지 않는다(v2.665 규칙 유지).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idractrend2666-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';

const { hostShortName, buildHostMatchIndex, matchHostForServer } = await import('../src/idrac/hostMatch.js');
const { kindOf, HOST_CPU_METRIC } = await import('../src/routes/admin/idracTrend.js');
const { store } = await import('../src/store.js');
const { getMetricsDb } = await import('../src/metrics/db.js');
const { _sampleOnceForTest } = await import('../src/metrics/sampler.js');

const MIN = 60_000, HOUR = 3_600_000;

test('① 짧은 이름 — 도메인 제거 · 대소문자 무시 · 끝 점 · IP 는 이름이 아니다', () => {
  assert.equal(hostShortName('HOST01.Corp.Example.com'), 'host01');
  assert.equal(hostShortName('host01'), 'host01');
  assert.equal(hostShortName('  HOST01.  '), 'host01');
  assert.equal(hostShortName('esx-a.lab.'), 'esx-a');
  assert.equal(hostShortName('10.20.1.11'), '', 'IPv4 를 줄이면 10 이 된다(v2.628 C2628-01)');
  assert.equal(hostShortName('fd00::1'), '');
  assert.equal(hostShortName(''), ''); assert.equal(hostShortName(null), '');
  assert.ok(hostShortName('a'.repeat(5000) + '.'.repeat(5000)).length <= 255, '긴 입력은 자른다');
});

test('② 매칭 — 서비스태그 먼저, 없으면 호스트네임(HOST ↔ host.domain.com), 모호하면 정하지 않는다', () => {
  const hosts = [
    { id: 'vc1:host-1', name: 'esx01.corp.example.com', serviceTag: 'ABC1234', vcenterId: 'vc1' },
    { id: 'vc1:host-2', name: 'ESX02', serviceTag: '', vcenterId: 'vc1' },
    { id: 'vc1:host-3', name: 'dup.a.com', vcenterId: 'vc1' },
    { id: 'vc2:host-4', name: 'DUP.b.com', vcenterId: 'vc2' },
    { id: 'vc2:host-5', name: '10.1.1.5', vcenterId: 'vc2' },
  ];
  const idx = buildHostMatchIndex(hosts);
  const t = matchHostForServer(idx, { serviceTag: 'abc1234', names: ['esx02'] });
  assert.equal(t.host.id, 'vc1:host-1'); assert.equal(t.matchedBy, 'serviceTag', '서비스태그가 이름보다 먼저');
  const h1 = matchHostForServer(idx, { serviceTag: 'NOPE', names: ['ESX01'] });
  assert.equal(h1.host.id, 'vc1:host-1'); assert.equal(h1.matchedBy, 'hostname', 'FQDN 호스트 ↔ 짧은 대문자 이름');
  const h2 = matchHostForServer(idx, { names: ['esx02.corp.example.com'] });
  assert.equal(h2.host.id, 'vc1:host-2', '짧은 호스트 ↔ FQDN 이름');
  const amb = matchHostForServer(idx, { names: ['dup'] });
  assert.equal(amb.host, null); assert.equal(amb.ambiguous, true, '같은 짧은 이름이 두 호스트 — 정하지 않는다');
  assert.equal(matchHostForServer(idx, { names: ['10.1.1.5'] }).host, null, 'IP 는 이름 매칭에 쓰지 않는다');
  const two = matchHostForServer(idx, { names: ['esx01', 'esx02'] });
  assert.equal(two.host, null); assert.equal(two.ambiguous, true, '이름 후보가 서로 다른 호스트를 가리키면 정하지 않는다');
  assert.equal(matchHostForServer(idx, { names: ['esx01', 'ESX01.other.net'] }).host.id, 'vc1:host-1', '같은 호스트면 매칭');
});

test('③ kindOf — 서비스태그가 없어도 인벤토리 hostName 으로 ESXi 판정 · 근거를 싣는다', () => {
  const idx = buildHostMatchIndex([{ id: 'vc1:host-9', name: 'gpu-node9', vcenterId: 'vc1' }]);
  const k = kindOf({ id: 's9', name: '10.0.0.9' }, { index: idx, inv: { system: { hostName: 'GPU-NODE9.dc.local' } } });
  assert.equal(k.kind, 'esxi'); assert.equal(k.matchedBy, 'hostname'); assert.equal(k.host.id, 'vc1:host-9');
  const b = kindOf({ id: 's8', name: 'other' }, { index: idx, inv: null });
  assert.equal(b.kind, 'baremetal'); assert.equal(b.matchedBy, null);
});

test('④ 적재 + 라우트 — 샘플러가 host_cpu_pct 를 쌓고, 호스트네임으로 매칭된 서버 추이에 hostCpuPct 가 따로 실린다', async () => {
  await store.refresh({ force: true });
  const hosts = (store.get().hosts || []).filter((h) => h.connectionState !== 'DISCONNECTED' && h.connectionState !== 'NOT_RESPONDING' && Number.isFinite(h.cpuUsagePct));
  assert.ok(hosts.length > 0, '목 호스트가 있다');
  const h = hosts[0];
  await _sampleOnceForTest();
  const db = await getMetricsDb();
  const now = Date.now();
  const got = db.historyRange(HOST_CPU_METRIC, h.id, now - HOUR, now + MIN, MIN);
  assert.ok(got.length >= 1, '샘플러가 호스트 CPU 계열을 적재했다');

  const { addServer } = await import('../src/idrac/registry.js');
  const fqdn = `${String(h.name).split('.')[0].toUpperCase()}.idrac-test.example`;
  addServer({ id: 'esx-by-name', name: fqdn, host: '10.0.0.77', username: 'root', password: 'x' });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0); await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin`;
  try {
    const t = await (await fetch(`${base}/idrac/esx-by-name/trend?range=1h`)).json();
    assert.equal(t.ok, true);
    assert.equal(t.kind, 'esxi', '서비스태그 없이 호스트네임(도메인 다름·대문자)으로 매칭');
    assert.equal(t.matchedBy, 'hostname');
    assert.equal(t.hostCpu.hostId, h.id);
    assert.ok(t.points.some((p) => typeof p.hostCpuPct === 'number'), 'vCenter CPU 계열이 따로 실린다');
    assert.ok(t.points.every((p) => p.cpuPct === null), 'iDRAC CPU 에는 섞이지 않는다(v2.665)');
    // 과거 구간 스크롤(start/end) — 1시간 창을 1시간 전으로 옮겨도 200
    const end = Math.floor(Date.now() / MIN) * MIN - HOUR;
    const past = await fetch(`${base}/idrac/esx-by-name/trend?start=${end - HOUR}&end=${end}`);
    assert.equal(past.status, 200);
    const csv = await (await fetch(`${base}/idrac/trend/export.csv?scope=server&id=esx-by-name&range=1h`)).text();
    assert.ok(csv.includes('ESXi 호스트 CPU(vCenter, %)'), 'CSV 에도 별도 열');
  } finally { srv.close(); }
});
