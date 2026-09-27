// v2.628 감사 그룹 A(리드) — 보안(SEC2628-01~05)·법인 귀속(C2628-01·02)·법인별 사용량(C2628-03·04·06, R2628-02·04·05) 회귀 고정.
//   라우트 게이트는 실제 라우터를 express 에 띄워 **상태코드**로 본다(AUTH_ENABLED=true — 꺼져 있으면 requireRole 이 모두 통과한다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2628a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

let srv, base;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};
before(async () => {
  const express = (await import('express')).default;
  const { upgradeRouter } = await import('../src/routes/upgrade.js');
  const { capacityRouter } = await import('../src/routes/capacity.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/upgrade', upgradeRouter);
  app.use('/api/capacity', capacityRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

test('SEC2628-01: 업그레이드 제어는 범위 관리자에 403 · 전체 범위 admin 은 통과', async () => {
  for (const [m, p, body] of [['GET', '/upgrade/status'], ['GET', '/upgrade/detect-install'], ['GET', '/upgrade/settings'],
    ['PUT', '/upgrade/settings', { autoApply: false }], ['POST', '/upgrade/apply', {}], ['POST', '/upgrade/check', {}]]) {
    const r = await call('sadm', m, p, body);
    assert.equal(r.s, 403, `${m} ${p} 범위 관리자 403 (받은 ${r.s} ${r.t.slice(0, 100)})`);
    assert.equal(r.j?.error, 'forbidden');
  }
  const ok = await call('full', 'GET', '/upgrade/status');
  assert.equal(ok.s, 200, ok.t.slice(0, 100));
});

test('SEC2628-05: /api/capacity 는 범위 관리자에 403', async () => {
  const r = await call('sadm', 'GET', '/capacity/hosts');
  assert.equal(r.s, 403, r.t.slice(0, 100));
  const f = await call('full', 'GET', '/capacity/hosts');
  assert.notEqual(f.s, 403);
});

test('SEC2628-04: AD 설정 조회·연결 테스트는 전체 범위 게이트를 거친다', async () => {
  const { authRouter } = await import('../src/routes/auth.js');
  const kinds = (p, method) => {
    const layer = authRouter.stack.find((l) => l.route?.path === p && l.route.methods[method]);
    assert.ok(layer, `${method} ${p} 라우트가 있어야 한다`);
    return layer.route.stack.map((s) => s.handle?.gate?.kind).filter(Boolean);
  };
  for (const [p, m] of [['/ad-config', 'get'], ['/ad-test', 'post'], ['/ad-config', 'put']]) {
    assert.ok(kinds(p, m).includes('fullScope'), `${m} ${p} 에 fullScope 게이트`);
  }
});

test('SEC2628-02·03·R2628-05: 배포 제외 판정은 자기 속성만 · 미검증 인출은 검증 기록을 덮지 않는다 · 전달됨', async () => {
  const S = await import('../src/bmusage/settings.js');
  S._resetForTest();
  S.saveDistribution({ enabled: true, excluded: {} }, 't');
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const d = S.distributeFor(name);
    assert.equal(d.distribute, true, `${name} 은 제외가 아니다`);
  }
  // 제외 목록에 '__proto__' 를 적어도 프로토타입을 바꾸지 않는다.
  const n = S.normalizeDistribution({ excluded: JSON.parse('{"__proto__": true, "edge-x": true}') });
  assert.equal(Object.getPrototypeOf(n.excluded), null);
  assert.equal(S.distributeFor('edge-x').distribute, true, '저장하지 않은 정규화는 판정에 영향 없음');
  // 검증된 기록 → 미검증 인출이 덮지 않는다
  const cur = S.distributeFor('edge-a').sig;
  S.recordBmUsagePull('Edge-A', { appliedSig: 'old', verified: true });
  S.recordBmUsagePull('edge-a', { appliedSig: cur, verified: false });
  let row = S.distributionStatus(['Edge-A']).rows[0];
  assert.equal(row.state, 'pending', '공유 토큰 인출이 검증 기록을 "적용됨" 으로 위장하지 못한다');
  assert.equal(row.verified, true);
  // 미검증만 있는 이름은 verified:false 로 밝힌다
  S.recordBmUsagePull('edge-b', { appliedSig: '', verified: false });
  assert.equal(S.distributionStatus([]).rows.find((r) => r.agent === 'edge-b').verified, false);
  // 방금 지금 판을 내려받았으면 '전달됨'
  S.recordBmUsagePull('Edge-A', { appliedSig: 'old', verified: true, deliveredSig: cur });
  row = S.distributionStatus(['Edge-A']).rows[0];
  assert.equal(row.state, 'delivered');
  S.recordBmUsagePull('Edge-A', { appliedSig: cur, verified: true, deliveredSig: cur });
  assert.equal(S.distributionStatus(['Edge-A']).rows[0].state, 'applied');
});

test('C2628-01·02: IP 는 줄이지 않고 · 두 vCenter 에 걸린 짧은 이름은 판정 근거가 아니다', async () => {
  const { serversByCorp } = await import('../src/idrac/serverByCorp.js');
  const hosts = [{ name: '10.20.1.11', vcenterId: 'vcB' }];
  const servers = [
    { id: 's1', name: '10.30.0.5', host: '10.30.0.5', vcenterId: 'vcA' },
    { id: 's2', name: '10.40.0.6', host: '10.40.0.6', vcenterId: 'vcA' },
  ];
  const o = serversByCorp(servers, hosts);
  assert.equal(o.matchedCount, 0, '10.x IP 가 "10" 으로 줄어 ESXi 와 같은 장비로 판정되지 않는다');
  assert.equal(o.byVcenter.vcA, 2);
  assert.equal(o.physicalOnly, 2);
  // 짧은 이름 모호
  const hosts2 = [{ name: 'app01.corpa.local', vcenterId: 'vcA' }, { name: 'app01.corpb.local', vcenterId: 'vcB' }];
  const o2 = serversByCorp([{ id: 'x', name: 'app01.corpc.local' }], hosts2);
  assert.equal(o2.matchedCount, 0, '모호한 짧은 이름으로 중복·귀속을 판정하지 않는다');
  // 전체 이름이 같으면 여전히 맞는다
  const o3 = serversByCorp([{ id: 'y', name: 'app01.corpb.local' }], hosts2);
  assert.equal(o3.matchedCount, 1);
  assert.equal(o3.byVcenter.vcB, 1);
  // 짧은 이름이 한 vCenter 에만 있으면 FQDN iDRAC 과 맞는다(예전 동작 유지)
  const o4 = serversByCorp([{ id: 'z', name: 'esx9.corp.local' }], [{ name: 'esx9', vcenterId: 'vcC' }]);
  assert.equal(o4.matchedCount, 1);
});

test('C2628-03·04·06 · R2628-02·04: 법인별 사용량 판정', async () => {
  const { buildCorpUsage, judgeServer, srcOfRow } = await import('../src/corpusage/build.js');
  const NOW = 1_800_000_000_000;
  // 04: 읽히지 않는 vCenter 의 호스트 값은 지금 값이 아니다
  const host = { cpuUsagePct: 90, memUsagePct: 80, connectionState: 'CONNECTED' };
  assert.equal(judgeServer({ role: 'virt', host, now: NOW, freshMs: 1 }).state, 'ok');
  const j = judgeServer({ role: 'virt', host, now: NOW, freshMs: 1, vcUnread: 'stale' });
  assert.equal(j.state, 'stale');
  assert.equal(j.cpuPct, null);
  const o = buildCorpUsage({
    vcenters: [{ id: 'vc1', name: 'A' }], virtHosts: [{ name: 'esx1', fleetId: 'esx1', vcenterId: 'vc1', cpuCores: 32, memGB: 512 }],
    hostByKey: new Map([['vc1|esx1', host]]), now: NOW, freshMs: 60_000, unreadVcenters: new Map([['vc1', 'maintenance']]),
  });
  assert.equal(o.corps[0].virt.stale, 1);
  assert.equal(o.corps[0].virt.cpu.n, 0, '점검중 vCenter 의 옛 값이 합계에 들어가지 않는다');
  // 03: 다른 vCenter 의 같은 key → 행이 사라지지 않는다
  const o2 = buildCorpUsage({
    vcenters: [{ id: 'va', name: 'A' }, { id: 'vb', name: 'B' }],
    virtHosts: [{ name: 'esxi-01', fleetId: 'esxi-01', vcenterId: 'va', cpuCores: 8, memGB: 64 }, { name: 'esxi-01', fleetId: 'esxi-01', vcenterId: 'vb', cpuCores: 8, memGB: 64 }],
    rowsByKey: new Map([['esxi-01', { key: 'esxi-01', ts: NOW, src: 'idrac', cpu_pct: 50, mem_pct: 50 }]]),
    hostByKey: new Map([['vb|esxi-01', { cpuUsagePct: 10, memUsagePct: 20, connectionState: 'CONNECTED' }]]),
    now: NOW, freshMs: 60_000,
  });
  assert.deepEqual(o2.corps.map((c) => c.vcenterId).sort(), ['va', 'vb'], '두 법인 모두 행이 있다');
  const b = o2.corps.find((c) => c.vcenterId === 'vb').virt;
  assert.equal(b.keyConflict, 1);
  assert.equal(b.src.vcenter, 1, '겹친 키의 사용률 행을 붙이지 않고 그 vCenter 값을 쓴다');
  assert.equal(b.cpu.pct, 10);
  // 06: 행에 메모리가 없으면 vCenter 메모리로 채운다(지표별) · 물리 서버는 memMissing
  const j6 = judgeServer({ role: 'virt', row: { ts: NOW, src: 'idrac', cpu_pct: 40, mem_pct: null }, host, now: NOW, freshMs: 60_000 });
  assert.equal(j6.memPct, 80);
  assert.deepEqual(j6.filledFromVcenter, ['mem']);
  // R02: 행의 _freshMs 가 중앙 기준보다 우선
  const row = { ts: NOW - 45 * 60_000, src: 'idrac', cpu_pct: 50, mem_pct: 40 };
  assert.equal(judgeServer({ role: 'bm', row, now: NOW, freshMs: 30 * 60_000 }).state, 'stale');
  assert.equal(judgeServer({ role: 'bm', row: { ...row, _freshMs: 3 * 3_600_000 }, now: NOW, freshMs: 30 * 60_000 }).state, 'ok');
  // R04: 출처 합집합
  assert.equal(srcOfRow({ src: 'idrac+os' }), 'mixed');
  assert.equal(srcOfRow({ src: 'os' }), 'os');
  assert.equal(srcOfRow({ src: 'idrac' }), 'idrac');
  assert.equal(srcOfRow({ src: 'idrac-ent' }), 'idrac');
});

test('EDGE2628-01: 엣지 보관분 가져오기 기본 limit 은 상한(2,000)이다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/bmUsage.js', import.meta.url), 'utf8');
  assert.match(src, /pullBmUsage\(a, \{ limit: Number\(req\.body\?\.limit\) \|\| 2_000 \}\)/);
  const cu = fs.readFileSync(new URL('../src/routes/api/corpUsage.js', import.meta.url), 'utf8');
  assert.match(cu, /edgeTruncated/);
  assert.match(cu, /unreadVcenters/);
});
