// 서비스 인벤토리 6차 반증 F2(재현): 엣지 '태그 없을 때 id'(untaggedServerId — 고정 승계 내부용)가 /insights/fleet 응답에 실려
//   비관리자 주소 가림(maskFleetPayload)을 비켜 갔다. IP 스캔으로 등록한 iDRAC 은 등록부 id 가 곧 IP 라 'edge:<agent>:10.x.x.x' 가 된다.
//   응답에서 그 필드를 빼고(관리자 포함 — 내부용), 가림 목록에도 넣는다(이중). 수정 전 코드에서 관리자·운영자 둘 다 IP 가 보였다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r6b-'));
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
const { config } = await import('../src/config.js');
const express = (await import('express')).default;
const { insightsRouter, maskFleetPayload } = await import('../src/routes/insights.js');
const central = await import('../src/central/fleet.js');
const { store } = await import('../src/store.js');

const IP = '10.20.30.40';
test('6차 반증 F2: /insights/fleet 은 untaggedServerId 를 싣지 않는다 — 관리자·운영자 모두 엣지 등록 IP 가 보이지 않는다', async () => {
  await store.refresh({ force: true });
  const prev = { central: config.central, agent: config.agent };
  config.central = { ...(config.central || {}), token: 'tok-r6b' }; config.agent = { ...(config.agent || {}), centralUrl: '' };
  try {
    central.setEdgeFleet('agt', [{ fleetId: 'tag9', name: 'srv9', serviceTag: 'TAG9', vcenterId: '', untaggedId: IP }], Date.now());
    for (const user of [{ username: 'root', role: 'admin', scope: null }, { username: 'op', role: 'operator', scope: null }]) {
      const app = express(); app.use((req, _r, n) => { req.user = user; n(); }); app.use('/api/insights', insightsRouter);
      const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
      try {
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/insights/fleet`);
        const t = await res.text();
        assert.equal(res.status, 200, t.slice(0, 300));
        assert.ok(t.includes('edge:agt:tag9'), '엣지 행이 실제로 들어 있다(시험 전제)');
        assert.equal(t.includes(IP), false, `${user.username}: 엣지 등록 IP 가 응답에 없다`);
        assert.equal(t.includes('untaggedServerId'), false);
      } finally { srv.close(); }
    }
  } finally { config.central = prev.central; config.agent = prev.agent; central.resetEdgeFleet(); }
  // 가림 목록에도 있다(응답에서 빼는 것을 누가 되돌려도 비관리자 판본은 가린다)
  const m = maskFleetPayload({ bareMetal: [{ serverId: 'edge:agt:tag9', untaggedServerId: `edge:agt:${IP}` }] }, (v) => String(v || '').includes(IP));
  assert.equal(JSON.stringify(m).includes(IP), false);
});
