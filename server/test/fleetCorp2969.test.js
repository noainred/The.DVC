// v2.969 통합 서버 인벤토리 — 법인(DataCenter) 기준(사용자 요청 2026-11-11) + 법인 수동 지정(vCenter 지정과 둘 다 — 사용자 결정).
//   판정은 insights/hwExport/corp.js 하나(서버 분석 · 하드웨어 내보내기 · 이 화면이 같은 판정) · 수동 지정 저장은 insights/fleetDcAssign.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { loadFleetDcAssign, setFleetDcAssignMany, fleetDcAssignUnreadable, _resetFleetDcAssignForTest } from '../src/insights/fleetDcAssign.js';
import { makeCorpOf, buildDcIndex } from '../src/insights/hwExport/corp.js';
import { enrichFleetCorp, hwCorpRoster } from '../src/routes/insights.js';
import { fleetRev } from '../src/insights/fleetRev.js';
import { stripComments } from './_stripComments.js';

let dir; let prevDir;
before(() => { prevDir = config.configDir; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdc2969-')); config.configDir = dir; _resetFleetDcAssignForTest(); });
after(() => { config.configDir = prevDir; _resetFleetDcAssignForTest(); fs.rmSync(dir, { recursive: true, force: true }); });

test('저장소 — 소문자 키 · 없는 법인 거부 · 해제 · 손상이면 보존하고 쓰기 거부(503) · 쓰면 fleetRev 가 오른다', () => {
  const valid = new Set(['AZ', 'NJ']);
  const r0 = fleetRev();
  assert.deepEqual(setFleetDcAssignMany([['TAG1', 'AZ'], ['srv-2', 'NJ']], valid), { ok: true, changed: 2 });
  assert.ok(fleetRev() > r0, '화면 캐시가 바로 바뀌게');
  assert.deepEqual(loadFleetDcAssign(), { tag1: 'AZ', 'srv-2': 'NJ' });
  assert.equal(setFleetDcAssignMany([['tag1', 'GHOST']], valid).status, 400, '없는 법인');
  assert.deepEqual(setFleetDcAssignMany([['tag1', 'AZ']], valid), { ok: true, changed: 0 }, '같은 값은 쓰지 않는다');
  assert.deepEqual(setFleetDcAssignMany([['TAG1', '']], valid), { ok: true, changed: 1 });
  assert.deepEqual(loadFleetDcAssign(), { 'srv-2': 'NJ' });
  fs.writeFileSync(path.join(dir, 'fleet-dc-assign.json'), '{ broken');
  _resetFleetDcAssignForTest();
  assert.deepEqual(loadFleetDcAssign(), {});
  assert.equal(fleetDcAssignUnreadable(), true);
  const w = setFleetDcAssignMany([['x', 'AZ']], valid);
  assert.equal(w.status, 503, '손상 파일 위에 덮어 다른 지정을 잃지 않게');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('fleet-dc-assign.json.corrupt')), '손상 사본 보존');
  assert.equal(setFleetDcAssignMany([['y', 'AZ']], valid).status, 503, '보존 뒤(파일이 옮겨진 뒤)에도 계속 거부');
  // 관리자가 사본을 되돌리면(정상 파일) — 재시작 없이 다시 쓸 수 있다(그 지정들도 살아 있다)
  fs.writeFileSync(path.join(dir, 'fleet-dc-assign.json'), JSON.stringify({ v: 1, assign: { 'srv-2': 'NJ' } }));
  assert.deepEqual(loadFleetDcAssign(), { 'srv-2': 'NJ' });
  assert.equal(fleetDcAssignUnreadable(), false);
  assert.deepEqual(setFleetDcAssignMany([['y', 'AZ']], valid), { ok: true, changed: 1 });
  assert.deepEqual(loadFleetDcAssign(), { 'srv-2': 'NJ', y: 'AZ' });
  fs.rmSync(path.join(dir, 'fleet-dc-assign.json'), { force: true });
  _resetFleetDcAssignForTest();
  assert.equal(fleetDcAssignUnreadable(), false, '정상(없음)에서 다시 시작하면 풀린다');
});

const ASSIGN = { 'vc-az': 'AZ', 'vc-nj': 'NJ' };
const dcOfVc = (vc) => ASSIGN[vc] || '';
const index = buildDcIndex([{ id: 'r1', serviceTag: 'T1', datacenterId: 'NJ' }], dcOfVc);
const mk = (manual) => makeCorpOf({ index, dcOfVc, dcName: (id) => ({ AZ: 'AZ', NJ: 'NJ' }[id] || ''), vcName: () => '', manual, knownDc: new Set(['AZ', 'NJ']) });

test('판정 — 수동 지정이 가장 먼저(tagKey · 서비스태그 · 서버 id) · 없는 법인을 가리키는 지정은 무시 · 출처(src)를 싣는다', () => {
  const row = { serverId: 'r1', serviceTag: 'T1', tagKey: 't1', vcenterId: 'vc-az' };
  assert.deepEqual(mk(null)(row, 'bm'), { id: 'NJ', name: 'NJ', src: 'scan' }, '자동: 스캔 법인이 vCenter 할당보다 먼저');
  assert.deepEqual(mk({ t1: 'AZ' })(row, 'bm'), { id: 'AZ', name: 'AZ', src: 'manual' });
  assert.deepEqual(mk({ r1: 'AZ' })(row, 'bm').src, 'manual', '서버 id 키도');
  assert.deepEqual(mk({ t1: 'DELETED' })(row, 'bm'), { id: 'NJ', name: 'NJ', src: 'scan' }, '지워진 법인 지정은 자동으로');
  assert.deepEqual(mk({ t1: 'AZ' })({ name: 'esx', serviceTag: 'T1', tagKey: 't1', vcenterId: 'vc-nj' }, 'vh'), { id: 'NJ', name: 'NJ', src: 'vcenter' }, '가상화 호스트는 수동 지정 대상이 아니다(vCenter 의 법인)');
  assert.equal(mk(null)({ serverId: 'x', serviceTag: 'Q', vcenterId: 'vc-az' }, 'bm').src, 'vcenter');
});

test('화면 응답 — 행마다 corpId · corpName · corpSource, 법인 목록 · 지정용 법인 목록 · 법인 미지정 수 · 원본 불변', () => {
  const full = {
    bareMetal: [{ serverId: 'r1', name: 'bm1', serviceTag: 'T1', tagKey: 't1' }, { serverId: 'z', name: 'bm2', serviceTag: 'Z', tagKey: 'z' }],
    virtualizationHosts: [{ name: 'esx', vcenterId: 'vc-az' }],
    summary: { bareMetal: 2, bareMetalUnassigned: 2 },
  };
  const before = JSON.stringify(full);
  const out = enrichFleetCorp(full, { corpOf: mk(null), dcOrder: ['NJ', 'AZ'], datacenters: [{ id: 'NJ', name: 'NJ' }, { id: 'AZ', name: 'AZ' }] });
  assert.equal(JSON.stringify(full), before, '캐시에 있는 원본은 바꾸지 않는다');
  assert.deepEqual(out.bareMetal.map((b) => [b.corpId, b.corpName, b.corpSource]), [['NJ', 'NJ', 'scan'], ['', '', '']]);
  assert.deepEqual(out.virtualizationHosts.map((h) => h.corpId), ['AZ']);
  assert.deepEqual(out.corps.map((c) => [c.id, c.bm, c.vh]), [['NJ', 1, 0], ['AZ', 0, 1], ['__none__', 1, 0]]);
  assert.equal(out.summary.bareMetalNoCorp, 1);
  assert.equal(out.summary.bareMetalUnassigned, 2, 'vCenter 미지정 수는 그대로(다른 화면이 읽는다)');
  assert.deepEqual(out.datacenters.map((d) => d.id), ['NJ', 'AZ']);
  assert.deepEqual(hwCorpRoster(full, { corpOf: mk(null), dcOrder: ['NJ', 'AZ'] }), out.corps, '내보내기 창과 같은 목록');
});

test('라우트 — /fleet 은 법인 판정을 덧붙이고(법인 설정 서명이 캐시 키) · 법인 지정은 관리자 + 전체 범위 + 감사 · 등록부를 고치지 않는다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/insights.js', import.meta.url), 'utf8'));
  const fleet = src.slice(src.indexOf("insightsRouter.get('/fleet',"), src.indexOf("insightsRouter.put('/fleet/tag'"));
  assert.match(fleet, /const key = `\$\{key0\}\|dc:\$\{hwDcSignature\(\)\}`/);
  assert.match(fleet, /enrichFleetCorp\(raw, hwCorpContext\(snap\)\)/);
  assert.match(fleet, /if \(scopedVcenterIds\(req\.user, snap\)\)/, '전체 범위 전용은 그대로');
  assert.match(src, /insightsRouter\.put\('\/fleet\/dc-assign', adminOnly, fleetFullScopeOnly,/);
  const dc = src.slice(src.indexOf("'/fleet/dc-assign'"), src.indexOf("'/fleet/dc-assign'") + 2500);
  assert.match(dc, /setFleetDcAssignMany\(/);
  assert.match(dc, /logAudit\(/);
  assert.doesNotMatch(dc, /updateServer\(|assignVcenter\(/, '등록부 datacenterId 를 고치지 않는다(교체 스캔이 지우거나 되돌린다)');
});

test('실제 호출 — 법인 지정: operator 403 · 범위 계정 403 · 없는 법인 400 · 관리자 200', async (t) => {
  const express = (await import('express')).default;
  const { insightsRouter } = await import('../src/routes/insights.js');
  const { addDatacenter, removeDatacenter } = await import('../src/datacenter/store.js');
  const { store } = await import('../src/store.js');
  const http = await import('node:http');
  addDatacenter({ id: 'dc-t2969', name: 'T2969' });   // DataCenter id 는 소문자로 저장된다
  t.after(() => { try { removeDatacenter('dc-t2969'); } catch { /* */ } });
  let who = null;
  const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = who; next(); }); app.use('/api/insights', insightsRouter);
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const put = async (u, body) => { who = u; const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/insights/fleet/dc-assign`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const admin = { username: 'adm', role: 'admin' };
  assert.equal((await put({ username: 'op', role: 'operator' }, { items: [{ key: 'k1' }], datacenterId: 'dc-t2969' })).status, 403);
  const vcs = store.get?.()?.vcenters || [];
  if (vcs.length) assert.equal((await put({ username: 'sc', role: 'admin', scope: { vcenters: [vcs[0].id] } }, { items: [{ key: 'k1' }], datacenterId: 'dc-t2969' })).status, 403);
  assert.equal((await put(admin, { items: [{ key: 'k1' }], datacenterId: 'GHOST' })).status, 400);
  assert.equal((await put(admin, { items: [], datacenterId: 'dc-t2969' })).status, 400);
  const ok = await put(admin, { items: [{ key: 'K1' }], datacenterId: 'dc-t2969' });
  assert.deepEqual([ok.status, ok.body.changed, ok.body.total], [200, 1, 1]);
  assert.equal(loadFleetDcAssign().k1, 'dc-t2969');
  assert.equal((await put(admin, { items: [{ key: 'k1' }], datacenterId: '' })).body.changed, 1, '해제');
});
