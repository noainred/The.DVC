/**
 * v2.733(점검 3회차 — 리드 통합) — 그룹 보고의 배정 밖 후속.
 *  ① 재부팅 분류 라우트가 '이 포탈이 지금 이벤트를 수집하지 않는 vCenter' 사유(logs/coverage.js)를 넘긴다 —
 *     reboots.js 는 coverageOf().why 를 받아야 notCollected 를 싣는데(그룹 a), 라우트가 why 를 넘기지 않아 응답에 실리지 않았다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733lead-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'vc-d', name: 'Direct', host: 'd.example.invalid', username: 'u', password: 'p' },
    { id: 'vc-s', name: 'Site', host: 's.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-a' },
  ],
}));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const H = 3_600_000;
const DAY = 86_400_000;

test('① 재부팅 분류 — 위임 vCenter 의 이벤트 없는 부팅은 notCollected(site) · 직접 수집 vCenter 는 사유 없음', async () => {
  const express = (await import('express')).default;
  const { registerHostHygiene } = await import('../src/routes/api/hostHygiene.js');
  const { store } = await import('../src/store.js');
  const now = Math.floor(Date.now() / H) * H - 30 * 60_000;
  const boot = now - 5 * DAY;
  const prev = store.snapshot;
  store.snapshot = {
    source: 'live', generatedAt: new Date(now).toISOString(), vcenters: [{ id: 'vc-d', name: 'Direct' }, { id: 'vc-s', name: 'Site' }],
    hosts: [
      { id: 'vc-d:h1', name: 'esx-d', vcenterId: 'vc-d', connectionState: 'CONNECTED', bootTime: boot },
      { id: 'vc-s:h1', name: 'esx-s', vcenterId: 'vc-s', connectionState: 'CONNECTED', bootTime: boot },
    ],
    vms: [], datastores: [], networks: [], alarms: [], collectionErrors: [],
  };
  try {
    const router = express.Router();
    registerHostHygiene(router);
    const app = express();
    app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
    app.use('/api', router);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    closers.push(() => new Promise((r) => srv.close(r)));
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/host-hygiene/reboots?days=30`);
    assert.equal(res.status, 200);
    const j = await res.json();
    const bySite = j.rows.find((r) => r.id === 'vc-s:h1');
    const byDirect = j.rows.find((r) => r.id === 'vc-d:h1');
    assert.ok(bySite && byDirect, '두 호스트 모두 목록에 있다');
    assert.equal(bySite.kind, 'no-events');
    assert.equal(bySite.notCollected, 'site', '위임 vCenter 는 수집하지 않는다는 사유가 행에 실린다');
    assert.equal(byDirect.notCollected, undefined, '직접 수집 vCenter 는 사유가 없다(수집 실패·보관 기간 밖과 구분)');
    assert.equal(j.noEventsNotCollected, 1);
  } finally {
    store.snapshot = prev;
  }
});

test('② GPU 게스트 push 보류 — 못 읽은 vCenter 는 객체({vcId, reason})라도 id 로 말한다([object Object] 금지)', async () => {
  const { gpuGuestPushWithhold } = await import('../src/agent/gpuGuestPush.js');
  const now = 1_000_000;
  const r = gpuGuestPushWithhold({ unreadVcenters: [{ vcId: 'vc-a', reason: '예외' }, 'vc-b'] }, null, now, 60_000);
  assert.equal(r.reason, 'unread-vcenters');
  assert.deepEqual(r.unreadIds, ['vc-a', 'vc-b']);
  assert.ok(!r.unreadIds.some((x) => x.includes('[object')), '객체를 문자열로 바꾼 흔적이 없다');
});

test('③ SAN 단건 수집은 flush 인자를 받는다 — flush:false 면 스냅샷 파일을 쓰지 않는다(묶음 끝에 한 번)', async () => {
  const fsMod = await import('node:fs');
  const src = fsMod.readFileSync(new URL('../src/sanswitch/poller.js', import.meta.url), 'utf8');
  const { stripComments } = await import('./_stripComments.js');
  const code = stripComments(src);
  const m = code.match(/export async function collectDeviceNow\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'collectDeviceNow 를 찾는다');
  assert.match(m[1], /flush\s*=\s*true/, 'flush 인자(기본 true)');
  assert.match(m[2], /if\s*\(\s*flush\s*\)\s*flushSnapshotsNow\(\)/, 'flush 일 때만 쓴다');
  const pull = stripComments(fsMod.readFileSync(new URL('../src/agent/storageConfigPull.js', import.meta.url), 'utf8'));
  assert.match(pull, /collectDeviceNow\(String\(id\),\s*\{\s*flush:\s*false\s*\}\)/, '스토리지 재수집 묶음은 flush:false');
  assert.match(pull, /flushSnapshotsNow\(\)/, '묶음 끝에 한 번 쓴다');
});

test('④ GPU 게스트 수집 상태 — 범위 관리자에게 전 함대 집계를 싣지 않는다(허용 vCenter 목록만)', async () => {
  const { scopeGpuGuestStatus } = await import('../src/routes/admin/gpuGuest.js');
  const status = {
    enabled: true, pollIntervalMs: 60_000, monitored: 3, overlay: { hosts: 40, vms: 120 },
    lastRun: {
      at: 123, mode: 'live', vcenters: 3, hosts: 40, vms: 120, errors: 2, authStoppedVms: 1, overlay: { hosts: 40 },
      unreadVcenters: [{ vcId: 'vc-a', reason: '예외' }, { vcId: 'vc-z', reason: '예외' }],
      skippedVcenters: [{ vcId: 'vc-z', why: 'site' }], skippedCounts: { site: 1 }, vcAuthStopped: ['vc-a', 'vc-z'],
    },
  };
  const settings = { vcenters: { 'vc-a': { enabled: true }, 'vc-b': { enabled: false }, 'vc-z': { enabled: true } } };
  const allowed = new Set(['vc-a', 'vc-b']);
  const out = scopeGpuGuestStatus(status, allowed, settings);
  assert.equal(out.fleetCountsHidden, true);
  assert.equal(out.monitored, 1, '허용 vCenter 중 켠 수');
  assert.equal(out.overlay, null);
  assert.equal(out.lastRun.at, 123);
  assert.equal(out.lastRun.hosts, null);
  assert.equal(out.lastRun.vms, null);
  assert.equal(out.lastRun.errors, null);
  assert.equal(out.lastRun.skippedCounts, undefined, '전 함대 사유 분포를 싣지 않는다');
  assert.deepEqual(out.lastRun.unreadVcenters.map((x) => x.vcId), ['vc-a']);
  assert.deepEqual(out.lastRun.skippedVcenters, []);
  assert.deepEqual(out.lastRun.vcAuthStopped, ['vc-a']);
  assert.ok(!JSON.stringify(out).includes('vc-z'), '범위 밖 vCenter id 가 남지 않는다');
  assert.equal(scopeGpuGuestStatus(status, null, settings), status, '전체 범위는 그대로');
  const fsMod = await import('node:fs');
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fsMod.readFileSync(new URL('../src/routes/admin/gpuGuest.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/status:\s*gpuGuestStatus\(\)/g) || []).length, 0, '설정 조회·저장 응답은 가린 상태만 싣는다');
  assert.equal((src.match(/scopeGpuGuestStatus\(gpuGuestStatus\(\)/g) || []).length, 2);
});
