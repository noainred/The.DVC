/**
 * v2.614 — 특수 기능 › 포탈 점검 › **아키텍처 점검**(서버 코어) 회귀.
 *
 * 고정하는 것:
 *  ① 게이트 태그 — requireRole/requirePerm/fullScopeOnlyWith/requireSettingsOwner/toolGate/requireCentral 이 `.gate` 를 달고,
 *     `util/asyncRoute.js` 가 래핑할 때 그 태그를 **복사**한다(안 하면 wrapAsyncRouter 뒤 라우터 스택에서 태그가 사라진다).
 *  ② 실제 `api` 라우터를 express 에 마운트해 `GET /api/tools/portal-check/arch` 를 **상태코드로** 본다 — 전체 범위 admin 200 ·
 *     KPI 항등식 · 항목 코드 == ARCH_CODES · 범위 admin 403(v2.536 하니스 방식. 소스 grep 이 아니다).
 *  ③ 변이 — 합성 라우터에 fullScope 없는 admin POST 를 두면 route-gate-missing 1, `fullScopeOnlyWith` 를 붙이면 0.
 *  ④ 카탈로그를 못 읽으면 카탈로그 의존 항목은 **unknown** 이지 ok 가 아니다. 입력 하나의 실패는 그 항목만 unknown.
 *  ⑤ `stripComments` 는 `test/_stripComments.js` 와 같은 출력(배포 패키지에 test/ 가 없어 src 에 사본을 둔 근거 — 갈라지면 여기서 잡힌다).
 *
 * ⚠ CONFIG_DIR 은 import 전에 임시 디렉터리로 고정한다(config.js 싱글턴).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as testStrip } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archcheck2614-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

let srv; let base; let express; let A; let auth; let shared; let api; let adminRouter; let centralRouter; let collectorRouter; let asyncRoute;
const USERS = {
  full: { username: 'full', role: 'admin', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
  op: { username: 'op', role: 'operator', scope: null },
};
before(async () => {
  express = (await import('express')).default;
  auth = await import('../src/auth/auth.js');
  shared = await import('../src/routes/admin/shared.js');
  asyncRoute = await import('../src/util/asyncRoute.js');
  A = await import('../src/portalcheck/archScan.js');
  ({ api } = await import('../src/routes/api.js'));
  ({ adminRouter } = await import('../src/routes/admin.js'));
  ({ centralRouter } = await import('../src/routes/central.js'));
  ({ collectorRouter } = await import('../src/routes/collector.js'));
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  // index.js 의 BIG_JSON 마운트와 같은 모양(함수 이름 `gate`) — bigjson-missing 판정이 app 에서 읽는 것을 확인한다.
  function gate(_req, _res, next) { next(); }
  app.use('/api/central/inventory', gate);
  app.use('/api/admin', adminRouter);
  app.use('/api/central', centralRouter);
  app.use('/api/collector', collectorRouter);
  app.use('/api/insights', auth.requirePerm('insights'), express.Router());
  app.use('/api', api);
  A.setApp(app);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j };
}

/* ── ① 게이트 태그 ─────────────────────────────────────────────────────────── */
test('① 게이트 클로저에 .gate 태그가 있고 asyncRoute 가 그것을 복사한다', () => {
  assert.deepEqual(auth.requireRole('admin').gate, { kind: 'role', arg: ['admin'] });
  assert.deepEqual(auth.requireRole('admin', 'operator').gate, { kind: 'role', arg: ['admin', 'operator'] });
  assert.deepEqual(auth.requirePerm('tools', 'inv.vms').gate, { kind: 'perm', arg: ['tools', 'inv.vms'] });
  assert.deepEqual(shared.fullScopeOnlyWith('x').gate, { kind: 'fullScope' });
  assert.deepEqual(shared.adminOnly.gate, { kind: 'role', arg: ['admin'] });
  assert.deepEqual(shared.requireSettingsOwner.gate, { kind: 'settingsOwner' });
  const wrapped = asyncRoute.asyncRoute(shared.fullScopeOnlyWith('y'));
  assert.equal(wrapped.__asyncWrapped, true);
  assert.deepEqual(wrapped.gate, { kind: 'fullScope' }, 'asyncRoute 가 .gate 를 복사해야 한다');
  const plain = asyncRoute.asyncRoute((req, res) => res.end());
  assert.equal(plain.gate, undefined, '태그 없는 핸들러에 태그를 지어내지 않는다');
});

test('①-b toolGate·requireCentral 의 태그 — 실제 라우터 스택에서 읽힌다', async () => {
  const { toolGate } = await import('../src/auth/toolAccess.js');
  assert.deepEqual(toolGate({ roleOf: () => 'admin' }).gate, { kind: 'tool' });
  const { requireCentral } = await import('../src/routes/central.js');
  assert.deepEqual(requireCentral().gate, { kind: 'central' });
  const routes = A.routesOf({ name: 'central', mount: '/api/central', router: centralRouter });
  const inv = routes.find((r) => r.method === 'POST' && r.path === '/inventory');
  assert.ok(inv, 'central POST /inventory 가 스택에 있다');
  assert.ok(inv.gates.some((g) => g.kind === 'central'), 'wrapAsyncRouter 를 지난 뒤에도 central 태그가 남는다');
  const apiRoutes = A.routesOf({ name: 'api', mount: '/api', router: api });
  const tools = apiRoutes.find((r) => r.full === '/api/tools/portal-check/arch' && r.method === 'GET');
  assert.ok(tools, 'GET /api/tools/portal-check/arch 가 등록돼 있다');
  assert.ok(tools.gates.some((g) => g.kind === 'tool'), 'api.use(\'/tools\', toolGate) 가 /tools 하위 라우트에 붙는다');
  assert.ok(tools.gates.some((g) => g.kind === 'role' && g.arg[0] === 'admin'));
  assert.ok(tools.gates.some((g) => g.kind === 'fullScope'));
});

/* ── ② 실제 라우트 ─────────────────────────────────────────────────────────── */
test('② GET /api/tools/portal-check/arch — 전체 범위 admin 200 · KPI 항등식 · 코드 집합 == ARCH_CODES · 범위 admin 403', async () => {
  const full = await call('full', 'GET', '/tools/portal-check/arch');
  assert.equal(full.s, 200, JSON.stringify(full.j).slice(0, 300));
  const b = full.j;
  assert.equal(b.ok, true);
  assert.ok(Number.isFinite(b.at) && Number.isFinite(b.tookMs));
  const k = b.kpi;
  assert.equal(k.total, k.ok + k.warn + k.fault + k.unknown, 'KPI 항등식');
  assert.equal(k.total, b.items.length);
  assert.deepEqual(b.items.map((i) => i.code), [...A.ARCH_CODES], '항목 순서·집합이 ARCH_CODES 와 같다');
  for (const it of b.items) {
    assert.ok(A.ARCH_STATES.includes(it.state), `${it.code}: ${it.state}`);
    assert.ok(Array.isArray(it.samples) && it.samples.length <= 20);
    assert.equal(it.count, it.samples.length + it.omitted);
    if (it.state === 'unknown') assert.equal(it.count, 0);
  }
  assert.ok(Array.isArray(b.inputs.errors));
  assert.equal(b.inputs.appInjected, true);
  // 응답에 토큰·비밀번호 문자열이 없다(라우터 스택은 핸들러 함수를 담지만 직렬화되지 않는다).
  const text = JSON.stringify(b);
  assert.ok(!/"password"|"token":/.test(text));
  assert.ok(!/\?[a-z]+=/.test(text.replace(/https?:\/\/[^"]*/g, '')), 'URL 쿼리 0');
  // 이 저장소 현재 상태: 라우트·엣지 로그 표·풀 등은 정상이어야 한다(회귀가 생기면 여기서 드러난다).
  const by = Object.fromEntries(b.items.map((i) => [i.code, i]));
  for (const code of ['asyncroute-unwrapped', 'tool-segment-unmapped', 'edgelog-spec-drift', 'dataflow-cats-unmapped', 'util-imports-domain', 'db-no-purpose']) {
    assert.equal(by[code].state, 'ok', `${code}: ${JSON.stringify(by[code])}`);
  }
  // ⚠ 정직 기록(v2.614): 이 저장소의 현재 상태에서 **실제로 남아 있는** admin 상태변경 라우트 1개 — `PUT /api/admin/tool-categories`
  //   (특수 기능 카테고리 배치 = 전 법인 공통 설정)는 범위 admin 이 통째로 바꿀 수 있다(v2.605 가 '범위 admin 의 전 법인 공통 스칼라
  //   설정' 으로 남긴 것). 허용 목록에 거짓 사유를 적어 ok 로 만들지 않는다 — 고쳐지면(fleetOnly) 이 배열을 비울 것.
  const KNOWN_OPEN = []; // v2.614 통합: tool-categories PUT 에 fleetOnly 를 붙여 0 — 운영 트리에서 이 항목은 ok 여야 한다
  assert.deepEqual(by['route-gate-missing'].samples, KNOWN_OPEN, JSON.stringify(by['route-gate-missing']));
  assert.equal(by['route-gate-missing'].state, KNOWN_OPEN.length ? 'warn' : 'ok');
  assert.equal(by['import-cycle'].state, 'ok');
  assert.ok(by['import-cycle'].count <= A.IMPORT_CYCLE_MAX);
  assert.deepEqual(by['route-gate-missing'].detail.allowlistStale, [], '허용 목록에 실재하지 않는 라우트가 없다');
  // 범위 admin · operator 는 403(엣지·라우트 구조는 법인 축으로 나눌 수 없다).
  assert.equal((await call('sadm', 'GET', '/tools/portal-check/arch')).s, 403);
  assert.equal((await call('op', 'GET', '/tools/portal-check/arch')).s, 403);
  assert.equal((await call('sadm', 'POST', '/tools/portal-check/arch/run')).s, 403);
  // 즉시 재판정 — 같은 모양.
  const run = await call('full', 'POST', '/tools/portal-check/arch/run');
  assert.equal(run.s, 200);
  assert.deepEqual(run.j.items.map((i) => i.code), [...A.ARCH_CODES]);
});

test('②-b bigjson — app 마운트에서 등록을 읽고, 미등록·허용목록 밖만 센다', async () => {
  const inputs = await A.gatherArchInputs({ routers: [{ name: 'central', mount: '/api/central', router: centralRouter }, { name: 'collector', mount: '/api/collector', router: collectorRouter }] });
  assert.deepEqual(inputs.bigJsonMounts, ['/api/central/inventory'], 'requirePerm(insights) 의 클로저(이름 gate 가 아니다)는 BIG_JSON 으로 세지 않는다');
  const out = A.scanArch(inputs);
  const it = out.items.find((i) => i.code === 'bigjson-missing');
  assert.equal(it.state, 'warn');
  assert.ok(!it.samples.includes('central:/inventory'), '등록된 경로는 세지 않는다');
  assert.ok(!it.samples.includes('central:/register-collector'), '허용 목록(사유)은 세지 않는다');
  assert.ok(it.samples.includes('central:/guest-disk'), '이 합성 app 에는 guest-disk 가 등록되지 않았다');
  for (const why of Object.values(A.BIG_JSON_SMALL)) assert.ok(why.length > 5 && !why.includes('`'));
  // app 없이(setApp 전)는 unknown 이지 ok 가 아니다.
  const noApp = A.scanArch(await A.gatherArchInputs({ routers: [{ name: 'central', mount: '/api/central', router: centralRouter }], app: null }));
  assert.equal(noApp.items.find((i) => i.code === 'bigjson-missing').state, 'unknown');
  assert.ok(noApp.inputs.errors.some((e) => e.code === 'app'));
});

/* ── ③ 변이 — 합성 라우터 ───────────────────────────────────────────────────── */
test('③ 합성 admin 라우터 — fullScope 없는 POST 는 route-gate-missing 1, fullScopeOnlyWith 를 붙이면 0', () => {
  const mk = (withFull) => {
    const r = express.Router();
    asyncRoute.wrapAsyncRouter(r);
    const gates = [shared.adminOnly, ...(withFull ? [shared.fullScopeOnlyWith('x')] : [])];
    r.post('/things', ...gates, async (_req, res) => res.json({ ok: true }));
    r.get('/things', shared.adminOnly, (_req, res) => res.json({ ok: true }));           // 조회는 대상이 아니다
    r.post('/open', auth.requireRole('admin', 'operator'), (_req, res) => res.json({}));   // admin 전용이 아니다 — 대상 아님
    return r;
  };
  const scan = (router) => A.scanArch({ routes: A.routesOf({ name: 'admin', mount: '/api/admin', router }), errors: [], appInjected: true });
  const bad = scan(mk(false)).items.find((i) => i.code === 'route-gate-missing');
  assert.equal(bad.state, 'warn');
  assert.deepEqual(bad.samples, ['POST /api/admin/things']);
  const good = scan(mk(true)).items.find((i) => i.code === 'route-gate-missing');
  assert.equal(good.state, 'ok');
  assert.equal(good.count, 0);
});

test('③-b asyncroute-unwrapped — 래핑되지 않은 async 핸들러는 fault, wrapAsyncRouter 뒤에는 ok', () => {
  const raw = express.Router();
  raw.post('/x', async (_req, res) => res.json({}));
  const wrapped = asyncRoute.wrapAsyncRouter(express.Router());
  wrapped.post('/x', async (_req, res) => res.json({}));
  const st = (router) => A.scanArch({ routes: A.routesOf({ name: 'r', mount: '/api/r', router }), errors: [] }).items.find((i) => i.code === 'asyncroute-unwrapped');
  assert.equal(st(raw).state, 'fault');
  assert.deepEqual(st(raw).samples, ['POST /api/r/x']);
  assert.equal(st(wrapped).state, 'ok');
});

test('③-c tool-segment-unmapped — 매핑 없는 /tools 세그먼트는 fault', () => {
  const r = express.Router();
  r.get('/tools/no-such-tool-2614/list', (_req, res) => res.json({}));
  r.get('/tools/ipam', (_req, res) => res.json({}));
  const it = A.scanArch({ routes: A.routesOf({ name: 'api', mount: '/api', router: r }), errors: [] }).items.find((i) => i.code === 'tool-segment-unmapped');
  assert.equal(it.state, 'fault');
  assert.deepEqual(it.samples, ['no-such-tool-2614']);
});

/* ── ④ 카탈로그 · 입력 독립성 ───────────────────────────────────────────────── */
test('④ 카탈로그를 못 읽으면 카탈로그 의존 항목 3개는 unknown 이지 ok 가 아니다', async () => {
  const inputs = await A.gatherArchInputs({ routers: [{ name: 'api', mount: '/api', router: api }] });
  const missing = A.scanArch({ ...inputs, catalog: { source: 'missing', tools: [], count: 0, generatedAt: null, path: null, reason: 'not-found' } });
  for (const code of ['catalog-missing', 'catalog-key-orphan', 'catalog-adminonly-mismatch']) {
    assert.equal(missing.items.find((i) => i.code === code).state, 'unknown', code);
  }
  assert.equal(missing.catalog.source, 'missing');
  // 카탈로그가 있으면 판정한다 — 카탈로그에 없는 키(permissions/TOOL_PATH_KEYS 값)는 orphan, adminOnly 어긋남은 mismatch.
  const { TOOL_PATH_KEYS } = await import('../src/auth/toolAccess.js');
  const tools = [...new Set(Object.values(TOOL_PATH_KEYS))].map((k) => ({ k, adminOnly: false }));
  const present = A.scanArch({ ...inputs, catalog: { source: 'dist', tools, count: tools.length, generatedAt: 1, path: '/x/special-tools.json' } });
  const orphan = present.items.find((i) => i.code === 'catalog-key-orphan');
  assert.notEqual(orphan.state, 'unknown');
  assert.ok(orphan.samples.some((s) => s.startsWith('TOOL_PATH2_KEYS.') || s.startsWith('TOOL_EXACT_PATHS.') || s.startsWith('toolcats.')), '카탈로그에 없는 키가 잡힌다');
  const mm = present.items.find((i) => i.code === 'catalog-adminonly-mismatch');
  assert.notEqual(mm.state, 'unknown');
  assert.ok(mm.detail.judged > 0, '주 라우트가 있는 도구는 판정된다');
  // rma 는 `GET /api/tools/rma` 가 adminOnly 인데 합성 카탈로그가 adminOnly:false 라 했으므로 mismatch 에 잡혀야 한다.
  //   (portal-check 는 `GET /api/tools/portal-check` 자체가 없어 판정 대상이 아니다 — notJudged 로 센다.)
  assert.ok(mm.samples.some((s) => s.startsWith('rma:')), JSON.stringify(mm.samples));
  assert.ok(mm.detail.notJudged > 0);
  assert.equal(present.catalog.path, '/x/special-tools.json');
  assert.equal(A.scopeArchPaths(present, { role: 'operator' }).catalog.path, 'special-tools.json', '비-admin 은 basename');
  assert.equal(A.scopeArchPaths(present, { role: 'admin' }).catalog.path, '/x/special-tools.json');
});

test('④-b 입력 하나의 실패는 그 항목만 unknown — 나머지는 판정된다', async () => {
  const inputs = await A.gatherArchInputs({ routers: [{ name: 'api', mount: '/api', router: api }], dbDir: path.join(tmp, 'no-such-dir') });
  assert.ok(inputs.errors.some((e) => e.code === 'db-files'));
  const out = A.scanArch(inputs);
  const by = Object.fromEntries(out.items.map((i) => [i.code, i]));
  assert.equal(by['db-file-mode'].state, 'unknown');
  assert.equal(by['db-not-migratable'].state, 'unknown');
  assert.equal(by['db-no-purpose'].state, 'ok', '목록 대조는 파일과 무관하다');
  assert.equal(by['asyncroute-unwrapped'].state, 'ok');
  assert.equal(by['edgelog-spec-drift'].state, 'ok');
  assert.ok(out.inputs.errors.some((e) => e.code === 'db-files'));
});

test('④-c DB 파일 모드·MIGRATABLE·설정 파일 분류 — 실제 파일로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archdb-'));
  fs.writeFileSync(path.join(dir, 'host-temp.db'), ''); fs.chmodSync(path.join(dir, 'host-temp.db'), 0o600);
  fs.writeFileSync(path.join(dir, 'host-temp.db-wal'), ''); fs.chmodSync(path.join(dir, 'host-temp.db-wal'), 0o644);
  fs.writeFileSync(path.join(dir, 'mystery.db'), ''); fs.chmodSync(path.join(dir, 'mystery.db'), 0o600);
  fs.writeFileSync(path.join(dir, 'ipam.db'), ''); fs.chmodSync(path.join(dir, 'ipam.db'), 0o600);
  fs.writeFileSync(path.join(dir, 'vcenters.json'), '{}');
  fs.writeFileSync(path.join(dir, 'central-inventory.json'), '{}');
  fs.writeFileSync(path.join(dir, 'unknown-thing.json'), '{}');
  fs.writeFileSync(path.join(dir, 'portal.env'), '');
  fs.writeFileSync(path.join(dir, 'foo.example.json'), '{}');
  const out = A.scanArch(await A.gatherArchInputs({ routers: [], dbDir: dir, configDir: dir }));
  const by = Object.fromEntries(out.items.map((i) => [i.code, i]));
  assert.equal(by['db-file-mode'].state, 'warn');
  assert.deepEqual(by['db-file-mode'].samples, ['host-temp.db-wal (0644)']);
  assert.equal(by['db-not-migratable'].state, 'warn');
  assert.deepEqual(by['db-not-migratable'].samples, ['mystery.db'], 'ipam.db 는 사유와 함께 제외');
  assert.equal(by['config-file-unclassified'].state, 'warn');
  assert.deepEqual(by['config-file-unclassified'].samples, ['unknown-thing.json'], '비밀·상태·PURPOSES·알려진 설정은 분류된다 · 예제 파일은 대상 아님');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── ⑤ 코어 동일성 · 그래프 ─────────────────────────────────────────────────── */
test('⑤ stripComments 는 test/_stripComments.js 와 같은 출력(사본이 갈라지면 여기서 잡힌다)', () => {
  const files = ['portalcheck/archScan.js', 'agent/configPush.js', 'util/asyncRoute.js', 'routes/central.js', 'auth/auth.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.equal(A.stripComments(src), testStrip(src), f);
  }
});

test('⑤-b import 그래프·SCC 는 arch2579 와 같은 계산 — 현재 상한 안', () => {
  const g = A.buildImportGraph();
  assert.ok(g.size > 500, `파일 수 ${g.size}`);
  assert.ok(g.has('portalcheck/archScan.js'));
  assert.ok(!g.get('portalcheck/archScan.js').some((d) => d.startsWith('routes/')), 'archScan 은 routes/ 를 import 하지 않는다(규칙 ①)');
  const sccs = A.cyclesOf(g);
  assert.ok(sccs.length <= A.IMPORT_CYCLE_MAX, sccs.map((c) => c.join(' <-> ')).join('\n'));
  assert.ok(!sccs.some((c) => c.some((x) => x.startsWith('util/'))));
});

test('⑤-c mountPathOf — express 4 use() 레이어의 regexp 를 경로로 되돌린다', () => {
  const app = express();
  app.use('/api/admin', (_r, _s, n) => n());
  app.use('/api/central/link-check', (_r, _s, n) => n());
  app.use((_r, _s, n) => n());
  const L = A.appLayers(app).filter((l) => l.name !== 'query' && l.name !== 'expressInit');
  assert.deepEqual(L.map((l) => l.mount), ['/api/admin', '/api/central/link-check', '/']);
});

test('⑤-d 허용 목록의 사유는 비어 있지 않고 백틱이 없다 · 코드 집합 크기', () => {
  for (const m of [A.ROUTE_GATE_ALLOW, A.BIG_JSON_SMALL, A.UTIL_ALLOW, A.DB_MIGRATE_EXCLUDED, A.KNOWN_CONFIG_FILES]) {
    for (const [k, why] of Object.entries(m)) assert.ok(typeof why === 'string' && why.length > 5 && !why.includes('`'), k);
  }
  assert.equal(A.ARCH_CODES.length, 15);
  assert.equal(new Set(A.ARCH_CODES).size, 15);
});
