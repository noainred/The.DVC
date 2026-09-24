/**
 * v2.605 감사 그룹 b — 인가·범위·SAN 점검 화면·페이지 인자.
 *   AUTHZ2605-01 범위 제한 admin 의 설정 PUT 왕복이 범위 밖 설정·vmperf DB 파일을 지웠다
 *   AUTHZ2605-02 전 법인 수동 실행(guest-disk·off-check·vm-track·Horizon)이 범위 계정에 열려 있었다
 *   AUTHZ2605-03 SAN 사용량 빈 상태 진단(diag.facts.error)이 비-admin 에 관리 IP 원문을 줬다
 *   AUTHZ2605-04 maskSnapAddress 가 sections 를 가리지 않았고 /zoning·/healthcheck/history 이름=IP 미가림
 *   LEFT2605-05 + RECENT2605-01(bmusage) hostsUnread 응답 노출 + 보류 시한
 *   LEFT2605-07 소수 limit → SQLite datatype mismatch
 *   WEB2605-04/07 checkPorts errHeld·slotPort (웹 판정은 web/src/views/tools/sanHealthText.test.js)
 *
 * ⚠ AUTHZ 는 v2.536 하니스와 같다 — **실제 `api` 라우터를 express 에 마운트하고 상태로** 본다(소스 grep 아님).
 *   자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
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

/** 자식 프로세스에서 실제 api 라우터를 띄우고 body(스크립트 본문)를 돌린다. `@@` 줄의 JSON 을 돌려준다. */
function runChild(body, { env = {}, setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2605b-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
    const app = express(); app.use(express.json({ limit: '5mb' }));
    const USERS = {
      full: { username: 'full', role: 'admin', scope: null },
      sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'], regions: [], writeVcenters: [] } },
      op: { username: 'op', role: 'operator', scope: null },
    };
    app.use((req, _r, n) => { req.user = USERS[req.headers['x-u'] || 'full']; n(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const out = {};
    try { ${body} } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)} ${(r.stderr || '').slice(-1500)}`);
  return { ...JSON.parse(line.slice(2)), dir };
}

/* ── AUTHZ2605-01 ─────────────────────────────────────────────────────────── */

test('AUTHZ2605-01: 범위 admin 의 GET→PUT 왕복이 범위 밖 설정·vmperf DB 파일을 지우지 않는다(4종)', () => {
  const o = runChild(`
    const fs = await import('node:fs'); const path = await import('node:path');
    const vcs = (store.get().vcenters || []).map((v) => v.id);
    const ids = ['vc-us-east', 'vc-us-west', 'vc-eu-west'];
    out.have = ids.every((x) => vcs.includes(x));
    const dbdir = path.join(process.env.CONFIG_DIR, 'vmperf');
    const files = () => { try { return fs.readdirSync(dbdir).filter((f) => f.endsWith('.db')).sort(); } catch { return []; } };
    // waste(vmperf)
    await call('full', 'PUT', '/tools/waste/settings', { enabled: true, vcenterIds: ids });
    const { getVmperfDb } = await import(SRC + 'metrics/vmperfDb.js');
    for (const id of ids) await getVmperfDb(id);
    out.filesBefore = files();
    let r = await call('sadm', 'GET', '/tools/waste/settings');
    out.wasteGet = r.j.settings.vcenterIds;
    r = await call('sadm', 'PUT', '/tools/waste/settings', r.j.settings);
    out.wastePut = { s: r.s, dropped: r.j.dropped, resp: r.j.settings.vcenterIds };
    out.wasteAfter = (await call('full', 'GET', '/tools/waste/settings')).j.settings.vcenterIds;
    out.filesAfter = files();
    // 범위 밖 vCenter 데이터·전체 합계 삭제는 403
    out.delOther = (await call('sadm', 'DELETE', '/tools/waste/settings/data?vcenterId=vc-us-west')).s;
    out.delTotal = (await call('sadm', 'DELETE', '/tools/waste/settings/data?all=1')).s;
    out.filesAfterDel = files();
    // 범위 admin 이 자기 vCenter 만 빼면 범위 밖은 남는다
    r = await call('sadm', 'PUT', '/tools/waste/settings', { vcenterIds: ['vc-us-east', 'vc-us-west'] });
    out.wasteForged = { s: r.s, ignored: r.j.ignoredOutOfScope, after: (await call('full', 'GET', '/tools/waste/settings')).j.settings.vcenterIds };
    // curuser
    await call('full', 'PUT', '/tools/curuser/settings', { vcenters: Object.fromEntries(ids.map((i) => [i, { enabled: true, folders: ['F'] }])) });
    r = await call('sadm', 'GET', '/tools/curuser/settings');
    r = await call('sadm', 'PUT', '/tools/curuser/settings', r.j.settings);
    out.cuPutResp = Object.keys(r.j.settings?.vcenters || {}).sort();
    out.cuAfter = Object.keys((await call('full', 'GET', '/tools/curuser/settings')).j.settings.vcenters || {}).sort();
    // vmseries
    await call('full', 'PUT', '/tools/vmseries/settings', { scope: 'selected', targets: Object.fromEntries(ids.map((i) => [i, { all: true }])) });
    r = await call('sadm', 'GET', '/tools/vmseries/settings');
    r = await call('sadm', 'PUT', '/tools/vmseries/settings', { targets: r.j.settings.targets, scope: 'all' });
    out.vsPutResp = Object.keys(r.j.settings?.targets || {}).sort();
    const vsFull = (await call('full', 'GET', '/tools/vmseries/settings')).j.settings;
    out.vsAfter = { targets: Object.keys(vsFull.targets || {}).sort(), scope: vsFull.scope };
    // bm-usage
    await call('full', 'PUT', '/tools/bm-usage/settings', { corps: { 'vc-us-west': true, 'vc-eu-west': true } });
    r = await call('sadm', 'GET', '/tools/bm-usage');
    r = await call('sadm', 'PUT', '/tools/bm-usage/settings', { corps: { ...(r.j.settings?.corps || {}), 'vc-us-east': true } });
    out.bmPutResp = Object.keys(r.j.settings?.corps || {}).sort();
    out.bmAfter = Object.keys((await call('full', 'GET', '/tools/bm-usage')).j.settings.corps || {}).sort();
  `);
  assert.ok(o.have, '목 스냅샷에 vc-us-east/us-west/eu-west 가 있어야 한다');
  assert.equal(o.filesBefore.length, 3);
  assert.deepEqual(o.wasteGet, ['vc-us-east']);
  assert.equal(o.wastePut.s, 200);
  assert.deepEqual(o.wastePut.dropped, [], '범위 밖 vmperf DB 를 지우면 안 된다');
  assert.deepEqual(o.wastePut.resp, ['vc-us-east'], 'PUT 응답도 GET 과 같은 필터');
  assert.deepEqual([...o.wasteAfter].sort(), ['vc-eu-west', 'vc-us-east', 'vc-us-west']);
  assert.deepEqual(o.filesAfter, o.filesBefore, '왕복 뒤 vmperf 파일 3개가 그대로');
  assert.equal(o.delOther, 403);
  assert.equal(o.delTotal, 403);
  assert.deepEqual(o.filesAfterDel, o.filesBefore);
  assert.equal(o.wasteForged.ignored, 1, '본문의 범위 밖 id 는 무시하고 개수를 밝힌다');
  assert.deepEqual([...o.wasteForged.after].sort(), ['vc-eu-west', 'vc-us-east', 'vc-us-west']);
  assert.deepEqual(o.cuPutResp, ['vc-us-east']);
  assert.deepEqual(o.cuAfter, ['vc-eu-west', 'vc-us-east', 'vc-us-west']);
  assert.deepEqual(o.vsPutResp, ['vc-us-east']);
  assert.deepEqual(o.vsAfter.targets, ['vc-eu-west', 'vc-us-east', 'vc-us-west']);
  assert.equal(o.vsAfter.scope, 'selected', '범위 계정은 전 법인에 걸친 scope 를 바꾸지 못한다');
  assert.deepEqual(o.bmPutResp, ['vc-us-east']);
  assert.deepEqual(o.bmAfter, ['vc-eu-west', 'vc-us-east', 'vc-us-west']);
});

test('AUTHZ2605-01: mergeScopedIds — 빈 배열(전체)·범위 안 선택·범위 밖 무시', async () => {
  const { mergeScopedIds, mergeScopedMap } = await import('../src/auth/scopeMerge.js');
  const A = new Set(['a']);
  // 직전 전체([]) + 범위 계정이 [] 를 되돌려 보냄 → 그대로 []
  assert.deepEqual(mergeScopedIds([], [], A, ['a', 'b', 'c']).merged, []);
  // 직전 전체 + 범위 계정이 자기 것 선택 → 전체가 유지되므로 [] 그대로
  assert.deepEqual(mergeScopedIds([], ['a'], A, ['a', 'b', 'c']).merged, []);
  // 직전 [b] (범위 밖만) + GET 이 준 [] 를 되돌려 보냄 → 변경 없음(넓히지 않는다)
  assert.deepEqual(mergeScopedIds(['b'], [], A, ['a', 'b']).merged, ['b']);
  // 직전 [a,b] + 범위 계정이 [a] → [a,b]
  assert.deepEqual(mergeScopedIds(['a', 'b'], ['a'], A, ['a', 'b']).merged, ['a', 'b']);
  // 전체 범위(null)면 요청 그대로
  assert.deepEqual(mergeScopedIds(['a', 'b'], ['a'], null, ['a', 'b']).merged, ['a']);
  const m = mergeScopedMap({ a: 1, b: 2 }, { a: 9, c: 3 }, A);
  assert.deepEqual(m.merged, { b: 2, a: 9 });
  assert.deepEqual(m.ignored, ['c']);
});

/* ── AUTHZ2605-02 ─────────────────────────────────────────────────────────── */

test('AUTHZ2605-02: 전 법인 수동 실행·Horizon 설정 변경은 범위 계정에 403', () => {
  const o = runChild(`
    out.gd = (await call('sadm', 'POST', '/tools/guest-disk/run')).s;
    out.off = (await call('sadm', 'POST', '/tools/waste/off-check/run')).s;
    out.vt = (await call('sadm', 'POST', '/tools/vm-track/snapshot')).s;
    out.hzc = (await call('sadm', 'POST', '/tools/horizon-sessions/collect')).s;
    const hp = await call('sadm', 'PUT', '/tools/horizon-sessions/settings', {});
    out.hzs = { s: hp.s, hasSettings: !!hp.j?.settings };
    // 전체 범위 admin 은 여전히 실행된다(403 아님)
    out.fullOff = (await call('full', 'POST', '/tools/waste/off-check/run')).s;
    out.fullHz = (await call('full', 'PUT', '/tools/horizon-sessions/settings', {})).s;
  `);
  assert.equal(o.gd, 403);
  assert.equal(o.off, 403);
  assert.equal(o.vt, 403);
  assert.equal(o.hzc, 403);
  assert.equal(o.hzs.s, 403);
  assert.equal(o.hzs.hasSettings, false, '403 응답에 전체 settings 를 싣지 않는다');
  assert.notEqual(o.fullOff, 403);
  assert.notEqual(o.fullHz, 403);
});

/* ── AUTHZ2605-03 · 04 ────────────────────────────────────────────────────── */

const SAN_HOST = '10.77.3.44';

test('AUTHZ2605-03/04: SAN 사용량 진단·포트 sections·조닝·점검 이력 이름은 비-admin 에 주소를 가린다', () => {
  const o = runChild(`
    const reg = await import(SRC + 'sanswitch/registry.js');
    let dev = reg.listDevices().find((d) => d.host === ${JSON.stringify(SAN_HOST)});
    if (!dev) { reg.saveDevice({ name: ${JSON.stringify(SAN_HOST)}, host: ${JSON.stringify(SAN_HOST)}, type: 'brocade', collectMethod: 'ssh', username: 'u', password: 'p' }); dev = reg.listDevices().find((d) => d.host === ${JSON.stringify(SAN_HOST)}); }
    out.devOk = !!dev;
    const id = dev.id;
    const ps = await import(SRC + 'sanswitch/perfSettings.js').catch(() => null);
    if (ps?.savePerfSettings) ps.savePerfSettings({ enabled: true });
    const pal = await import(SRC + 'sanswitch/perfActivityLog.js');
    pal.recordActivity({ deviceId: id, name: dev.name, host: dev.host, source: 'central', ok: false, error: 'connect ETIMEDOUT ${SAN_HOST}:22' });
    const store2 = await import(SRC + 'sanswitch/store.js');
    const snap = { deviceId: id, name: ${JSON.stringify(SAN_HOST)}, host: ${JSON.stringify(SAN_HOST)}, ok: false, collectedAt: 1700000000000,
      error: 'connect ETIMEDOUT ${SAN_HOST}:443',
      sections: { ports: '오류: ${SAN_HOST}:443 응답이 없습니다', zoning: '오류: ${SAN_HOST}:443 응답이 없습니다' },
      ports: { list: [] }, zoning: null };
    store2.putSnapshot(snap);
    for (const u of ['op', 'full']) {
      out[u] = {
        perf: await call(u, 'GET', '/tools/sanswitch/devices/' + id + '/perf'),
        ports: await call(u, 'GET', '/tools/sanswitch/devices/' + id + '/ports'),
        zoning: await call(u, 'GET', '/tools/sanswitch/devices/' + id + '/zoning'),
        hist: await call(u, 'GET', '/tools/sanswitch/devices/' + id + '/healthcheck/history'),
        list: await call(u, 'GET', '/tools/sanswitch'),
      };
    }
  `);
  assert.ok(o.devOk);
  const op = o.op;
  assert.equal(op.perf.s, 200);
  assert.ok(op.perf.j.diag, '빈 시계열이면 진단이 붙는다');
  assert.ok(JSON.stringify(o.full.perf.j.diag?.facts || {}).includes(SAN_HOST), '재현 전제: admin 진단에는 원문이 있다');
  assert.ok(!JSON.stringify(op.perf.j.diag).includes(SAN_HOST), `diag 에 주소가 남았다: ${JSON.stringify(op.perf.j.diag).slice(0, 300)}`);
  assert.equal(op.perf.j.addressHidden, true);
  assert.equal(op.ports.s, 200);
  assert.ok(!JSON.stringify(op.ports.j.sections).includes(SAN_HOST), 'ports.sections 가림');
  assert.notEqual(op.ports.j.name, SAN_HOST);
  assert.equal(op.zoning.s, 200);
  assert.notEqual(op.zoning.j.name, SAN_HOST, 'zoning 이름=IP 가림');
  assert.ok(!String(op.zoning.j.section).includes(SAN_HOST), 'zoning section 가림');
  assert.equal(op.hist.s, 200);
  assert.notEqual(op.hist.j.name, SAN_HOST, '점검 이력 이름=IP 가림');
  const listDev = (op.list.j.devices || [])[0];
  assert.ok(listDev && !JSON.stringify(listDev.snap?.sections || {}).includes(SAN_HOST), '목록 snap.sections 가림');
  // admin 은 원문 그대로
  assert.ok(JSON.stringify(o.full.ports.j.sections).includes(SAN_HOST));
  assert.equal(o.full.hist.j.name, SAN_HOST);
});

test('AUTHZ2605-04: maskSnapAddress 가 sections 문자열의 주소(스킴·포트 변형 포함)를 가린다', async () => {
  const { maskSnapAddress } = await import('../src/auth/addressMask.js');
  const s = maskSnapAddress({ host: '10.91.1.11', error: 'x', sections: { capacity: '오류: 10.91.1.11:8080 응답이 없습니다', nodes: 'ok', n: 3 } });
  assert.ok(!s.sections.capacity.includes('10.91.1.11'));
  assert.equal(s.sections.nodes, 'ok');
  assert.equal(s.sections.n, 3);
  const s2 = maskSnapAddress({ sections: { capacity: 'https://isi.example:8080 timeout' } }, 'https://isi.example');
  assert.ok(!s2.sections.capacity.includes('isi.example'));
});

/* ── LEFT2605-05 · RECENT2605-01(bmusage) ──────────────────────────────────── */

test('RECENT2605-01: 호스트 미수집 vCenter 보류는 WITHHOLD_MAX_MS 뒤에 끝난다(무기한 제외 금지)', async () => {
  process.env.CONFIG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'audit2605b-bm-'));
  const { withholdUnreadBareMetal } = await import('../src/bmusage/poller.js');
  const { WITHHOLD_MAX_MS } = await import('../src/agent/inventoryPush.js');
  const snap = { vcenters: [{ id: 'vcA', status: 'ok' }, { id: 'vcD', status: 'unreachable' }], hosts: [{ id: 'h1', vcenterId: 'vcA' }] };
  const reg = [{ id: 'vcA' }, { id: 'vcD' }];
  const bm = [{ key: 'a', vcenterId: 'vcA' }, { key: 'b', vcenterId: '' }, { key: 'c', vcenterId: 'vcD' }];
  const since = new Map();
  const T0 = 1_700_000_000_000;
  const r1 = await withholdUnreadBareMetal(snap, bm, reg, { now: T0, sinceMap: since });
  assert.deepEqual(r1.bareMetal.map((x) => x.key), ['a']);
  assert.deepEqual(r1.hostsUnread.withheld, ['vcD']);
  assert.equal(r1.hostsUnread.dropped, 2);
  assert.deepEqual(r1.hostsUnread.droppedByVc, { '': 1, vcD: 1 });
  const r2 = await withholdUnreadBareMetal(snap, bm, reg, { now: T0 + WITHHOLD_MAX_MS + 1, sinceMap: since });
  assert.deepEqual(r2.bareMetal.map((x) => x.key), ['a', 'b', 'c'], '시한이 지나면 다시 수집한다');
  assert.deepEqual(r2.hostsUnread.expired, ['vcD']);
  assert.equal(r2.hostsUnread.dropped, 0);
  // 복구되면 시계를 지운다
  const r3 = await withholdUnreadBareMetal({ ...snap, vcenters: [{ id: 'vcA', status: 'ok' }, { id: 'vcD', status: 'ok' }], hosts: [...snap.hosts, { id: 'h2', vcenterId: 'vcD' }] }, bm, reg, { now: T0 + WITHHOLD_MAX_MS + 2, sinceMap: since });
  assert.equal(r3.hostsUnread, null);
  assert.equal(since.size, 0);
});

test('LEFT2605-05: hostsUnread 는 응답에 실리고 범위 계정에는 자기 범위만(귀속 없음 개수 제외)', async () => {
  const { scopeHostsUnread } = await import('../src/routes/api/bmUsage.js');
  const h = { vcenters: ['vcA', 'vcB'], withheld: ['vcA', 'vcB'], expired: [], dropped: 5, droppedByVc: { vcA: 2, vcB: 1, '': 2 }, since: { vcA: 1, vcB: 2 }, withholdMaxMs: 1 };
  assert.equal(scopeHostsUnread(h, null), h);
  const s = scopeHostsUnread(h, new Set(['vcA']));
  assert.deepEqual(s.vcenters, ['vcA']);
  assert.equal(s.dropped, 2);
  assert.deepEqual(s.droppedByVc, { vcA: 2 });
  assert.equal(scopeHostsUnread(h, new Set(['vcX'])), null);
  assert.equal(scopeHostsUnread(null, null), null);
  // 라우트가 실제로 싣는지(소스가 아니라 응답 키로)
  const o = runChild(`
    const r = await call('full', 'GET', '/tools/bm-usage');
    out.s = r.s; out.has = Object.prototype.hasOwnProperty.call(r.j, 'hostsUnread');
  `);
  assert.equal(o.s, 200);
  assert.ok(o.has, 'GET /tools/bm-usage 응답에 hostsUnread 키가 있어야 한다');
});

/* ── LEFT2605-07 ──────────────────────────────────────────────────────────── */

test('LEFT2605-07: 소수·음수·NaN limit 이 SQLite 바인드 오류(500)가 되지 않는다(5개 헬퍼)', () => {
  const o = runChild(`
    const res = {};
    const tryIt = async (k, fn) => { try { const v = await fn(); res[k] = { ok: true, n: Array.isArray(v) ? v.length : (v?.rows?.length ?? v?.runs?.length ?? null) }; } catch (e) { res[k] = { ok: false, e: e.message }; } };
    const hh = await import(SRC + 'sanswitch/healthHistory.js');
    await tryIt('healthHistory', () => hh.listRuns('d1', 1.5));
    const rh = await import(SRC + 'rma/historyDb.js');
    await tryIt('rmaHistory', () => rh.listHistoryRows({ limit: 1.5 }));
    await tryIt('rmaHistoryNaN', () => rh.listHistoryRows({ limit: undefined }));
    const tr = await import(SRC + 'rma/testResults.js');
    await tryIt('rmaTests', () => tr.testHistory('a', 'b', { limit: 1.5 }));
    const vs = await import(SRC + 'vmseries/db.js');
    await tryIt('vmseriesTop', async () => { await vs.getVmSeriesDb('vc-x', { create: true }); return vs.topInWindow('vc-x', 0, Date.now(), 1.5); });
    const du = await import(SRC + 'dirusage/db.js');
    await tryIt('dirusage', async () => { const db = await du.getDb(); return db ? db.list('t1', 1.5) : []; });
    out.res = res;
    // 라우트 왕복
    out.route = (await call('full', 'GET', '/tools/sanswitch/devices/none/healthcheck/history?limit=1.5')).s;
  `);
  for (const [k, v] of Object.entries(o.res)) assert.ok(v.ok, `${k}: ${v.e}`);
  assert.notEqual(o.route, 500);
});

/* ── WEB2605-04 · 07 (서버 쪽 행 필드) ─────────────────────────────────────── */

test('WEB2605-04/07: checkPorts 행이 축약 보류(errHeld)와 slotPort 를 싣는다', async () => {
  const { checkPorts } = await import('../src/sanswitch/healthCheck.js');
  const pc = checkPorts({ sections: { counters: 'ok', sfp: 'ok', ports: 'ok' }, ports: { list: [
    { index: 3, slotPort: '1/3', state: 'online', rxPowerDbm: -3, errCrc: 1200000, errEncOut: 0, errApprox: ['errCrc'] },
    { index: 4, slotPort: '1/4', state: 'online', rxPowerDbm: -3, errCrc: 0, errEncOut: 0 },
  ] } }, { baseline: { ports: { 3: { errCrc: 1200000, errEncOut: 0, _approx: ['errCrc'] }, 4: { errCrc: 0, errEncOut: 0 } } } });
  const r3 = pc.rows.find((r) => r.index === 3);
  const r4 = pc.rows.find((r) => r.index === 4);
  assert.equal(r3.errors, 'unknown');
  assert.equal(r3.errHeld, 'approx');
  assert.equal(r3.errSum, 1200000);
  assert.equal(r3.slotPort, '1/3');
  assert.equal(r4.errHeld, null);
  assert.equal(r4.slotPort, '1/4');
});
