/**
 * v2.929(5단계 · 반증 L5) — 대상이 **일부만 해석된 주기**(등록부 못 읽음 — sourceErrors)의 대상 목록으로는 change_latest 를 지우지 않는다.
 *   OS 계정 등록부(bm-storage.json)가 처음부터 손상이라 매 주기 sourceErrors 가 있다(대상은 iDRAC 경로로 2대 남는다).
 *   정리 틱이 그 목록으로 지우면 목록 밖(그 등록부에만 있던) 서버의 기준선이 사라져, 돌아올 때 ‘첫 관찰’ 이 된다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm2929l5-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const SERVERS = [{ id: 'mock-bmsrv-l5-db01', name: 'l5-db01', tag: 'L5TAG01' }, { id: 'mock-bmsrv-l5-db02', name: 'l5-db02', tag: 'L5TAG02' }];
fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: SERVERS.map((x) => ({ id: x.id, name: x.name, host: '10.9.9.9', username: 'root', password: 'p' })) }));
fs.writeFileSync(path.join(DIR, 'bm-storage.json'), '{broken');

test('L5 — sourceErrors 가 있는 주기의 목록으로는 정리 틱이 change_latest 를 지우지 않는다', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const P = await import('../src/bmusage/poller.js');
  const O = await import('../src/bmusage/opsDb.js');
  const { config } = await import('../src/config.js');
  const agent = config.agent?.name || '';
  await O.changeWriteBatch({ agent, items: [{ key: 'GHOST-OS-ONLY', at: Date.now(), facts: { kernel: '5.14' }, events: [] }] });
  P._setFleetForTest(async () => ({ bareMetal: SERVERS.map((x) => ({ serverId: x.id, name: x.name, serviceTag: x.tag })), virtualizationHosts: [] }));
  try {
    const r = await P.pollBmUsageOnce({ trigger: 'manual' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok((P.bmUsageStatus().last?.sourceErrors || []).some((x) => x.source === 'os-registry'), 'OS 등록부 손상 = 일부만 해석');
    assert.equal(r.servers, 2, '대상은 남았다(iDRAC 경로)');
    const p = await P.pruneTick({ every: 1 });
    assert.equal(p.opsPruned?.changeLatestGone, 0, JSON.stringify(p.opsPruned));
    assert.ok((await O.changeLatestAll({ agent })).has('GHOST-OS-ONLY'), '목록 밖 서버의 기준선이 남는다');
  } finally { P._setFleetForTest(null); }
});
