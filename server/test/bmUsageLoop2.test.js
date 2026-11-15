/**
 * 베어메탈 사용률 점검 반복 2회차(기준판 68b220406) — 서버 쪽 고정.
 *   E1 · E2 쓰기 버튼 표지(routes/api/bmWriteGate.js) = **실제 라우트 게이트와 같은 판정**:
 *     ① 표지 표(BM_ACTIONS)가 실제 라우터의 (메서드 · 경로 · 역할 게이트 인자)와 같다(라우터 스택 대조)
 *     ② 실제 라우터(authMiddleware → requireEnrolled → api — index.js 와 같은 순서) · 실제 토큰 5계정: GET 표지 ok ⟺ 같은 계정의 쓰기가 403 이 아니다
 *        (수집 설정 · 지금 수집 · 엣지 인출 · 용량/저활용 다시 계산 · 저활용 검토 · 주석 추가 · 동시 집중 · 비교 세트)
 *     ③ 행 · 열 writable(저활용 행 · 비교 열 · 주석 표지) = 쓰기 라우트의 inUserWriteScope(조회 전용 법인 403)
 *     ④ 데모 계정 — authMiddleware 와 같은 함수(demoGuestDenial): ‘지금 수집’ 만 열리고 나머지는 demo
 *     ⑤ 저활용 응답 캐시 열쇠 — 같은 조회 범위의 operator · viewer 가 표지를 나누지 않는다(gateKey)
 *   E3 PowerCap 꺼짐 = 해당 없음 — 판정 하나(hwFacts invCapState)를 하드웨어 U · 전력 보기 · 엣지 봉투가 공유 · 중앙 정제가 capState 를 싣는다
 *   I2 장치 응답에 피크 창 설정 상한(peakWindowCapS — 이 노드 · 엣지 대행 정제) · I3 용량 상세에 임박 기준(alertDays)
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 기준(docs/rules/common.md).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop2-'));
Object.assign(process.env, {
  CONFIG_DIR: DIR, DATA_DIR: DIR, AUTH_ENABLED: 'true', AUTH_SECRET: 'z'.repeat(48), OTP_ROLE_ENFORCE: 'false', DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', COLLECTOR_TOKEN: 'tok-loop2',
});
delete process.env.CENTRAL_URL;
delete process.env.BMUSAGE_ENABLED;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
  { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: ['/'] },
  { id: 'o-b1', name: 'bm-b1', host: '127.0.0.2', port: 9, username: 'mon', password: 'pw', mounts: ['/'] },
] }));
fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));

const SNAP = { vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }], hosts: [], vms: [] };
const USERS = {
  adm: { role: 'admin' },
  sadm: { role: 'admin', scope: { vcenters: ['vcA'] } },
  op: { role: 'operator' },
  sop: { role: 'operator', scope: { vcenters: ['vcA', 'vcB'], writeVcenters: ['vcA'] } },   // vcB = 조회 전용
  vw: { role: 'viewer' },
};
const TOK = {};
let srv; let port; let api; let G; let poller;

before(async () => {
  const express = (await import('express')).default;
  ({ api } = await import('../src/routes/api.js'));
  const auth = await import('../src/auth/auth.js');
  const audit = await import('../src/audit.js');
  const { store } = await import('../src/store.js');
  G = await import('../src/routes/api/bmWriteGate.js');
  poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'CTAGA1', vcenterId: 'vcA' },
    { serverId: 's-b1', name: 'bm-b1', serviceTag: 'CTAGB1', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  poller._setOsCollectorForTest(async () => ({ ok: false, error: 'stub — 시험은 장비에 접속하지 않는다' }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  store.snapshot = structuredClone(SNAP);
  for (const [name, u] of Object.entries(USERS)) {
    auth.createUser({ username: name, role: u.role, password: 'Passw0rd!long2', ...(u.scope ? { scope: u.scope } : {}) }, { trusted: true });
    const rec = auth.getUser(name); const sid = `sid-${name}`; const exp = Math.floor(Date.now() / 1000) + 3600;
    TOK[name] = auth.signToken({ sub: name, role: rec.role, name, src: 'local', tv: rec.tokenVersion || 0, sid }, { exp });
    auth.noteIssuedSession({ sub: name, sid, exp });
  }
  const app = express();
  app.use('/api/collector', (await import('../src/routes/collector.js')).collectorRouter);   // 엣지 역할(같은 프로세스) — 중앙이 대행으로 부르는 경로
  app.use(express.json());
  app.use('/api', auth.authMiddleware, auth.requireEnrolled, audit.auditMiddleware, api);   // index.js 와 같은 순서
  srv = http.createServer(app);
  port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
});
after(() => { try { srv?.close(); } catch { /* */ } try { poller?._setFleetForTest(null); poller?._setOsCollectorForTest(null); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });

const call = (u, method, p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, {
  method, headers: { authorization: `Bearer ${TOK[u]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
const get = (u, p) => call(u, 'GET', p);

test('① 표지 표(BM_ACTIONS) = 실제 라우터의 메서드 · 경로 · 역할 게이트', () => {
  for (const [name, a] of Object.entries(G.BM_ACTIONS)) {
    const layer = api.stack.find((l) => l.route && l.route.methods[a.method.toLowerCase()] && l.match(a.path));
    assert.ok(layer, `${name}: 실제 라우트가 없다(${a.method} ${a.path})`);
    const role = layer.route.stack.map((s) => s.handle?.gate).find((g) => g?.kind === 'role');
    assert.ok(role, `${name}: 역할 게이트가 없다`);
    assert.deepEqual([...role.arg].sort(), [...a.roles].sort(), `${name}: 역할 인자가 라우트와 다르다`);
  }
  assert.deepEqual([...G.WRITE_WHY].sort(), ['demo', 'full-scope', 'read-only', 'role-admin', 'role-operator']);
});

test('② 실제 라우터 — 전 법인 동작 · 설정: GET 표지 ok ⟺ 같은 계정의 쓰기가 403 이 아니다(5계정)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const expectWhy = {
    settings: { adm: null, sadm: null, op: 'role-admin', sop: 'role-admin', vw: 'role-admin' },
    collect: { adm: null, sadm: 'full-scope', op: null, sop: 'full-scope', vw: 'role-operator' },
  };
  for (const u of Object.keys(USERS)) {
    const main = await get(u, '/tools/bm-usage');
    assert.equal(main.s, 200, `${u} 주 조회`);
    const cap = await get(u, '/tools/bm-usage/capacity');
    const idle = await get(u, '/tools/bm-usage/idle');
    const flags = { settings: main.j.actions?.settings, collect: main.j.actions?.collect, edgePull: main.j.actions?.edgePull,
      capacityRecompute: cap.j.actions?.recompute, idleRecompute: idle.j.actions?.recompute };
    const writes = {
      settings: await call(u, 'PUT', '/tools/bm-usage/settings', {}),
      collect: await call(u, 'POST', '/tools/bm-usage/collect', {}),
      edgePull: await call(u, 'POST', '/tools/bm-usage/edges/pull', {}),   // 게이트를 지나면 400(엣지 이름 없음)
      capacityRecompute: await call(u, 'POST', '/tools/bm-usage/capacity/recompute', {}),
      idleRecompute: await call(u, 'POST', '/tools/bm-usage/idle/recompute', {}),
    };
    for (const [k, f] of Object.entries(flags)) {
      assert.ok(f && typeof f.ok === 'boolean', `${u} ${k}: 표지가 없다`);
      assert.equal(f.ok, writes[k].s !== 403, `${u} ${k}: 표지 ${JSON.stringify(f)} ↔ 실제 ${writes[k].s} ${JSON.stringify(writes[k].j).slice(0, 120)}`);
    }
    for (const k of ['settings', 'collect']) assert.equal(flags[k].ok ? null : flags[k].why, expectWhy[k][u], `${u} ${k} 이유`);
    assert.deepEqual(flags.edgePull, flags.collect, `${u}: 엣지 인출 = 지금 수집과 같은 조건`);
  }
});

test('③ 실제 라우터 — 행 · 열 · 주석 표지 = 쓰기 라우트의 법인 쓰기 범위(조회 전용 법인 403)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  // 저활용 — 계산 결과가 있어야 행이 있다(데이터 부족 행이라도 대상마다 행)
  assert.equal((await (await import('../src/bmusage/idle.js')).recomputeIdle({ force: true })).ok, true);
  const rowsOf = async (u) => Object.fromEntries(((await get(u, '/tools/bm-usage/idle')).j.rows || []).map((r) => [r.vcenterId, r.writable]));
  assert.deepEqual(await rowsOf('sop'), { vcA: true, vcB: false }, '범위 운영자: 조회 전용 법인 행은 writable false');
  assert.deepEqual(await rowsOf('adm'), { vcA: true, vcB: true });
  const rv = (u, key, vc) => call(u, 'POST', '/tools/bm-usage/idle/review', { key, vcenterId: vc, status: 'review', reason: '시험' });
  assert.equal((await rv('sop', 'CTAGB1', 'vcB')).s, 403, '조회 전용 법인 행 검토 = 403(표지 false 와 같다)');
  assert.equal((await rv('sop', 'CTAGA1', 'vcA')).s, 200);
  const vwIdle = (await get('vw', '/tools/bm-usage/idle')).j;
  assert.deepEqual(vwIdle.actions.review, { ok: false, why: 'role-operator' });
  assert.equal((await rv('vw', 'CTAGA1', 'vcA')).s, 403);

  // 주석 추가 — 고른 서버의 법인 쓰기 범위
  const ann = async (u, key, vc) => (await get(u, `/tools/bm-usage/annotations?keys=${key}&vcenterIds=${vc}&from=${NOW - HOUR}&to=${NOW + HOUR}`)).j.actions?.create;
  const post = (u, key, vc) => call(u, 'POST', '/tools/bm-usage/annotations', { keys: [key], vcenterIds: [vc], at: NOW, kind: 'work', text: '시험 주석' });
  for (const [u, key, vc] of [['sop', 'CTAGB1', 'vcB'], ['sop', 'CTAGA1', 'vcA'], ['adm', 'CTAGB1', 'vcB'], ['vw', 'CTAGA1', 'vcA']]) {
    const g = await ann(u, key, vc);
    const w = await post(u, key, vc);
    assert.equal(g.ok, w.s === 200, `${u} ${vc}: 표지 ${JSON.stringify(g)} ↔ 실제 ${w.s}`);
  }
  assert.deepEqual(await ann('sop', 'CTAGB1', 'vcB'), { ok: false, why: 'read-only' });
  assert.deepEqual(await ann('sop', 'NOPE', 'vcA'), { ok: false }, '찾지 못한 서버(존재 은닉) — 쓸 대상이 없다(이유를 말하지 않는다)');

  // 비교 — 열 writable · 동시 집중 표지 · 조회 전용 열이 섞이면 서버가 403
  const cmp = (await get('sop', '/tools/bm-usage/compare?keys=CTAGA1,CTAGB1&vcenterIds=vcA,vcB')).j;
  assert.deepEqual(Object.fromEntries(cmp.columns.map((c) => [c.vcenterId, c.writable])), { vcA: true, vcB: false });
  assert.deepEqual(cmp.actions.focus, { ok: true });
  assert.equal(cmp.crossAllowed, false);
  const fo = await call('sop', 'POST', '/tools/bm-usage/compare/focus', { keys: ['CTAGB1'], vcenterIds: ['vcB'], reason: '시험 집중' });
  assert.equal(fo.s, 403, '조회 전용 열 = 동시 집중 403');
  const cmpA = (await get('adm', '/tools/bm-usage/compare?keys=CTAGA1,CTAGB1&vcenterIds=vcA,vcB&cross=1')).j;
  assert.ok(cmpA.columns.every((c) => c.writable === true));
  assert.deepEqual((await get('vw', '/tools/bm-usage/compare?keys=CTAGA1&vcenterIds=vcA')).j.actions.focus, { ok: false, why: 'role-operator' });

  // 비교 세트 — 저장 · 지우기 표지 ↔ 실제
  for (const u of ['op', 'vw']) {
    const sets = (await get(u, '/tools/bm-usage/compare/sets')).j;
    const w = await call(u, 'PUT', '/tools/bm-usage/compare/sets', { name: `세트-${u}`, keys: ['CTAGA1', 'CTAGB1'], vcenterIds: ['vcA', 'vcB'] });
    assert.equal(sets.actions.compareSetSave.ok, w.s !== 403, `${u} 세트 저장 표지 ↔ ${w.s}`);
    assert.equal(sets.actions.compareSetDelete.ok, sets.actions.compareSetSave.ok);
  }
});

test('④ 데모 계정 — authMiddleware 와 같은 판정(demoGuestDenial): 지금 수집만 열리고 나머지는 demo', async () => {
  const { demoGuestDenial } = await import('../src/auth/demoGuest.js');
  const req = { user: { username: 'thedvcdemp', role: 'admin', demoGuest: true } };
  for (const [name, a] of Object.entries(G.BM_ACTIONS)) {
    const g = G.bmGate(req, name, { snap: SNAP });
    const denied = !!demoGuestDenial(a.method, `/api${a.path}`);
    assert.equal(g.ok, !denied, `${name}: 데모 표지 ${JSON.stringify(g)} ↔ 미들웨어 거부 ${denied}`);
    if (denied) assert.equal(g.why, 'demo');
  }
  assert.equal(G.bmGate(req, 'collect', { snap: SNAP }).ok, true, '지금 수집은 데모 데이터만 다시 만든다(SAFE_ACTIONS)');
  assert.equal(G.bmGate(req, 'edgePull', { snap: SNAP }).why, 'demo');
  assert.equal(G.bmGate({ user: { role: 'admin' } }, 'nope').ok, false, '모르는 동작은 닫는다');
});

test('⑤ 저활용 응답 캐시 — 같은 조회 범위의 operator · viewer 가 표지를 나누지 않는다(gateKey)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const a = (await get('op', '/tools/bm-usage/idle')).j;
  const b = (await get('vw', '/tools/bm-usage/idle')).j;   // 바로 뒤(캐시 12초 안)
  assert.deepEqual(a.actions.review, { ok: true });
  assert.deepEqual(b.actions.review, { ok: false, why: 'role-operator' });
  assert.notEqual(G.gateKey({ user: { role: 'operator' } }, SNAP), G.gateKey({ user: { role: 'viewer' } }, SNAP));
  assert.notEqual(G.gateKey({ user: { role: 'admin', demoGuest: true } }, SNAP), G.gateKey({ user: { role: 'admin' } }, SNAP));
  assert.notEqual(G.gateKey({ user: { role: 'operator', scope: { writeVcenters: ['vcA'] } } }, SNAP), G.gateKey({ user: { role: 'operator' } }, SNAP));
});

test('E3 PowerCap 꺼짐 = 해당 없음(none) — 판정 하나(invCapState)를 하드웨어 U · 전력 보기 · 엣지 봉투가 공유 · 중앙 정제가 싣는다', async () => {
  const HF = await import('../src/bmusage/hwFacts.js');
  const { judgeUse } = await import('../src/bmusage/useJudge.js');
  const EP = await import('../src/bmusage/edgePull.js');
  const { sanitizePerfEntry } = await import('../src/central/bmPerfSanitize.js');
  const inv = (pc) => ({ collectedAt: NOW, ...(pc === undefined ? {} : { powerCap: pc }) });
  assert.deepEqual(HF.invCapState(inv({ limitWatts: 600 })), { state: 'set', limitWatts: 600 });
  for (const lw of [null, 0, '', '  ']) assert.deepEqual(HF.invCapState(inv({ limitWatts: lw })), { state: 'unset', limitWatts: null }, `limit ${JSON.stringify(lw)}`);
  assert.deepEqual(HF.invCapState(inv(undefined)), { state: 'unread', limitWatts: null });
  assert.deepEqual(HF.invCapState(null), { state: 'unread', limitWatts: null });
  const hwU = (pc, { stale = false } = {}) => {
    const hw = HF.shapeHwFacts({ power: { watts: 415, ts: NOW }, inv: { ...inv(pc), collectedAt: stale ? NOW - 10 * HOUR : NOW } }, { now: NOW, freshMs: 15 * 60_000 });
    return { hw, U: judgeUse({ row: { ts: NOW, idrac_at: NOW }, hw, coverage: 'idrac', th: {} }).cells.hw.U };
  };
  // 재현(기준판): limit null · 0 → missing(못 읽음) — 이제 none(해당 없음)
  assert.equal(hwU({ limitWatts: null }).U.code, 'none');
  assert.equal(hwU({ limitWatts: 0 }).U.code, 'none');
  assert.equal(hwU({ limitWatts: null }).hw.power.capState, 'unset');
  assert.equal(hwU({ limitWatts: 600 }).U.code, 'ok');
  // 해당 없음은 읽을 칸이 아니다 — 분모(applicable)에서 빠진다(‘읽은 칸 n−1/n’ 이 수집 실패로 읽히지 않게)
  const rd = (pc) => { const hw = hwU(pc).hw; return judgeUse({ row: { ts: NOW, idrac_at: NOW }, hw, coverage: 'idrac', th: {} }).read; };
  assert.equal(rd({ limitWatts: null }).applicable, rd(undefined).applicable - 1);
  assert.equal(rd({ limitWatts: null }).judged, rd(undefined).judged);
  assert.equal(hwU(undefined).U.code, 'missing', 'PowerLimit 미보고는 못 읽음 그대로');
  assert.equal(hwU({ limitWatts: null }, { stale: true }).U.code, 'missing', '낡은 인벤토리는 사실이 아니다 — 못 읽음');
  // 엣지 봉투 — 같은 판정(unset → enabled false · unread → 싣지 않음)
  const invs = { r1: inv({ limitWatts: 600 }), r2: inv({ limitWatts: 0 }), r3: inv(undefined) };
  const tg = ['r1', 'r2', 'r3'].map((r, i) => ({ key: `K${i + 1}`, idrac: { regId: r } }));
  const env = EP.envelopePowerCaps(tg, new Set(['K1', 'K2', 'K3']), { inventoryOf: (id) => invs[id] });
  assert.deepEqual(env.powerCaps.map((x) => [x.key, x.enabled, x.limitWatts]), [['K1', true, 600], ['K2', false, null]]);
  // 중앙 정제 — capState 를 싣는다(아는 값만)
  assert.equal(sanitizePerfEntry({ key: 'K', hw: { power: { watts: 1, capState: 'unset' } } }).hw.power.capState, 'unset');
  assert.equal(sanitizePerfEntry({ key: 'K', hw: { power: { watts: 1, capState: '<x>' } } }).hw.power.capState, null);
  // 판정 사본이 남지 않았다(전력 보기 · 엣지 봉투가 같은 함수를 부른다)
  const strip = (await import('./_stripComments.js')).stripComments;
  for (const f of ['powerAgg.js', 'edgePull.js']) {
    const s = strip(fs.readFileSync(new URL(`../src/bmusage/${f}`, import.meta.url), 'utf8'));
    assert.match(s, /invCapState\(/, `${f}: invCapState 를 쓴다`);
    assert.doesNotMatch(s, /limitWatts\)?\s*(?:>|&&)[^;\n]*>\s*0/, `${f}: 상한 판정 사본(limitWatts > 0)이 없다`);
  }
});

test('I2 · I3 — 장치 응답 피크 창 상한 · 엣지 정제 · 용량 상세 임박 기준', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const Q = await import('../src/bmusage/trendQuery.js');
  assert.equal((await Q.devicesFor({ agent: '', key: 'CTAGA1', settings: { store: { peakWindowS: 5 } } })).peakWindowCapS, 5);
  assert.equal((await Q.devicesFor({ agent: '', key: 'CTAGA1', settings: { store: { peakWindowS: 0 } } })).peakWindowCapS, 0, '0(끔)도 설정값');
  assert.equal((await Q.devicesFor({ agent: '', key: 'CTAGA1', settings: { peakWindowS: 5 } })).peakWindowCapS, null, '저장 구조 설정(store) 밖의 같은 이름은 읽지 않는다');
  assert.equal((await Q.devicesFor({ agent: '', key: 'CTAGA1' })).peakWindowCapS, null, '설정을 모르면 null');
  const { sanitizeDevicesBody } = await import('../src/central/bmUsageEdgePull.js');
  assert.equal(sanitizeDevicesBody({ ok: true, devices: {}, peakWindowCapS: '20' }).peakWindowCapS, 20);
  assert.equal(sanitizeDevicesBody({ ok: true, devices: {} }).peakWindowCapS, null, '구버전 엣지 — null(화면은 줄었는지 말하지 않는다)');
  // 엣지 쪽(중앙 대행이 부르는 collector 경로)도 그 노드 설정 상한을 싣는다
  const ed = await fetch(`http://127.0.0.1:${port}/api/collector/bm-usage/devices?key=CTAGA1`, { headers: { 'X-Collector-Token': 'tok-loop2' } }).then((r) => r.json());
  assert.equal(ed.peakWindowCapS, 10, `엣지 collector 장치 응답 ${JSON.stringify(ed).slice(0, 160)}`);
  const dv = await get('adm', '/tools/bm-usage/perf/CTAGA1/devices?vcenterId=vcA');
  assert.equal(dv.s, 200); assert.equal(dv.j.peakWindowCapS, 10, '이 노드 설정 기본값(settings.js STORE_DEFAULTS.peakWindowS)');
  const cd = await get('adm', '/tools/bm-usage/capacity/CTAGA1?vcenterId=vcA');
  assert.equal(cd.s, 200); assert.equal(cd.j.alertDays, 7, '함대 표 cfg.alertDays 와 같은 기준(규칙 기본 7일)');
});
