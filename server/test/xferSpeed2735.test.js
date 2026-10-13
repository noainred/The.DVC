/**
 * v2.735 — 법인 간 전송 속도 측정(메인 ↔ 엣지 10MB, 30분 주기 · DB 이력 · 특수 기능 화면).
 *
 *  ① 설정 — 기본 꺼짐 · 범위 클램프 · 빈 숫자 칸은 이전 값 유지 · 제외 목록 정규화 · 손상 파일 보존 후에도 '못 읽음' 을 말한다
 *  ② 엣지 라우트(`/api/collector/xfer-test`) — 토큰 · bytes 검증 · 무작위 데이터 · 업로드 수신 시간 · 꺼짐 404 + 사유 · 동시 상한 429
 *  ③ 측정기(probe) — 실제 엣지 라우트 상대로 ↓↑ · 꺼짐/구버전 404 구분 · 403 · 전송 중 끊김(short) · 시한 · 버퍼링 프록시 판정
 *  ④ DB — 같은 ts 재적재가 일 요약을 두 번 세지 않는다 · 최신값은 더 늦은 ts 만 · 실패 연속 · 실패 행의 속도는 NULL · 보존 정리
 *  ⑤ 판정(analyze) — 측정 없음/오래됨을 정상으로 칠하지 않는다 · 평소 대비 느려짐은 표본 6개 이상일 때만 · KPI 항등식 · 히트맵 빈 칸
 *  ⑥ 폴러 — 대상 선정(꺼짐·URL 없음·제외) · 오래 안 잰 엣지 먼저 · 수동 실행이 같은 가드를 쓴다
 *  ⑦ 실제 api 라우터(자식 프로세스) — admin 200 · operator 403 · 범위 계정 403 · CSV 는 data.csv · 응답에 토큰 없음
 *  ⑧ 웹 문구와 1:1 — 실패 종류 · 상태 · 사유 코드(웹 xferSpeedText.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web/src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xferspeed2735-'));
process.env.CONFIG_DIR = TMP;
process.env.COLLECTOR_TOKEN = 'edge-token-2735';
process.env.DATA_SOURCE = 'live';
delete process.env.XFER_TEST_ENABLED;
delete process.env.XFER_SPEED_ENABLED;

const settings = await import('../src/xferspeed/settings.js');
const serve = await import('../src/xferspeed/serve.js');
const probe = await import('../src/xferspeed/probe.js');
const db = await import('../src/xferspeed/db.js');
const an = await import('../src/xferspeed/analyze.js');
const poller = await import('../src/xferspeed/poller.js');
const express = (await import('express')).default;
const { collectorRouter } = await import('../src/routes/collector.js');

const MB = 1_048_576;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 테스트용 fetch — resilientFetch 와 같은 옵션 모양(timeoutMs·retries)을 받는다. */
const plainFetch = (url, { timeoutMs = 10_000, retries, ...init } = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

async function listen(app) {
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

function edgeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/collector', collectorRouter);
  return app;
}

/* ① 설정 ───────────────────────────────────────────────────────────── */
test('① 설정 — 기본 꺼짐 · 클램프 · 빈 칸 유지 · 제외 정규화 · 손상 보존', () => {
  const d = settings.normalizeSettings({});
  assert.equal(d.enabled, false, '기본은 꺼짐(opt-in) — 회선을 실제로 쓴다');
  assert.equal(d.intervalMs, 30 * 60_000);
  assert.equal(d.sizeMB, 10);
  const c = settings.normalizeSettings({ intervalMs: 1, sizeMB: 9999, concurrency: 99, slowPct: 1, excluded: ['A', 'a', ' b ', '', 5, null] });
  assert.equal(c.intervalMs, settings.RANGES.intervalMs.min);
  assert.equal(c.sizeMB, 50);
  assert.equal(c.concurrency, 4);
  assert.equal(c.slowPct, 10);
  assert.deepEqual(c.excluded, ['A', 'b'], '대소문자 무시 중복 제거 · 글자만');

  const s1 = settings.saveXferSpeedSettings({ enabled: true, intervalMs: 3_600_000, sizeMB: 20 });
  assert.equal(s1.enabled, true);
  assert.equal(s1.intervalMs, 3_600_000);
  // 빈 칸·숫자 아님은 '미지정' — 이전 값이 남는다(Number('') === 0 이 하한 10분으로 올라가지 않게).
  const s2 = settings.saveXferSpeedSettings({ intervalMs: '', sizeMB: null, slowPct: 'abc', enabled: 'yes' });
  assert.equal(s2.intervalMs, 3_600_000);
  assert.equal(s2.sizeMB, 20);
  assert.equal(s2.enabled, true, '불리언이 아닌 enabled 는 무시');
  assert.equal(fs.statSync(path.join(TMP, 'xfer-speed-settings.json')).mode & 0o777, 0o600);

  // 손상 → 보존 + 기본값(꺼짐) + 사유. 재시작처럼 원본이 치워진 뒤에도 '못 읽음' 을 계속 말한다.
  fs.writeFileSync(path.join(TMP, 'xfer-speed-settings.json'), '{not json');
  const s3 = settings.loadXferSpeedSettings();
  assert.equal(s3.enabled, false);
  assert.ok(settings.xferSettingsLoadError(), '손상 사유가 있어야 한다');
  assert.ok(fs.readdirSync(TMP).some((n) => n.startsWith('xfer-speed-settings.json.corrupt.')), '손상본 보존');
  assert.ok(settings.xferSettingsLoadError()?.reason?.includes('손상 보존본'), '원본이 치워진 뒤에도 못 읽음을 말한다');
  settings.saveXferSpeedSettings({ enabled: false });
  assert.equal(settings.xferSettingsLoadError(), null, '저장하면 풀린다');

  assert.equal(settings.isExcluded({ excluded: ['Edge-A'] }, 'edge-a'), true);
  assert.equal(settings.isExcluded({ excluded: ['Edge-A'] }, 'edge-b', null), false);
  process.env.XFER_SPEED_ENABLED = 'true';
  assert.equal(settings.xferSpeedEnabled({ enabled: false }), true, 'env 가 강제한다');
  process.env.XFER_SPEED_ENABLED = 'false';
  assert.equal(settings.xferSpeedEnabled({ enabled: true }), false);
  delete process.env.XFER_SPEED_ENABLED;
});

/* ② 엣지 라우트 ───────────────────────────────────────────────────────── */
test('② 엣지 라우트 — 토큰 · bytes · 무작위 · 업로드 수신 시간 · 꺼짐 404 · 413', async () => {
  serve._resetServeForTest();
  assert.equal(serve.parseBytes('1048576'), MB);
  for (const bad of ['', '0', '-1', '1e6', '1.5', 'abc', String(serve.XFER_TEST_MAX_BYTES + 1), undefined, ['5']]) assert.equal(serve.parseBytes(bad), null, `${bad}`);
  const e = await listen(edgeApp());
  try {
    let r = await fetch(`${e.base}/api/collector/xfer-test?bytes=1024`);
    assert.equal(r.status, 403, '토큰 없음');
    r = await fetch(`${e.base}/api/collector/xfer-test?bytes=0`, { headers: { 'X-Collector-Token': 'edge-token-2735' } });
    assert.equal(r.status, 400);
    r = await fetch(`${e.base}/api/collector/xfer-test?bytes=${2 * MB}`, { headers: { 'X-Collector-Token': 'edge-token-2735' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), String(2 * MB));
    assert.match(r.headers.get('cache-control') || '', /no-transform/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, 2 * MB);
    // 무작위다 — 0 으로 채우면 WAN 가속기가 줄여 보내 속도가 부풀려진다. 압축되지 않아야 한다.
    const zeros = buf.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
    assert.ok(zeros < buf.length / 100, `0 바이트가 너무 많다(${zeros})`);
    const { gzipSync } = await import('node:zlib');
    assert.ok(gzipSync(buf).length > buf.length * 0.98, '무작위 데이터는 압축되지 않는다');

    const body = Buffer.alloc(MB, 7);
    r = await fetch(`${e.base}/api/collector/xfer-test?bytes=${MB}`, { method: 'POST', body, headers: { 'X-Collector-Token': 'edge-token-2735', 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.bytes, MB);
    assert.ok(j.recvMs == null || j.recvMs >= 0);
    assert.ok(j.node && typeof j.node === 'object');

    r = await fetch(`${e.base}/api/collector/xfer-test?bytes=1000`, { method: 'POST', body: Buffer.alloc(5000), headers: { 'X-Collector-Token': 'edge-token-2735' } });
    assert.equal(r.status, 413, '요청한 크기보다 많이 보내면 받지 않는다');

    process.env.XFER_TEST_ENABLED = 'false';
    r = await fetch(`${e.base}/api/collector/xfer-test?bytes=1024`, { headers: { 'X-Collector-Token': 'edge-token-2735' } });
    assert.equal(r.status, 404);
    assert.match((await r.json()).reason, /XFER_TEST_ENABLED/);
    delete process.env.XFER_TEST_ENABLED;
  } finally { await e.close(); }
});

test('② 엣지 라우트 — 동시 상한 2건(429)', async () => {
  serve._resetServeForTest();
  const e = await listen(edgeApp());
  const held = [];
  try {
    // 받지 않는(읽지 않는) 다운로드 2건이 백프레셔로 걸려 있는 동안 세 번째는 429 다.
    for (let i = 0; i < 2; i += 1) {
      held.push(await new Promise((resolve) => {
        const req = http.get(`${e.base}/api/collector/xfer-test?bytes=${32 * MB}`, { headers: { 'X-Collector-Token': 'edge-token-2735' } }, (res) => { res.pause(); resolve({ req, res }); });
      }));
    }
    const r = await fetch(`${e.base}/api/collector/xfer-test?bytes=1024`, { headers: { 'X-Collector-Token': 'edge-token-2735' } });
    assert.equal(r.status, 429);
  } finally {
    for (const h of held) { h.res.destroy(); h.req.destroy(); }
    await e.close();
    serve._resetServeForTest();
  }
});

/* ③ 측정기 ─────────────────────────────────────────────────────────── */
test('③ 측정기 — 실제 엣지 라우트로 ↓↑ · 행 모양 · 토큰은 등록부에서', async () => {
  serve._resetServeForTest();
  const e = await listen(edgeApp());
  try {
    const col = { id: 'edge-a', name: 'Edge A', url: `${e.base}/`, token: 'edge-token-2735' };
    const down = await probe.measureDown(col, { bytes: 2 * MB, timeoutMs: 15_000, fetchImpl: plainFetch });
    assert.equal(down.ok, true, JSON.stringify(down));
    assert.equal(down.dir, 'down');
    assert.equal(down.bytes, 2 * MB);
    assert.ok(down.mbps > 0);
    assert.equal(down.basis, 'receiver');
    assert.ok(down.ttfbMs >= 0 && down.totalMs >= down.ttfbMs);
    const up = await probe.measureUp(col, { bytes: 2 * MB, timeoutMs: 15_000, fetchImpl: plainFetch });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.dir, 'up');
    assert.equal(up.bytes, 2 * MB);
    assert.ok(up.mbps > 0);
    // 실제 경로(resilientFetch) — IP 리터럴 사내 주소는 lookup 이 불리지 않는다. 본문 스트림·POST Buffer 가 그대로 간다.
    const real = await probe.measureDown(col, { bytes: MB, timeoutMs: 15_000 });
    assert.equal(real.ok, true, JSON.stringify(real));
    const realUp = await probe.measureUp(col, { bytes: MB, timeoutMs: 15_000 });
    assert.equal(realUp.ok, true, JSON.stringify(realUp));

    const bad = await probe.measureDown({ ...col, token: 'wrong' }, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(bad.ok, false);
    assert.equal(bad.kind, 'auth');
    assert.equal(bad.mbps, null, '실패 측정의 속도는 0 이 아니라 null');
    const noUrl = await probe.measureUp({ id: 'x', url: '' }, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(noUrl.kind, 'no-url');

    process.env.XFER_TEST_ENABLED = 'false';
    const off = await probe.measureDown(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(off.kind, 'disabled', '엣지가 사유와 함께 404 → 꺼짐');
    delete process.env.XFER_TEST_ENABLED;
  } finally { await e.close(); }

  // 구버전 엣지 — 경로가 없어 express 기본 404(HTML).
  const old = await listen(express());
  try {
    const r = await probe.measureUp({ id: 'old', url: old.base, token: 't' }, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(r.kind, 'old-version');
    assert.match(r.error, new RegExp(probe.MIN_XFER_EDGE_VERSION.replace(/\./g, '\\.')));
  } finally { await old.close(); }
});

test('③ 측정기 — 전송 중 끊김(short) · 시한(timeout) · 버퍼링 프록시(sender-total)', async () => {
  const app = express();
  app.get('/api/collector/xfer-test', (req, res) => {
    if (req.query.mode === 'hang') return undefined;   // 응답하지 않는다
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(MB) });
    res.write(Buffer.alloc(MB / 2, 1));
    setTimeout(() => res.destroy(), 50);              // 절반만 보내고 끊는다
    return undefined;
  });
  app.post('/api/collector/xfer-test', (req, res) => {
    let got = 0;
    req.on('data', (c) => { got += c.length; });
    // 본문을 다 받은 척 1.3초 뒤에 답하면서 수신 구간은 아주 짧다고 말한다 — 앞단 프록시가 모았다가 넘긴 모양.
    req.on('end', () => setTimeout(() => res.json({ ok: true, bytes: got, recvMs: 2 }), 1300));
  });
  const e = await listen(app);
  try {
    const col = { id: 'x', url: e.base, token: 't' };
    const s = await probe.measureDown(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(s.ok, false);
    assert.equal(s.kind, 'short', JSON.stringify(s));
    assert.ok(s.bytes > 0 && s.bytes < MB);
    const h = await probe.measureDown({ ...col, url: `${e.base}/__dummy` }, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(h.ok, false);   // 경로 없음 → 구버전(404)
    const hang = await probe.measureDown(col, { bytes: MB, timeoutMs: 400, fetchImpl: (url, o) => plainFetch(`${url}&mode=hang`, o) });
    assert.equal(hang.kind, 'timeout');
    const up = await probe.measureUp(col, { bytes: MB, timeoutMs: 5_000, fetchImpl: plainFetch });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.basis, 'sender-total', '수신 구간이 전체의 25% 미만이고 1초를 넘으면 중앙 전체 시간으로 계산하고 밝힌다');
    assert.ok(up.xferMs >= 1000);
  } finally { await e.close(); }

  assert.equal(probe.mbpsOf(10 * MB, 1000), 83.89);
  assert.equal(probe.mbpsOf(10 * MB, 0), null);
  assert.equal(probe.mbpsOf(null, 1000), null);
  assert.equal(probe.errKind(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(probe.errKind(new Error('ECONNREFUSED')), 'unreachable');
});

/* ④ DB ─────────────────────────────────────────────────────────────── */
test('④ DB — 재적재 이중 계수 없음 · 최신은 더 늦은 ts 만 · 실패 연속 · NULL 속도 · 정리', async () => {
  db._resetForTest();
  const base = Date.UTC(2026, 9, 10, 3, 0, 0);   // KST 12:00
  const row = (dir, ts, ok, mbps, extra = {}) => ({ agent: 'Edge-A', dir, ts, ok, mbps: ok ? mbps : null, bytes: 10 * MB, xferMs: 100, totalMs: 200, ttfbMs: 50, basis: 'receiver', kind: ok ? null : 'timeout', error: ok ? '' : '시한', trig: 'timer', ...extra });
  let r = await db.insertSamples([row('down', base, true, 100), row('up', base + 1, true, 60)]);
  assert.deepEqual([r.ok, r.inserted, r.duplicates], [true, 2, 0]);
  r = await db.insertSamples([row('down', base, true, 100)]);
  assert.deepEqual([r.inserted, r.duplicates], [0, 1], '같은 ts 는 무시');
  r = await db.insertSamples([row('down', base + 30 * 60_000, false, null), row('down', base + 60 * 60_000, false, null)]);
  assert.equal(r.inserted, 2);
  // 더 이른 ts 의 늦게 도착한 성공이 최신값을 덮지 않는다.
  await db.insertSamples([row('down', base - 60_000, true, 999)]);
  const lat = await db.latestAll();
  const d = lat.find((x) => x.dir === 'down');
  assert.equal(d.ts, base + 60 * 60_000);
  assert.equal(d.ok, 0);
  assert.equal(d.mbps, null, '실패 행의 속도는 NULL');
  assert.equal(d.fail_streak, 2);
  assert.equal(d.last_ok_mbps, 100);
  const daily = await db.dailyOf('Edge-A', '2026-10-01');
  const dd = daily.find((x) => x.dir === 'down' && x.day === '2026-10-10');
  assert.equal(dd.n, 4, '하루 4건(성공 2 · 실패 2) — 재적재는 세지 않는다');
  assert.equal(dd.ok_n, 2);
  assert.equal(dd.mbps_sum, 1099);
  assert.equal(dd.mbps_min, 100);
  assert.equal(dd.mbps_max, 999);
  const since = await db.samplesSince(base - DAY, { agent: 'Edge-A' });
  assert.equal(since.rows.length, 5);
  assert.equal(since.truncated, false);
  const fails = await db.recentFailures(base - DAY, 10);
  assert.equal(fails.length, 2);
  const st = await db.dbStatus();
  assert.equal(st.available, true);
  assert.equal(st.firstTs, base - 60_000);
  assert.equal(fs.statSync(db.dbPath()).mode & 0o777, 0o600);
  const ex = await db.exportRows(base - DAY, { agent: 'Edge-A', limit: 2 });
  assert.equal(ex.rows.length, 2);
  assert.equal(ex.truncated, true);
  // 정리 — 원시는 기간 밖을, 일 요약은 그 기간 밖을 지운다. 최신값도 원시 보존 밖이면 지운다.
  const p = await db.pruneXferSpeed({ sampleDays: 1, dailyDays: 1, now: base + 3 * DAY });
  assert.equal(p.ok, true);
  assert.equal(p.sample, 5);
  assert.ok(p.daily >= 2);
  assert.equal((await db.latestAll()).length, 0);
});

/* ⑤ 판정 ───────────────────────────────────────────────────────────── */
test('⑤ 판정 — 상태 · 평소 대비 · KPI 항등식 · 히트맵 · 회선 산수', () => {
  const now = Date.UTC(2026, 9, 13, 3, 0, 0);
  const S = settings.normalizeSettings({ intervalMs: 30 * 60_000, slowPct: 70, excluded: ['Edge-X'] });
  const collectors = [
    { id: 'Edge-OK', name: 'OK', url: 'https://a', datacenter: 'Seoul' },
    { id: 'Edge-SLOW', name: 'SLOW', url: 'https://b' },
    { id: 'Edge-FAIL', name: 'FAIL', url: 'https://c' },
    { id: 'Edge-STALE', name: 'STALE', url: 'https://d' },
    { id: 'Edge-NEVER', name: 'NEVER', url: 'https://e' },
    { id: 'Edge-NOURL', name: 'NOURL', url: '' },
    { id: 'Edge-OFF', name: 'OFF', url: 'https://g', enabled: false },
    { id: 'Edge-X', name: 'X', url: 'https://h' },
  ];
  const L = (agent, dir, ts, ok, mbps, kind = null) => ({ agent, dir, ts, ok: ok ? 1 : 0, mbps: ok ? mbps : null, kind, fail_streak: ok ? 0 : 1 });
  const latest = [
    L('Edge-OK', 'down', now - 60_000, true, 100), L('Edge-OK', 'up', now - 60_000, true, 50),
    L('Edge-SLOW', 'down', now - 60_000, true, 30), L('Edge-SLOW', 'up', now - 60_000, true, 50),
    L('Edge-FAIL', 'down', now - 60_000, false, null, 'timeout'), L('Edge-FAIL', 'up', now - 60_000, true, 40),
    L('Edge-STALE', 'down', now - 3 * HOUR, true, 80), L('Edge-STALE', 'up', now - 3 * HOUR, true, 80),
    L('Edge-GONE', 'down', now - 60_000, true, 80),
  ];
  const recent = [];
  for (let i = 1; i <= 8; i += 1) {
    recent.push({ agent: 'Edge-OK', dir: 'down', ts: now - i * HOUR, ok: 1, mbps: 100 });
    recent.push({ agent: 'Edge-SLOW', dir: 'down', ts: now - i * HOUR, ok: 1, mbps: 100 });
    recent.push({ agent: 'Edge-SLOW', dir: 'up', ts: now - i * HOUR, ok: 1, mbps: 50 });
  }
  recent.push({ agent: 'Edge-SLOW', dir: 'down', ts: now - 2 * HOUR, ok: 0, mbps: null });   // 실패는 기준선에 0 으로 들어가지 않는다
  const rows = an.edgeRows({ collectors, latest, recent, settings: S, now });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['Edge-OK'].state, 'ok');
  assert.equal(by['Edge-OK'].down.vsPct, 100);
  assert.equal(by['Edge-OK'].reason, 'partial-baseline', '↑ 기준선이 없으면 그 사실을 남긴다(↓ 만 판정했다)');
  assert.equal(by['Edge-SLOW'].state, 'slow');
  assert.equal(by['Edge-SLOW'].vsPct, 30);
  assert.equal(by['Edge-SLOW'].down.baseline, 100);
  assert.equal(by['Edge-SLOW'].down.week.ok, 8);
  assert.equal(by['Edge-SLOW'].down.week.n, 9);
  assert.equal(by['Edge-FAIL'].state, 'fail');
  assert.equal(by['Edge-FAIL'].reason, 'timeout');
  assert.equal(by['Edge-STALE'].state, 'stale', '주기 30분 → 경계 max(90분, 2시간)');
  assert.equal(by['Edge-NEVER'].state, 'no-data');
  assert.equal(by['Edge-NEVER'].reason, 'never');
  assert.equal(by['Edge-NOURL'].reason, 'no-url');
  assert.equal(by['Edge-OFF'].reason, 'disabled-central');
  assert.equal(by['Edge-X'].state, 'excluded');
  assert.equal(by['Edge-GONE'].registered, false, '등록부에 없는 기록도 행으로 남긴다');
  assert.ok(by['Edge-OK'].down.spark.length >= 1);

  const k = an.kpisOf(rows);
  const sum = k.ok + k.slow + k.fail + k.stale + k['no-data'];
  assert.equal(sum, k.total, 'KPI 는 겹치지 않는다(제외는 합계 밖)');
  assert.equal(k.excluded, 1);
  assert.equal(k.slowest.id, 'Edge-SLOW');
  assert.equal(k.slowest.mbps, 30);

  // 표본이 6개 미만이면 평소 대비를 판정하지 않는다.
  const few = an.edgeRows({ collectors: [{ id: 'E', url: 'https://x' }], latest: [L('E', 'down', now, true, 10), L('E', 'up', now, true, 10)], recent: [{ agent: 'E', dir: 'down', ts: now - HOUR, ok: 1, mbps: 100 }], settings: S, now });
  assert.equal(few[0].state, 'ok');
  assert.equal(few[0].vsPct, null);
  assert.equal(few[0].reason, 'no-baseline');

  // 히트맵 — 칸은 그 엣지 중앙값 대비, 측정 없는 칸은 null(0 아님). 시각은 포탈 시각(기본 KST).
  const kst9 = Date.UTC(2026, 9, 13, 0, 0, 0);    // KST 09:00
  const kst21 = Date.UTC(2026, 9, 13, 12, 0, 0);  // KST 21:00
  const heat = an.heatOf([
    { agent: 'E', dir: 'down', ts: kst9, ok: 1, mbps: 50 }, { agent: 'E', dir: 'down', ts: kst21, ok: 1, mbps: 100 },
    { agent: 'E', dir: 'down', ts: kst21 + 60_000, ok: 1, mbps: 100 }, { agent: 'E', dir: 'down', ts: kst9 + 5, ok: 0, mbps: null },
  ], { offsetMin: 540 });
  const h = heat[0];
  assert.equal(h.median, 100);
  assert.equal(h.hours[9].ratio, 0.5);
  assert.equal(h.hours[21].ratio, 1);
  assert.equal(h.hours[3], null);
  assert.equal(an.localHour(kst9, 540), 9);

  const tr = an.trafficOf({ sizeMB: 10, intervalMs: 30 * 60_000 }, 28);
  assert.equal(tr.cyclesPerDay, 48);
  assert.equal(tr.bytesPerDayEdge, 10 * MB * 2 * 48);
  assert.equal(tr.bytesPerDayCentral, 10 * MB * 2 * 48 * 28);

  const ds = an.dailySeriesOf([{ dir: 'down', day: '2026-10-10', n: 4, ok_n: 0, mbps_sum: 0, mbps_min: null, mbps_max: null, ttfb_sum: 0, ttfb_n: 0 }]);
  assert.equal(ds.down[0].avg, null, '성공 0건 날의 평균은 0 이 아니라 null');
  assert.equal(an.staleMsOf(24 * HOUR), 72 * HOUR);
  assert.equal(an.statsOf([{ ok: 0, mbps: null }]).avg, null);
  // 성공인데 속도를 못 읽은 행·실패인데 값이 붙은 행은 속도 통계에 넣지 않는다(0 으로 세면 평균이 끌려 내려간다).
  const st = an.statsOf([{ ok: 1, mbps: null }, { ok: 1, mbps: 10 }, { ok: 0, mbps: 5 }]);
  assert.deepEqual([st.n, st.ok, st.avg, st.min], [3, 1, 10, 10]);
});

/* ⑥ 폴러 ───────────────────────────────────────────────────────────── */
test('⑥ 폴러 — 대상 선정 · 오래 안 잰 엣지 먼저 · 수동 실행도 같은 가드', async () => {
  const S = settings.normalizeSettings({ excluded: ['Edge-C'] });
  const cols = [
    { id: 'Edge-A', url: 'https://a' }, { id: 'Edge-B', url: '' }, { id: 'Edge-C', url: 'https://c' },
    { id: 'Edge-D', url: 'https://d', enabled: false }, { id: 'Edge-E', url: 'https://e' }, null, { id: '' },
  ];
  const { targets, skipped } = poller.xferTargets(cols, S);
  assert.deepEqual(targets.map((c) => c.id), ['Edge-A', 'Edge-E']);
  assert.deepEqual(skipped.map((x) => `${x.id}:${x.reason}`).sort(), ['Edge-B:no-url', 'Edge-C:excluded', 'Edge-D:disabled-central']);
  const only = poller.xferTargets(cols, S, { only: 'edge-c' });
  assert.deepEqual(only.targets.map((c) => c.id), ['Edge-C'], '사람이 고른 엣지는 제외 목록을 무시한다');
  const ordered = poller.orderTargets(targets, [{ agent: 'edge-a', ts: 2000 }, { agent: 'Edge-E', ts: 1000 }]);
  assert.deepEqual(ordered.map((c) => c.id), ['Edge-E', 'Edge-A']);

  poller._resetXferPollerForTest();
  // 등록부가 비어 있으면 대상 0 으로 한 주기를 끝내고 기록을 남긴다(꺼져 있어도 수동은 돈다).
  const r = await poller.runXferCycle({ trigger: 'manual' });
  assert.equal(r.ok, true);
  assert.equal(r.targets, 0);
  const st = poller.xferSpeedStatus();
  assert.equal(st.running, false);
  assert.equal(st.last.trigger, 'manual');
  const t = await poller.runXferCycle({ trigger: 'timer' });
  assert.equal(t.skipped, 'disabled', '꺼져 있으면 주기 측정은 건너뛴다');
});

/* ⑦ 실제 api 라우터 ───────────────────────────────────────────────────── */
test('⑦ 실제 api 라우터 — admin 200 · operator·범위 계정 403 · CSV data.csv · 토큰 미노출', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferspeed2735-api-'));
  fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'Edge-Seoul', name: 'Edge Seoul', url: 'https://10.20.0.5:4000/x?token=leak', token: 'SECRET-COLLECTOR-TOKEN', enabled: true, datacenter: 'Seoul' }] }));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const users = {
      admin: { username: 'a', role: 'admin', scope: null },
      operator: { username: 'o', role: 'operator', scope: null },
      scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } },
    };
    const out = {};
    for (const [label, user] of Object.entries(users)) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api', api);
      const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const b = 'http://127.0.0.1:' + srv.address().port + '/api/tools/xfer-speed';
      const main = await fetch(b);
      const text = await main.text();
      const csv = await fetch(b + '/export.csv');
      const heat = await fetch(b + '/heat?days=7');
      const hist = await fetch(b + '/history?agent=edge-seoul&days=7');
      const unknown = await fetch(b + '/history?agent=nope');
      const put = await fetch(b + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sizeMB: 5 }) });
      const putBad = await fetch(b + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedules: [{ kind: 'weekly', time: '09:00', days: [] }] }) });
      let pb = null; try { pb = await putBad.json(); } catch {}
      let j = null; try { j = JSON.parse(text); } catch {}
      out[label] = { main: main.status, csv: csv.status, csvType: csv.headers.get('content-type'), heat: heat.status, hist: hist.status, unknown: unknown.status, put: put.status, putBad: putBad.status, putBadField: pb?.errors?.[0]?.field ?? null, putBadReason: pb?.reason ?? null,
        rules: j?.scheduleRules ?? null, statusNext: j?.status ? ('next' in j.status) : null,
        leak: text.includes('SECRET-COLLECTOR-TOKEN') || text.includes('token=leak'), origin: j?.rows?.[0]?.origin ?? null, state: j?.rows?.[0]?.state ?? null,
        kpiTotal: j?.kpis?.total ?? null, traffic: j?.traffic?.targets ?? null, failKinds: j?.failKinds ?? null, enabled: j?.enabled ?? null };
      srv.close();
    }
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
  const out = JSON.parse(line.slice(2));
  assert.equal(out.admin.main, 200);
  assert.equal(out.admin.leak, false, '응답에 토큰·URL 경로가 없어야 한다');
  assert.equal(out.admin.origin, 'https://10.20.0.5:4000', '주소는 origin 만');
  assert.equal(out.admin.state, 'no-data');
  assert.equal(out.admin.kpiTotal, 1);
  assert.equal(out.admin.traffic, 1);
  assert.equal(out.admin.enabled, false);
  assert.equal(out.admin.csv, 200);
  assert.match(out.admin.csvType || '', /text\/csv/);
  assert.equal(out.admin.heat, 200);
  assert.equal(out.admin.hist, 200, '대소문자 무시로 엣지를 찾는다');
  assert.equal(out.admin.unknown, 404);
  assert.equal(out.admin.put, 200);
  assert.equal(out.admin.putBad, 400, '잘못된 예약은 400 — 고치지 않고 돌려준다');
  assert.equal(out.admin.putBadField, 'days');
  assert.match(out.admin.putBadReason || '', /예약 1/);
  assert.deepEqual(out.admin.rules?.kinds, ['once', 'daily', 'weekly', 'monthly']);
  assert.equal(out.admin.statusNext, true, '상태에 다음 실행 예정이 실린다');
  assert.deepEqual(out.admin.failKinds, [...probe.XFER_FAIL_KINDS]);
  for (const k of ['main', 'csv', 'heat', 'hist', 'put', 'putBad']) {
    assert.equal(out.operator[k], 403, `operator ${k}`);
    assert.equal(out.scoped[k], 403, `범위 계정 ${k}`);
  }
});

/* ⑧ 웹 문구 1:1 ───────────────────────────────────────────────────── */
test('⑧ 웹 문구와 1:1 — 실패 종류 · 상태 · 사유', async () => {
  const p = path.join(WEB, 'views/tools/xferSpeedText.js');
  assert.ok(fs.existsSync(p), '웹 문구 모듈이 있어야 한다');
  const w = await import(p);
  assert.deepEqual(Object.keys(w.FAIL_TEXT).sort(), [...probe.XFER_FAIL_KINDS].sort(), '실패 종류 ↔ 웹 문구');
  assert.deepEqual(Object.keys(w.STATE_TEXT).sort(), [...an.STATES].sort(), '상태 ↔ 웹 문구');
  for (const code of ['excluded', 'unregistered', 'disabled-central', 'no-url', 'never', 'old', 'below-baseline', 'no-baseline', 'partial-baseline']) {
    assert.ok(w.REASON_TEXT[code], `사유 ${code} 문구`);
  }
  const src = fs.readFileSync(path.join(SRC, 'xferspeed/analyze.js'), 'utf8');
  for (const m of src.matchAll(/reason = '([a-z-]+)'/g)) assert.ok(w.REASON_TEXT[m[1]], `analyze 의 사유 ${m[1]} 문구`);
});
