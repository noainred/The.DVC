// v2.719 그룹 A2 — mock 모드 합성 수집은 **데모 장비(mock-)에만**(감사 R1-03·R2-03·B2-01·B2-02).
// 사람이 등록한 장비는 mock 모드에서도 예전처럼 실제로 수집하고, 합성 값이 실장비 id 로 이력 DB 에 남지 않아야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719a2-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 닫힌 루프백 포트로 '실제 수집 시도 → 실패' 를 본다

// 닫힌 포트(연결 거부) — 실제 수집이 '시도됐다' 는 것을 빠르게 실패로 보게 한다(합성이면 성공으로 나온다).
async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('① 베어메탈 사용률: 데모 대상 판정과 데모 행 표지(src 에 demo, iDRAC 출처 판정은 그대로)', async () => {
  const { isDemoBmTarget, demoBmUsageRow } = await import('../src/mock/demo/baremetal.js');
  const { bmSrcIsIdrac } = await import('../src/idrac/serverTrendSeries.js');
  assert.equal(isDemoBmTarget({ serverId: 'mock-bmsrv-vc1-db01', idrac: { regId: 'mock-bmsrv-vc1-db01' } }), true);
  assert.equal(isDemoBmTarget({ serverId: 'idrac-real-01', idrac: { regId: 'idrac-real-01' } }), false);
  assert.equal(isDemoBmTarget({ serverId: '', osHost: { id: 'mock-bm-1' } }), true);
  assert.equal(isDemoBmTarget({ serverId: 'real', osHost: { id: 'mock-bm-1' } }), false);
  const row = demoBmUsageRow({ key: 'TAG1', serverId: 'mock-bmsrv-x', name: 'db01' }, 1_790_000_000_000);
  assert.ok(String(row.src).split('+').includes('demo'), 'demo 표지');
  assert.equal(bmSrcIsIdrac(row.src), true, 'iDRAC 출처 판정은 그대로');
});

test('② 베어메탈 사용률: 저장 설정이 꺼져 있으면 실등록 서버는 대상이 아니다(데모만) — 켜져 있으면 실제로 수집한다', async () => {
  const port = await closedPort();
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [
    { id: 'mock-bmsrv-x-db01', name: 'demo-db01', host: '10.9.9.9', username: 'root', password: 'p' },
    { id: 'real-idrac-01', name: 'real-db01', host: `127.0.0.1:${port}`, username: 'root', password: 'p' },
  ] }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({
    bareMetal: [
      { serverId: 'mock-bmsrv-x-db01', name: 'demo-db01', serviceTag: 'DEMOTAG1' },
      { serverId: 'real-idrac-01', name: 'real-db01', serviceTag: 'REALTAG1' },
    ],
    virtualizationHosts: [],
  }));
  try {
    // 저장 설정 없음(꺼짐) — 데모 설정은 데모 대상에만.
    let tg = await poller.currentTargets();
    assert.deepEqual(tg.targets.map((x) => x.key), ['DEMOTAG1']);
    assert.equal(tg.demoScope?.realNotEnabled, 1, '뺀 실등록 대수를 밝힌다');
    // 저장 설정을 켠다(귀속 없는 서버 포함 · iDRAC 경로) — 실등록은 저장 설정으로 판정되어 대상이 된다.
    const { saveBmUsageSettings } = await import('../src/bmusage/settings.js');
    saveBmUsageSettings({ enabled: true, includeUnassigned: true, idracTelemetry: true });
    tg = await poller.currentTargets();
    assert.deepEqual(tg.targets.map((x) => x.key).sort(), ['DEMOTAG1', 'REALTAG1']);
    const r = await poller.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(r.ok, true, JSON.stringify(r));
    // 실등록은 실제로 접속을 시도해 실패해야 한다(합성이면 성공 2대가 된다).
    assert.equal(r.okCount, 1, `실등록 서버가 합성되면 안 된다: ${JSON.stringify(r)}`);
    assert.equal(r.failCount, 1);
    const db = await import('../src/bmusage/db.js');
    const latest = await db.latestAll?.('') ?? null;
    if (Array.isArray(latest)) assert.ok(!latest.some((x) => x.key === 'REALTAG1'), '실등록 키로 합성 행이 적재되면 안 된다');
  } finally { poller._setFleetForTest(null); }
});

test('③ SAN 스위치: 사람이 등록한 스위치는 mock 모드에서도 합성하지 않는다(스냅샷·포트 사용량 DB)', async () => {
  const port = await closedPort();
  const reg = await import('../src/sanswitch/registry.js');
  const saved = reg.saveDevice({ type: 'brocade', name: 'real-sw', host: '127.0.0.1', sshPort: port, username: 'admin', password: 'p' });
  const id = saved?.device?.id || saved?.id;
  assert.ok(id && !id.startsWith('mock-san-'), JSON.stringify(saved));
  const poller = await import('../src/sanswitch/poller.js');
  await poller.collectDeviceNow(id).catch(() => {});
  const { getSnapshot } = await import('../src/sanswitch/store.js');
  const snap = getSnapshot(id);
  assert.ok(snap, '스냅샷이 있다');
  assert.notEqual(snap.extra?.mock, true, `합성 스냅샷이 실장비를 덮으면 안 된다: ${snap.name}`);
  assert.equal(snap.ok, false, '닫힌 포트 — 실제 수집 실패');
  const perf = await import('../src/sanswitch/perfPoller.js');
  const out = await perf.pollPerfOnce({ force: true });
  assert.equal(out.ok, true);
  assert.equal(out.collected, 0, `실장비에 합성 처리량이 수집되면 안 된다: ${JSON.stringify(out)}`);
  const { perfDbStats } = await import('../src/sanswitch/perfDb.js');
  const st = await perfDbStats();
  assert.ok(!st?.rows, `포트 사용량 DB 에 행이 없어야 한다: ${JSON.stringify(st)}`);
});

test('④ SAN 포트 사용량: 저장 설정이 꺼진 채 데모로 도는 주기는 데모 장비만 — 실등록 수는 notEnabled 로 밝힌다', async () => {
  const perf = await import('../src/sanswitch/perfPoller.js');
  const reg = await import('../src/sanswitch/registry.js');
  const real = reg.listDevices().filter((d) => !String(d.id).startsWith('mock-san-'));
  assert.ok(real.length >= 1);
  const out = await perf.pollPerfOnce();   // force 아님 · 저장 설정 꺼짐(mock 이라 demoOn)
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.failed, 0, `실등록 장비를 시도하면 안 된다: ${JSON.stringify(out)}`);
  assert.equal(out.notEnabled, real.length);
});

test('⑤ 스토리지: 사람이 등록한 Isilon 의 영역 DB 에는 합성 행을 저장하지 않는다(데모 장비는 저장)', async () => {
  const reg = await import('../src/storage/registry.js');
  const r = reg.saveDevice({ type: 'isilon', name: 'real-isi', host: '10.250.1.10', username: 'admin', password: 'p', collectMethod: 'api' });
  const id = r?.device?.id || r?.id;
  assert.ok(id && !String(id).startsWith('mock-'), JSON.stringify(r));
  const poller = await import('../src/storage/poller.js');
  await poller.collectDeviceNow(id);
  const db = await import('../src/storage/db.js');
  const sum = await db.areaSummary(id);
  const rows = Array.isArray(sum) ? sum : (sum?.areas || sum?.rows || []);
  assert.equal(rows.length, 0, `실장비 영역 DB 에 합성 행: ${JSON.stringify(sum).slice(0, 200)}`);
});

test('⑥ 베어메탈 스토리지: 사람이 등록한 서버는 합성하지 않는다(데모 서버만 합성)', async () => {
  const port = await closedPort();
  const reg = await import('../src/bmstor/registry.js');
  const r = reg.saveBmServer({ name: 'real-nas', host: '127.0.0.1', port, username: 'u', password: 'p', mounts: ['/'] });
  const id = r?.server?.id || r?.id;
  assert.ok(id && !String(id).startsWith('mock-'), JSON.stringify(r));
  const poller = await import('../src/bmstor/poller.js');
  const out = await poller.bmCollectNow('manual');
  assert.equal(out.ok, true, JSON.stringify(out));
  const res = poller.getBmLatest().get(id);
  assert.ok(res, '결과가 있다');
  assert.equal(res.ok, false, `실서버가 합성 성공이면 안 된다: ${JSON.stringify(res).slice(0, 200)}`);
  // 기준판은 실서버를 데모 경로에 넣어 '데모 사양 없음' 이라는 지어낸 실패를 만들었다 — 실제 접속을 시도한 실패여야 한다.
  assert.doesNotMatch(String(res.error || ''), /데모/, `실제 수집을 시도해야 한다: ${res.error}`);
});
