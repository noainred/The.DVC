/**
 * v2.740 점검 그룹 f — 문서의 '남긴 것 / 다음 회차 후보' 중 코드로 고칠 수 있는 것(감사 F-03 · F-07 · F-08 · F-10).
 *
 *  F-03 같은 장비 전력은 같은 기준 — Overview·특수 기능 '전체 소비 전력'(power/total.js)의 네트워크 합이 CVP 전력 탭과 **같은 판정**
 *       (cvp/confirm.js cvpPartsStaleReason — 장비 확인 불가 never·stale·not-streaming·telemetry-failed + 부품 낡음 parts-stale)을 쓰고
 *       사유별 개수(staleBy)를 싣는다. 예전에는 PSU 값이 6시간 안이면 더해, 부품 조회가 2~6시간 멈춘 스위치를 한 화면은 합산·다른 화면은 제외했다.
 *  F-07 실시간 스파이크 DB 보존 정리는 수집과 분리 — 꺼짐·디스크 가드·수집 미완주와 무관하게 시간 기준(기동 첫 틱 회피)으로 돌고,
 *       보존일을 줄인 저장 직후 한 번 백그라운드로 돈다. 예전에는 수집을 끝까지 돈 실행 12번에 1번뿐이라 디스크가 부족할 때 영영 돌지 않았다.
 *  F-08 Capacity Advisor 호스트 표 — 롤업 보존일보다 오래 보고하지 않은 호스트 행을 prune 이 지운다(그 호스트의 시계열은 이미 전부 지워졌다).
 *  F-10 웹 SSH 게이트웨이 — 빈 비밀번호(또는 문자열 아님)인 auth 프레임은 대상에 접속하지 않고 4400 'empty-password' 로 닫는다.
 *
 * ⚠ CONFIG_DIR 은 config.js 가 import 시점에 굳히므로 맨 위에서 고정하고 src 는 동적 import 한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2740f-'));
process.env.CONFIG_DIR = DIR;
process.env.VMSERIES_DB_DIR = path.join(DIR, 'vmseries');
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
delete process.env.VMSERIES_RETENTION_DAYS;
delete process.env.CVP_PARTS_EVERY_MS;
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const H = 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;
const waitFor = async (fn, ms = 10_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
const sqliteOk = await import('node:sqlite').then(() => true).catch(() => false);

/* ── F-03 ──────────────────────────────────────────────────────────────── */
const psu = (w) => ({ kind: 'psu', state: 'ok', power: { inW: w } });
/** DB 행 모양(rowToDevice) — collectedAt·partsAt·streaming·telemetry 가 있다. */
const dev = (key, o) => ({ cvpId: 'c1', key, hostname: key, model: 'X', agent: '', streaming: true, telemetry: 'ok', partsList: [psu(200), psu(210)], corp: { corpId: 'HG' }, ...o });

test('F-03 판정 함수는 cvp/ 모듈 하나 — CVP 라우트는 같은 함수를 가져다 쓴다', async () => {
  const C = await import('../src/cvp/confirm.js');
  const R = await import('../src/routes/api/cvp.js');
  assert.equal(typeof C.cvpPartsStaleReason, 'function');
  assert.equal(R.cvpPartsStaleReason, C.cvpPartsStaleReason, 'routes 의 cvpPartsStaleReason 은 cvp/confirm.js 의 그것이다(사본 금지)');
  assert.equal(R.cvpDeviceConfirm, C.cvpDeviceConfirm);
  const T = await import('../src/power/total.js');
  assert.equal(T.NET_STALE_MS, undefined, '네트워크 전용 6시간 경계는 없어졌다(CVP 와 다른 기준)');
});

test('F-03 전체 소비 전력의 네트워크 합 = CVP 전력 탭과 같은 판정 · 사유별 개수', async () => {
  const { buildPowerTotal } = await import('../src/power/total.js');
  const { cvpPartsStaleReason } = await import('../src/routes/api/cvp.js');
  const R = await import('../src/routes/api/cvp.js');
  const now = Math.floor(Date.now() / H) * H - 30 * MIN;
  const opts = { intervalMs: 5 * MIN };
  const rows = [
    dev('fresh', { collectedAt: now - MIN, partsAt: now - 10 * MIN }),
    dev('central-2h', { collectedAt: now - MIN, partsAt: now - 2 * H }),                  // 한계 1.75h(부품 30분 × 3 + 15분) → parts-stale
    dev('edge-4h', { agent: 'Edge-A', collectedAt: now - MIN, partsAt: now - 4 * H }),     // 엣지 한계 1.75h + 1h + 15m = 3h → parts-stale
    dev('edge-2h', { agent: 'Edge-A', collectedAt: now - MIN, partsAt: now - 2 * H }),     // 엣지 한계 안 → 지금 값
    dev('collect-old', { collectedAt: now - 2 * H, partsAt: now - 10 * MIN }),            // 수집 자체가 낡음 → stale
    dev('not-stream', { collectedAt: now - MIN, partsAt: now - MIN, streaming: false }),  // 스트리밍 아님
    dev('tel-fail', { collectedAt: now - MIN, partsAt: now - MIN, telemetry: 'failed' }), // 텔레메트리 실패
    dev('never', { collectedAt: null, partsAt: now - MIN }),                               // 수집 기록 없음
    dev('stale-nopsu', { collectedAt: now - 2 * H, partsList: [] }),                        // 낡은 장비는 '못 읽음' 보다 '낡음' 이 먼저(CVP 탭과 같은 순서)
    dev('unread', { collectedAt: now - MIN, partsAt: now - MIN, partsList: [] }),           // 지금 값인데 PSU 없음 → 못 읽음
  ];
  const r = buildPowerTotal({ now, network: rows, cvpOpts: opts });
  const want = {};
  for (const d of rows) { const why = cvpPartsStaleReason(d, { now, ...opts }); if (why) want[why] = (want[why] || 0) + 1; }
  assert.deepEqual(r.network.staleBy, want, 'staleBy 는 CVP 전력 탭(cvpPartsStaleReason)과 같은 사유·개수다');
  assert.equal(r.network.stale, Object.values(want).reduce((a, b) => a + b, 0));
  assert.deepEqual(want, { 'parts-stale': 2, stale: 2, 'not-streaming': 1, 'telemetry-failed': 1, never: 1 });
  assert.equal(r.network.measured, 2, 'fresh · edge-2h 만 지금 값');
  assert.equal(r.network.watts, 820);
  assert.equal(r.network.unread, 1);
  assert.equal(r.network.devices, rows.length);
  assert.equal(r.network.devices, r.network.measured + r.network.partial + r.network.unread + r.network.stale, '겹치지 않는 칸의 합 = 장비 수');
  for (const k of Object.keys(r.network.staleBy)) assert.ok(R.CVP_STALE_REASONS.includes(k), `사유 ${k} 는 CVP_STALE_REASONS(웹 문구 표와 1:1)에 있다`);
});

test('F-03 기본값 — 경계는 CVP 설정의 수집 주기를 따른다(CVP 탭이 쓰는 loadSettings().intervalMs 와 같은 값)', async () => {
  const { buildPowerTotal } = await import('../src/power/total.js');
  const { saveSettings } = await import('../src/cvp/settings.js');
  saveSettings({ intervalMs: 20 * MIN });   // 부품 한계 = 30분 × 3 + 20분 × 3 = 150분
  const now = Math.floor(Date.now() / H) * H - 30 * MIN;
  const rows = [dev('p2h', { collectedAt: now - MIN, partsAt: now - 2 * H })];
  assert.equal(buildPowerTotal({ now, network: rows }).network.measured, 1, '주기 20분 설정이면 2시간 전 부품 값은 지금 값이다');
  assert.equal(buildPowerTotal({ now, network: rows, cvpOpts: { intervalMs: 5 * MIN } }).network.staleBy['parts-stale'], 1, '주기 5분이면 낡음');
  saveSettings({ intervalMs: 5 * MIN });
  assert.equal(buildPowerTotal({ now, network: rows }).network.staleBy['parts-stale'], 1, '설정을 바꾸면 기본 경계도 따라간다');
});

/* ── F-07 ──────────────────────────────────────────────────────────────── */
async function seedOldSpike(vcId, ageDays) {
  const db = await import('../src/vmseries/db.js');
  const { packMoments } = await import('../src/vmseries/spikes.js');
  const { VM_COUNTERS } = await import('../src/vmseries/counters.js');
  const names = VM_COUNTERS.map((c) => c.name);
  const t0 = Math.floor((Date.now() - ageDays * DAY) / H) * H + 30 * MIN;
  const v = new Array(names.length).fill(-1); v[names.indexOf('cpuUsagePct')] = 9000;
  const p = packMoments([{ ts: t0 + 20_000, vals: v }], names.length);
  await db.commitVmSeries(vcId, { spikes: [{ kind: 'vm', ref: `vm-${ageDays}`, t0: p.t0, t1: p.t1, n: p.n, cols: names, buf: p.buf, mxcpu: 9000, mxmem: -1 }], cover: [], cursors: [] });
  return t0;
}
async function momentsLeft(vcId, ageDays, t0) {
  const q = await import('../src/vmseries/query.js');
  return (await q.momentsOf(vcId, 'vm', `vm-${ageDays}`, t0 - H, Date.now())).length;
}

test('F-07 보존 정리는 수집과 무관한 시간 기준 — 꺼져 있어도 돌고, 기동 첫 틱은 피한다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const P = await import('../src/vmseries/poller.js');
  const S = await import('../src/vmseries/settings.js');
  assert.equal(S.loadVmSeriesSettings().enabled, false, '전제: 수집은 꺼져 있다');
  assert.equal(typeof P.vmSeriesScheduledPrune, 'function', '시간 기준 정리 진입점이 있다');
  const t0 = await seedOldSpike('vc-f07', 100);   // 기본 보존 60일 밖
  assert.equal(await momentsLeft('vc-f07', 100, t0), 1);
  const now = Date.now();
  assert.equal(P.vmSeriesScheduledPrune(now), null, '기동 첫 틱은 정리하지 않는다');
  assert.equal(await momentsLeft('vc-f07', 100, t0), 1);
  const p = P.vmSeriesScheduledPrune(now + 60 * MIN);
  assert.ok(p && typeof p.then === 'function', '두 번째 틱(마지막 정리 기록 없음)은 정리한다');
  const r = await p;
  assert.equal(await momentsLeft('vc-f07', 100, t0), 0, '수집이 꺼져 있어도 보존일 밖 행이 지워진다');
  assert.ok(r.deleted >= 1);
  assert.equal(P.vmSeriesScheduledPrune(now + 2 * H), null, '방금 정리했으면 주기(10시간) 전에는 다시 돌지 않는다');
  const p2 = P.vmSeriesScheduledPrune(now + 60 * MIN + 10 * H + 1);
  assert.ok(p2, '10시간이 지나면 다시 돈다');
  await p2;
  const st = P.vmSeriesPollerStatus();
  assert.ok(st.lastPrune && st.lastPrune.reason === 'schedule' && st.lastPrune.days === 60, '상태에 마지막 정리(사유·보존일)를 남긴다');
});

test('F-07 보존일을 줄여 저장하면 곧바로 한 번 정리한다(라우트 — 실제 api 라우터)', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: new Date().toISOString(), source: 'mock', vcenters: [{ id: 'vc-r', name: 'R' }], hosts: [], vms: [], datastores: [], alarms: [], networks: [] };
  const t0 = await seedOldSpike('vc-r', 45);   // 60일 보존 안 · 30일 보존 밖
  assert.equal(await momentsLeft('vc-r', 45, t0), 1);
  const { api } = await import('../src/routes/api.js');
  const a = express();
  a.use(express.json({ limit: '5mb' }));
  a.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
  a.use('/api', api);
  const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/vmseries/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retentionDays: 30 }) });
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.settings.retentionDays, 30);
    assert.equal(j.pruneScheduled, true, '응답이 정리를 시작했다고 말한다');
    assert.ok(await waitFor(async () => (await momentsLeft('vc-r', 45, t0)) === 0), '보존일을 줄인 저장 뒤 30일 밖 행이 지워진다');
    // 보존일을 늘리거나 그대로면 정리를 다시 시작하지 않는다
    const res2 = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/vmseries/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retentionDays: 90 }) });
    assert.equal((await res2.json()).pruneScheduled, undefined);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('F-07 배선 — 타이머 틱은 재진입·꺼짐 검사보다 먼저 시간 기준 정리를 부르고, 수집 함수는 정리하지 않는다(소스)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/vmseries/poller.js', import.meta.url), 'utf8'));
  const start = src.indexOf('export function startVmSeriesPoller');
  assert.ok(start > 0);
  const body = src.slice(start);
  const iPrune = body.indexOf('vmSeriesScheduledPrune()');
  const iRunning = body.indexOf('if (running) return');
  const iEnabled = body.indexOf('if (!demoOn(loadVmSeriesSettings().enabled)) return');
  assert.ok(iPrune > 0 && iPrune < iRunning && iPrune < iEnabled, '틱의 정리는 재진입 가드·꺼짐 검사보다 앞이다(그 뒤면 꺼짐·수집 중에 정리하지 않는다)');
  assert.match(body, /onVmSeriesSettingsChange\(\(eff\) =>[\s\S]{0,200}noteVmSeriesRetentionChange\(/, '엣지 설정 pull 등 다른 저장 경로도 보존일 축소를 곧바로 집행한다');
  const run = src.slice(src.indexOf('export async function runVmSeriesNow'), start);
  assert.ok(!/pruneVmSeries\(/.test(run), '수집 실행(runVmSeriesNow)에는 정리가 없다 — 디스크 가드·꺼짐 return 이 정리를 막지 않게');
});

test('F-07 정리 도중 보존일을 더 줄이면 끝난 뒤 새 보존일로 한 번 더 돈다(공유만 하지 않는다)', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const P = await import('../src/vmseries/poller.js');
  const S = await import('../src/vmseries/settings.js');
  S.saveVmSeriesSettings({ retentionDays: 90 });
  const t0 = await seedOldSpike('vc-again', 20);   // 90일 보존 안 · 10일 보존 밖
  const first = P.runVmSeriesPrune('schedule');    // 보존 90일로 도는 중
  S.saveVmSeriesSettings({ retentionDays: 10 });
  assert.ok(P.noteVmSeriesRetentionChange(90, 10), '정리가 돌 예정이라고 알린다');
  const r1 = await first;
  assert.equal(r1.days, 90, '진행 중이던 정리는 옛 보존일로 끝난다');
  assert.ok(await waitFor(async () => (await momentsLeft('vc-again', 20, t0)) === 0), '끝난 뒤 새 보존일(10일)로 한 번 더 돌아 지운다');
  assert.ok(await waitFor(() => P.vmSeriesPollerStatus().lastPrune?.days === 10));
  S.saveVmSeriesSettings({ retentionDays: 60 });
});

test('F-07 범위 계정에는 보존 정리 기록의 전 법인 집계(파일 수·삭제 수·실패 vCenter)를 싣지 않는다', async () => {
  const { scopeVmSeriesStatus } = await import('../src/routes/api/vmSeries.js');
  const st = { running: false, lastResult: null, lastPrune: { at: 1, reason: 'schedule', days: 60, files: 9, deleted: 1234, errors: [{ vcenterId: 'vc-other', error: 'x' }], ms: 5 } };
  const full = scopeVmSeriesStatus(st, null);
  assert.equal(full.lastPrune.deleted, 1234, '전체 범위는 그대로');
  const sc = scopeVmSeriesStatus(st, new Set(['vc-mine']));
  assert.deepEqual(sc.lastPrune, { at: 1, reason: 'schedule', days: 60, scoped: true });
});

/* ── F-08 ──────────────────────────────────────────────────────────────── */
test('F-08 Capacity 호스트 표 — 롤업 보존일보다 오래 보고하지 않은 호스트 행은 prune 이 지운다', { skip: !sqliteOk ? 'node:sqlite 미지원' : false }, async () => {
  const { config } = await import('../src/config.js');
  const { getCapacityDb } = await import('../src/capacity/db.js');
  const db = await getCapacityDb();
  assert.equal(db.kind, 'sqlite');
  const now = Date.now();
  const days = config.capacity.rollupRetentionDays;
  db.insertSnapshot('retired-host-01', [{ metric: 'cpu_pct', v: 40 }], now - (days + 30) * DAY, { name: 'retired' });
  db.insertSnapshot('quiet-host-02', [{ metric: 'cpu_pct', v: 40 }], now - (days - 5) * DAY, { name: 'quiet' });   // 보존일 안 — 남는다
  db.insertSnapshot('live-host-01', [{ metric: 'cpu_pct', v: 40 }], now, { name: 'live' });
  const r = await db.prune(now);
  assert.equal(r.hostsDeleted, 1, '지운 호스트 수를 밝힌다');
  const ks = db.hosts().map((h) => h.k);
  assert.ok(!ks.includes('retired-host-01'), '퇴역 호스트 행이 남지 않는다');
  assert.ok(ks.includes('quiet-host-02') && ks.includes('live-host-01'));
  // 퇴역 호스트에 남은 시계열은 없다(지운 행은 보여 줄 데이터가 없는 행이다)
  assert.equal(db.windowStats('cpu_pct', 'retired-host-01', now - (days + 60) * DAY, now), null);
  // 다시 보고하면 다시 생긴다(upsert)
  db.insertSnapshot('retired-host-01', [{ metric: 'cpu_pct', v: 1 }], now, {});
  assert.ok(db.hosts().some((h) => h.k === 'retired-host-01'));
});

/* ── F-10 ──────────────────────────────────────────────────────────────── */
class FakeWs extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.bufferedAmount = 0; this.json = []; this.closed = null; }
  send(d, cb) { const s = String(d); if (s.startsWith('{')) this.json.push(JSON.parse(s)); if (cb) setImmediate(cb); }
  close(code, reason) { if (this.readyState !== 1) return; this.readyState = 3; this.closed = { code, reason }; setImmediate(() => this.emit('close')); }
  terminate() { this.close(1006, ''); }
  input(o) { this.emit('message', Buffer.from(JSON.stringify(o))); }
  statuses() { return this.json.filter((o) => o.type === 'status').map((o) => o.text); }
}

test('F-10 빈 비밀번호 auth 프레임은 대상에 접속하지 않고 empty-password 로 닫는다', async () => {
  const gw = await import('../src/proxy/sshGateway.js');
  const reg = await import('../src/proxy/registry.js');
  const ADMIN = { username: 'admin1', role: 'admin', scope: null };
  let made = 0; const connects = [];
  gw._setSshDepsForTest({ Client: class extends EventEmitter { constructor() { super(); made++; } connect(cfg) { connects.push(cfg); setImmediate(() => this.emit('error', new Error('test stop'))); } end() {} } });
  try {
    const m = reg.addMapping({ protocol: 'ssh', targetHost: '127.0.0.1', targetPort: 22, owner: 'admin1' });
    assert.equal(m.ok, true, m.reason);
    const before = gw.activeSshSessionCount();
    for (const pw of ['', undefined, null, 1234, ['x']]) {
      const ws = new FakeWs();
      gw._handleConnectionForTest(ws, ADMIN, { token: null });
      ws.input({ type: 'auth', mappingId: m.mapping.id, username: 'root', ...(pw === undefined ? {} : { password: pw }) });
      assert.ok(await waitFor(() => ws.closed), `password=${JSON.stringify(pw)} 이면 닫는다`);
      assert.deepEqual(ws.closed, { code: 4400, reason: 'empty-password' }, `password=${JSON.stringify(pw)}`);
      assert.ok(ws.statuses().some((t) => /비밀번호/.test(t)), '왜 닫는지 상태 줄로 말한다');
    }
    assert.equal(made, 0, '대상 SSH 클라이언트를 만들지 않았다(대상 계정의 잠금 카운터에 쌓이지 않는다)');
    assert.equal(gw.activeSshSessionCount(), before, '세션 수를 세지 않았다');
    // 비밀번호가 있으면 예전처럼 접속을 시도한다
    const ws = new FakeWs();
    gw._handleConnectionForTest(ws, ADMIN, { token: null });
    ws.input({ type: 'auth', mappingId: m.mapping.id, username: 'root', password: 'pw' });
    assert.ok(await waitFor(() => connects.length === 1));
    assert.equal(connects[0].password, 'pw');
    assert.ok(await waitFor(() => ws.closed));
    assert.notEqual(ws.closed.reason, 'empty-password');
  } finally { gw._setSshDepsForTest(null); }
});
