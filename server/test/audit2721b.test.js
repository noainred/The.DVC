// v2.721 감사 그룹 B — 데모 계정 실행·구성 캐시 정리 순서.
//   S1-01·R1-04  store.refresh: 구성 캐시 6종 정리(syncVcConfigCaches)는 수집 '전' 이다 — 접속처를 바꾼 첫 주기에
//                옛 vCenter 의 같은 moref 구성 값이 새 스냅샷에 붙지 않게.
//   R1-03·S1-02  Horizon demoOnly: mock 모드에서는 거르지 않는다(사람 등록 서버의 최신 행이 지워지지 않는다).
//                거르는 경로(스냅샷이 mock 이 아님)는 정리 기준이 등록 전체이고 '전체' 추이에 부분 합을 적재하지 않는다.
//   S1-04        베어메탈 스토리지 demoOnly 실행은 lastRunAt 을 갱신하지 않는다(실서버 주기 수집이 밀리지 않게).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2721b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 가짜 vCenter·닫힌 포트(127.0.0.1)를 등록하려고 — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
const writeJson = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
async function closedPort() {
  const s = net.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

test('S1-01·R1-04 구성 캐시 정리는 수집 전에 일어난다 — 새 접속처 수집 중에 옛 vCenter 구성 값이 남아 있지 않다', async () => {
  const vmcfg = await import('../src/vmcfg/cache.js');
  const { syncVcConfigCaches } = await import('../src/hostcfg/cache.js');
  // 가짜 vCenter: 첫 요청이 들어오는 순간(= 이 vCenter 수집 중) 캐시 상태를 기록하고 바로 실패시킨다.
  const seen = { atFirstRequest: undefined, requests: 0 };
  const srv = http.createServer((req, res) => {
    seen.requests += 1;
    if (seen.atFirstRequest === undefined) seen.atFirstRequest = vmcfg.get('vc-b21', 'vm-101');
    req.resume();
    req.on('end', () => { res.writeHead(500, { 'content-type': 'text/xml' }); res.end('<faultstring>nope</faultstring>'); });
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));

  // 옛 접속처(A)로 알고 있던 캐시 — 같은 id 를 그대로 두고 host 만 B(가짜 서버)로 바꾼다.
  syncVcConfigCaches([{ id: 'vc-b21', host: 'https://old-vc.example.invalid' }]);
  vmcfg.put('vc-b21', 'vm-101', 'cfg', { cpuHotAdd: true, src: 'A' });
  assert.ok(vmcfg.get('vc-b21', 'vm-101'), '전제: 옛 vCenter 값이 캐시에 있다');
  writeJson('vcenters.json', { vcenters: [
    { id: 'vc-b21', name: 'VC-B', host: `http://127.0.0.1:${port}`, username: 'administrator@vsphere.local', password: 'x', enabled: true, timeoutMs: 3000 },
  ] });
  const { store } = await import('../src/store.js');
  await store.refresh();
  assert.ok(seen.requests >= 1, '새 접속처로 수집을 시도했다');
  assert.equal(seen.atFirstRequest, null, `수집 중에 옛 vCenter 구성 값이 남아 있으면 새 스냅샷에 붙는다: ${JSON.stringify(seen.atFirstRequest)}`);
  assert.equal(vmcfg.get('vc-b21', 'vm-101'), null);
});

async function hzSetup() {
  // mock 모드(데모 등록이 대상에 드는 조건 — targetServers 가 런타임 데이터 소스를 본다)
  const rt = await import('../src/runtime-settings.js');
  assert.equal(rt.setDataSource('mock').ok, true);
  const hz = await import('../src/horizon/horizon.js');
  const refused = await closedPort();
  const r0 = hz.upsertHorizon({ id: 'real-hz-b21', name: 'Real HZ', host: `https://127.0.0.1:${refused}`, username: 'u', password: 'p', domain: 'D' });
  const r1 = hz.upsertHorizon({ id: 'mock-hz-b21', name: 'Demo HZ', host: `https://127.0.0.1:${refused}`, username: 'u', password: 'p', domain: 'D' });
  assert.ok(r0?.ok !== false && r1?.ok !== false, `등록 실패: ${JSON.stringify([r0, r1])}`);
}

test('R1-03·S1-02 Horizon demoOnly(mock): 사람이 등록한 서버의 최신 행을 지우지 않는다', async () => {
  await hzSetup();
  const { store } = await import('../src/store.js');
  store.snapshot = { ...(store.snapshot || {}), source: 'mock' };
  const p = await import('../src/horizon/sessionPoller.js');
  const db = await import('../src/horizon/sessionDb.js');
  const a = await p.runHzSessionsNow('manual');
  assert.ok(a.servers >= 2, JSON.stringify(a));
  const ids0 = (await db.hzLatestRecords()).map((r) => r.serverId);
  assert.ok(ids0.includes('real-hz-b21') && ids0.includes('mock-hz-b21'), JSON.stringify(ids0));
  await new Promise((r) => setTimeout(r, 5));
  const b = await p.runHzSessionsNow('manual', { demoOnly: true });
  assert.notEqual(b.skipped, true, JSON.stringify(b));
  const ids1 = (await db.hzLatestRecords()).map((r) => r.serverId);
  assert.ok(ids1.includes('real-hz-b21'), `demoOnly 실행이 사람 등록 서버의 최신 행을 지웠다: ${JSON.stringify(ids1)}`);
});

test('S1-02 Horizon demoOnly 로 실제로 거른 실행(스냅샷 mock 아님)은 정리 기준이 등록 전체이고 전체 추이에 적재하지 않는다', async () => {
  const { store } = await import('../src/store.js');
  const db = await import('../src/horizon/sessionDb.js');
  const p = await import('../src/horizon/sessionPoller.js');
  store.snapshot = { ...(store.snapshot || {}), source: 'live' };
  const before = (await db.hzLatestRecords()).map((r) => r.serverId);
  assert.ok(before.includes('real-hz-b21'), '전제: 앞 테스트의 최신 행');
  const T0 = Date.now() - 1000;
  const r = await p.runHzSessionsNow('manual', { demoOnly: true });
  assert.equal(r.skippedNonDemo, 1, JSON.stringify(r));
  const ids = (await db.hzLatestRecords()).map((x) => x.serverId);
  assert.ok(ids.includes('real-hz-b21'), `걸러낸 서버를 '등록이 사라졌다' 로 읽고 지웠다: ${JSON.stringify(ids)}`);
  const rng = await db.hzSeriesRange('', T0, Date.now() + 1000);
  const rows = (rng?.rows || []).filter((x) => Number(x.ts) >= T0 && Number(x.ts) === Number(r.at));
  assert.equal(rows.length, 0, `걸러낸 실행의 부분 합이 전체 추이에 적재됐다: ${JSON.stringify(rows)}`);
  store.snapshot = { ...(store.snapshot || {}), source: 'mock' };
});

test('S1-04 베어메탈 스토리지 demoOnly 실행은 lastRunAt 을 갱신하지 않는다(일반 실행은 갱신)', async () => {
  const bm = await import('../src/bmstor/poller.js');
  assert.equal(bm.bmPollerStatus().lastRunAt, 0, '전제: 기동 뒤 실행 없음');
  const r = await bm.bmCollectNow('manual', { demoOnly: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(bm.bmPollerStatus().lastRunAt, 0, 'demoOnly 실행이 주기 기준 시각을 갱신하면 실서버 주기 수집이 밀린다');
  await bm.bmCollectNow('manual');
  assert.ok(bm.bmPollerStatus().lastRunAt > 0, '일반 실행은 예전처럼 갱신한다');
});
