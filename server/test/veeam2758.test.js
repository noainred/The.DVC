/**
 * v2.758 — 실서버 GM1: vCenter 카드 '0/340 · 백업 · 스냅샷' 인데 VM 및 폴더 화면은 '최근 7일 Veeam 백업 시도 54대'.
 * 원인: 재시작 직후 골격 스냅샷(snap.initial — vCenter 목록만, VM 없음)에서 엣지가 대조할 VM 없이 'ok · 0대' 를 push 했고,
 *   카드는 그 값을 5분 캐시에 담아 다음 push(54대)를 늦게 보였다.
 *  ① 엣지 push 는 골격·VM 없는 vCenter 를 싣지 않는다(중앙은 직전 요약 유지)
 *  ② 중앙 카드·VM 화면은 VM 목록이 없으면 '0' 이 아니라 no-inventory(모름)
 *  ③ 엣지 요약은 캐시하지 않는다 — 새 push 가 카드와 VM 화면에 바로(같은 값으로) 보인다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2758-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const SITE = 'us:gm1';   // 엣지 위임
const LOC = 'kr:vc01';   // 중앙 직접 수집
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: SITE, name: 'GM1', host: 'gm1.corp.local', username: 'u', password: 'p', collectMode: 'site', agent: 'edge-us' },
  { id: LOC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/snapEvents.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('① 엣지 push — 재시작 직후 골격·VM 없는 vCenter 는 싣지 않는다 · 인벤토리가 있으면 싣는다', async () => {
  S.saveManualAccounts(['svc-veeam']);
  const rows = [{ vcenterId: SITE, ts: NOW - HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'app01', message: 'Task: Create virtual machine snapshot' }];
  const db = { query: () => rows, queryAsync: async () => rows };
  const skeleton = { initial: true, vcenters: [{ id: SITE, status: 'pending' }], vms: [] };
  assert.deepEqual(await S.edgeSnapPayload({ db, snap: skeleton, notCollected: new Map(), logSettings: null, now: NOW }), [], '골격에서는 보내지 않는다(예전: ok · byVm {})');
  const noVms = { vcenters: [{ id: SITE, status: 'unreachable' }], vms: [] };
  assert.deepEqual(await S.edgeSnapPayload({ db, snap: noVms, notCollected: new Map(), logSettings: null, now: NOW }), []);
  const ready = { vcenters: [{ id: SITE }], vms: [{ id: `${SITE}:vm-1`, vcenterId: SITE, name: 'app01' }] };
  const out = await S.edgeSnapPayload({ db, snap: ready, notCollected: new Map(), logSettings: null, now: NOW });
  assert.equal(out.length, 1); assert.deepEqual(Object.keys(out[0].byVm), [`${SITE}:vm-1`]);
});

test('②③ 라우트 — VM 목록이 없으면 모름 · 엣지 새 요약이 카드와 VM 화면에 같은 값으로 바로 보인다', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'a', role: 'admin' }; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api/veeam`;
  const get = async (p) => (await fetch(`${base}${p}`)).json();
  let gen = 0;
  const setSnap = (o) => { store.snapshot = { source: 'live', hosts: [], generatedAt: new Date(NOW + (++gen) * 1000).toISOString(), ...o }; };
  const vcs = [{ id: SITE, name: 'GM1' }, { id: LOC, name: 'vc01' }];
  const vms = Array.from({ length: 4 }, (_, i) => ({ id: `${SITE}:vm-${i}`, vcenterId: SITE, name: `g${i}` }));
  try {
    // 재시작 직후 골격 — 0 이 아니라 모름(두 화면 모두)
    setSnap({ initial: true, vcenters: vcs, vms: [] });
    const c0 = await get('/backup-counts');
    assert.equal(c0.byVc[SITE].n, null); assert.equal(c0.byVc[SITE].reason, 'no-inventory');
    assert.equal(c0.byVc[LOC].n, null); assert.equal(c0.byVc[LOC].reason, 'no-inventory');
    // 인벤토리 수집 뒤 — 엣지가 (옛 판본처럼) 빈 요약을 보낸 상태 → 0
    setSnap({ vcenters: vcs, vms });
    S.putEdgeSnap('edge-us', [{ vcenterId: SITE, status: 'ok', byVm: {}, accounts: 1, at: Date.now() }]);
    assert.equal((await get('/backup-counts')).byVc[SITE].n, 0);
    // 다음 push(54대에 해당) — 캐시 없이 바로, 카드와 VM 화면이 같은 수
    S.putEdgeSnap('edge-us', [{ vcenterId: SITE, status: 'ok', byVm: { [`${SITE}:vm-0`]: [NOW, 1], [`${SITE}:vm-2`]: [NOW, 2] }, accounts: 1, at: Date.now() }]);
    setSnap({ vcenters: vcs, vms }); // 응답 캐시(60초) 키만 바꾼다 — 스냅샷 요약 캐시는 엣지 값을 담지 않아야 한다
    const card = (await get('/backup-counts')).byVc[SITE];
    const detail = await get(`/snap-events?vcenterId=${encodeURIComponent(SITE)}`);
    assert.equal(card.n, 2, '엣지 새 요약이 카드에 바로');
    assert.equal(Object.keys(detail.byVm).length, card.n, 'VM 화면과 카드가 같은 값');
    assert.equal(detail.status, 'ok'); assert.equal(detail.source, 'edge');
  } finally { store.snapshot = prev; }
});
