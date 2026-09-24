/**
 * test/audit2601a.test.js — v2.601 감사 그룹 a(게스트 디스크 · 인벤토리 push · 추이 prune) 회귀.
 *
 * 전부 실제 함수를 호출해 동작으로 본다. push 는 목 HTTP 중앙에 실제로 보내 본문 도착까지 확인한다(v2.566 규약).
 * prune 은 모듈 안에서 Date.now() 로 경계를 잡으므로 표본은 경계에서 **수 일** 떨어뜨려 심는다(v2.517 규약 —
 * 시각 경계에 걸릴 여지가 없게). 기준 시각은 일 단위로 내린 뒤 정오로 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2601a-'));
process.env.CONFIG_DIR = TMP;
process.env.GUESTDISK_DB_PATH = path.join(TMP, 'guest-disk.db');
process.env.VMTRACK_DB_PATH = path.join(TMP, 'vm-track.db');
process.env.AGENT_VMSERIES_CHUNK_BYTES = '100000';   // 청크를 실제로 여러 개 만들게(하한 100KB)
process.env.AGENT_PUSH_GZIP = 'true';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;                                   // 순수 판정용 기준 시각
const NOW = Math.floor(Date.now() / DAY) * DAY - DAY / 2;       // prune 용 — 항상 과거·경계에서 수 일 떨어진 표본만 쓴다

const src = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));

// ── RECENT2601-01 ────────────────────────────────────────────────────────────
test('RECENT2601-01: 여유 미보고 파티션 하나가 그 vCenter 의 전 VM 커밋을 롤백하지 않는다(commit 2차 방어)', async () => {
  const db = await import('../src/guestdisk/db.js');
  const vms = [
    { vmId: 'vc1:vm-1', vmName: 'a', allocGB: 100, usedGB: 50, partCount: 2,
      parts: [{ path: 'C:\\', capGB: 100, usedGB: 50 }, { path: 'D:\\', capGB: 100, usedGB: null }] },
    { vmId: 'vc1:vm-2', vmName: 'b', allocGB: 40, usedGB: 10, partCount: 1, parts: [{ path: '/', capGB: 40, usedGB: 10 }] },
  ];
  const r = await db.commitCollection('vc1', 'vc1', vms, { ts: T0 });
  assert.equal(r.ok, true, `커밋 성공이어야 한다 — ${r.reason || ''}`);
  assert.equal(r.skippedParts, 1, '적재하지 않은 파티션 개수를 밝힌다');
  const latest = await db.listLatest(['vc1']);
  assert.equal(latest.length, 2, '정상 VM 두 대가 모두 저장된다');
  const parts = await db.partSeries('vc1:vm-1', 0);
  assert.deepEqual(parts.map((p) => p.path), ['C:\\'], '사용량을 모르는 파티션은 0 으로 적재하지 않는다');
});

test('RECENT2601-01: 직접 수집 경로도 중앙 수신과 같은 정제(sanitizeGuestDiskVms)를 거친다', async () => {
  const { parseGuestDisks } = await import('../src/vcenter/soapParse.js');
  const an = await import('../src/guestdisk/analyze.js');
  const parts = parseGuestDisks('<GuestDiskInfo><diskPath>C:\\</diskPath><capacity>107374182400</capacity><freeSpace>53687091200</freeSpace></GuestDiskInfo>'
    + '<GuestDiskInfo><diskPath>D:\\</diskPath><capacity>107374182400</capacity></GuestDiskInfo>');
  const s = an.vmSummary(parts);
  const row = { vmId: 'vc1:vm-9', vmName: 'x', allocGB: s.allocGB, usedGB: s.usedGB, partCount: s.partCount,
    parts: parts.map((p) => ({ path: p.path, capGB: p.capacityGB, usedGB: p.usedGB })) };
  const [clean] = an.sanitizeGuestDiskVms([row]);
  assert.deepEqual(clean.parts.map((p) => p.path), ['C:\\']);
  assert.equal(clean.partsUnknown, 1);
  // 이미 정제된 행(엣지 → push)을 중앙이 다시 정제해도 뺀 개수가 사라지지 않는다.
  const [again] = an.sanitizeGuestDiskVms([JSON.parse(JSON.stringify(clean))]);
  assert.equal(again.partsUnknown, 1, '재정제 시 partsUnknown 을 이어받는다');
  // service.js 가 그 정제를 실제로 거치는지(수집 함수는 라이브 vCenter 가 필요해 소스로 본다).
  const body = src('guestdisk/service.js');
  const fn = body.slice(body.indexOf('export async function collectVcenterGuestDisk'), body.indexOf('export async function collectAndStore'));
  assert.match(fn, /const out = sanitizeGuestDiskVms\(raw\)/, 'collectVcenterGuestDisk 는 결과를 sanitizeGuestDiskVms 로 정제해 돌려준다');
  assert.doesNotMatch(fn, /out\.push\(/, '정제 전 배열을 그대로 돌려주지 않는다');
});

// ── RECENT2601-02 · EDGE2601-03 ──────────────────────────────────────────────
test('RECENT2601-02: 엣지의 빈 슬라이스 보류는 LASTGOOD_HOLD 창까지만이다', async () => {
  const ip = await import('../src/agent/inventoryPush.js');
  const snap = { vcenters: [{ id: 'vc-a', status: 'unreachable' }], hosts: [], vms: [] };
  const vc = snap.vcenters[0];
  const m = new Map();
  let d = ip.withholdDecision(snap, vc, T0, m);
  assert.deepEqual([d.withhold, d.expired, d.since], [true, false, T0]);
  d = ip.withholdDecision(snap, vc, T0 + ip.WITHHOLD_MAX_MS - 1000, m);
  assert.equal(d.withhold, true, '창 안에서는 계속 보류');
  d = ip.withholdDecision(snap, vc, T0 + ip.WITHHOLD_MAX_MS + 1000, m);
  assert.deepEqual([d.withhold, d.expired], [false, true], '창을 넘으면 빈 슬라이스를 보내 중앙 HOLD 규칙이 적용되게 한다');
  // 다시 읽히면 기록을 지운다 — 다음 장애는 새로 센다.
  const ok = { vcenters: [{ id: 'vc-a', status: 'connected' }], hosts: [{ vcenterId: 'vc-a' }], vms: [] };
  ip.withholdDecision(ok, ok.vcenters[0], T0 + 10 * DAY, m);
  assert.equal(m.has('vc-a'), false);
  // pushInventoryNow 가 isUnreadEmpty 단독이 아니라 시간 제한 판정을 쓴다.
  const body = src('agent/inventoryPush.js');
  const fn = body.slice(body.indexOf('export async function pushInventoryNow'));
  assert.match(fn, /withholdDecision\(snap, vc, now\)/);
  assert.doesNotMatch(fn, /if \(isUnreadEmpty\(snap, vc\)\)/);
});

test('EDGE2601-03: 캐시 없는 점검중 vCenter 의 빈 조각은 엣지가 보류하고, 중앙도 마지막 정상 목록을 지우지 않는다', async () => {
  const ip = await import('../src/agent/inventoryPush.js');
  const snap = { vcenters: [{ id: 'vc-m', status: 'maintenance', maintenance: true }], hosts: [], vms: [] };
  assert.equal(ip.isUnreadEmpty(snap, snap.vcenters[0]), true, '엣지: 점검중 + 빈 목록은 읽지 못한 것');
  const inv = await import('../src/central/inventory.js');
  inv.setInventory('vc-m', { vcenter: { id: 'vc-m', status: 'connected' }, hosts: [{ id: 'h1', vcenterId: 'vc-m' }], vms: [{ id: 'v1', vcenterId: 'vc-m' }] }, 'edgeA', null);
  const r = inv.setInventory('vc-m', { vcenter: { id: 'vc-m', status: 'maintenance', maintenance: true }, hosts: [], vms: [] }, 'edgeA', null);
  assert.equal(r.held, true, '중앙: 점검중 빈 조각은 목록을 두고 상태만 갱신한다');
  const e = inv.getInventory('vc-m');
  assert.equal(e.data.hosts.length, 1);
  assert.equal(e.data.vcenter.status, 'maintenance');
  assert.equal(e.data.vcenter.maintenance, true);
  // 점검 해제 뒤 unreachable 보류로 바뀌면 점검 표시가 남지 않는다.
  inv.setInventory('vc-m', { vcenter: { id: 'vc-m', status: 'unreachable' }, hosts: [], vms: [] }, 'edgeA', null);
  assert.equal(inv.getInventory('vc-m').data.vcenter.maintenance, undefined);
});

// ── EDGE2601-02 ──────────────────────────────────────────────────────────────
function mockCentral(failChunk) {
  const got = [];
  const srv = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(bufs);
      if (req.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
      const body = JSON.parse(raw.toString('utf8'));
      got.push(body);
      const fail = failChunk != null && body.chunk === failChunk;
      res.writeHead(fail ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: !fail }));
    });
  });
  return { srv, got };
}
const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv.address().port; };

function bigSpikes(n) {
  return Array.from({ length: n }, (_, i) => ({ kind: 'vm', ref: `vm-${i}`, t0: T0, t1: T0 + 60_000, n: 3, cols: ['cpu'], buf: Buffer.alloc(60_000, i), mxcpu: 50, mxmem: 40 }));
}

test('EDGE2601-02: vmseries 커버리지·커서는 마지막 청크에만 실린다(뒤 청크 실패 시 측정 사실이 올라가지 않는다)', async () => {
  const { config } = await import('../src/config.js');
  const vp = await import('../src/agent/vmSeriesPush.js');
  const res = { spikes: bigSpikes(3), cover: [{ kind: 'vm', ref: 'vm-0', h: T0, samples: 180 }], cursors: [{ kind: 'vm', ref: 'vm-0', lastTs: T0 }], stats: { a: 1 } };

  const ok = mockCentral(null);
  config.agent.centralUrl = `http://127.0.0.1:${await listen(ok.srv)}`;
  config.agent.centralToken = 'tok'; config.agent.name = 'edgeA';
  try {
    const r = await vp.pushVmSeriesSlice({ id: 'vc-e', name: 'vc-e' }, res);
    assert.ok(r.chunks >= 2, `여러 청크가 나가야 검증이 된다 — ${r.chunks}`);
    const withCover = ok.got.filter((b) => Array.isArray(b.cover));
    assert.equal(withCover.length, 1);
    assert.equal(withCover[0].chunk, r.chunks - 1, '커버리지는 마지막 청크');
    assert.equal(ok.got.filter((b) => b.cursors).length, 1);
  } finally { ok.srv.close(); }

  const bad = mockCentral(1);   // 두 번째 청크 실패
  config.agent.centralUrl = `http://127.0.0.1:${await listen(bad.srv)}`;
  try {
    await assert.rejects(vp.pushVmSeriesSlice({ id: 'vc-e', name: 'vc-e' }, res));
    assert.equal(bad.got.some((b) => Array.isArray(b.cover)), false, '실패한 주기의 커버리지는 중앙에 도착하지 않는다');
  } finally { bad.srv.close(); }
});

// ── DB2601-01 ────────────────────────────────────────────────────────────────
test('DB2601-01: 게스트 디스크 prune 은 경계 이전 마지막 행(창 시작 이월 행)을 남긴다', async () => {
  const db = await import('../src/guestdisk/db.js');
  const vc = 'vc-p';
  const mk = (used, pused) => [{ vmId: `${vc}:vm-1`, vmName: 'p', allocGB: 100, usedGB: used, partCount: 1, parts: [{ path: '/data', capGB: 100, usedGB: pused }] }];
  await db.commitCollection(vc, vc, mk(10, 10), { ts: NOW - 60 * DAY });
  await db.commitCollection(vc, vc, mk(20, 20), { ts: NOW - 40 * DAY });
  await db.commitCollection(vc, vc, mk(40, 40), { ts: NOW - 5 * DAY });
  const r = await db.prune(30);
  assert.equal(r.ok, true);
  const since = NOW - 20 * DAY;
  const vs = await db.vmSeries(`${vc}:vm-1`, since);
  assert.equal(vs[0].carried, true, '창 시작 이월 행이 남아 있어야 한다');
  assert.equal(vs[0].usedGB, 20);
  assert.equal(vs[vs.length - 1].usedGB, 40, '증가(20→40)가 보인다');
  const ps = await db.partSeries(`${vc}:vm-1`, since);
  assert.equal(ps[0].carried, true);
  assert.equal(ps[0].usedGB, 20);
  // 경계 이전의 더 오래된 행(60일 전)은 지운다(무한 누적 방지).
  const all = await db.vmSeries(`${vc}:vm-1`, 0);
  assert.deepEqual(all.map((x) => x.usedGB), [20, 40]);
});

// ── DB2601-02 ────────────────────────────────────────────────────────────────
test('DB2601-02: vmtrack ds_series prune 도 경계 이전 마지막 행을 남긴다', async () => {
  const vt = await import('../src/vmtrack/db.js');
  const x = await vt.getDb();
  assert.ok(x, 'vmtrack DB');
  x.st.insDsSeries.run('s1', NOW - 60 * DAY, 'vc', 'ds-1', 1000, 100);
  x.st.insDsSeries.run('s2', NOW - 40 * DAY, 'vc', 'ds-1', 1000, 200);
  x.st.insDsSeries.run('s3', NOW - 5 * DAY, 'vc', 'ds-1', 1000, 400);
  x.st.insDsSeries.run('s1', NOW - 60 * DAY, 'vc', 'ds-still', 500, 50);   // 오래 안 바뀐 DS(v2.590 P5)
  const r = await vt.pruneVmtrack(30);
  assert.equal(r.ok, true);
  const a = await vt.readDsSeries({ dsId: 'ds-1', sinceTs: NOW - 20 * DAY });
  assert.ok(a.carryIn, '창 시작 이월 행이 남아야 한다');
  assert.equal(a.carryIn.used_gb, 200);
  const all = await vt.readDsSeries({ dsId: 'ds-1', sinceTs: 0 });
  assert.deepEqual(all.rows.map((q) => q.used_gb), [200, 400], '더 오래된 행은 지운다');
  const still = await vt.readDsSeries({ dsId: 'ds-still', sinceTs: 0 });
  assert.equal(still.rows.length, 1, '값이 안 바뀐 DS 의 유일한 행은 남긴다(v2.590 P5)');
});

// ── LO2601-05 ────────────────────────────────────────────────────────────────
test('LO2601-05: DS 사용량을 전부 모르면 집계 사용률은 0 이 아니라 null', async () => {
  const { diffDatastores } = await import('../src/vmtrack/diff.js');
  const r = diffDatastores([{ id: 'vc:ds1', capacityGB: 1000, usedGB: null }], null);
  assert.equal(r.usagePct, null);
  assert.equal(r.usedUnknown, 1);
  const ok = diffDatastores([{ id: 'vc:ds1', capacityGB: 1000, usedGB: 250 }], null);
  assert.equal(ok.usagePct, 25);
});

// ── TIM2601-04 ───────────────────────────────────────────────────────────────
test('TIM2601-04: 게스트 디스크 폴러는 재시작 직후 DB 의 마지막 적재 시각으로 주기를 복원한다', async () => {
  const db = await import('../src/guestdisk/db.js');
  const { store } = await import('../src/store.js');
  const poller = await import('../src/guestdisk/poller.js');
  await db.commitCollection('vc-direct', 'vc-direct', [{ vmId: 'vc-direct:vm-1', vmName: 'd', allocGB: 10, usedGB: 1, partCount: 0, parts: [] }], { ts: T0 });
  await db.commitCollection('vc-site', 'vc-site', [{ vmId: 'vc-site:vm-1', vmName: 's', allocGB: 10, usedGB: 1, partCount: 0, parts: [] }], { ts: T0 + DAY });
  assert.equal(await db.lastCollectTs(['vc-direct']), T0);
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, vcenters: [] };
    assert.equal(await poller.restoreLastRunTs(), 0, '스냅샷이 비었으면(첫 수집 전) 복원을 미룬다');
    store.snapshot = { ...prev, vcenters: [{ id: 'vc-direct' }, { id: 'vc-site', collectSource: 'site' }] };
    assert.equal(await poller.restoreLastRunTs(), T0, '직접 수집 vCenter 의 마지막 적재 시각(site 행은 제외)');
    assert.equal(poller.guestDiskPollerStatus().lastRunTs, T0);
  } finally { store.snapshot = prev; }
});
