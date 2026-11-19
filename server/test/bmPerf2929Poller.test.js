/**
 * v2.929(5단계 · 반증 review-s5 ‘진입 함수는 실제로 호출’) — 폴러 배선: pollBmUsageOnce → prepareCycleOps → 적재 → changeWriteBatch → runCyclePerfAlerts ·
 *   pruneTick 의 집중 · 변경 정리(대상에서 사라진 서버의 change_latest) · 반증 L5(대상이 일부만 해석된 주기의 목록으로는 지우지 않는다).
 *   데모(mock) 대상으로 돈다 — 장비 접속 없이 합성 행(실제 폴러 경로 그대로) · 알림은 데모라 보내지 않는다(skipped demo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2929po-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const SERVERS = [
  { id: 'mock-bmsrv-po-db01', name: 'po-db01', tag: 'POTAG01' },
  { id: 'mock-bmsrv-po-db02', name: 'po-db02', tag: 'POTAG02' },
];
const writeIdrac = (list) => fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: list.map((x) => ({ id: x.id, name: x.name, host: '10.9.9.9', username: 'root', password: 'p' })) }));
const fleetOf = (list) => async () => ({ bareMetal: list.map((x) => ({ serverId: x.id, name: x.name, serviceTag: x.tag })), virtualizationHosts: [] });

test('폴러 한 주기 — 소모품 · 변경 사실 → change_latest 적재 · 알림 규칙 경로 호출(데모라 보내지 않음) · 정리 틱이 사라진 서버만 지운다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  writeIdrac(SERVERS);
  const R = await import('../src/bmusage/perfRules.js');
  R.savePerfRules({ rules: { use: { on: true } } }, { by: 'adm' });
  const P = await import('../src/bmusage/poller.js');
  const O = await import('../src/bmusage/opsDb.js');
  const { config } = await import('../src/config.js');
  const agent = config.agent?.name || '';
  P._setFleetForTest(fleetOf(SERVERS));
  try {
    const r1 = await P.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const last = P.bmUsageStatus().last;
    assert.ok(last.cycleOps, '소모품 · 변경 단계가 돌았다(_last.cycleOps)');
    assert.equal(last.cycleOps.error, null, JSON.stringify(last.cycleOps));
    assert.equal(last.perfAlertsSkipped, 'demo', '켠 규칙이 있으면 알림 경로를 부른다(데모 값으로는 보내지 않는다)');
    const latest = await O.changeLatestAll({ agent });
    assert.deepEqual([...latest.keys()].sort(), ['POTAG01', 'POTAG02'], 'changeWriteBatch 가 서버마다 최신 사실을 남긴다');
    // 정리 틱 — 둘 다 대상이면 지우지 않는다
    const p1 = await P.pruneTick({ every: 1 });
    assert.equal(p1.opsPruned?.changeLatestGone, 0, JSON.stringify(p1));
    // 정상 주기에서 한 서버가 대상에서 빠지면 그 서버만 지운다
    P._setFleetForTest(fleetOf(SERVERS.slice(0, 1)));
    writeIdrac(SERVERS.slice(0, 1));
    await P.pollBmUsageOnce({ trigger: 'manual' });
    const p3 = await P.pruneTick({ every: 1 });
    assert.equal(p3.opsPruned?.changeLatestGone, 1, JSON.stringify(p3.opsPruned));
    assert.deepEqual([...(await O.changeLatestAll({ agent })).keys()], ['POTAG01']);
  } finally { P._setFleetForTest(null); R._resetPerfRulesForTest(); }
});
