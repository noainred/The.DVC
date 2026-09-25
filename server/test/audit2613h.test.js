// v2.613 감사 그룹 H — 테스트 구조·문서 생성기 회귀 고정.
//   TESTDOC2613-05 설정 pull 진입 함수 4종(curuser·partfault·storage·users)을 **인프로세스 목 중앙**에 실제로 부른다(v2.566 교훈) ·
//   CONTRACT2613-06 + RUNTIME2613-02 edgelog/spec.js 가 `index.js` 가 시작하는 모듈의 상태 export 를 빠뜨리지 않는다(async 포함) ·
//   TESTDOC2613-08 2줄 정규식 주석 제거기 사본 0(테스트-of-테스트 스윕) · TESTDOC2613-02 200ms 이하 절대 시간 단언 0 ·
//   TESTDOC2613-07 느린 테스트 2종이 실제 네트워크 시한을 기다리지 않는다 · TESTDOC2613-11 `scripts/arch-doc.mjs` 가
//   `server/src` 디렉터리 전부와 `docs/*.md` 전부를 찾고 `--check` 가 통과한다 · TESTDOC2613-13 `onIntervalsChange` 리스너가 주기 변경에 발화한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(HERE, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2613h-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
delete process.env.STORAGE_INTERVALS_LOCAL;
delete process.env.CURUSER_LOCAL;

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const readTest = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));

/* ── 목 중앙: 요청을 기록하고 경로별 응답을 준다 ─────────────────────────────── */
let central; let centralPort; let config;
const seen = [];
const ROUTES = {
  '/api/central/curuser-config': { settings: { enabled: false, intervalMs: 900_000, vcenters: {} } },
  '/api/central/partfault-config': { settings: { enabled: true } },
  '/api/central/storage-config': { devices: [], intervals: { pollMs: 7_200_000 }, collectNow: [] },
  '/api/central/users-config': { users: [] },
};
let forbid = false;
before(async () => {
  central = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, agent: u.searchParams.get('agent'), token: req.headers['x-central-token'] || '' });
    if (forbid) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'forbidden' })); return; }
    const body = ROUTES[u.pathname];
    if (!body) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'no route' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  centralPort = await listen(central);
  ({ config } = await import('../src/config.js'));
  config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
  config.agent.centralToken = 'ctok-2613h';
  config.agent.name = 'edge-2613h';
});
after(() => { try { central?.close(); } catch { /* */ } });

/* ── TESTDOC2613-05 ───────────────────────────────────────────────────────── */
test('TESTDOC2613-05: pullCurUserConfigNow — 목 중앙의 설정을 받아 적용하고 토큰·agent 를 싣는다', async () => {
  const { pullCurUserConfigNow } = await import('../src/agent/curUserConfigPull.js');
  const r = await pullCurUserConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.applied, true, '첫 적용은 applied:true 여야 한다(설정이 바뀌었다)');
  const req = seen.find((s) => s.path === '/api/central/curuser-config');
  assert.ok(req, '중앙에 요청이 닿지 않았다');
  assert.equal(req.agent, 'edge-2613h');
  assert.equal(req.token, 'ctok-2613h');
  const again = await pullCurUserConfigNow();
  assert.equal(again.ok, true); assert.equal(again.applied, false, '같은 설정이면 다시 적용하지 않는다');
});

test('TESTDOC2613-05: pullPartFaultConfigNow — 스위치를 받아 적용하고 결과에 enabled 를 밝힌다', async () => {
  const { pullPartFaultConfigNow } = await import('../src/agent/partFaultConfigPull.js');
  const r = await pullPartFaultConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.applied, true);
  assert.equal(r.enabled, true);
  const { partFaultEnabled } = await import('../src/partfault/settings.js');
  assert.equal(partFaultEnabled().enabled, true, '중앙이 켠 스위치가 로컬 판정에 반영돼야 한다(env 미설정)');
});

test('TESTDOC2613-05: pullStorageConfigNow — 장비 목록·주기를 받아 적용한다(주기는 리스너까지 흘러간다)', async () => {
  const { pullStorageConfigNow } = await import('../src/agent/storageConfigPull.js');
  const { runtimeIntervals } = await import('../src/storage/intervals.js');
  const r = await pullStorageConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 0);
  assert.equal(r.intervalsApplied, true, '중앙이 준 pollMs 가 적용돼야 한다');
  assert.equal(runtimeIntervals().pollMs, 7_200_000);
  assert.equal(r.intervals.pollMs, 7_200_000);
});

test('TESTDOC2613-05: pullUsersConfigNow — 배포 사용자 목록을 받아 적용한다', async () => {
  const { pullUsersConfigNow } = await import('../src/agent/usersConfigPull.js');
  const r = await pullUsersConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.applied, true);
  assert.deepEqual([r.created, r.updated, r.removed], [0, 0, 0]);
  const req = seen.find((s) => s.path === '/api/central/users-config');
  assert.equal(req?.token, 'ctok-2613h');
});

test('TESTDOC2613-05: 중앙이 403 이면 네 진입 함수 모두 던지지 않고 ok:false 로 돌아온다', async () => {
  forbid = true;
  try {
    const mods = [
      ['curUserConfigPull.js', 'pullCurUserConfigNow'], ['partFaultConfigPull.js', 'pullPartFaultConfigNow'],
      ['storageConfigPull.js', 'pullStorageConfigNow'], ['usersConfigPull.js', 'pullUsersConfigNow'],
    ];
    for (const [f, fn] of mods) {
      const m = await import(`../src/agent/${f}`);
      const r = await m[fn]();
      assert.equal(r.ok, false, `${fn} 이 403 을 성공으로 읽었다: ${JSON.stringify(r)}`);
      assert.match(String(r.error || r.reason || ''), /403/, `${fn} 이 사유에 상태코드를 남기지 않는다`);
    }
  } finally { forbid = false; }
});

/* ── TESTDOC2613-13 ───────────────────────────────────────────────────────── */
test('TESTDOC2613-13: onIntervalsChange 리스너는 주기가 바뀔 때 발화하고 해제하면 멈춘다', async () => {
  const { onIntervalsChange, applyCentralIntervals, runtimeIntervals } = await import('../src/storage/intervals.js');
  const fired = [];
  const off = onIntervalsChange((eff) => fired.push(eff.pushMs));
  const a = applyCentralIntervals({ pushMs: 180_000 });
  assert.equal(a.applied, true);
  assert.deepEqual(fired, [180_000], '값이 바뀌면 리스너가 실효 주기를 받는다');
  const same = applyCentralIntervals({ pushMs: 180_000 });
  assert.equal(same.applied, false); assert.equal(same.unchanged, true);
  assert.equal(fired.length, 1, '같은 값이면 발화하지 않는다(타이머를 헛되이 재무장하지 않게)');
  off();
  applyCentralIntervals({ pushMs: 240_000 });
  assert.equal(fired.length, 1, '해제한 리스너는 더 부르지 않는다');
  assert.equal(runtimeIntervals().pushMs, 240_000);
  // pull 경로로도 같은 리스너가 발화한다(pullStorageConfigNow → applyCentralIntervals)
  const seenPull = [];
  const off2 = onIntervalsChange((eff) => seenPull.push(eff.pollMs));
  ROUTES['/api/central/storage-config'] = { devices: [], intervals: { pollMs: 3_600_000 }, collectNow: [] };
  const { pullStorageConfigNow } = await import('../src/agent/storageConfigPull.js');
  const r = await pullStorageConfigNow();
  off2();
  assert.equal(r.intervalsApplied, true);
  assert.deepEqual(seenPull, [3_600_000]);
});

/* ── CONTRACT2613-06 + RUNTIME2613-02 ─────────────────────────────────────── */
test('CONTRACT2613-06 + RUNTIME2613-02: index.js 가 시작하는 모듈의 인자 없는 *Status export 는 전부 spec 에 있고, async 도 잡는다', async () => {
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const byMod = new Map(STATUS_SPEC.map((s) => [path.normalize(s.mod).replace(/^\.\.\//, ''), s]));
  // ① 새로 등재한 셋이 실재하는 함수이고 redactDeep 을 통과한다(collect.js 와 같은 경로)
  const { redactDeep } = await import('../src/edgelog/redact.js');
  for (const [mod, fn, key] of [['logs/poller.js', 'logStatus', 'collect.vcLogs'], ['capacity/sampler.js', 'capacitySamplerStatus', 'collect.capacity'], ['security/certMonitor.js', 'certStatus', 'collect.certs']]) {
    const sp = byMod.get(mod);
    assert.ok(sp, `${mod} 가 spec 에 없다`);
    assert.equal(sp.key, key); assert.equal(sp.fn, fn);
    const m = await import(path.join(SRC, mod));
    const v = await m[fn]();
    assert.equal(typeof v, 'object');
    redactDeep(v);
  }
  // ② 스윕: index.js 의 start* import 원천 모듈 × 인자 없는 *Status export ⊆ spec ∪ EXCLUDED(edgeSweep2574 와 같은 목록)
  const indexSrc = stripComments(read('index.js'));
  const started = new Set();
  for (const m of indexSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) if (/\bstart[A-Z]\w*/.test(m[1])) started.add(path.normalize(m[2]));
  assert.ok(started.has('logs/poller.js') && started.has('capacity/sampler.js') && started.has('security/certMonitor.js'));
  const sweep = stripComments(readTest('edgeSweep2574.test.js'));
  assert.match(sweep, /export \(\?:async \)\?function/, 'edgeSweep2574 의 정규식이 async 상태 함수를 못 본다');
  assert.match(sweep, /\\bstart\[A-Z\]\\w\*/, 'edgeSweep2574 가 index.js 의 start* import 원천을 대상으로 삼지 않는다');
  const excluded = new Set([...sweep.matchAll(/\['([\w/.]+\.js)', '/g)].map((m) => m[1]));
  assert.ok(excluded.size >= 8, `EXCLUDED 목록을 읽지 못했다(${excluded.size})`);
  const STATUS_RE = /export (?:async )?function (\w*[Ss]tatus\w*)\s*\(\s*\)/g;
  const missed = [];
  for (const rel of started) {
    if (byMod.has(rel) || excluded.has(rel)) continue;
    for (const st of stripComments(read(rel)).matchAll(STATUS_RE)) missed.push(`${rel}::${st[1]}`);
  }
  assert.deepEqual(missed, []);
});

/* ── TESTDOC2613-08 ───────────────────────────────────────────────────────── */
test('TESTDOC2613-08: 2줄 정규식 주석 제거기 사본이 server/test 에 없다(_stripComments.js 하나)', () => {
  // 블록 주석 정규식 리터럴을 문자열 조립으로 만든다 — 여기 그대로 적으면 이 파일 자신이 스윕에 걸린다.
  const needle = 'replace(/' + '\\/\\*[\\s\\S]*?\\*\\/' + '/g';
  const ALLOW = new Map([
    ['audit2575.test.js', 'CSS 파일(줄 주석 없음)에서 블록 주석만 지운다 — 2줄 판본이 아니고 CSS 에는 상태 기계가 맞지 않는다(url(http://…) 의 // 를 주석으로 읽는다)'],
  ]);
  const hits = [];
  for (const f of fs.readdirSync(HERE)) {
    if (!f.endsWith('.test.js') || ALLOW.has(f)) continue;
    const src = readTest(f);
    if (src.includes(needle)) hits.push(f);
  }
  assert.deepEqual(hits, [], `2줄 판본이 남아 있다(v2.574 규약 — test/_stripComments.js 를 쓸 것): ${hits.join(', ')}`);
  for (const f of ALLOW.keys()) assert.ok(fs.existsSync(path.join(HERE, f)), `허용 목록의 파일이 없다: ${f}`);
});

/* ── TESTDOC2613-02 ───────────────────────────────────────────────────────── */
test('TESTDOC2613-02: 200ms 이하 절대 시간 단언이 server/test 에 없다(비율 또는 회귀와 확실히 갈리는 상한만)', () => {
  // 다른 그룹이 편집하는 파일은 이번 회차에서 손대지 않았다 — 사유와 함께 허용한다.
  const ALLOW = new Set(['audit2590.test.js', 'audit2611c.test.js', 'arch2582.test.js', 'arch2579.test.js', 'audit2606g.test.js']);
  const RE = /assert\.ok\(\s*\(?\s*(?:performance\.now\(\)\s*-\s*\w+|Date\.now\(\)\s*-\s*\w+|Number\([^)]*hrtime[^)]*\)\s*\/\s*1e6|\b(?:ms|dt|el|elapsed|took)\b)\s*\)?\s*<\s*([0-9_]+)/;
  const hits = [];
  for (const f of fs.readdirSync(HERE)) {
    if (!f.endsWith('.test.js') || ALLOW.has(f)) continue;
    stripComments(readTest(f)).split('\n').forEach((ln, i) => {
      const m = RE.exec(ln);
      if (m && Number(m[1].replace(/_/g, '')) <= 200) hits.push(`${f}:${i + 1} (<${m[1]})`);
    });
  }
  assert.deepEqual(hits, [], `CPU 에 따라 깨지는 절대 상한(v2.603·v2.611 규약): ${hits.join(', ')}`);
});

/* ── TESTDOC2613-07 ───────────────────────────────────────────────────────── */
test('TESTDOC2613-07: 느린 테스트 2종이 실제 네트워크 시한을 기다리지 않는다', () => {
  const san = stripComments(readTest('sanSwitch.test.js'));
  const i = san.indexOf("test('폴러: 재진입 가드");
  assert.ok(i > 0, 'sanSwitch 재진입 가드 테스트를 찾지 못했다');
  const body = san.slice(i, san.indexOf('\n});', i));
  assert.match(body, /sanswitch-devices\.json/, '재진입 테스트가 등록부를 비우지 않는다 — 앞 테스트가 저장한 장비로 실제 SSH 를 시도해 시한(60초)을 기다린다');
  for (const f of ['securityH1RegisterCollector.test.js', 'securityAudit2026-09-13.test.js']) {
    const s = stripComments(readTest(f));
    assert.doesNotMatch(s, /10\.20\.30\.40/, `${f}: 자기등록 urlHint 가 응답 없는 사설 주소다 — 검증 ping 이 8초 시한을 기다린다`);
    assert.match(s, /SSRF_ALLOW_LOOPBACK/, `${f}: 루프백 목 엣지를 쓰려면 SSRF_ALLOW_LOOPBACK 이 필요하다`);
  }
});

/* ── TESTDOC2613-11 ───────────────────────────────────────────────────────── */
test('TESTDOC2613-11: arch-doc 생성기가 server/src 디렉터리 전부와 docs/*.md 전부를 찾고, 생성 절이 최신이다', async () => {
  const gen = await import(path.join(ROOT, 'scripts/arch-doc.mjs'));
  const rows = gen.moduleMap();
  const dirs = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(rows.map((r) => r.dir), dirs, '생성기가 찾은 디렉터리 집합이 실제와 다르다');
  for (const r of rows) {
    assert.ok(r.files > 0 && r.lines > 0, `${r.dir}: 파일·줄 수`);
    assert.ok(r.anchor && r.desc, `${r.dir}: 대표 파일·설명이 비어 있다(못 읽은 것을 조용히 넘기지 않는다)`);
  }
  const docs = gen.docList();
  const md = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => /\.md$/i.test(f)).sort();
  assert.deepEqual(docs.map((d) => d.file), md);
  for (const d of docs) assert.ok(d.title, `${d.file}: 제목을 읽지 못했다`);
  const r = spawnSync(process.execPath, ['scripts/arch-doc.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `문서가 낡았습니다. 'node scripts/arch-doc.mjs' 를 실행하세요.\n${r.stderr}`);
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /node scripts\/arch-doc\.mjs --check/, 'CI 가 arch-doc --check 를 돌리지 않는다');
});
