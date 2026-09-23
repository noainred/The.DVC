/**
 * v2.598 — 감사 그룹 c(AUTHZ-2598-01~05 · CENTRAL-01~03 · INJ-05) 회귀 고정.
 *
 * 권한 항목은 **실제 라우터를 express 에 마운트해** 상태코드·응답 필드로 본다(소스 grep 이 아니다).
 * 각 테스트는 수정을 되돌리면 실패하도록 입력을 골랐다(변이 검증은 보고서에 기록).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2598c-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_URL = 'https://central.example.internal:8443';
process.env.CENTRAL_TOKEN = 'tok-2598c';

const ADMIN = { username: 'adm', role: 'admin', scope: {} };
const ADMIN_SCOPED = { username: 'adm2', role: 'admin', scope: { vcenters: ['vc-a'] } };
const OPERATOR = { username: 'op', role: 'operator', scope: {} };
const VIEWER = { username: 'vw', role: 'viewer', scope: {} };

/** 라우터를 마운트하고 req.user 를 주입한 앱으로 GET/POST 1회. */
async function call(mount, router, user, method, url, body) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(mount, router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${mount}${url}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

/* ── AUTHZ-2598-01 /api/ping/series 가 엣지 주소 가림을 우회하지 않는다 ── */
test('AUTHZ-2598-01 — 엣지 대상 /series 는 /edge/overview 와 같은 계정 기준으로 host·port 를 가린다', async () => {
  const { seedEdgeTargets } = await import('../src/ping/store.js');
  const { pingRouter } = await import('../src/routes/ping.js');
  assert.equal(seedEdgeTargets([{ id: 'hq', name: 'HQ 엣지', url: 'https://10.20.30.40:4443' }]).ok, true);

  for (const u of [VIEWER, OPERATOR, ADMIN_SCOPED]) {
    const s = await call('/api/ping', pingRouter, u, 'GET', '/series?id=edge_hq');
    assert.equal(s.status, 200);
    assert.equal(s.body.target.host, null, `${u.username}: series host 가림`);
    assert.equal(s.body.target.port, null);
    assert.equal(s.body.addressHidden, true);
    assert.ok(!JSON.stringify(s.body).includes('10.20.30.40'), `${u.username}: 응답 어디에도 주소가 없다`);
    const o = await call('/api/ping', pingRouter, u, 'GET', '/edge/overview');
    assert.equal(o.body.addressHidden, true, '두 경로가 같은 판정');
  }
  const a = await call('/api/ping', pingRouter, ADMIN, 'GET', '/series?id=edge_hq');
  assert.equal(a.body.target.host, '10.20.30.40', 'admin + 전체 범위는 주소를 본다');
  assert.equal(a.body.addressHidden, undefined);
});

/* ── AUTHZ-2598-02 /api/remote/proxies 범위 필터 ── */
test('AUTHZ-2598-02 — 범위 계정은 자기 vCenter 프록시와 기본 프록시만, vcenterIds 도 교집합, 뺀 개수를 밝힌다', async () => {
  const { saveProxy } = await import('../src/proxy/registry.js');
  const { remoteRouter } = await import('../src/routes/remote.js');
  assert.equal(saveProxy({ name: 'P-A', proxyHost: '10.1.1.1', vcenterIds: ['vc-a', 'vc-z'] }).ok, true);
  assert.equal(saveProxy({ name: 'P-B', proxyHost: '10.2.2.2', vcenterIds: ['vc-b'] }).ok, true);

  const s = await call('/api/remote', remoteRouter, ADMIN_SCOPED, 'GET', '/proxies');
  assert.equal(s.status, 200);
  const names = s.body.proxies.map((p) => p.name).sort();
  assert.deepEqual(names, ['P-A', '기본 프록시']);
  assert.deepEqual(s.body.proxies.find((p) => p.name === 'P-A').vcenterIds, ['vc-a'], '범위 밖 vc-z 를 잘라낸다');
  assert.equal(s.body.omittedOutOfScope, 1);
  assert.equal(s.body.scoped, true);
  assert.ok(!JSON.stringify(s.body).includes('10.2.2.2'), '범위 밖 프록시 주소가 없다');

  const a = await call('/api/remote', remoteRouter, ADMIN, 'GET', '/proxies');
  assert.equal(a.body.proxies.length, 3, '전체 범위는 전량');
  assert.equal(a.body.omittedOutOfScope, undefined);
});

/* ── AUTHZ-2598-03 svcmon push·pull 상태의 centralUrl ── */
test('AUTHZ-2598-03 — svcmon /edges·/assign·/diag 의 push·pull 상태에서 centralUrl·실패 원문은 admin 만', async () => {
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const { redactPushStatus } = await import('../src/auth/scopeStatus.js');
  for (const [url, key] of [['/edges', 'push'], ['/assign', 'pull'], ['/diag', 'push']]) {
    const o = await call('/api/svcmon', svcmonRouter, OPERATOR, 'GET', url);
    assert.equal(o.status, 200, url);
    assert.equal(o.body[key].centralUrl, null, `${url} ${key}.centralUrl 가림`);
    assert.equal(o.body[key].addressHidden, true);
    assert.ok(!JSON.stringify(o.body).includes('central.example.internal'), `${url}: 주소가 어디에도 없다`);
    const a = await call('/api/svcmon', svcmonRouter, ADMIN, 'GET', url);
    assert.equal(a.body[key].centralUrl, 'https://central.example.internal:8443', `${url}: admin 은 본다`);
  }
  const r = redactPushStatus({ centralUrl: 'https://c', last: { at: 1, error: 'connect ECONNREFUSED 10.0.0.9:443', errors: ['a', 'b'], rows: 5 } }, OPERATOR);
  assert.equal(r.last.error, '(관리자만 확인)');
  assert.deepEqual(r.last.errors, ['(관리자만 확인)', '(관리자만 확인)'], '개수는 남기고 원문은 가린다');
  assert.equal(r.last.rows, 5, '성패·수치는 그대로');
});

/* ── AUTHZ-2598-04 작업 로그 파일 절대 경로 ── */
test('AUTHZ-2598-04 — bm-usage log.file·svcmon /log dir 은 비-admin 에게 파일 이름만', async () => {
  const { registerBmUsage } = await import('../src/routes/api/bmUsage.js');
  const r = express.Router();
  registerBmUsage(r);
  const o = await call('/api', r, OPERATOR, 'GET', '/tools/bm-usage/activity');
  assert.equal(o.status, 200);
  assert.equal(o.body.log.file, 'bmusage-activity.json', '절대 경로가 아니라 이름');
  assert.equal(o.body.log.pathHidden, true);
  assert.ok(!JSON.stringify(o.body).includes(CFG), 'CONFIG_DIR 경로가 응답에 없다');
  const a = await call('/api', r, ADMIN, 'GET', '/tools/bm-usage/activity');
  assert.equal(a.body.log.file, path.join(CFG, 'bmusage-activity.json'), 'admin 은 절대 경로');

  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const l = await call('/api/svcmon', svcmonRouter, VIEWER, 'GET', '/log');
  assert.equal(l.status, 200);
  assert.ok(l.body.dir && !path.isAbsolute(l.body.dir), `dir=${l.body.dir}`);
  assert.equal(l.body.pathHidden, true);
  assert.ok(!JSON.stringify(l.body).includes(CFG));
  const la = await call('/api/svcmon', svcmonRouter, ADMIN, 'GET', '/log');
  assert.ok(path.isAbsolute(la.body.dir), 'admin 은 절대 경로');
});

/* ── AUTHZ-2598-05 tool-usage 키 ── */
test('AUTHZ-2598-05 — 모르는 도구 키·상속 속성 키는 기록하지 않는다', async () => {
  const { recordToolUse, getTopTools, resetToolUsage, knownToolKeys } = await import('../src/tool-usage.js');
  resetToolUsage();
  assert.ok(knownToolKeys().has('ipam') && knownToolKeys().size >= 50);
  for (const k of ['constructor', 'toString', 'hasOwnProperty', 'not-a-tool-zzz', 'x'.repeat(40)]) {
    assert.equal(recordToolUse(k).ok, false, k);
  }
  assert.equal(getTopTools(10).length, 0, '아무것도 쌓이지 않았다');
  assert.equal(recordToolUse('ipam').ok, true);
  assert.deepEqual(getTopTools(10).map((t) => t.k), ['ipam']);
  assert.equal(getTopTools(10)[0].count, 1);
  resetToolUsage();
});

/* ── CENTRAL-01 gpu 게스트 진단 정제·상한 ── */
test('CENTRAL-01 — diag 는 아는 필드만·원소 수 상한·에이전트 수 상한', async () => {
  const m = await import('../src/central/gpuGuestDiag.js');
  m._resetGpuGuestDiagForTest();
  const huge = 'x'.repeat(100_000);
  m.setGpuGuestDiag('edge1', {
    at: 5, mode: 'live', junk: huge,
    vcenters: [
      { vcId: 'vc-a', stage: '완료', junk: huge, error: huge, counts: { gpuHosts: 2, evil: huge },
        results: Array.from({ length: 1000 }, (_, i) => ({ vm: `v${i}`, ok: true, util: '37', evil: huge })) },
      null, 'str', 7,
    ],
  }, { hosts: 3, vms: { x: 1 } });
  const [d] = m.getAllGpuGuestDiag();
  assert.equal(d.junk, undefined, '모르는 최상위 필드는 버린다');
  assert.equal(d.vcenters.length, 1, 'null·문자열·숫자 원소는 버린다');
  assert.equal(d.dropped, 3);
  const vc = d.vcenters[0];
  assert.equal(vc.junk, undefined);
  assert.equal(vc.error.length, 500, '문자열 길이 상한');
  assert.deepEqual(vc.counts, { gpuHosts: 2 });
  assert.equal(vc.results.length, m.MAX_RESULTS);
  assert.equal(vc.resultsOmitted, 1000 - m.MAX_RESULTS, '자른 개수를 밝힌다');
  assert.equal(vc.results[0].util, 37);
  assert.equal(vc.results[0].evil, undefined);
  assert.deepEqual(d.counts, { hosts: 3, vms: null });
  assert.ok(JSON.stringify(d).length < 200_000, `정제 뒤 크기 ${JSON.stringify(d).length}`);

  m._resetGpuGuestDiagForTest();
  for (let i = 0; i < m.MAX_AGENTS + 50; i++) m.setGpuGuestDiag(`ag${i}`, { vcenters: [] });
  const all = m.getAllGpuGuestDiag();
  assert.equal(all.length, m.MAX_AGENTS, '에이전트 수 상한');
  assert.ok(!all.some((a) => a.agent === 'ag0'), '가장 오래된 것부터 뺀다');
  assert.ok(all.some((a) => a.agent === `ag${m.MAX_AGENTS + 49}`));
  m.setGpuGuestDiag('y'.repeat(5000), {});
  assert.ok(m.getAllGpuGuestDiag().every((a) => a.agent.length <= 64), '이름 길이 상한');
  m._resetGpuGuestDiagForTest();
});

/* ── CENTRAL-02 오염된 진단이 소비처를 500 으로 만들지 않는다 ── */
test('CENTRAL-02 — vcenters 가 비배열·null 원소여도 정제 후 배열, 3D 그래프·로그 연합 소스가 200', async () => {
  const m = await import('../src/central/gpuGuestDiag.js');
  m._resetGpuGuestDiagForTest();
  m.setGpuGuestDiag('poison1', { vcenters: [null, { vcId: 'vc-q' }] });
  m.setGpuGuestDiag('poison2', { vcenters: 'not-an-array' });
  m.setGpuGuestDiag('poison3', { vcenters: { length: 2, 0: null } });
  for (const a of m.getAllGpuGuestDiag()) {
    assert.ok(Array.isArray(a.vcenters), `${a.agent}: 배열`);
    assert.ok(a.vcenters.every((v) => v && typeof v === 'object'), `${a.agent}: 원소는 객체`);
  }
  const { buildGraph } = await import('../src/insights/graph.js');
  assert.doesNotThrow(() => buildGraph({}), '그래프 조립이 던지지 않는다');

  const { api } = await import('../src/routes/api.js');
  const r = await call('/api', api, ADMIN, 'GET', '/tools/vclogs/sources');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.remote.some((x) => x.vcenterId === 'vc-q' && x.agent === 'poison1'), '정상 원소는 살린다');
  m._resetGpuGuestDiagForTest();

  // 방어선 2중 — 정제를 우회한 저장값이 생겨도 두 소비처가 같은 형식 가드를 둔다(한쪽만 고치면 형제로 재발).
  //   저장소 내부 맵을 테스트가 직접 오염시킬 길이 없어 소스로 고정한다(주석 제거 후).
  const { stripComments } = await import('./_stripComments.js');
  for (const f of ['insights/graph.js', 'routes/api/checksLogs.js']) {
    const src = stripComments(fs.readFileSync(path.resolve(import.meta.dirname, '../src', f), 'utf8'));
    assert.match(src, /!Array\.isArray\(a\.vcenters\)\) continue;/, `${f}: 비배열 가드`);
    assert.match(src, /for \(const vc of a\.vcenters\) if \(vc && vc\.vcId/, `${f}: null 원소 가드`);
  }
});

/* ── CENTRAL-03 /central/result 정제 ── */
test('CENTRAL-03 — 스캔 결과의 수치·found 원소를 정제한다(객체 위조는 null, 못 읽은 값을 0 으로 채우지 않는다)', async () => {
  const { sanitizeScanResult, setResult, getResults } = await import('../src/central/assignments.js');
  const r = sanitizeScanResult({
    scanned: { a: 1 }, foundCount: '3', unreachable: -1, notIdrac: [5], authFailed: 2, durationMs: 'x',
    found: [{ ip: '10.0.0.1', serviceTag: { $: 1 }, model: 'R750', hostName: 7, evil: 'x' }, null, 'str', ['a']],
  });
  assert.equal(r.scanned, null, '객체는 수치가 아니다');
  assert.equal(r.foundCount, 3);
  assert.equal(r.unreachable, null, '음수는 개수가 아니다');
  assert.equal(r.notIdrac, null);
  assert.equal(r.authFailed, 2);
  assert.equal(r.durationMs, null);
  assert.deepEqual(r.found, [{ ip: '10.0.0.1', serviceTag: '', model: 'R750', manufacturer: '', hostName: '7' }]);
  assert.equal(r.foundOmitted, 3, '버린 원소 수를 밝힌다');
  const miss = sanitizeScanResult({ found: [] });
  assert.equal(miss.scanned, null, '보고에 없는 값은 0 이 아니라 null');
  assert.equal(miss.foundCount, 0, 'found 길이는 센 값이다');
  for (const k of ['scanned', 'foundCount', 'unreachable', 'notIdrac', 'authFailed', 'durationMs']) {
    const v = r[k];
    assert.ok(v === null || typeof v === 'number', `${k} 는 숫자 또는 null`);
  }
  setResult('edge-x', { scanned: { evil: 1 }, found: 'x' });
  const saved = getResults()['edge-x'];
  assert.equal(saved.scanned, null);
  assert.deepEqual(saved.found, []);
  assert.equal(typeof saved.at, 'number');

  // 이미 저장된 오염 파일도 로드 시 정제된다 — 새 프로세스로 확인(모듈 캐시를 피한다).
  const cfg2 = fs.mkdtempSync(path.join(os.tmpdir(), 'a2598c-r-'));
  fs.writeFileSync(path.join(cfg2, 'agent-results.json'), JSON.stringify({ e1: { at: 9, scanned: { x: 1 }, found: [null, { ip: '1.2.3.4' }] }, bad: 'str' }));
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `import('./src/central/assignments.js').then(m=>console.log(JSON.stringify(m.getResults())))`],
    { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, CONFIG_DIR: cfg2 } }).toString();
  const loaded = JSON.parse(out.trim().split('\n').pop());
  assert.equal(loaded.e1.scanned, null);
  assert.equal(loaded.e1.at, 9);
  assert.deepEqual(loaded.e1.found.map((f) => f.ip), ['1.2.3.4']);
  assert.equal(loaded.bad, undefined);
  assert.ok(!fs.readdirSync(cfg2).some((f) => f.includes('.corrupt')), '멀쩡한 파일을 손상으로 보존하지 않는다(TDZ 회귀)');
});

/* ── INJ-05 AD 필터 치환 ── */
test('INJ-05 — 사용자명의 $` $\' $& 가 필터 조각을 끌어오지 않고, 치환은 한 번이다', async () => {
  const { buildUserFilter } = await import('../src/auth/ad.js');
  const F = '(&(objectClass=user)(userPrincipalName={upn}))';
  assert.equal(buildUserFilter(F, 'u', 'a$`b'), '(&(objectClass=user)(userPrincipalName=a$`b))');
  assert.equal(buildUserFilter(F, 'u', "a$'b"), "(&(objectClass=user)(userPrincipalName=a$'b))");
  assert.equal(buildUserFilter(F, 'u', 'a$&b'), '(&(objectClass=user)(userPrincipalName=a$&b))');
  assert.equal(buildUserFilter('(|(sAMAccountName={user})(upn={upn}))', 'bob', 'x{user}'),
    '(|(sAMAccountName=bob)(upn=x{user}))', '앞 치환값 안의 {user} 를 다시 치환하지 않는다');
  assert.equal(buildUserFilter(F, 'u', 'a*(b)'), '(&(objectClass=user)(userPrincipalName=a\\2a\\28b\\29))', '이스케이프는 그대로');
});

/* ── 후속 ② /api/svcmon/diag 의 log.lastError ── */
test('AUTHZ-2598-04 후속 — /diag 의 로그 라이터 실패 원문은 비-admin 에게 가린다', async () => {
  const csv = await import('../src/svcmon/csvlog.js');
  const { getLogSettings, setLogSettings } = await import('../src/svcmon/logsettings.js');
  setLogSettings({ enabled: true, mode: 'all' });
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  // 로그 라이터 오류를 실제로 만든다 — 로그 디렉터리 자리에 **파일**을 두면 mkdir 이 실패하고 원문(경로 포함)이 lastError 에 남는다.
  const cfgL = getLogSettings();
  const dir = cfgL.dirPath || path.join(CFG, cfgL.dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'x');
  try {
    csv.appendResult({ ts: 1_700_000_000_000, target: { id: 't', name: 'n', host: 'h' }, test: { id: 'x', type: 'ping' }, result: { status: 'ok' }, changed: true });
    csv.closeCsvLog();
    assert.ok(csv.logStats().lastError, '실패 원문이 생겼다(전제)');
    const o = await call('/api/svcmon', svcmonRouter, OPERATOR, 'GET', '/diag');
    assert.equal(o.status, 200);
    assert.equal(o.body.log.lastError, '(관리자만 확인)');
    assert.equal(o.body.poller.log.lastError, '(관리자만 확인)', 'poller 안의 같은 필드도');
    { const j = JSON.stringify(o.body); const i = j.indexOf(CFG); assert.ok(i < 0, '경로가 응답에 없다: ' + j.slice(Math.max(0, i - 200), i + 80)); }
    const a = await call('/api/svcmon', svcmonRouter, ADMIN, 'GET', '/diag');
    assert.equal(a.body.log.lastError, csv.logStats().lastError, 'admin 은 원문');
  } finally { fs.rmSync(dir, { force: true }); }
});

/* ── 후속 ③ activityLog 파일 경로를 싣는 라우트 전수 ── */
test('AUTHZ-2598-04 후속 — 라우트가 작업 로그 파일 경로(*LogInfo()·.FILE)를 실으면 scopeFilePaths 를 거친다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const root = path.resolve(import.meta.dirname, '../src/routes');
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p); } return out; };
  const bad = [];
  let seen = 0;
  for (const f of walk(root)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\b\w+LogInfo\(\)|\bFILE\b/g)) {
      seen++;
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (/^\s*import\b/.test(line)) continue;
      if (!/scopeFilePaths\(/.test(line)) bad.push(`${path.relative(root, f)}: ${line.trim()}`);
    }
  }
  assert.ok(seen > 0, '스윕이 대상(bmUsageLogInfo)을 한 번은 봐야 한다');
  assert.deepEqual(bad, [], `경로를 가리지 않고 싣는 곳:\n${bad.join('\n')}`);
});
