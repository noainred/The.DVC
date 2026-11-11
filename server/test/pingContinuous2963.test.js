/**
 * v2.963 — Ping 연속 측정 + 화면 측정 설정(사용자 요청 "화면에서 주기 설정할 수 있게 · ping 은 중단없이 계속 ping"
 * — 선택: '1초 간격 연속 측정 + 주기 요약' · 표준 검증).
 *
 *  ① 엔진: 대상마다 쉬지 않고 잰다 · 요약 창마다 대상당 한 줄(n·fail·rn·평균·최저·최고)
 *  ② 느린 대상(시한에 걸림)이 다른 대상의 측정을 막지 않는다(예전: 한 바퀴가 길면 다음 회차를 건너뜀)
 *  ③ 지운 대상은 남은 값을 쓰고 멈춘다 · 다시 넣으면 다시 잰다
 *  ④ 설정 변경 — 재시작 없이: 쉬던 루프가 새 측정 간격을 바로 쓰고, 요약 주기는 지금 창을 마감한 뒤 새 경계로
 *  ⑤ stop() 은 진행 중 창을 버리지 않는다 · 측정 예외는 실패로 센다
 *  ⑥ ICMP 슬롯 — 상한을 넘지 않는다
 *  ⑦ 저장소 — 요약 줄과 예전 줄(측정 1회)이 같은 식으로 묶인다(원시 · 시간 롤업 · 대상 삭제 후 재구성 · NDJSON 가중)
 *  ⑧ 설정 — env 기본 · 화면 값이 이김 · 범위/정수/요약 ≥ 측정 검사 · 초기화 · 손상 파일 보존 + 저장 거절 · 변경 알림
 *  ⑨ 라우트 — GET 은 인증(부하 산수는 전체 범위만) · PUT 은 관리자 · 전체 범위 · 400 field · 손상 503 · poll-now
 *  ⑩ 서버 범위 ↔ 웹 문구 범위 1:1
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPingEngine, createSlots } from '../src/ping/monitor.js';
import { weightOf } from '../src/ping/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web/src');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function engineWith({ probeMs = 10, summaryMs = 200, probe, targets, timeoutMs = 50 } = {}) {
  let s = { probeIntervalMs: probeMs, summaryIntervalMs: summaryMs, timeoutMs };
  const rows = []; const listeners = new Set();
  const list = { value: targets || [{ id: 'a', host: '10.0.0.1', kind: 'tcp' }] };
  const e = createPingEngine({
    settings: () => s,
    targets: () => list.value,
    probe: probe || (async () => ({ ok: true, rtt: 5 })),
    write: (r) => { rows.push(...r); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    random: () => 0,
    onError: (err) => { throw err; },
  });
  return {
    e, rows, list,
    set(next) { s = { ...s, ...next }; for (const fn of listeners) fn(s); },
  };
}

test('① 대상마다 쉬지 않고 재고 요약 창마다 대상당 한 줄 — n·fail·rn·평균·최저·최고', async () => {
  let k = 0;
  const seq = [{ ok: true, rtt: 10 }, { ok: true, rtt: 30 }, { ok: false, rtt: null }, { ok: true, rtt: 20 }, { ok: true, rtt: null }];
  const h = engineWith({ probeMs: 5, summaryMs: 250, targets: [{ id: 'a', host: 'h', kind: 'tcp' }, { id: 'b', host: 'h2', kind: 'tcp' }],
    probe: async (t) => (t.id === 'a' ? seq[(k++) % seq.length] : { ok: true, rtt: 7 }) });
  h.e.start();
  await wait(650);
  h.e.stop();
  const a = h.rows.filter((r) => r.target === 'a');
  const b = h.rows.filter((r) => r.target === 'b');
  assert.ok(a.length >= 2 && b.length >= 2, `창마다 한 줄 (a ${a.length} · b ${b.length})`);
  const full = a.find((r) => r.n >= 15);
  assert.ok(full, `한 창에 여러 번 쟀다 — n ${a.map((r) => r.n).join(',')}`);
  const totN = a.reduce((x, r) => x + r.n, 0);
  const totF = a.reduce((x, r) => x + r.fail, 0);
  assert.ok(Math.abs(totF / totN - 0.2) < 0.08, `실패 비율 ≈ 1/5 (${totF}/${totN})`);
  for (const r of a) {
    assert.equal(r.rn <= r.n - r.fail, true, 'rn 은 RTT 가 있는 성공만');
    if (r.rn) { assert.ok(r.mn >= 10 && r.mx <= 30 && r.rtt >= r.mn && r.rtt <= r.mx); }
    assert.equal(r.ok, r.n - r.fail > 0);
  }
  assert.ok(b.every((r) => r.fail === 0 && r.rtt === 7 && r.mn === 7 && r.mx === 7));
  const stamps = a.map((r) => r.ts);
  assert.deepEqual([...stamps].sort((x, y) => x - y), stamps, '줄 시각은 창 시작(오름)');
});

test('② 느린 대상이 다른 대상을 막지 않는다', async () => {
  const h = engineWith({ probeMs: 5, summaryMs: 300, targets: [{ id: 'fast', host: 'f', kind: 'tcp' }, { id: 'slow', host: 's', kind: 'tcp' }],
    probe: async (t) => { if (t.id === 'slow') { await wait(250); return { ok: false, rtt: null }; } return { ok: true, rtt: 1 }; } });
  h.e.start();
  await wait(700);
  h.e.stop();
  const fastN = h.rows.filter((r) => r.target === 'fast').reduce((x, r) => x + r.n, 0);
  const slowN = h.rows.filter((r) => r.target === 'slow').reduce((x, r) => x + r.n, 0);
  assert.ok(fastN >= 40, `빠른 대상은 계속 잰다(${fastN}회)`);
  assert.ok(slowN >= 2 && slowN <= 4, `느린 대상은 시한만큼씩(${slowN}회)`);
  assert.ok(h.rows.filter((r) => r.target === 'slow').every((r) => r.ok === false && r.rtt === null && r.fail === r.n), '응답 없음 = 손실(0 이 아니다)');
});

test('③ 지운 대상은 남은 값을 쓰고 멈춘다 · 다시 넣으면 다시 잰다', async () => {
  const h = engineWith({ probeMs: 5, summaryMs: 150, targets: [{ id: 'a', host: 'h', kind: 'tcp' }, { id: 'b', host: 'h', kind: 'tcp' }] });
  h.e.start();
  await wait(200);
  h.list.value = [{ id: 'a', host: 'h', kind: 'tcp' }];
  h.e.reconcile();
  const cut = h.rows.length;
  await wait(400);
  const after = h.rows.slice(cut);
  const bAfter = after.filter((r) => r.target === 'b');
  assert.ok(bAfter.length <= 1, `지운 뒤 b 는 남은 값 한 줄까지만 (${bAfter.length})`);
  assert.ok(after.filter((r) => r.target === 'a').length >= 2, 'a 는 계속');
  assert.equal(h.e.status().targets, 1);
  h.list.value = [{ id: 'a', host: 'h', kind: 'tcp' }, { id: 'b', host: 'h', kind: 'tcp' }];
  h.e.reconcile();
  const cut2 = h.rows.length;
  await wait(350);
  h.e.stop();
  assert.ok(h.rows.slice(cut2).some((r) => r.target === 'b' && r.n > 3), '다시 넣은 b 를 다시 잰다');
});

test('④ 설정 변경은 재시작 없이 — 측정 간격은 바로, 요약 주기는 지금 창을 마감하고 새 경계로', async () => {
  const h = engineWith({ probeMs: 10_000, summaryMs: 10_000 });
  h.e.start();
  await wait(120);
  const before = h.e._acc().a.n;
  assert.ok(before <= 1, `10초 간격이면 아직 한 번(${before})`);
  h.set({ probeIntervalMs: 5, summaryIntervalMs: 100 });
  const cut = h.rows.length;
  assert.equal(cut, before ? 1 : 0, '설정이 바뀌면 지금 창을 바로 마감해 쓴다');
  await wait(450);
  h.e.stop();
  const later = h.rows.slice(cut).filter((r) => r.target === 'a');
  assert.ok(later.length >= 3, `새 요약 주기(100ms)로 줄이 나온다 (${later.length})`);
  assert.ok(later.some((r) => r.n >= 8), `새 측정 간격(5ms)으로 잰다 (${later.map((r) => r.n).join(',')})`);
  assert.equal(h.e.status().running, false);
});

test('⑤ stop() 은 진행 중 창을 버리지 않는다 · 측정 예외는 실패로 센다', async () => {
  let k = 0;
  const h = engineWith({ probeMs: 5, summaryMs: 60_000, probe: async () => { k += 1; if (k % 2) throw new Error('boom'); return { ok: true, rtt: 3 }; } });
  h.e.start();
  await wait(150);
  assert.equal(h.rows.length, 0, '요약 주기 전에는 쓰지 않는다');
  const r = h.e.stop();
  assert.equal(r.reason, 'stop');
  assert.equal(h.rows.length, 1);
  const row = h.rows[0];
  assert.ok(row.n >= 6 && Math.abs(row.fail - row.n / 2) <= 1, `예외 = 실패 (${row.fail}/${row.n})`);
  assert.equal(h.e.flushNow(), null, '멈춘 엔진은 마감하지 않는다');
});

test('⑥ ICMP 슬롯 — 상한을 넘지 않는다', async () => {
  const slots = createSlots(() => 2);
  let live = 0; let peak = 0;
  await Promise.all(Array.from({ length: 7 }, async () => { await slots.acquire(); live += 1; peak = Math.max(peak, live); await wait(15); live -= 1; slots.release(); }));
  assert.equal(peak, 2);
  assert.equal(slots.busy, 0);
  assert.equal(slots.waiting, 0);
});

test('⑦ 저장소 — 요약 줄과 예전 줄이 같은 식으로 묶인다(원시 · 롤업 · 재구성 · NDJSON 가중)', () => {
  assert.deepEqual(weightOf({ ok: true, rtt: 10 }), { n: 1, fail: 0, rn: 1, rtt: 10, mn: 10, mx: 10 });
  assert.deepEqual(weightOf({ ok: false, rtt: null }), { n: 1, fail: 1, rn: 0, rtt: null, mn: null, mx: null });
  assert.deepEqual(weightOf({ ok: true, rtt: 20, n: 60, fail: 6, rn: 54, mn: 5, mx: 90 }), { n: 60, fail: 6, rn: 54, rtt: 20, mn: 5, mx: 90 });
  assert.deepEqual(weightOf({ ok: false, rtt: null, n: 3, fail: 3, rn: 0 }), { n: 3, fail: 3, rn: 0, rtt: null, mn: null, mx: null });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingcont2963db-'));
  const script = `
    const HOUR = 3600000;
    const { getPingDb } = await import(${JSON.stringify(path.join(SRC, 'ping/db.js'))});
    const db = await getPingDb();
    await db._rollupSeed?.();
    const t0 = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR + 10 * 60000;
    db.insertMany([
      { target: 'a', ts: t0, rtt: 10, ok: true },
      { target: 'a', ts: t0 + 60000, rtt: null, ok: false },
      { target: 'a', ts: t0 + 120000, rtt: 20, ok: true, n: 60, fail: 6, rn: 54, mn: 5, mx: 90 },
      { target: 'a', ts: t0 + 180000, rtt: null, ok: false, n: 60, fail: 60, rn: 0 },
    ]);
    const raw = db.history('a', t0 - HOUR, 3600000 / 2, 10);
    const hourly = db.historyHourly('a', t0 - HOUR, HOUR, 10);
    await db.dropTarget('a', t0 + 90000);   // 경계가 걸친 시간 칸은 남은 원시로 다시 만든다
    const afterDrop = db.historyHourly('a', t0 - HOUR, HOUR, 10);
    const afterRaw = db.history('a', t0 - HOUR, HOUR, 10);
    (await import('node:fs')).writeFileSync(process.env.OUT, JSON.stringify({ raw, hourly, afterDrop, afterRaw, kind: db.kind }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir, OUT: path.join(dir, 'o.json') }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const o = JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(o.kind, 'sqlite');
  const sum = (list, k) => list.reduce((x, b) => x + b[k], 0);
  assert.equal(sum(o.raw, 'n'), 122, '측정 수 = 1 + 1 + 60 + 60');
  assert.equal(sum(o.raw, 'fail'), 67, '실패 = 0 + 1 + 6 + 60');
  const withAvg = o.raw.find((b) => b.avg != null);
  assert.equal(withAvg.avg, Math.round(((10 + 20 * 54) / 55) * 100) / 100, '평균은 rn 가중');
  assert.equal(withAvg.min, 5); assert.equal(withAvg.max, 90);
  assert.equal(sum(o.hourly, 'n'), 122, '롤업도 같은 수');
  assert.equal(sum(o.hourly, 'fail'), 67);
  assert.equal(o.hourly.find((b) => b.avg != null).avg, withAvg.avg, '롤업 평균 = 원시 평균');
  assert.equal(sum(o.afterRaw, 'n'), 120, '삭제 경계 뒤 원시 = 요약 두 줄');
  assert.equal(sum(o.afterDrop, 'n'), 120, '삭제 뒤 재구성한 롤업도 같은 가중');
  assert.equal(sum(o.afterDrop, 'fail'), 66);
});

function settingsRun(env, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingcont2963set-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], { env: { ...process.env, CONFIG_DIR: dir, OUT: path.join(dir, 'o.json'), DATA_SOURCE: 'live', AUTH_ENABLED: 'true', ...env }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const o = JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return o;
}

test('⑧ 설정 — env 기본 · 화면 값이 이김 · 검사 · 초기화 · 손상 보존 · 변경 알림', () => {
  const o = settingsRun({ PING_MON_INTERVAL_MS: '30000', PING_MON_PROBE_MS: '', PING_MON_TIMEOUT_MS: '' }, `
    const S = await import(${JSON.stringify(path.join(SRC, 'ping/settings.js'))});
    const fs = await import('node:fs'); const path = await import('node:path');
    const out = {};
    let heard = 0; S.onPingSettingsChange(() => { heard += 1; });
    out.def = S.loadPingSettings();
    out.save = S.savePingSettings({ probeIntervalMs: 2000, summaryIntervalMs: 120000 }, { actor: 'admin1' });
    out.after = S.loadPingSettings();
    out.badRange = S.savePingSettings({ probeIntervalMs: 500 });
    out.badInt = S.savePingSettings({ timeoutMs: 1500.5 });
    out.badStr = S.savePingSettings({ timeoutMs: 'abc' });
    out.badOrder = S.savePingSettings({ summaryIntervalMs: 10000, probeIntervalMs: 20000 });
    out.clearOne = S.savePingSettings({ probeIntervalMs: null });
    out.reset = S.savePingSettings({ reset: true });
    out.heard = heard;
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'ping-settings.json'), '{oops');
    out.corrupt = S.loadPingSettings();
    out.corruptSave = S.savePingSettings({ probeIntervalMs: 3000 });
    out.files = fs.readdirSync(process.env.CONFIG_DIR).filter((f) => f.startsWith('ping-settings.json'));
    out.load = S.pingLoadOf({ probeIntervalMs: 1000, summaryIntervalMs: 60000 }, 30);
    fs.writeFileSync(process.env.OUT, JSON.stringify(out));
    process.exit(0);
  `);
  assert.equal(o.def.summaryIntervalMs, 30_000, 'env PING_MON_INTERVAL_MS = 요약 주기 기본');
  assert.equal(o.def.source.summaryIntervalMs, 'env');
  assert.equal(o.def.probeIntervalMs, 1_000, '측정 간격 기본 1초');
  assert.equal(o.def.source.probeIntervalMs, 'default');
  assert.equal(o.def.timeoutMs, 2_500);
  assert.equal(o.save.ok, true);
  assert.equal(o.after.probeIntervalMs, 2_000); assert.equal(o.after.summaryIntervalMs, 120_000);
  assert.deepEqual(o.after.source, { probeIntervalMs: 'ui', summaryIntervalMs: 'ui', timeoutMs: 'default' });
  assert.equal(o.after.updatedBy, 'admin1');
  assert.deepEqual([o.badRange.ok, o.badRange.field], [false, 'probeIntervalMs']);
  assert.deepEqual([o.badInt.ok, o.badInt.field], [false, 'timeoutMs']);
  assert.deepEqual([o.badStr.ok, o.badStr.field], [false, 'timeoutMs']);
  assert.deepEqual([o.badOrder.ok, o.badOrder.field], [false, 'summaryIntervalMs'], '요약 주기 < 측정 간격은 저장하지 않는다');
  assert.equal(o.clearOne.settings.probeIntervalMs, 1_000, '비운 항목만 기본값으로');
  assert.equal(o.clearOne.settings.summaryIntervalMs, 120_000);
  assert.equal(o.reset.settings.summaryIntervalMs, 30_000, '초기화 = env 기본');
  assert.equal(o.reset.settings.source.summaryIntervalMs, 'env');
  assert.equal(o.heard, 3, '저장이 성공할 때만 알린다(save · clearOne · reset)');
  assert.ok(o.corrupt.loadError && o.corrupt.summaryIntervalMs === 30_000, '손상 = 기본값으로 동작 + loadError');
  assert.equal(o.corruptSave.ok, false, '손상 상태에서 저장해 원본을 덮지 않는다');
  assert.ok(o.files.some((f) => f.includes('.corrupt.')), `원본 보존 ${o.files.join(',')}`);
  assert.deepEqual(o.load, { targets: 30, probesPerSec: 30, probesPerSummary: 60, rowsPerDay: 43_200 });
});

test('⑨ 라우트 — GET 인증 · PUT 관리자 · 전체 범위 · 400 field · 손상 503 · poll-now', () => {
  const o = settingsRun({}, `
    const express = (await import('express')).default;
    const { pingRouter } = await import(${JSON.stringify(path.join(SRC, 'routes/ping.js'))});
    const fs = await import('node:fs'); const path = await import('node:path');
    const users = {
      admin: { username: 'a', role: 'admin', scope: null },
      operator: { username: 'o', role: 'operator', scope: null },
      viewer: { username: 'v', role: 'viewer', scope: null },
      scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } },
    };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
    app.use('/api/ping', pingRouter);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/ping/';
    const call = async (method, p, who = 'admin', body) => { const x = await fetch(base + p, { method, headers: { 'x-test-user': who, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => null) }; };
    const out = {};
    out.getViewer = await call('GET', 'settings', 'viewer');
    out.getScoped = await call('GET', 'settings', 'scoped');
    out.getAdmin = await call('GET', 'settings', 'admin');
    out.putOk = await call('PUT', 'settings', 'admin', { probeIntervalMs: 5000, summaryIntervalMs: 60000, timeoutMs: 1000, junk: 1 });
    out.putOperator = await call('PUT', 'settings', 'operator', { probeIntervalMs: 2000 });
    out.putScoped = await call('PUT', 'settings', 'scoped', { probeIntervalMs: 2000 });
    out.putBad = await call('PUT', 'settings', 'admin', { summaryIntervalMs: 5 });
    out.putReset = await call('PUT', 'settings', 'admin', { reset: true });
    out.pollNow = await call('POST', 'poll-now', 'admin');
    fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'ping-settings.json'), '[1,2');
    out.getCorrupt = await call('GET', 'settings', 'admin');
    out.putCorrupt = await call('PUT', 'settings', 'admin', { probeIntervalMs: 2000 });
    srv.close();
    fs.writeFileSync(process.env.OUT, JSON.stringify(out));
    process.exit(0);
  `);
  assert.equal(o.getViewer.status, 200);
  assert.equal(o.getViewer.body.probeIntervalMs, 1_000);
  assert.equal(o.getViewer.body.summaryIntervalMs, 60_000);
  assert.ok(o.getViewer.body.ranges?.probeIntervalMs?.min === 1_000);
  assert.equal(o.getScoped.body.load, null, '범위 계정에는 전 대상 수가 들어간 부하 산수를 싣지 않는다');
  assert.ok(o.getAdmin.body.load && 'probesPerSec' in o.getAdmin.body.load);
  assert.ok(o.getAdmin.body.monitor && 'running' in o.getAdmin.body.monitor);
  assert.equal(o.putOk.status, 200);
  assert.equal(o.putOk.body.probeIntervalMs, 5_000);
  assert.equal(o.putOk.body.timeoutMs, 1_000);
  assert.equal(o.putOk.body.source.probeIntervalMs, 'ui');
  assert.equal(o.putOperator.status, 403, 'operator 403(관리자만)');
  assert.equal(o.putScoped.status, 403, '범위 계정 403(전 대상 측정을 바꾼다)');
  assert.equal(o.putBad.status, 400);
  assert.equal(o.putBad.body.field, 'summaryIntervalMs');
  assert.equal(o.putReset.status, 200);
  assert.equal(o.putReset.body.probeIntervalMs, 1_000);
  assert.equal(o.pollNow.status, 200);
  assert.equal(o.pollNow.body.mode, 'once', '연속 측정이 돌지 않으면 한 번 잰다');
  assert.ok(o.getCorrupt.body.loadError, '손상은 화면에 알린다');
  assert.equal(o.putCorrupt.status, 503, '손상 상태 저장은 503');
});

test('⑩ 서버 범위 ↔ 웹 문구 범위 1:1', async () => {
  const S = await import('../src/ping/settings.js');
  const W = await import(path.join(WEB, 'views/pingSettingsText.js'));
  assert.deepEqual(JSON.parse(JSON.stringify(W.PING_SETTING_RANGES)), JSON.parse(JSON.stringify(S.PING_SETTING_RANGES)));
});
