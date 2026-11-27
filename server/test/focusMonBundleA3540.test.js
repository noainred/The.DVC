/**
 * v3.54.0 — 서버 집중 모니터링 자동 설치 · 접속 준비 보강(사용자 "모두 넣어서 구현해줘" — 11-20 남은 일 목록의 ④ ⑤ ⑥ ⑧).
 *
 *  ④ 엣지가 받은 root 작업의 대상 확인(v3.17.0 S4) — 맡은 서버 목록(같은 id · 주소 · 포트 · 계정)에 있어야 · 법인 공통 계정은 엣지가 아는 서버(그 엣지 vCenter VM IP ·
 *     SSH 공용 접속 서버)에만('not-local') · 중앙은 root 작업을 싣는 응답에 늘 목록(계정 포함)
 *  ⑤ 같은 서버 판정(sameMachine) — 주소 + 같은 노드의 인벤토리 같은 VM · 호스트 이름(hello) · 이름 — 다른 노드 · 흔한 기본 이름은 아님
 *  ⑥ 설치 · 준비 'lost' 는 그 카드의 마지막 결과 칸(lastInstall · lastPrep)에 — 디스크 점검 카드의 오류 칸(lastError)이 아니다 · 늦은 결과가 덮는다 · 재시작
 *  ⑧ sudo 판정은 sudo 에게(셸 · su · env 허용 = root 와 같다 · requiretty 면 가짜 터미널 · 그래도 모르면 넣지 않음) · 원격 시한(timeout — 124 → 'timeout')
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('focusmon3540-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SETTINGS_OWNERS = 'own';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-3540-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [{ username: 'own', role: 'admin' }] }));

const M = await import('../src/focusmon/audit/sameMachine.js');
const A = await import('../src/focusmon/audit/service.js');
const C = await import('../src/focusmon/audit/installCred.js');
const B = await import('../src/focusmon/audit/bundle.js');
const I = await import('../src/focusmon/audit/install.js');
const PR = await import('../src/focusmon/audit/prep.js');
const SET = await import('../src/focusmon/audit/settings.js');
const Wk = await import('../src/agent/focusMonWorker.js');
const WP = await import('../../web/src/views/tools/focusMonPrepText.js');
const WI = await import('../../web/src/views/tools/focusMonAuditInstallText.js');

const tg = (id, host, o = {}) => ({ id, name: o.name || id, host, port: 22, username: o.username || 'dvcmon', agent: o.agent || '', ...o });

/* ── ⑤ 같은 서버 ── */
test('⑤ sameMachine — 주소(전 노드) · 같은 노드의 같은 VM · 호스트 이름 · 이름 · 다른 노드 · 기본 이름', () => {
  assert.equal(M.addrKey('10.1.0.5'), '10.1.0.5'); assert.equal(M.addrKey(' 010.1.0.5 '), '10.1.0.5', '넓게 잡는 쪽(같은 서버 판정)');
  assert.equal(M.nameKey('DB01.Corp.local.'), 'db01.corp.local'); assert.equal(M.nameKey('localhost.localdomain'), null); assert.equal(M.nameKey('10.0.0.1'), null);
  assert.equal(M.nameKey('server.corp.com'), null, '흔한 기본 이름(첫 마디)'); assert.equal(M.nameKey('a b'), null); assert.equal(M.nameKey('x'.repeat(300)), null);
  const vms = [{ id: 'vm-1', vcenterId: 'vcA', ipAddresses: ['10.1.0.5', '10.2.0.5'] }, { id: 'vm-2', vcenterId: 'vcB', ipAddress: '10.3.0.9' }];
  const targets = [
    tg('fm-a1', '10.1.0.5', { agent: 'edge-a', name: 'db01' }), tg('fm-a2', '10.2.0.5', { agent: 'edge-a', username: 'other', name: 'db01-svc' }), // 같은 VM 의 두 IP
    tg('fm-b1', '10.2.0.5', { agent: 'edge-b', username: 'x' }), // 같은 주소 — 다른 노드라도 예전처럼 같다(글자 비교)
    tg('fm-c1', '10.9.0.1', { agent: 'edge-a', name: 'app7' }), tg('fm-c2', '10.9.0.2', { agent: 'edge-a', name: 'app7-mgmt' }), // hello 호스트 이름 같음
    tg('fm-d1', '10.9.1.1', { agent: 'edge-a', name: 'web3' }), tg('fm-d2', '10.9.1.2', { agent: 'edge-a', name: 'web3.corp.local' }), // 이름 ↔ hello
    tg('fm-e1', '10.9.2.1', { agent: 'edge-c', name: 'app7' }), // 다른 노드의 같은 이름 — 아님
    tg('fm-f1', '10.9.3.1', { agent: 'edge-a' }), tg('fm-f2', '10.9.3.2', { agent: 'edge-a' }), // 둘 다 localhost — 아님
  ];
  const hello = { 'fm-c1': { hostname: 'app7.corp.local' }, 'fm-c2': { hostname: 'APP7' }, 'fm-d2': { hostname: 'web3' }, 'fm-e1': { hostname: 'app7' }, 'fm-f1': { hostname: 'localhost.localdomain' }, 'fm-f2': { hostname: 'localhost' } };
  const mx = M.machineIndex(targets, { vms, helloOf: (id) => hello[id] || null });
  const peers = (id) => mx.peersOf(id).map((p) => `${p.id}:${p.basis}`).sort();
  assert.deepEqual(peers('fm-a1'), ['fm-a2:vm'], '같은 노드의 같은 VM(다른 IP)');
  assert.deepEqual(peers('fm-a2'), ['fm-a1:vm', 'fm-b1:addr']);
  assert.deepEqual(peers('fm-b1'), ['fm-a2:addr'], '다른 노드의 VM 근거는 쓰지 않는다(법인마다 사설 대역이 겹친다)');
  assert.deepEqual(peers('fm-c1'), ['fm-c2:hostname']);
  assert.deepEqual(peers('fm-d1'), ['fm-d2:name'], '표시 이름이 다른 항목의 호스트 이름과 같다');
  assert.deepEqual(peers('fm-e1'), [], '다른 노드의 같은 호스트 이름은 같은 서버로 보지 않는다');
  assert.deepEqual(peers('fm-f1'), [], '기본 호스트 이름은 근거가 아니다');
  assert.deepEqual(mx.peersOf('fm-none'), []);
  // 첫 마디만 같은 서로 다른 FQDN 은 같은 서버가 아니다(sameHostName — 둘 다 FQDN 이면 전부 같아야) · 이름 근거도 같다
  const fq = [tg('fm-g1', '10.9.4.1', { agent: 'edge-a', name: 'app9.corp-a.local' }), tg('fm-g2', '10.9.4.2', { agent: 'edge-a', name: 'x1' }), tg('fm-g3', '10.9.4.3', { agent: 'edge-a', name: 'x2' })];
  const fx = M.machineIndex(fq, { helloOf: (id) => ({ 'fm-g2': { hostname: 'app9.corp-b.local' }, 'fm-g3': { hostname: 'app9.corp-c.local' } })[id] || null });
  assert.deepEqual(fx.peersOf('fm-g2'), [], 'hello FQDN 끼리 첫 마디만 같음'); assert.deepEqual(fx.peersOf('fm-g1'), [], '표시 이름 FQDN ↔ hello FQDN 첫 마디만 같음');
  // 색인 없이는 예전처럼 주소 글자만
  assert.deepEqual(M.sameMachinePeers(targets[1], targets).map((p) => p.id), ['fm-b1']);
  assert.deepEqual(M.sameMachinePeers(targets[0], targets, mx).map((p) => [p.id, p.basis]), [['fm-a2', 'vm']]);
  // 웹 근거 문구 1:1
  assert.deepEqual(Object.keys(WP.BASIS_TEXT).sort(), [...M.BASIS].sort());
  assert.equal(WP.sharedWhy([{ basis: 'addr' }]), '같은 주소에 다른 수집 계정 — 손으로 설치', '주소뿐이면 예전 문구');
  assert.match(WP.sharedWhy([{ basis: 'vm', name: 'db01' }]), /인벤토리의 같은 VM — db01/);
});

test('⑤ 접수 — 다른 IP 로 등록한 같은 서버도 host-shared · host-busy · 준비는 하되 디스크 점검은 함께 하지 않음', () => {
  A._resetForTest(); SET._resetForTest(); assert.equal(SET.saveInstallDir('', { by: 'own' }).ok, true);
  const vms = [{ id: 'vm-9', vcenterId: 'vcA', ipAddresses: ['10.5.0.1', '10.5.0.2'] }];
  const t1 = tg('fm-pppp000001', '10.5.0.1', { demo: true, name: 'db9' }); const t2 = tg('fm-pppp000002', '10.5.0.2', { demo: true, username: 'mon2', name: 'db9-b' });
  const everyone = [t1, t2];
  const mx = M.machineIndex(everyone, { vms });
  const r = A.requestInstall(t1, { by: 'own', peers: everyone, machine: mx });
  assert.equal(r.code, 'host-shared'); assert.deepEqual(r.sharedWith, [{ id: t2.id, name: 'db9-b', basis: 'vm' }]); assert.match(r.reason, /db9-b\(인벤토리의 같은 VM\)/);
  const ok = A.requestInstall(t1, { by: 'own', peers: everyone, keys: { keyInfo: () => ({ usable: false }) } }); // 중앙 직접(데모) — 라우트처럼 키 저장소를 같이 준다
  assert.equal(ok.ok, true, `색인이 없으면 예전 판정(글자) — 다른 주소라 통과(이 경로는 시험만) ${JSON.stringify(ok)}`);
  A._resetForTest();
  const p = A.requestPrep(t1, { by: 'own', peers: everyone, machine: mx, withAudit: true, keys: { keyInfo: () => ({ usable: false }) } });
  assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.audit, false); assert.equal(p.auditWhy, 'host-shared');
  assert.equal(A.requestPrep(t2, { by: 'own', peers: everyone, machine: mx }).code, 'host-busy', '같은 서버 준비 · 설치는 겹치지 않는다');
});

/* ── ④ 엣지 대상 확인 ── */
test('④ localHostIndex — 엣지 vCenter VM IP · 이 노드가 맡은 SSH 공용 접속 서버 · 정규 IPv4 만', () => {
  const has = M.localHostIndex({ vms: [{ id: 'v', ipAddresses: ['10.7.0.1', '010.7.0.2', 'fe80::1'] }, { id: 'w', ipAddress: '10.7.0.3' }],
    servers: [{ host: '10.7.1.1', agent: '' }, { host: '10.7.1.2', agent: 'edge-x' }, { host: 'db.corp', agent: '' }] });
  assert.equal(has('10.7.0.1'), true); assert.equal(has('10.7.0.3'), true); assert.equal(has('10.7.1.1'), true);
  assert.equal(has('10.7.0.2'), false, '비정규 표기는 같은 주소로 보지 않는다(좁게)'); assert.equal(has('010.7.0.2'), false);
  assert.equal(has('10.7.1.2'), false, '다른 노드가 맡은 서버 항목은 아니다'); assert.equal(has('10.9.9.9'), false); assert.equal(has(''), false);
  assert.equal(M.localHostIndex()('10.0.0.1'), false, '못 읽으면 빈 색인(닫힘)');
});

test('④ 엣지 워커 — root 작업은 맡은 서버 목록과 같은 접속처일 때만 · 공통 계정은 엣지가 아는 서버에만 · 목록 상한 대조', () => {
  const list = [{ id: 'fm-1', host: '10.1.0.1', port: 22, username: 'dvcmon' }, { id: 'fm-2', host: '10.1.0.2', port: 2222, username: null }];
  assert.equal(Wk.jobTargetKnown({ id: 'fm-1', host: '10.1.0.1', port: 22, username: 'dvcmon' }, list), true);
  assert.equal(Wk.jobTargetKnown({ id: 'fm-1', host: '10.66.6.6', port: 22, username: 'dvcmon' }, list), false, '주소가 다르면');
  assert.equal(Wk.jobTargetKnown({ id: 'fm-1', host: '10.1.0.1', port: 2200, username: 'dvcmon' }, list), false, '포트가 다르면');
  assert.equal(Wk.jobTargetKnown({ id: 'fm-1', host: '10.1.0.1', port: 22, username: 'root' }, list), false, '계정이 다르면');
  assert.equal(Wk.jobTargetKnown({ id: 'fm-2', host: '10.1.0.2', port: 2222, username: 'any' }, list), true, '옛 중앙(계정 칸 없음) — 계정은 보지 않는다');
  assert.equal(Wk.jobTargetKnown({ id: 'fm-9', host: '10.1.0.9', port: 22, username: 'x' }, list), false, '목록에 없으면');
  assert.equal(Wk.jobTargetKnown({ id: 'fm-1', host: '10.1.0.1', port: 22, username: 'dvcmon' }, []), false, '목록이 비었으면(엣지 재시작 직후) 돌리지 않는다');
  assert.equal(Wk.KNOWN_MAX, A.KNOWN_MAX, '엣지 · 중앙 목록 상한이 같다');
  const src = fs.readFileSync(new URL('../src/agent/focusMonWorker.js', import.meta.url), 'utf8');
  assert.match(src, /if \(\(j\.mode === 'install' \|\| j\.mode === 'prep'\) && !jobTargetKnown\(tgt\)\) \{\n\s+queueAuditResult\(j\.runId,/, '맡지 않은 대상의 root 작업은 돌리지 않고 결과로 알린다');
  assert.match(src, /\{ code: 'not-mine', step: 0 \}/);
  assert.match(src, /username: typeof t\.username === 'string' \? t\.username : null/, '목록의 계정 칸(옛 중앙은 null)');
  // credReport 는 엣지가 아는 서버 색인을 한 번 만들어 넘긴다
  Wk._setKnownForTest([{ id: 'fm-pppppppp81', name: 'x', host: '10.48.8.1', port: 22 }]);
  const seen = [];
  Wk.credReport(Date.now(), (t, o) => { seen.push(o); return { state: 'ok' }; });
  assert.equal(seen.length, 2); assert.equal(typeof seen[0].local, 'function'); assert.equal(seen[0].local, seen[1].local, '한 번만 만든다');
  assert.equal(seen[0].local('10.48.8.1'), false, '이 시험 노드의 스냅샷 · 등록부에는 없는 주소');
});

test('④ installCred — 엣지 공통 계정은 엣지가 아는 서버에만 · 서버 항목(같은 주소)은 그대로 · 중앙은 보지 않음', async () => {
  const F = await import('./_sshKeyFixtures.js');
  const VAULT = await import('../src/security/secretVault.js'); VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const k = KS.addKey({ name: 'pl-root-3540', privateKey: F.ed25519Key().pem, folderCorp: 'vcP', features: [C.PREP_FEATURE, C.INSTALL_FEATURE] }, { by: 'own' }).key;
  KS.saveAccount({ name: 'pl-root-3540', kind: 'os', corp: 'vcP', username: 'root', keyRef: k.id }, { by: 'own' });
  const t = tg('fm-pppppppp91', '10.48.9.1');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcP'] }).state, 'ok', '중앙은 대상을 정하는 쪽 — 보지 않는다');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcP'], edge: true }).state, 'not-local', 'local 이 없으면 닫힌다');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcP'], edge: true, local: () => false }).state, 'not-local');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcP'], edge: true, local: (h) => h === '10.48.9.1' }).state, 'ok');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcP'], edge: true, local: () => 'yes' }).state, 'not-local', '참(true)만');
  assert.ok(C.CRED_STATES.includes('not-local'));
  assert.equal(A.cleanEdgeCred({ state: 'not-local', src: 'corp' }).state, 'not-local', '중앙 정제가 받는다');
  // 웹 글 1:1(설치 · 준비 두 표)
  for (const s of C.CRED_STATES) { assert.ok(WI.CRED_TEXT[s], `설치 ${s}`); assert.ok(WP.PREP_CRED_TEXT[s], `준비 ${s}`); }
  // installOnce · prepOnce 가 엣지의 색인을 계정 해석에 넘긴다(expect.edgeLocal — 중앙이 보낸 값이 아니다)
  const seen = [];
  const credSpy = (tt, o) => { seen.push(o); return { state: 'not-local' }; };
  const edgeLocal = () => (h) => h === 'x';
  const ri = await I.installOnce(tg('fm-q1', '10.1.0.1'), { keys: {}, credOf: credSpy, expect: { dir: '', edge: true, edgeVcs: () => ['vcP'], edgeLocal } });
  assert.equal(ri.install.code, 'cred'); assert.equal(ri.install.cred, 'not-local'); assert.equal(typeof seen[0].local, 'function');
  await I.installOnce(tg('fm-q1', '10.1.0.1'), { keys: {}, credOf: credSpy, expect: { dir: '', corpVcs: ['vcP'] } });
  assert.equal(seen[1].local, null, '중앙 설치는 색인 없음');
  const KEYS = { keyInfo: () => ({ usable: true, fingerprint: 'SHA256:f', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMAk2Lxi5YNyB4sH7jV4nJGJiWlU4HAy6+YojtTxQLC3 n' }) };
  const rp = await PR.prepOnce(tg('fm-q2', '10.1.0.2'), { keys: KEYS, credOf: credSpy, expect: { edge: true, edgeVcs: () => [], edgeLocal } });
  assert.equal(rp.prep.code, 'cred'); assert.equal(rp.prep.cred, 'not-local'); assert.equal(typeof seen[2].local, 'function');
});

test('④ 중앙 — root 작업을 싣는 응답에는 늘 맡은 서버 목록(계정 포함) · 엣지 거절(not-mine) 반영', async () => {
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const te = tg('fm-eeee354001', '10.48.0.1', { agent: 'edge-pl' }); const mine = new Map([[te.id, te]]);
  const t0 = Date.now();
  const first = A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: { [te.id]: { state: 'ok' } }, credPrep: { [te.id]: { state: 'ok', acct: 'root' } } }, t0);
  assert.equal(first.known[0].username, 'dvcmon');
  const quiet = A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'] }, t0 + 1000);
  assert.equal(quiet.known, undefined, 'root 작업이 없으면 60초에 한 번');
  const r = A.requestPrep(te, { by: 'own', now: t0 + 1500 }); assert.equal(r.ok, true, JSON.stringify(r));
  const out = A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: { [te.id]: { state: 'ok' } }, credPrep: { [te.id]: { state: 'ok', acct: 'root' } } }, t0 + 2000);
  assert.equal(out.jobs.length, 1); assert.ok(Array.isArray(out.known) && out.known[0].id === te.id, '60초 안이라도 root 작업과 함께 싣는다');
  // 엣지가 거절(not-mine) — 정제 · 반영
  assert.equal(A.cleanEdgeResult({ mode: 'prep', prep: { code: 'not-mine' } }).prep.code, 'not-mine');
  assert.equal(A.cleanEdgeResult({ mode: 'install', install: { code: 'not-mine' } }).install.code, 'not-mine');
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], results: [{ runId: r.runId, result: { mode: 'prep', ok: false, kind: 'not-ready', prep: { code: 'not-mine', step: 0 } } }] }, t0 + 3000);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(A.readinessOf(te.id).lastPrep.code, 'not-mine');
  for (const c of PR.PREP_CODES) assert.ok(WP.PREP_CODE_TEXT[c], `준비 결과 문구 ${c}`);
  for (const c of I.INSTALL_CODES) assert.ok(WI.INSTALL_CODE_TEXT[c], `설치 결과 문구 ${c}`);
});

/* ── ⑥ lost ── */
test('⑥ 설치 · 준비 lost 는 그 카드의 마지막 결과 칸에 — 디스크 점검 오류 칸이 아니다 · 늦은 결과가 덮는다', async () => {
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const tp = tg('fm-llll354001', '10.48.1.1', { agent: 'edge-pl' }); const ti = tg('fm-llll354002', '10.48.1.2', { agent: 'edge-pl' }); const tr = tg('fm-llll354003', '10.48.1.3', { agent: 'edge-pl' });
  const mine = new Map([[tp.id, tp], [ti.id, ti], [tr.id, tr]]);
  const t0 = Date.now();
  const rows = Object.fromEntries([tp, ti, tr].map((t) => [t.id, { state: 'ok' }]));
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: rows, credPrep: rows }, t0);
  const rp = A.requestPrep(tp, { by: 'own', withAudit: true, now: t0 }); const ri = A.requestInstall(ti, { by: 'own', now: t0 });
  assert.equal(rp.ok && ri.ok, true);
  // 받아 가지 않음(엣지가 동기화하지 않음) → undelivered
  A.sweep(t0 + A.DELIVER_TTL_MS + 60_000);
  let rec = A.readinessOf(tp.id);
  assert.equal(rec.lastPrep.code, 'lost'); assert.equal(rec.lastPrep.why, 'undelivered'); assert.equal(rec.lastPrep.node, 'edge-pl'); assert.equal(rec.lastPrep.audit, 'unknown');
  assert.equal(rec.lastError, undefined, '디스크 점검 카드의 오류 칸에 적지 않는다');
  rec = A.readinessOf(ti.id); assert.equal(rec.lastInstall.code, 'lost'); assert.equal(rec.lastInstall.why, 'undelivered'); assert.equal(rec.lastError, undefined);
  // 배달은 됐는데 결과가 없음 → no-result · 늦은 결과(lost 기억 안)가 덮는다
  const t1 = t0 + 10 * 3600_000;
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: rows, credPrep: rows }, t1);
  const r3 = A.requestPrep(tr, { by: 'own', now: t1 }); assert.equal(r3.ok, true);
  assert.equal(A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: rows, credPrep: rows }, t1 + 1000).jobs.length, 1);
  A.sweep(t1 + A.SEEN_TTL_MS + 120_000);
  assert.equal(A.readinessOf(tr.id).lastPrep.why, 'no-result');
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], results: [{ runId: r3.runId, result: { mode: 'prep', ok: true, kind: 'done', ready: [], prep: { code: 'login', step: 6, added: true }, login: { ok: false, kind: 'auth' } } }] }, t1 + A.SEEN_TTL_MS + 180_000);
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(A.readinessOf(tr.id).lastPrep.code, 'login', '늦은 결과가 lost 를 덮는다');
  // 웹 — 까닭 문구 1:1 · 표시
  assert.deepEqual(Object.keys(WP.LOST_WHY_TEXT).sort(), [...A.LOST_WHY].sort()); assert.deepEqual(Object.keys(WI.INSTALL_LOST_TEXT).sort(), [...A.LOST_WHY].sort());
  const lt = WP.prepResultText({ code: 'lost', why: 'undelivered', node: 'edge-pl', audit: 'unknown' });
  assert.equal(lt.tone, 'warn'); assert.equal(lt.label, '결과를 받지 못함'); assert.match(lt.sub, /받아 가지 않았습니다/); assert.match(lt.sub, /맡은 노드 edge-pl/); assert.match(lt.sub, /디스크 점검: 결과를 모름/);
  const li = WI.installResultText({ code: 'lost', why: 'restart' }); assert.equal(li.tone, 'warn'); assert.match(li.sub, /다시 시작돼/);
});

test('⑥ 재시작 — 앞 프로세스의 중앙 설치 · 준비 작업은 그 카드에 restart', async () => {
  A._resetForTest();
  const st = { v: 1, ready: {}, lost: {}, jobs: [
    { runId: 'da-aaaaaaaaaaaa', tid: 'fm-rrrr354001', mode: 'prep', node: '', by: 'own', requestedAt: Date.now() - 1000, state: 'running', audit: false },
    { runId: 'da-bbbbbbbbbbbb', tid: 'fm-rrrr354002', mode: 'install', node: '', by: 'own', requestedAt: Date.now() - 1000, state: 'running', dir: '' },
    { runId: 'da-cccccccccccc', tid: 'fm-rrrr354003', mode: 'run', node: '', by: 'own', requestedAt: Date.now() - 1000, state: 'running' }] };
  fs.writeFileSync(path.join(DIR, 'focusmon-audit.json'), JSON.stringify(st));
  A._resetForTest();
  assert.equal(A.readinessOf('fm-rrrr354001').lastPrep.why, 'restart'); assert.equal(A.readinessOf('fm-rrrr354001').lastError, undefined);
  assert.equal(A.readinessOf('fm-rrrr354002').lastInstall.why, 'restart');
  assert.equal(A.readinessOf('fm-rrrr354003').lastError.kind, 'lost', '점검 실행은 예전처럼 오류 칸');
  fs.rmSync(path.join(DIR, 'focusmon-audit.json'), { force: true }); A._resetForTest();
});

/* ── ⑧ sudo 판정(준비 파일을 셸로) ── */
function sandbox() {
  const root = tmpDir('fm3540sb-');
  const bin = path.join(root, 'bin'); const homes = path.join(root, 'home'); fs.mkdirSync(bin); fs.mkdirSync(homes); fs.mkdirSync(path.join(homes, 'mon5'));
  const pw = path.join(root, 'passwd'); fs.writeFileSync(pw, `mon5:x:905:905::${homes}/mon5:/bin/bash\n`);
  const log = path.join(root, 'log'); fs.writeFileSync(log, '');
  const w = (n, body) => { fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, n), 0o755); };
  w('sshd', "printf 'pubkeyauthentication yes\\nauthorizedkeysfile .ssh/authorized_keys\\n'");
  w('getent', `grep "^$2:" '${pw}' || exit 2`);
  w('runuser', `echo "runuser $1 $2" >> '${log}'; shift 3; exec "$@"`);
  w('id', 'if [ "$1" = "-Gn" ]; then echo mon5; else echo 0; fi');
  // 실제 sudo 와 같은 꼴(이 개발 환경 sudo 1.9.15 로 확인): -l -U A <명령> 은 허용이면 경로를 찍고 0 · 아니면 아무것도 없이 1 · requiretty 면 터미널이 없을 때 오류 글 · 1
  w('sudo', `if [ -f '${root}/tty' ] && [ -z "\${FAKE_TTY:-}" ]; then echo 'sudo: sorry, you must have a tty to run sudo' >&2; exit 1; fi
if [ "$#" -ge 5 ]; then if grep -qxF -- "$5" '${root}/allow' 2>/dev/null; then echo "$5"; exit 0; fi; exit 1; fi
cat '${root}/list' 2>/dev/null`);
  return { root, bin, homes, log, w };
}
const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMAk2Lxi5YNyB4sH7jV4nJGJiWlU4HAy6+YojtTxQLC3 dvc-focusmon@n';
function runPrep(sb) {
  const s = PR.prepScript(PR.keyLineFor(PUB), { conn: { caddr: '10.48.0.5', laddr: '10.1.0.1', lport: 22 } }).replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH', `PATH=${sb.bin}:/usr/bin:/bin; export PATH`);
  const f = path.join(sb.root, 'prep.sh'); fs.writeFileSync(f, s);
  const r = spawnSync('/bin/sh', [f, 'mon5'], { encoding: 'utf8', env: { PATH: `${sb.bin}:/usr/bin:/bin`, DVC_FM_TO: '1' } });
  return { p: PR.parsePrepOut(r.stdout), out: r.stdout, log: fs.readFileSync(sb.log, 'utf8') };
}
test('⑧ sudo 판정은 sudo 에게 — 셸만 준 줄(별칭) · requiretty(가짜 터미널) · 그래도 모르면 넣지 않음 · 좁은 허용은 넣음', () => {
  const real = (sb) => sb.w('script', 'FAKE_TTY=1; export FAKE_TTY; exec /bin/sh -c "$2"');
  // 좁은 허용(디스크 점검 실행 파일 하나) — 넣는다 · 계정 줄(E)을 덮지 않아 홈을 찾는다(v3.54.0 시험이 잡은 결함)
  let sb = sandbox(); real(sb); fs.writeFileSync(path.join(sb.root, 'list'), '    (root) NOPASSWD: /usr/local/sbin/dvc-disk-audit ""\n');
  let r = runPrep(sb); assert.equal(r.p.ok, true, r.out); assert.equal(r.p.exists, true); assert.equal(r.p.added, true);
  // 셸만 준 줄(Cmnd_Alias SHELLS = /bin/sh, /bin/bash) — 목록 글에는 'ALL' 이 없다
  sb = sandbox(); real(sb); fs.writeFileSync(path.join(sb.root, 'list'), '    (root) NOPASSWD: /bin/sh, /bin/bash\n'); fs.writeFileSync(path.join(sb.root, 'allow'), '/bin/sh\n/bin/bash\n');
  r = runPrep(sb); assert.equal(r.p.fail, 'acct-sudo'); assert.doesNotMatch(r.log, /runuser/, '아무것도 넣지 않는다');
  // su · env 도 root 와 같다
  const su = spawnSync('/bin/sh', ['-c', 'command -v env'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout.trim();
  if (su) { sb = sandbox(); real(sb); fs.writeFileSync(path.join(sb.root, 'allow'), `${su}\n`); assert.equal(runPrep(sb).p.fail, 'acct-sudo', 'env 허용'); }
  // requiretty(전역) — tty 없는 root 의 sudo -l 이 실패한다 → 가짜 터미널로 다시 물어 ALL 을 찾는다(예전 판은 이 경우 넣었다)
  sb = sandbox(); real(sb); fs.writeFileSync(path.join(sb.root, 'tty'), ''); fs.writeFileSync(path.join(sb.root, 'allow'), '/bin/sh\n');
  r = runPrep(sb); assert.equal(r.p.fail, 'acct-sudo', r.out);
  // requiretty + 터미널에서도 허용 안 됨 → 넣는다
  sb = sandbox(); real(sb); fs.writeFileSync(path.join(sb.root, 'tty'), '');
  r = runPrep(sb); assert.equal(r.p.ok, true, r.out);
  // requiretty + script 가 없다(또는 실패) → 모름 → 넣지 않는다
  sb = sandbox(); sb.w('script', 'exit 1'); fs.writeFileSync(path.join(sb.root, 'tty'), '');
  r = runPrep(sb); assert.equal(r.p.fail, 'acct-sudo-unknown', r.out); assert.doesNotMatch(r.log, /runuser/);
  // 터미널에서 다른 오류(표지는 있으나 오류 글이 섞임) → 모름
  sb = sandbox(); sb.w('script', 'echo "sudo: unable to resolve host"; echo DVC-SUDO-RC=1'); fs.writeFileSync(path.join(sb.root, 'tty'), '');
  assert.equal(runPrep(sb).p.fail, 'acct-sudo-unknown');
  // 웹 글 1:1
  for (const f of PR.PREP_FAILS) assert.ok(WP.PREP_FAIL_TEXT[f], f);
  assert.match(PR.prepScript(PR.keyLineFor(PUB), { conn: { caddr: '10.48.0.5', laddr: '10.1.0.1', lport: 22 } }), /SE=\$\(sudo -n -l -U "\$A" "\$c" 2>&1 >\/dev\/null\)/, '계정 줄(E)을 덮지 않는 변수');
});

/* ── ⑧ 원격 시한 ── */
test('⑧ 원격 시한 — 산수 · 설치 · 준비 파일이 스스로 timeout 아래에서 · 실제 셸로 124 · 자식까지 멈춤 · 124 → timeout', async () => {
  assert.ok(B.INSTALL_REMOTE_LIMIT_S + B.REMOTE_KILL_S < I.INSTALL_EXEC_MS / 1000, '설치: 원격 시한 + KILL 유예 < exec 시한');
  assert.ok(PR.PREP_REMOTE_LIMIT_S + B.REMOTE_KILL_S < PR.PREP_EXEC_MS / 1000, '준비: 원격 시한 + KILL 유예 < exec 시한');
  assert.throws(() => B.selfTimeoutLines(1)); assert.throws(() => B.selfTimeoutLines('5; id'));
  const inst = B.installScript({ dir: '' });
  assert.ok(inst.includes(B.selfTimeoutLines(B.INSTALL_REMOTE_LIMIT_S)), '설치 파일'); assert.match(inst, /trap 'exit 143' TERM INT HUP/, 'TERM 에서도 임시 폴더를 지운다');
  assert.ok(inst.indexOf('selfTimeout') < 0 && inst.indexOf('exec timeout -k') < inst.indexOf('ACCT='), '인자 검사보다 먼저(같은 인자로 다시 돈다)');
  const prep = PR.prepScript(PR.keyLineFor(PUB), { conn: { caddr: '10.48.0.5', laddr: '10.1.0.1', lport: 22 } });
  assert.ok(prep.includes(B.selfTimeoutLines(PR.PREP_REMOTE_LIMIT_S)), '준비 파일');
  const which = spawnSync('/bin/sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();
  if (which) {
    const d = tmpDir('fm3540to-'); const f = path.join(d, 'to.sh'); const mark = path.join(d, 'child');
    fs.writeFileSync(f, `#!/bin/sh\nset -eu\n${B.selfTimeoutLines(5)}\n(sleep 20; echo alive > '${mark}') &\nsleep 20\necho never\n`);
    const t0 = Date.now(); const r = spawnSync('/bin/sh', [f, 'x'], { encoding: 'utf8' });
    assert.equal(r.status, 124, r.stdout + r.stderr); assert.ok(Date.now() - t0 < 12_000); assert.doesNotMatch(r.stdout, /never/);
    await new Promise((res) => setTimeout(res, 300)); assert.equal(fs.existsSync(mark), false, '자식(같은 프로세스 묶음)도 멈춘다');
  }
  // 원격이 시한으로 멈춘 결과(##DI rc 124 · ##DP rc 124) → 'timeout'
  const connect = (out) => async (o, fn) => fn({ exec: async (cmd) => (cmd === I.PRIV_COMMAND || cmd === PR.PREP_PRIV_COMMAND ? { stdout: '##DI priv root\n##DP conn 10.48.0.5 51515 10.1.0.1 22\n' } : { stdout: out }), writeFile: async () => {} });
  const cred = () => ({ state: 'ok', src: 'server', acct: 'root', key: 'k', keyId: 'K', auth: { username: 'root', privateKey: 'P', fingerprint: 'fp' } });
  const ri = await I.installOnce(tg('fm-t1', '10.1.0.1'), { keys: {}, connect: connect('##DI step dir\n##DI rc 124'), credOf: cred, expect: { dir: '' } });
  assert.equal(ri.install.code, 'timeout'); assert.equal(ri.install.rc, 124);
  const KEYS = { keyInfo: () => ({ usable: true, fingerprint: 'SHA256:f', publicKey: PUB }) };
  const rp = await PR.prepOnce(tg('fm-t2', '10.1.0.2'), { keys: KEYS, connect: connect('##DP step sshd\n##DP step acct\n##DP created\n##DP rc 137'), credOf: cred, test: async () => ({ ok: true, kind: 'ok' }) });
  assert.equal(rp.prep.code, 'timeout'); assert.equal(rp.prep.created, true, '한 일은 그대로 알린다');
});

/* ── 변이 검증이 찾은 빈틈(생존 6건) ── */
test('④ 준비 뒤 이어서 하는 디스크 점검 설치도 엣지가 아는 서버 판정을 넘긴다(설치 계정 확인 · installOnce 둘 다)', async () => {
  I._resetInstallForTest();
  const seen = [];
  const cred = (t, o) => { seen.push({ feature: o.feature || C.INSTALL_FEATURE, edge: o.edge, local: o.local, withAuth: !!o.withAuth });
    return { state: 'ok', src: 'corp', acct: 'root', key: 'k', keyId: 'K1', ...(o.withAuth ? { auth: { username: 'root', privateKey: 'P', fingerprint: 'fp' } } : {}) }; };
  const connect = async (o, fn) => fn({ exec: async (cmd) => (cmd === PR.PREP_PRIV_COMMAND ? { stdout: '##DI priv root\n##DP conn 10.48.0.5 51515 10.1.0.1 22\n' }
    : cmd === I.PRIV_COMMAND ? { stdout: '##DI priv no\n' } : { stdout: '##DP step sshd\n##DP step acct\n##DP exists\n##DP step key\n##DP added\n##DP ok\n##DP rc 0' }), writeFile: async () => {} });
  const KEYS = { keyInfo: () => ({ usable: true, fingerprint: 'SHA256:f', publicKey: PUB }) };
  const edgeLocal = () => (h) => h === '10.1.0.9';
  const r = await PR.prepOnce(tg('fm-c1', '10.1.0.9'), { keys: KEYS, connect, credOf: cred, test: async () => ({ ok: true, kind: 'ok' }), expect: { edge: true, edgeVcs: () => ['vcP'], edgeLocal, audit: true, dir: '' } });
  assert.equal(r.prep.code, 'ok', JSON.stringify(r.prep));
  const inst = seen.filter((x) => x.feature === C.INSTALL_FEATURE);
  assert.ok(inst.length >= 2, `설치 계정 확인 + 설치 실행 — ${JSON.stringify(seen)}`);
  for (const x of seen) { assert.equal(x.edge, true); assert.equal(typeof x.local, 'function', `${x.feature} withAuth=${x.withAuth}`); }
});

test('⑧ 원격 시한 — set -e 없는 파일(준비 파일)도 시한에 멈춘다 · 정상이면 한 번만 돈다(exec)', async () => {
  const which = spawnSync('/bin/sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();
  if (!which) return;
  const d = tmpDir('fm3540to2-');
  // 준비 파일처럼 set -e 가 없다 — exec 가 없으면 시한 뒤에 바깥 파일이 이어서 돈다
  const f = path.join(d, 'noe.sh');
  fs.writeFileSync(f, `#!/bin/sh\n${B.selfTimeoutLines(5)}\nsleep 20\necho never\n`);
  const t0 = Date.now(); const r = spawnSync('/bin/sh', [f], { encoding: 'utf8' });
  assert.equal(r.status, 124); assert.ok(Date.now() - t0 < 12_000); assert.doesNotMatch(r.stdout, /never/);
  // 금방 끝나는 파일은 한 번만(다시 도는 것은 timeout 아래의 한 번)
  const g = path.join(d, 'once.sh'); const cnt = path.join(d, 'count');
  fs.writeFileSync(g, `#!/bin/sh\nset -eu\n${B.selfTimeoutLines(30)}\necho run >> '${cnt}'\n`);
  const r2 = spawnSync('/bin/sh', [g, 'a b'], { encoding: 'utf8' });
  assert.equal(r2.status, 0); assert.equal(fs.readFileSync(cnt, 'utf8'), 'run\n', '한 번만 돈다');
});

test('⑤ 라우트 — 준비 조회 · 설치 · 준비 접수가 같은 서버 색인(호스트 이름 근거)을 쓴다 · 데모 계정에는 실제 항목 이름 없음', async () => {
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const FS = await import('../src/focusmon/store.js');
  const users = { own: { username: 'own', role: 'admin', scope: null }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'own']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { who = 'own', body } = {}) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    // 데모 대상 kr-db-01(fm-d0000000)이 연결 시험에서 알린 호스트 이름 = 'kr-db-01' · 같은 노드(중앙)에 다른 주소 · 다른 계정으로 'kr-db-01' 을 등록
    FS.putTestResult('fm-d0000000', { ok: true, kind: 'ok', hello: { hostname: 'kr-db-01' } });
    const add = await call('POST', '/api/tools/focus-mon/targets', { body: { name: 'kr-db-01', host: '10.10.29.99', port: 22, username: 'other', agent: '' } });
    assert.equal(add.status, 200, JSON.stringify(add.body)); const aid = add.body.target.id;
    const g = await call('GET', '/api/tools/focus-mon/prep');
    const ra = g.body.rows.find((x) => x.id === aid);
    assert.deepEqual(ra.hostSharedWith, [{ id: 'fm-d0000000', name: 'kr-db-01', basis: 'name' }]); assert.equal(ra.hostShared, true);
    const gd = await call('GET', '/api/tools/focus-mon/prep', { who: 'demo' });
    const rd = gd.body.rows.find((x) => x.id === 'fm-d0000000');
    assert.deepEqual(rd.hostSharedWith, [{ id: '', name: '', basis: 'name' }], '데모 계정에는 데모가 아닌 항목의 id · 이름을 싣지 않는다');
    const ins = await call('POST', '/api/tools/focus-mon/audit/install', { body: { ids: [aid] } });
    assert.equal(ins.status, 200); assert.equal(ins.body.results[0].code, 'host-shared', JSON.stringify(ins.body.results[0]));
    const pr = await call('POST', '/api/tools/focus-mon/prep', { body: { ids: ['fm-d0000000'], withAudit: true } });
    assert.equal(pr.status, 200); assert.equal(pr.body.results[0].ok, true); assert.equal(pr.body.results[0].auditWhy, 'host-shared', '같은 서버로 보이는 다른 계정 — 준비만');
    await new Promise((res) => setTimeout(res, 100));
  } finally { svc.stopFocusMon(); srv.close(); }
});

/* ── 반증 1인 반영(재현된 것) ── */
test('반증 F1(같은 서버) — VM 색인은 대상 주소만 · 상한 없음 · 그 노드가 수집한 VM 만(다른 법인 VM 이 앞을 채워도 놓치지 않는다)', () => {
  const foreign = Array.from({ length: 12 }, (_, i) => ({ id: `vm-f${i}`, vcenterId: 'vcX', ipAddresses: ['10.0.0.5'] }));
  const vms = [...foreign, { id: 'vm-real', vcenterId: 'vcA', ipAddresses: ['10.0.0.5', '10.0.1.5'] }, { id: 'vm-both', vcenterId: 'vcX', ipAddresses: ['10.7.0.1', '10.7.0.2'] }];
  const vmNodeOf = (vm) => ({ vcA: 'edge-a', vcX: 'edge-x' })[vm.vcenterId] ?? null;
  const ts = [tg('fm-r1', '10.0.0.5', { agent: 'edge-a' }), tg('fm-r2', '10.0.1.5', { agent: 'edge-a', username: 'u2' }), tg('fm-s1', '10.7.0.1', { agent: 'edge-a' }), tg('fm-s2', '10.7.0.2', { agent: 'edge-a', username: 'u3' })];
  const mx = M.machineIndex(ts, { vms, vmNodeOf });
  assert.deepEqual(mx.peersOf('fm-r1'), [{ id: 'fm-r2', basis: 'vm' }], '다른 법인 VM 12개가 같은 IP 여도 그 노드의 실제 VM 으로 안다');
  assert.deepEqual(mx.peersOf('fm-s1'), [], '다른 노드가 수집한 VM 이 두 주소를 함께 가져도 같은 서버로 보지 않는다');
  assert.deepEqual(M.machineIndex(ts, { vms, vmNodeOf: () => null }).peersOf('fm-r1'), [], '어느 노드 VM 인지 모르면 근거로 쓰지 않는다');
});

test('반증 F2(같은 서버) — 템플릿 · 관례 이름은 근거 아님 · 같은 이름이 많으면 근거 아님 · 작업 겹침(host-busy)은 강한 근거만 · 법인이 다르면 이름으로 묶지 않음', () => {
  for (const n of ['rhel8-template', 'centos7', 'rocky9', 'win2019', 'Ubuntu22.04']) assert.equal(M.nameKey(n), null, n);
  assert.equal(M.nameKey('db-prod-01'), 'db-prod-01');
  // 같은 호스트 이름(hello)이 4대 — 템플릿 복제로 보고 이름 근거를 쓰지 않는다
  const ts = Array.from({ length: 4 }, (_, i) => tg(`fm-t${i}`, `10.20.0.${i + 1}`, { username: i ? `u${i}` : 'dvcmon' }));
  const mx = M.machineIndex(ts, { helloOf: () => ({ hostname: 'appsrv' }) });
  assert.deepEqual(mx.peersOf('fm-t0'), [], `이름이 ${M.NAME_BUCKET_MAX}개를 넘는 묶음`);
  // 둘이면 근거 — 그러나 작업 겹침은 강한 근거만(이름 근거로 묶인 다른 서버의 일괄 설치를 막지 않는다)
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const a = tg('fm-hb000001', '10.21.0.1', { demo: true }); const b = tg('fm-hb000002', '10.21.0.2', { demo: true });
  const pair = M.machineIndex([a, b], { helloOf: () => ({ hostname: 'appsrv' }) });
  assert.deepEqual(pair.peersOf(a.id), [{ id: b.id, basis: 'hostname' }]);
  const K = { keyInfo: () => ({ usable: false }) };
  assert.equal(A.requestInstall(a, { by: 'own', peers: [a, b], machine: pair, keys: K }).ok, true);
  assert.equal(A.requestInstall(b, { by: 'own', peers: [a, b], machine: pair, keys: K }).ok, true, '같은 계정 · 이름 근거만 — 겹쳐도 된다(예전처럼 둘 다 시작)');
  // 강한 근거(같은 주소)면 host-busy — 누구와 겹쳤는지 알린다
  A._resetForTest();
  const c = tg('fm-hb000005', '10.21.0.9', { demo: true }); const d = tg('fm-hb000006', '10.21.0.9', { demo: true }); // 데모 계정 해석: 끝 두 자리 % 5 === 3 은 'feature'
  { const rc = A.requestInstall(c, { by: 'own', peers: [c, d], keys: K }); assert.equal(rc.ok, true, JSON.stringify(rc)); }
  const hb = A.requestInstall(d, { by: 'own', peers: [c, d], keys: K });
  assert.equal(hb.code, 'host-busy'); assert.deepEqual(hb.sharedWith, [{ id: c.id, name: c.name, basis: 'addr' }]);
  // 중앙 직접 — 법인이 다르면(둘 다 알 때) 이름으로 묶지 않는다 · 한쪽 법인을 모르면 견준다
  const kr = tg('fm-kr000001', '10.30.0.1', { name: 'db01' }); const vn = tg('fm-vn000001', '10.30.0.1x', { name: 'x', username: 'o' }); const un = tg('fm-un000001', '10.40.0.1', { name: 'y', username: 'o2' });
  const hello = { [vn.id]: { hostname: 'db01' }, [un.id]: { hostname: 'db01' } };
  const corp = { [kr.id]: 'KR', [vn.id]: 'VN' };
  const gx = M.machineIndex([kr, vn, un], { helloOf: (id) => hello[id] || null, groupOf: (t) => corp[t.id] || null });
  assert.deepEqual(gx.peersOf(kr.id).map((p) => p.id).sort(), [un.id], '법인 KR ↔ VN 은 아님 · 법인 모름은 견준다');
});

test('반증 F2 · F3(엣지 대상) — 인벤토리를 아직 못 읽으면 local-unknown · 여러 VM 이 같이 알린 IP(브리지)는 아는 서버가 아니다', async () => {
  const has = M.localHostIndex({ vms: [{ id: 'a', ipAddresses: ['10.8.0.1', '172.17.0.1'] }, { id: 'b', ipAddresses: ['10.8.0.2', '172.17.0.1'] }] });
  assert.equal(has('10.8.0.1'), true); assert.equal(has('172.17.0.1'), false, '두 VM 이 알린 IP'); assert.equal(has.unknown, false);
  const unk = M.localHostIndex({ vms: [], unknown: true }); assert.equal(unk.unknown, true);
  const F = await import('./_sshKeyFixtures.js');
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const k = KS.addKey({ name: 'lu-root-3540', privateKey: F.ed25519Key().pem, folderCorp: 'vcL', features: [C.PREP_FEATURE] }, { by: 'own' }).key;
  KS.saveAccount({ name: 'lu-root-3540', kind: 'os', corp: 'vcL', username: 'root', keyRef: k.id }, { by: 'own' });
  const t = tg('fm-lu000001', '10.48.7.7');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcL'], edge: true, local: unk }).state, 'local-unknown', '모르는 서버라고 단정하지 않는다(그래도 쓰지 않는다)');
  assert.equal(C.installCredFor(t, { feature: C.PREP_FEATURE, corpVcs: ['vcL'], edge: true, local: has }).state, 'not-local');
  assert.equal(A.cleanEdgeCred({ state: 'local-unknown' }).state, 'local-unknown');
  // 엣지 워커 — 첫 수집 전이면 unknown(이 시험 노드는 vCenter 수집 전)
  assert.equal(Wk.edgeLocal({ servers: [] }).unknown, true);
});

test('반증 L1 · L2 · L3(lost) — 한 일을 모르는데 단정하지 않음 · 엣지가 보낸 lost 는 받지 않음 · 이번 본문이 싣는 작업은 정리 전에 본 것으로', async () => {
  const t = WP.prepResultText({ code: 'lost', why: 'no-result', fromAsked: true, added: false, created: false, audit: 'off' });
  assert.doesNotMatch(t.sub, /주소 제한은 적용되지 않음/); assert.doesNotMatch(t.sub, /계정은 있었음|공개키 넣음/);
  assert.equal(A.cleanEdgeResult({ mode: 'prep', prep: { code: 'lost' } }).prep.code, 'unreachable', 'lost 는 중앙만 적는다');
  assert.equal(A.cleanEdgeResult({ mode: 'install', install: { code: 'lost' } }).install.code, 'unreachable');
  assert.equal(A.cleanEdgeResult({ mode: 'prep', prep: { code: 'login' }, install: { code: 'lost' } }).install.code, 'unreachable', '준비에 실린 설치 결과도');
  // L3 — 중앙이 SEEN_TTL 넘게 멈췄다 돌아온 첫 동기화: 엣지가 그 본문에 싣는 작업은 지우지 않는다
  A._resetForTest(); SET._resetForTest(); SET.saveInstallDir('', { by: 'own' });
  const te = tg('fm-l3l3354001', '10.48.3.1', { agent: 'edge-pl' }); const mine = new Map([[te.id, te]]);
  const t0 = Date.now(); const rows = { [te.id]: { state: 'ok' } };
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: rows, credPrep: rows }, t0);
  const r = A.requestPrep(te, { by: 'own', now: t0 }); assert.equal(r.ok, true);
  assert.equal(A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], cred: rows, credPrep: rows }, t0 + 1000).jobs.length, 1);
  A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], active: [{ runId: r.runId, state: 'running', phase: '계정 · 공개키' }] }, t0 + 2000);
  const back = t0 + A.SEEN_TTL_MS + 5 * 60_000;
  const out = A.handleEdgeAudit('edge-pl', mine, { caps: ['install', 'prep'], active: [{ runId: r.runId, state: 'running', phase: '계정 · 공개키' }] }, back);
  assert.ok(A.jobOf(te.id), '엣지가 아직 싣고 있다 — 지우지 않는다'); assert.equal(A.readinessOf(te.id)?.lastPrep, undefined); assert.deepEqual(out.cancel, []);
  A.sweep(back + A.SEEN_TTL_MS + 60_000); assert.equal(A.readinessOf(te.id).lastPrep.code, 'lost', '그 뒤 보고가 끊기면 예전처럼 lost');
});
