/**
 * v2.757 — vCenter 카드의 'VM 백업 수량'(사용자 요청: Veeam 연동이면 Veeam 기준, 아니면 스냅샷 기준 · 182/195 형식).
 *  · 판정(순수): Veeam 은 대조된 VM 수 · 실패 서버가 있으면 부분 · 결과가 없으면 모름 / 스냅샷은 이벤트 ∪ 지금 임시 스냅샷(VM 단위 한 번) ·
 *    이벤트를 못 보면(꺼짐·엣지 없음·수집 멈춤 6시간·계정 모름) 0 이 아니라 모름.
 *  · 라우트: 범위 밖 vCenter 는 싣지 않는다 · Veeam 이 연결된 vCenter 는 스냅샷과 섞지 않는다 · 오류 원문·계정 이름 없음.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2757-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // Veeam 연결
const SN = 'apac:vc02';   // 연동 없음(직접 수집 — 로그 DB)
const SITE = 'eu:vc03';   // 연동 없음(엣지 위임 — 요약 없음)
const OUT = 'us:vc04';    // 범위 밖
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
  { id: SN, name: 'vc02', host: 'vc02.corp.local', username: 'u', password: 'p' },
  { id: SITE, name: 'vc03', host: 'vc03.corp.local', username: 'u', password: 'p', collectMode: 'site', agent: 'edge-a' },
  { id: OUT, name: 'vc04', host: 'vc04.corp.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const B = await import('../src/veeam/backupCounts.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('Veeam 기준 — 대조된 VM 수·백업 중/대기 · 실패·첫 수집 전 서버가 있으면 부분 · 결과가 없으면 모름', () => {
  const byVm = { a: { run: 1 }, b: { run: 2 }, c: {}, d: null };
  const ok = B.veeamCount({ views: [{ ok: true, lastOkTs: 5 }], byVm, vmTotal: 10 });
  assert.deepEqual([ok.n, ok.vmTotal, ok.running, ok.pending, ok.partial, ok.basisTs], [3, 10, 1, 1, false, 5]);
  const part = B.veeamCount({ views: [{ ok: true, lastOkTs: 9 }, { ok: false, lastOkTs: 4 }], byVm, vmTotal: 10 });
  assert.equal(part.partial, true); assert.equal(part.failed, 1); assert.equal(part.basisTs, 4, '기준은 가장 오래된 성공');
  assert.equal(B.veeamCount({ views: [{ ok: null }], byVm: null, vmTotal: 10 }).reason, 'veeam-pending');
  const none = B.veeamCount({ views: [{ ok: false }], byVm: null, vmTotal: 10 });
  assert.equal(none.n, null); assert.equal(none.reason, 'veeam-failed');
});

test('스냅샷 기준 — 이벤트 ∪ 지금 임시 스냅샷(겹침 한 번) · 못 보면 0 이 아니라 모름', () => {
  const vms = [{ id: 'x:1', veeamSnaps: 1 }, { id: 'x:2' }, { id: 'x:3', veeamSnaps: 2 }, { id: 'x:4' }];
  const ev = { status: 'ok', source: 'local', days: 7, byVm: { 'x:1': [NOW, 3], 'x:2': [NOW, 1] }, accounts: 1, collectedAt: NOW, at: NOW };
  const r = B.snapCount({ ev, vms, now: NOW });
  assert.deepEqual([r.n, r.vmTotal, r.snapEv, r.snapNow, r.overlap, r.partial], [3, 4, 2, 2, 1, false]);
  assert.equal(B.snapCount({ ev: { ...ev, truncated: true }, vms, now: NOW }).partial, true);
  for (const st of ['log-off', 'severity-filter', 'not-collected', 'no-edge-data', 'stale-edge', 'error']) {
    const x = B.snapCount({ ev: { status: st }, vms, now: NOW });
    assert.equal(x.n, null, st); assert.equal(x.reason, st); assert.equal(x.snapNow, 2, '지금 스냅샷 수는 안내용으로 남긴다');
  }
  const stale = B.snapCount({ ev: { ...ev, collectedAt: NOW - 7 * HOUR }, vms, now: NOW });
  assert.equal(stale.n, null); assert.equal(stale.reason, 'stale-events');
  assert.equal(B.snapCount({ ev: { ...ev, collectedAt: NOW - 5 * HOUR }, vms, now: NOW }).n, 3, '6시간 안이면 센다');
  assert.equal(B.snapCount({ ev: { ...ev, collectedAt: null }, vms, now: NOW }).n, 3, '재시작 직후(모름)는 막지 않는다');
  assert.equal(B.snapCount({ ev: { ...ev, accounts: 0, byVm: {} }, vms, now: NOW }).reason, 'no-account');
  assert.equal(B.snapCount({ ev: { ...ev, source: 'edge', collectedAt: undefined }, vms, now: NOW }).n, 3);
});

test('라우트 — 범위 안만 · Veeam 연결 vCenter 는 Veeam 기준만 · 직접 수집은 로그 DB · 엣지 요약 없으면 모름 · 비밀·원문 없음', async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), jobs: [], counts: {}, vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [], rp: 3 },
    { n: 'db01', m: 'vm-2', h: 'vc01.corp.local', j: [], rp: 1, run: 1 },
  ] });
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  // 연동 없는 vc02 — 이름에 veeam 이 든 계정이 만든 스냅샷 생성 이벤트(app01) + 지금 임시 스냅샷(app02)
  await db.insertManyAsync([{ vcenterId: SN, key: 'k1@1', ts: NOW - 2 * HOUR, severity: 'info', type: 'TaskEvent', user: 'CORP\\svc-veeam', entity: 'app01', message: 'Task: Create virtual machine snapshot' }]);
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VC, SN, SITE, OUT].map((id) => ({ id, name: id })),
    vms: [
      { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01' }, { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01' }, { id: `${VC}:vm-3`, vcenterId: VC, name: 'x', veeamSnaps: 1 },
      { id: `${SN}:vm-1`, vcenterId: SN, name: 'app01' }, { id: `${SN}:vm-2`, vcenterId: SN, name: 'app02', veeamSnaps: 1, veeamSnapTs: NOW }, { id: `${SN}:vm-3`, vcenterId: SN, name: 'app03' },
      { id: `${SITE}:vm-1`, vcenterId: SITE, name: 's1', veeamSnaps: 1 },
      { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1' },
    ], hosts: [] };
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'v', role: 'viewer', scope: { vcenters: [VC, SN, SITE] } }; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/veeam/backup-counts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body.byVc).sort(), [VC, SN, SITE].sort(), '범위 밖 vCenter 는 싣지 않는다');
    const v = body.byVc[VC];
    assert.deepEqual([v.src, v.n, v.vmTotal, v.running, v.partial], ['veeam', 2, 3, 1, false], 'Veeam 기준만 — vm-3 의 임시 스냅샷을 더하지 않는다');
    const s = body.byVc[SN];
    assert.deepEqual([s.src, s.n, s.vmTotal, s.snapEv, s.snapNow, s.overlap], ['snap', 2, 3, 1, 1, 0]);
    const e = body.byVc[SITE];
    assert.deepEqual([e.src, e.n, e.reason, e.snapNow], ['snap', null, 'no-edge-data', 1]);
    const raw = JSON.stringify(body);
    for (const leak of ['svc-bk', 'svc-veeam', 'PW-secret-1', 'vbr-a.corp.local']) assert.equal(raw.includes(leak), false, leak);
  } finally { store.snapshot = prev; }
});
