/**
 * v2.961 반증 F1(OS 쪽) — OS 계정 등록부(bm-storage.json)를 **못 읽으면** 원격 수집 서버(엣지)가 맡은 서버를 '엣지 수집' 으로 단정하지 않는다.
 *   bmstor/registry.js 는 프로세스 첫 읽기를 캐시하므로(손상은 첫 읽기에서만 드러난다) 이 시험은 별도 파일(별도 프로세스)에서 손상 상태로 시작한다.
 *   1차 판(fa5bb293): OS 계정으로 수집하던 원격 서버 · os-foreign · os-ambiguous 행까지 edge-delegated(edge-pl) — 못 읽음을 '등록 없음' 으로 읽었다.
 *   고친 판: 예전(기준판) 사유 그대로 · sourceErrors 경고가 '엣지 수집으로 가르지 않는다' 를 말한다 · 누락 점검도 엣지로 보내지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmrmt2961os-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.CENTRAL_TOKEN = 'test-central-token-2961os';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨린다(docs/rules/common.md). 원격 전력 신선도(2시간) 안.
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const VCS = [{ id: 'vcA', name: 'A 법인', status: 'connected' }, { id: 'vcB', name: 'B 법인', status: 'connected' }];

test('반증 F1(OS) — OS 계정 등록부 손상: 원격 서버를 엣지 수집으로 단정하지 않는다 · 경고가 이유를 말한다 · 누락 점검도 같다', async () => {
  fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'edge-pl', url: 'https://10.9.0.1:3443', enabled: true }] }));
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), '{"servers": [ {"id": "o1", "name": "os-only-01"');   // 손상 — 정상이면 os-only-01 OS 계정으로 중앙이 수집
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: true, includeUnassigned: false }));
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: 'g-os-1', vcenters: VCS, hosts: [] };
  const { setRemoteHost } = await import('../src/collector/state.js');
  setRemoteHost('10.5.0.20', { collectorId: 'c1', serverId: 20, serverName: 'os-only-01', serviceTag: 'RMT020', watts: 300, ts: NOW, vcenterId: 'vcA' });
  setRemoteHost('10.5.0.1', { collectorId: 'c1', serverId: 1, serverName: 'rm-noreg', serviceTag: 'RMT001', watts: 300, ts: NOW, vcenterId: 'vcA' });
  const poller = await import('../src/bmusage/poller.js');
  const tg = await poller.currentTargets();
  assert.ok(tg.sourceErrors.some((e) => e.source === 'os-registry'), '손상이 실제로 드러났다');
  const se = tg.sourceErrors.find((e) => e.source === 'os-registry');
  assert.match(se.error, /no-os-cred 로 보일 수 있습니다/);
  assert.match(se.error, /베어메탈 서버도 이 동안은 ‘엣지 수집’ 으로 가르지 않습니다/, '재확인 R2: OS 등록부만 못 읽으면 베어메탈만 보류한다(가상화 호스트는 iDRAC 등록부만 본다)');
  assert.match(se.error, /가상화 호스트는 iDRAC 등록부만 봅니다/);
  const by = Object.fromEntries(tg.skipped.map((s) => [s.serviceTag, s]));
  assert.equal(by.RMT020.reason, 'no-idrac', '예전(기준판) 사유 — 1차 판: edge-delegated');
  assert.equal(by.RMT001.reason, 'no-idrac', '등록이 없는지 모른다 — 단정하지 않는다');
  assert.ok(!tg.skipped.some((s) => s.reason === 'edge-delegated' || s.reason === 'remote-collector-unknown'));
  // 누락 점검(실제 라우트) — 엣지로 보내지 않는다
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const a = express(); a.use(express.json());
  a.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  a.use('/api', api);
  const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/onboard/missing`);
    const m = await r.json();
    assert.equal(r.status, 200, JSON.stringify(m));
    assert.deepEqual(m.rows.filter((x) => x.via === 'edge').length, 0);
  } finally { srv.close(); }
});
