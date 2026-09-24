/**
 * v2.599 감사 — 인가·범위 그룹(c) 회귀 고정.
 *
 *  - AUTHZ-2599-01 VM 복제 잡 수정 POST 가 **기존 잡의 vCenter** 를 쓰기 범위로 보지 않아 범위 밖 잡을 가로챘다
 *  - AUTHZ-2599-02 /remote/probe·quick-connect 가 범위 검사 없는 body.vcenterId 로 프록시를 골랐다
 *  - AUTHZ-2599-03 스토리지·SAN 스위치·PDU 조회가 tools 권한(operator)에 관리 IP·계정명을 줬다
 *  - AUTHZ-2599-04 공개 API /inventory/collection 이 범위 키에 전 함대 vCenter 수·상태를 줬다
 *  - AUTHZ-2599-05 범위 제한 admin 에게 VM 복제·실제 OS 스캔 결과의 범위 밖 항목
 *  - AUTHZ-2599-06 VM 복제 잡의 vmId 가 다른 vCenter 의 VM 이어도 저장됐다(정합성)
 *  - EDGE2599-02  /api/v1/capacity/storage 가 로컬+엣지 스냅샷을 deviceId 로 합치지 않았다
 *
 * ⚠ 검증 방식: **실제 라우터를 express 에 마운트하고 역할·범위별 응답으로** 본다(소스 grep 이 아니다 — v2.506 교훈).
 *   자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { latestByDevice } from '../src/storage/latestSnapshots.js';
import { maskDeviceAddress, maskSnapAddress } from '../src/auth/addressMask.js';
import { vcenterScopeIssue } from '../src/routes/remote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (p) => JSON.stringify(path.join(SRC, p));

/** 자식 프로세스에서 목 스냅샷을 채우고 라우터를 띄운다. script 는 { call, v1call, snap, ... } 을 쓴다. */
function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2599c-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const { adminRouter } = await import(${J('routes/admin.js')});
    const { remoteRouter } = await import(${J('routes/remote.js')});
    const v1 = (await import(${J('routes/publicApi.js')})).default;
    const keys = await import(${J('publicapi/keys.js')});
    const vmclone = await import(${J('vmclone/store.js')});
    const osStore = await import(${J('inventory/osStore.js')});
    const storageReg = await import(${J('storage/registry.js')});
    const sanReg = await import(${J('sanswitch/registry.js')});
    const pduReg = await import(${J('pdu/registry.js')});
    const { STORAGE_TYPES } = await import(${J('storage/types.js')});
    const { SAN_SWITCH_TYPES } = await import(${J('sanswitch/types.js')});
    await store.refresh({ force: true });
    const snap = store.get();
    const vcs = snap.vcenters.map((v) => v.id);
    const mk = (user) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api', api);
      app.use('/api/admin', adminRouter);
      app.use('/api/remote', remoteRouter);
      return app;
    };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p, init = {}) => {
      const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
      let b = null; try { b = await r.json(); } catch {}
      return { status: r.status, body: b };
    };
    const v1app = express(); v1app.use('/api/v1', v1);
    const v1base = await start(v1app);
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

/* ── 순수 모듈 ─────────────────────────────────────────────────────────────── */

test('EDGE2599-02: latestByDevice — 같은 deviceId 는 최신 collectedAt 하나(ISO·숫자 모두)', () => {
  const T = 1_800_000_000_000;
  const rows = latestByDevice([
    [{ deviceId: 'st-1', collectedAt: T, name: 'local' }, { deviceId: 'st-2', collectedAt: T }],
    [{ deviceId: 'st-1', collectedAt: T + 5000, name: 'edge' }, { deviceId: 'st-2', collectedAt: new Date(T - 1000).toISOString() }, { name: 'no-id' }],
  ]);
  assert.equal(rows.filter((r) => r.deviceId === 'st-1').length, 1);
  assert.equal(rows.find((r) => r.deviceId === 'st-1').name, 'edge');
  assert.equal(rows.filter((r) => r.deviceId === 'st-2').length, 1);
  assert.equal(rows.find((r) => r.deviceId === 'st-2').collectedAt, T, 'ISO 로 온 더 오래된 스냅샷이 이기면 안 된다');
  assert.ok(rows.some((r) => r.name === 'no-id'), 'deviceId 없는 원소를 조용히 버리지 않는다');
});

test('AUTHZ-2599-03: maskDeviceAddress — host·계정·지문 계정명·오류 속 주소를 비우고 원본은 그대로', () => {
  const d = { id: 'x', name: '10.9.9.9', host: '10.9.9.9', username: 'svc', snap: { error: 'connect ECONNREFUSED 10.9.9.9:22', extra: { credFp: { user: 'svc', len: 8, hash: 'abcd' } } } };
  const m = maskDeviceAddress(d);
  assert.equal(m.host, ''); assert.equal(m.username, ''); assert.ok(m.name && !m.name.includes('10.9.9.9'), m.name);
  assert.equal(m.snap.extra.credFp.user, ''); assert.equal(m.snap.extra.credFp.hash, 'abcd');
  assert.ok(!m.snap.error.includes('10.9.9.9'), m.snap.error);
  assert.equal(d.host, '10.9.9.9', '원본을 바꾸면 admin 응답까지 가려진다');
  assert.equal(d.snap.extra.credFp.user, 'svc');
  const s = maskSnapAddress({ host: 'h1', name: 'sw', errors: { a: 'h1 down' } });
  assert.equal(s.host, ''); assert.equal(s.name, 'sw'); assert.ok(!s.errors.a.includes('h1'));
});

test('AUTHZ-2599-02: vcenterScopeIssue — 범위 밖 지정만 거부, 빈 값·전체 범위는 통과', () => {
  const allowed = new Set(['vc-a']);
  assert.equal(vcenterScopeIssue(allowed, 'vc-a'), null);
  assert.ok(vcenterScopeIssue(allowed, 'vc-b'));
  assert.equal(vcenterScopeIssue(allowed, ''), null);
  assert.equal(vcenterScopeIssue(null, 'vc-b'), null);
});

/* ── 실제 라우터 ─────────────────────────────────────────────────────────── */

test('실제 라우터 — 역할·범위별 응답(01·02·03·04·05·06·EDGE-02)', () => {
  const r = runLive(`
    const [A, B] = vcs;
    const vmA = snap.vms.find((v) => v.vcenterId === A);
    const vmB = snap.vms.find((v) => v.vcenterId === B);
    // 범위 밖(B) 잡 하나 + 범위 안(A) 잡 하나
    const jobB = vmclone.saveJob({ vcenterId: B, vmId: vmB.id, vmName: vmB.name, dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 1 });
    const jobA = vmclone.saveJob({ vcenterId: A, vmId: vmA.id, vmName: vmA.name, dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 1 });
    osStore.upsertOs(vmA, { os: 'Linux' }); osStore.upsertOs(vmB, { os: 'Linux' });
    const stType = STORAGE_TYPES.find((t) => t.implemented).type;
    const swType = SAN_SWITCH_TYPES.find((t) => t.implemented).type;
    storageReg.saveDevice({ type: stType, name: 'ST1', host: '10.20.0.50', username: 'stadmin', password: 'p' });
    sanReg.saveDevice({ type: swType, name: 'SW1', host: '10.20.0.51', username: 'swadmin', password: 'p' });
    pduReg.saveDevice({ name: 'PDU1', host: '10.20.0.52', username: 'apc', password: 'p' });

    const sadmin = await start(mk({ username: 'sadmin', role: 'admin', scope: { vcenters: [A] } }));
    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));

    const hijack = await req(sadmin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ id: jobB.id, vcenterId: A, vmId: vmA.id, vmName: vmA.name, dest: { type: 'datastore', datastoreName: 'x' }, schedule: { mode: 'manual' }, keep: 1 }) });
    const afterHijack = vmclone.listJobs().find((j) => j.id === jobB.id);
    const moveVc = await req(admin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ id: jobA.id, vcenterId: B, vmId: vmB.id, vmName: vmB.name, dest: { type: 'datastore', datastoreName: 'x' }, schedule: { mode: 'manual' }, keep: 1 }) });
    const editOk = await req(sadmin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ id: jobA.id, vcenterId: A, vmId: vmA.id, vmName: vmA.name, dest: { type: 'datastore', datastoreName: 'y' }, schedule: { mode: 'manual' }, keep: 2 }) });
    const vmMismatch = await req(admin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ vcenterId: A, vmId: vmB.id, vmName: vmB.name, dest: { type: 'datastore', datastoreName: 'x' }, schedule: { mode: 'manual' }, keep: 1 }) });
    const cloneListS = await req(sadmin, '/api/tools/vm-clone');
    const cloneListF = await req(admin, '/api/tools/vm-clone');
    const osS = await req(sadmin, '/api/admin/os-scan/results');
    const osSB = await req(sadmin, '/api/admin/os-scan/results?vcenterId=' + encodeURIComponent(B));
    const osF = await req(admin, '/api/admin/os-scan/results');

    const osStS = await req(sadmin, '/api/admin/os-scan');
    const osStF = await req(admin, '/api/admin/os-scan');
    const osRunOut = await req(sadmin, '/api/admin/os-scan/run', { method: 'POST', body: JSON.stringify({ vcenterId: B }) });
    const osRunNone = await req(sadmin, '/api/admin/os-scan/run', { method: 'POST', body: JSON.stringify({}) });
    const probeOut = await req(sadmin, '/api/remote/probe', { method: 'POST', body: JSON.stringify({ vcenterId: B, targetHost: vmA.name }) });
    const probeIn = await req(sadmin, '/api/remote/probe', { method: 'POST', body: JSON.stringify({ vcenterId: A, targetHost: vmA.name }) });
    const qcOut = await req(sadmin, '/api/remote/quick-connect', { method: 'POST', body: JSON.stringify({ vcenterId: B, targetHost: vmA.name }) });

    // 형제 경로(작업 로그·점검)까지 보려고 목 수집을 한 번 돌린다.
    const swId = sanReg.listDevices()[0].id; const stId = storageReg.listDevices()[0].id;
    await (await import(${J('sanswitch/poller.js')})).collectDeviceNow(swId).catch(() => {});
    await (await import(${J('storage/poller.js')})).collectDeviceNow(stId).catch(() => {});
    const lists = {};
    for (const [who, base] of [['admin', admin], ['oper', oper]]) {
      lists[who] = {
        storage: await req(base, '/api/tools/storage'),
        san: await req(base, '/api/tools/sanswitch'),
        pdu: await req(base, '/api/tools/pdu'),
        stAct: await req(base, '/api/tools/storage/activity'),
        swAct: await req(base, '/api/tools/sanswitch/activity'),
        swPorts: await req(base, '/api/tools/sanswitch/devices/' + swId + '/ports'),
        swHc: await req(base, '/api/tools/sanswitch/devices/' + swId + '/healthcheck'),
        swHcAll: await req(base, '/api/tools/sanswitch/healthcheck-all'),
      };
    }

    const scopedKey = keys.issueApiKey({ name: 's', groups: ['inventory'], vcenters: [A] }).plaintext;
    const fullKey = keys.issueApiKey({ name: 'f', groups: ['inventory', 'capacity'] }).plaintext;
    const v1get = async (p, k) => { const x = await fetch(v1base + '/api/v1' + p, { headers: { 'X-Api-Key': k } }); return { status: x.status, body: await x.json() }; };
    const colS = await v1get('/inventory/collection', scopedKey);
    const colF = await v1get('/inventory/collection', fullKey);

    // EDGE2599-02: 같은 장비가 로컬과 엣지 양쪽에 있을 때 공개 API 는 한 행
    const stDev = storageReg.listDevices()[0];
    const stStore = await import(${J('storage/store.js')});
    const edge = await import(${J('central/storageEdge.js')});
    const T = Date.now();
    if (stStore.putSnapshot) stStore.putSnapshot({ deviceId: stDev.id, name: 'ST1', type: stDev.type, collectedAt: T - 60000, ok: true, capacity: { totalBytes: 100, usedBytes: 10 } });
    edge.saveEdgeStorage('e1', [{ deviceId: stDev.id, name: 'ST1', type: stDev.type, collectedAt: T, ok: true, capacity: { totalBytes: 100, usedBytes: 20 } }]);
    const localCount = stStore.localSnapshots().filter((s) => s.deviceId === stDev.id).length;
    const cap = await v1get('/capacity/storage', fullKey);

    return {
      A, B, jobB, hijack, afterHijack, moveVc, editOk, vmMismatch,
      cloneListS: cloneListS.body, cloneListF: cloneListF.body,
      osStS: osStS.body, osStF: osStF.body, osRunOut, osRunNone,
      osS: osS.body, osSB: osSB.body, osF: osF.body,
      probeOut, probeIn, qcOut, lists, colS, colF, vcCount: vcs.length, localCount, cap,
    };
  `);

  // AUTHZ-2599-01 — 범위 밖 잡 가로채기 403, 잡은 그대로
  assert.equal(r.hijack.status, 403, JSON.stringify(r.hijack.body));
  assert.equal(r.afterHijack.vcenterId, r.B, '범위 밖 잡이 재지정됐다');
  assert.equal(r.moveVc.status, 400, '기존 잡의 vCenter 변경은 거부');
  assert.equal(r.editOk.status, 201, '범위 안 잡 수정은 그대로 된다');
  // AUTHZ-2599-06 — 다른 vCenter 의 VM
  assert.equal(r.vmMismatch.status, 400, JSON.stringify(r.vmMismatch.body));
  // AUTHZ-2599-05 — 범위 밖 항목 제외 + 개수 밝힘
  assert.ok(r.cloneListS.jobs.every((j) => j.vcenterId === r.A), '범위 밖 잡이 나갔다');
  assert.equal(r.cloneListS.omittedOutOfScope, 1);
  assert.equal(r.cloneListF.jobs.length, 2);
  assert.ok(r.osS.items.length >= 1 && r.osS.items.every((x) => x.vcenterId === r.A));
  assert.equal(r.osS.omittedOutOfScope, 1);
  assert.equal(r.osSB.items.length, 0, '?vcenterId 로 범위 밖을 지정해도 안 나온다');
  assert.equal(r.osF.items.length, 2);
  // 후속: os-scan 상태 요약은 범위 기준, 함대 실행 결과는 가림 · 즉시 스캔은 범위 안 하나만
  assert.equal(r.osStS.summary.scanned, 1);
  assert.equal(r.osStF.summary.scanned, 2);
  assert.equal(r.osStS.fleetRunHidden, true);
  assert.equal(r.osStS.lastAuth, null);
  assert.equal(r.osRunOut.status, 404, JSON.stringify(r.osRunOut.body));
  assert.equal(r.osRunNone.status, 400);
  // AUTHZ-2599-02 — 범위 밖 vCenter 지정은 404, 프록시 이름이 응답에 없다
  assert.equal(r.probeOut.status, 404, JSON.stringify(r.probeOut.body));
  assert.equal(r.probeOut.body.proxyName, undefined);
  assert.equal(r.qcOut.status, 404);
  assert.notEqual(r.probeIn.status, 404, '범위 안 vCenter 는 막지 않는다');
  // AUTHZ-2599-03 — operator 에는 주소·계정이 없고 addressHidden, admin 은 그대로
  for (const k of ['storage', 'san', 'pdu']) {
    const o = r.lists.oper[k]; const a = r.lists.admin[k];
    assert.equal(o.status, 200, k + ' 조회 자체는 열려 있다');
    assert.equal(o.body.addressHidden, true, k);
    const txt = JSON.stringify(o.body.devices);
    assert.ok(!/10\.20\.0\.5\d/.test(txt), k + ' 관리 IP 가 샜다: ' + txt.slice(0, 300));
    assert.ok(!/stadmin|swadmin|"apc"/.test(txt), k + ' 계정명이 샜다');
    assert.ok(o.body.devices.length >= 1 && o.body.devices[0].name, k + ' 이름·목록은 남는다');
    assert.equal(a.body.addressHidden, undefined);
    assert.match(JSON.stringify(a.body.devices), /10\.20\.0\.5\d/);
  }
  // 형제 경로 — 작업 로그·포트 상세·점검 결과도 같은 기준(Chromium 판독에서 작업 로그로 새는 것을 발견했다)
  for (const k of ['stAct', 'swAct', 'swPorts', 'swHc', 'swHcAll']) {
    const o = r.lists.oper[k]; const a = r.lists.admin[k];
    assert.equal(o.status, 200, k + ' ' + JSON.stringify(o.body).slice(0, 200));
    assert.ok(!/10\.20\.0\.5\d|stadmin|swadmin/.test(JSON.stringify(o.body)), k + ' 주소·계정이 샜다');
    assert.match(JSON.stringify(a.body), /10\.20\.0\.5\d/, k + ' admin 은 그대로 본다(수집이 돌았는지 확인)');
  }
  // AUTHZ-2599-04 — 범위 키는 범위 vCenter 만 센다
  assert.equal(r.colS.status, 200);
  assert.equal(r.colS.body.data.registered, 1);
  assert.equal(r.colS.body.meta.scopedToVcenters, 1);
  assert.equal(r.colF.body.data.registered, r.vcCount);
  // EDGE2599-02 — 한 장비 한 행(최신 = 엣지 20)
  assert.equal(r.localCount, 1, '로컬 스냅샷이 심어져야 중복 경우를 본다');
  assert.equal(r.cap.status, 200);
  const rows = r.cap.body.data.filter((x) => x.name === 'ST1');
  assert.equal(rows.length, 1, JSON.stringify(r.cap.body.data));
  assert.equal(rows[0].usedBytes, 20);
});

test('AUTHZ-2599-05 후속: scopeCloneStatus — running·queued 잡 id 를 보이는 잡으로 좁힌다', async () => {
  const { scopeCloneStatus } = await import('../src/routes/api/vmClone.js');
  const all = [{ id: 'a' }, { id: 'b' }];
  const vis = [{ id: 'a' }];
  const st = { lastTick: 1, running: { jobId: 'b', phase: '복제' }, queued: ['a', 'b'] };
  const out = scopeCloneStatus(st, vis, all);
  assert.equal(out.running, null);
  assert.equal(out.runningOutOfScope, true);
  assert.deepEqual(out.queued, ['a']);
  assert.equal(out.queuedOutOfScope, 1);
  assert.equal(scopeCloneStatus(st, all, all), st, '전체 범위는 그대로');
  const own = scopeCloneStatus({ running: { jobId: 'a' }, queued: [] }, vis, all);
  assert.equal(own.running.jobId, 'a'); assert.equal(own.runningOutOfScope, false);
});
