/**
 * v2.604 감사 — 공개 API·가림·범위 그룹(b) 회귀 고정.
 *
 *  - AUTHZ-2604-01  공개 API /capacity/storage(+ storage-growth)가 관리 IP 와 같은 장비 이름을 그대로 줬다
 *  - AUTHZ-2604-02  공개 API /faults/parts 가 IP 로 등록한 iDRAC 의 partKey·deviceKey 를 원문으로 줬다
 *                   (내부 /tools/part-faults 는 v2.601 부터 비-admin 에 불투명 토큰)
 *  - AUTHZ-2604-06  공개 API /faults/parts 의 openedAt·reason 이 필드명 불일치로 **항상 null**
 *  - AUTHZ-2604-03  GET /tools/storage 의 poller.inFlight 이름(IP)이 비-admin 에 나갔다
 *  - AUTHZ-2604-04  GET /tools/sanswitch 의 poller.inFlight 도 같다
 *  - AUTHZ-2604-05  범위 제한 admin 이 GET /admin/alerts 로 전 vCenter 의 발생 중·최근 알림을 받았다
 *
 * ⚠ 검증 방식: 실제 라우터를 express 에 띄워(자식 프로세스 — config 싱글턴) 역할·키별 응답으로 본다.
 *   in-flight 는 **실제 수집을 매달아** 만든다(응답하지 않는 로컬 TLS 포트 — 시간에 기대지 않고 상태를 폴링한다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { alertVcenterOf, scopeAlertStatus } from '../src/routes/admin/opsSettings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (rel) => JSON.stringify(path.join(SRC, rel));

function runChild(boot, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2604b-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)} ${r.stderr?.slice(-800)}`);
  return JSON.parse(line.slice(2));
}

/* ── 공개 API(AUTHZ-2604-01·02·06) ───────────────────────────────────────── */

test('공개 API — 스토리지 이름·파트 식별자의 IP 를 가리고, openedAt·reason 은 실제 값이다(키 집합 계약 유지)', () => {
  const r = runChild(`
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const v1 = (await import(${J('routes/publicApi.js')})).default;
    const keys = await import(${J('publicapi/keys.js')});
    const { ENDPOINT_BY_PATH } = await import(${J('publicapi/allowlist.js')});
    const storageReg = await import(${J('storage/registry.js')});
    const stPoller = await import(${J('storage/poller.js')});
    const pf = await import(${J('partfault/db.js')});
    const { maskPartRow, partFaultHosts } = await import(${J('routes/api/partFaults.js')});
    const { addressMatcher } = await import(${J('auth/addressMask.js')});
    await store.refresh({ force: true });
    // 이름을 비워 주소로 떨어진 장비 + 정상 이름 장비
    storageReg.saveDevice({ type: 'isilon', name: '10.20.30.40', host: '10.20.30.40', username: 'u', password: 'p' });
    storageReg.saveDevice({ type: 'isilon', name: 'UNITY-OK', host: '10.20.30.41', username: 'u', password: 'p' });
    for (const d of storageReg.listDevices()) await stPoller.collectDeviceNow(d.id);
    // IP 로 등록된 iDRAC 의 열린 장애 + 보류 사유
    const T0 = 1_800_000_000_000;   // 고정 기준 시각(Date.now() 금지 — CLAUDE.md v2.517)
    const pk = 'idrac:10.9.8.7:psu:PSU.Slot.1';
    const p = { agent: '', partKey: pk, scope: 'idrac', deviceId: '10.9.8.7', deviceKey: '10.9.8.7', deviceKeyKind: 'id',
      deviceName: '10.9.8.7', kind: 'psu', partId: 'PSU.Slot.1', keyKind: 'fqdd', label: 'PSU 1', state: 'fault', rawState: 'Critical',
      firstSeenAt: T0, lastSeenAt: T0 };
    await pf.applyTransition({ opened: [p], updated: [], closed: [], held: [] }, { now: T0 });
    await pf.applyTransition({ opened: [], updated: [], closed: [], held: [{ ...p, lastSeenAt: T0 + 60000, holdReason: 'device-failed' }] }, { now: T0 + 60000 });
    const out = await (async () => {
    const internal = (await pf.openFaults()).map((f) => maskPartRow(f, addressMatcher([]), []));
    const app = express();
    app.use('/api/v1', v1);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/v1';
    const key = keys.issueApiKey({ name: 'k', groups: ['capacity', 'faults'] }).plaintext;
    const call = async (p2) => { const x = await fetch(base + p2, { headers: { 'X-Api-Key': key } }); const text = await x.text(); return { status: x.status, text, body: JSON.parse(text) }; };
    const storage = await call('/capacity/storage');
    const growth = await call('/capacity/storage-growth');
    const parts = await call('/faults/parts');
    srv.close();
    return { storage, growth, parts, internal,
      fields: { storage: ENDPOINT_BY_PATH['/capacity/storage'].fields, parts: ENDPOINT_BY_PATH['/faults/parts'].fields },
      ids: storageReg.listDevices().map((d) => d.id), T0 };
    })();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_SOURCE: 'mock' });

  // AUTHZ-2604-01
  assert.equal(r.storage.status, 200, r.storage.text.slice(0, 300));
  const rows = r.storage.body.data;
  assert.equal(rows.length, 2, '두 장비가 모두 나와야 한다(가림은 행을 빼지 않는다)');
  assert.ok(!/10\.20\.30\.4\d/.test(r.storage.text), `공개 API 스토리지 응답에 관리 IP 가 남았다: ${r.storage.text.slice(0, 500)}`);
  assert.ok(rows.some((x) => x.name === 'UNITY-OK'), '주소가 아닌 이름은 그대로여야 한다');
  const masked = rows.find((x) => x.name !== 'UNITY-OK');
  assert.match(masked.name, /이름 가림/);
  assert.ok(r.ids.includes(masked.deviceId));
  for (const x of rows) assert.deepEqual(Object.keys(x).sort(), [...r.fields.storage].sort(), '키 집합 == 선언 fields 계약');
  assert.equal(r.storage.body.meta.namesHidden, 1, '가린 개수를 밝힌다');
  if (r.growth.status === 200) assert.ok(!/10\.20\.30\.4\d/.test(r.growth.text), '증가량 경로(형제)에도 IP 가 없어야 한다');

  // AUTHZ-2604-02 / 06
  assert.equal(r.parts.status, 200, r.parts.text.slice(0, 300));
  assert.ok(!/10\.9\.8\.7/.test(r.parts.text), `공개 API 파트 장애 응답에 iDRAC IP 가 남았다: ${r.parts.text.slice(0, 500)}`);
  const row = r.parts.body.data[0];
  assert.deepEqual(Object.keys(row).sort(), [...r.fields.parts].sort());
  assert.equal(row.partKey, r.internal[0].partKey, '내부 화면과 같은 토큰(같은 함수)이어야 대조된다');
  assert.equal(row.deviceKey, r.internal[0].deviceKey);
  assert.match(row.deviceKey, /^masked-/);
  assert.equal(row.partId, 'PSU.Slot.1');
  assert.equal(r.parts.body.meta.addressHidden, true);
  assert.equal(row.openedAt, r.T0, 'openedAt 이 firstSeenAt 을 읽어야 한다(예전: 항상 null)');
  assert.equal(row.reason, 'device-failed', 'reason 이 holdReason 을 읽어야 한다(예전: 항상 null)');
  assert.equal(row.lastSeenAt, r.T0 + 60000);
});

/* ── 목록 라우트의 poller.inFlight(AUTHZ-2604-03·04) ─────────────────────── */

test('GET /tools/storage·/tools/sanswitch — 수집 중인 장비 이름(IP)이 비-admin poller.inFlight 에 나가지 않는다', () => {
  const r = runChild(`
    const net = await import('node:net');
    // 연결은 받되 아무 것도 보내지 않는 포트 — TLS 핸드셰이크가 매달려 수집이 in-flight 로 남는다.
    const socks = [];
    const hang = net.createServer((s) => { socks.push(s); s.on('error', () => {}); });
    await new Promise((res) => hang.listen(0, '127.0.0.1', res));
    const hp = hang.address().port;
    process.env.STORAGE_ISILON_PORT = String(hp);
    const express = (await import('express')).default;
    const { api } = await import(${J('routes/api.js')});
    const storageReg = await import(${J('storage/registry.js')});
    const sanReg = await import(${J('sanswitch/registry.js')});
    const stPoller = await import(${J('storage/poller.js')});
    const swPoller = await import(${J('sanswitch/poller.js')});
    const s1 = storageReg.saveDevice({ type: 'isilon', collectMethod: 'api', name: '127.0.0.1', host: '127.0.0.1', username: 'u', password: 'p' });
    const s2 = sanReg.saveDevice({ type: 'brocade', collectMethod: 'rest', name: '127.0.0.1', host: '127.0.0.1', httpsPort: hp, username: 'u', password: 'p' });
    const stId = storageReg.listDevices()[0]?.id; const swId = sanReg.listDevices()[0]?.id;
    stPoller.collectDeviceNow(stId).catch(() => {});
    swPoller.collectDeviceNow(swId).catch(() => {});
    // 두 수집이 실제로 매달릴 때까지(시각이 아니라 상태로) 기다린다.
    for (let i = 0; i < 200; i++) {
      if (stPoller.storagePollerStatus().inFlight.length && swPoller.sanSwitchPollerStatus().inFlight.length && socks.length >= 2) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const mk = (user) => { const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = user; next(); }); app.use('/api', api); return app; };
    const start = async (app) => { const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); }); return { s, base: 'http://127.0.0.1:' + s.address().port }; };
    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
    const get = async (b, p) => { const x = await fetch(b + p); const text = await x.text(); return { status: x.status, text, body: JSON.parse(text) }; };
    const out = {
      saved: [s1, s2],
      inflight: [stPoller.storagePollerStatus().inFlight.length, swPoller.sanSwitchPollerStatus().inFlight.length],
      adminSt: await get(admin.base, '/api/tools/storage'), operSt: await get(oper.base, '/api/tools/storage'),
      adminSw: await get(admin.base, '/api/tools/sanswitch'), operSw: await get(oper.base, '/api/tools/sanswitch'),
    };
    for (const k of ['adminSt', 'operSt', 'adminSw', 'operSw']) out[k] = { status: out[k].status, poller: out[k].body.poller, ip: /127\\.0\\.0\\.1/.test(out[k].text) };
    console.log('@@' + JSON.stringify(out));
    process.exit(0);   // 매달린 수집을 기다리지 않는다(장비 시한까지 수 분)
  `, { DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true' });
  assert.deepEqual(r.inflight, [1, 1], `수집이 in-flight 가 아니다 — 테스트가 공허하다: ${JSON.stringify(r)}`.slice(0, 1500));
  for (const k of ['adminSt', 'operSt', 'adminSw', 'operSw']) assert.equal(r[k].status, 200, `${k} ${r[k].status}`);
  // admin 은 원문을 받는다(테스트가 공허하지 않은지)
  assert.equal(r.adminSt.poller.inFlight[0].name, '127.0.0.1');
  assert.equal(r.adminSw.poller.inFlight[0].name, '127.0.0.1');
  // 비-admin — 응답 전체에 주소가 없다(devices 는 v2.599 부터 가려졌고, poller 가 마지막 누출 지점이었다)
  assert.equal(r.operSt.ip, false, `스토리지 비-admin 응답에 IP: ${JSON.stringify(r.operSt.poller)}`);
  assert.equal(r.operSw.ip, false, `SAN 비-admin 응답에 IP: ${JSON.stringify(r.operSw.poller)}`);
  assert.match(r.operSt.poller.inFlight[0].name, /이름 가림/);
  assert.match(r.operSw.poller.inFlight[0].name, /이름 가림/);
});

/* ── 범위 제한 admin 의 알림(AUTHZ-2604-05) ─────────────────────────────── */

test('alertVcenterOf — vcenterId 필드, 없으면 키 접두 + 허용 id 대조(콜론 split 금지)', () => {
  const allowed = new Set(['vc-a', 'vc:b']);
  assert.equal(alertVcenterOf({ key: 'ds:1', vcenterId: 'vc-x' }, allowed), 'vc-x');
  assert.equal(alertVcenterOf({ key: 'vc:vc-a' }, allowed), 'vc-a');
  assert.equal(alertVcenterOf({ key: 'massoff:vc:b' }, allowed), 'vc:b', '콜론이 든 vCenter id');
  assert.equal(alertVcenterOf({ key: 'ramoc:vc:b:cl-1' }, allowed), 'vc:b');
  assert.equal(alertVcenterOf({ key: 'vcpuoc:vc-a:cl' }, allowed), 'vc-a');
  assert.equal(alertVcenterOf({ key: 'vcpuoc:vc-z:cl' }, allowed), null, '허용 밖 id 는 귀속하지 않는다');
  assert.equal(alertVcenterOf({ key: 'host:h1', severity: 'resolved' }, allowed), null, '귀속 불가');
  const st = { config: { c: 1 }, firing: [{ key: 'vc:vc-a' }, { key: 'x', vcenterId: 'vc-z' }], recent: [{ key: 'host:h' }, { key: 'y', vcenterId: 'vc-a' }], engineOn: true };
  const s = scopeAlertStatus(st, allowed);
  assert.deepEqual(s.firing.map((a) => a.key), ['vc:vc-a']);
  assert.deepEqual(s.recent.map((a) => a.key), ['y']);
  assert.deepEqual(s.omittedOutOfScope, { firing: 1, recent: 1 });
  assert.equal(s.scoped, true);
  assert.equal(scopeAlertStatus(st, null), st, '전체 범위는 그대로');
});

test('GET /admin/alerts — 범위 제한 admin 은 범위 vCenter 의 알림만, 전체 admin 은 전부', () => {
  const r = runChild(`
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const al = await import(${J('alerts.js')});
    const { registerOpsSettings } = await import(${J('routes/admin/opsSettings.js')});
    await store.refresh({ force: true });
    await al._refreshStateForTest(al.alertStatus().config, false);
    const vcs = [...new Set(al.alertStatus().firing.map((a) => a.vcenterId).filter(Boolean))];
    const A = vcs[0];
    const mk = (user) => { const r0 = express.Router(); registerOpsSettings(r0); const app = express(); app.use((req, _r, next) => { req.user = user; next(); }); app.use('/api/admin', r0); return app; };
    const start = async (app) => { const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); }); return 'http://127.0.0.1:' + s.address().port; };
    const full = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const sc = await start(mk({ username: 'adminsc', role: 'admin', scope: { vcenters: [A] } }));
    const g = async (b) => (await fetch(b + '/api/admin/alerts')).json();
    const out = { A, vcs, full: await g(full), sc: await g(sc) };
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_SOURCE: 'mock' });
  assert.ok(r.vcs.length >= 2, `목 데이터에서 여러 vCenter 알림이 필요하다: ${JSON.stringify(r.vcs)}`);
  const fullVcs = new Set(r.full.firing.map((a) => a.vcenterId).filter(Boolean));
  assert.ok(fullVcs.size >= 2, '전체 admin 은 전 vCenter 를 받는다');
  assert.ok(r.sc.firing.length > 0, '범위 vCenter 의 알림은 남아야 한다');
  for (const a of r.sc.firing) assert.ok(a.vcenterId === r.A || String(a.key).includes(r.A), `범위 밖 알림: ${JSON.stringify(a)}`);
  assert.equal(r.sc.scoped, true);
  assert.equal(r.sc.omittedOutOfScope.firing, r.full.firing.length - r.sc.firing.length, '뺀 개수를 밝힌다');
  assert.ok(r.sc.omittedOutOfScope.firing > 0);
  assert.equal(r.full.scoped, undefined);
});
