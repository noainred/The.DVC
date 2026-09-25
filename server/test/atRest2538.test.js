/**
 * atRest2538.test.js — 저장 파일·저장 데이터·외부 공격면 감사(v2.538) 회귀 고정.
 *
 * ── 고정하는 결함 ────────────────────────────────────────────────────────────
 * ① 인증 전 대용량 본문 파싱: `app.use('/api/central/x', express.json({limit:'16mb'}))` 가 토큰 검사보다
 *    먼저 돌아 무토큰 15MB 요청도 다 읽고 파싱했다(실측 ×6 동시 RSS +238MB). 이제 `bigJsonGate` 가
 *    유효 토큰/세션이 있을 때만 큰 파서를 태운다 — **실제 서버를 띄워** 무토큰 3MB → 413 을 본다.
 * ② 비밀을 담는 파일 4종(agent-assignments·guest-scans·upgrade·packages)이 봉인 대상 미등록·미배선.
 * ③ 백업 번들·엣지 설정 push 가 portal.env 의 AUTH_SECRET/SECRETS_KEY/토큰을 그대로 실었다.
 * ④ `X-Powered-By: Express` 노출.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const strip = stripComments;   // v2.613 TESTDOC2613-08

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'atrest2538-'));
process.env.CONFIG_DIR = CFG;

let ENV; let BK; let VAULT; let ASG; let GS; let UPG; let PKG; let GATE; let AC;
before(async () => {
  ENV = await import('../src/util/envRedact.js');
  VAULT = await import('../src/security/secretVault.js');
  BK = await import('../src/backup/service.js');
  ASG = await import('../src/central/assignments.js');
  GS = await import('../src/security/guestScanScheduler.js');
  UPG = await import('../src/upgrade/settings.js');
  PKG = await import('../src/upgrade/packageSettings.js');
  GATE = await import('../src/util/bigJsonGate.js');
  AC = await import('../src/central/agentConfig.js');
});

// ── ③ env 가림(순수) ─────────────────────────────────────────────────────────
test('★ .env 의 키·토큰·비밀번호 값만 가리고 나머지는 그대로', () => {
  const src = [
    '# 주석은 그대로', 'PORT=4000', 'AUTH_SECRET=abc123', 'export SECRETS_KEY = k-9', 'CENTRAL_TOKEN=t1',
    'EDGE_TOKEN=', 'DB_PASSWORD=pw', 'SMTP_PASSWD=x', 'PRIVATE_KEY=---', 'TOKEN_TTL=30', 'DATA_SOURCE=live', '',
  ].join('\n');
  const r = ENV.redactEnvSecrets(src);
  assert.equal(r.redacted, 6, JSON.stringify(r.keys));
  assert.deepEqual(r.keys, ['AUTH_SECRET', 'SECRETS_KEY', 'CENTRAL_TOKEN', 'DB_PASSWORD', 'SMTP_PASSWD', 'PRIVATE_KEY']);
  assert.ok(!r.text.includes('abc123') && !r.text.includes('k-9') && !r.text.includes('=t1'), '값이 남아 있다');
  assert.ok(r.text.includes('PORT=4000') && r.text.includes('DATA_SOURCE=live') && r.text.includes('TOKEN_TTL=30'), '비밀 아닌 키가 바뀌었다');
  assert.ok(r.text.includes('EDGE_TOKEN='), '빈 값 줄은 그대로');
  assert.ok(r.text.includes(`AUTH_SECRET=${ENV.REDACTED}`) && r.text.includes(`export SECRETS_KEY = ${ENV.REDACTED}`), '표식·접두(export)·공백 보존');
  // 멱등 — 이미 가린 텍스트를 다시 가려도 0
  assert.equal(ENV.redactEnvSecrets(r.text).redacted, 0);
});

test('★ 복원 병합 — 표식 줄은 현재 값으로 되살리고, 현재에 없으면 버린다(빈 값으로 덮어쓰지 않는다)', () => {
  const bundle = `PORT=4001\nAUTH_SECRET=${ENV.REDACTED}\nCENTRAL_TOKEN=${ENV.REDACTED}\nNEW_KEY=1`;
  const current = 'PORT=4000\nAUTH_SECRET=live-secret\n';
  const m = ENV.mergeRedactedEnv(bundle, current);
  assert.equal(m.restored, 1); assert.deepEqual(m.dropped, ['CENTRAL_TOKEN']);
  assert.ok(m.text.includes('AUTH_SECRET=live-secret'), '현재 값으로 되살아나야 한다');
  assert.ok(!m.text.includes('CENTRAL_TOKEN'), '현재에 없는 키는 빈 값으로 쓰지 않고 버린다');
  assert.ok(m.text.includes('PORT=4001') && m.text.includes('NEW_KEY=1'), '번들의 비밀 아닌 값은 번들이 이긴다');
});

// ── ③ 번들 왕복(실제 파일) ───────────────────────────────────────────────────
test('★ 백업 번들에 portal.env 의 AUTH_SECRET 이 들어가지 않고, 복원 뒤에도 현재 키가 유지된다', () => {
  fs.writeFileSync(path.join(CFG, 'portal.env'), 'PORT=4000\nAUTH_SECRET=very-secret-value\nCENTRAL_TOKEN=tok-abc\nDATA_SOURCE=mock\n');
  fs.writeFileSync(path.join(CFG, 'ui.json'), '{"theme":"dark"}');
  const r = BK.createBackup('manual');
  assert.equal(r.redacted, 2, JSON.stringify(r));
  const raw = fs.readFileSync(path.join(CFG, 'backups', r.name));
  const text = zlib.gunzipSync(raw).toString('utf8');
  assert.ok(!text.includes('very-secret-value') && !text.includes('tok-abc'), '번들 안에 키·토큰 값이 남아 있다');
  assert.ok(text.includes('"theme":"dark"') || text.includes('theme'), 'JSON 설정은 그대로');
  const a = BK.readBackup(r.name);
  assert.deepEqual(a.central.redacted, { 'portal.env': ['AUTH_SECRET', 'CENTRAL_TOKEN'] }, '무엇을 가렸는지 번들이 말한다');
  assert.ok(!(BK.REDACTED_META in a.central.files), '메타 키가 파일 목록에 섞이면 안 된다');
  // 복원: 현재 portal.env 의 키가 그대로 남아야 한다
  const rr = BK.restoreCentral(a);
  assert.equal(rr.envKeysRestored, 2, JSON.stringify(rr));
  const after = fs.readFileSync(path.join(CFG, 'portal.env'), 'utf8');
  assert.ok(after.includes('AUTH_SECRET=very-secret-value') && after.includes('CENTRAL_TOKEN=tok-abc'), `복원이 키를 지웠다:\n${after}`);
  assert.ok(!after.includes(ENV.REDACTED), '표식이 파일에 남으면 안 된다');
});

test('★ 구버전 엣지가 보낸 .env 도 중앙 저장 전에 가린다(수신 측 심층 방어)', () => {
  AC.setAgentConfig('edge-old', { 'portal.env': 'EDGE_TOKEN=leak-me\nPORT=4000', 'x.json': '{}' });
  const got = AC.getAllAgentConfigs()['edge-old'].files;
  assert.ok(!got['portal.env'].includes('leak-me'), '엣지 토큰이 중앙에 저장됐다');
  assert.ok(got['portal.env'].includes('PORT=4000') && got['x.json'] === '{}');
});

// ── ② 봉인 배선 ──────────────────────────────────────────────────────────────
test('★ 비밀 파일 4종이 봉인 대상에 등록돼 있고, 암호화 모드에서 실제로 봉인된다(로드는 평문)', () => {
  for (const f of ['agent-assignments.json', 'guest-scans.json', 'upgrade.json', 'packages.json']) {
    assert.ok(VAULT.SECRET_FILES.includes(f), `${f} 가 SECRET_FILES 에 없다`);
  }
  VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  const rawOf = (n) => JSON.parse(fs.readFileSync(path.join(CFG, n), 'utf8'));

  const a = ASG.addAssignment({ agent: 'e1', ips: '10.0.0.1', username: 'root', password: 'idrac-pw' });
  assert.equal(a.ok, true, a.reason);
  assert.ok(VAULT.isSealed(rawOf('agent-assignments.json').assignments[0].password), 'assignments: 디스크가 평문');
  assert.equal(ASG.getAssignment('e1').password, 'idrac-pw', 'assignments: 로드가 복호되지 않는다');

  GS.saveGuestScan({ name: 't', vcenterId: 'vc1', guestUser: 'u', guestPass: 'guest-pw' });
  assert.ok(VAULT.isSealed(rawOf('guest-scans.json')[0].guestPass), 'guest-scans: 디스크가 평문');
  assert.ok(!JSON.stringify(GS.listGuestScans()).includes('guest-pw'), '목록 응답에 비밀번호가 나가면 안 된다');

  UPG.saveSettings({ token: 'upg-token' });
  assert.ok(VAULT.isSealed(rawOf('upgrade.json').token), 'upgrade: 디스크가 평문');
  assert.equal(UPG.loadSettings().token, 'upg-token', 'upgrade: 로드가 복호되지 않는다');

  PKG.savePackageSettings({ token: 'pkg-token' });
  assert.ok(VAULT.isSealed(rawOf('packages.json').token), 'packages: 디스크가 평문');
  assert.equal(PKG.getPackageToken(), 'pkg-token', 'packages: 로드가 복호되지 않는다');
  VAULT.saveSecretsPolicy({ mode: 'plain' });
});

// ── ① BIG_JSON 게이트(순수) ──────────────────────────────────────────────────
test('★ bigJsonGate 는 인증된 요청에만 큰 파서를 태우고 아니면 본문을 읽지 않고 next() 한다', () => {
  let parsed = 0;
  const parser = (_q, _s, next) => { parsed++; next(); };
  const gate = GATE.bigJsonGate(parser, { central: (r) => r.headers.ok === '1', session: (r) => r.headers.sess === '1' });
  const run = (baseUrl, headers) => { let nexted = false; gate({ baseUrl, path: '/', headers }, {}, () => { nexted = true; }); return nexted; };
  assert.equal(run('/api/central/inventory', {}), true); assert.equal(parsed, 0, '무토큰인데 파싱했다');
  assert.equal(run('/api/central/inventory', { ok: '1' }), true); assert.equal(parsed, 1);
  assert.equal(run('/api/svcmon/targets/import', {}), true); assert.equal(parsed, 1);
  assert.equal(run('/api/svcmon/targets/import', { sess: '1' }), true); assert.equal(parsed, 2);
  // 판정 함수가 던져도 '파싱 안 함' 으로 실패한다
  const g2 = GATE.bigJsonGate(parser, { central: () => { throw new Error('x'); } });
  g2({ baseUrl: '/api/central/inventory', path: '/', headers: {} }, {}, () => {}); assert.equal(parsed, 2);
});

test('소스 계약: index.js 가 게이트로 감싸고 X-Powered-By 를 끈다 · 마운트 줄은 그대로', () => {
  const idx = strip(read('index.js'));
  assert.match(idx, /const BIG_JSON = bigJsonGate\(express\.json\(/);
  assert.match(idx, /app\.disable\('x-powered-by'\)/);
  assert.match(idx, /app\.use\('\/api\/central\/inventory', BIG_JSON\)/); // v2.517·v2.520 테스트가 고정하는 줄 유지
  assert.match(strip(read('routes/central.js')), /export function resolveCentralAuth\(/);
});

// ── ①·④ 실제 서버 ───────────────────────────────────────────────────────────
test('★ 실제 서버: 무토큰 3MB → 413(파싱 전 차단) · 유효 토큰 3MB → 413 아님 · X-Powered-By 없음', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atrest2538-live-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(SRC, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', CENTRAL_TOKEN: 'live-token-2538', PORT: String(port) },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const t0 = Date.now();
    for (;;) { // 기동 대기(최대 40초)
      try { const r = await fetch(`${base}/dl/versions.json`); if (r.ok) break; } catch { /* 아직 */ }
      if (Date.now() - t0 > 40_000) throw new Error('서버 기동 시간 초과');
      await new Promise((r) => setTimeout(r, 300));
    }
    const big = JSON.stringify({ x: 'a'.repeat(3 * 1024 * 1024) });
    const noTok = await fetch(`${base}/api/central/inventory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    assert.equal(noTok.status, 413, '무토큰 대용량은 파싱 전에 413 으로 끊겨야 한다(예전엔 다 읽고 403)');
    const withTok = await fetch(`${base}/api/central/inventory`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Central-Token': 'live-token-2538' }, body: big });
    assert.notEqual(withTok.status, 413, `유효 토큰은 큰 본문을 받아야 한다(${withTok.status})`);
    assert.equal(withTok.headers.get('x-powered-by'), null, 'X-Powered-By 가 여전히 나간다');
    const small = await fetch(`${base}/api/central/inventory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(small.status, 403, '무토큰 소형 본문은 예전처럼 라우터가 403');
  } finally { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
});
