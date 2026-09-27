/**
 * test/audit2628b.test.js — v2.628 감사 엣지 축 확정분(EDGE2628-02~05) 회귀.
 *
 *  ① EDGE2628-02 보존 정리는 수집이 꺼져 있어도 폴러 틱마다(스로틀) 돈다 — 첫 틱에는 돌지 않는다(v2.453)
 *  ② EDGE2628-02 대상 0대 경로도 누적 카운터(_prev)·인증 정지 기록을 정리한다
 *  ③ EDGE2628-03 분류 실패는 '대상 0대' 가 아니라 실패 주기다 — _last.error·sourceErrors 에 남는다
 *  ④ EDGE2628-03 등록부 손상은 sourceErrors 로 밝힌다(no-idrac 로만 보이지 않게)
 *  ⑤ EDGE2628-04 404 는 ok:false · 사본이 있으면 keptCopy:true + '계속 적용' 문구(로컬 설정을 쓴다고 거짓말하지 않는다)
 *  ⑥ EDGE2628-04 CENTRAL_URL 없음 + 사본 잔존 → staleCopy:true
 *  ⑦ EDGE2628-05 svcmon 두 폴러의 주기 env 상한(2^31-1 초과가 1ms 루프가 되지 않는다)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2628b-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.BMUSAGE_ENABLED;
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let P; let S; let DB; let config;
const writeSettings = (obj) => { fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify(obj)); S._resetForTest(); };

before(async () => {
  ({ config } = await import('../src/config.js'));
  S = await import('../src/bmusage/settings.js');
  DB = await import('../src/bmusage/db.js');
  P = await import('../src/bmusage/poller.js');
});
after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

test('① EDGE2628-02: 수집이 꺼져 있어도 폴러 틱이 보존 정리를 집행한다(첫 틱은 아니다)', async () => {
  writeSettings({ enabled: true, rawRetentionDays: 7 });
  const old = Date.now() - 30 * 86_400_000;
  const r = await DB.insertUsage([{ key: 'k-old', ts: old, name: 'old', cpu_pct: 10 }, { key: 'k-new', ts: Date.now(), name: 'new', cpu_pct: 20 }], '');
  assert.equal(r.inserted, 2, JSON.stringify(r));
  writeSettings({ enabled: false, rawRetentionDays: 7 });   // 꺼짐(중앙 배포로 끈 경우와 같다)
  P._resetForTest();
  await P.bmUsageTimerTick();
  let h = await DB.usageHistory('k-old', { hours: 24 * 60 });
  assert.equal(h.rows.length, 1, '기동 첫 틱에 정리하면 안 된다(v2.453)');
  for (let i = 1; i < 12; i++) await P.bmUsageTimerTick();
  h = await DB.usageHistory('k-old', { hours: 24 * 60 });
  assert.equal(h.rows.length, 0, '꺼진 상태에서도 보존일이 지난 원시 행이 지워져야 한다');
  const n = await DB.usageHistory('k-new', { hours: 24 });
  assert.equal(n.rows.length, 1, '보존 안의 행은 남는다');
  assert.ok(P.bmUsageStatus().lastPrune?.ok, JSON.stringify(P.bmUsageStatus().lastPrune));
});

test('② EDGE2628-02: 대상 0대 주기도 누적 카운터·인증 정지 기록을 정리한다', async () => {
  writeSettings({ enabled: true });
  P._resetForTest();
  P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [] }));
  P._seedStateForTest({ prev: ['srv-a', 'srv-b'], authStopped: ['srv-a', 'srv-a|idrac'] });
  assert.equal(P.bmUsageStatus().prevKeys, 2);
  const r = await P.pollBmUsageOnce({ trigger: 'auto' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.servers, 0);
  assert.equal(P.bmUsageStatus().prevKeys, 0, '0대 경로가 _prev 를 남겼다');
  assert.equal(P.bmUsageStatus().authStopCount, 0, '0대 경로가 인증 정지 기록을 남겼다');
  P._setFleetForTest(null);
});

test('③ EDGE2628-03: 분류 실패는 대상 0대가 아니라 실패 주기다', async () => {
  writeSettings({ enabled: true });
  P._resetForTest();
  P._setFleetForTest(async () => { throw new Error('fleet-assign 손상'); });
  P._seedStateForTest({ prev: ['srv-x'] });
  const r = await P.pollBmUsageOnce({ trigger: 'auto' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(!/대상 서버가 없습니다/.test(r.reason || ''), r.reason);
  assert.match(r.reason, /fleet-assign 손상/);
  const last = P.bmUsageStatus().last;
  assert.ok(last.error, JSON.stringify(last));
  assert.ok(Array.isArray(last.sourceErrors) && last.sourceErrors.some((e) => e.source === 'classify'), JSON.stringify(last));
  assert.equal(P.bmUsageStatus().prevKeys, 1, '분류 실패로 누적 카운터를 지우면 안 된다(대상을 모른다)');
  P._setFleetForTest(null);
});

test('④ EDGE2628-03: iDRAC 등록부 손상은 sourceErrors 로 밝힌다', async () => {
  writeSettings({ enabled: true });
  P._resetForTest();
  P._setFleetForTest(async () => ({ bareMetal: [], virtualizationHosts: [] }));
  fs.writeFileSync(path.join(DIR, 'idrac.json'), '{ 손상');
  const tg = await P.currentTargets();
  assert.ok(tg.sourceErrors.some((e) => e.source === 'idrac-registry'), JSON.stringify(tg.sourceErrors));
  // 재시작 뒤(원본 없음 + 보존본만) 에도 밝힌다
  const tg2 = await P.currentTargets();
  assert.ok(tg2.sourceErrors.some((e) => e.source === 'idrac-registry'), JSON.stringify(tg2.sourceErrors));
  const r = await P.pollBmUsageOnce({ trigger: 'auto' });
  assert.ok(P.bmUsageStatus().last.sourceErrors?.length, JSON.stringify(r));
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('idrac.json')) fs.rmSync(path.join(DIR, f));
  P._setFleetForTest(null);
});

test('⑤ EDGE2628-04: 404 는 ok:false · 사본이 있으면 keptCopy + 계속 적용 문구', async () => {
  const pull = await import('../src/agent/bmUsageConfigPull.js');
  let html = false;
  const srv = http.createServer((req, res) => {
    if (html) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<pre>Cannot GET /api/central/bmusage-config</pre>'); return; }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'central 비활성화' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`;
    config.agent.centralToken = 'tok-2628';
    config.agent.name = 'Edge-2628';
    S.applyCentralBmUsage({ settings: { enabled: true, intervalMs: 300_000 }, sig: 'sig-a' });
    assert.equal(S.bmUsageCentralState().managed, true);
    const r = await pull.pullBmUsageConfigNow();
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.keptCopy, true, JSON.stringify(r));
    assert.ok(!/엣지 로컬 설정 사용/.test(r.note), `사본이 적용 중인데 로컬 설정을 쓴다고 말한다: ${r.note}`);
    assert.match(r.note, /계속 적용/);
    assert.equal(S.bmUsageCentralState().managed, true, '404 는 사본을 지우지 않는다(설계 유지)');
    // 구버전 중앙(HTML 404 = no-endpoint)도 ok:false
    S.clearCentralBmUsage();
    html = true;
    const r2 = await pull.pullBmUsageConfigNow();
    assert.equal(r2.kind, 'no-endpoint', JSON.stringify(r2));
    assert.equal(r2.ok, false, JSON.stringify(r2));
    assert.equal(r2.keptCopy, false);
    assert.match(r2.note, /엣지 로컬 설정 사용/);
  } finally { srv.close(); }
});

test('⑥ EDGE2628-04: CENTRAL_URL 없음 + 사본 잔존 → staleCopy:true', async () => {
  const pull = await import('../src/agent/bmUsageConfigPull.js');
  config.agent.centralUrl = '';
  config.agent.centralToken = '';
  S.applyCentralBmUsage({ settings: { enabled: true, intervalMs: 300_000 }, sig: 'sig-b' });
  const st = pull.bmUsageConfigPullStatus();
  assert.equal(st.configured, false);
  assert.equal(st.last.staleCopy, true, JSON.stringify(st));
  assert.equal(st.last.ok, false);
  S.clearCentralBmUsage();
  const st2 = pull.bmUsageConfigPullStatus();
  assert.equal(st2.last.staleCopy, false, JSON.stringify(st2));
});

test('⑦ EDGE2628-05: svcmon 주기 env 는 타이머 상한을 넘지 않는다', () => {
  const code = `
    const { pollerStats } = await import('./src/svcmon/poller.js');
    const { silenceStatus } = await import('./src/central/svcmonSilence.js');
    console.log(JSON.stringify({ a: pollerStats().tickMs, b: silenceStatus().tickMs }));
    process.exit(0);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: SERVER_DIR, encoding: 'utf8',
    env: { ...process.env, CONFIG_DIR: DIR, SVCMON_TICK_MS: '3000000000', SVCMON_SILENCE_TICK_MS: '9e12' },
  });
  const j = JSON.parse(out.trim().split('\n').pop());
  const MAX = 2_147_483_647;
  assert.ok(j.a >= 1000 && j.a <= MAX, `svcmon tick ${j.a}`);
  assert.ok(j.b >= 15_000 && j.b <= MAX, `silence tick ${j.b}`);
});
