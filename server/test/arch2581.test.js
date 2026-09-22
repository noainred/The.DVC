/**
 * v2.581 회귀 — 아키텍처 점검 3차.
 *  ① BUG-D: storage push 는 장비가 0대여도 상태 전용 본문을 중앙에 보낸다(v2.517 sendStatusOnly 규약 —
 *     v2.548 이 "storage/push.js:30 에는 아직 '0대면 POST 안 함' 결함이 남아 있다" 고 적어 둔 것).
 *     ⚠ push 함수를 **실제로 호출**해 목 HTTP 서버에 본문이 도착하는지 본다(v2.566 규약 — 순수 헬퍼만
 *     고정하는 테스트는 이 종류를 못 잡는다).
 *  ② 중앙 storageEdge 는 상태 전용 보고로 장비 목록을 **지우지 않는다**(빈 목록으로 덮으면 엣지 재시작
 *     직후 한 주기 동안 중앙 화면이 빈다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('BUG-D — storage push: 스냅샷 0대면 statusOnly 본문이 중앙에 도착한다(조용한 조기 반환 금지)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-push2581-'));
  process.env.CONFIG_DIR = dir;
  const { config } = await import('../src/config.js');
  config.configDir = dir;
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { bodies.push({ url: req.url, body: JSON.parse(buf) }); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"saved":0,"statusOnly":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  config.agent = { ...(config.agent || {}), name: 'edge-t2581', centralUrl: `http://127.0.0.1:${port}`, centralToken: 'tok-2581' };
  process.env.SSRF_ALLOW_LOOPBACK = 'true';
  try {
    const m = await import('../src/storage/push.js');
    const r = await m.pushStorageNow();
    assert.equal(r.sent, 0);
    assert.equal(r.statusSent, true, `상태 전용 push 가 성공해야 한다: ${JSON.stringify(r)}`);
    assert.equal(bodies.length, 1, '중앙으로 요청이 정확히 1건 가야 한다');
    assert.equal(bodies[0].url, '/api/central/storage-data');
    assert.equal(bodies[0].body.statusOnly, true);
    assert.deepEqual(bodies[0].body.devices, []);
    assert.equal(bodies[0].body.status.reason, 'no-snapshots');
    assert.ok(Number.isFinite(bodies[0].body.status.at));
    const st = m.storagePushStatus();
    assert.equal(st.statusSent, true);
  } finally {
    srv.close();
  }
});

test('BUG-D — 중앙 storageEdge: 상태 전용 보고는 장비 목록을 지우지 않고 status 만 기록한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-edge2581-'));
  process.env.CONFIG_DIR = dir;
  const { config } = await import('../src/config.js');
  config.configDir = dir;
  const m = await import('../src/central/storageEdge.js');
  m._resetForTest();
  m.saveEdgeStorage('edge-a', [{ deviceId: 'd1', name: 'D1', ok: true, collectedAt: Date.now() - 1000 }]);
  assert.equal(m.edgeStorageSnapshots().length, 1);
  m.saveEdgeStorageStatus('edge-a', { reason: 'no-snapshots', registered: 0, junk: 'x'.repeat(10_000) });
  assert.equal(m.edgeStorageSnapshots().length, 1, '상태 보고가 장비 목록을 지우면 안 된다');
  const rep = m.edgeStorageReports().find((r) => r.agent === 'edge-a');
  assert.equal(rep.deviceCount, 1);
  assert.equal(rep.status.reason, 'no-snapshots');
  assert.equal(rep.status.registered, 0);
  assert.equal('junk' in rep.status, false, '아는 키만 담는다');
  // 장비 보고가 다시 와도 마지막 상태는 남는다(언제 무엇을 보고했는지가 진단)
  m.saveEdgeStorage('edge-a', [{ deviceId: 'd1', name: 'D1', ok: true, collectedAt: Date.now() }]);
  assert.equal(m.edgeStorageReports().find((r) => r.agent === 'edge-a').status.reason, 'no-snapshots');
  // 등록부에 없던 엣지의 상태 전용 보고도 행을 만든다(보고 사실 자체가 진단)
  m.saveEdgeStorageStatus('edge-new', { reason: 'no-snapshots', registered: 3 });
  const n = m.edgeStorageReports().find((r) => r.agent === 'edge-new');
  assert.equal(n.deviceCount, 0); assert.equal(n.status.registered, 3);
});

test('TUNE-D — vmperf 파일별 DB 핸들 상한 기본값은 운영 vCenter 수(28, 30+ 예정)+합계 파일보다 크다', async () => {
  const m = await import('../src/metrics/vmperfDb.js');
  assert.ok(m.VMPERF_MAX_OPEN_DEFAULT >= 36, `기본 ${m.VMPERF_MAX_OPEN_DEFAULT} — 8 이면 33개 파일이 매 주기 LRU 스래싱(실측 openFile 68회/분)`);
});
