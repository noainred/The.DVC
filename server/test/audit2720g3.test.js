// v2.720 그룹 G3 — 스토리지 폴러의 합성 조건은 **mock 모드 + 데모 장비(mock-)** 뿐이다(감사 R1-05·B2-04).
// 사람이 등록한 장비는 mock 모드에서도 실제로 수집하고 합성 스냅샷·용량 이력을 남기지 않는다. 데모 계정의 수집은 데모 장비만.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2720g3-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
process.env.SSRF_ALLOW_LOOPBACK = 'true'; // 닫힌 루프백 포트로 '실제 수집 시도 → 빠른 실패' 를 본다

let realId = '';
async function realDevice() {
  if (realId) return realId;
  // 포트 칸이 없으므로 https://127.0.0.1:443 — 이 환경에서 아무도 듣지 않아 즉시 연결 거부된다.
  const reg = await import('../src/storage/registry.js');
  const r = reg.saveDevice({ type: 'unity480', name: 'real-unity', host: '127.0.0.1', username: 'admin', password: 'p', collectMethod: 'api' });
  realId = r?.device?.id || r?.id;
  assert.ok(realId && !String(realId).startsWith('mock-'), JSON.stringify(r));
  return realId;
}

test('① useDemoSynth: mock 모드 + mock- id 일 때만 참', async () => {
  const { useDemoSynth } = await import('../src/storage/poller.js');
  assert.equal(useDemoSynth({ id: 'mock-st-01' }), true);
  assert.equal(useDemoSynth({ id: 'dev-human-01' }), false);
  assert.equal(useDemoSynth(null), false);
});

test('② 사람이 등록한 장비: mock 모드에서도 합성 스냅샷·용량 이력을 쓰지 않는다(실제 수집 시도 → 실패)', async () => {
  const id = await realDevice();
  const poller = await import('../src/storage/poller.js');
  await poller.collectDeviceNow(id);
  const { localSnapshots } = await import('../src/storage/store.js');
  const snap = localSnapshots().find((x) => x.deviceId === id);
  assert.ok(snap, '스냅샷이 있다');
  assert.notEqual(snap.extra?.mock, true, `합성 스냅샷이 실장비를 덮으면 안 된다: ${snap.name}`);
  assert.equal(snap.ok, false, '닫힌 포트 — 실제 수집 실패');
  const db = await import('../src/storage/db.js');
  const hist = await db.capacityHistory(id, 0).catch(() => null);
  const rows = Array.isArray(hist) ? hist : (hist?.points || hist?.rows || []);
  assert.equal(rows.length, 0, `실장비 용량 이력에 합성 행: ${JSON.stringify(hist).slice(0, 200)}`);
});

test('③ pollStorageOnce({demoOnly}): 사람이 등록한 장비는 건너뛰고 개수를 밝힌다', async () => {
  await realDevice();
  const poller = await import('../src/storage/poller.js');
  const r = await poller.pollStorageOnce({ demoOnly: true });
  assert.equal(r.demoOnly, true, JSON.stringify(r));
  assert.ok(r.skippedNonDemo >= 1, JSON.stringify(r));
  assert.equal(r.fail, 0, `데모 계정 실행이 실장비에 접속하면 안 된다: ${JSON.stringify(r)}`);
});

test('④ 라우트: 데모 계정은 사람이 등록한 장비를 수집할 수 없고(403) 전체 새로고침은 데모 장비만', async () => {
  const id = await realDevice();
  const express = (await import('express')).default;
  const { registerStorageMon } = await import('../src/routes/api/storageMon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'demo', role: 'admin', demoGuest: true }; next(); });
  const router = express.Router();
  registerStorageMon(router);
  app.use('/api', router);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const one = await fetch(`${base}/tools/storage/devices/${id}/collect`, { method: 'POST' });
    assert.equal(one.status, 403);
    const b1 = await one.json();
    assert.equal(b1.demoGuest, true);
    const all = await fetch(`${base}/tools/storage/collect-all`, { method: 'POST' });
    const b2 = await all.json();
    assert.equal(all.status, 200, JSON.stringify(b2));
    assert.equal(b2.result?.demoOnly, true, JSON.stringify(b2));
    assert.ok(b2.result?.skippedNonDemo >= 1, JSON.stringify(b2));
  } finally { await new Promise((r) => srv.close(r)); }
});
