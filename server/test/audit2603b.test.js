/**
 * v2.603 감사 — 권한·가림·NSX 경로 그룹(b) 회귀 고정.
 *
 *  - AUTHZ-2603-01  /tools/license-expiry 가 범위 계정에 범위 밖 NSX 라이선스 키·Horizon 라이선스·오류(호스트명)를 줬다
 *  - AUTHZ-2603-02  SAN 월간 점검 items[].detail · 이력 runs[].items[].detail 이 비-admin 에 관리 주소를 실었다
 *  - AUTHZ-2603-03  /tools/pdu/db-stats 가 /tools/pdu/:id 에 가려 도달 불가 — 살리면서 DB 절대 경로는 admin 에게만
 *  - LEFT2603-01    NSX group-members 가 groupId 를 첫 콜론에서 잘라 콜론 있는 매니저 id 에서 엉뚱한 그룹을 조회했다
 *  - RECENT2603-04  스토리지 연결 테스트 counts.alerts/nodes 의 null 을 0 으로 바꿨다
 *
 * ⚠ 검증 방식: 라우트는 **실제 api 라우터를 express 에 띄워 역할·범위별 응답으로** 본다. admin 응답에 가릴 값이
 *   실제로 있는지도 확인한다(가릴 것이 없어서 통과하는 공허한 테스트 방지). 기준 시각은 고정값이다(CLAUDE.md v2.517).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskSnapAddress, scrubStringsDeep } from '../src/auth/addressMask.js';
import { splitNsxGroupId } from '../src/routes/api/overviewNsx.js';
import { testCounts } from '../src/routes/api/storageMon.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (p) => JSON.stringify(path.join(SRC, p));
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % 3_600_000) - 30 * 60_000; // 정시 −30분 고정

/* ── 순수 ─────────────────────────────────────────────────────────────────── */

test('LEFT2603-01: splitNsxGroupId — 콜론 있는 매니저 id 는 그 접두만 떼고, 없을 때는 등록부 최장 일치 → 첫 콜론', () => {
  assert.deepEqual(splitNsxGroupId('kr:nsx01:grp-web', 'kr:nsx01'), { managerId: 'kr:nsx01', rawId: 'grp-web' });
  assert.deepEqual(splitNsxGroupId('kr:nsx01:grp-web', '', ['kr', 'kr:nsx01']), { managerId: 'kr:nsx01', rawId: 'grp-web' });
  // 예전 동작 보존: 콜론 없는 매니저 · 원 id 만 넘긴 호출 · managerId 없는 경우 첫 콜론
  assert.deepEqual(splitNsxGroupId('m1:grp-a', 'm1'), { managerId: 'm1', rawId: 'grp-a' });
  assert.deepEqual(splitNsxGroupId('grp-a', 'm1'), { managerId: 'm1', rawId: 'grp-a' });
  assert.deepEqual(splitNsxGroupId('m1:grp-a', undefined, []), { managerId: 'm1', rawId: 'grp-a' });
  assert.deepEqual(splitNsxGroupId('', ''), { managerId: '', rawId: '' });
});

test('RECENT2603-04: testCounts — 못 읽은 노드·경보는 null 그대로(0 아님), 보고된 0 은 0', () => {
  assert.deepEqual(testCounts({ nodes: { count: null }, alerts: { unresolved: null }, pools: [], accounts: [] }),
    { nodes: null, pools: 0, accounts: 0, alerts: null });
  assert.deepEqual(testCounts({}), { nodes: null, pools: 0, accounts: 0, alerts: null });
  assert.deepEqual(testCounts({ nodes: { count: 0 }, alerts: { unresolved: 0 }, pools: [{}], accounts: [{}, {}] }),
    { nodes: 0, pools: 1, accounts: 2, alerts: 0 });
});

test('AUTHZ-2603-02: maskSnapAddress 가 점검 결과 items[].detail 의 주소도 가린다 · scrubStringsDeep 은 트리 전부', () => {
  const r = { host: 'sansecret.invalid', name: 'sw1', items: [{ key: 'hw', detail: '수집 자체가 실패: getaddrinfo ENOTFOUND sansecret.invalid' }] };
  const m = maskSnapAddress(r);
  assert.ok(!JSON.stringify(m).includes('sansecret'), JSON.stringify(m));
  assert.ok(r.items[0].detail.includes('sansecret'), '원본을 바꾸지 않는다');
  const h = scrubStringsDeep({ runs: [{ items: [{ detail: 'x sansecret.invalid y' }] }], compare: { changes: [{ detail: 'sansecret.invalid' }] }, n: 3 }, ['sansecret.invalid']);
  assert.ok(!JSON.stringify(h).includes('sansecret'));
  assert.equal(h.n, 3);
});

/* ── 실제 라우터 ─────────────────────────────────────────────────────────── */

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2603b-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const { nsxStore } = await import(${J('nsx/store.js')});
    const hz = await import(${J('horizon/horizon.js')});
    const sanReg = await import(${J('sanswitch/registry.js')});
    const sanStore = await import(${J('sanswitch/store.js')});
    await store.refresh({ force: true });
    const snap = store.get();
    const vcs = snap.vcenters.map((v) => v.id);
    const mk = (user) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api', api);
      return app;
    };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p, init) => {
      const r = await fetch(base + p, init);
      const text = await r.text();
      let b = null; try { b = JSON.parse(text); } catch {}
      return { status: r.status, body: b, text };
    };
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)} ${r.stderr?.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

test('실제 라우터 — license-expiry 범위 거름 · SAN 점검 주소 가림 · pdu db-stats 도달+경로 가림 · NSX 콜론 매니저', () => {
  const r = runLive(`
    const [A, B] = vcs;
    nsxStore.snapshot = { ...nsxStore.get(), managers: [
      { id: 'm-a', vcenterId: A, name: 'nsx-in-scope', version: '4.1', licenses: [{ key: 'IN-SCOPE-KEY-1', description: 'NSX DC', quantity: 1 }] },
      { id: 'm-b', vcenterId: B, name: 'nsx-out-of-scope', version: '4.1', licenses: [{ key: 'EUROPE-SECRET-KEY-11111', description: 'NSX DC', quantity: 1 }] },
    ] };
    hz.upsertHorizon({ id: 'hz1', name: 'hz1', host: 'https://hzsecret.invalid', username: 'u', password: 'p', domain: 'd' });
    const dev = sanReg.saveDevice({ type: 'brocade', name: 'sw1', host: 'sansecret.invalid', username: 'admin', password: 'pw', collectMethod: 'ssh' });
    sanStore.putSnapshot({ deviceId: dev.id, ok: false, error: 'getaddrinfo ENOTFOUND sansecret.invalid', host: 'sansecret.invalid', name: 'sw1', collectedAt: ${T0}, sections: {} });

    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const oper = await start(mk({ username: 'op', role: 'operator', scope: null }));
    const sop = await start(mk({ username: 'sop', role: 'operator', scope: { vcenters: [A] } }));

    const lic = {};
    for (const [who, b] of [['admin', admin], ['oper', oper], ['sop', sop]]) {
      const x = await req(b, '/api/tools/license-expiry');
      lic[who] = { status: x.status, outKey: x.text.includes('EUROPE-SECRET'), inKey: x.text.includes('IN-SCOPE-KEY'), outName: x.text.includes('nsx-out-of-scope'),
        hzHost: x.text.includes('hzsecret'), hzErr: (x.body?.collectionErrors || []).some((e) => e.startsWith('Horizon')),
        horizonServers: x.body?.horizonServers, omitted: x.body?.omittedOutOfScope, scoped: x.body?.scoped };
    }

    const san = {};
    for (const [who, b] of [['admin', admin], ['oper', oper]]) {
      const h = await req(b, '/api/tools/sanswitch/devices/' + dev.id + '/healthcheck');
      const hi = await req(b, '/api/tools/sanswitch/devices/' + dev.id + '/healthcheck/history');
      const all = await req(b, '/api/tools/sanswitch/healthcheck-all');
      san[who] = { h: [h.status, (h.text.match(/sansecret/g) || []).length], hi: [hi.status, (hi.text.match(/sansecret/g) || []).length, hi.body?.runs?.length || 0],
        all: [all.status, (all.text.match(/sansecret/g) || []).length], items: h.body?.result?.items?.length || 0 };
    }

    const pa = await req(admin, '/api/tools/pdu/db-stats');
    const po = await req(oper, '/api/tools/pdu/db-stats');
    const pdu = { admin: [pa.status, pa.body?.ok, 'file' in (pa.body?.stats || {})], oper: [po.status, po.body?.ok, 'file' in (po.body?.stats || {}), po.text.includes(${JSON.stringify(path.sep)} + 'pdu'), po.body?.pathHidden] };

    const g = await req(admin, '/api/nsx/group-members?managerId=' + encodeURIComponent('kr:nsx01') + '&groupId=' + encodeURIComponent('kr:nsx01:grp-web'));
    const nsx = { status: g.status, first: g.body?.vms?.[0]?.name || '' };
    return { lic, san, pdu, nsx };
  `);

  // AUTHZ-2603-01 — admin 은 원문(공허 방지), 범위 계정은 범위 안만 + 뺀 수를 밝힌다
  assert.equal(r.lic.admin.status, 200);
  assert.ok(r.lic.admin.outKey && r.lic.admin.inKey, 'admin 은 두 NSX 키를 다 본다');
  assert.ok(r.lic.admin.hzErr, `Horizon 수집 오류가 admin 에 실려야 공허하지 않다: ${JSON.stringify(r.lic.admin)}`);
  assert.equal(r.lic.sop.status, 200);
  assert.equal(r.lic.sop.outKey, false, '범위 밖 NSX 키가 범위 계정에 나갔다');
  assert.equal(r.lic.sop.outName, false);
  assert.equal(r.lic.sop.inKey, true, '범위 안 NSX 키는 그대로');
  assert.equal(r.lic.sop.hzHost, false); assert.equal(r.lic.sop.hzErr, false);
  assert.equal(r.lic.sop.horizonServers, null);
  assert.equal(r.lic.sop.scoped, true);
  assert.deepEqual(r.lic.sop.omitted, { nsxManagers: 1, nsxLicenses: 1, horizon: true });
  // 전체 범위 operator: NSX 는 전부, Horizon 오류 문구 속 호스트명만 가린다
  assert.ok(r.lic.oper.outKey && r.lic.oper.hzErr);
  assert.equal(r.lic.oper.hzHost, false, '비-admin 에 Horizon 호스트명이 나갔다');

  // AUTHZ-2603-02 — admin 에는 실제로 주소가 있고(공허 방지) operator 에는 0회
  assert.equal(r.san.admin.h[0], 200); assert.ok(r.san.admin.h[1] > 0 && r.san.admin.items > 0, JSON.stringify(r.san.admin));
  assert.ok(r.san.admin.hi[1] > 0, `admin 이력에 주소가 있어야 한다: ${JSON.stringify(r.san.admin)}`);
  assert.ok(r.san.admin.all[1] > 0);
  assert.deepEqual([r.san.oper.h[0], r.san.oper.h[1]], [200, 0], `healthcheck: ${JSON.stringify(r.san.oper)}`);
  assert.deepEqual([r.san.oper.hi[0], r.san.oper.hi[1]], [200, 0], `history: ${JSON.stringify(r.san.oper)}`);
  assert.ok(r.san.oper.hi[2] > 0, '이력은 그대로 준다(가림이지 거부가 아니다)');
  assert.deepEqual(r.san.oper.all, [200, 0], `healthcheck-all: ${JSON.stringify(r.san.oper)}`);

  // AUTHZ-2603-03 — 도달 가능 + 경로는 admin 만
  assert.deepEqual(r.pdu.admin, [200, true, true], JSON.stringify(r.pdu));
  assert.deepEqual(r.pdu.oper.slice(0, 4), [200, true, false, false], JSON.stringify(r.pdu));
  assert.equal(r.pdu.oper[4], true);

  // LEFT2603-01 — 목 경로는 원 그룹 id 로 이름을 짓는다('grp-web' → 'grp-web-vm-1', 예전 'nsx01:gr-vm-1')
  assert.equal(r.nsx.status, 200);
  assert.equal(r.nsx.first, 'grp-web-vm-1');
});
