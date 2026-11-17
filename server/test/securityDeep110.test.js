/**
 * test/securityDeep110.test.js — 전체 점검 110회차: 보안 심화(88회차가 '깊이 보지 못한 곳' 으로 남긴 모듈).
 *
 *  F1(중간) backup/stagedRestore.js — 자격증명 저장 방식(secrets-policy.json) 복원: 본 파일이 없거나 정책으로 읽히지 않으면(손상 보존 뒤) 돌고 있는 값은
 *     신뢰 사본인데 '없음' 으로 보고 평문 백업을 그대로 써, 암호화가 OTP 없이 평문이 됐다(100회차 세션 보안의 형제) → 짝 파일과 견준다.
 *  F2(중간) 같은 파일 — 장비 신뢰(peer-trust.json) 복원이 **지금 승인된 지문을 버려**, 백업의 신뢰 지문이 전부 회수된 장비는 신뢰 지문 없는 항목이 됐다 —
 *     observe 에서 처음 보는 지문이 '관찰' 로 통과(복원 전에는 '바뀐 지문' 거부) → 신뢰 = (백업 − 지금 거부 − 교체로 뺀 것) ∪ 지금 신뢰.
 *  F3(낮음) 같은 함수 — 두 종류 정책을 함께 지킬 때 첫 종류(ssh)의 origin 을 백업 값으로 되덮었다.
 *  F4(낮음) 같은 파일 — users.json · central-agent-tokens.json · bareos-groups.json 의 지금 파일 **읽기 오류**를 '없음' 으로 보았다(91회차 R2 의 형제).
 *  F5(낮음) security/tlsTrust.js — 사설 CA 번들 읽기 오류를 stat 열쇠로 기억해, 권한을 고쳐도(mtime 그대로) 재시작 전까지 번들을 쓰지 않았다.
 *  F6(낮음) auth/addressMask.js — 등록한 호스트 이름과 대소문자가 다른 오류 문구(REST 수집은 URL 이 소문자로 바꾼다)가 비관리자 응답에서 가려지지 않았다.
 *  결정(권장안 구현): 교체 승인(replace)으로 뺀 지문은 복원으로 신뢰 목록에 되살리지 않는다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } };
after(() => { rmTmpDirs(); process.once('exit', rmTmpDirs); });   // 종료 flush(peer-trust)가 뒤늦게 다시 만든 폴더까지

const DIR = tmpDir('secdeep110-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
delete process.env.TLS_PEER_POLICY;
delete process.env.SSH_HOSTKEY_POLICY;
delete process.env.SECRETS_KEY;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const SR = await import('../src/backup/stagedRestore.js');

const J = (o) => JSON.stringify(o);
const PLAIN = J({ mode: 'plain', level: 2, algorithm: '' });
const ENC = JSON.stringify({ mode: 'encrypted', level: 3, algorithm: '' }, null, 2);
const modeOf = (t) => JSON.parse(t).mode;
/** 자식 프로세스(= 다음 기동)에서 모듈을 불러 한 줄 JSON 을 받는다. */
function child(dir, rel, expr) {
  const code = `const m = await import(${J(pathToFileURL(path.join(SRC, rel)).href)}); console.log('OUT=' + JSON.stringify(${expr}));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, DATA_DIR: dir }, encoding: 'utf8' });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('OUT='));
  assert.ok(line, `자식 프로세스 출력 없음: ${String(r.stderr || '').slice(0, 400)}`);
  return JSON.parse(line.slice(4));
}
function applyTo(dir, files) {
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  SR.stageRestore(files, { configDir: dir });
  return SR.applyStagedRestore({ configDir: dir });
}

// ── F1 자격증명 저장 방식 복원 — 짝 파일(신뢰 사본)과 견준다 ─────────────────────────────────────
test('F1 본 파일이 없고 신뢰 사본이 암호화면 평문 백업으로 내리지 않는다(실제 적용 + 다음 기동의 로더)', () => {
  const d = tmpDir('secdeep110-pol-');
  fs.writeFileSync(path.join(d, 'secrets-policy.trusted.json'), ENC);
  assert.equal(child(d, 'security/secretVault.js', 'm.loadSecretsPolicy()').mode, 'encrypted', '복원 전: 신뢰 사본으로 암호화');
  const r = applyTo(d, { 'secrets-policy.json': PLAIN });
  assert.deepEqual(r.applied, ['secrets-policy.json']);
  assert.ok(r.warnings.some((w) => w.file === 'secrets-policy.json' && /지금 방식을 유지/.test(w.reason)), '약하게 되돌리지 않은 사실을 알린다');
  assert.equal(modeOf(fs.readFileSync(path.join(d, 'secrets-policy.json'), 'utf8')), 'encrypted');
  const next = child(d, 'security/secretVault.js', 'm.loadSecretsPolicy()');
  assert.equal(next.mode, 'encrypted', '다음 기동도 암호화(예전: 평문 정책을 정상으로 읽었다)');
  assert.equal(next.level, 3, '레벨도 지금 값');
  assert.equal(modeOf(fs.readFileSync(path.join(d, 'secrets-policy.trusted.json'), 'utf8')), 'encrypted', '신뢰 사본도 평문으로 맞춰지지 않는다');
});

test('F1 본 파일이 손상 · 내용 오류여도 신뢰 사본과 견주고, 짝이 본 파일인 경우(신뢰 사본 복원)도 같다', () => {
  for (const bad of ['{"mode": "encr', '{}', '[]', '{"mode":"weird"}']) {
    const d = tmpDir('secdeep110-pol2-');
    fs.writeFileSync(path.join(d, 'secrets-policy.json'), bad);
    fs.writeFileSync(path.join(d, 'secrets-policy.trusted.json'), ENC);
    const rc = SR.reconcileForApply('secrets-policy.json', PLAIN, d);
    assert.equal(modeOf(rc.content), 'encrypted', `본 파일 ${bad} — 신뢰 사본(암호화)을 지킨다`);
    assert.equal(rc.info?.secretsPolicyKept, true);
  }
  // 신뢰 사본을 복원할 때: 사본이 없고 본 파일이 암호화면 평문 사본을 쓰지 않는다(본 파일을 못 읽는 기동이 그 사본으로 돈다)
  const d2 = tmpDir('secdeep110-pol3-');
  fs.writeFileSync(path.join(d2, 'secrets-policy.json'), ENC);
  assert.equal(modeOf(SR.reconcileForApply('secrets-policy.trusted.json', PLAIN, d2).content), 'encrypted');
});

test('F1 짝 파일을 읽지 못하면 이 파일만 적용하지 않고, 예전 규칙(둘 다 없음 · 본 파일이 평문 · 백업이 암호화)은 그대로다', () => {
  const d = tmpDir('secdeep110-pol4-');
  fs.mkdirSync(path.join(d, 'secrets-policy.trusted.json'));   // 읽기 오류(EISDIR)
  assert.throws(() => SR.reconcileForApply('secrets-policy.json', PLAIN, d), /읽지 못해\(EISDIR\)/, '지금 값을 모른 채 평문으로 덮지 않는다');
  const e = tmpDir('secdeep110-pol5-');
  assert.equal(SR.reconcileForApply('secrets-policy.json', PLAIN, e).content, PLAIN, '둘 다 없음(재해 복구) — 백업 그대로');
  fs.writeFileSync(path.join(e, 'secrets-policy.json'), PLAIN);
  fs.writeFileSync(path.join(e, 'secrets-policy.trusted.json'), ENC);
  assert.equal(SR.reconcileForApply('secrets-policy.json', PLAIN, e).content, PLAIN, '본 파일이 정책으로 읽히면 그것이 지금 값이다(짝을 보지 않는다)');
  fs.writeFileSync(path.join(e, 'secrets-policy.json'), '{bad');
  const encBackup = J({ mode: 'encrypted', level: 1 });
  assert.equal(SR.reconcileForApply('secrets-policy.json', encBackup, e).content, encBackup, '백업이 암호화면 백업 그대로');
});

// ── F2 · F3 · 결정: 장비 신뢰 복원 ───────────────────────────────────────────────────────────
const FP = (ch) => `SHA256:${ch.repeat(43)}`;
const [A, B, C, D, X] = ['A', 'B', 'C', 'D', 'X'].map(FP);
const peerFile = (policy, entries, origin = {}) => ({ v: 1, policy, origin, entries });
const ent = (host, o = {}) => ({ kind: 'ssh', host, port: 22, ...o });
const ap = (fp, extra = {}) => ({ fp, state: 'approved', ...extra });
const OBS = { ssh: 'observe', tls: 'observe' };

test('F2 지금 승인된 지문을 버리지 않는다 — observe 에서 처음 보는 지문이 복원 뒤에도 거부된다(실제 로더)', async () => {
  const PT = await import('../src/security/peerTrust.js');
  const file = path.join(DIR, 'peer-trust.json');
  const cur = peerFile(OBS, [ent('10.0.0.5', { trusted: ap(B), rejected: [{ fp: A, at: 1, by: 'adm' }] })]);
  const bak = peerFile(OBS, [ent('10.0.0.5', { trusted: ap(A) })]);
  fs.writeFileSync(file, J(cur));
  PT._resetPeerTrustForTest();
  assert.deepEqual([PT.checkPeer('ssh', '10.0.0.5', 22, X).ok, PT.peekPeer('ssh', '10.0.0.5', 22, X).state], [false, 'changed'], '복원 전: 신뢰 지문이 있는 장비의 다른 지문은 거부');
  PT._resetPeerTrustForTest();
  fs.writeFileSync(file, J(cur));
  const r = applyTo(DIR, { 'peer-trust.json': J(bak) });
  assert.deepEqual(r.applied, ['peer-trust.json']);
  assert.ok(r.warnings.some((w) => /거부\(회수\)한 지문 1개/.test(w.reason) && /승인 · 관찰한 지문 1개는 그대로/.test(w.reason)), JSON.stringify(r.warnings));
  PT._resetPeerTrustForTest();
  const x = PT.checkPeer('ssh', '10.0.0.5', 22, X);
  assert.deepEqual([x.ok, x.reason], [false, 'changed'], '복원 뒤: 처음 보는 지문 X 는 여전히 거부(예전: observed-new 로 통과)');
  assert.deepEqual([PT.checkPeer('ssh', '10.0.0.5', 22, B).reason, PT.checkPeer('ssh', '10.0.0.5', 22, A).reason], ['approved', 'rejected'], '지금 승인 B 는 통과 · 회수한 A 는 거부');
  PT.flushPeerTrust(); PT._resetPeerTrustForTest();
});

test('F2 규칙 — 신뢰 = (백업 − 지금 거부) ∪ 지금 신뢰 · 거부 = (백업 거부 − 지금 신뢰) ∪ 지금 거부 · 대기는 승인됐으면 비움', () => {
  const bak = peerFile(OBS, [
    ent('h1', { trusted: ap(A), trustedMore: [{ fp: C, state: 'observed' }] }),                 // 지금: A 거부 · C 승인 · B 추가 승인
    ent('h2', { trusted: null, rejected: [{ fp: B, at: 1 }] }),                                 // 지금: B 를 승인(거부를 풀었다)
    ent('h3', { trusted: { fp: D, state: 'observed' }, pending: { fp: D, reason: 'not-approved' } }),   // 지금도 관찰 — 그대로
    ent('h4', { trusted: ap(A) }),                                                              // 지금 파일에 없음 — 백업 그대로
    ent('h6', { trusted: null, pending: { fp: C, reason: 'unknown' } }),                        // 지금: 대기 지문 C 를 승인
  ]);
  const cur = peerFile(OBS, [
    ent('h1', { trusted: ap(C), trustedMore: [ap(B)], rejected: [{ fp: A, at: 2, by: 'adm' }] }),
    ent('h2', { trusted: ap(B) }),
    ent('h3', { trusted: { fp: D, state: 'observed' } }),
    ent('h5', { trusted: ap(D) }),                                                              // 백업 이후 생긴 항목
    ent('h6', { trusted: ap(C) }),
  ]);
  const r = SR.reconcilePeerTrustText(J(bak), J(cur));
  const out = JSON.parse(r.text);
  const by = (h) => out.entries.find((e) => e.host === h);
  const fps = (e) => [e.trusted, ...(e.trustedMore || [])].filter(Boolean).map((t) => `${t.fp.slice(7, 8)}:${t.state}`);
  assert.deepEqual(fps(by('h1')), ['C:approved', 'B:approved'], 'A 는 빠지고 · C 는 지금 승인 상태로 · B(지금 추가 승인)는 남는다');
  assert.deepEqual(by('h1').rejected.map((x) => x.fp), [A]);
  assert.deepEqual(fps(by('h2')), ['B:approved']);
  assert.deepEqual(by('h2').rejected, [], '백업 뒤 승인한 지문의 옛 거부 기록은 뺀다(승인이 거부를 푼다)');
  assert.deepEqual(by('h3'), bak.entries[2], '바뀐 것이 없는 항목은 백업 그대로(관찰 대기도 그대로)');
  assert.deepEqual(by('h4'), bak.entries[3]);
  assert.deepEqual(by('h5'), cur.entries[3]);
  assert.deepEqual([fps(by('h6')), by('h6').pending], [['C:approved'], null], '이미 승인된 대기 지문은 비운다');
  assert.deepEqual([r.keptRevoked, r.keptReplaced, r.keptApproved], [1, 0, 4], '회수 1(A) · 지금 것 유지 4(h1 C 승격 · h1 B · h2 B · h6 C)');
  // 지금 파일과 같으면 글자 그대로의 백업 내용(다시 쓰기만)
  const same = SR.reconcilePeerTrustText(J(bak), J(bak));
  assert.deepEqual(JSON.parse(same.text), bak);
  assert.deepEqual([same.keptRevoked, same.keptReplaced, same.keptApproved], [0, 0, 0]);
});

test('F2 상한(8개)을 넘으면 지금 지문을 앞에 두고 · TLS 지문은 표기(콜론 · 대소문자)가 달라도 같은 지문으로 본다', () => {
  const many = 'abcdefgh'.split('').map((ch) => ap(FP(ch)));
  const bak = peerFile(OBS, [ent('h1', { trusted: many[0], trustedMore: many.slice(1) })]);
  const cur = peerFile(OBS, [ent('h1', { trusted: ap(X), trustedMore: [ap(B)] })]);
  const e = JSON.parse(SR.reconcilePeerTrustText(J(bak), J(cur)).text).entries[0];
  const list = [e.trusted, ...e.trustedMore].map((t) => t.fp);
  assert.equal(list.length, 8);
  assert.deepEqual(list.slice(0, 2), [X, B], '지금 통과하는 지문이 로더의 꼬리 버림에 걸리지 않게 앞에');
  const hex = 'ab'.repeat(32);
  const colon = hex.toUpperCase().match(/../g).join(':');
  const bakT = peerFile(OBS, [{ kind: 'tls', host: 'h1', port: 443, trusted: { fp: hex, state: 'approved' } }]);
  const curT = peerFile(OBS, [{ kind: 'tls', host: 'h1', port: 443, trusted: null, rejected: [{ fp: colon, at: 1 }] }]);
  const rt = SR.reconcilePeerTrustText(J(bakT), J(curT));
  assert.equal(JSON.parse(rt.text).entries[0].trusted, null);
  assert.equal(rt.keptRevoked, 1);
});

test('F3 두 종류 정책을 함께 지킬 때 origin 도 둘 다 지금 값이다', () => {
  const cur = peerFile({ ssh: 'enforce', tls: 'enforce' }, [], { ssh: { origin: 'admin', at: 5, by: 'a' }, tls: { origin: 'admin', at: 6, by: 'b' } });
  const bak = peerFile(OBS, [], { ssh: { origin: 'upgrade-migration', at: 1 }, tls: { origin: 'load-error', at: 1 } });
  const r = SR.reconcilePeerTrustText(J(bak), J(cur));
  const out = JSON.parse(r.text);
  assert.deepEqual(out.policy, { ssh: 'enforce', tls: 'enforce' });
  assert.deepEqual(out.origin, cur.origin, '예전: ssh 가 백업 값(upgrade-migration)으로 되덮였다');
  assert.deepEqual(r.keptPolicy, ['ssh', 'tls']);
  // 한 종류만 지킬 때는 다른 종류의 백업 origin 을 건드리지 않는다
  const one = JSON.parse(SR.reconcilePeerTrustText(J(bak), J({ ...cur, policy: { ssh: 'enforce', tls: 'observe' } })).text);
  assert.deepEqual(one.origin, { ssh: cur.origin.ssh, tls: bak.origin.tls });
});

test('결정(권장안) 교체 승인으로 뺀 지문은 되살리지 않는다 — 거부 목록에는 넣지 않고, 다시 승인했으면 남긴다', () => {
  const hist = [{ at: 2, ev: 'approved-replace', fp: B, by: 'adm', replaced: [A, C] }];
  const bak = peerFile({ ssh: 'enforce', tls: 'enforce' }, [ent('h1', { trusted: ap(A), trustedMore: [ap(C)] })]);
  // 교체로 A · C 를 뺀 뒤 C 는 다시 승인했다
  const cur = peerFile({ ssh: 'enforce', tls: 'enforce' }, [ent('h1', { trusted: ap(B, { prevFp: A }), trustedMore: [ap(C)], history: hist })]);
  const r = SR.reconcilePeerTrustText(J(bak), J(cur));
  const e = JSON.parse(r.text).entries[0];
  assert.deepEqual([e.trusted, ...(e.trustedMore || [])].map((t) => t.fp), [C, B], 'A(교체로 뺌)는 없고 · C(다시 승인) · B(지금 승인)는 있다');
  assert.equal(e.rejected, undefined, '교체로 뺀 지문은 거부가 아니다(다시 보이면 바뀐 지문으로 승인 대기)');
  assert.equal(r.keptReplaced, 1);
  const rc = (() => { const d = tmpDir('secdeep110-pt-'); fs.writeFileSync(path.join(d, 'peer-trust.json'), J(cur)); return SR.reconcileForApply('peer-trust.json', J(bak), d); })();
  assert.match(rc.warning.reason, /교체 승인으로 뺀 지문 1개는 되살리지 않았습니다/);
  assert.equal(rc.info.peerTrustKeptReplaced, 1);
});

// ── F4 지금 파일 읽기 오류 ≠ 없음 ────────────────────────────────────────────────────────────
test('F4 users.json · 엣지 토큰 · Bareos 그룹은 지금 파일 읽기 오류면 복원 적용하지 않는다(없음만 예전대로)', () => {
  const d = tmpDir('secdeep110-rd-');
  const backups = {
    'users.json': J({ users: [{ username: 'a', tokenVersion: 3 }] }),
    'central-agent-tokens.json': J({ tokens: [{ agent: 'edge-old', hash: 'h-old' }] }),
    'bareos-groups.json': J({ groups: [{ id: 'g', lastKey: '2026-01-01 00:00' }] }),
  };
  for (const name of Object.keys(backups)) fs.mkdirSync(path.join(d, name));   // 읽기 오류(EISDIR)
  for (const [name, text] of Object.entries(backups)) assert.throws(() => SR.reconcileForApply(name, text, d), /읽지 못해\(EISDIR\)/, name);
  // 없음(ENOENT — 재해 복구)은 예전 그대로
  const e = tmpDir('secdeep110-rd2-');
  assert.equal(JSON.parse(SR.reconcileForApply('users.json', backups['users.json'], e).content).users[0].tokenVersion, 4);
  assert.deepEqual(SR.reconcileForApply('central-agent-tokens.json', backups['central-agent-tokens.json'], e).info.agentTokensRevived, ['edge-old']);
  assert.equal(JSON.parse(SR.reconcileForApply('bareos-groups.json', backups['bareos-groups.json'], e).content).groups[0].lastKey, '2026-01-01 00:00');
});

test('F4 실제 적용 — 읽지 못한 users.json · 토큰 파일을 백업 판본으로 덮지 않는다(권한 오류 흉내)', () => {
  const d = tmpDir('secdeep110-rd3-');
  const curUsers = J({ users: [{ username: 'a', tokenVersion: 10 }] });
  const curTokens = J({ tokens: [{ agent: 'edge-new', hash: 'h-new' }] });
  fs.writeFileSync(path.join(d, 'users.json'), curUsers);
  fs.writeFileSync(path.join(d, 'central-agent-tokens.json'), curTokens);
  const blocked = new Set([path.join(d, 'users.json'), path.join(d, 'central-agent-tokens.json')]);
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...a) => { if (blocked.has(String(p))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead(p, ...a); };
  let r;
  try {
    r = applyTo(d, { 'users.json': J({ users: [{ username: 'a', tokenVersion: 3 }] }), 'central-agent-tokens.json': J({ tokens: [{ agent: 'edge-old', hash: 'h-old' }] }), 'ui.json': '{"x":1}' });
  } finally { fs.readFileSync = realRead; }
  assert.deepEqual(r.applied, ['ui.json'], '다른 파일은 적용된다');
  assert.deepEqual(r.failed.map((f) => f.file).sort(), ['central-agent-tokens.json', 'users.json']);
  assert.ok(r.failed.every((f) => /읽지 못해\(EACCES\)/.test(f.reason)));
  assert.equal(fs.readFileSync(path.join(d, 'users.json'), 'utf8'), curUsers, '예전: 세션 버전 4(지금 10 보다 낮다 — 그 사이 폐기한 토큰이 되살아날 수 있다)로 덮였다');
  assert.equal(fs.readFileSync(path.join(d, 'central-agent-tokens.json'), 'utf8'), curTokens, '예전: 다시 발급한 토큰을 잃고 옛 토큰이 되살아났다');
});

// ── F5 사설 CA 번들 읽기 오류는 고착되지 않는다 ─────────────────────────────────────────────────
test('F5 CA 번들 읽기 오류 뒤 파일이 다시 읽히면(권한 수정 — mtime 그대로) 재시작 없이 번들을 쓴다', async () => {
  const T = await import('../src/security/tlsTrust.js');
  const file = path.join(DIR, 'tls-ca-bundle.pem');
  fs.writeFileSync(file, fs.readFileSync(path.join(HERE, 'fixtures', 'rvI-tls', 'ca.crt')));
  const realRead = fs.readFileSync; const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;   // 1초 stat 간격을 넘긴다(기다리지 않고)
  try {
    T._resetTlsTrustForTest();
    fs.readFileSync = (p, ...a) => { if (String(p) === file) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead(p, ...a); };
    const bad = T.loadCaBundle();
    assert.deepEqual([bad.certs.length, /읽지 못했습니다\(EACCES\)/.test(bad.info.error)], [0, true]);
    const badKey = bad.key;
    skew += 5000;
    assert.equal(T.loadCaBundle().key, badKey, '오류가 이어지는 동안 열쇠는 같다(검증된 세션 · 컨텍스트 캐시가 흔들리지 않는다)');
    fs.readFileSync = realRead;   // chmod 로 고쳤다 — mtime · size · inode 는 그대로
    skew += 5000;
    const ok = T.loadCaBundle();
    assert.equal(ok.certs.length, 1, '예전: 재시작 전까지 0(읽지 못했습니다)');
    assert.equal(ok.info.error, undefined);
    assert.equal(T.tlsTrustStatus().caBundle.certs, 1);
  } finally { fs.readFileSync = realRead; Date.now = realNow; T._resetTlsTrustForTest(); fs.rmSync(file, { force: true }); }
});

// ── F6 주소 가림 — 대소문자가 다른 표기 ─────────────────────────────────────────────────────────
test('F6 등록한 이름과 대소문자가 다른 오류 문구도 가린다(REST 수집은 URL 이 호스트 이름을 소문자로 바꾼다)', async () => {
  const M = await import('../src/auth/addressMask.js');
  assert.equal(new URL('https://STOR01.Corp.Example:8080/x').hostname, 'stor01.corp.example', '전제: fetch 가 쓰는 이름은 소문자');
  assert.deepEqual(M.hostVariants('https://STOR01.Corp:8080/'), ['https://STOR01.Corp:8080/', 'STOR01.Corp', 'https://stor01.corp:8080/', 'stor01.corp']);
  assert.deepEqual(M.hostVariants('10.0.0.5'), ['10.0.0.5'], '소문자와 같은 표기는 늘지 않는다');
  const dev = { id: 'd1', type: 'isilon', name: 'ISI-A', host: 'STOR01.Corp.Example', username: 'root',
    snap: { deviceId: 'd1', type: 'isilon', name: 'ISI-A',
      error: '스토리지 REST stor01.corp.example:8080 장비 인증서를 신뢰할 수 없어 연결을 끊었습니다',
      errors: { capacity: 'getaddrinfo ENOTFOUND stor01.corp.example', n: 3 },
      sections: { a: '오류: stor01.corp.example:8080 응답이 없습니다' },
      items: [{ detail: 'connect to STOR01.Corp.Example failed (stor01.corp.example)' }] } };
  const m = M.maskDeviceAddress(dev);
  const all = JSON.stringify(m);
  assert.equal(/stor01/i.test(all), false, `비관리자 판본에 호스트 이름이 남았다: ${all}`);
  assert.equal(m.snap.error, '스토리지 REST (주소 가림):8080 장비 인증서를 신뢰할 수 없어 연결을 끊었습니다');
  assert.equal(m.snap.errors.n, 3, '글자가 아닌 값은 그대로');
  assert.equal(M.scrubHosts('connect to stor01.corp.example failed', ['STOR01.Corp.Example']), 'connect to (주소 가림) failed');
  const ev = M.maskActivityEvents([{ deviceId: 'd1', name: 'ISI-A', host: 'STOR01.Corp.Example', error: 'getaddrinfo ENOTFOUND stor01.corp.example' }], []);
  assert.equal(ev[0].error, 'getaddrinfo ENOTFOUND (주소 가림)');
  // 소문자 · IP 로 등록한 장비의 결과는 예전과 같다
  const plain = M.maskSnapAddress({ host: '10.0.0.5', name: 'SW-A', error: 'connect ECONNREFUSED 10.0.0.5:22 (10.0.0.50 아님)', errors: { x: '10.0.0.5 timeout' } });
  assert.deepEqual([plain.error, plain.errors.x, plain.host], ['connect ECONNREFUSED (주소 가림):22 ((주소 가림)0 아님)', '(주소 가림) timeout', '']);
});
