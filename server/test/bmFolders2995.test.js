// 물리서버 폴더 v2.997 — 폴더 끌어 옮기기(folder.move: 같은 법인 안 · 부모만 · 하위 · 등록 · 법인 규칙 · 서비스 인벤토리 규칙 함께 · 가드)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmfolders95-'));
process.env.CONFIG_DIR = tmp;

const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerBmFolders } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');

const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg);
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const RO_B = { username: 'op-b', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: ['vc-b'] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}` }, res);
  return res;
}
let gen = 0;
const snapOf = () => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts: [], vms: [] });
const SRV = (id, name, tag, vc) => ({ id, name, host: `https://192.0.2.${10 + Number(id.replace(/\D/g, '') || 0)}`, username: 'root', password: 'x', serviceTag: tag, vcenterId: vc });
const S = (id, name) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '' });
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], bmFolderRules: [], tagEnabled: false, ...c });
function reset({ svc = {} } = {}) {
  bs._resetForTest(); sm._resetForTest();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: svc }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a'), SRV('s2', 'kr-app-01', 'TAG2', 'vc-a'), SRV('s3', 'pl-db-01', 'TAG3', 'vc-b')], 'replace');
}
const withSnap = async (fn) => { const prev = store.snapshot; try { store.snapshot = snapOf(); return await fn(); } finally { store.snapshot = prev; } };
const op = (body, user) => call('POST /tools/bm-folders/op', { body, user });
const foldersOf = (vc) => [...(bs.peekMain().corps[vc]?.folders || [])].sort();

test('옮기기 — 하위 폴더 · 등록 · 법인 규칙 · 서비스 인벤토리 규칙이 함께 · 법인 바로 아래로도', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s1', 'DP')], bmFolderRules: [{ prefix: 'Service\\SBP\\DP', serviceId: 's1' }] }) } });
  await withSnap(async () => {
    for (const p of ['Service\\SBP\\DP\\Airflow', 'AWX']) assert.equal((await op({ op: 'folder.add', corp: 'vc-a', path: p })).statusCode, 200);
    await op({ op: 'assign', path: 'Service\\SBP\\DP\\Airflow', keys: ['st:tag1'] });
    const ra = await op({ op: 'rule.add', corp: 'vc-a', value: 'kr-app', path: 'Service\\SBP\\DP' });
    assert.equal(ra.statusCode, 200, JSON.stringify(ra.body));
    const r = await op({ op: 'folder.move', corp: 'vc-a', path: 'Service\\SBP\\DP', parent: 'AWX' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.path, 'AWX\\DP'); assert.equal(r.body.result.moved, 1); assert.equal(r.body.result.svcRules, 1);
    assert.ok(foldersOf('vc-a').includes('AWX\\DP\\Airflow') && !foldersOf('vc-a').some((x) => x.startsWith('Service\\SBP\\DP')));
    assert.equal(bs.peekAssign()['st:tag1'].path, 'AWX\\DP\\Airflow');
    assert.deepEqual(bs.peekMain().rules.map((x) => x.path), ['AWX\\DP'], '법인 규칙 경로도 함께');
    assert.deepEqual(sm.peekMap().corps['vc-a'].bmFolderRules, [{ prefix: 'AWX\\DP', serviceId: 's1' }]);
    const root = await op({ op: 'folder.move', corp: 'vc-a', path: 'AWX\\DP', parent: '' });
    assert.equal(root.body.result.path, 'DP');
    assert.equal(bs.peekAssign()['st:tag1'].path, 'DP\\Airflow');
  });
});

test('가드 — 자기/하위 안 409 · 같은 이름 409 · 없는 곳 404 · parent 글자 아님 400 · 깊이 400 · 쓰기 밖 403 · 다른 법인 폴더는 그 법인에 없음 404', async () => {
  reset();
  await withSnap(async () => {
    for (const p of ['A\\B\\C', 'X\\B', 'L1\\L2\\L3\\L4\\L5\\L6\\L7\\L8\\L9']) await op({ op: 'folder.add', corp: 'vc-a', path: p });
    await op({ op: 'folder.add', corp: 'vc-b', path: 'OnlyB' });
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'A\\B\\C' })).statusCode, 409);
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'A\\B' })).statusCode, 409);
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'X' })).statusCode, 409, '같은 이름 B');
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'NOPE' })).statusCode, 404);
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'OnlyB' })).statusCode, 404, '다른 법인 폴더로는 못 옮긴다');
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 7 })).statusCode, 400);
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B' })).statusCode, 400);
    const deep = await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'L1\\L2\\L3\\L4\\L5\\L6\\L7\\L8\\L9' });
    assert.equal(deep.statusCode, 400, JSON.stringify(deep.body));
    assert.equal((await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'L1' }, RO_B)).statusCode, 403);
    assert.deepEqual(foldersOf('vc-a').filter((x) => x.startsWith('A')), ['A', 'A\\B', 'A\\B\\C'], '거절된 옮기기는 아무것도 바꾸지 않는다');
    const same = await op({ op: 'folder.move', corp: 'vc-a', path: 'A\\B', parent: 'A' });
    assert.equal(same.statusCode, 200); assert.equal(same.body.result.path, 'A\\B', '지금 자리 = 바꾸지 않음');
  });
});

test('서비스 인벤토리 규칙이 옮길 곳에서 겹치면 409(아무것도 쓰지 않음) — 이름 바꾸기와 같은 가드', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s1', 'A'), S('s2', 'B')], bmFolderRules: [{ prefix: 'P\\Q', serviceId: 's1' }, { prefix: 'R\\Q', serviceId: 's2' }] }) } });
  await withSnap(async () => {
    for (const p of ['P\\Q', 'R']) await op({ op: 'folder.add', corp: 'vc-a', path: p });
    const r = await op({ op: 'folder.move', corp: 'vc-a', path: 'P\\Q', parent: 'R' });
    assert.equal(r.statusCode, 409, JSON.stringify(r.body));
    assert.ok(foldersOf('vc-a').includes('P\\Q'));
  });
});
