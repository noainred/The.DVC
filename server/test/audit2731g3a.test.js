// v2.731 r1 G3a — A2-01 VM 가용성 측정 끝 · A2-03 서버 온도 ESXi 대체 행의 낡은 온도.
//
// A2-01: 가용성 측정 구간의 끝이 언제나 '지금' 이라, 이벤트 수집이 멈춘 vCenter 의 '수집 안 된 꼬리 구간' 을
//   '정지 이벤트 없음 = 가동' 으로 셌다. 측정 끝 = 그 vCenter 의 이벤트가 온전한 마지막 시각(로그 폴러의 마지막 수집 성공 ·
//   기록이 없으면 마지막으로 받은 이벤트 시각)이고, 지금과의 차이가 허용치를 넘을 때만 자른다.
// A2-03: '서버 온도' 의 ESXi 대체 행이 읽히지 않는 vCenter(unreachable·점검중·낡은 위임 — metrics/sampler.js
//   unreadVcenterReasons)의 직전 온도를 stale:false 로 요약·법인 표·클러스터/vCenter 집계에 넣었다.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g3a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';   // 로그 폴러 시험은 가짜 SOAP vCenter 로 실수집 경로를 탄다(라우트 시험은 자식 프로세스 · mock)
const TMP_DIRS = [TMP];
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

const { analyzeAvailability } = await import('../src/availability/analyze.js');
const { buildServerTempReport } = await import('../src/tools/serverTemp.js');

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;   // 정시 -30분(경계에서 떨어뜨린 고정 시각)
const ev = (vm, ts, type, user = '') => ({ vcenterId: 'vc1', entity: vm, ts, type, user });
const vm = (name, powerState = 'POWERED_ON') => ({ id: `vc1:${name}`, name, vcenterId: 'vc1', cluster: 'C1', powerState });
const SERVER_DIR = path.resolve(new URL('..', import.meta.url).pathname);

// ── A2-01 · analyzeAvailability ─────────────────────────────────────────────
test('A2-01 ① 이벤트 수집이 10일 전에 멈춘 vCenter — 측정 끝을 그 시각으로 자르고 그 사실을 싣는다', () => {
  const cov = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 10 * DAY });   // 수집 성공 기록 없음 → 마지막 이벤트 시각
  const rows = [ev('a', NOW - 12 * DAY, 'VmPoweredOffEvent', 'admin@corp')];
  const r = analyzeAvailability(rows, [vm('a'), vm('b')], { days: 30, now: NOW, coverageOf: cov });
  const v = r.vcenters[0];
  assert.equal(v.tailCut, true, '수집이 멈춘 vCenter 는 측정 끝이 잘려야 한다');
  assert.equal(v.measuredUntil, NOW - 10 * DAY);
  assert.equal(v.untilSource, 'last-event');
  // a 는 12일 전에 꺼졌고 그 뒤 10일 전까지 켬 기록이 없다(이벤트는 그때까지 온전) — 2일 정지가 측정된다.
  const a = r.vms.find((x) => x.name === 'a');
  assert.ok(a, '정지가 있는 VM 은 목록에 있어야 한다(예전: 켬 이벤트 누락으로 판정 제외)');
  assert.equal(a.downMs, 2 * DAY);
  assert.equal(a.windowTo, NOW - 10 * DAY);
  assert.equal(a.tailCut, true);
  assert.equal(a.availability, 90, '측정 구간 20일(기간 시작 ~ 수집 멈춤) 중 2일 정지');
  // b 는 정지 기록이 없다 — 꼬리 10일을 가동으로 세지 않는다(전체 합산 = 2일 ÷ 40일).
  assert.equal(r.totals.availability, 95);
  assert.equal(r.coverage.staleTail, 2);
  assert.equal(r.coverage.tailVcenters, 1);
  assert.equal(r.coverage.tailMaxAgeMs, 10 * DAY);
  assert.equal(r.coverage.tailFromLastEvent, 1);
  assert.equal(r.coverage.inconsistent, 0);
});

test('A2-01 ② 수집은 정상인데 조용한 vCenter(마지막 이벤트가 오래됨) — 수집 성공 시각이 있으면 자르지 않는다', () => {
  const cov = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 10 * DAY, okAt: NOW - 5 * 60_000 });
  const r = analyzeAvailability([], [vm('b')], { days: 30, now: NOW, coverageOf: cov });
  const v = r.vcenters[0];
  assert.equal(v.tailCut, false);
  assert.equal(v.measuredUntil, null);
  assert.equal(v.untilSource, 'collect');
  assert.equal(r.coverage.staleTail, 0);
  assert.equal(r.coverage.measured, 1);
});

test('A2-01 ③ 수집 성공이 3일 전에 멈춤 — 끝 = 수집 성공 시각(마지막 이벤트보다 늦으면 그것)', () => {
  const cov = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 4 * DAY, okAt: NOW - 3 * DAY });
  const rows = [ev('a', NOW - 3.5 * DAY, 'VmPoweredOffEvent')];
  const r = analyzeAvailability(rows, [vm('a')], { days: 30, now: NOW, coverageOf: cov });
  const v = r.vcenters[0];
  assert.equal(v.measuredUntil, NOW - 3 * DAY);
  assert.equal(v.untilSource, 'collect');
  const a = r.vms.find((x) => x.name === 'a');
  assert.equal(a.downMs, 0.5 * DAY, '꺼진 뒤 수집이 멈춘 시각까지만 정지로 센다(지금까지가 아니다)');
  assert.equal(a.availability, Math.round((100 - (0.5 / 27) * 100) * 1000) / 1000);
  assert.equal(r.coverage.tailFromLastEvent, 0);
});

test('A2-01 ④ 수집이 기간 시작 전에 멈춤 — 측정 구간이 없으니 판정하지 않는다(시계 어긋남으로 세지 않는다)', () => {
  const cov = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 40 * DAY });
  const r = analyzeAvailability([], [vm('b')], { days: 30, now: NOW, coverageOf: cov });
  assert.equal(r.coverage.measured, 0, '예전: 기간 내내 가동 100% 로 셌다');
  assert.equal(r.coverage.stoppedEarly, 1);
  assert.equal(r.coverage.clockSkew, 0);
  assert.equal(r.vcenters[0].availability, null);
  assert.equal(r.totals.availability, null);
});

test('A2-01 ⑤ 허용치 안의 차이는 자르지 않는다 · 허용치는 인자로 받는다', () => {
  const cov = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW - 50 * 60_000 });
  const r = analyzeAvailability([], [vm('b')], { days: 30, now: NOW, coverageOf: cov });
  assert.equal(r.vcenters[0].tailCut, false, '기본 허용치(1시간) 안이다');
  const r2 = analyzeAvailability([], [vm('b')], { days: 30, now: NOW, coverageOf: cov, tailToleranceMs: 30 * 60_000 });
  assert.equal(r2.vcenters[0].tailCut, true);
  assert.equal(r2.vcenters[0].measuredUntil, NOW - 50 * 60_000);
  // 정상 수집 vCenter(마지막 이벤트 = 지금)는 예전과 같다.
  const full = analyzeAvailability([], [vm('b')], { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW }) });
  assert.equal(full.vcenters[0].tailCut, false);
  assert.equal(full.coverage.measured, 1);
});

// ── A2-01 · 로그 폴러가 vCenter 별 '이벤트가 온전한 시각' 을 남긴다 ─────────────
function fakeVcenter() {
  const state = { events: [], served: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') { state.served = 0; return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>'); }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.events.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="UserLoginSessionEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>u</userName><fullFormattedMessage>login</fullFormattedMessage></returnval>`).join('');
        return send(`<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}

test('A2-01 ⑥ 로그 폴러 — 수집 성공 시각을 남기고(상한에 걸리면 마지막으로 읽은 이벤트 시각), 실패는 그 값을 바꾸지 않는다', async () => {
  const warn = mock.method(console, 'warn', () => {});
  const log = mock.method(console, 'log', () => {});
  const { srv, state } = fakeVcenter();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcx', name: 'vcx', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000 }] }));
    const { saveLogSettings } = await import('../src/logs/settings.js');
    saveLogSettings({ enabled: true, maxPerPoll: 100, minSeverity: 'info' });
    const P = await import('../src/logs/poller.js');
    assert.equal(typeof P.logCollectOkAt, 'function', '로그 폴러가 vCenter 별 수집 성공 시각을 내놓아야 한다');
    assert.equal(P.logCollectOkAt('vcx'), null, '수집 전에는 기록이 없다');
    // (1) 상한(100건)에 걸린 수집 — 100번째 이벤트까지만 온전하다.
    const base = Date.now() - 10 * H;
    state.events = Array.from({ length: 150 }, (_, i) => ({ key: `k${i}`, ts: base + i * 60_000 }));
    await P.pollLogsOnce({ manual: true });
    assert.equal(P.logCollectOkAt('vcx'), base + 99 * 60_000, '상한에 걸리면 수집 시작 시각이 아니라 마지막으로 읽은 이벤트 시각');
    assert.equal(P.logCollectOk('vcx').capped, true);
    // (2) 상한에 걸리지 않은 수집 — 수집을 시작한 시각까지 온전하다.
    state.events = [];
    const t1 = Date.now();
    await P.pollLogsOnce({ manual: true });
    const ok2 = P.logCollectOkAt('vcx');
    assert.ok(ok2 >= t1 && ok2 <= Date.now(), `수집 시작 시각이어야 한다: ${ok2 - t1}`);
    assert.equal(P.logCollectOk('vcx').capped, false);
    // (3) 실패 — 기록을 바꾸지 않는다(멈춘 수집이 '방금 성공' 으로 보이지 않게).
    await new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
    await P.pollLogsOnce({ manual: true });
    assert.equal(P.logCollectOkAt('vcx'), ok2);
  } finally { warn.mock.restore(); log.mock.restore(); try { srv.close(); } catch { /* */ } }
});

// ── 라우트(자식 프로세스 · mock) ──────────────────────────────────────────────
function runChild(script) {
  return import('node:child_process').then(({ spawnSync }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2731g3a-rt-'));
    TMP_DIRS.push(dir);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
      encoding: 'utf8', cwd: SERVER_DIR, timeout: 150_000,
    });
    assert.equal(r.status, 0, `자식 프로세스 실패: ${String(r.stderr).slice(-1200)}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
    assert.ok(line, r.stdout.slice(-400));
    return JSON.parse(line.slice(2));
  });
}
const SERVE = `
  const express = (await import('express')).default;
  const { api } = await import('./src/routes/api.js');
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const get = async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch {} return { status: r.status, b }; };
`;

test('A2-01 ⑦ 라우트 — 수집 성공 기록이 없으면 마지막 이벤트 시각으로 자르고, 폴러가 성공하면 그 시각을 쓴다', async () => {
  const o = await runChild(`
    console.log = () => {}; console.warn = () => {};
    const { store } = await import('./src/store.js');
    await store.refresh({ force: true });
    const snap = store.get();
    const vc = snap.vcenters[0].id;
    const { getLogsDb } = await import('./src/logs/db.js');
    const db = await getLogsDb();
    const now = Date.now(); const DAY = 86400000;
    db.insertMany([
      { vcenterId: vc, key: 'g3a-0', ts: now - 20 * DAY, severity: 'info', type: 'UserLoginSessionEvent', user: 'u', entity: '', message: 'm', detail: null },
      { vcenterId: vc, key: 'g3a-1', ts: now - 10 * DAY, severity: 'info', type: 'UserLoginSessionEvent', user: 'u', entity: '', message: 'm', detail: null },
    ]);
    ${SERVE}
    const before = await get('/api/tools/vm-availability?vcenterId=' + encodeURIComponent(vc) + '&days=30');
    const { pollLogsOnce } = await import('./src/logs/poller.js');
    await pollLogsOnce({ manual: true });
    const after = await get('/api/tools/vm-availability?vcenterId=' + encodeURIComponent(vc) + '&days=30&target=99.5');
    srv.close();
    process.stdout.write('@@' + JSON.stringify({ now, before, after }) + '\\n');
    process.exit(0);
  `);
  assert.equal(o.before.status, 200);
  const v1 = o.before.b.vcenters[0];
  assert.equal(v1.tailCut, true, '수집이 10일 전에 멈춘 것으로 보이는 vCenter — 꼬리를 가동으로 세지 않는다');
  assert.equal(v1.untilSource, 'last-event');
  assert.ok(Math.abs(v1.measuredUntil - (o.now - 10 * DAY)) < 1000);
  assert.ok(o.before.b.coverage.staleTail >= 1);
  assert.ok(o.before.b.tailToleranceMs >= H, '허용치를 응답에 싣는다');
  assert.equal(o.after.status, 200);
  const v2 = o.after.b.vcenters[0];
  assert.equal(v2.untilSource, 'collect', '라우트가 로그 폴러의 수집 성공 시각을 넘겨야 한다');
  assert.equal(v2.tailCut, false);
});

// ── A2-03 · 서버 온도 ESXi 대체 행 ───────────────────────────────────────────
test('A2-03 ① 읽히지 않는 vCenter 의 ESXi 대체 행은 stale(사유 포함) — 요약·법인 표에서 빠지고 개수로 밝힌다', () => {
  const hosts = [
    { id: 'vc-a:h1', vcenterId: 'vc-a', name: 'esx-a1', cluster: 'c1', tempC: 24, tempMaxC: 30, temps: [] },
    { id: 'vc-b:h1', vcenterId: 'vc-b', name: 'esx-b1', cluster: 'c2', tempC: 41, tempMaxC: 48, temps: [] },
  ];
  const rep = buildServerTempReport({ idracServers: [], hosts, unreadVcenters: new Map([['vc-b', 'unreachable']]) });
  const b = rep.rows.find((r) => r.id === 'vc-b:h1');
  const a = rep.rows.find((r) => r.id === 'vc-a:h1');
  assert.equal(b.stale, true, '직전 온도를 현재값으로 보이지 않는다');
  assert.equal(b.staleReason, 'unreachable');
  assert.equal(b.curC, 41, '행(표)에는 마지막 값을 남긴다(오래됨 표지와 함께)');
  assert.equal(a.stale, false);
  assert.equal(rep.summary.all.staleExcluded, 1);
  assert.equal(rep.summary.all.reporting, 1);
  assert.equal(rep.summary.all.avgC, 24);
  assert.equal(rep.summary.all.curMaxC, 24);
  assert.equal(rep.counts.stale, 1);
  const dcB = rep.byDatacenter.find((d) => d.key === 'vc-b');
  assert.equal(dcB.all.avgC, null, '법인 표에서도 뺀다');
  assert.equal(dcB.all.staleExcluded, 1);
  // 인자를 안 주면 예전 그대로(구버전 호출 호환)
  const old = buildServerTempReport({ idracServers: [], hosts });
  assert.equal(old.rows.every((r) => r.stale === false), true);
});

test('A2-03 ② 라우트 — unreachable vCenter 의 호스트는 행·호스트 목록이 오래됨이고 클러스터·vCenter 집계 현재값에서 빠진다', async () => {
  const o = await runChild(`
    console.log = () => {}; console.warn = () => {};
    const { store } = await import('./src/store.js');
    await store.refresh({ force: true });
    const snap = store.get();
    const withTemp = (id) => (snap.hosts || []).filter((h) => h.vcenterId === id && h.tempC != null).length;
    const vcB = snap.vcenters.map((v) => v.id).find((id) => withTemp(id) > 0);
    const vcA = snap.vcenters.map((v) => v.id).find((id) => id !== vcB && withTemp(id) > 0);
    snap.vcenters.find((v) => v.id === vcB).status = 'unreachable';
    ${SERVE}
    const r = await get('/api/tools/esxi-temp');
    srv.close();
    process.stdout.write('@@' + JSON.stringify({ vcA, vcB, nB: withTemp(vcB), r }) + '\\n');
    process.exit(0);
  `);
  assert.equal(o.r.status, 200);
  const body = o.r.b;
  const rowsB = body.idrac.rows.filter((r) => r.source === 'esxi' && r.vcenterId === o.vcB);
  const rowsA = body.idrac.rows.filter((r) => r.source === 'esxi' && r.vcenterId === o.vcA);
  assert.ok(rowsB.length > 0 && rowsA.length > 0, `ESXi 대체 행이 있어야 한다 B=${rowsB.length} A=${rowsA.length}`);
  assert.equal(rowsB.every((r) => r.stale === true && r.staleReason === 'unreachable'), true, '읽히지 않는 vCenter 의 행은 오래됨');
  assert.equal(rowsA.every((r) => r.stale === false), true);
  assert.ok(body.idrac.summary.all.staleExcluded >= rowsB.length);
  const hostsB = body.hosts.filter((h) => h.vcenterId === o.vcB);
  assert.equal(hostsB.length, o.nB);
  assert.equal(hostsB.every((h) => h.stale === true && h.staleReason === 'unreachable'), true);
  assert.equal(body.hosts.filter((h) => h.vcenterId === o.vcA).every((h) => !h.stale), true);
  const vcRowB = body.vcenters.find((g) => g.key === o.vcB);
  assert.equal(vcRowB.curC, null, 'vCenter 집계의 현재값에 낡은 온도를 넣지 않는다');
  assert.equal(vcRowB.staleHosts, o.nB);
  assert.ok(Number.isFinite(body.vcenters.find((g) => g.key === o.vcA).curC));
  for (const c of body.clusters.filter((g) => String(g.key).startsWith(`${o.vcB}|`))) assert.equal(c.curC, null);
  assert.equal(body.staleHosts, o.nB);
  // 정렬: 현재값이 없는 묶음은 뒤로
  const idx = body.vcenters.findIndex((g) => g.key === o.vcB);
  assert.equal(body.vcenters.slice(idx).every((g) => g.curC == null), true);
});
