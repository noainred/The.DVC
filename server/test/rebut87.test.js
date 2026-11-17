/**
 * rebut87.test.js — 전체 점검 87회차(84회차 수정 반증 — 적대적 재검토 + 84회차가 남긴 결정의 권장안).
 *
 * 반증:
 *  R1 백업 복원(restoreCentral)이 지금 portal.env 의 **읽기 오류**(EACCES — install.sh 가 안내하는 root 소유)를 '없음' 으로 보고 합쳐,
 *     번들에서 가려진 AUTH_SECRET · CENTRAL_TOKEN 과 호스트에만 있던 보안 스위치 줄을 잃은 파일로 덮었다(failed 0 — 조용히 · 재현).
 *     84 F3(persistEnv)의 형제 경로 → 읽기 오류면 그 .env 는 복원하지 않고 failed 로 알린다.
 *  R2 84 F2 의 형제 — /capture-result hostA(캡처 이력 300건 상주) · /capacity meta(메모리 폴백 저장소 상주)의 `.slice` → capStr.
 *
 * 결정(84회차 남긴 것 — 권장안):
 *  ⓐ central 등록부 로더(agentTokens · agentUsers · assignments · inventory · fleet · agent-results)에 공용 읽기 판정 — 읽기 오류는 원본 유지 ·
 *     캐시 안 함 · 쓰기 거절 · 30초 재읽기(읽히면 재시작 없이 풀림). 손상은 예전과 같다.
 *  ⓑ edgePull kind `ambiguous` 를 열거 EDGE_PULL_KINDS · 웹 문구 맵에(1:1).
 *  ⓒ POST /api/admin/central-token/generate 의 portal.env 저장 거절은 400 + 사유(PUT 과 같게 — 예전 500 'internal error').
 *
 * ⚠ 저장소 server/config 오염 방지 — 모듈 import 전에 CONFIG_DIR 을 임시 폴더로 고정한다. 읽기 오류는 fs.readFileSync 를 그 파일에서만 던지게 해 만든다
 *   (컨테이너가 root 라 chmod 로는 EACCES 를 재현할 수 없다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const CFG = tmpDir('rebut87-');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRCDIR = path.join(HERE, '..', 'src');
const WEBDIR = path.join(HERE, '..', '..', 'web', 'src');
const realRead = fs.readFileSync;
/** file 의 읽기만 code 로 던지게 하고 fn 을 돌린다(끝나면 원래대로). */
async function denyRead(file, fn, code = 'EACCES') {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error(`${code}: permission denied, open '${file}'`); e.code = code; throw e; }
    return realRead.call(this, p, ...a);
  };
  try { return await fn(); } finally { fs.readFileSync = realRead; }
}
const corruptFiles = (dir, base) => fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.corrupt.`));
/** 정시 경계로 떨어뜨린 기준 시각(테스트 시계) — Date.now() 직접 · 고정 epoch 둘 다 쓰지 않는다. */
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000;

/* ── R1 ─────────────────────────────────────────────────────────────── */
test('87 R1: 백업 복원 — 지금 portal.env 를 읽지 못하면 그 파일은 복원하지 않고 failed 로 알린다(AUTH_SECRET · 토큰 · 보안 스위치 보존)', async () => {
  const BK = await import('../src/backup/service.js');
  const envF = path.join(CFG, 'portal.env');
  const orig = 'PORT=4000\nAUTH_SECRET=keep-me-87\nCENTRAL_TOKEN=tok-keep-87\nWAN_TLS_INSECURE=false\nDATA_SOURCE=live\n';
  fs.writeFileSync(envF, orig);
  const made = await BK.createBackup('manual');
  const a = BK.readBackup(made.name);
  assert.match(a.central.files['portal.env'], /AUTH_SECRET=<redacted/, '번들의 비밀은 가려져 있다(전제)');
  const rr = await denyRead(envF, () => BK.restoreCentral(a, { retention: 5, source: 'rebut87' }));
  assert.equal(realRead(envF, 'utf8'), orig, '읽지 못한 portal.env 를 덮지 않는다');
  assert.ok((rr.failed || []).some((f) => f.file === 'portal.env' && /읽지 못해\(EACCES\)/.test(f.reason)), JSON.stringify(rr.failed));
  assert.deepEqual(rr.envKeysDropped, [], '가린 키를 버렸다고 보고하지 않는다(합치지 않았다)');
  // 읽을 수 있으면 예전처럼 합쳐 쓴다(가린 값은 지금 파일 값으로 되살린다)
  const rr2 = await BK.restoreCentral(a, { retention: 5, source: 'rebut87' });
  assert.equal((rr2.failed || []).filter((f) => f.file === 'portal.env').length, 0);
  assert.match(realRead(envF, 'utf8'), /^AUTH_SECRET=keep-me-87$/m);
  assert.match(realRead(envF, 'utf8'), /^CENTRAL_TOKEN=tok-keep-87$/m);
});

/* ── R2 ─────────────────────────────────────────────────────────────── */
test('87 R2: /capture-result hostA · /capacity meta 는 capStr(상주 글자 — `.slice` 금지)', () => {
  const ops = stripComments(realRead(path.join(SRCDIR, 'routes/central/opsRoutes.js'), 'utf8'));
  const cap = ops.slice(ops.indexOf('const hostA ='), ops.indexOf('\n', ops.indexOf('const hostA =')));
  assert.match(cap, /capStr\(/); assert.doesNotMatch(cap, /\.trim\(\)\.slice\(0, 255\)/);
  const c = stripComments(realRead(path.join(SRCDIR, 'routes/central.js'), 'utf8'));
  const meta = c.slice(c.indexOf('const meta = b.meta'), c.indexOf('getCapacityDb', c.indexOf('const meta = b.meta')));
  assert.doesNotMatch(meta, /String\(b\.meta\.\w+ \|\| ''\)\.slice/, 'capacity meta 에 .slice 절단');
  assert.doesNotMatch(c, /r\.metric\.slice\(0, 40\)/);
});

/* ── ⓐ agentTokens ──────────────────────────────────────────────────── */
test('87 ⓐ agentTokens: 읽기 오류는 원본을 옮기지 않고 · 발급 · 회수를 거절(409)하며 · 읽히면 재시작 없이 풀린다', async () => {
  const T = await import('../src/central/agentTokens.js');
  const JL = await import('../src/util/jsonFileLoad.js');
  const F = path.join(CFG, 'central-agent-tokens.json');
  T._resetAgentTokenCache();
  const a = T.issueAgentToken('edge87-a'); const b = T.issueAgentToken('edge87-b');
  assert.ok(a.ok && b.ok);
  const orig = realRead(F, 'utf8');
  T._resetAgentTokenCache();
  let now = BASE; JL._setJsonFileLoadClockForTest(() => now);
  try {
    await denyRead(F, () => {
      const le = T.agentTokensLoadError();
      assert.ok(le && le.readError === true, JSON.stringify(le));
      assert.match(le.text, /EACCES/);
      const iss = T.issueAgentToken('edge87-c');
      assert.equal(iss.ok, false); assert.equal(iss.status, 409); assert.equal(iss.code, 'registry-unreadable');
      const rv = T.revokeAgentToken('edge87-a');
      assert.equal(rv.ok, false); assert.equal(rv.status, 409, '읽기 오류 중 회수는 \'발급된 토큰이 없습니다\' 가 아니다');
      assert.equal(T.resolveAgentByToken(a.token), null);
      // 간격 안의 반복 조회는 디스크를 보지 않는다(reader 간격) — 여전히 오류
      now += 10_000; assert.ok(T.agentTokensLoadError());
    });
    assert.equal(realRead(F, 'utf8'), orig, '원본 그대로(덮지 않음)');
    assert.deepEqual(corruptFiles(CFG, 'central-agent-tokens.json'), [], '읽기 오류를 손상으로 보존하지 않는다');
    now += 31_000;   // 권한이 풀렸다 — 간격이 지나면 다시 읽는다
    assert.equal(T.resolveAgentByToken(a.token), 'edge87-a');
    assert.equal(T.agentTokensLoadError(), null);
    assert.equal(T.listAgentTokens().length, 2);
  } finally { JL._setJsonFileLoadClockForTest(); }
  // 손상은 예전과 같다 — 보존 → 표지 → 발급으로 풀림
  fs.writeFileSync(F, '{broken');
  T._resetAgentTokenCache();
  assert.equal(T.agentTokensLoadError()?.code, 'parse-error');
  assert.equal(corruptFiles(CFG, 'central-agent-tokens.json').length, 1);
  assert.equal(T.issueAgentToken('edge87-z').ok, true);
  assert.equal(T.agentTokensLoadError(), null);
});

/* ── ⓐ agentUsers · assignments · inventory · fleet · results — 기동 시 읽기(자식 프로세스) ─────────── */
function runChild(dir, deny, body, extraEnv = {}) {
  const script = `
    import fs from 'node:fs';
    const realRead = fs.readFileSync; const DENY = ${JSON.stringify(deny)};
    globalThis.__deny = true;
    fs.readFileSync = function (p, ...a) { if (globalThis.__deny && DENY.includes(String(p))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead.call(this, p, ...a); };
    const JL = await import(${JSON.stringify(path.join(SRCDIR, 'util/jsonFileLoad.js'))});
    let now = ${BASE}; JL._setJsonFileLoadClockForTest(() => now);
    const tick = (ms) => { now += ms; };
    const out = {};
    ${body}
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const res = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir, ...extraEnv }, encoding: 'utf8', timeout: 90_000 });
  return JSON.parse(res.split('\n').find((l) => l.startsWith('@@')).slice(2));
}

test('87 ⓐ agentUsers: 기동 때 읽기 오류 — 원본 유지 · 503 표지(readError) · 저장 거절 · 간격 뒤 다시 읽어 풀림', () => {
  const dir = tmpDir('rebut87-users-');
  const F = path.join(dir, 'central-agent-users.json');
  const orig = JSON.stringify({ 'edge-a': { at: 1, users: [{ username: 'ops1', name: 'ops1', role: 'viewer', passwordHash: 'scrypt$x' }] } });
  fs.writeFileSync(F, orig);
  const out = runChild(dir, [F], `
    const U = await import(${JSON.stringify(path.join(SRCDIR, 'central/agentUsers.js'))});
    out.err = U.registryLoadError();
    out.users = U.getEffectiveUsers('edge-a').length;
    out.up = U.upsertAgentUser('edge-b', { username: 'ops2', role: 'viewer' });
    globalThis.__deny = false;
    tick(10_000); out.stillErr = !!U.registryLoadError();
    tick(25_000); out.after = U.registryLoadError(); out.usersAfter = U.getEffectiveUsers('edge-a').length;
  `);
  assert.ok(out.err && out.err.readError === true, JSON.stringify(out.err));
  assert.equal(out.users, 0);
  assert.equal(out.up.ok, false); assert.equal(out.up.readError, true); assert.match(out.up.reason, /읽기 오류이고 원본은 그대로/);
  assert.equal(out.stillErr, true, '간격(30초) 안에는 다시 읽지 않는다');
  assert.equal(out.after, null); assert.equal(out.usersAfter, 1);
  assert.equal(realRead(F, 'utf8'), orig);
  assert.deepEqual(corruptFiles(dir, 'central-agent-users.json'), []);
});

test('87 ⓐ assignments: 읽기 오류 — 원본 유지 · 바꾸기 가져오기까지 거절 · 503 표지 · 읽히면 풀림 / 결과 파일은 덮지 않고 합친다', () => {
  const dir = tmpDir('rebut87-assign-');
  const F = path.join(dir, 'agent-assignments.json');
  const R = path.join(dir, 'agent-results.json');
  const orig = JSON.stringify({ assignments: [{ agent: 'edge-a', ips: '10.0.0.1-10.0.0.9', username: 'root', password: 'pw-a', enabled: true }] });
  fs.writeFileSync(F, orig);
  const origR = JSON.stringify({ 'edge-old': { at: 5, scanned: 3, foundCount: 0, found: [] } });
  fs.writeFileSync(R, origR);
  const out = runChild(dir, [F, R], `
    const A = await import(${JSON.stringify(path.join(SRCDIR, 'central/assignments.js'))});
    out.list = A.listAssignments().length;
    out.err = A.assignmentsLoadError();
    out.add = A.addAssignment({ agent: 'edge-b', ips: '10.1.0.1', username: 'u', password: 'p' });
    out.rep = A.importAssignments([{ agent: 'edge-c', ips: '10.2.0.1', username: 'u', password: 'p' }], 'replace');
    A.setResult('edge-new', { scanned: 1, foundCount: 0, found: [] });
    await new Promise((r) => setTimeout(r, 3_300));   // 결과 디바운스(3초) — 읽기 오류 중에는 쓰지 않는다
    out.resultFileSame = realRead(${JSON.stringify(R)}, 'utf8') === ${JSON.stringify(origR)};
    globalThis.__deny = false; tick(31_000);
    out.listAfter = A.listAssignments().length; out.errAfter = A.assignmentsLoadError();
    const realNow = Date.now; Date.now = () => realNow() + 31_000;   // 결과 파일 재읽기 간격(실제 시계)
    await new Promise((r) => setTimeout(r, 3_300));
    Date.now = realNow;
    out.resultKeys = Object.keys(JSON.parse(realRead(${JSON.stringify(R)}, 'utf8'))).sort();
  `);
  assert.equal(out.list, 0);
  assert.ok(out.err && out.err.readError === true, JSON.stringify(out.err));
  assert.equal(out.add.ok, false); assert.equal(out.add.readError, true);
  assert.equal(out.rep.ok, false, '읽기 오류 중에는 바꾸기(목록 전체)도 원본을 덮지 않는다'); assert.equal(out.rep.readError, true);
  assert.equal(out.listAfter, 1); assert.equal(out.errAfter, null);
  assert.equal(realRead(F, 'utf8'), orig, '배정 원본 그대로');
  assert.deepEqual(corruptFiles(dir, 'agent-assignments.json'), []);
  assert.equal(out.resultFileSame, true, '결과 파일도 읽기 오류 중에는 덮지 않는다');
  assert.deepEqual(out.resultKeys, ['edge-new', 'edge-old'], '읽히면 파일 결과와 합쳐 쓴다');
  assert.deepEqual(corruptFiles(dir, 'agent-results.json'), []);
});

test('87 ⓐ inventory · fleet: 읽기 오류면 원본을 옮기지 않고 저장도 하지 않는다 · 읽히면 합친다(소유 엣지가 다르면 파일 쪽)', () => {
  const dir = tmpDir('rebut87-inv-');
  const I = path.join(dir, 'central-inventory.json');
  const FL = path.join(dir, 'central-fleet.json');
  const at = BASE - 60_000;
  const invOrig = JSON.stringify({ inventory: { 'vc-a': { at, agent: 'edge-a', data: { hosts: [{ id: 'h1' }], vms: [] } }, 'vc-b': { at, agent: 'edge-b', data: { hosts: [], vms: [] } } } });
  const fleetOrig = JSON.stringify({ fleet: { 'edge-a': { at, generatedAt: null, baremetal: [{ fleetId: 'f1', name: 'bm1' }] } } });
  fs.writeFileSync(I, invOrig); fs.writeFileSync(FL, fleetOrig);
  const out = runChild(dir, [I, FL], `
    const inv = await import(${JSON.stringify(path.join(SRCDIR, 'central/inventory.js'))});
    const fleet = await import(${JSON.stringify(path.join(SRCDIR, 'central/fleet.js'))});
    out.blocked = [inv.inventoryReadBlocked(), fleet.fleetReadBlocked()];
    inv.setInventory('vc-b', { vcenter: { id: 'vc-b', status: 'ok' }, hosts: [{ id: 'x' }], vms: [] }, 'edge-evil', null);   // 그동안 TOFU 로 다른 엣지가
    inv.setInventory('vc-c', { vcenter: { id: 'vc-c', status: 'ok' }, hosts: [], vms: [] }, 'edge-c', null);
    out.own = inv.setInventoryOwner('vc-c', 'edge-c2');
    fleet.setEdgeFleet('edge-n', [{ fleetId: 'f9', name: 'bm9' }], null, { verified: true });
    fleet.flushEdgeFleetNow();
    out.invSame = realRead(${JSON.stringify(I)}, 'utf8') === ${JSON.stringify(invOrig)};
    out.fleetSame = realRead(${JSON.stringify(FL)}, 'utf8') === ${JSON.stringify(fleetOrig)};
    globalThis.__deny = false;
    const realNow = Date.now; Date.now = () => realNow() + 31_000;
    out.own2 = inv.setInventoryOwner('vc-c', 'edge-c2');
    fleet.flushEdgeFleetNow();
    Date.now = realNow;
    const fi = JSON.parse(realRead(${JSON.stringify(I)}, 'utf8')).inventory;
    out.invOwners = Object.fromEntries(Object.entries(fi).map(([k, v]) => [k, v.agent]));
    out.fleetAgents = Object.keys(JSON.parse(realRead(${JSON.stringify(FL)}, 'utf8')).fleet).sort();
    out.blockedAfter = [inv.inventoryReadBlocked(), fleet.fleetReadBlocked()];
  `, { CENTRAL_TOKEN: 'tok-87-test', CENTRAL_FLEET_TTL_MS: String(10 * 86_400_000) });
  assert.deepEqual(out.blocked, [true, true]);
  assert.equal(out.own.persisted, false, '소유 지정 즉시 저장도 읽기 오류 중에는 하지 않는다(사유를 돌려준다)');
  assert.equal(out.invSame, true, '인벤토리 원본 그대로');
  assert.equal(out.fleetSame, true, '함대 원본 그대로(종료 flush 포함)');
  assert.equal(out.own2.persisted, true);
  assert.deepEqual(out.invOwners, { 'vc-a': 'edge-a', 'vc-b': 'edge-b', 'vc-c': 'edge-c2' }, '파일에만 있는 것은 되살리고 · 소유가 다르면 파일 쪽(TOFU 가로채기 되돌림)');
  assert.deepEqual(out.fleetAgents, ['edge-a', 'edge-n']);
  assert.deepEqual(out.blockedAfter, [false, false]);
  assert.deepEqual(corruptFiles(dir, 'central-inventory.json'), []);
});

/* ── ⓑ ─────────────────────────────────────────────────────────────── */
test('87 ⓑ: edgePull 이 내는 kind 는 전부 EDGE_PULL_KINDS 안이고(ambiguous 포함) 웹 문구 맵 넷이 그것을 덮는다', async () => {
  const { EDGE_PULL_KINDS } = await import('../src/central/edgePull.js');
  const src = stripComments(realRead(path.join(SRCDIR, 'central/edgePull.js'), 'utf8'));
  const emitted = [...new Set([...src.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]))];
  for (const k of emitted) assert.ok(EDGE_PULL_KINDS.includes(k), `edgePull 이 열거 밖 kind '${k}' 를 낸다`);
  assert.ok(EDGE_PULL_KINDS.includes('ambiguous'));
  for (const [f, re] of [['views/tools/edgeLogText.js', /FETCH_KIND_TEXT/], ['views/tools/isiduText.js', /EDGE_CALL_TEXT/], ['views/tools/focusMonText.js', /WAKE_TEXT/], ['views/collectors/EmptyInvModal.jsx', /FETCH_KIND_TEXT/]]) {
    const w = realRead(path.join(WEBDIR, f), 'utf8');
    assert.match(w, re);
    assert.match(w, /^\s*ambiguous:\s*/m, `${f} 에 ambiguous 문구가 없다`);
  }
});

/* ── ⓒ ─────────────────────────────────────────────────────────────── */
test('87 ⓒ: POST /admin/central-token/generate — portal.env 저장 거절은 400 + 사유(500 아님) · 실행 중 토큰 그대로', async () => {
  const express = (await import('express')).default;
  const { registerCentralTokens } = await import('../src/routes/admin/centralTokens.js');
  const tok = await import('../src/central/token.js');
  const { config } = await import('../src/config.js');
  const router = express.Router();
  registerCentralTokens(router);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'noainred', role: 'admin' }; next(); });
  app.use('/api/admin', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const envFile = tok.centralTokenInfo().envFile;
    fs.writeFileSync(envFile, 'AUTH_SECRET=s87\nCENTRAL_TOKEN=old87\n');
    const before = config.central?.token;
    const res = await denyRead(envFile, () => fetch(`http://127.0.0.1:${srv.address().port}/api/admin/central-token/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) }));
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(body.reason, /읽지 못해 저장하지 않았습니다/);
    assert.equal(config.central?.token, before, '실행 중 토큰은 바뀌지 않는다');
    assert.equal(realRead(envFile, 'utf8'), 'AUTH_SECRET=s87\nCENTRAL_TOKEN=old87\n');
  } finally { await new Promise((r) => srv.close(r)); }
});

/* ── 85회차 반증 · 결정(배포 대상 등록부) ─────────────────────────────── */
async function adminApp(register) {
  const express = (await import('express')).default;
  const router = express.Router();
  register(router);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'noainred', role: 'admin' }; next(); });
  app.use('/api/admin', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}/api/admin`, close: () => new Promise((r) => srv.close(r)) };
}

test('87 R4(85 F1 반증): POST /agent-deploy 는 대상 저장이 거절되면 targetSaved:false + 사유(예전 늘 true)', async () => {
  const { registerDeployLlm } = await import('../src/routes/admin/deployLlm.js');
  const a = await adminApp(registerDeployLlm);
  try {
    // env 블록 주입(개행) — 배포는 시작 전에 거절되고, 대상 저장도 같은 판정으로 거절된다.
    const res = await fetch(`${a.base}/agent-deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: '192.0.2.87', username: 'root', agentName: 'edge87\nAUTH_SECRET=x' }) });
    const body = await res.json();
    assert.equal(body.targetSaved, false, JSON.stringify(body));
    assert.ok(typeof body.targetSaveReason === 'string' && body.targetSaveReason.length > 0);
  } finally { await a.close(); }
});

test('87 ⓐ(85 결정): 배포 대상 등록부 손상 — 표지(GET targets loadError) · 자동 경로 거절 · 관리자 저장이 풀고 · 재시작 뒤 보존본만 남아도 표지', async () => {
  const dir = tmpDir('rebut87-deploy-');
  const F = path.join(dir, 'agent-deploy-targets.json');
  fs.writeFileSync(F, '{broken');
  const out = runChild(dir, [], `
    const R = await import(${JSON.stringify(path.join(SRCDIR, 'agent/deployRegistry.js'))});
    out.le = R.deployTargetsLoadError();
    out.auto = R.saveTarget({ host: '192.0.2.10', username: 'root' }, { auto: true });
    out.rename = R.setTargetAgentName('nope', 'edge-x');
    out.admin = R.saveTarget({ host: '192.0.2.11', username: 'root' });
    out.after = R.deployTargetsLoadError();
  `);
  assert.equal(out.le?.code, 'corrupt'); assert.equal(out.le?.corrupt, true);
  assert.equal(out.auto.ok, false); assert.equal(out.auto.code, 'registry-unreadable');
  assert.equal(out.rename.code, 'registry-unreadable', "손상 동안 '찾을 수 없음' 이 아니다");
  assert.equal(out.admin.ok, true, '관리자 저장은 새 등록부를 만든다(v2.612 규약)');
  assert.equal(out.after, null);
  // 재시작 뒤 — 파일이 없고 보존본만 있으면 여전히 표지
  const dir2 = tmpDir('rebut87-deploy2-');
  fs.writeFileSync(path.join(dir2, 'agent-deploy-targets.json.corrupt.1'), '{x');
  const out2 = runChild(dir2, [], `
    const R = await import(${JSON.stringify(path.join(SRCDIR, 'agent/deployRegistry.js'))});
    out.le = R.deployTargetsLoadError();
  `);
  assert.equal(out2.le?.code, 'corrupt-only');
  // 화면 문구 — 읽기 오류 · 손상은 조치가 다르다
  const W = await import(path.join(WEBDIR, 'views/readFailText.js'));
  assert.match(W.deployTargetsUnreadableText({ code: 'EACCES', readError: true }), /권한 · 소유자/);
  assert.match(W.deployTargetsUnreadableText({ code: 'corrupt', corrupt: true }), /보존본/);
  assert.equal(W.deployTargetsUnreadableText(null), null);
  const src = stripComments(realRead(path.join(SRCDIR, 'routes/admin/deployLlm.js'), 'utf8'));
  assert.match(src, /'\/agent-deploy\/targets', adminOnly, fleetOnly, \(_req, res\) => res\.json\(\{ targets: listTargets\(\), loadError: deployTargetsLoadError\(\) \}\)/);
  const deps = stripComments(realRead(path.join(SRCDIR, 'central/tokenApplyDeps.js'), 'utf8'));
  assert.match(deps, /saveTarget: \(b\) => saveTarget\(b, \{ auto: true \}\)/, '토큰 자동 적용의 배포 기록 맞춤은 자동 경로');
});

/* ── 86회차 반증 · 결정 ─────────────────────────────────────────────── */
test('87 R3(86 F2 반증): 설치 대기(deferred) 표지는 그 엣지가 대상 판을 보고하면 내린다 · 못 읽은 버전이면 그대로', async () => {
  const { mergeAutoPushStatus } = await import('../src/collector/upgradePush.js');
  const lr = { at: BASE, version: '3.19.0', collectorPush: { total: 2, ok: 2, items: [
    { id: 'c1', ok: true, deferred: true, version: '3.19.0', reason: '진행 중 스캔을 기다립니다' },
    { id: 'c2', ok: true, deferred: true, version: '3.19.0', reason: '진행 중 스캔을 기다립니다' },
  ] } };
  const out = mergeAutoPushStatus({ c1: { version: '3.19.0' }, c2: { version: null } }, lr);
  assert.equal(out.c1.upgrade.deferred, undefined, '이미 대상 판 — 설치 대기가 아니다');
  assert.equal(out.c1.upgrade.ok, true); assert.equal(out.c1.upgrade.reason, '');
  assert.equal(out.c2.upgrade.deferred, true, '못 읽은 버전은 설치됐다고 보지 않는다');
});

test('87 ⓒ(86 결정): 수집 서버 화면 마지막 자동 업그레이드 — 이미 최신은 실패로 세지 않는다', async () => {
  const src = stripComments(realRead(path.join(SRCDIR, 'routes/admin/collectorsDc.js'), 'utf8'));
  assert.match(src, /i\.ok !== true && i\.upToDate === true/);
  const W = await import(path.join(WEBDIR, 'views/collectorUpgradeText.js'));
  const r = W.autoPushLine({ at: BASE, total: 3, ok: 1, upToDate: 2 });
  assert.equal(r.tone, 'ok'); assert.match(r.text, /3\/3 모두 받았습니다\(이미 최신 2\)/);
  const r2 = W.autoPushLine({ at: BASE, total: 3, ok: 1, upToDate: 1 });
  assert.match(r2.text, /2\/3 성공\(이미 최신 1\)/); assert.equal(r2.tone, 'warn');
  const r3 = W.autoPushLine({ at: BASE, total: 2, ok: 2, deferred: 1 });
  assert.match(r3.text, /설치 대기 1/); assert.equal(r3.tone, 'warn');
  // 예전 문구 그대로(표지가 없으면)
  assert.match(W.autoPushLine({ at: BASE, total: 5, ok: 3 }).text, /3\/5 성공 — 실패한 서버는/);
});

test('87 ⓑ(86 결정): 설치하고 재시작했는데 여전히 옛 판이면 자동 적용을 멈춘다(같은 판 재설치 고리) · 설치 경로 ≠ 실행 경로 경고', async () => {
  const M = await import('../src/upgrade/manager.js');
  const auto = { trigger: 'auto', ok: true, restarting: true, version: '3.20.0' };
  assert.equal(M.stuckApply(auto, { current: '3.19.0', latest: '3.20.0', installDir: '/opt/a' }), '3.20.0', '설치했는데 옛 판 — 고리');
  assert.equal(M.stuckApply(auto, { current: '3.20.0', latest: '3.20.0' }), null, '새 판으로 올라왔다');
  assert.equal(M.stuckApply(auto, { current: '3.19.0', latest: '3.21.0' }), null, '더 새 판은 한 번 시도');
  assert.equal(M.stuckApply({ ...auto, trigger: 'manual' }, { current: '3.19.0', latest: '3.20.0' }), null);
  assert.equal(M.stuckApply({ ...auto, version: null }, { current: '3.19.0', latest: '3.20.0' }), null, '못 읽은 판은 고리로 보지 않는다');
  const stuck = { trigger: 'auto', ok: false, code: 'apply-stuck', target: '3.20.0', installDir: '/opt/a' };
  assert.equal(M.stuckApply(stuck, { current: '3.19.0', latest: '3.20.0', installDir: '/opt/a' }), '3.20.0', '멈춘 기록은 다음 주기에도 멈춘다');
  assert.equal(M.stuckApply(stuck, { current: '3.19.0', latest: '3.20.0', installDir: '/opt/b' }), null, '설치 경로를 바꾸면 다시 시도');
  // 실경로 비교 — 심볼릭 링크 설치는 같은 곳
  const d = tmpDir('rebut87-inst-');
  fs.mkdirSync(path.join(d, 'real')); fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
  assert.equal(M.installDirMismatch(path.join(d, 'link'), path.join(d, 'real')), null);
  const mm = M.installDirMismatch(path.join(d, 'real'), path.join(d, 'other'));
  assert.ok(mm && mm.installDir.endsWith('real'));
  // 판정 → 상태 사유(웹 AUTO_TEXT 와 1:1)
  const A = await import('../src/upgrade/autoState.js');
  const st = A.autoUpgradeState({ settings: { enabled: true, autoApply: true, installDir: '/opt/a', remoteBase: 'https://x.invalid' }, intervalMs: 60_000, installDirMismatch: { installDir: '/opt/a', appRoot: '/opt/b' }, now: BASE });
  assert.ok(st.issues.some((i) => i.code === 'install-dir-mismatch' && /\/opt\/b/.test(i.reason)));
  assert.ok(A.AUTO_CODES.includes('install-dir-mismatch'));
  // 기록은 재시작을 넘는다(installDir · code · target)
  const s = A.sanitizeResult({ at: BASE, ...stuck, reason: 'x' });
  assert.equal(s.code, 'apply-stuck'); assert.equal(s.target, '3.20.0'); assert.equal(s.installDir, '/opt/a');
});

test('87 ⓑ(86 결정): tick — 직전 자동 적용(설치 + 재시작)의 판이 지금 판보다 높으면 다시 설치하지 않고 사유를 남긴다', async () => {
  const dir = tmpDir('rebut87-tick-');
  const out = runChild(dir, [], `
    const C = await import(${JSON.stringify(path.join(SRCDIR, 'config.js'))});
    const M = await import(${JSON.stringify(path.join(SRCDIR, 'upgrade/manager.js'))});
    const m = M.upgradeManager;
    const cur = C.currentVersion();
    const [a, b, c] = cur.split('.').map(Number); const next = a + '.' + b + '.' + (c + 1);
    m.settings = { ...m.settings, enabled: true, autoApply: true, installDir: ${JSON.stringify(dir)}, remoteBase: 'https://upgrade.invalid', pollIntervalMs: 0 };
    m.lastResult = { at: ${BASE}, source: 'auto', trigger: 'auto', ok: true, restarting: true, version: next };
    let applied = 0; m.apply = async () => { applied += 1; return { ok: true }; };
    m.check = async () => ({ remote: { ok: true, available: true, latest: next } });
    await m.tick();
    await m.tick();
    out.applied = applied; out.tick = m.lastTick; out.code = m.lastResult?.code; out.reason = m.lastResult?.reason || '';
    out.issue = m.status().auto.issues.map((i) => i.code);
  `);
  assert.equal(out.applied, 0, '같은 판을 다시 설치하지 않는다');
  assert.equal(out.tick.outcome, 'apply-failed');
  assert.equal(out.code, 'apply-stuck');
  assert.match(out.reason, /설치하고 재시작했는데 여전히/);
  assert.ok(out.issue.includes('apply-failed'), JSON.stringify(out.issue));
  assert.ok(out.issue.includes('install-dir-mismatch'), '임시 설치 경로 ≠ 실행 중 앱 경로');
});

/* ── ⓓ(85 E3) ───────────────────────────────────────────────────────── */
test('87 ⓓ(85 E3): 옛 워커 · pull 의 중앙 응답 읽기는 상한 읽기(readJsonCapped) — 바꾼 파일에 상한 없는 .json() 이 남지 않는다', () => {
  const files = ['curUserConfigPull', 'gpuGuestConfigPull', 'partFaultConfigPull', 'pduConfigPull', 'sanSwitchConfigPull', 'storageConfigPull', 'usersConfigPull', 'svcmonConfigPull', 'idracScanWorker', 'ipScanWorker', 'logQueryWorker', 'pingWorker', 'captureWorker', 'bmstorWorker', 'scanner'];
  const left = [];
  for (const f of files) {
    const s = stripComments(realRead(path.join(SRCDIR, `agent/${f}.js`), 'utf8'));
    if (/\b(?:res|r|aRes)\.json\(\)/.test(s)) left.push(f);
    assert.match(s, /from '\.\.\/util\/readCapped\.js'/, f);
  }
  assert.deepEqual(left, []);
});
