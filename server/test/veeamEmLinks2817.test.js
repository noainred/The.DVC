/**
 * v2.817 — Veeam EM 연결 현황(사용자 신고 'EM 2대 이상인데 서버가 일부만 보인다' · 요청 'EM 마다 어떤 vCenter 와 연결돼 백업하는지').
 *  · 수집: GET /api/hierarchyRoots?format=Entity(⚠ 응답 모양은 문서 기준 추정) — 실패해도 다른 항목은 산다(섹션 사유)
 *  · 맞추기: 포탈 vCenter host(URL 호스트명) · 이름 **정확 일치** — 앞 마디만 같은 것('vc01.corpA'/'vc01.corpB')·IP 앞자리는 맞추지 않는다
 *  · 대조: same · diff · unmapped · none · unknown(루트를 못 읽음) · 서버 목록에 없는 루트 서버(orphanRoots)
 *  · 라우트: EM 2대가 모두 응답에 · 실패한 EM 의 상태 · 범위 계정 403 유지
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamEmLinks2817-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'kr:vc1', name: 'Seoul', host: 'https://vc01.corpa.local/sdk', username: 'u', password: 'p' },
  { id: 'us:vc2', name: 'NewYork', host: 'https://vc01.corpb.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const EP = await import('../src/veeam/em/parse.js');
const EV = await import('../src/veeam/em/view.js');
const EC = await import('../src/veeam/em/client.js');
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const ROOTS = { HierarchyRoots: [
  { Name: 'vc01.corpA.local', HostType: 'VC', UniqueId: 'u-1', UID: 'urn:veeam:HierarchyRoot:1', Links: [{ Rel: 'Up', Type: 'BackupServerReference', Name: 'VBR-KR' }] },
  { Name: 'esx-07.corpa.local', HostType: 'ESX', UID: 'urn:veeam:HierarchyRoot:2', Links: [{ Type: 'BackupServerReference', Name: 'VBR-KR' }] },
  { Name: 'vc-legacy.corp.local', HostType: 'VC', UID: 'urn:veeam:HierarchyRoot:3', Links: [{ Type: 'BackupServerReference', Name: 'VBR-OLD' }] },
  { HostType: 'VC' },
] };

test('A parse — hierarchyRootsOf(이름·종류·서버 링크 · 이름 없으면 버림) · isVcRoot', () => {
  const r = EP.hierarchyRootsOf(ROOTS);
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].name, r[0].hostType, r[0].server, r[0].uniqueId], ['vc01.corpA.local', 'VC', 'VBR-KR', 'u-1']);
  assert.deepEqual(r.map(EP.isVcRoot), [true, false, true]);
  assert.equal(EP.isVcRoot({ hostType: 'vCenter Server' }), true);
  assert.equal(EP.isVcRoot({ hostType: '' }), false);
  assert.equal(EP.hierarchyRootsOf({ HierarchyRoots: Array.from({ length: 2100 }, (_, i) => ({ Name: `h${i}` })) }).length, 2000);
});

test('B matchVcenter — host 정확 일치(대소문자·URL·포트 무시) · 이름 일치 · 앞 마디만 같은 것·IP 앞자리는 맞추지 않는다 · 모호한 키는 버린다', () => {
  const idx = EV.vcIndexOf([{ id: 'a', name: 'Seoul', host: 'https://vc01.corpA.local/sdk' }, { id: 'b', name: 'NY', host: 'https://vc01.corpB.local' }, { id: 'c', name: 'ip', host: 'https://10.1.2.3:443' },
    { id: 'd', name: 'dup', host: 'https://same.local' }, { id: 'e', name: 'dup2', host: 'https://same.local' }]);
  assert.deepEqual(['VC01.corpa.local', 'vc01.corpB.local', 'https://vc01.corpA.local:443', '10.1.2.3', 'seoul'].map((x) => EV.matchVcenter(x, idx)), ['a', 'b', 'a', 'c', 'a']);
  assert.deepEqual(['vc01', '10.1.2', '10', 'same.local', ''].map((x) => EV.matchVcenter(x, idx)), [null, null, null, null, null], '앞 마디만 · 모호(두 vCenter 가 같은 host) · 빈 값');
});

test('C emView — 서버마다 roots·vcCheck(same/diff/unmapped/none/unknown) · orphanRoots · 루트를 못 읽으면 unknown', () => {
  const idx = EV.vcIndexOf([{ id: 'kr:vc1', name: 'Seoul', host: 'https://vc01.corpa.local' }, { id: 'us:vc2', name: 'NewYork', host: 'https://vc01.corpb.local' }]);
  const roots = EP.hierarchyRootsOf(ROOTS).concat([{ name: 'vc01.corpb.local', hostType: 'VC', server: 'VBR-US' }]);
  const map = { [`vem-1|vbr-kr`]: { vcenterIds: ['kr:vc1'] }, [`vem-1|vbr-us`]: { vcenterIds: ['kr:vc1'] } };
  const rec = { result: { ok: true, ts: Date.now(), sections: { hierarchyRoots: { ok: true } }, backupServers: [{ name: 'VBR-KR' }, { name: 'VBR-US' }, { name: 'VBR-NEW' }, { name: 'VBR-EMPTY' }], hierarchyRoots: roots.concat([{ name: 'vc01.corpb.local', hostType: 'VC', server: 'VBR-NEW' }]) } };
  const v = EV.emView({ id: 'vem-1', name: 'EM1' }, rec, { map, vcIndex: idx });
  const by = Object.fromEntries(v.data.backupServers.map((s) => [s.name, s]));
  assert.equal(by['VBR-KR'].vcCheck, 'same');
  assert.deepEqual(by['VBR-KR'].roots.map((r) => [r.name, r.vcenterId]), [['vc01.corpA.local', 'kr:vc1'], ['esx-07.corpa.local', null]]);
  assert.equal(by['VBR-US'].vcCheck, 'diff', '매핑은 Seoul 인데 EM 은 NewYork');
  assert.equal(by['VBR-NEW'].vcCheck, 'unmapped');
  assert.equal(by['VBR-EMPTY'].vcCheck, 'none');
  assert.deepEqual(v.data.orphanRoots.map((r) => [r.server, r.name, r.vcenterId]), [['VBR-OLD', 'vc-legacy.corp.local', null]]);
  assert.equal(v.data.hierarchyRootsKnown, true);
  const v2 = EV.emView({ id: 'vem-1', name: 'EM1' }, { result: { ok: true, ts: Date.now(), sections: {}, backupServers: [{ name: 'VBR-KR' }], hierarchyRoots: null } }, { map, vcIndex: idx });
  assert.deepEqual([v2.data.backupServers[0].vcCheck, v2.data.backupServers[0].roots, v2.data.hierarchyRootsKnown, v2.data.orphanRoots], ['unknown', null, false, null]);
});

test('D collectEm — hierarchyRoots 를 읽어 싣는다 · 실패해도 다른 항목은 산다(섹션 사유)', async () => {
  const mk = (rootsResp) => async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') === 'POST' && u.pathname === '/api/sessionMngr/') return json({ SessionId: 's' }, 201, { 'X-RestSvcSessionId': 'sess' });
    if ((init.method || 'GET') === 'DELETE') return new Response(null, { status: 204 });
    if (u.pathname === '/api/hierarchyRoots') return rootsResp();
    if (u.pathname === '/api/backupServers') return json({ BackupServers: [{ Name: 'VBR-KR', UID: 'x' }] });
    if (u.pathname === '/api/reports/summary/overview') return json({ BackupServers: 1 });
    return json({}, 200);
  };
  const EM = { id: 'vem-t', name: 'HQ', host: 'vem01.corp.local', port: 9398, username: 'svc', password: 'PW' };
  const ok = await EC.collectEm(EM, { fetchImpl: mk(() => json(ROOTS)) });
  assert.equal(ok.sections.hierarchyRoots.ok, true);
  assert.equal(ok.hierarchyRoots.length, 3);
  const bad = await EC.collectEm(EM, { fetchImpl: mk(() => json({ message: 'nope' }, 500)) });
  assert.equal(bad.ok, true, '연결 호스트 실패는 수집 전체를 죽이지 않는다');
  assert.equal(bad.sections.hierarchyRoots.ok, false);
  assert.equal(bad.hierarchyRoots, null);
  assert.equal(bad.backupServers.length, 1);
});

test('E 라우트 — EM 2대가 모두 응답에 · 서버별 roots 가 포탈 vCenter(등록부 host)로 맞는다 · 실패 EM 의 상태 · 범위 계정 403', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const ER = await import('../src/veeam/em/registry.js');
  const ES = await import('../src/veeam/em/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  store.snapshot = { source: 'live', generatedAt: Date.now(), vcenters: [{ id: 'kr:vc1', name: 'Seoul' }, { id: 'us:vc2', name: 'NewYork' }], hosts: [], vms: [] };
  ER._resetEmRegistryForTest();
  const a = ER.saveEm({ name: 'EM-A', host: 'vem01.corp.local', username: 'svc', password: 'PW-A' });
  const b = ER.saveEm({ name: 'EM-B', host: 'vem02.corp.local', username: 'svc', password: 'PW-B' });
  const c = ER.saveEm({ name: 'EM-C', host: 'vem03.corp.local', username: 'svc', password: 'PW-C' });
  const tgt = (id) => ER.emFingerprint(ER.getEmWithSecret(id));
  ES.putEmResult(a.id, { ok: true, ts: Date.now(), target: tgt(a.id), sections: { hierarchyRoots: { ok: true } }, notes: [], backupServers: [{ name: 'VBR-KR' }], hierarchyRoots: [{ name: 'vc01.corpA.local', hostType: 'VC', server: 'VBR-KR' }] });
  ES.putEmResult(b.id, { ok: true, ts: Date.now(), target: tgt(b.id), sections: { hierarchyRoots: { ok: true } }, notes: [], backupServers: [{ name: 'VBR-US' }], hierarchyRoots: [{ name: 'https://VC01.corpB.local:443', hostType: 'VC', server: 'VBR-US' }] });
  ES.putEmResult(c.id, { ok: false, ts: Date.now(), target: tgt(c.id), error: '수집 시한(240초)이 지나 일부만 읽었습니다', kind: 'timeout' });
  let user = { username: 'op', role: 'operator' };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => srv.close(() => ok())));
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`); return { status: r.status, body: await r.json() }; };
  let r = await get('/tools/backup-em');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.ems.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(by).sort(), ['EM-A', 'EM-B', 'EM-C'], 'EM 이 여러 대면 모두 응답에 있다');
  assert.deepEqual(by['EM-A'].data.backupServers[0].roots.map((x) => [x.vcenterId, x.vcName]), [['kr:vc1', 'Seoul']]);
  assert.deepEqual(by['EM-B'].data.backupServers[0].roots.map((x) => [x.vcenterId, x.vcName]), [['us:vc2', 'NewYork']]);
  assert.equal(by['EM-A'].data.backupServers[0].vcCheck, 'unmapped');
  assert.deepEqual([by['EM-C'].status.ok, by['EM-C'].data], [false, null]);
  assert.match(by['EM-C'].status.error, /시한/);
  assert.ok(!JSON.stringify(r.body).includes('PW-'), '비밀을 싣지 않는다');
  user = { username: 's', role: 'operator', scope: { vcenters: ['kr:vc1'] } };
  r = await get('/tools/backup-em');
  assert.equal(r.status, 403, '범위 계정 — 기존 규칙 유지');
});

test('F 데모 — EM 3대(2대 정상 · 1대 수집 실패) · 서버마다 roots·vcCheck · 세션 상세 데모 id', async () => {
  const D = await import('../src/mock/demo/veeamEm.js');
  const snap = { vcenters: Array.from({ length: 11 }, (_, i) => ({ id: `vc${i}`, name: `vcenter-${i}` })), vms: [] };
  const v = D.demoEmViews(snap, Date.now());
  assert.deepEqual(v.map((e) => e.id), [...D.DEMO_EM_IDS]);
  assert.deepEqual(v.map((e) => !!e.data), [true, true, false]);
  const checks = new Set(v.flatMap((e) => (e.data?.backupServers || []).map((s) => s.vcCheck)));
  for (const k of ['same', 'unmapped']) assert.ok(checks.has(k), `데모에 ${k} 가 보인다: ${[...checks]}`);
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(src, /DEMO_EM_IDS\.includes\(emId\)/);
});
