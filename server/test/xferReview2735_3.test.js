/**
 * v2.735.3 — 법인 간 전송 속도 리뷰 확정분(사용자 요청 "기타 개선이 필요하거나 버그 찾아서 수정").
 *  XS-03 엣지에 COLLECTOR_TOKEN 이 없으면 'collector-off'(예전엔 'XFER_TEST_ENABLED 로 껐다' 로 잘못 안내)
 *  XS-04 잴 엣지가 0곳이면 '지금 측정' 이 409 + 사유(예전엔 202 + '1분 안에 나옵니다')
 *  XS-07 요청보다 많은 바이트(받음·보고)는 bad-body — 그 값으로 속도를 계산하지 않는다
 *  XS-08 상한에 걸리면 오래된 쪽을 버린다(예전엔 가장 최근 행이 빠졌다)
 *  XS-10 CSV 가 end(보고 있는 구간)를 따른다
 *  XS-11 보존 정리는 시간 기준(6시간) — 측정이 꺼져 있어도, 첫 틱에는 하지 않는다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xferreview2735_3-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
delete process.env.XFER_SPEED_ENABLED;

const probe = await import('../src/xferspeed/probe.js');
const db = await import('../src/xferspeed/db.js');
const poller = await import('../src/xferspeed/poller.js');

const MB = 1_048_576;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const col = { id: 'Edge-T', name: 'Edge T', url: 'https://10.9.9.9:4000', token: 'tok' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('XS-03 404 사유로 꺼진 까닭을 가른다 — COLLECTOR_TOKEN 없음 / 측정 꺼짐 / 구버전', async () => {
  const off = await probe.measureDown(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: async () => json(404, { ok: false, reason: 'collector 비활성화(COLLECTOR_TOKEN 미설정)' }) });
  assert.equal(off.kind, 'collector-off');
  assert.match(off.error, /COLLECTOR_TOKEN/);
  const dis = await probe.measureDown(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: async () => json(404, { ok: false, reason: '이 엣지에서 전송 속도 측정을 껐습니다(portal.env XFER_TEST_ENABLED=false).' }) });
  assert.equal(dis.kind, 'disabled');
  const old = await probe.measureDown(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: async () => new Response('<html>Cannot GET</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }) });
  assert.equal(old.kind, 'old-version');
  assert.ok(probe.XFER_FAIL_KINDS.includes('collector-off'));
});

test('XS-07 요청보다 많은 바이트 — 받은 쪽(↓)·엣지 보고(↑) 모두 bad-body', async () => {
  const over = Buffer.alloc(MB + 4096, 7);
  const down = await probe.measureDown(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: async () => new Response(over, { status: 200 }) });
  assert.equal(down.ok, false);
  assert.equal(down.kind, 'bad-body');
  assert.equal(down.mbps, null);
  const up = await probe.measureUp(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: async () => json(200, { ok: true, bytes: 1e12, recvMs: 900 }) });
  assert.equal(up.ok, false);
  assert.equal(up.kind, 'bad-body');
  assert.equal(up.mbps, null, '오염된 속도를 저장하지 않는다');
  const exact = await probe.measureUp(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: async () => json(200, { ok: true, bytes: MB, recvMs: 900 }) });
  assert.equal(exact.ok, true, '정확히 같은 크기는 정상');
});

test('XS-08 상한에 걸리면 가장 최근 행을 남긴다(시각 순) · XS-10 exportRows until', async () => {
  db._resetForTest();
  const base = Date.UTC(2026, 9, 10, 3, 30);
  const rows = Array.from({ length: 10 }, (_, i) => ({ agent: 'Edge-T', dir: 'down', ts: base + i * HOUR, ok: true, mbps: 10 + i, bytes: MB, xferMs: 100, totalMs: 200, ttfbMs: 50, basis: 'receiver', trig: 'timer' }));
  const r = await db.insertSamples(rows);
  assert.equal(r.inserted, 10);
  const s = await db.samplesSince(base - DAY, { agent: 'Edge-T', limit: 3 });
  assert.equal(s.truncated, true);
  assert.deepEqual(s.rows.map((x) => x.mbps), [17, 18, 19], '최근 3행 · 시각 순');
  const all = await db.samplesSince(base - DAY, { limit: 3 });
  assert.deepEqual(all.rows.map((x) => x.mbps), [17, 18, 19]);
  const e = await db.exportRows(base - DAY, { agent: 'Edge-T', limit: 3 });
  assert.deepEqual(e.rows.map((x) => x.mbps), [17, 18, 19]);
  assert.equal(e.truncated, true);
  const w = await db.exportRows(base - DAY, { agent: 'Edge-T', until: base + 4 * HOUR });
  assert.deepEqual(w.rows.map((x) => x.mbps), [10, 11, 12, 13, 14], 'until 이후 행은 빠진다');
  assert.equal(w.truncated, false);
});

test('XS-11 보존 정리는 시간 기준 — 첫 틱은 하지 않고 6시간 뒤에는 측정이 꺼져 있어도 한다', async () => {
  db._resetForTest();
  poller._resetXferPollerForTest();
  const old = Date.now() - 400 * DAY;   // 원시 보존 기본 180일 밖
  await db.insertSamples([{ agent: 'Edge-P', dir: 'down', ts: old, ok: true, mbps: 1, bytes: MB, xferMs: 100, totalMs: 200, ttfbMs: 50, basis: 'receiver', trig: 'timer' }]);
  const count = async () => (await db.samplesSince(0, { agent: 'Edge-P' })).rows.length;
  const t0 = Date.now();
  await poller.tickXferSchedule({ now: t0 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await count(), 1, '첫 틱은 기준만 잡는다');
  await poller.tickXferSchedule({ now: t0 + HOUR });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(await count(), 1, '6시간 전에는 하지 않는다');
  await poller.tickXferSchedule({ now: t0 + poller.PRUNE_EVERY_MS + 1 });
  let n = 1;
  for (let i = 0; i < 40 && n; i += 1) { await new Promise((r) => setTimeout(r, 50)); n = await count(); }
  assert.equal(n, 0, '6시간 뒤에는 꺼져 있어도 보존 정리가 돈다');
});

test('XS-04·XS-10 실제 api 라우터 — 0곳이면 409 · CSV end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferreview2735_3-api-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'Edge-Off', name: 'Edge Off', url: 'https://10.20.0.6:4000', token: 't', enabled: false }, { id: 'Edge-On', name: 'Edge On', url: 'https://10.20.0.7:4000', token: 't', enabled: true }] }));
  const script = `
    const HOUR = 3600000, DAY = 24 * HOUR;
    const db = await import(${JSON.stringify(path.join(SRC, 'xferspeed/db.js'))});
    const now = Date.now();
    const E = Math.floor(now / HOUR) * HOUR - 2 * DAY - 30 * 60000;
    await db.insertSamples([E - 2 * HOUR, E + 2 * HOUR].map((ts, i) => ({ agent: 'Edge-On', dir: 'down', ts, ok: true, mbps: 11 + i, bytes: 1048576, xferMs: 100, totalMs: 200, ttfbMs: 50, basis: 'receiver', trig: 'timer' })));
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'a', role: 'admin', superAdmin: true, scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const b = 'http://127.0.0.1:' + srv.address().port + '/api/tools/xfer-speed';
    const post = async (body) => { const x = await fetch(b + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: x.status, body: await x.json() }; };
    const out = {
      off: await post({ agent: 'edge-off' }),
      csvPast: await (await fetch(b + '/export.csv?days=1&agent=edge-on&end=' + E)).text(),
      csvNow: await (await fetch(b + '/export.csv?days=7&agent=edge-on')).text(),
    };
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.off.status, 409, '꺼진 엣지만 고르면 시작하지 않는다');
  assert.equal(o.off.body.noTargets, true);
  assert.match(o.off.body.reason, /꺼져 있습니다/);
  const dataLines = (t) => t.split('\r\n').slice(1).filter(Boolean);
  assert.equal(dataLines(o.csvPast).length, 1, '과거 구간 CSV 는 그 창의 행만');
  assert.match(dataLines(o.csvPast)[0], /,11,/);
  assert.equal(dataLines(o.csvNow).length, 2, 'end 가 없으면 지금까지');
});
