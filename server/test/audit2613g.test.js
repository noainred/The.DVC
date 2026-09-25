/**
 * v2.613 감사 그룹 G — 런타임(서비스 점검 커버리지 · 엣지 팬아웃 풀·예산 · bmusage 예산 결합 · 기동 스태거 · push 크기 규약).
 *  RUNTIME2613-01 서비스 점검이 edgelog/spec.js 의 collect.* 폴러 전부(+중앙 전용)를 본다 ·
 *  RUNTIME2613-03(a) 토큰 점검 엣지 인출·베어메탈 엣지 인출은 util/pool.js + 총 예산 ·
 *  RUNTIME2613-05 bmusage 세션 예산은 장비 시한과 묶여 잘린다(env 조합) ·
 *  RUNTIME2613-06 기동 스태거는 마지막 폴러가 60초 안에 켜진다 ·
 *  DEPS2613-07·08 fleet·gpu-guest-data push 는 gzip + 중앙 BIG_JSON + 413 로그 · CONTRACT2613-08(반증) 주석 1줄.
 * 실제 api 라우터·목 중앙 HTTP 서버를 띄워 본다. 기준 시각은 고정값을 주입한다(Date.now() 를 경계로 쓰지 않는다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2613g-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', CENTRAL_TOKEN: 'shared-2613g', AGENT_NAME: 'e1',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
  BMUSAGE_PULL_BUDGET_MS: '20000', // 예산 하한(20초) < 엣지 1곳 최악(40초) → 인출은 시도 없이 '예산' 으로 끝나야 한다(네트워크 0)
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const bare = (p) => stripComments(read(p));
const WEB_SRC = path.join(SRC, '..', '..', 'web', 'src');
const quiet = async (fn) => {
  const w = console.warn; const l = console.log; const warned = [];
  console.warn = (...a) => { warned.push(a.join(' ')); }; console.log = () => {};
  try { return { value: await fn(), warned }; } finally { console.warn = w; console.log = l; }
};

// ── 목 중앙: 받은 헤더·본문(gzip 해제)을 모으고 경로별 응답을 바꾼다 ──
const got = [];
const replies = new Map();
const central = http.createServer((q, r) => {
  const ch = []; q.on('data', (c) => ch.push(c));
  q.on('end', () => {
    let b = Buffer.concat(ch); const enc = q.headers['content-encoding'] || '';
    try { if (enc === 'gzip') b = zlib.gunzipSync(b); } catch { /* */ }
    let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
    const p = q.url.split('?')[0];
    got.push({ path: p, enc, body, raw: Buffer.concat(ch).length });
    const out = (replies.get(p) || (() => ({ status: 200, json: { ok: true } })))(body);
    r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(out.json));
  });
});
let CENTRAL = '';
let srv, base;
const USERS = { full: { username: 'full', role: 'admin', scope: null } };
before(async () => {
  await new Promise((r) => central.listen(0, '127.0.0.1', r));
  CENTRAL = `http://127.0.0.1:${central.address().port}`;
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { central.close(); } catch { /* */ } try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });
async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

// ─────────────────────────────────────────────────────────────────────────────
test('RUNTIME2613-01: 서비스 점검은 edgelog/spec.js 의 collect.* 폴러 전부를 본다(spec 키 ⊆ 점검 행) + 중앙 전용 2개 + 대상 밖을 밝힌다', async () => {
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const svc = await import('../src/health/services.js');
  const r = svc.getServiceCheck();
  // 응답 모양은 그대로(overall·summary·checks[]{key,label,status,detail,at}) + coverage(추가)
  assert.ok(['ok', 'warn', 'down'].includes(r.overall));
  assert.equal(r.summary.total, r.checks.length);
  for (const c of r.checks) {
    assert.ok(c.key && c.label, `행에 key·label 이 없다: ${JSON.stringify(c)}`);
    assert.ok(['ok', 'warn', 'down', 'off'].includes(c.status), `${c.key}: status ${c.status}`);
    assert.equal(typeof c.detail, 'string'); assert.equal(typeof c.at, 'number');
  }
  const collect = STATUS_SPEC.filter((s) => s.group === 'collect').map((s) => s.key);
  assert.ok(collect.length >= 27, `spec collect.* 가 ${collect.length}개 — 표가 줄었다면 이 테스트를 다시 볼 것`);
  const have = new Set(r.checks.map((c) => c.specKey).filter(Boolean));
  const missing = collect.filter((k) => !have.has(k));
  assert.deepEqual(missing, [], `서비스 점검이 모르는 폴러(수정 전에는 고정 13항목뿐이라 CVP·bmusage·통신 점검이 멈춰도 정상이었다): ${missing.join(', ')}`);
  // 같은 폴러를 두 줄로 그리지 않는다
  const dup = [...r.checks.map((c) => c.specKey).filter(Boolean)].filter((k, i, a) => a.indexOf(k) !== i);
  assert.deepEqual(dup, []);
  // 점검 미구현(대응표에 없는 모듈) 행이 없다 — spec 에 새 모듈이 생겼는데 services.js 가 모르면 여기서 드러난다
  assert.deepEqual(r.checks.filter((c) => /점검 미구현/.test(c.detail)).map((c) => c.key), []);
  // 중앙 전용(이 프로세스는 CENTRAL_URL 없음 = 중앙) — relaycheck·partfault 행이 있다
  for (const k of svc.CENTRAL_ONLY_SPEC.map((x) => x.key)) assert.ok(have.has(k), `중앙 전용 ${k} 행이 없다`);
  // 대상 밖(push/pull 워커)을 문구로 말한다
  assert.ok(Array.isArray(r.coverage.notCovered) && r.coverage.notCovered.every((k) => /^(push|pull)\./.test(k)));
  assert.match(r.coverage.note, /push\/pull 워커/);
  assert.equal(r.coverage.pollers, collect.length + svc.CENTRAL_ONLY_SPEC.length);
  // 소스 대조: spec 의 mod 경로 전부가 services.js 대응표(MODS)에 있다
  const s = bare('health/services.js');
  const mods = STATUS_SPEC.filter((x) => x.group === 'collect').map((x) => x.mod);
  const absent = mods.filter((m) => !s.includes(`'${m}':`));
  assert.deepEqual(absent, [], `MODS 대응표에 없는 spec 모듈: ${absent.join(', ')}`);
  // 동기 API 를 유지한다(소비처 checksLogs.js 가 그대로 res.json 한다)
  assert.doesNotMatch(s, /export async function getServiceCheck/);
});

test('RUNTIME2613-01(b): 공통 판정 — 꺼짐 → off · 주기×2(최소 30분) 초과 → warn · 실행 기록 없이 경계를 넘긴 기동 → warn · 시각 이름 6종을 다 읽는다', async () => {
  const { pollerCheck, pollerLastAt, pollerIntervalMs } = await import('../src/health/services.js');
  const NOW = 1_780_000_000_000; const MIN = 60_000;
  assert.equal(pollerCheck({ enabled: false }, { now: NOW, uptimeMs: 0 }).status, 'off');
  assert.equal(pollerCheck({ settings: { enabled: false } }, { now: NOW, uptimeMs: 0 }).status, 'off');
  // 주기 5분 → 경계 30분(최소) · 주기 60분 → 경계 120분
  assert.equal(pollerCheck({ intervalMs: 5 * MIN, at: NOW - 29 * MIN }, { now: NOW }).status, 'ok');
  assert.equal(pollerCheck({ intervalMs: 5 * MIN, at: NOW - 31 * MIN }, { now: NOW }).status, 'warn');
  assert.equal(pollerCheck({ intervalMs: 60 * MIN, at: NOW - 119 * MIN }, { now: NOW }).status, 'ok', '주기가 길면 30분 고정 경계로 오탐하지 않는다(v2.591 R-H1)');
  assert.equal(pollerCheck({ intervalMs: 60 * MIN, at: NOW - 121 * MIN }, { now: NOW }).status, 'warn');
  // 실행 기록 없음: 기동 직후는 ok, 경계를 넘긴 뒤에도 없으면 warn(v2.590 W1 — 멈춘 폴러를 정상으로 칠하지 않는다)
  assert.equal(pollerCheck({ intervalMs: 5 * MIN, lastRun: null }, { now: NOW, uptimeMs: 10 * MIN }).status, 'ok');
  assert.equal(pollerCheck({ intervalMs: 5 * MIN, lastRun: null }, { now: NOW, uptimeMs: 31 * MIN }).status, 'warn');
  // 마지막 실행 시각 이름 — 모듈마다 다르다
  for (const st of [{ at: NOW }, { last: { at: NOW } }, { lastRun: { at: NOW } }, { lastRun: NOW }, { lastRunTs: NOW }, { lastRunAt: NOW }, { lastTickAt: NOW }, { lastPollAt: NOW }, { lastTick: NOW }]) {
    assert.equal(pollerLastAt(st), NOW, JSON.stringify(st));
  }
  assert.equal(pollerLastAt({ at: 0, lastRun: null }), null, '0·null 은 실행 없음');
  assert.equal(pollerIntervalMs({ intervalMinutes: 10 }), 10 * MIN);
  assert.equal(pollerIntervalMs({ pollIntervalMs: 60_000 }), 60_000);
  assert.equal(pollerIntervalMs({}), null);
});

// ─────────────────────────────────────────────────────────────────────────────
test('RUNTIME2613-03(a): 토큰 점검 엣지 인출·베어메탈 엣지 인출은 util/pool.js + 총 예산이고 예산 초과 개수를 응답에 밝힌다', async () => {
  // 소스: 손 풀 스캐폴드·순차 for 가 사라지고 poolSettled 를 쓴다
  const pc = bare('routes/api/portalCheck.js');
  assert.doesNotMatch(pc, /Array\.from\(\{\s*length:\s*Math\.(min|max)\(/, '토큰 점검 인출에 손으로 쓴 풀이 남아 있다(v2.579 규약)');
  assert.match(pc, /import \{ poolSettled \} from '\.\.\/\.\.\/util\/pool\.js'/);
  assert.match(pc, /budgetExceeded/, '예산 초과 개수를 응답에 실어야 한다(조용한 상한 금지)');
  const bm = bare('routes/api/bmUsage.js');
  assert.doesNotMatch(bm, /for \(const a of agents\)/, '베어메탈 엣지 인출이 순차 for 로 남아 있다');
  assert.match(bm, /poolSettled\(agents, EDGE_PULL_CONCURRENCY/);
  // 산수: 예산 + 엣지 1곳 최악 ≤ 웹 시한(api.js MUT_TIMEOUT_MS) — 같거나 크면 화면이 먼저 끊긴다
  const m = /const MUT_TIMEOUT_MS = ([\d_]+)/.exec(fs.readFileSync(path.join(WEB_SRC, 'api.js'), 'utf8'));
  assert.ok(m, '웹 MUT_TIMEOUT_MS 를 찾지 못했다');
  const webMs = Number(m[1].replace(/_/g, ''));
  const r = await import('../src/routes/api/bmUsage.js');
  assert.ok(r.EDGE_PULL_BUDGET_MS + r.EDGE_PULL_WORST_MS <= webMs, `예산 ${r.EDGE_PULL_BUDGET_MS} + 최악 ${r.EDGE_PULL_WORST_MS} > 웹 시한 ${webMs}`);
  assert.equal(r.EDGE_PULL_BUDGET_MS, 20_000, '이 테스트는 env 로 예산을 하한(20초)으로 두었다');
  // 런타임: 예산(20초) < 엣지 1곳 최악(40초) → 세 곳 모두 시도 없이 '예산' 으로 끝나고 개수가 응답에 있다(네트워크 0)
  const res = await call('full', 'POST', '/tools/bm-usage/edges/pull', { agents: ['e-a', 'e-b', 'e-c'] });
  assert.equal(res.s, 200, res.t.slice(0, 200));
  assert.equal(res.j.budgetExceeded, 3, `수정 전에는 순차로 실제 인출을 시도했고 budgetExceeded 가 없었다: ${res.t.slice(0, 300)}`);
  assert.deepEqual(res.j.results.map((x) => [x.agent, x.ok, x.kind]), [['e-a', false, 'budget'], ['e-b', false, 'budget'], ['e-c', false, 'budget']], '입력 순서 보존 + 사유');
});

// ─────────────────────────────────────────────────────────────────────────────
function runNode(env, code) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(SRC, '..'), env: { ...process.env, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => resolve({ code: c, out, err }));
  });
}
const STATUS_CODE = `const m = await import('./src/bmusage/poller.js'); const s = m.bmUsageStatus(); console.log('@@' + JSON.stringify({ d: s.deviceTimeoutMs, os: s.osBudgetMs, osC: s.osBudgetClamped, ent: s.entBudgetEffectiveMs, entC: s.entBudgetClamped })); process.exit(0);`;

test('RUNTIME2613-05: bmusage 세션 예산은 장비 시한 − 5초 로 잘린다(순수 판정 + env 조합 실행) · 잘랐으면 콘솔 1줄 · 상태가 세 값을 밝힌다', async () => {
  const { coupleBudget, BUDGET_MARGIN_MS } = await import('../src/bmusage/poller.js');
  assert.equal(BUDGET_MARGIN_MS, 5_000);
  assert.deepEqual(coupleBudget(50_000, 60_000, 10_000), { effective: 50_000, clamped: false, cap: 55_000 }, '기본값은 잘리지 않는다');
  assert.deepEqual(coupleBudget(50_000, 30_000, 10_000), { effective: 25_000, clamped: true, cap: 25_000 }, '시한 30초면 예산 25초');
  assert.deepEqual(coupleBudget(50_000, 12_000, 10_000), { effective: 10_000, clamped: true, cap: 10_000 }, '하한(수집기의 최소 시도 시간) 아래로는 내려가지 않는다');
  assert.deepEqual(coupleBudget(45_000, 60_000, 15_000), { effective: 45_000, clamped: false, cap: 55_000 });
  // 수집기는 폴러가 준 예산을 쓴다(자기 상수가 아니라)
  const osSrc = bare('bmusage/collectors/osSsh.js');
  assert.match(osSrc, /collectOsUsage\(osHost = \{\}, \{ signal, budgetMs = SESSION_BUDGET_MS \}/);
  assert.match(osSrc, /budgetMs - READY_TIMEOUT_MS/);
  const pl = bare('bmusage/poller.js');
  assert.match(pl, /collectOsUsage\(target\.osHost, \{ signal, budgetMs: OS_BUDGET\.effective \}\)/);
  assert.match(pl, /budgetMs: ENT_BUDGET\.effective/);
  // env 조합 — 자식 프로세스에서 모듈을 다시 로드해 본다(기본값 / 장비 시한 30초 / 예산을 시한보다 크게)
  const base = { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' };
  const [dflt, dev30, budBig] = await Promise.all([
    runNode({ ...base }, STATUS_CODE),
    runNode({ ...base, BMUSAGE_DEVICE_TIMEOUT_MS: '30000' }, STATUS_CODE),
    runNode({ ...base, BMUSAGE_SESSION_BUDGET_MS: '90000', BMUSAGE_ENT_BUDGET_MS: '70000' }, STATUS_CODE),
  ]);
  const parse = (r) => { const m = /@@(\{.*\})/.exec(r.out); assert.ok(m, `자식 출력에 상태가 없다: ${r.err.slice(-400)}`); return JSON.parse(m[1]); };
  const a = parse(dflt);
  assert.deepEqual(a, { d: 60_000, os: 50_000, osC: false, ent: 45_000, entC: false });
  assert.doesNotMatch(dflt.err, /RUNTIME2613-05/, '기본값에서는 경고가 없어야 한다');
  const b = parse(dev30);
  assert.deepEqual(b, { d: 30_000, os: 25_000, osC: true, ent: 25_000, entC: true }, '수정 전에는 시한 30초에 예산 50·45초가 그대로였다(두 번째 시도 결과가 버려진다)');
  assert.match(dev30.err, /\[bmusage\] OS\(BMUSAGE_SESSION_BUDGET_MS\) 세션 예산 50초.*30초.*25초/);
  assert.match(dev30.err, /\[bmusage\] iDRAC 대체\(BMUSAGE_ENT_BUDGET_MS\) 세션 예산 45초/);
  const c = parse(budBig);
  assert.deepEqual(c, { d: 60_000, os: 55_000, osC: true, ent: 55_000, entC: true }, '예산 env 만 키워도 시한 − 5초로 잘린다');
});

// ─────────────────────────────────────────────────────────────────────────────
test('RUNTIME2613-06: 기동 스태거 간격은 총량으로 정해 마지막 폴러가 60초 안에 켜진다(index.js 소스로 계산)', () => {
  const s = bare('index.js');
  const arr = /const stagger = \[([\s\S]*?)\];/.exec(s);
  assert.ok(arr, 'stagger 배열을 찾지 못했다');
  const items = arr[1].split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
  assert.ok(items.length >= 60 && items.length <= 200, `스태거 항목 수가 이상하다: ${items.length}`);
  const f = /const STAGGER_STEP_MS = Math\.min\((\d+), Math\.floor\((\d[\d_]*) \/ Math\.max\(1, stagger\.length\)\)\);/.exec(s);
  assert.ok(f, '간격이 총량(min(1500, floor(60000 / N)))으로 정해져 있지 않다 — 수정 전에는 i * 1500 고정');
  assert.match(s, /\}, i \* STAGGER_STEP_MS\)/, 'setTimeout 이 STAGGER_STEP_MS 를 써야 한다');
  const cap = Number(f[1]); const total = Number(f[2].replace(/_/g, ''));
  assert.equal(cap, 1500); assert.equal(total, 60_000);
  const step = Math.min(cap, Math.floor(total / items.length));
  const lastStart = (items.length - 1) * step;
  assert.ok(lastStart <= 60_000, `마지막 폴러 기동 ${lastStart}ms > 60s (항목 ${items.length}개 × ${step}ms)`);
  assert.ok(step >= 300, `간격 ${step}ms — 항목이 200개를 넘으면 스태거의 CPU 평탄화가 무의미해진다(그때 총량을 다시 볼 것)`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('DEPS2613-07·08: gpu-guest-data·fleet 는 중앙 BIG_JSON 에 등록되고 엣지 push 는 gzip 으로 보내며 413 을 크기와 함께 찍는다(목 중앙 실제 호출) · CONTRACT2613-08 반증 주석', async () => {
  const idx = read('index.js');
  assert.match(idx, /app\.use\('\/api\/central\/gpu-guest-data',\s*BIG_JSON\)/, 'gpu-guest-data 가 BIG_JSON 에 없다');
  assert.match(idx, /app\.use\('\/api\/central\/fleet',\s*BIG_JSON\)/, 'fleet 가 BIG_JSON 에 없다');
  assert.match(idx, /작아서 등록하지 않음/, 'CONTRACT2613-08(반증) — 등록하지 않는 두 경로의 근거 주석');
  for (const f of ['agent/gpuGuestPush.js', 'agent/fleetPush.js']) {
    const s = bare(f);
    assert.match(s, /gzipAsync\(json\)/, `${f}: gzip 이 없다`);
    assert.match(s, /'Content-Encoding': 'gzip'/, `${f}: gzip 헤더가 없다`);
    assert.match(s, /res\.status === 413/, `${f}: 413 을 따로 찍지 않는다(v2.503 체크리스트)`);
  }
  // 런타임 — 목 중앙으로 실제 push
  const { config } = await import('../src/config.js');
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  config.agent.centralUrl = CENTRAL; config.agent.centralToken = 'shared-2613g'; config.agent.name = 'e1';
  const gp = await import('../src/agent/gpuGuestPush.js');
  const fp = await import('../src/agent/fleetPush.js');
  try {
    gp._setGuestPollerStatusForTest(() => ({ lastRun: { at: 1_780_000_000_000, unreadVcenters: [] } }));
    const n0 = got.length;
    const r1 = await quiet(() => gp.pushGpuGuestNow());
    assert.equal(r1.value.ok, true, JSON.stringify(r1.value));
    const g1 = got.slice(n0).find((g) => g.path === '/api/central/gpu-guest-data');
    assert.ok(g1, '목 중앙에 도착해야 한다');
    assert.equal(g1.enc, 'gzip', '수정 전에는 평문이었다');
    assert.equal(g1.body?.agent, 'e1', 'gzip 해제 후 본문이 온전해야 한다');
    fp._setFleetWithholdSinceForTest(null, null);
    const r2 = await quiet(() => fp.pushFleetNow());
    assert.equal(r2.value.ok, true, JSON.stringify(r2.value));
    const f1 = got.slice(n0).find((g) => g.path === '/api/central/fleet');
    assert.ok(f1); assert.equal(f1.enc, 'gzip'); assert.equal(f1.body?.agent, 'e1'); assert.ok(Array.isArray(f1.body?.baremetal));
    // 413 — 크기(KB)와 함께 콘솔에 남는다
    replies.set('/api/central/gpu-guest-data', () => ({ status: 413, json: { error: 'too large' } }));
    replies.set('/api/central/fleet', () => ({ status: 413, json: { error: 'too large' } }));
    const r3 = await quiet(() => gp.pushGpuGuestNow());
    assert.equal(r3.value.ok, false);
    assert.ok(r3.warned.some((w) => /\[gpu-guest-push\] 중앙이 본문 크기를 거부\(413\).*KB/.test(w)), `413 로그가 없다: ${JSON.stringify(r3.warned)}`);
    fp._setFleetWithholdSinceForTest(null, null);
    const r4 = await quiet(() => fp.pushFleetNow());
    assert.equal(r4.value.ok, false);
    assert.ok(r4.warned.some((w) => /\[fleet-push\] 중앙이 본문 크기를 거부\(413\).*KB/.test(w)), `413 로그가 없다: ${JSON.stringify(r4.warned)}`);
  } finally {
    replies.clear(); gp._setGuestPollerStatusForTest(null); fp._setFleetWithholdSinceForTest(null, null);
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
  }
});
