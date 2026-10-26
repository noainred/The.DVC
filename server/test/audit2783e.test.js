// v2.783 점검 Q5 회귀 — 내보내기 백프레셔 대기 · 토큰 점검 인출 예산 · VM DNS CSV 'DNS 없음'.
//  ① util/waitDrain — drain 이면 true, 끊김·오류·이미 닫힘이면 false, 어느 쪽이든 건 리스너를 전부 뗀다.
//  ② GPU 시계열 내보내기(CSV·JSON) — 백프레셔 중 클라이언트가 끊으면 핸들러가 끝나고 내보내기 잠금이 풀린다
//     (예전: `res.once('drain')` 만 기다려 영원히 멈춤 → finally 의 lock.release 에 닿지 못해 재기동 전까지 409).
//  ③ 전송 속도 CSV — 큰 내보내기가 'close' 리스너를 쌓지 않고 MaxListenersExceededWarning 이 없다(O-B4).
//  ④ 소스 스윕 — server/src 에 drain 만 기다리는(once('drain')) 형태 · drain+close 를 각각 once 로 거는 형태를 새로 만들지 않는다.
//  ⑤ 토큰 점검 엣지 인출 — 예산 판정이 실제 인출 시한(PULL_TIMEOUT_MS)을 쓰고, env 상한 60초 · 하한 3초(O-I2).
//  ⑥ VM DNS CSV — 보고했지만 서버 0개인 VM 은 'DNS 없음'(N-I1).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2783e-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

const express = (await import('express')).default;
const { waitDrain } = await import('../src/util/waitDrain.js');
const FULL = { username: 'root', role: 'admin', scope: {} };
const HOUR = 3_600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000; // 정시 −30분(경계에서 떨어뜨린 고정 기준)

let store; let api; let acquireExport;
before(async () => {
  ({ store } = await import('../src/store.js'));
  await store.refresh().catch(() => {});
  ({ api } = await import('../src/routes/api.js'));
  ({ acquireExport } = await import('../src/util/exportBusy.js'));
});

async function listen(router, { onRes } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = FULL; onRes?.(res); next(); });
  app.use('/api', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { srv, base: `http://127.0.0.1:${srv.address().port}/api`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 응답 헤더를 받은 뒤 읽기를 멈추고(백프레셔를 만든다) delay 뒤 연결을 끊는다. */
function abortingGet(url, delay = 300) {
  return new Promise((resolve) => {
    const req = http.get(url, (r) => {
      const status = r.statusCode;
      r.pause();
      setTimeout(() => { req.destroy(); resolve(status); }, delay);
    });
    req.on('error', () => {});
  });
}

/** 잠금이 풀릴 때까지(최대 ms) 기다린다 — 풀렸으면 바로 되돌려 놓고 true. */
async function lockFreedWithin(name, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const l = acquireExport(name, { user: { username: 'probe' } });
    if (l.ok) { l.release(); return true; }
    await sleep(50);
  }
  return false;
}

test('① waitDrain — drain=true · close/error=false · 이미 닫힘=false · 리스너를 남기지 않는다', async () => {
  const mk = () => { const s = new EventEmitter(); s.destroyed = false; s.writableNeedDrain = true; return s; };
  const a = mk();
  const pa = waitDrain(a);
  assert.equal(a.listenerCount('close'), 1);
  a.emit('drain');
  assert.equal(await pa, true);
  assert.deepEqual([a.listenerCount('drain'), a.listenerCount('close'), a.listenerCount('error')], [0, 0, 0], 'drain 뒤 close·error 리스너가 남았다');
  const b = mk();
  const pb = waitDrain(b);
  b.emit('close');
  assert.equal(await pb, false);
  assert.deepEqual([b.listenerCount('drain'), b.listenerCount('close'), b.listenerCount('error')], [0, 0, 0]);
  const c = mk();
  const pc = waitDrain(c);
  c.emit('error', new Error('x'));
  assert.equal(await pc, false);
  const d = mk(); d.destroyed = true;
  assert.equal(await waitDrain(d), false, '이미 끊긴 스트림을 영원히 기다리면 안 된다');
  // gzip → res 처럼 drain 대상과 끊김 대상이 다를 때 — 끊김 대상의 close 로 끝나고 양쪽 리스너를 뗀다.
  const g = mk(); const r = mk();
  const pg = waitDrain(g, r);
  r.emit('close');
  assert.equal(await pg, false);
  assert.deepEqual([g.listenerCount('drain'), g.listenerCount('close'), r.listenerCount('close'), r.listenerCount('error')], [0, 0, 0, 0]);
  // 100번 기다려도(drain 먼저) close 리스너가 쌓이지 않는다
  const e = mk();
  for (let i = 0; i < 100; i++) { const p = waitDrain(e); e.emit('drain'); await p; }
  assert.equal(e.listenerCount('close'), 0);
});

test('② GPU 시계열 CSV·JSON 내보내기 — 백프레셔 중 클라이언트가 끊으면 핸들러가 끝나 잠금이 풀린다(두 번째 내보내기가 409 가 아니다)', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  // 키 2000개 × 60 시점 = 12만 행(첫 청크 5만 행 ≈ 4MB — 소켓 버퍼를 넘겨 drain 대기에 들어간다).
  const keys = Array.from({ length: 2000 }, (_, i) => `gpu-host-${i}`);
  for (let t = 0; t < 60; t++) db.insertMany(keys.map((k, i) => ({ metric: 'gpu_util', k, v: (i + t) % 100 })), T0 - (60 - t) * 60_000);
  const s = await listen(api);
  try {
    for (const fmt of ['csv', 'json']) {
      const st = await abortingGet(`${s.base}/tools/gpu/export.${fmt}?range=all`, 300);
      assert.equal(st, 200, `${fmt}: 내보내기가 시작되지 않았다`);
      assert.equal(await lockFreedWithin('gpu.series.export', 5000), true,
        `${fmt}: 끊긴 뒤 5초가 지나도 내보내기 잠금이 그대로다(drain 만 기다려 핸들러가 멈춤 — 재기동 전까지 409)`);
      const again = await fetch(`${s.base}/tools/gpu/export.${fmt}?range=days&days=1`);
      await again.arrayBuffer();
      assert.equal(again.status, 200, `${fmt}: 끊긴 내보내기 뒤 다음 내보내기가 ${again.status}`);
    }
  } finally { s.close(); }
});

test('③ 전송 속도 CSV — 큰 내보내기(3만 행)가 close 리스너를 쌓지 않고 MaxListenersExceededWarning 이 없다', async () => {
  const xdb = await import('../src/xferspeed/db.js');
  const rows = [];
  for (let i = 0; i < 30_000; i++) {
    rows.push({ agent: `edge-${i % 7}`, dir: i % 2 ? 'up' : 'down', ts: T0 - 2 * 86_400_000 + i * 1000, ok: true, mbps: 10 + (i % 50), bytes: 1048576,
      xferMs: 140, totalMs: 260, ttfbMs: 20, basis: 'receiver', trig: 'schedule' });
  }
  for (let k = 0; k < rows.length; k += 3000) {
    const r = await xdb.insertSamples(rows.slice(k, k + 3000));
    assert.equal(r.ok, true, r.error);
  }
  const warnings = [];
  const onWarn = (w) => { if (w?.name === 'MaxListenersExceededWarning') warnings.push(String(w.message)); };
  process.on('warning', onWarn);
  let base = null; let max = 0; let writes = 0;
  const s = await listen(api, {
    onRes: (res) => {
      if (!res.req?.url?.includes('xfer-speed/export.csv')) return;
      const orig = res.write.bind(res);
      res.write = (...a) => {
        const n = res.listenerCount('close');
        if (base == null) base = n;
        max = Math.max(max, n); writes += 1;
        return orig(...a);
      };
    },
  });
  try {
    const r = await fetch(`${s.base}/tools/xfer-speed/export.csv?days=30`);
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    assert.equal(r.status, 200, text.slice(0, 300));
    assert.ok(text.split('\r\n').length >= 30_001, `행 수 ${text.split('\r\n').length}`);
    assert.ok(writes >= 15, `조각 쓰기 ${writes}회 — 백프레셔를 만들 만큼 크지 않다`);
    await sleep(50); // 경고는 nextTick 으로 나온다
    assert.ok(max <= base + 1, `내보내는 동안 'close' 리스너가 ${base} → 최대 ${max} 로 쌓였다`);
    assert.deepEqual(warnings, [], 'MaxListenersExceededWarning 이 났다');
  } finally { process.off('warning', onWarn); s.close(); }
});

test('④ 소스 스윕 — drain 만 기다리거나 drain·close 를 각각 once 로 거는 대기를 새로 만들지 않는다(공용 util/waitDrain)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(SRC);
  // svcmon/csvlog.js 는 파일 스트림 라이터 — 'error' 핸들러가 draining 을 풀어 준다(v2.287 #21). 응답 스트림이 아니다.
  const ALLOW = new Set(['svcmon/csvlog.js']);
  const bad = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    if (ALLOW.has(rel) || rel === 'util/waitDrain.js') continue;
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\.once\(\s*['"]drain['"]/.test(s)) bad.push(rel);
  }
  assert.deepEqual(bad, [], `once('drain') 대기 — util/waitDrain.js 를 쓸 것: ${bad.join(', ')}`);
  for (const rel of ['routes/api/hardwareGpu.js', 'routes/api/checksLogs.js', 'routes/api/xferSpeed.js', 'xferspeed/serve.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    assert.match(s, /from '\.\.\/(\.\.\/)?util\/waitDrain\.js'/, `${rel}: 공용 waitDrain 을 쓰지 않는다`);
  }
});

test('⑤ 토큰 점검 엣지 인출 — 예산 판정은 실제 인출 시한 · env 는 3초~60초', async () => {
  const run = (env) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import('./src/central/tokenCheckPull.js'); console.log('@@' + JSON.stringify({ t: m.PULL_TIMEOUT_MS }));"],
    { env: { ...process.env, CONFIG_DIR: CFG, ...env }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000 });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, r.stderr);
    return JSON.parse(line.slice(2)).t;
  };
  assert.equal(run({ PORTALCHECK_PULL_TIMEOUT_MS: '' }), 20_000, '기본값');
  assert.equal(run({ PORTALCHECK_PULL_TIMEOUT_MS: '120000' }), 60_000, '상한(웹 백스톱 180초 안에 들게)');
  assert.equal(run({ PORTALCHECK_PULL_TIMEOUT_MS: '500' }), 3_000, '하한');
  const { stripComments } = await import('./_stripComments.js');
  const s = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/portalCheck.js'), 'utf8'));
  const i = s.indexOf("'/tools/portal-check/tokens/edge-pull'");
  assert.ok(i > 0);
  const j = s.indexOf('\napi.', i + 10);
  const body = s.slice(i, j > 0 ? j : undefined);
  assert.match(body, /PULL_TIMEOUT_MS/, '예산 판정이 인출 시한을 써야 한다');
  assert.doesNotMatch(body, /PROBE_TIMEOUT_MS/, '프로브 시한(8초)으로 인출 예산을 판정하면 예산을 넘긴다');
  assert.match(body, /pullTokenCheck\([^)]*timeoutMs/, '판정에 쓴 시한을 실제 인출에도 넘긴다');
});

test('⑥ VM DNS CSV — 보고했지만 DNS 서버 0개인 VM 은 이상 없음이 아니라 DNS 없음', async () => {
  const A = await import('../src/vmdns/analyze.js');
  const dns = (servers) => ({ servers, stack: { servers, domain: 'a.corp', search: [], dhcp: true, hostName: 'h' },
    nics: [{ network: 'VM Network', mac: '00:50:56:00:00:01', servers, domain: 'a.corp', search: [], dhcp: true }] });
  const snap = {
    vcenters: [{ id: 'vc-a', name: 'Alpha' }],
    hosts: [],
    vms: [
      { id: 'vc-a:ok', name: 'A-OK', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.1'], dns: dns(['10.1.0.53', '10.1.0.54']) },
      { id: 'vc-a:none', name: 'A-NONE', vcenterId: 'vc-a', powerState: 'POWERED_ON', ipAddresses: ['10.1.1.2'], dns: dns([]) },
      { id: 'vc-a:unk', name: 'A-UNK', vcenterId: 'vc-a', powerState: 'POWERED_OFF', ipAddresses: [], dns: null },
    ],
  };
  const rows = A.csvRows({ snap, policy: {} });
  const by = Object.fromEntries(rows.map((r) => [r[1], r[r.length - 1]]));
  assert.equal(by['A-OK'], '이상 없음');
  assert.equal(by['A-NONE'], 'DNS 없음', `서버 0개 VM 의 CSV 판정: ${by['A-NONE']}`);
  assert.equal(by['A-UNK'], A.STATE_TEXT.unknown, '모름(null)은 예전 그대로');
  // 화면·KPI·필터가 읽는 flags 에는 넣지 않는다(웹 flagChips 가 모르는 표지를 회색 원문 칩으로 보인다 — CSV 전용).
  const out = A.analyzeVmDns({ snap, policy: {} });
  assert.equal(out.kpis.reported, 2);
});
