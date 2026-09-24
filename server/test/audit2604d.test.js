/**
 * audit2604d.test.js — v2.604 감사 그룹 d(비밀·가림·통신 점검) 회귀 고정.
 *
 * SEC2604-01 portal.env 의 `*_PASS`(PROXY_SSH_PASS·HAPROXY_DATAPLANE_PASS)가 백업 번들·엣지→중앙 설정 사본에 평문으로 남았다.
 * SEC2604-02 엣지 로그 줄 가림이 홑따옴표 다단어 값의 뒤 단어와 env 꼴 `SECRETS_KEY=`·`*_PASS=` 를 놓쳤다.
 * SEC2604-03 알림 채널 웹훅 URL(경로가 곧 비밀)이 SECRET_FIELDS 밖이라 암호화 모드에서도 평문으로 저장됐다.
 * CEN2604-02 통신 점검 stepHttp 가 본문 **전체**를 읽은 뒤 잘랐다(gzip 305KB → RSS +928MB).
 * TIM2604-05 stepDns 의 타임아웃 타이머가 조회 성공 뒤에도 해제되지 않았다.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604d-'));
process.env.CONFIG_DIR = CFG;

let ENV; let RED; let VAULT; let BK; let CHK;
before(async () => {
  ENV = await import('../src/util/envRedact.js');
  RED = await import('../src/edgelog/redact.js');
  VAULT = await import('../src/security/secretVault.js');
  BK = await import('../src/backup/service.js');
  CHK = await import('../src/linkcheck/checks.js');
});

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── SEC2604-01 ───────────────────────────────────────────────────────────────
test('SEC2604-01: 소스가 읽는 env 중 비밀번호 계열 이름(PASS·PW·PWD·CRED)은 전부 비밀로 판정된다', () => {
  const names = new Set();
  for (const f of walkJs(SRC)) for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  const pw = [...names].filter((n) => /(PASS|PASSWORD|PASSWD|PW|PWD|CRED|CREDENTIALS?)$/.test(n));
  assert.ok(pw.includes('PROXY_SSH_PASS') && pw.includes('HAPROXY_DATAPLANE_PASS'), `표본이 비었다: ${pw}`);
  for (const n of pw) assert.equal(ENV.isSecretEnvKey(n), true, `${n} 가 비밀로 판정되지 않는다`);
});

test('SEC2604-01: redactEnvSecrets 가 *_PASS 값을 가리고, 비밀 아닌 이름은 두며, 객체 키 오탐(pass·bypass)이 없다', () => {
  const r = ENV.redactEnvSecrets('PROXY_SSH_PASS=hunter2\nHAPROXY_DATAPLANE_PASS=dp-secret\nSMTP_PWD=x1\nVAULT_CREDENTIALS=c1\nPORT=4000\nTOKEN_TTL=30\nBYPASS=1');
  assert.deepEqual(r.keys, ['PROXY_SSH_PASS', 'HAPROXY_DATAPLANE_PASS', 'SMTP_PWD', 'VAULT_CREDENTIALS']);
  assert.ok(!r.text.includes('hunter2') && !r.text.includes('dp-secret'));
  assert.ok(r.text.includes('PORT=4000') && r.text.includes('TOKEN_TTL=30') && r.text.includes('BYPASS=1'));
  // edgelog 객체 가림은 isSecretEnvKey 를 쓴다 — 밑줄 없는 pass/bypass/compass 는 식별자이므로 가리지 않는다.
  for (const k of ['pass', 'bypass', 'compass', 'deviceKey', 'partKey', 'tokenFp']) assert.equal(RED.isSecretKey(k), false, k);
  const d = RED.redactDeep({ pass: true, results: [{ pass: false }], HAPROXY_DATAPLANE_PASS: 'z' });
  assert.equal(d.value.pass, true); assert.equal(d.value.results[0].pass, false); assert.equal(d.value.HAPROXY_DATAPLANE_PASS, RED.MASK);
});

test('SEC2604-01: 백업 번들(collectConfigDir)에 PROXY_SSH_PASS·HAPROXY_DATAPLANE_PASS 값이 들어가지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2604d-env-'));
  fs.writeFileSync(path.join(dir, 'portal.env'), 'PORT=4000\nPROXY_SSH_PASS=ssh-plain-pw\nHAPROXY_DATAPLANE_PASS=dp-plain-pw\n');
  const out = BK.collectConfigDir(dir);
  assert.ok(!out['portal.env'].includes('ssh-plain-pw') && !out['portal.env'].includes('dp-plain-pw'), out['portal.env']);
  assert.ok(out['portal.env'].includes('PORT=4000'));
});

// ── SEC2604-02 ───────────────────────────────────────────────────────────────
test('SEC2604-02: 로그 줄 가림 — 홑따옴표 다단어 값 전체 · env 꼴 *_PASS/*_KEY · 식별자 오탐 없음', () => {
  const r = RED.redactLogLine;
  assert.equal(r("PASSWORD: 'x y z' tail"), "PASSWORD: '[가림]' tail");
  assert.equal(r('PROXY_SSH_PASS=hunter2 next'), 'PROXY_SSH_PASS=[가림] next');
  assert.equal(r('export SECRETS_KEY=abc123'), 'export SECRETS_KEY=[가림]');
  assert.equal(r('HAPROXY_DATAPLANE_PASS="a b c" x'), 'HAPROXY_DATAPLANE_PASS="[가림]" x');
  assert.equal(r('deviceKey=SN123 partKey=p1 pass=true TOKEN_TTL=30'), 'deviceKey=SN123 partKey=p1 pass=true TOKEN_TTL=30');
  assert.equal(r('X_KEY=""'), 'X_KEY=""', '빈 값은 그대로(진단)');
  // 선형성 — 긴 대문자·밑줄 줄에서 멈추지 않는다
  const t0 = process.hrtime.bigint();
  r('A_'.repeat(30_000)); r(`PASSWORD: '${'x '.repeat(30_000)}`);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300, '가림이 느리다');
});

// ── SEC2604-03 ───────────────────────────────────────────────────────────────
test('SEC2604-03: 암호화 모드에서 웹훅 URL 은 봉인되어 저장되고, 메모리·재로드는 평문 · 평문 파일은 그대로 읽힌다', async () => {
  const FILE = path.join(CFG, 'alerts.json');
  // ① 구버전·평문 모드 파일 호환
  fs.writeFileSync(FILE, JSON.stringify({ channels: { slack: { enabled: true, url: 'https://hooks.slack.com/services/T/B/legacy' } } }));
  const A0 = await import(`../src/alerts.js?legacy=${Math.random()}`);
  assert.equal(A0.loadAlertConfig().channels.slack.url, 'https://hooks.slack.com/services/T/B/legacy');

  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  try {
    const A = await import(`../src/alerts.js?enc=${Math.random()}`);
    const slack = 'https://hooks.slack.com/services/T000/B000/SECRETSLACK';
    const teams = 'https://outlook.office.com/webhook/SECRETTEAMS';
    const cfg = A.saveAlertConfig({ channels: { slack: { enabled: true, url: slack }, webhook: { enabled: false, url: '' }, teams: { enabled: true, url: teams } } });
    assert.equal(cfg.channels.slack.url, slack, '메모리는 평문(화면·발송)');
    const raw = fs.readFileSync(FILE, 'utf8');
    assert.ok(!raw.includes('SECRETSLACK') && !raw.includes('SECRETTEAMS'), `파일에 URL 평문이 남았다: ${raw}`);
    const j = JSON.parse(raw);
    assert.ok(VAULT.isSealed(j.channels.slack.url) && VAULT.isSealed(j.channels.teams.url));
    assert.equal(j.channels.webhook.url, '', '빈 값은 봉인하지 않는다');
    // 같은 내용 재저장은 같은 암호문(백업 변경 감시가 헛돌지 않게 — v2.598 재사용)
    A.saveAlertConfig(cfg);
    assert.equal(fs.readFileSync(FILE, 'utf8'), raw, '무변경 재저장이 파일을 바꿨다');
    // 재로드(새 모듈 인스턴스) → 평문 복원
    const B = await import(`../src/alerts.js?reload=${Math.random()}`);
    assert.equal(B.loadAlertConfig().channels.slack.url, slack);
    assert.equal(B.alertStatus().config.channels.teams.url, teams);
  } finally {
    VAULT.saveSecretsPolicy({ mode: 'plain' });
  }
  // ② 모드 전환 마이그레이션이 alerts.json 도 다룬다(평문으로 되돌림)
  assert.ok(VAULT.SECRET_FILES.includes('alerts.json'));
  const m = VAULT.migrateSecretFiles({ mode: 'plain' });
  const row = m.files.find((f) => f.file === 'alerts.json');
  assert.ok(row && row.changed && row.secrets === 2, JSON.stringify(m));
  assert.ok(fs.readFileSync(FILE, 'utf8').includes('SECRETSLACK'));
  // ③ 평문 → 암호화 전환도 url 을 봉인한다
  const m2 = VAULT.migrateSecretFiles({ mode: 'encrypted', level: 1 });
  assert.ok(m2.files.find((f) => f.file === 'alerts.json')?.changed, JSON.stringify(m2));
  assert.ok(!fs.readFileSync(FILE, 'utf8').includes('SECRETSLACK'));
  VAULT.migrateSecretFiles({ mode: 'plain' });
});

test('SEC2604-03: url 은 alerts.json 에서만 봉인한다(다른 등록부의 접속 주소는 그대로)', () => {
  assert.equal(VAULT.SECRET_FIELDS.has('url'), false);
  const o = VAULT.sealSecretsDeep({ url: 'https://edge:4000', token: 't1' }, { mode: 'encrypted', level: 1, algorithm: '' });
  assert.equal(o.url, 'https://edge:4000');
  assert.ok(VAULT.isSealed(o.token));
});

// ── CEN2604-02 ───────────────────────────────────────────────────────────────
test('CEN2604-02: stepHttp 는 압축 폭탄 응답의 앞부분만 읽는다(bodyCapped)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20)); // 64MB 공백 → 약 64KB
  let aborted = false;
  const srv = http.createServer((req, res) => {
    res.on('close', () => { if (!res.writableFinished) aborted = true; });
    res.writeHead(200, { 'content-type': 'text/xml', 'content-encoding': 'gzip' });
    // 조각으로 흘려 보낸다 — 클라이언트가 전량을 받기 전에 끊는지 본다
    let i = 0; const CH = 4096;
    const pump = () => { while (i < bomb.length) { const ok = res.write(bomb.subarray(i, i + CH)); i += CH; if (!ok) { res.once('drain', pump); return; } } res.end(); };
    pump();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const out = await CHK.stepHttp({ url: `http://127.0.0.1:${port}/sdk/vimServiceVersions.xml`, ip: '127.0.0.1', timeoutMs: 15_000 });
    assert.equal(out.http?.ok, true, JSON.stringify(out));
    assert.equal(out.http.bodyCapped, true, '상한에서 끊었다는 표시가 없다');
    assert.ok(out.http.bytes <= 1600, `읽은 바이트 ${out.http.bytes}`);
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
  void aborted;
});

test('CEN2604-02: 스윕 — server/src 에서 본문 전체를 읽고 자르는 형태 금지(예외 0)', () => {
  const KNOWN = new Map(); // v2.604: 마지막 잔여(llm/ollama.js)도 readBodyPrefix 로 옮겼다 — 예외 0
  const bad = [];
  for (const f of walkJs(SRC)) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (/\.text\(\)[^;\n]{0,40}\)\.slice\(/.test(code) && !KNOWN.has(rel)) bad.push(rel);
  }
  assert.deepEqual(bad, []);
});

// ── TIM2604-05 ───────────────────────────────────────────────────────────────
test('TIM2604-05: stepDns 가 성공한 뒤 타임아웃 타이머를 남기지 않는다', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before0 = timers();
  const r = await CHK.stepDns('localhost', { timeoutMs: 20_000 });
  // localhost 는 루프백이라 차단 대역(dns-blocked)일 수 있다 — 어느 쪽이든 조회(dns.lookup)는 끝났다.
  assert.ok(r.ok || r.failKind === 'dns-blocked', JSON.stringify(r));
  assert.equal(timers(), before0, '타이머가 남았다');
});

test('CEN2604-02: Ollama 오류 본문도 앞부분만 읽는다(압축 폭탄 500 응답)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024, 0x41));
  const srv = http.createServer((_q, res) => { res.writeHead(500, { 'content-encoding': 'gzip' }); res.end(bomb); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.SSRF_ALLOW_LOOPBACK; process.env.SSRF_ALLOW_LOOPBACK = 'true';
  try {
    const { ollamaGenerate } = await import('../src/llm/ollama.js');
    await assert.rejects(ollamaGenerate({ url: `http://127.0.0.1:${srv.address().port}`, model: 'm', timeoutMs: 10_000 }, 'p'), (e) => {
      assert.match(e.message, /^Ollama HTTP 500: A+$/);
      assert.ok(e.message.length <= 'Ollama HTTP 500: '.length + 200, `길이 ${e.message.length}`);
      return true;
    });
  } finally {
    if (prev == null) delete process.env.SSRF_ALLOW_LOOPBACK; else process.env.SSRF_ALLOW_LOOPBACK = prev;
    srv.closeAllConnections?.(); await new Promise((r) => srv.close(r));
  }
});
