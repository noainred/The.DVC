/**
 * v2.994 묶음 D(설계 docs/design/bm-folders §11) — 엣지 포탈 화면: 중앙 묶음(엣지 키 · 그 법인만) · 엣지 사본 · 받기 워커 · 엣지 읽기 화면 · 엣지 전달.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-bmf2994-'));
const { bmKeyOf, edgeKeyOfRow } = await import('../src/routes/api/svcInventory.js');
const EB = await import('../src/bmfolders/edgeBundle.js');
const EC = await import('../src/bmfolders/edgeCopy.js');
const PULL = await import('../src/agent/bmFoldersPull.js');
const { config } = await import('../src/config.js');
const BF = await import('../src/routes/api/bmFolders.js');
const rd = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('엣지 쪽 키 — 태그 있으면 st: · 없으면 엣지 fleetId 의 fl:(엣지가 자기 함대 행으로 만드는 키와 같다)', () => {
  assert.equal(edgeKeyOfRow({ source: 'edge', remoteAgent: 'kr', serviceTag: 'ABC123', serverId: 'edge:kr:abc123' }), 'st:abc123');
  const ek = edgeKeyOfRow({ source: 'edge', remoteAgent: 'kr', serviceTag: '', serverId: 'edge:kr:idrac-10.0.0.5' });
  assert.equal(ek, bmKeyOf({ fleetId: 'idrac-10.0.0.5' }).key);
  assert.equal(edgeKeyOfRow({ source: 'idrac', serverId: 'x' }), '');
  assert.equal(edgeKeyOfRow({ source: 'edge', remoteAgent: 'kr', serverId: 'edge:pl:x' }), '', '다른 엣지 꼴이면 모름');
  assert.equal(edgeKeyOfRow({ source: 'edge', remoteAgent: 'kr', serverId: 'edge:kr:' }), '');
});

const M = (o) => ({ kind: 'bm', source: 'edge', remoteAgent: 'kr', corp: 'vc-kr', ...o });
const place = new Map([['st:a', { path: 'DB\\Oracle', src: 'manual' }], ['st:b', { path: 'WEB', src: 'rule', ruleId: 'r1' }], ['st:c', { path: 'DB', src: 'manual' }], ['st:p', { path: 'X', src: 'manual' }], ['st:z', { path: 'DB', src: 'manual' }]]);
const members = [
  M({ key: 'st:a', edgeKey: 'st:a', name: 'kr-a' }), M({ key: 'st:b', edgeKey: 'st:b', name: 'kr-b' }),
  M({ key: 'st:c', source: 'idrac', remoteAgent: '', name: 'kr-central' }),     // 같은 법인 · 중앙 직접 → 이 엣지 밖
  M({ key: 'st:p', corp: 'vc-pl', remoteAgent: 'pl', edgeKey: 'st:p', name: 'pl-a' }),   // 다른 법인
  M({ key: 'st:z', edgeKey: '', name: 'kr-oldedge' }),                         // 엣지 키 모름
];
const main = { corps: { 'vc-kr': { folders: ['DB', 'DB\\Oracle', 'WEB'] }, 'vc-pl': { folders: ['X'] } }, rules: [{ value: 'secret-rule', path: 'WEB', corp: 'vc-kr' }] };

test('묶음 — 그 엣지 법인만 · 엣지 키로 · 규칙 값 · 등록자 · 다른 법인 없음 · 이 엣지 밖 등록 · 엣지 키 모름은 싣지 않고 센다', () => {
  const b = EB.buildEdgeBundle({ agent: 'KR', members, b: { placeOf: place }, main, corps: new Set(), svcLinks: { 'vc-kr': [{ prefix: 'DB', service: 'Oracle 서비스' }] }, rev: '3.7', now: 1 });
  assert.deepEqual(b.corps.map((c) => c.vcenterId), ['vc-kr']);
  assert.deepEqual(b.place, { 'st:a': { path: 'DB\\Oracle', src: 'manual', corp: 'vc-kr' }, 'st:b': { path: 'WEB', src: 'rule', corp: 'vc-kr' } });
  assert.deepEqual(b.outside, [{ corp: 'vc-kr', path: 'DB', name: 'kr-central', via: 'central' }]);
  assert.equal(b.noEdgeKey, 1);
  const txt = JSON.stringify(b);
  assert.ok(!txt.includes('secret-rule') && !txt.includes('pl-a') && !txt.includes('vc-pl') && !txt.includes('ruleId'), txt);
  assert.deepEqual(b.corps[0].services, [{ prefix: 'DB', service: 'Oracle 서비스' }]);
});

test('사본 정제 — 형식 · 키 · 경로 · 법인 목록 밖은 버리고 센다', () => {
  assert.equal(EC.sanitizeBundle({ v: 2, corps: [], place: {} }), null);
  const s = EC.sanitizeBundle({ v: 1, rev: '1', corps: [{ vcenterId: 'vc', folders: ['A', '', '\\\\'], services: [{ prefix: 'A', service: 'S' }] }], place: { 'st:a': { path: 'A', corp: 'vc' }, 'bad key': { path: 'A', corp: 'vc' }, 'st:b': { path: 'A', corp: 'other' }, 'st:c': { path: 123, corp: 'vc' } }, outside: [{ corp: 'zz', path: 'A' }] });
  assert.deepEqual(Object.keys(s.place), ['st:a']);
  assert.deepEqual(s.corps[0].folders, ['A']);
  assert.ok(s.dropped >= 6, `dropped ${s.dropped}`);
});

test('사본 저장 · 읽기 · 손상(보존본 · 못 읽음 — 빈 사본으로 바꾸지 않는다) · 없음', () => {
  assert.deepEqual(EC.loadCopy(), { copy: null });
  const r = EC.saveCopy({ v: 1, rev: '9', corps: [{ vcenterId: 'vc', folders: ['A'] }], place: { 'st:a': { path: 'A', corp: 'vc' } } }, { now: 77 });
  assert.equal(r.ok, true);
  const c = EC.loadCopy();
  assert.equal(c.copy.rev, '9'); assert.equal(c.copy.savedAt, 77); assert.equal(c.copy.place['st:a'].path, 'A');
  fs.writeFileSync(EC._copyFileForTest(), '{broken');
  const bad = EC.loadCopy();
  assert.equal(bad.copy, null); assert.match(bad.error, /읽지 못했습니다/);
  assert.ok(fs.readdirSync(process.env.CONFIG_DIR).some((f) => f.startsWith('bm-folders-central.json.corrupt')), '보존본');
  assert.equal(EC.saveCopy({ v: 9 }).ok, false);
});

test('받기 워커 — 404 · distribute:false · 503 · 실패는 지난 사본 유지 · 받으면 저장 · 가진 판을 쿼리로', async () => {
  const keep = { ...config.agent };
  Object.assign(config.agent, { centralUrl: 'https://central.test', centralToken: 'tok', name: 'kr' });
  try {
    const saved = []; let have = '';
    const copy = { loadCopy: () => ({ copy: { rev: '5' } }), saveCopy: (b) => { saved.push(b); return { ok: true, corps: 1, place: 2, dropped: 0 }; } };
    const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body), body: null, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
    const run = (status, body) => PULL.pullBmFoldersNow({ copy, fetchImpl: async (u) => { have = new URL(u).searchParams.get('have'); return resp(status, body); } });
    PULL._resetBmFoldersPullForTest();
    let r = await run(503, { ok: false });
    assert.equal(r.ok, false); assert.equal(saved.length, 0); assert.equal(have, '5');
    r = await run(200, { ok: true, distribute: false, reason: 'unverified' });
    assert.equal(r.distribute, false); assert.equal(saved.length, 0);
    r = await run(200, { ok: true, distribute: true, bundle: { v: 1 } });
    assert.equal(r.ok, true); assert.equal(saved.length, 1);
    r = await run(200, { ok: true });
    assert.equal(r.ok, false, '형식 오류'); assert.equal(saved.length, 1);
  } finally { Object.assign(config.agent, keep); }
  assert.match(rd('edgelog/spec.js'), /key: 'pull\.bmFolders'.*fn: 'bmFoldersPullStatus'/);
  assert.match(rd('index.js'), /startBmFoldersPull,/);
});

test('중앙 라우트 — 개별 토큰에만(공유 토큰은 distribute:false) · 받기 기록 · 저장소 손상 503(소스)', () => {
  const s = rd('routes/central/storageRoutes.js');
  const i = s.indexOf("centralRouter.get('/bm-folders'");
  const body = s.slice(i, i + 1400);
  assert.match(body, /req\.centralAuth\?\.mode !== 'agent'[\s\S]*distribute: false, reason: 'unverified'/);
  assert.match(body, /recordEdgeSync\(agent/);
  assert.match(body, /status\(503\)/);
});

test('엣지 전달 — 받아 간 판이 지금 세대와 같으면 최신 · 받은 적 없으면 null', () => {
  EB._resetEdgeSyncForTest();
  assert.equal(EB.edgeSyncOf('kr', '1.1'), null);
  EB.recordEdgeSync('KR', { have: '1.1', now: 5 });
  assert.deepEqual(EB.edgeSyncOf('kr', '1.1'), { at: 5, have: '1.1', current: true });
  assert.equal(EB.edgeSyncOf('kr', '1.2').current, false);
});

test('엣지 화면 — 사본 배치는 같은 법인일 때만 · 이 엣지 밖 이름은 전체 범위 관리자만 · 범위 계정은 그 법인만 · 쓰기는 409(소스)', async () => {
  const copy = { rev: '2', savedAt: 1, at: 1, corps: [{ vcenterId: 'vc-kr', name: 'KR', folders: ['DB'], services: [] }, { vcenterId: 'vc-x', name: 'X', folders: ['Z'], services: [] }],
    place: { 'st:a': { path: 'DB', src: 'manual', corp: 'vc-kr' }, 'st:b': { path: 'DB', src: 'manual', corp: 'vc-other' } }, outside: [{ corp: 'vc-kr', path: 'DB', name: 'kr-central', via: 'central' }] };
  const g = { members: [{ kind: 'bm', key: 'st:a', keyKind: 'serviceTag', corp: 'vc-kr', name: 'a1', serviceTag: 'A', usage: { state: 'ok', cpuPct: 1, memPct: 2 } }, { kind: 'bm', key: 'st:b', keyKind: 'serviceTag', corp: 'vc-kr', name: 'b1', serviceTag: 'B', usage: { state: 'unread' } }] };
  const D = { loadCopy: () => ({ copy }), gather: async () => g, ix: null, pullStatus: () => ({ intervalMs: 600000, last: { at: 1, ok: false, error: 'conn refused https://central:8443' } }) };
  const admin = { username: 'a', role: 'admin' };
  const v = await BF.edgeViewFor({ user: admin }, { vcenters: [] }, D);
  const by = Object.fromEntries(v.servers.map((s) => [s.name, s.path]));
  assert.deepEqual(by, { a1: 'DB', b1: '' }, '다른 법인으로 놓인 사본 배치는 쓰지 않는다');
  assert.equal(v.outside.length, 1); assert.equal(v.edge, true);
  const viewer = { username: 'v', role: 'viewer' };
  const v2 = await BF.edgeViewFor({ user: viewer }, { vcenters: [] }, D);
  assert.equal(v2.outside, undefined); assert.equal(v2.outsideCount, 1);
  assert.equal(v2.pull.last.error, undefined, '받기 오류 원문(주소)은 관리자 판본만');
  const scoped = { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } };
  const v3 = await BF.edgeViewFor({ user: scoped }, { vcenters: [{ id: 'vc-x' }, { id: 'vc-kr' }] }, D);
  assert.deepEqual(v3.corps.map((c) => c.vcenterId), ['vc-x']); assert.equal(v3.servers.length, 0); assert.equal(v3.outsideCount, 0);
  const src = rd('routes/api/bmFolders.js');
  assert.match(src, /api\.post\('\/tools\/bm-folders\/op', writeRole, toolsPerm, async \(req, res\) => \{\n\s*\/\/[^\n]*\n\s*if \(isEdgeNode\(\)\) return res\.status\(409\)/);
});
