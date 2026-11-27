/**
 * secResidual1127EdgeRelay.test.js — 보안 잔여 11-27 G8(2026-11-08 감사 L2 · L5).
 *
 *  L2 옛 방식 엣지 목록(env UPGRADE_EDGES · upgrade.json edges)의 평문 HTTP — 이 목록의 엣지에는 엣지 관리자 토큰(Bearer)과 번들이 실린다.
 *     판정은 수집 서버 등록부(S-09)와 같은 evaluateCollectorUrl(승계 없음 · 허용 목록 COLLECTOR_HTTP_ALLOW 만) 하나 — upgrade/legacyEdgePolicy.js.
 *     세 경로가 탄다: 동기화(edgeSync.legacyEdgesOf · EdgeSyncRunner) · 적용 직후 push(manager.pushToEdges — 예전에는 판정 0개) · 싱크(upgrade.pushBundleToEdge).
 *  L5 중계 haproxy.cfg 적용(relaytopo/ops.js applySite)의 예측 가능한 '/tmp/haproxy.cfg.portal-<시각>' → remoteTmpDir(0700 mktemp · 소유자 · 심링크 확인)
 *     안에만 · 실패 시 고정 경로 폴백 없음 · 모든 출구에서 세션 안 정리(sudo 없이) · 정리 실패는 advisory(tmpLeft).
 *     같은 줄 정정: withSsh 의 ok:true 가 단계 판정을 덮어 실패한 적용도 ok=true 였다.
 *
 * 가짜 SSH(_setSshForTest)는 실제 withSsh 처럼 fn 이 끝나면 연결을 닫고(그 뒤 exec 는 던진다) 시한(signal)과 Promise.race 를 한다 —
 *   '정리를 세션 밖으로 옮기는' 변이를 잡기 위해서(반증 S-3).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 정리 실패는 결과가 아니다 */ } } });

// src 를 부르기 전에 — 설정에 쓰는 시험은 CONFIG_DIR 을 임시 폴더로(정적 import 는 호이스팅 — 아래는 모두 동적 import).
const CFG = tmpDir('secres1127g8-');
process.env.CONFIG_DIR = CFG;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
for (const k of ['DATA_SOURCE', 'COLLECTOR_HTTP_ALLOW', 'UPGRADE_EDGES', 'UPGRADE_PUSH_CONCURRENCY', 'UPGRADE_WATCH_DIR', 'UPGRADE_EDGE_AUTO']) delete process.env[k];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const sync = await import('../src/upgrade/edgeSync.js');
const policy = await import('../src/upgrade/legacyEdgePolicy.js');
const up = await import('../src/upgrade/upgrade.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');
const ops = await import('../src/relaytopo/ops.js');
const store = await import('../src/relaytopo/store.js');
const { stripComments } = await import('./_stripComments.js');

const quiet = { log() {}, warn() {} };
const ARCHIVE = path.join(CFG, 'vmware-portal-9.9.9.tar.gz');
fs.writeFileSync(ARCHIVE, 'bundle-bytes');

/** 전역 fetch 스파이 — 호출을 기록하고 { ok:true } 로 답한다. 반드시 restore(). */
function spyFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers?.Authorization || null });
    return new Response(JSON.stringify({ ok: true, version: '9.9.9' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
/** process.env 의 키 몇 개를 잠시 바꾼다(finally 에서 되돌린다 — 다른 시험을 오염하지 않게). */
async function withEnv(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/* ───────────────────────────── L2 ───────────────────────────── */

test('L2-1 평문 원격 http 옛 방식 엣지는 뺀다 — code insecure-http · 한국어 사유 · 토큰 미포함', () => {
  const r = sync.legacyEdgesOf({ edges: [{ url: 'http://10.1.2.3:4000', token: 'ADM' }] }, { env: {} });
  assert.equal(r.edges.length, 0, '관리자 토큰을 평문으로 실을 행을 만들지 않는다');
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].url, 'http://10.1.2.3:4000');
  assert.equal(r.dropped[0].code, 'insecure-http');
  assert.match(r.dropped[0].reason, /평문 HTTP/); assert.match(r.dropped[0].reason, /COLLECTOR_HTTP_ALLOW/);
  assert.match(r.dropped[0].reason, /수집 서버 등록도 함께 허용/, '허용 목록이 수집 서버 평문 등록에도 쓰인다는 사실(반증 S-6)');
  assert.ok(!JSON.stringify(r).includes('ADM'));
  // 판정 함수 자체 — 승계(existing) 없음 · 관리자 예외 없음
  assert.equal(policy.legacyEdgeTransportIssue('http://10.1.2.3:4000', {}).code, 'insecure-http');
  assert.equal(policy.legacyEdgeTransportIssue('https://10.1.2.3:4000', {}), null);
});

test('L2-2 허용 목록(COLLECTOR_HTTP_ALLOW) — CIDR · * · 호스트 이름은 받고, 맞지 않으면 뺀다', () => {
  const plain = { edges: [{ url: 'http://10.1.2.3:4000', token: 'T' }] };
  assert.equal(sync.legacyEdgesOf(plain, { env: { COLLECTOR_HTTP_ALLOW: '10.1.2.0/24' } }).edges.length, 1);
  assert.equal(sync.legacyEdgesOf(plain, { env: { COLLECTOR_HTTP_ALLOW: '*' } }).edges.length, 1);
  const named = sync.legacyEdgesOf({ edges: [{ url: 'http://edge-a.corp:4000', token: 'T' }] }, { env: { COLLECTOR_HTTP_ALLOW: 'edge-a.corp' } });
  assert.equal(named.edges.length, 1, JSON.stringify(named.dropped));
  const miss = sync.legacyEdgesOf(plain, { env: { COLLECTOR_HTTP_ALLOW: '10.9.0.0/16' } });
  assert.equal(miss.edges.length, 0); assert.equal(miss.dropped[0].code, 'insecure-http');
});

test('L2-3 기존 계약 — https · 루프백 http 는 받고 · ftp 는 형식 사유 · 차단 대역은 SSRF 사유가 먼저', () => {
  const r = sync.legacyEdgesOf({ edges: [{ url: 'https://edge.example:4000' }, { url: 'http://127.0.0.1:4100' }, { url: 'ftp://nope' }, { url: 'http://169.254.169.254/' }] }, { env: {} });
  assert.deepEqual(r.edges.map((e) => e.name), ['https://edge.example:4000', 'http://127.0.0.1:4100']);
  assert.equal(r.dropped.length, 2);
  assert.match(r.dropped[0].reason, /http\(s\) URL 이 아닙니다/); assert.equal(r.dropped[0].code, undefined);
  assert.equal(r.dropped[1].code, undefined, '차단 대역은 평문 판정보다 SSRF 사유로 말한다');
  assert.doesNotMatch(r.dropped[1].reason, /평문 HTTP/);
});

test('L2-4 뺀 목록은 origin 만(계정 · 경로 · 쿼리 없음) · 같은 origin 은 한 번 · 형식 오류도 계정을 가린다 · 중복은 따로', () => {
  const r = sync.legacyEdgesOf({ edges: [
    { url: 'http://u:pw-secret@10.1.2.3:4000/x?t=tok-secret' }, { url: 'http://10.1.2.3:4000/y' },
    { url: 'ftp://u:ftp-secret@host.example/' },
    { url: 'https://edge.example/a', token: 'A' }, { url: 'https://edge.example/b', token: 'B' },
  ] }, { env: {} });
  const insecure = r.dropped.filter((d) => d.code === 'insecure-http');
  assert.equal(insecure.length, 1);
  assert.equal(insecure[0].url, 'http://10.1.2.3:4000');
  const all = JSON.stringify(r.dropped);
  assert.ok(!all.includes('pw-secret') && !all.includes('tok-secret') && !all.includes('ftp-secret'), all);
  assert.equal(r.edges.length, 1); assert.equal(r.edges[0].token, 'A');
  assert.deepEqual(r.duplicates, ['https://edge.example']);
});

const PLAIN = { url: 'http://10.9.9.9:4000', token: 'ADM-SECRET' };
const ALLOWED = { url: 'http://10.1.2.3:4000', token: 'ALLOWED-TOK' };
function runnerOf(settings, { env = {}, probe = [], push = [], log = quiet } = {}) {
  return new sync.EdgeSyncRunner({
    settings: () => settings, env, log, collectors: () => [], statusOf: () => null, currentVersion: () => '9.9.9', intervalMs: 600_000,
    probeFn: async (e) => { probe.push(e); return { at: Date.now(), ok: true, version: '0.0.1' }; },
    pushEdgeFn: async (edge, file) => { push.push({ edge, file }); return { edge: edge.url, ok: true, status: 200 }; },
    pushFn: async () => [],
    resolveBundle: async () => ({ bytes: Buffer.from('b'), path: ARCHIVE, source: 'package' }),
    notifyFn: async () => [],
  });
}

test("L2-5 동기화 — 평문 엣지만 있으면 질의 · push 0 · 'no-edges' 에 사유(초록으로 끝내지 않는다 — 반증 M-1) · 상태에 뺀 엣지", async () => {
  const probe = []; const push = [];
  const r = runnerOf({ enabled: true, edgeAutoUpgrade: true, edges: [PLAIN] }, { probe, push });
  const run = await r.run();
  assert.equal(run.outcome, 'no-edges');
  assert.match(run.reason, /옛 방식 엣지 1곳은 보내지 않았습니다\(평문 HTTP 1곳\)/);
  assert.equal(probe.length, 0); assert.equal(push.length, 0);
  const st = r.status();
  assert.equal(st.legacyDropped.length, 1); assert.equal(st.legacyDropped[0].code, 'insecure-http');
  assert.ok(!JSON.stringify(st).includes('ADM-SECRET'));
});

test('L2-6 동기화 — 평문 + 허용 목록 엣지가 섞이면 허용 목록 것만 질의 · push(그 토큰만)', async () => {
  const probe = []; const push = [];
  const r = runnerOf({ enabled: true, edgeAutoUpgrade: true, edges: [PLAIN, ALLOWED] }, { env: { COLLECTOR_HTTP_ALLOW: '10.1.2.3' }, probe, push });
  const run = await r.run();
  assert.equal(run.outcome, 'pushed', JSON.stringify(run));
  assert.deepEqual(probe.map((e) => e.url), ['http://10.1.2.3:4000']);
  assert.deepEqual(push.map((p) => p.edge), [{ url: 'http://10.1.2.3:4000', token: 'ALLOWED-TOK' }]);
  assert.match(run.reason, /평문 HTTP 1곳/, '밀어 넣은 결과에도 뺀 사실을 싣는다');
});

test('L2-7 기능이 꺼져 있어도 상태에 뺀 엣지가 실린다(수동 적용도 push 한다)', () => {
  const r = runnerOf({ enabled: false, edgeAutoUpgrade: true, edges: [PLAIN] });
  const st = r.status();
  assert.equal(st.enabled, false);
  assert.equal(st.legacyDropped.length, 1); assert.equal(st.legacyDropped[0].code, 'insecure-http');
});

test('L2-8 평문 경고는 집합이 바뀔 때만 한 줄 · 토큰 없음', async () => {
  const warns = [];
  const s = { enabled: true, edgeAutoUpgrade: true, edges: [PLAIN] };
  const r = runnerOf(s, { log: { log() {}, warn: (m) => warns.push(m) } });
  await r.run(); r.status(); r.status(); await r.run(); r.status();
  const plainWarns = () => warns.filter((m) => /평문 HTTP/.test(m));
  assert.equal(plainWarns().length, 1, warns.join('\n'));
  assert.match(plainWarns()[0], /http:\/\/10\.9\.9\.9:4000/);
  assert.ok(!warns.join('\n').includes('ADM-SECRET'));
  s.edges = [PLAIN, { url: 'http://10.8.8.8:4000', token: 'X' }]; r.status(); r.status();
  assert.equal(plainWarns().length, 2, '집합이 바뀌면 다시 한 번');
  s.edges = []; r.status(); s.edges = [PLAIN]; r.status();
  assert.equal(plainWarns().length, 3, '비었다가 다시 생기면 또 알린다');
});

test('L2-9 적용 직후 push(manager.pushToEdges) — 평문 엣지에 fetch 0회 · 결과는 origin · 보내지 않음 사유', async () => {
  const f = spyFetch();
  try {
    const m = new UpgradeManager();
    m.settings = { ...m.settings, edges: [{ url: 'http://10.9.9.9:4000/portal/', token: 'SECRET' }] };
    const res = await m.pushToEdges(ARCHIVE);
    assert.equal(f.calls.length, 0, JSON.stringify(f.calls));
    assert.equal(res.length, 1);
    assert.equal(res[0].edge, 'http://10.9.9.9:4000', '동기화와 같은 목록 판정(origin)을 탔다 — 싱크 가드가 아니라');
    assert.equal(res[0].ok, false); assert.equal(res[0].code, 'insecure-http');
    assert.match(res[0].reason, /^보내지 않음 — 평문 HTTP/);
  } finally { f.restore(); }
});

test('L2-10 pushToEdges 혼합 — 루프백 2 + 평문 1 + 같은 origin 중복 → push 2 · 결과 3', async () => {
  const f = spyFetch();
  try {
    const m = new UpgradeManager();
    m.settings = { ...m.settings, edges: [{ url: 'http://127.0.0.1:4101', token: 'L1' }, { url: 'http://10.9.9.9:4000', token: 'SECRET' }, { url: 'http://127.0.0.1:4102', token: 'L2' }, { url: 'http://127.0.0.1:4101/dup', token: 'L1b' }] };
    const res = await m.pushToEdges(ARCHIVE);
    assert.equal(f.calls.length, 2, JSON.stringify(f.calls));
    assert.deepEqual(f.calls.map((c) => c.auth).sort(), ['Bearer L1', 'Bearer L2']);
    assert.ok(!f.calls.some((c) => c.auth === 'Bearer SECRET'));
    assert.equal(res.length, 3);
    assert.equal(res.filter((x) => x.ok === false && x.code === 'insecure-http').length, 1);
  } finally { f.restore(); }
});

test('L2-10b pushToEdges — 번들이 없어도 뺀 엣지는 결과로 남는다(반증 N-7)', async () => {
  const f = spyFetch();
  try {
    const m = new UpgradeManager();
    m.settings = { ...m.settings, watchDir: '', edges: [{ url: 'http://10.9.9.9:4000', token: 'SECRET' }] };
    const res = await m.pushToEdges(null);
    assert.equal(f.calls.length, 0);
    assert.equal(res.length, 1); assert.equal(res[0].code, 'insecure-http'); assert.match(res[0].reason, /^보내지 않음 — /);
  } finally { f.restore(); }
});

test('L2-11 싱크 pushBundleToEdge — 평문 · 해석 불가 URL 은 번들 파일을 읽기 전에 거부(fetch 0)', async () => {
  const f = spyFetch();
  try {
    const missing = path.join(CFG, 'no-such-bundle.tar.gz');
    const a = await up.pushBundleToEdge({ url: 'http://10.9.9.9:4000', token: 'S' }, missing);
    assert.equal(a.ok, false); assert.equal(a.code, 'insecure-http');
    assert.doesNotMatch(String(a.reason), /ENOENT|no such file/i, '파일을 읽기 전에 거부');
    // 반증 S-1: 'http:' 는 그 자체로는 해석되지 않지만 조립한 'http:/api/upgrade/bundle' 은 http://api/… 로 평문 전송됐다
    const b = await up.pushBundleToEdge({ url: 'http:', token: 'S' }, missing);
    assert.equal(b.ok, false); assert.ok(b.code, JSON.stringify(b));
    const c = await up.pushBundleToEdge({ url: undefined, token: 'S' }, missing);
    assert.equal(c.ok, false); assert.equal(c.code, 'invalid-url');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('L2-12 허용 목록 http 엣지에는 싱크가 Bearer 로 보낸다(과잉 차단 아님 — 양성 대조)', async () => {
  const f = spyFetch();
  try {
    const r = await withEnv({ COLLECTOR_HTTP_ALLOW: '10.9.9.9' }, () => up.pushBundleToEdge({ url: 'http://10.9.9.9:4000', token: 'S' }, ARCHIVE));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].auth, 'Bearer S');
    assert.equal(f.calls[0].url, 'http://10.9.9.9:4000/api/upgrade/bundle?restart=true');
  } finally { f.restore(); }
});

/* ───────────────────────────── L5 ───────────────────────────── */

const D = '/tmp/haproxy-cfg.Ab3dE6gH9j';
store.saveTopology({ main: { privateIp: '10.20.30.1' }, sites: [
  { dc: 'T1', edge: { privateIp: '10.20.30.40', ssh: { username: 'root', password: 'pw' } }, irs: { privateIp: '10.20.30.41' } },
  { dc: 'T2', edge: { privateIp: '10.20.31.40', ssh: { username: 'portal', password: 'pw' } }, irs: { privateIp: '10.20.31.41' } },
] });
const TOPO = store.loadTopologyRaw();
const PORTS = TOPO.services.filter((s) => s.enabled !== false).map((s) => `0.0.0.0:${s.listenPort}`).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 기본 응답 — over 로 명령별 응답을 바꾼다(정규식 → 결과 · Error 면 던진다 · 함수면 부른다). */
function responder(over = []) {
  const base = [
    [/^haproxy -v/, { stdout: 'HAProxy version 2.4.22\n' }],
    [/__HAS__/, { stdout: '__HAS__\nglobal\n  daemon\n' }],
    [/^mktemp -d \/tmp\/haproxy-cfg\.XXXXXXXXXX$/, { stdout: `${D}\n` }],
    [/^test -d /, { stdout: 'ok\n' }],
    [/base64 -d/, { stdout: 'written\n' }],
    [/haproxy -c -f/, { stdout: 'Configuration file is valid\nrc=0' }],
    [/sh -c 'set -e/, { stdout: 'replaced\nrc=0' }],
    [/systemctl reload haproxy/, { stdout: 'active\n' }],
    [/sh -c 'cp -a/, { stdout: 'active\n' }],
    [/^ss -ltnH/, { stdout: PORTS }],
    [/^rm -rf -- /, { stdout: '' }],
  ];
  return async (cmd) => {
    for (const [re, out] of [...over, ...base]) {
      if (!re.test(cmd)) continue;
      const v = typeof out === 'function' ? await out(cmd) : out;
      if (v instanceof Error) throw v;
      return { stdout: '', stderr: '', code: 0, ...v };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}
/** 실제 withSsh 처럼 — fn 이 끝나면 연결을 닫고(그 뒤 exec 는 던진다) signal 과 Promise.race 를 한다. 결과는 { ok:true, log, ...result }. */
function fakeSsh(respond, cmds) {
  return async (creds, fn) => {
    let closed = false;
    const signal = creds?.signal;
    const exec = async (cmd) => {
      if (closed) throw new Error('연결이 닫혔습니다(가짜)');
      cmds.push(cmd);
      return respond(cmd);
    };
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      onAbort = () => { closed = true; reject(new Error('SSH 세션 취소(타임아웃)')); };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      const result = signal ? await Promise.race([fn({ exec }), aborted]) : await fn({ exec });
      return { ok: true, log: [], ...result };
    } finally { closed = true; if (onAbort) signal?.removeEventListener('abort', onAbort); }
  };
}
async function apply(dc, { over = [], ...opts } = {}) {
  const cmds = [];
  ops._setSshForTest(fakeSsh(responder(over), cmds));
  try { return { r: await ops.applySite(dc, opts), cmds }; }
  finally { ops._setSshForTest(null); }
}
const idx = (cmds, re) => cmds.findIndex((c) => re.test(c));
const has = (cmds, re) => cmds.some((c) => re.test(c));

test('L5-1 성공 적용(root) — mktemp 0700 디렉터리 · 소유 확인이 쓰기보다 먼저 · 그 안에만 쓰고 · 마지막에 세션 안에서 정리', async () => {
  const { r, cmds } = await apply('T1');
  assert.equal(r.ok, true, JSON.stringify(r.steps)); assert.equal(r.applied, true);
  assert.ok(!cmds.some((c) => c.includes('/tmp/haproxy.cfg.portal-')), '예측 가능한 고정 경로 없음');
  const iMk = idx(cmds, /^mktemp -d \/tmp\/haproxy-cfg\.XXXXXXXXXX$/); const iOwn = idx(cmds, /test ! -L .*test -O/); const iW = idx(cmds, /base64 -d/);
  assert.ok(iMk >= 0 && iOwn > iMk && iW > iOwn, cmds.join('\n'));
  const w = cmds[iW];
  assert.ok(w.startsWith('umask 077; set -C; '), w.slice(0, 60));
  assert.ok(w.includes(`> ${D}/haproxy.cfg && chmod 600 ${D}/haproxy.cfg`));
  assert.ok(has(cmds, new RegExp(`^haproxy -c -f ${D}/haproxy\\.cfg`)));
  assert.ok(cmds.some((c) => c.includes(`install -m 644 ${D}/haproxy.cfg /etc/haproxy/haproxy.cfg`)));
  assert.equal(cmds[cmds.length - 1], `rm -rf -- ${D}`, '마지막 명령이 정리');
  assert.equal(r.tmpLeft, undefined);
  assert.ok(!r.steps.some((s) => s.advisory));
  assert.equal(r.steps.find((s) => s.name === '임시 파일 기록').detail, `${D}/haproxy.cfg`);
  assert.equal(r.log, undefined, '명령 로그(base64 cfg)는 응답에 싣지 않는다');
});

test('L5-2 비-root 계정 — mktemp · 소유 확인 · 쓰기 · 정리에는 sudo 없음 · 검증 · 교체 · reload 는 sudo -n', async () => {
  const { r, cmds } = await apply('T2');
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  for (const re of [/mktemp -d/, /test -d /, /base64 -d/, /rm -rf -- /]) {
    const c = cmds[idx(cmds, re)];
    assert.ok(c && !c.includes('sudo'), `${re}: ${c}`);
  }
  assert.ok(has(cmds, new RegExp(`^sudo -n haproxy -c -f ${D}/haproxy\\.cfg`)));
  assert.ok(has(cmds, /^sudo -n sh -c 'set -e; .*install -m 644/));
});

test('L5-3 모의 실행 — 교체 없음 · 정리는 한다', async () => {
  const { r, cmds } = await apply('T1', { dryRun: true });
  assert.equal(r.dryRun, true); assert.equal(r.ok, true);
  assert.ok(!has(cmds, /install -m 644/));
  assert.equal(cmds[cmds.length - 1], `rm -rf -- ${D}`);
});

test('L5-4 검증 실패(rc=1) — 교체 없음 · 정리 · ok:false(예전에는 세션 ok:true 가 덮었다)', async () => {
  const { r, cmds } = await apply('T1', { over: [[/haproxy -c -f/, { stdout: '[ALERT] parsing error\nrc=1' }]] });
  assert.equal(r.applied, false); assert.equal(r.ok, false, '실패한 적용을 성공으로 보고하지 않는다');
  assert.ok(!has(cmds, /install -m 644/));
  assert.equal(cmds[cmds.length - 1], `rm -rf -- ${D}`);
});

for (const [id, label, over] of [
  ['L5-5', 'mktemp 실패', [[/^mktemp -d/, { stdout: '', stderr: 'mktemp: failed', code: 1 }]]],
  ['L5-6', 'mktemp 출력에 주입 시도', [[/^mktemp -d/, { stdout: `${D}; rm -rf /\n` }]]],
  ['L5-7', '소유자 · 심링크 확인 실패', [[/^test -d /, { stdout: '' }]]],
]) {
  test(`${id} ${label} — 적용 중단 · 고정 경로로 폴백하지 않는다 · 쓰기 · 검증 · 교체 0`, async () => {
    const { r, cmds } = await apply('T1', { over });
    assert.equal(r.ok, false); assert.equal(r.applied, false);
    const st = r.steps.find((s) => s.name === '임시 디렉터리 만들기');
    assert.ok(st && st.ok === false, JSON.stringify(r.steps));
    assert.match(st.detail, /고정 \/tmp 경로로 대신 쓰지 않습니다/);
    if (id === 'L5-5') assert.match(st.detail, /mktemp/);
    assert.ok(!has(cmds, /base64 -d/) && !has(cmds, /haproxy -c/) && !has(cmds, /install -m/), cmds.join('\n'));
    assert.ok(!cmds.some((c) => c.includes('/tmp/haproxy.cfg')), '고정 경로 0건');
    assert.ok(!cmds.some((c) => c.includes('; rm -rf /')), '원격 출력이 명령에 섞이지 않는다');
    assert.equal(r.tmpLeft, undefined);
  });
}

test('L5-8 reload 뒤 inactive — 롤백(cp -a 백업) 뒤 마지막에 정리 · isActiveOut 마지막 줄 비교 유지', async () => {
  const { r, cmds } = await apply('T1', { over: [[/systemctl reload haproxy/, { stdout: 'Job failed\ninactive\n' }]] });
  assert.equal(r.rolledBack, true); assert.equal(r.applied, false); assert.equal(r.ok, false);
  const iRb = idx(cmds, /sh -c 'cp -a \/etc\/haproxy\/haproxy\.cfg\.bak-/);
  assert.ok(iRb > 0, cmds.join('\n'));
  assert.equal(cmds[cmds.length - 1], `rm -rf -- ${D}`);
  assert.ok(iRb < cmds.length - 1);
});

test('L5-9 백업 실패(rc=91) — reload 없음 · 정리 · 교체 스크립트의 set -e · exit 91/92/93 유지', async () => {
  const { r, cmds } = await apply('T1', { over: [[/sh -c 'set -e/, { stdout: 'rc=91' }]] });
  assert.equal(r.applied, false); assert.equal(r.ok, false);
  assert.match(r.steps.find((s) => s.name === '백업·교체').detail, /원본을 건드리지 않고 중단/);
  assert.ok(!has(cmds, /systemctl reload/));
  const inst = cmds[idx(cmds, /sh -c 'set -e/)];
  for (const k of ['set -e;', '|| exit 91', '|| exit 92', '|| exit 93']) assert.ok(inst.includes(k), `${k}: ${inst}`);
  assert.ok(!inst.includes('rm -f'), '임시 파일 정리는 교체 스크립트가 아니라 세션 정리 한 곳');
  assert.equal(cmds[cmds.length - 1], `rm -rf -- ${D}`);
});

test('L5-10 검증 명령이 예외를 던져도 세션 안에서 정리한다', async () => {
  const { r, cmds } = await apply('T1', { over: [[/haproxy -c -f/, new Error('채널 오류')]] });
  assert.equal(r.ok, false); assert.match(r.reason, /채널 오류/);
  assert.equal(cmds[cmds.length - 1], `rm -rf -- ${D}`);
  assert.equal(r.tmpLeft, undefined);
});

test('L5-11 정리 실패 — 적용 결과는 그대로(ok) · tmpLeft · advisory 단계 하나', async () => {
  const { r } = await apply('T1', { over: [[/^rm -rf -- /, { stdout: '', stderr: 'Operation not permitted', code: 1 }]] });
  assert.equal(r.applied, true); assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.equal(r.tmpLeft.dir, D); assert.match(r.tmpLeft.reason, /Operation not permitted/);
  const adv = r.steps.filter((s) => s.advisory);
  assert.equal(adv.length, 1); assert.equal(adv[0].name, '임시 디렉터리 정리'); assert.equal(adv[0].ok, false);
  assert.match(adv[0].detail, /적용 결과와 별개/);
});

test('L5-12 관리 블록이 이미 같으면 임시 디렉터리를 만들지 않는다', async () => {
  const { renderManagedBlock, mergeManagedBlock } = await import('../src/relaytopo/haproxy.js');
  const site = TOPO.sites.find((s) => s.dc === 'T1');
  const same = mergeManagedBlock('global\n  daemon\n', renderManagedBlock(site, TOPO.services, TOPO.main).text);
  const { r, cmds } = await apply('T1', { over: [[/__HAS__/, { stdout: `__HAS__\n${same}` }]] });
  assert.equal(r.unchanged, true, JSON.stringify(r.steps));
  assert.ok(!has(cmds, /mktemp/)); assert.ok(!has(cmds, /rm -rf/));
});

test('L5-13 시한 초과 — 세션이 끊겨 정리를 확인하지 못한 디렉터리는 tmpLeft 로 보고(반증 S-2)', { timeout: 15_000 }, async () => {
  const { r } = await apply('T1', { timeoutMs: 1000, over: [[/haproxy -c -f/, async () => { await sleep(1600); return { stdout: 'Configuration file is valid\nrc=0' }; }]] });
  assert.equal(r.ok, false); assert.match(r.reason, /타임아웃/);
  assert.equal(r.tmpLeft?.dir, D, JSON.stringify(r));
  assert.match(r.tmpLeft.reason, /세션이 끊겨/);
  assert.ok(r.steps.some((s) => s.advisory && s.name === '임시 디렉터리 정리'));
  await sleep(800);   // 뒤늦게 끝나는 가짜 명령이 다음 시험과 겹치지 않게
});

test('L5-14 소스 스윕 — 고정 경로 0 · remoteTmpDir 사용 · agent/deploy.js 의 같은 코어', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'relaytopo/ops.js'), 'utf8'));
  assert.ok(!src.includes('/tmp/haproxy.cfg.portal'));
  assert.equal((src.match(/remoteTmpDir\(\(c\) => exec\(c, 15_000\), 'haproxy-cfg'\)/g) || []).length, 1);
  assert.ok(src.includes("from '../agent/deploy.js'"));
  assert.ok(!/rm -f \$\{tmp\}/.test(src), '개별 rm -f 대신 세션 정리 한 곳');
});
