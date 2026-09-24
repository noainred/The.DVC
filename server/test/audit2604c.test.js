// v2.604 감사 그룹 c — 수집기.
//   COL-2604-01 Isilon SSH 반올림 용량 · COL-2604-02 PowerMax 부분 SRP · COL-2604-03 PowerMax 어레이 상한/원격 필터 순서 ·
//   COL-2604-04 FOS PSU 0W · COL-2604-05 bmstor 마운트 지점 아닌 디렉터리 · EDGE2604-03 워커 '완료' 로그와 회신 실패.
//   ⚠ 픽스처는 전부 합성값이다(공개 저장소 — v2.513 규약). 기준 시각에 Date.now() 를 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604c-'));
process.env.CONFIG_DIR = TMP;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.DATA_SOURCE = 'live';

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const json = (r, o, s = 200) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
const PiB = 1024 ** 5;

const isiStatus = (used, pct) => `Cluster Name: synth-isi
Cluster Health:     [  OK ]
Cluster Storage:  HDD                 SSD Storage
Size:             2.2P (2.3P Raw)     0 (0 Raw)
VHS Size:         45.2T
Used:             ${used} (${pct}%)          0 (n/a)
Avail:            990.1T (44%)        0 (n/a)

Critical Events:
Time            LNN  Event
`;

test('COL-2604-01: isi status 반올림 용량은 해상도를 밝히고, 사용률은 장비가 보고한 % 를 쓴다', async () => {
  const { parseIsiStatus, normalizeIsiStatus, sizeStep } = await import('../src/storage/collectors/isilonSsh.js');
  assert.equal(sizeStep('5.0P'), 0.1 * PiB);
  assert.equal(sizeStep('107T'), 1024 ** 4);
  assert.equal(sizeStep('n/a'), null);
  const s = normalizeIsiStatus({ id: 'i', name: 'i' }, parseIsiStatus(isiStatus('1.2P', 56)));
  assert.equal(s.sections.capacity, 'ok');
  assert.equal(s.capacity.pct, 56);                               // 예전 54.5(1.2P/2.2P) — 장비는 56% 라 말한다
  assert.equal(s.extra.capacityApprox?.resolutionBytes, 0.1 * PiB);
  assert.match(s.extra.capacityBasisNote, /반올림 표기/);
  assert.ok(!s.extra.capacityBasisNote.includes('`'), '백틱 금지(BoldText)');
  assert.equal(s.extra.clusterHealth, 'OK');                      // 뒤의 extra 대입이 용량 근거를 덮지 않고 둘 다 남는다
});

test('COL-2604-01: isi statistics 로 정확한 바이트를 읽으면 그것을 쓰고 approx 가 아니다', async () => {
  const { parseIsiStatus, normalizeIsiStatus, parseIsiStatsBytes } = await import('../src/storage/collectors/isilonSsh.js');
  const T = 2420000000000000; const U = 1330123456789012;
  const kv = JSON.stringify([{ key: 'ifs.bytes.total', value: T, devid: 0 }, { key: 'ifs.bytes.used', value: U, devid: 0 }]);
  assert.deepEqual(parseIsiStatsBytes(kv), { total: T, used: U, ssdTotal: null, ssdUsed: null });
  assert.deepEqual(parseIsiStatsBytes(JSON.stringify({ stats: JSON.parse(kv) })), { total: T, used: U, ssdTotal: null, ssdUsed: null });
  assert.deepEqual(parseIsiStatsBytes(JSON.stringify([{ node: 'cluster', 'ifs.bytes.total': T, 'ifs.bytes.used': String(U), 'ifs.ssd.bytes.total': 0 }])),
    { total: T, used: U, ssdTotal: 0, ssdUsed: null });
  // 사람용 표기('2.2P')는 받지 않는다 — isi status 와 정밀도가 같다
  assert.equal(parseIsiStatsBytes(JSON.stringify([{ key: 'ifs.bytes.total', value: '2.2P' }])), null);
  assert.equal(parseIsiStatsBytes('not json'), null);
  const exact = parseIsiStatsBytes(kv);
  const s = normalizeIsiStatus({ id: 'i', name: 'i' }, parseIsiStatus(isiStatus('1.2P', 56)), { exact });
  assert.equal(s.capacity.totalBytes, T);
  assert.equal(s.capacity.usedBytes, U);
  assert.equal(s.extra.capacityApprox, undefined);
  assert.match(s.extra.capacityBasis, /isi statistics/);
});

// ── PowerMax 목 Unisphere ──
async function pmaxServer(scen) {
  const dir = path.join(TMP, 'tls');
  if (!fs.existsSync(path.join(dir, 'c.pem'))) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  }
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (q, r) => {
    const p = q.url.split('?')[0];
    let m;
    if (p.endsWith('/version')) return json(r, { version: 'V10.2.0.9' });
    if (/\/system\/symmetrix$/.test(p)) {
      if (scen === 'remote') return json(r, { symmetrixId: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'L1'] });
      if (scen === 'mixed') return json(r, { symmetrixId: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'L1', 'L2', 'L3'] });
      if (scen === 'allremote') return json(r, { symmetrixId: ['R1', 'R2'] });
      return json(r, { symmetrixId: ['L1'] });
    }
    if ((m = /\/system\/symmetrix\/(\w+)$/.exec(p))) return json(r, { symmetrixId: m[1], model: 'PowerMax_2500', local: !m[1].startsWith('R') });
    if ((m = /\/sloprovisioning\/symmetrix\/(\w+)$/.exec(p))) return json(r, { symmetrixId: m[1], physicalCapacity: { total_capacity_gb: 200000, used_capacity_gb: 60000 } });
    if (/\/srp$/.test(p)) return json(r, { srpId: ['SRP_1', 'SRP_2'] });
    if (/\/srp\/SRP_1$/.test(p)) return json(r, { srpId: 'SRP_1', fba_srp_capacity: { effective: { physical_capacity: { used_tb: 30, total_tb: 100 } } } });
    if (/\/srp\/SRP_2$/.test(p)) {
      if (scen === 'srpfail') return json(r, { message: 'boom' }, 500);
      return json(r, { srpId: 'SRP_2', fba_srp_capacity: { effective: { physical_capacity: { used_tb: 40, total_tb: 100 } } } });
    }
    if (/alert/.test(p)) return json(r, { alertId: [] });
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  process.env.STORAGE_UNISPHERE_PORT = String(port);
  return srv;
}
const pmDev = { id: 'pm', name: 'pm', type: 'powermax', host: '127.0.0.1', username: 'u', password: 'p' };

test('COL-2604-02: SRP 하나를 못 읽으면 부분 SRP 합을 어레이 전체라 말하지 않고 partial-pools 로 막는다', async () => {
  const { collect } = await import('../src/storage/collectors/powermax.js');
  const { capacityPointEligible } = await import('../src/storage/db.js');
  let srv = await pmaxServer('normal');
  try {
    const ok = await collect(pmDev);
    assert.equal(ok.capacity.totalBytes, 200e12);                 // SRP 둘의 합(100+100 TB)
    assert.equal(ok.extra.poolsUnreadable, undefined);
    assert.equal(capacityPointEligible(ok).ok, true);
  } finally { srv.close(); }
  srv = await pmaxServer('srpfail');
  try {
    const s = await collect(pmDev);
    // 예전: total 100 TB · used 30 TB(첫 SRP 뿐) · poolsUnreadable 없음 → 증가량에 반토막 급변 적재
    assert.notEqual(s.capacity.totalBytes, 100e12);
    assert.equal(s.extra.poolsUnreadable, 1);
    assert.deepEqual(s.extra.srpIncomplete, [{ array: 'L1', listed: 2, parsed: 1, failed: 1, unrecognized: 0, omitted: 0 }]);
    assert.deepEqual(capacityPointEligible(s), { ok: false, reason: 'partial-pools' });
    assert.match(s.extra.capacityBasisNote, /SRP 1개를 읽지 못해/);
  } finally { srv.close(); delete process.env.STORAGE_UNISPHERE_PORT; }
});

test('COL-2604-03: 원격(SRDF) 어레이를 거른 뒤에 로컬 상한을 적용한다', async () => {
  const { collect } = await import('../src/storage/collectors/powermax.js');
  let srv = await pmaxServer('mixed');   // 원격 6 + 로컬 3 — 예전엔 앞 8개만 봐 L3 가 조용히 빠졌다
  try {
    const s = await collect(pmDev);
    assert.deepEqual(s.pools.map((p) => p.name), ['L1', 'L2', 'L3']);
    assert.equal(s.extra.poolsUnreadable, undefined);
  } finally { srv.close(); }
  srv = await pmaxServer('remote');      // 원격 8 + 로컬 1 — 예전엔 로컬 0 → 사유 없이 실패
  try {
    const s = await collect(pmDev);
    assert.equal(s.ok, true);
    assert.deepEqual(s.pools.map((p) => p.name), ['L1']);
  } finally { srv.close(); }
  srv = await pmaxServer('allremote');   // 로컬이 하나도 없으면 사유를 말한다
  try {
    const s = await collect(pmDev);
    assert.match(String(s.sections.config), /로컬 어레이를 찾지 못했습니다.*원격\(SRDF\) 2개/);
  } finally { srv.close(); delete process.env.STORAGE_UNISPHERE_PORT; }
});

test('COL-2604-03: 로컬 상한·미확인 어레이는 합계에서 빠졌다고 센다(정규화)', async () => {
  const { normalizePowermax } = await import('../src/storage/collectors/powermax.js');
  const caps = { L1: { totalBytes: 100e12, usedBytes: 10e12, basis: 'system_capacity.usable', documented: true } };
  const s = normalizePowermax(pmDev, { arrays: [{ symmetrixId: 'L1' }], caps, srps: {}, arraysOverCap: 2, arraysUnchecked: 1 });
  assert.equal(s.extra.poolsUnreadable, 3);
  assert.equal(s.extra.arraysOverCap, 2);
  assert.equal(s.extra.arraysUnchecked, 1);
});

test('COL-2604-04: PSU 의 Power Usage 0W 는 값 0 이고 부분 합 표시를 만들지 않는다', async () => {
  const { parseChassisShow } = await import('../src/sanswitch/collectors/fosParse.js');
  const txt = ['POWER SUPPLY Unit: 1', 'Power Usage: -240W', 'POWER SUPPLY Unit: 2', 'Power Usage: 0W',
    'POWER SUPPLY Unit: 3', 'Power Usage: n/a'].join('\n');
  const r = parseChassisShow(txt);
  assert.deepEqual(r.psus.map((p) => p.powerW), [240, 0, null]);
  assert.equal(r.powerWatts, 240);
  assert.deepEqual(r.powerPartial, { read: 2, total: 3 });      // 예전: read 1(0W 를 못 읽음으로 셈)
  const r2 = parseChassisShow(['POWER SUPPLY Unit: 1', 'Power Usage: -240W', 'POWER SUPPLY Unit: 2', 'Power Usage: 0W'].join('\n'));
  assert.equal(r2.powerPartial, null);
});

test('COL-2604-05: 마운트 지점이 아닌 디렉터리는 "미마운트/오타" 가 아니라 사유와 함께 밝힌다', async () => {
  const { parseDfOutput } = await import('../src/bmstor/collect.js');
  const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
    + '/dev/sda1 1000 400 600 40% /\n/dev/sda1 1000 400 600 40% /\n';
  const r = parseDfOutput(out, ['/', '/nope', '/var'], 'df: /nope: No such file or directory');
  assert.deepEqual(r.mounts.map((m) => m.mount), ['/']);
  assert.deepEqual(r.notMountPoints, [{ path: '/var', mount: '/' }]);
  assert.equal(r.missing[0], '/nope');
  assert.match(r.missing[1], /^\/var \(마운트 지점 아님/);
  // 줄 수가 맞지 않으면 순서로 짝짓지 않는다(판단 근거 없음 → 예전 동작)
  const r2 = parseDfOutput('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 400 600 40% /\n', ['/', '/nope', '/var']);
  assert.deepEqual(r2.missing, ['/nope', '/var']);
});

test('EDGE2604-03: 결과 회신이 실패하면 "수집 완료" 줄이 그 사실을 함께 적는다', async () => {
  const { config } = await import('../src/config.js');
  const srv = http.createServer((q, r) => {
    if (q.method === 'GET' && q.url.startsWith('/api/central/bmstor-jobs')) return json(r, { jobs: [{ reqId: 'rq1', servers: [] }] });
    if (q.method === 'GET' && q.url.startsWith('/api/central/capture-jobs')) return json(r, { jobs: [{ reqId: 'rq2', spec: { host: '127.0.0.1', port: 1, username: 'u', password: 'p', seconds: 1 } }] });
    if (q.method === 'POST') { q.resume(); q.on('end', () => json(r, { error: 'too large' }, 413)); return; }
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  const prev = { ...config.agent };
  config.agent.centralUrl = `http://127.0.0.1:${port}`;
  config.agent.centralToken = 'tok';
  config.agent.name = 'edge-c';
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    const { runBmstorWorkerOnce } = await import('../src/agent/bmstorWorker.js');
    const b = await runBmstorWorkerOnce();
    assert.equal(b.ok, false);
    const { runCaptureWorkerOnce } = await import('../src/agent/captureWorker.js');
    const c = await runCaptureWorkerOnce();
    assert.equal(c.ok, false);
  } finally { console.log = orig; Object.assign(config.agent, prev); srv.close(); }
  const bl = logs.find((l) => l.includes('[bmstor-agent] 수집 완료 reqId=rq1'));
  assert.ok(bl && /결과 회신 실패/.test(bl), JSON.stringify(logs));
  const cl = logs.find((l) => l.includes('[capture-agent] 캡처 완료 reqId=rq2'));
  assert.ok(cl && /결과 회신 실패/.test(cl), JSON.stringify(logs));
});

test('COL-2604-01 후속: 증가량 매트릭스가 반올림 장비의 해상도를 싣고, 해상도 미만은 0 이 아니라 belowResolution 이다', async () => {
  const { growthMatrix } = await import('../src/storage/growth.js');
  const D0 = 20000;   // 고정 일 인덱스(Date.now 금지)
  const row = (id, day, used) => ({ device_id: id, day, last_ts: day * 86_400_000, total_bytes: 2.2 * PiB, used_bytes: used, max_used: used, samples: 4 });
  const rows = [row('isi', D0 - 7, 1.2 * PiB), row('isi', D0, 1.2 * PiB), row('isi', D0 - 30, 1.1 * PiB),
    row('pm', D0 - 7, 100), row('pm', D0, 100)];
  const periods = [{ key: '7d', days: 7, label: '1주' }, { key: '30d', days: 30, label: '1달' }];
  const meta = new Map([['isi', { name: 'isi', capacityApprox: { source: 'isi status', resolutionBytes: 0.1 * PiB } }], ['pm', { name: 'pm' }]]);
  const m = growthMatrix(rows, { asOfDay: D0, periods, meta });
  const isi = m.devices.find((x) => x.deviceId === 'isi');
  const pm = m.devices.find((x) => x.deviceId === 'pm');
  assert.deepEqual(isi.capacityApprox, { resolutionBytes: 0.1 * PiB });
  assert.equal(isi.growth['7d'].bytes, 0);
  assert.equal(isi.growth['7d'].belowResolution, true);
  assert.equal(isi.growth['7d'].resolutionBytes, 0.1 * PiB);
  assert.equal(isi.growth['30d'].belowResolution, false);
  assert.equal(pm.capacityApprox, undefined);                    // 정확한 장비에는 붙지 않는다
  assert.equal(pm.growth['7d'].belowResolution, undefined);
  assert.equal(m.totals.approxDevices, 1);
  // 해상도가 이상한 값이면 붙이지 않는다(지어내지 않는다)
  const m2 = growthMatrix(rows, { asOfDay: D0, periods, meta: new Map([['isi', { capacityApprox: { resolutionBytes: '' } }]]) });
  assert.equal(m2.devices.find((x) => x.deviceId === 'isi').capacityApprox, undefined);
});
