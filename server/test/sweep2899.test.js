/**
 * v2.899 전체 점검(5축 + 반증 1인) 확정분 — 보안 · 범위(S1~S4). 실제 라우트 체인을 가짜 사용자로 부른다(sweep1 재현 하네스와 같은 방식).
 *  S1 서비스 인벤토리 전 법인 공용 쓰기 — 쓰기 범위가 지정된 관리자는 403(fleetAdmin = 조회 무제한 ∧ 쓰기 무제한)
 *  S2 백업 서머리 메일 알림 저장 — 쓰기 범위가 지정된 관리자는 403(형제 bareos-backup digest 와 같은 판정)
 *  S3 저장한 관리자 계정명(savedBy)은 관리자 판본에만(사용자 결정) — 데모 계정 · operator 에게 가린다
 *  S4 볼륨 즉시 조회 기억 열쇠에 데모 여부
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep2899-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { store } = await import('../src/store.js');
const sm = await import('../src/servicemap/store.js');
const { registerSvcInventory } = await import('../src/routes/api/svcInventory.js');
const { registerBareosBackup } = await import('../src/routes/api/bareosBackup.js');
const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
const { saveHealthCfg } = await import('../src/bareos/health.js');
const { saveDigest } = await import('../src/bareos/digest.js');

const routes = new Map();
const api = {};
for (const m of ['get', 'post', 'put', 'delete', 'patch']) api[m] = (p, ...h) => { routes.set(`${m.toUpperCase()} ${p}`, h.flat()); };
api.use = () => {};
registerSvcInventory(api); registerBareosBackup(api); registerBackupStatus(api);

async function call(key, { user, query = {}, body = {} } = {}) {
  const chain = routes.get(key);
  assert.ok(chain, `no route ${key}`);
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, get(k) { return this.headers[k]; },
    end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; }, on() {}, once() {} };
  const req = { user, query, body, params: {}, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: key.replace(/^\w+ /, '/api'), url: key.replace(/^\w+ /, '/api'), get: () => undefined, socket: {} };
  let i = 0;
  const next = async (e) => { if (e) throw e; const h = chain[i++]; if (!h || res.headersSent) return; await h(req, res, next); };
  await next();
  return res;
}
const WL_ADMIN = { username: 'wl-admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: ['vc-a'] } };
const FULL_ADMIN = { username: 'root-admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const DEMO = { username: 'thedvcdemp', role: 'admin', demoGuest: true, scope: { vcenters: [], regions: [], writeVcenters: [] } };
const OPER = { username: 'oper', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };

fs.writeFileSync(path.join(tmp, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-a', name: 'A', host: 'a.example' }, { id: 'vc-b', name: 'B', host: 'b.example' }] }));
fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: 'Service' }, corps: {} }));
fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
sm._resetForTest();
store.snapshot = { ...(store.snapshot || {}), generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }], hosts: [], vms: [], datastores: [], alarms: [] };

test('S1 서비스 인벤토리 전 법인 공용 쓰기 — 쓰기 범위가 지정된 관리자는 403 · 전체 범위 관리자는 통과', async () => {
  for (const body of [{ op: 'settings.tagCategory', value: 'X' }, { op: 'global.add', name: 'G' }, { op: 'corp.purge', corp: 'vc-gone' }]) {
    const r = await call('POST /tools/svc-inventory/op', { user: WL_ADMIN, body });
    assert.equal(r.statusCode, 403, `${body.op}: ${JSON.stringify(r.body)}`);
  }
  const ok = await call('POST /tools/svc-inventory/op', { user: FULL_ADMIN, body: { op: 'settings.tagCategory', value: 'Service2' } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
});

test('S2 백업 서머리 메일 알림 저장 — 쓰기 범위가 지정된 관리자는 403(형제 digest 와 같은 판정)', async () => {
  const r = await call('PUT /tools/backup-summary/alert', { user: WL_ADMIN, body: { enabled: true, time: '03:00', q: { n: 1, unit: 'd', src: 'all' } } });
  assert.equal(r.statusCode, 403);
  const d = await call('PUT /tools/bareos-backup/digest', { user: WL_ADMIN, body: { enabled: true, time: '03:00' } });
  assert.equal(d.statusCode, 403, '대조군');
});

test('S3 저장한 관리자 계정명은 관리자 판본에만 — 데모 계정 · operator 에게 가린다', async () => {
  const saved = await call('PUT /tools/backup-summary/alert', { user: FULL_ADMIN, body: { enabled: true, time: '03:00', q: { n: 1, unit: 'd', src: 'all' } } });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  saveHealthCfg({}, { by: 'root-admin' });
  saveDigest({ enabled: true, time: '08:30' }, { by: 'root-admin' });
  const op = await call('GET /tools/backup-summary/alert', { user: OPER });
  assert.equal(op.body.settings.savedBy, '', 'operator 에게 가린다');
  assert.equal((await call('GET /tools/backup-summary/alert', { user: FULL_ADMIN })).body.settings.savedBy, 'root-admin', '관리자에게는 보인다');
  for (const p of ['GET /tools/bareos-backup/health/settings', 'GET /tools/bareos-backup/digest']) {
    const r = await call(p, { user: DEMO });
    assert.equal(r.statusCode, 200, `${p} — 데모 계정은 mock 에서 adminOnly 를 통과한다(가림이 필요한 이유)`);
    assert.equal(r.body.config.savedBy, '', `${p} — 데모 계정`);
  }
  const adm = await call('GET /tools/bareos-backup/digest', { user: FULL_ADMIN });
  assert.equal(adm.body.config.savedBy, 'root-admin');
});

test('S4 볼륨 즉시 조회 기억 열쇠에 데모 여부가 들어간다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/bareosPolicy.js', import.meta.url), 'utf8');
  assert.match(src, /const k = `\$\{isDemoGuest\(req\.user\) \? 'demo' : 'real'\}\|\$\{directorId\}\|\$\{pool\}`;/);
});

test('P1 사용자 문서 파일(이슈 · 게시판 · 위키)은 저장소 상한까지 백업에 담긴다(사용자 결정 — 백업 상한을 올림) · 다른 파일은 8MB', async () => {
  const B = await import('../src/backup/service.js');
  const { issuesMaxBytes } = await import('../src/issues/store.js');
  const { boardMaxBytes } = await import('../src/bulletin/store.js');
  const { wikiMaxBytes } = await import('../src/wiki/store.js');
  for (const [f, max] of [['issues.json', issuesMaxBytes()], ['board.json', boardMaxBytes()], ['wiki.json', wikiMaxBytes()]]) {
    assert.ok(B.fileCapFor(f) > max * 1.2, `${f}: 백업 상한 ${B.fileCapFor(f)} > 저장소 상한 ${max} + 여유`);
  }
  assert.equal(B.fileCapFor('svcmon.json'), 8 * 1024 * 1024);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
  fs.writeFileSync(path.join(dir, 'issues.json'), JSON.stringify({ issues: [{ body: 'x'.repeat(9.5 * 1024 * 1024) }] }));
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ v: 'y'.repeat(9 * 1024 * 1024) }));
  const out = await B.collectConfigDirAsync(dir);
  const skipped = Object.getOwnPropertySymbols(out).flatMap((k) => out[k] || []).concat(Object.values(out).find(Array.isArray) || []);
  const names = Object.keys(out);
  assert.ok(names.some((n) => n.includes('issues.json')), `issues.json 이 담겼다 — ${names.join(',')}`);
  assert.ok(!names.some((n) => n.includes('other.json')), '다른 파일은 8MB 상한 그대로');
  void skipped;
  fs.rmSync(dir, { recursive: true, force: true });
});
