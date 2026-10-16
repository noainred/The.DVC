// v2.742 감사 수정 그룹 GD — iDRAC 스캔 교체 범위(DEV-01) · /idrac/host-power 범위(AUTHZ-01) · 파트 장애 훅 스위치·재실행(TIMING-03) ·
// 위임 iDRAC 스캔 결과 회신의 503 재전송(EDGE-03).
// 실제 함수·실제 api 라우터·실제 스캔 폴러(스캔 모듈만 가짜)·실제 엣지 워커(가짜 중앙)로 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742d-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.PARTFAULT_HOOK_DEBOUNCE_MS = '1000';
delete process.env.PARTFAULT_ENABLED;
delete process.env.CENTRAL_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const u = (p) => pathToFileURL(path.join(SRC, p)).href;
const writeJson = (name, v) => fs.writeFileSync(path.join(TMP, name), JSON.stringify(v, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let registry;
before(async () => { registry = await import('../src/idrac/registry.js'); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const ids = () => registry.loadRegistry().map((s) => s.id).sort();
const dell = (ip) => ({ ip, serviceTag: `T${ip.split('.').pop()}`, hostName: `h-${ip.split('.').pop()}`, vendor: 'dell' });

/* ════════════════════ DEV-01 — 교체 범위는 '그 엔트리' ════════════════════ */

test('DEV-01: registerScanned 교체는 같은 엔트리 표지·대역 안 옛 항목만 지우고, 다른 엔트리·수동 등록은 남긴다', () => {
  registry.importServers([{ id: 'boot', name: 'boot', host: '192.0.2.250', username: 'u', password: 'p' }], 'replace');
  registry.deleteServers({ all: true });
  // 엔트리 A·B 가 같은 법인 DC1 에 각자 등록(병합) — 표지가 붙는다.
  const a = registry.registerScanned([dell('192.0.2.11'), dell('192.0.2.12')], 'root', 'pw', 'merge', '', 'DC1', { scanRangeId: 'rng-A', scanRanges: ['192.0.2.11', '192.0.2.12', '192.0.2.13'] });
  assert.equal(a.ok, true, JSON.stringify(a));
  registry.registerScanned([dell('192.0.2.21')], 'root', 'pw', 'merge', '', 'DC1', { scanRangeId: 'rng-B', scanRanges: '192.0.2.21' });
  assert.equal(registry.loadRegistry().find((s) => s.id === '192.0.2.11').scanRangeId, 'rng-A', '스캔 등록에 엔트리 표지가 붙는다');
  // 수동 등록(사람이 정한 id, 대역 안 주소) · 표지 없는 옛 스캔 등록(대역 안 / 대역 밖)
  registry.importServers([
    { id: 'manual-1', name: 'manual-1', host: '192.0.2.13', username: 'u', password: 'p', datacenterId: 'DC1' },
    { id: '192.0.2.13', name: 'old-in', host: '192.0.2.13', username: 'u', password: 'p', datacenterId: 'DC1' },
    { id: '192.0.2.99', name: 'old-out', host: '192.0.2.99', username: 'u', password: 'p', datacenterId: 'DC1' },
    { id: 'other-dc', name: 'other', host: '192.0.2.12', username: 'u', password: 'p', datacenterId: 'DC2' },
  ], 'merge');
  assert.equal(registry.loadRegistry().find((s) => s.id === 'manual-1').scanRangeId, undefined, '수동 등록에는 표지가 없다(파일 모양 불변)');

  // 엔트리 A 교체 스캔 — 이번엔 .11 만 발견.
  const r = registry.registerScanned([dell('192.0.2.11')], 'root', 'pw', 'replace-datacenter', '', 'DC1', { scanRangeId: 'rng-A', scanRanges: ['192.0.2.11', '192.0.2.12', '192.0.2.13'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(ids(), ['192.0.2.11', '192.0.2.21', '192.0.2.99', 'manual-1', 'other-dc'],
    'A 의 .12(표지 A·미발견)와 표지 없는 대역 안 옛 등록(.13)만 지운다 — B 의 .21·수동·대역 밖 옛 등록·다른 법인은 남는다');
  assert.equal(r.removed, 2);
  assert.ok(r.scopeKept >= 3, `범위 밖이라 남긴 같은 법인 항목 수를 밝힌다: ${r.scopeKept}`);
});

test('DEV-01: 엔트리 id·대역을 모르는 스캔 교체는 법인 전체로 떨어지지 않는다(아무것도 지우지 않음) · 직접 가져오기는 예전 그대로', () => {
  registry.deleteServers({ all: true });
  registry.registerScanned([dell('192.0.2.31'), dell('192.0.2.32')], 'root', 'pw', 'merge', '', 'DC3', { scanRangeId: 'rng-X' });
  registry.importServers([{ id: '192.0.2.33', name: 'old', host: '192.0.2.33', username: 'u', password: 'p', datacenterId: 'DC3' }], 'merge');
  registry.registerScanned([dell('192.0.2.31')], 'root', 'pw', 'replace-datacenter', '', 'DC3', {});
  assert.deepEqual(ids(), ['192.0.2.31', '192.0.2.32', '192.0.2.33'], '범위를 모르면 지우지 않는다(= 병합)');
  // 등록부 가져오기(replaceScope 없음)의 replace-datacenter 는 법인 전체 교체 그대로(registryImportModes 계약).
  registry.importServers([{ id: 'n1', name: 'n1', host: '192.0.2.40', username: 'u', password: 'p', datacenterId: 'DC3' }], 'replace-datacenter');
  assert.deepEqual(ids(), ['n1']);
});

test('DEV-01: makeScanReplaceScope — 판정 표(표지·대역·id 모양·OME)', () => {
  const sc = registry.makeScanReplaceScope({ scanRangeId: 'rng-A', ranges: '192.0.2.0/30' });
  assert.equal(sc({ id: 'x', host: 'https://192.0.2.1', scanRangeId: 'rng-A' }), true, '같은 표지');
  assert.equal(sc({ id: '192.0.2.1', host: 'https://192.0.2.1', scanRangeId: 'rng-B' }), false, '다른 엔트리 표지는 대역 안이어도 남긴다');
  assert.equal(sc({ id: '192.0.2.2', host: 'https://192.0.2.2' }), true, '표지 없는 옛 스캔 등록 + 대역 안');
  assert.equal(sc({ id: '192.0.2.9', host: 'https://192.0.2.9' }), false, '대역 밖');
  assert.equal(sc({ id: 'srv', host: 'https://192.0.2.2' }), false, '수동 id(접속 주소와 다름)');
  assert.equal(sc({ id: '192.0.2.2', host: 'https://192.0.2.2', type: 'ome' }), false, 'OME 연결');
  assert.equal(registry.makeScanReplaceScope({})({ id: '192.0.2.2', host: 'https://192.0.2.2' }), false, '대역을 모르면 추측하지 않는다');
});

/** 실제 scanPoller·localScan 을 돌린다 — 스캔 모듈(idrac/scan.js)만 가짜(장비 접속 0). */
function runScanScript(body) {
  const script = `
    import { mock } from 'node:test';
    globalThis.__FOUND = new Set();
    mock.module(${JSON.stringify(u('idrac/scan.js'))}, { namedExports: {
      scanForIdracs: async ({ ips }) => {
        const list = String(ips || '').split(/[\\n,]+/).map((x) => x.trim()).filter(Boolean);
        const found = list.filter((ip) => globalThis.__FOUND.has(ip)).map((ip) => ({ ip, serviceTag: 'T' + ip.split('.').pop(), hostName: 'h-' + ip.split('.').pop(), vendor: 'dell' }));
        return { scanned: list.length, found, foundCount: found.length, unreachable: list.length - found.length, notIdrac: 0, authFailed: 0, truncated: false, aborted: false, iloEnabled: false, unsupported: [], unsupportedCount: 0, noCreds: 0 };
      },
      scanPartialReasons: () => [],
      makeScanCredsFor: () => () => null,
      normIloCred: () => null,
    } });
    const registry = await import(${JSON.stringify(u('idrac/registry.js'))});
    const ids = () => registry.loadRegistry().map((s) => s.id).sort();
    const out = {};
    ${body}
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: TMP, DATA_SOURCE: 'live', IDRAC_SCAN_INTERVAL_MS: '0' } });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout + r.stderr);
  return JSON.parse(line.slice(2));
}

test('DEV-01: 중앙 주기 스캔 — 같은 법인의 두 교체 엔트리가 서로의 등록을 지우지 않는다(실제 scanPoller)', () => {
  writeJson('idrac.json', { servers: [] });
  writeJson('idrac-scan-ranges.json', { entries: {
    'rng-A': { datacenterId: 'DC9', service: 'svcA', ranges: ['192.0.2.51', '192.0.2.52'], username: 'root', password: 'pw', enabled: true, mode: 'replace-datacenter' },
    'rng-B': { datacenterId: 'DC9', service: 'svcB', ranges: ['192.0.2.61'], username: 'root', password: 'pw', enabled: true, mode: 'replace-datacenter' },
  } });
  const o = runScanScript(`
    const sp = await import(${JSON.stringify(u('idrac/scanPoller.js'))});
    for (const ip of ['192.0.2.51', '192.0.2.52', '192.0.2.61']) globalThis.__FOUND.add(ip);
    out.first = await sp.runIdracScanOnce({ manual: true });
    out.afterFirst = ids();
    globalThis.__FOUND.delete('192.0.2.52');   // A 의 서버 하나가 사라졌다
    out.second = await sp.runIdracScanOnce({ manual: true });
    out.afterSecond = ids();
    out.tags = Object.fromEntries(registry.loadRegistry().map((s) => [s.id, s.scanRangeId || '']));
  `);
  assert.equal(o.first.ok, true, JSON.stringify(o.first));
  assert.deepEqual(o.afterFirst, ['192.0.2.51', '192.0.2.52', '192.0.2.61'], '두 엔트리 모두 남아야 한다(예전: B 의 교체가 A 의 등록을 지웠다)');
  assert.deepEqual(o.afterSecond, ['192.0.2.51', '192.0.2.61'], 'A 의 사라진 서버만 지운다 — B 는 그대로');
  assert.equal(o.tags['192.0.2.61'], 'rng-B');
});

test('DEV-01: 엣지 localScan(수동 PUSH 교체) — 엔트리 id·스캔 대역 범위로만 지운다', () => {
  writeJson('idrac.json', { servers: [] });
  const o = runScanScript(`
    const { runLocalIdracScan } = await import(${JSON.stringify(u('idrac/localScan.js'))});
    for (const ip of ['192.0.2.71', '192.0.2.72', '192.0.2.81']) globalThis.__FOUND.add(ip);
    await runLocalIdracScan({ ips: '192.0.2.71\\n192.0.2.72', username: 'root', password: 'pw', datacenterId: 'DCE', mode: 'replace-datacenter', rangeId: 'rng-E1' });
    await runLocalIdracScan({ ips: '192.0.2.81', username: 'root', password: 'pw', datacenterId: 'DCE', mode: 'replace-datacenter', rangeId: 'rng-E2' });
    out.after = ids();
    globalThis.__FOUND.delete('192.0.2.72');
    await runLocalIdracScan({ ips: '192.0.2.71\\n192.0.2.72', username: 'root', password: 'pw', datacenterId: 'DCE', mode: 'replace-datacenter', rangeId: 'rng-E1' });
    out.after2 = ids();
  `);
  assert.deepEqual(o.after, ['192.0.2.71', '192.0.2.72', '192.0.2.81']);
  assert.deepEqual(o.after2, ['192.0.2.71', '192.0.2.81']);
});

/* ════════════════════ AUTHZ-01 — /idrac/host-power 범위 ════════════════════ */

let server; let base; let who = null; let store; let state;
async function startApi() {
  if (server) return;
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  store = (await import('../src/store.js')).store;
  state = await import('../src/collector/state.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api', api);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
}
after(() => { try { server?.close(); } catch { /* */ } });
async function hostPowerCall(name) {
  const r = await fetch(`${base}/idrac/host-power?name=${encodeURIComponent(name)}`);
  let body = null; try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
}
const SCOPED = { username: 'scop', role: 'operator', scope: { vcenters: ['vc-a'] } };
const FULL = { username: 'full', role: 'admin' };
let gen = 0;
async function setSnap(hosts, vcenters = [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }]) {
  store.snapshot = { generatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++gen)).toISOString(), source: 'live', vcenters, hosts, vms: [], datastores: [], networks: [], alarms: [] };
  (await import('../src/routes/admin/idracCore.js'))._resetIdracCorpIndex();
}
const srv = (id, vc, tag, host) => ({ id, name: 'esx01', host, username: 'u', password: 'p', vcenterId: vc, serviceTag: tag, hostNames: ['esx01'] });

test('AUTHZ-01: 범위 계정은 이름이 같은 다른 법인 iDRAC 서버를 받지 않는다(matched:false)', async () => {
  await startApi();
  writeJson('idrac.json', { servers: [srv('srv-b', 'vc-b', 'TAGB', 'https://10.9.0.2')] });
  await setSnap([{ id: 'h-a', name: 'esx01', vcenterId: 'vc-a', serviceTag: 'TAGA' }]);
  who = SCOPED;
  const r = await hostPowerCall('esx01');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.matched, false, `범위 밖 서버가 나가면 안 된다: ${JSON.stringify(r.body?.server)}`);
});

test('AUTHZ-01: 범위 밖 같은 이름 호스트가 앞에 있어도 범위 안 호스트·서버를 고른다(예전: 404)', async () => {
  await startApi();
  writeJson('idrac.json', { servers: [srv('srv-b', 'vc-b', 'TAGB', 'https://10.9.0.2'), srv('srv-a', 'vc-a', 'TAGA', 'https://10.9.0.1')] });
  await setSnap([{ id: 'h-b', name: 'esx01', vcenterId: 'vc-b', serviceTag: 'TAGB' }, { id: 'h-a', name: 'esx01', vcenterId: 'vc-a', serviceTag: 'TAGA' }]);
  who = SCOPED;
  const r = await hostPowerCall('esx01');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.matched, true);
  assert.equal(r.body.server.id, 'srv-a');
  // 전체 범위 계정은 예전 그대로(첫 일치).
  who = FULL;
  const f = await hostPowerCall('esx01');
  assert.equal(f.body.matched, true);
  assert.equal(f.body.server.id, 'srv-b', '전체 범위 동작은 바꾸지 않는다');
  // 범위 밖 호스트 이름만 있으면 범위 계정은 404(존재 은닉) 그대로.
  await setSnap([{ id: 'h-b', name: 'esx01', vcenterId: 'vc-b', serviceTag: 'TAGB' }]);
  who = SCOPED;
  assert.equal((await hostPowerCall('esx01')).status, 404);
});

test('AUTHZ-01: 엣지 보고 전력은 그 호스트를 수집한 엣지 항목만(범위 계정) · 전체 범위는 예전처럼 가장 최근', async () => {
  await startApi();
  writeJson('idrac.json', { servers: [] });
  writeJson('vcenters.json', { vcenters: [
    { id: 'vc-a', name: 'A', host: 'https://vc-a.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-a' },
    { id: 'vc-b', name: 'B', host: 'https://vc-b.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-b' },
  ] });
  const now = Date.now();
  state.setRemoteHost('esx02', { watts: 111, ts: now - 60_000, collectorId: 'edge-a', serverName: 'esx02', serviceTag: '', dbKey: 'rmt:edge-a:esx02' });
  state.setRemoteHost('esx02', { watts: 999, ts: now, collectorId: 'edge-b', serverName: 'esx02', serviceTag: '', dbKey: 'rmt:edge-b:esx02' });
  await setSnap([{ id: 'h-a2', name: 'esx02', vcenterId: 'vc-a' }]);
  who = SCOPED;
  const r = await hostPowerCall('esx02');
  assert.equal(r.body.matched, true, JSON.stringify(r.body));
  assert.equal(r.body.source, 'remote');
  assert.equal(r.body.server.id, 'remote:edge-a', `다른 법인 엣지(edge-b)의 더 최근 항목을 쓰면 안 된다: ${r.body.server.id}`);
  assert.equal(r.body.current.watts, 111);
  who = FULL;
  const f = await hostPowerCall('esx02');
  assert.equal(f.body.server.id, 'remote:edge-b', '전체 범위는 예전처럼 가장 최근 항목');
  // 담당 엣지의 항목이 없으면 범위 계정은 matched:false.
  await setSnap([{ id: 'h-a3', name: 'esx03', vcenterId: 'vc-a' }]);
  state.setRemoteHost('esx03', { watts: 5, ts: now, collectorId: 'edge-b', serverName: 'esx03', serviceTag: '' });
  who = SCOPED;
  assert.equal((await hostPowerCall('esx03')).body.matched, false);
});

/* ════════════════════ TIMING-03 — 파트 장애 꺼짐·재실행 ════════════════════ */

const dbFile = async () => {
  const { config } = await import('../src/config.js');
  return process.env.PARTFAULT_DB_FILE || path.join(config.dbDir || config.configDir, 'part-faults.db');
};

test('TIMING-03: 꺼져 있으면(기본) 인벤토리 갱신 훅이 판정·DB 생성을 하지 않는다', async () => {
  const H = await import('../src/partfault/hooks.js');
  H.onSnapshotRefreshed('idrac');
  await sleep(1400);
  const st = H.hookStatus();
  assert.ok(st.last, '훅이 돌았다');
  assert.equal(st.last.result?.skipped, true, `꺼짐이면 건너뛴다: ${JSON.stringify(st.last)}`);
  assert.equal(fs.existsSync(await dbFile()), false, 'part-faults.db 를 만들지 않는다');
  const P = await import('../src/partfault/poller.js');
  const r = await P.runPartFaultsNow({ reason: 'hook:idrac' });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(fs.existsSync(await dbFile()), false);
  const s = await P.partFaultStatus();
  assert.equal(s.lastSkip?.reason, 'hook:idrac', '건너뛴 사실을 상태가 말한다');
});

test('TIMING-03: 수동(지금 점검)은 꺼져 있어도 돈다 · 진행 중 요청은 거절하지 않고 끝난 뒤 한 번 더', async () => {
  const P = await import('../src/partfault/poller.js');
  const m = await P.runPartFaultsNow({ reason: 'manual' });
  assert.equal(m.ok, true, JSON.stringify(m));
  process.env.PARTFAULT_ENABLED = 'true';
  try {
    const p1 = P.runPartFaultsNow({ reason: 'hook:idrac' });
    const p2 = P.runPartFaultsNow({ reason: 'hook:idrac' });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r2.ok, true, `진행 중이던 요청은 '진행 중' 으로 거절되지 않는다: ${JSON.stringify(r2)}`);
    assert.equal(r2.reason, 'hook:idrac+again', '끝난 뒤 한 번 더 돈 결과를 받는다');
    assert.equal(r1.reason, 'hook:idrac+again', '앞 호출자도 합류한 최종 결과를 받는다');
    const s = await P.partFaultStatus();
    assert.equal(s.busy, false);
  } finally { delete process.env.PARTFAULT_ENABLED; }
});

/* ════════════════════ EDGE-03 — 위임 스캔 결과 회신 503 ════════════════════ */

test('EDGE-03: 결과 회신이 503 이면 같은 본문을 호출 안에서 다시 보내지 않고 다음 주기에 보낸다', async () => {
  const { config } = await import('../src/config.js');
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  let jobsServed = false; let resultHits = 0; let resultStatus = 503;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/idrac-scan-jobs')) {
        const jobs = jobsServed ? [] : [{ reqId: 'rq-1', action: 'register', found: [], username: 'u', password: 'p', mode: 'merge' }];
        jobsServed = true;
        return res.end(JSON.stringify({ jobs }));
      }
      if (req.url.startsWith('/api/central/idrac-scan-result')) {
        resultHits++;
        res.statusCode = resultStatus;
        return res.end(JSON.stringify(resultStatus === 200 ? { ok: true } : { ok: false, reason: 'dbUnavailable' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  try {
    config.agent.centralUrl = `http://127.0.0.1:${fake.address().port}`;
    config.agent.centralToken = 'tok';
    config.agent.name = 'edge-gd';
    const W = await import('../src/agent/idracScanWorker.js');
    await W.runIdracScanWorkerOnce();
    assert.equal(resultHits, 1, `호출 안에서 재전송하지 않는다(예전 3회): ${resultHits}`);
    const st = W.getIdracScanWorkerStatus();
    assert.equal(st.unsentResults.length, 1, '보내지 못한 회신을 미전송 목록에 둔다');
    assert.match(st.last?.postError || '', /다음 주기/);
    // 다음 주기 — 아직 때가 아니면 보내지 않는다.
    const early = await W.flushUnsentResults(Date.now());
    assert.equal(early.sent, 0);
    assert.equal(resultHits, 1);
    // 때가 되면(백오프 뒤) 다시 보낸다.
    resultStatus = 200;
    const late = await W.flushUnsentResults(Date.now() + 60_000);
    assert.equal(late.sent, 1, JSON.stringify(late));
    assert.equal(resultHits, 2);
    assert.equal(W.getIdracScanWorkerStatus().unsentResults.length, 0);
    // 410(중앙에 잡이 없음)은 다시 보내지 않는다.
    resultStatus = 503; jobsServed = false;
    await W.runIdracScanWorkerOnce();
    resultStatus = 410;
    const gone = await W.flushUnsentResults(Date.now() + 60_000);
    assert.equal(gone.dropped, 1);
    assert.equal(W.getIdracScanWorkerStatus().unsentResults.length, 0);
    assert.equal(W.getIdracScanWorkerStatus().unsentDropped?.reqId, 'rq-1');
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
    await new Promise((r) => fake.close(r));
  }
});
