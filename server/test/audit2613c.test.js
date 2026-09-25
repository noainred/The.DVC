// v2.613 감사 그룹 C(G3) — 서버 의존 방향·동적 import·설정 pull 404 회귀 고정.
//   DEPS2613-01 envTimeout/central404 는 util/ 이 본체(agent/ 는 재수출) · config.js 는 util/·security/·node 내장만
//   DEPS2613-02 같은 모듈을 정적 + 동적으로 이중 import 하는 파일 0(idrac/redfish.js ↔ bmusage/parse/idracTelemetry.js)
//   DEPS2613-03 '순환' 주석이 붙은 동적 import 는 실제 되돌이 경로가 있어야 한다 + 되돌이 경로 있는 동적 import 3곳 고정
//   DEPS2613-06·EDGE2613-06 설정 pull 4벌(gpuGuest·pdu·storage·users)의 404 사유 판정(classifyCentral404) — 목 중앙으로 실제 호출
//   EDGE2613-08 수집 서버 이름 조회는 collector/registry.js findCollectorByName 하나(edgeLogPull·idracScanPush 는 재수출)
//   RUNTIME2613-03(b) arch2579 ③ 풀 스캐폴드 정규식이 `Math.max(1, Math.min(…))` 형태를 본다
// 소스 스윕은 test/_stripComments.js 로 주석을 먼저 지운다(v2.535 규약) — 단 DEPS2613-03 은 **주석 자체**를 검사하므로 원문을 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2613c-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (p.endsWith('.js')) files.push(p);
  }
})(SRC);
const resolveTarget = (from, spec) => {
  let t = path.resolve(path.dirname(from), spec);
  if (!t.endsWith('.js')) t = fs.existsSync(`${t}.js`) ? `${t}.js` : path.join(t, 'index.js');
  return fs.existsSync(t) ? rel(t) : null;
};
/** 정적 import/재수출 edge 만(arch2579 와 같은 정규식에서 동적 import 를 뺐다). */
const staticImportsOf = (p) => {
  const out = [];
  for (const m of stripComments(fs.readFileSync(p, 'utf8')).matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
    const t = resolveTarget(p, m[1]); if (t) out.push(t);
  }
  return out;
};
/** 동적 import 목록 — [{ line, target }] (주석 제거본 기준 줄 번호는 원문과 같다: stripComments 는 개행을 보존한다). */
const dynamicImportsOf = (p) => {
  const s = stripComments(fs.readFileSync(p, 'utf8'));
  const out = [];
  for (const m of s.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const t = resolveTarget(p, m[1]);
    if (t) out.push({ line: s.slice(0, m.index).split('\n').length, target: t });
  }
  return out;
};
let _graph = null;
const staticGraph = () => {
  if (!_graph) _graph = new Map(files.map((f) => [rel(f), staticImportsOf(f)]));
  return _graph;
};
/** 정적 edge 만 따라 from → to 에 닿는가(BFS). */
const staticReach = (from, to) => {
  const g = staticGraph(); const seen = new Set([from]); const q = [from];
  while (q.length) { const v = q.shift(); if (v === to) return true; for (const w of g.get(v) || []) if (!seen.has(w)) { seen.add(w); q.push(w); } }
  return false;
};

// ── DEPS2613-01 ───────────────────────────────────────────────────────────────
test('DEPS2613-01: envTimeout·central404 본체는 util/ 이고 agent/ 옛 경로는 같은 함수를 재수출한다', async () => {
  const ue = await import('../src/util/envTimeout.js');
  const ae = await import('../src/agent/envTimeout.js');
  assert.equal(typeof ue.reqTimeoutMs, 'function');
  assert.equal(ae.reqTimeoutMs, ue.reqTimeoutMs, '옛 경로는 사본이 아니라 같은 함수여야 한다');
  const uc = await import('../src/util/central404.js');
  const ac = await import('../src/agent/central404.js');
  assert.equal(ac.classifyCentral404, uc.classifyCentral404);
  assert.equal(ac.classifyCentral404Body, uc.classifyCentral404Body);
  // 본체가 util/ 에 있다(agent/ 쪽은 재수출 2줄 — 판정 본문이 두 벌이 되면 안 된다).
  const agentE = stripComments(read('agent/envTimeout.js')); const agentC = stripComments(read('agent/central404.js'));
  assert.ok(/import \{ reqTimeoutMs \} from '\.\.\/util\/envTimeout\.js';\s*export \{ reqTimeoutMs \};/.test(agentE), 'agent/envTimeout.js 는 import + export 재수출이어야 한다(v2.575 규약)');
  assert.ok(/import \{ classifyCentral404, classifyCentral404Body \} from '\.\.\/util\/central404\.js';\s*export \{ classifyCentral404, classifyCentral404Body \};/.test(agentC));
  assert.ok(/export function reqTimeoutMs\(/.test(stripComments(read('util/envTimeout.js'))));
  assert.ok(/export async function classifyCentral404\(/.test(stripComments(read('util/central404.js'))));
  // util/ 본체는 util/·node 내장만 import 한다(arch2579 ② 가 이미 고정하지만 이 두 파일을 이름으로 못 박는다).
  for (const f of ['util/envTimeout.js', 'util/central404.js']) assert.deepEqual(staticImportsOf(path.join(SRC, f)), [], `${f} 는 leaf 여야 한다`);
  // config.js(설정 leaf) 가 agent/ 를 향하지 않는 규칙은 arch2579 ②-c 가 갖는다(같은 판정을 두 벌 두지 않는다).
});

// ── DEPS2613-02 ───────────────────────────────────────────────────────────────
// 정적으로 이미 가져온 모듈을 함수 안에서 동적으로 또 import 하는 곳(캐시 조회일 뿐인 중복) — v2.613 시점 잔여 7곳.
// 이 감사 그룹의 파일이 아니라 고치지 않았다(다음 점검 후보). 목록이 **늘면** 실패, 줄면 통과(줄 번호는 보지 않는다).
const KNOWN_STATIC_DYNAMIC_DUP = new Set([
  'bmusage/poller.js -> config.js',
  'routes/api/cvp.js -> cvp/registry.js',
  'routes/api/edgeLog.js -> edgelog/collect.js',
  'routes/api/horizonSessions.js -> curuser/db.js',
  'routes/api/partFaults.js -> partfault/db.js',
  'routes/central.js -> collector/state.js',
  'svcmon/formats.js -> util/csv.js',
]);
test('DEPS2613-02: 같은 모듈을 정적 + 동적으로 이중 import 하는 파일이 늘지 않는다(redfish.js:21 ↔ :1204 는 한 줄로)', () => {
  const dup = [];
  for (const f of files) {
    const st = new Set(staticImportsOf(f));
    for (const d of dynamicImportsOf(f)) if (st.has(d.target)) dup.push(`${rel(f)} -> ${d.target}`);
  }
  const fresh = dup.filter((x) => !KNOWN_STATIC_DYNAMIC_DUP.has(x));
  assert.deepEqual(fresh, [], `정적으로 이미 가져온 모듈을 동적으로 또 import 한다(캐시 조회일 뿐인 중복 — 한 줄로 합칠 것):\n${fresh.join('\n')}`);
  assert.ok(!dup.includes('idrac/redfish.js -> bmusage/parse/idracTelemetry.js'));
  const rf = stripComments(read('idrac/redfish.js'));
  assert.match(rf, /import \{ pctFromMetric, pickReports, buildIdracUsage \} from '\.\.\/bmusage\/parse\/idracTelemetry\.js'/);
  assert.equal((rf.match(/idracTelemetry\.js/g) || []).length, 1, 'redfish.js 가 idracTelemetry 를 가리키는 곳은 정적 import 한 줄뿐');
});

// ── DEPS2613-03 ───────────────────────────────────────────────────────────────
// 되돌이(정적) 경로가 실제로 있어 동적 import 가 순환을 끊는 3곳 — 이 목록이 늘면 새 순환이 생긴 것이고, 줄면 그 동적 import 는
// 정적으로 바꿔도 된다(둘 다 이 테스트가 드러낸다).
const REAL_CYCLE_BREAKERS = [
  'config.js -> security/secretVault.js',
  'sanswitch/perfPush.js -> sanswitch/perfPoller.js',
  'vcenter/restClient.js -> vcenter/soapClient.js',
];
test('DEPS2613-03: 동적 import 근처(±4줄)의 \'순환\' 주석은 실제 되돌이 경로가 있을 때만 — 되돌이 경로 있는 동적 import 는 3곳 고정', () => {
  const falseClaims = [];
  const breakers = new Set();
  for (const f of files) {
    const r = rel(f);
    const raw = fs.readFileSync(f, 'utf8').split('\n');
    for (const d of dynamicImportsOf(f)) {
      const back = staticReach(d.target, r);
      if (back) breakers.add(`${r} -> ${d.target}`);
      const near = raw.slice(Math.max(0, d.line - 5), d.line + 4).join('\n');
      if (/순환/.test(near) && !back) falseClaims.push(`${r}:${d.line} -> ${d.target}`);
    }
  }
  assert.deepEqual(falseClaims, [], `'순환 회피' 라고 적었지만 되돌이 정적 경로가 없는 동적 import(주석이 낡았다 — 정적 import 로 바꾸고 주석을 지울 것):\n${falseClaims.join('\n')}`);
  assert.deepEqual([...breakers].sort(), REAL_CYCLE_BREAKERS, '되돌이 경로가 있는 동적 import 목록이 바뀌었다');
  // 고친 3곳은 정적 import 다.
  const reg = stripComments(read('collector/registry.js'));
  assert.match(reg, /import \{ resilientFetch \} from '\.\.\/util\/resilientFetch\.js'/);
  assert.doesNotMatch(reg, /import\(\s*['"]\.\.\/util\/resilientFetch\.js['"]\s*\)/);
  const hooks = stripComments(read('partfault/hooks.js'));
  assert.match(hooks, /import \{ pushPartFaultsNow \} from '\.\/push\.js'/);
  assert.match(hooks, /import \{ runPartFaultsNow \} from '\.\/poller\.js'/);
  assert.doesNotMatch(hooks, /import\(/);
});

// ── DEPS2613-06 · EDGE2613-06 ─────────────────────────────────────────────────
function mockCentral(handler) {
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const { status = 200, json = { ok: true }, html } = handler(req) || {};
      if (html != null) { res.writeHead(status, { 'Content-Type': 'text/html' }); res.end(html); return; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return srv;
}
const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv.address().port; };

test('DEPS2613-06·EDGE2613-06: 설정 pull 4벌의 404 는 central 꺼짐/거절/엔드포인트 없음을 가르고 상태에 남긴다(목 중앙)', async () => {
  // 소스 스윕 — agent/*ConfigPull.js 전부가 classifyCentral404 를 부른다(전에는 4벌이 빠져 `<- 404` 만 남겼다).
  const pulls = fs.readdirSync(path.join(SRC, 'agent')).filter((n) => /ConfigPull\.js$/.test(n)).sort();
  assert.ok(pulls.length >= 9, `설정 pull 모듈 수 ${pulls.length}`);
  const missing = pulls.filter((n) => !/classifyCentral404\(/.test(stripComments(read(`agent/${n}`))));
  assert.deepEqual(missing, [], `404 사유를 가르지 않는 설정 pull: ${missing.join(', ')}`);

  let mode = 'disabled';
  const srv = mockCentral(() => (mode === 'disabled' ? { status: 404, json: { ok: false, reason: 'central 비활성화' } }
    : mode === 'refused' ? { status: 404, json: { ok: false, reason: '이 엣지의 배정이 없습니다' } }
      : { status: 404, html: '<!DOCTYPE html><pre>Cannot GET /api/central/x</pre>' }));
  const port = await listen(srv);
  const warned = []; const origWarn = console.warn; console.warn = (...a) => { warned.push(a.join(' ')); };
  try {
    const { config } = await import('../src/config.js');
    const save = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
    config.agent.centralUrl = `http://127.0.0.1:${port}`;
    config.agent.centralToken = 'tok';
    config.agent.name = 'edge-c';
    try {
      const mods = [
        ['gpuGuestConfigPull', 'pullGpuGuestConfigNow', 'gpuGuestConfigPullStatus', (s) => s.last],
        ['pduConfigPull', 'pullPduConfigNow', 'pduConfigPullStatus', (s) => s],
        ['storageConfigPull', 'pullStorageConfigNow', 'storageConfigPullStatus', (s) => s],
        ['usersConfigPull', 'pullUsersConfigNow', 'usersConfigPullStatus', (s) => s.last],
      ];
      for (const [mod, run, status, pick] of mods) {
        const m = await import(`../src/agent/${mod}.js`);
        for (const [mk, kind] of [['disabled', 'disabled'], ['html', 'no-endpoint'], ['refused', 'refused']]) {
          mode = mk;
          const r = await m[run]();
          assert.equal(r.ok, false, `${mod}/${mk}: 404 를 성공으로 보고하지 않는다`);
          assert.equal(r.kind, kind, `${mod}/${mk}: 반환 kind`);
          assert.ok(typeof r.reason === 'string' && r.reason.includes('404'), `${mod}/${mk}: 사유 문장 — ${r.reason}`);
          const st = pick(m[status]());
          assert.equal(st.kind, kind, `${mod}/${mk}: 상태에 kind 가 남는다`);
          assert.equal(st.ok, false, `${mod}/${mk}: 상태 ok=false`);
          assert.ok(String(st.error || st.reason || '').includes('404'), `${mod}/${mk}: 상태에 사유가 남는다`);
        }
      }
      // 조치가 정반대인 두 사유가 다른 문장이다(한 문구로 덮지 않는다).
      const { classifyCentral404Body } = await import('../src/util/central404.js');
      assert.notEqual(classifyCentral404Body({ ok: false, reason: 'central 비활성화' }).reason, classifyCentral404Body(null).reason);
      // 콘솔에도 남는다(무음 실패 금지 — v2.549·v2.591 PR-7 규약). 같은 사유는 10분 창에서 한 줄이므로 모듈당 종류별 1줄 이상.
      for (const tag of ['gpu-guest-config', 'pdu-config', 'storage-config', 'users-config']) {
        assert.ok(warned.some((w) => w.includes(`[${tag}]`) && /404/.test(w)), `${tag}: 404 사유가 콘솔에 남는다`);
      }
    } finally { config.agent.centralUrl = save.url; config.agent.centralToken = save.tok; config.agent.name = save.name; }
  } finally { console.warn = origWarn; srv.close(); }
});

// ── EDGE2613-08 ───────────────────────────────────────────────────────────────
test('EDGE2613-08: 수집 서버 이름 조회는 registry.findCollectorByName 하나 — edgeLogPull·idracScanPush 는 재수출·래퍼', async () => {
  const reg = await import('../src/collector/registry.js');
  const push = await import('../src/central/idracScanPush.js');
  const elp = await import('../src/central/edgeLogPull.js');
  assert.equal(typeof reg.findCollectorByName, 'function');
  assert.equal(push.findCollectorForAgent, reg.findCollectorByName, 'idracScanPush 는 같은 함수를 재수출한다(사본 금지)');
  // 등록부에 실제로 넣고 대소문자·공백 무시 · id/name 양쪽 · 원본 토큰(마스킹 아님) 을 본다.
  const added = reg.addCollector({ id: 'oc2-sb-2613', name: 'OC2Sandbox', url: 'http://10.9.9.9:4000', token: 'SECRET-TOKEN-2613', datacenter: 'dc', enabled: true });
  assert.ok(added && added.ok !== false, `등록: ${JSON.stringify(added)}`);
  const c = { id: 'oc2-sb-2613' };
  try {
    for (const q of ['oc2sandbox', ' OC2SANDBOX ', c.id, 'OC2-SB-2613']) {
      const hit = reg.findCollectorByName(q);
      assert.ok(hit && hit.id === c.id, `'${q}' 로 찾는다`);
      assert.equal(hit.token, 'SECRET-TOKEN-2613', '원본(토큰 포함)을 돌려준다 — listCollectors 마스킹본이 아니다');
      const viaWrapper = await elp.findCollector(q);
      assert.ok(viaWrapper && viaWrapper.id === c.id && viaWrapper.token === 'SECRET-TOKEN-2613', 'edgeLogPull 래퍼도 같은 판정');
    }
    assert.equal(reg.findCollectorByName('no-such-edge'), null);
    assert.equal(reg.findCollectorByName(''), null);
    assert.equal(reg.findCollectorByName(null), null);
    assert.equal(await elp.findCollector('no-such-edge'), null);
  } finally { reg.removeCollector(c.id); }
  // 소스 스윕 — 등록부 밖에서 수집 서버 목록을 **이름(name)으로 대소문자 무시** 조회하는 사본 0
  // (id 정확 일치·url 비교는 다른 관심사라 대상이 아니다 — autoRegister·puller·collectorsDc·deployLlm 이 그것이다).
  const copies = [];
  for (const f of files) {
    const r = rel(f); if (r === 'collector/registry.js') continue;
    for (const line of stripComments(fs.readFileSync(f, 'utf8')).split('\n')) {
      if (/\.find\(/.test(line) && /\.name\b/.test(line) && /toLowerCase\(\)/.test(line) && /\bc(?:ollectors?)?\b|loadCollectors/.test(line)) copies.push(`${r}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(copies, [], `수집 서버 이름 조회 사본: ${copies.join(', ')}`);
  assert.doesNotMatch(stripComments(read('central/edgeLogPull.js')), /import\(\s*['"]\.\.\/collector\/registry\.js['"]\s*\)/, '순환 사유가 없는 동적 import 는 정적으로');
});

// ── RUNTIME2613-03(b) ─────────────────────────────────────────────────────────
test('RUNTIME2613-03(b): arch2579 ③ 정규식은 `Math.max(1, Math.min(…))` 손 풀을 보고 (_, k) 매핑은 보지 않는다', () => {
  const t = stripComments(fs.readFileSync(path.join(TEST_DIR, 'arch2579.test.js'), 'utf8'));
  assert.doesNotMatch(t, /Math\\\.min\\\(limit/, '변수 이름 하나(limit)만 보던 예전 리터럴이 남아 있다');
  const m = t.match(/const POOL_SCAFFOLD_RE = (\/.*\/);/);
  assert.ok(m, 'arch2579 에 POOL_SCAFFOLD_RE 가 있다');
  const re = new Function(`return ${m[1]};`)();
  assert.ok(re.test("const workers = Array.from({ length: Math.max(1, Math.min(PROBE_CONCURRENCY, rows.length)) }, async () => {"), 'portalCheck 형태');
  assert.ok(re.test("await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => {"), '예전 limit 형태도 여전히');
  assert.ok(re.test("await Promise.all(Array.from({ length: Math.min(config.ping.concurrency, targets.length) }, worker));"), '이름 붙은 worker 형태');
  assert.ok(!re.test("ports: Array.from({ length: Math.min(8, n(0, 8)) }, (_, k) => `vm-${k}`),"), '인덱스를 받는 매핑은 풀이 아니다');
  assert.ok(!re.test("Array.from({ length: Math.max(1, Number(inv.cpu?.count) || 1) }, () => ({ label: m }))"), '항목 생성 매핑은 풀이 아니다');
  // v2.594 '결함 아님' 7곳은 사유와 함께 명시돼 있다(암묵 통과 금지).
  for (const f of ['ping/monitor.js', 'bmstor/collect.js', 'idrac/redfish.js', 'idrac/scan.js', 'routes/admin/deployLlm.js', 'security/certMonitor.js']) {
    assert.ok(new RegExp(`\\['${f.replace(/[./]/g, '\\$&')}', 'v2\\.594 판정`).test(t), `${f} 가 POOL_EXCLUDED 에 사유와 함께 있다`);
  }
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
before(() => {});
