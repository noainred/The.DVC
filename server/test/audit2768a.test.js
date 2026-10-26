/**
 * v2.768(점검 R3 — G1 백업/복원) 회귀 테스트.
 *  C5-02 복원은 JSON 설정을 예약(backups/.restore-staged.json)하고 기동 시 다른 모듈보다 먼저 적용한다 — 예전에는 파일만 덮어
 *        인메모리 판본을 가진 모듈(엣지 토큰 touch 등)의 다음 저장이 재시작 전에 복원을 되돌렸다(재현: edge-b 토큰 재소실).
 *  C5-01 생성 직렬화가 해제 상한을 넘으면 엣지 사본을 빼고 경고 · 열 수 없는 백업은 404 '없음' 이 아니라 422 + 사유.
 * 기전 확인: 실제 central/agentTokens.js · config.js 를 자식 프로세스에서 index.js 와 같은 import 순서로 띄워 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2768a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const BACKUPS = path.join(DIR, 'backups');

const SR = await import('../src/backup/stagedRestore.js');
const BK = await import('../src/backup/service.js');
const TOK = await import('../src/central/agentTokens.js');
const AC = await import('../src/central/agentConfig.js');

after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const tokenAgents = (dir = DIR) => JSON.parse(fs.readFileSync(path.join(dir, 'central-agent-tokens.json'), 'utf8')).tokens.map((t) => t.agent).sort();

// ── C5-02 ───────────────────────────────────────────────────────────────────
test('C5-02 — 복원은 예약만 하고, 재시작 전 캐시 모듈의 저장이 파일을 되돌려도 기동 시 적용이 복원을 되살린다(실제 agentTokens)', async () => {
  const a = TOK.issueAgentToken('edge-a');
  const b = TOK.issueAgentToken('edge-b');
  const m = await BK.createBackup('manual');
  TOK.revokeAgentToken('edge-b');
  assert.deepEqual(tokenAgents(), ['edge-a']);
  const r = await BK.restoreCentral(BK.readBackup(m.name), { retention: 30, source: m.name });
  assert.equal(r.pendingRestart, true);
  assert.ok(r.staged.includes('central-agent-tokens.json'), JSON.stringify(r.staged));
  // 재시작 전: 파일은 아직 복원 전(바로 덮지 않는다) · edge-a 의 pull(touch 저장)이 일어나도 예약은 그대로 남는다
  assert.equal(TOK.resolveAgentByToken(a.token), 'edge-a');
  assert.deepEqual(tokenAgents(), ['edge-a']);
  assert.ok(fs.existsSync(path.join(BACKUPS, SR.STAGED_NAME)), '예약 파일이 있어야 한다');
  assert.equal(SR.stagedRestoreStatus({ configDir: DIR }).pending?.source, m.name);

  // 기동: index.js 와 같은 순서(logbuffer → stagedRestoreBoot → 캐시 모듈)로 자식 프로세스를 띄운다
  const entry = path.join(DIR, 'boot-entry.mjs');
  const u = (p) => pathToFileURL(path.join(SRC, p)).href;
  fs.writeFileSync(entry, [
    `import '${u('logbuffer.js')}';`,
    `import '${u('backup/stagedRestoreBoot.js')}';`,
    `import { resolveAgentByToken } from '${u('central/agentTokens.js')}';`,
    `import { stagedRestoreStatus } from '${u('backup/stagedRestore.js')}';`,
    `console.log('RESULT ' + JSON.stringify({ b: resolveAgentByToken(process.env.TOKB), last: stagedRestoreStatus().last }));`,
  ].join('\n'));
  const out = spawnSync(process.execPath, ['--experimental-sqlite', entry], { env: { ...process.env, CONFIG_DIR: DIR, TOKB: b.token }, encoding: 'utf8', timeout: 60_000 });
  const line = String(out.stdout).split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `자식 출력 없음: ${out.stdout}\n${out.stderr}`);
  const res = JSON.parse(line.slice(7));
  assert.equal(res.b, 'edge-b', '기동 시 적용 뒤 edge-b 토큰이 살아 있어야 한다');
  assert.equal(res.last.ok, true);
  assert.ok(res.last.applied.includes('central-agent-tokens.json'));
  assert.deepEqual(tokenAgents(), ['edge-a', 'edge-b']);
  assert.equal(fs.existsSync(path.join(BACKUPS, SR.STAGED_NAME)), false, '적용 뒤 예약 파일은 지운다(한 번만 적용)');
  assert.equal(fs.existsSync(path.join(BACKUPS, SR.APPLYING_NAME)), false);
  assert.match(String(out.stdout), /예약된 복원 적용/, '적용 결과를 로그에 남긴다');
});

test('C5-02 — 예약 적용은 config.js 보다 먼저 돈다(db-location.json 을 모듈 평가 때 읽는 실제 소비자)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2768a-cfg-'));
  try {
    const dbDir = path.join(d, 'db-restored');
    fs.mkdirSync(dbDir);
    SR.stageRestore({ 'db-location.json': JSON.stringify({ dbDir }) }, { configDir: d, source: 't' });
    const entry = path.join(d, 'e.mjs');
    const u = (p) => pathToFileURL(path.join(SRC, p)).href;
    fs.writeFileSync(entry, [
      `import '${u('logbuffer.js')}';`,
      `import '${u('backup/stagedRestoreBoot.js')}';`,
      `import { config } from '${u('config.js')}';`,
      `console.log('RESULT ' + JSON.stringify({ dbDir: config.dbDir, configDir: config.configDir }));`,
    ].join('\n'));
    const out = spawnSync(process.execPath, [entry], { env: { ...process.env, CONFIG_DIR: d }, encoding: 'utf8', timeout: 60_000 });
    const line = String(out.stdout).split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, `자식 출력 없음: ${out.stdout}\n${out.stderr}`);
    const res = JSON.parse(line.slice(7));
    assert.equal(res.configDir, d);
    assert.equal(res.dbDir, dbDir, `config.js 가 예약 적용 전에 평가됐다: ${line}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('C5-02 — index.js: logbuffer 다음 두 번째 import 가 예약 적용 · 적용 모듈의 import 는 무의존 leaf 뿐', async () => {
  const lines = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8').split('\n');
  assert.match(lines[0], /^import '\.\/logbuffer\.js';/);
  assert.match(lines[1], /^import '\.\/backup\/stagedRestoreBoot\.js';/);
  const importsOf = (rel) => [...fs.readFileSync(path.join(SRC, rel), 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map((x) => x[1] || x[2]);
  assert.deepEqual(importsOf('backup/stagedRestoreBoot.js'), ['./stagedRestore.js']);
  assert.deepEqual(importsOf('backup/stagedRestore.js').filter((s) => !s.startsWith('node:')), ['../util/atomicWrite.js']);
  assert.deepEqual(importsOf('util/atomicWrite.js').filter((s) => !s.startsWith('node:')), []);
  assert.deepEqual(importsOf('logbuffer.js'), ['./util/capStr.js']);
  assert.deepEqual(importsOf('util/capStr.js').filter((s) => !s.startsWith('node:')), []);
  // CONFIG_DIR 판정은 config.js 와 같다
  const { config } = await import('../src/config.js');
  assert.equal(SR.resolveConfigDir(), config.configDir);
});

test('C5-02 — session-state.json 은 복원하지 않고(사유를 결과에) · 적용은 이름을 다시 검사한다(경로 탈출·확장자·데이터 파일)', async () => {
  fs.writeFileSync(path.join(DIR, 'session-state.json'), '{"v":1,"notBefore":999}');
  const r = await BK.restoreCentral({ central: { files: { 'session-state.json': '{"v":1,"notBefore":0}', 'ui2.json': '{"x":1}' } }, edges: {} }, { retention: 30 });
  assert.ok(r.excluded.some((e) => e.file === 'session-state.json' && /폐기/.test(e.reason)), JSON.stringify(r.excluded));
  assert.deepEqual(r.staged, ['ui2.json']);
  // 디스크의 예약 파일을 조작해도 적용이 다시 거른다
  const esc = `audit2768a-escape-${path.basename(DIR)}.json`;   // 고유 이름 — 다른 실행의 잔재와 섞이지 않게
  fs.writeFileSync(path.join(BACKUPS, SR.STAGED_NAME), JSON.stringify({ v: 1, stagedAt: 1, source: 'x', files: {
    [`../${esc}`]: '{}', 'sub/a.json': '{}', 'sub\\b.json': '{}', 'x.txt': 'a', 'portal.env': 'A=1', 'settings-owners.txt': 'evil',
    'central-inventory.json': '{}', 'session-state.json': '{}', 'ok.json': '{"ok":true}', 'num.json': 5,
  } }));
  const ap = SR.applyStagedRestore({ configDir: DIR });
  assert.deepEqual(ap.applied, ['ok.json']);
  assert.equal(ap.rejected.length, 9, JSON.stringify(ap.rejected));
  assert.equal(ap.ok, false);
  assert.equal(fs.existsSync(path.join(path.dirname(DIR), esc)), false);
  assert.equal(fs.readFileSync(path.join(DIR, 'session-state.json'), 'utf8'), '{"v":1,"notBefore":999}');
  assert.equal(fs.existsSync(path.join(DIR, 'settings-owners.txt')), false);
  assert.equal(SR.applyStagedRestore({ configDir: DIR }), null, '두 번째 기동에는 적용할 것이 없다');
});

test('C5-02 — 중단 흔적이 있으면 다시 적용하지 않고 · 손상 예약은 원문 없이 옆으로 치운다 · 취소', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2768a-int-'));
  try {
    const bdir = path.join(d, 'backups'); fs.mkdirSync(bdir);
    fs.writeFileSync(path.join(bdir, SR.APPLYING_NAME), '{}');
    SR.stageRestore({ 'a.json': '{"a":1}' }, { configDir: d });
    const r1 = SR.applyStagedRestore({ configDir: d });
    assert.equal(r1.ok, false); assert.equal(r1.reason, 'interrupted');
    assert.equal(fs.existsSync(path.join(d, 'a.json')), false);
    assert.equal(SR.stagedRestoreStatus({ configDir: d }).interrupted, true);
    fs.unlinkSync(path.join(bdir, SR.APPLYING_NAME));
    // 손상 — JSON.parse 조각(설정 내용)을 사유·로그에 싣지 않는다
    fs.writeFileSync(path.join(bdir, SR.STAGED_NAME), '{"v":1,"files":{"a.json":"SuperSecret123!');
    const errs = []; const ce = console.error; console.error = (m) => errs.push(String(m));
    let r2; try { r2 = SR.applyStagedRestore({ configDir: d }); } finally { console.error = ce; }
    assert.equal(r2.ok, false);
    assert.ok(!JSON.stringify(r2).includes('SuperSecret') && !errs.join('').includes('SuperSecret'));
    assert.ok(fs.readdirSync(bdir).some((n) => n.startsWith(`${SR.STAGED_NAME}.bad-`)));
    assert.equal(fs.existsSync(path.join(bdir, SR.STAGED_NAME)), false);
    // 취소
    SR.stageRestore({ 'b.json': '{}' }, { configDir: d });
    assert.equal(SR.cancelStagedRestore({ configDir: d }).had, true);
    assert.equal(SR.stagedRestoreStatus({ configDir: d }).pending, null);
    assert.equal(SR.applyStagedRestore({ configDir: d }), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── C5-01 ───────────────────────────────────────────────────────────────────
test('C5-01 — 직렬화가 해제 상한을 넘으면 엣지 사본을 빼고 경고 · 그 백업은 열리고 복원된다', async () => {
  const big = 'x'.repeat(400 * 1024);
  for (let i = 0; i < 4; i++) AC.setAgentConfig(`edge-big-${i}`, { 'svcmon.json': JSON.stringify({ pad: big }) });
  BK._setArchiveCapForTest(1024 * 1024);   // 상한 1MB — 엣지 4곳 × 400KB 면 넘는다(실제 상한 64MB 와 같은 비교 코드)
  try {
    const r = await BK.createBackup('manual');
    assert.ok(r.edgesOmitted && r.edgesOmitted.agents.length >= 4, JSON.stringify(r.edgesOmitted));
    assert.equal(r.edges, 0);
    assert.ok(r.warnings.some((w) => /엣지 설정 사본/.test(w)));
    const rb = BK.readBackupDetailed(r.name);
    assert.equal(rb.ok, true, `상한 안으로 줄인 백업이 열리지 않는다: ${JSON.stringify(rb)}`);
    assert.deepEqual(rb.archive.edges, {});
    assert.ok(rb.archive.edgesOmitted.agents.includes('edge-big-0'));
  } finally { BK._setArchiveCapForTest(null); }
});

test('C5-01 — 중앙만으로도 상한을 넘으면 열 수 없는 백업을 만들지 않고 던진다', async () => {
  const f = path.join(DIR, 'huge-central.json');
  fs.writeFileSync(f, JSON.stringify({ pad: 'y'.repeat(300 * 1024) }));
  BK._setArchiveCapForTest(200 * 1024);
  const before = BK.listBackups().length;
  try {
    await assert.rejects(BK.createBackup('manual'), (e) => e.code === 'BACKUP_TOO_LARGE');
    assert.equal(BK.listBackups().length, before, '실패한 백업 파일이 남으면 안 된다');
  } finally { BK._setArchiveCapForTest(null); fs.unlinkSync(f); }
});

test('C5-01 — readBackupDetailed 는 없음 · 상한 초과 · 손상을 구분한다(해제 상한 유지)', () => {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const tooBig = 'portal-backup-2020-01-01T00-00-00-000Z-manual.json.gz';
  fs.writeFileSync(path.join(BACKUPS, tooBig), zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, central: { files: {} }, pad: 'z'.repeat(2 * 1024 * 1024) }))));
  const bad = 'portal-backup-2020-01-02T00-00-00-000Z-manual.json.gz';
  fs.writeFileSync(path.join(BACKUPS, bad), Buffer.from('not gzip'));
  BK._setArchiveCapForTest(1024 * 1024);
  try {
    assert.deepEqual(BK.readBackupDetailed(tooBig), { ok: false, code: 'too-large' });
    assert.equal(BK.readBackup(tooBig), null, '예전 API 모양 유지');
  } finally { BK._setArchiveCapForTest(null); }
  assert.deepEqual(BK.readBackupDetailed(bad), { ok: false, code: 'corrupt' });
  assert.deepEqual(BK.readBackupDetailed('portal-backup-none.json.gz'), { ok: false, code: 'not-found' });
  assert.deepEqual(BK.readBackupDetailed('../etc/passwd'), { ok: false, code: 'not-found' });
  assert.equal(BK.readBackupFailure('too-large').status, 422);
  assert.equal(BK.readBackupFailure('not-found').status, 404);
  // 테스트 훅은 상한을 올릴 수 없다
  BK._setArchiveCapForTest(10 * 1024 * 1024 * 1024);
  try { assert.equal(BK.readBackupDetailed(tooBig).ok, true); } finally { BK._setArchiveCapForTest(null); }
});

// ── 라우트(실제 adminRouter) ────────────────────────────────────────────────
test('라우트 — 열 수 없는 백업은 422 + 사유 · 복원 응답은 재시작 시 적용 · 상태에 예약 · 취소', async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/admin/backup`;
  try {
    const tooBig = 'portal-backup-2020-01-03T00-00-00-000Z-manual.json.gz';
    fs.writeFileSync(path.join(BACKUPS, tooBig), zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, central: { files: {} }, pad: 'z'.repeat(2 * 1024 * 1024) }))));
    BK._setArchiveCapForTest(1024 * 1024);
    try {
      const v = await fetch(`${base}/view/${tooBig}`);
      assert.equal(v.status, 422);
      const vj = await v.json();
      assert.equal(vj.error, 'backup-too-large'); assert.match(vj.reason, /상한/);
      const rr = await fetch(`${base}/restore/${tooBig}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(rr.status, 422);
    } finally { BK._setArchiveCapForTest(null); }
    assert.equal((await fetch(`${base}/view/portal-backup-nope.json.gz`)).status, 404);

    fs.writeFileSync(path.join(DIR, 'route-ui.json'), '{"v":"before"}');
    const m = await BK.createBackup('manual');
    fs.writeFileSync(path.join(DIR, 'route-ui.json'), '{"v":"after"}');
    const r = await fetch(`${base}/restore/${m.name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.pendingRestart, true); assert.equal(j.restarting, false);
    assert.match(j.note, /재시작하면 적용/);
    assert.ok(!/복원 완료/.test(j.note), '예약만 했는데 완료라고 말하지 않는다');
    assert.equal(fs.readFileSync(path.join(DIR, 'route-ui.json'), 'utf8'), '{"v":"after"}');
    const st = await (await fetch(`${base}/status`)).json();
    assert.equal(st.restore.pending.source, m.name);
    assert.ok(st.restore.pending.files.includes('route-ui.json'));
    const c = await (await fetch(`${base}/restore-staged/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(c.had, true); assert.equal(c.restore.pending, null);
  } finally { srv.close(); }
});

test('라우트 — 소유자 가드·감사 로그·restart 는 예약이 있을 때만(소스)', () => {
  const s = fs.readFileSync(path.join(SRC, 'routes/admin/backupNetSec.js'), 'utf8');
  assert.match(s, /adminRouter\.post\('\/backup\/restore-staged\/cancel', adminOnly, requireSettingsOwner/);
  assert.match(s, /const restart = req\.body\?\.restart === true && r\.pendingRestart;/);
  assert.match(s, /if \(restart\) setTimeout\(\(\) => restartProcess\(\), 250\);/);
  const cancel = s.slice(s.indexOf("'/backup/restore-staged/cancel'"), s.indexOf("'/backup/restore-staged/cancel'") + 600);
  assert.match(cancel, /logAudit/);
});
