/**
 * 베어메탈 사용률 점검 반복 4회차(기준판 47afbb1c) — 확정 3건을 재현한 입력으로 고정한다.
 *   D1 키 폴더 · 허용 기능 판정(keyPlacementIssue)이 7b 쓰기 경로(온보딩 분석 — 중앙 · 엣지 공통 · bm-storage 저장 bmBindCheck · 회전)에 없었다
 *      → 적용 · 저장 · 회전은 성공하는데 수집은 매 주기 key-folder · key-feature 로 접속하지 않았다.
 *      메인 결정: 폴더 밖은 거부(같은 함수) · 허용 기능 제한은 경고(분석 행 · 회전 결과 — 적용 · 회전은 막지 않는다).
 *   D2 1회차 D3 · D4 뒤 경로로 쓰지 않는 OS 등록(꺼짐 · 엣지 지정)이 누락 점검에 ‘등록부에만 있음(함대에 없음)’ 으로 한 번 더 나왔다(이름이 함대와 다를 때).
 *      기준판 55d8e121(1회차 시작)은 켬 · 끔 · agent 어느 경우나 1행이었다 — 그 1행으로 고정.
 *   D3 로그 공통 원인 후보가 서버를 키 하나로 셌다(이 노드 + 엣지 보관분 — 노드 사이 같은 IP 키가 다른 서버) → (법인, 키) 쌍(귀속 없음은 |키@노드).
 * 기준 시각: 정시 −30분(docs/rules/common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop4-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const MIN = 60_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * MIN;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const F = await import('./_sshKeyFixtures.js');
const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin', totpEnabled: true, totpSecret: SECRET },
  { username: 'adm', role: 'admin' },
] }));
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const KS = await import('../src/bmusage/onboard/keyStore.js');
const REFS = await import('../src/bmusage/onboard/refs.js');
const PL = await import('../src/bmusage/onboard/placement.js');
const RUN = await import('../src/bmusage/onboard/onboardRun.js');
const BM = await import('../src/bmstor/registry.js');

const key = (o) => { const r = KS.addKey({ privateKey: F.ed25519Key().pem, ...o }, { by: 'own' }); assert.equal(r.ok, true, JSON.stringify(r)); return r.key; };
const BOTH = ['bm-usage', 'bm-storage'];
const kA = key({ name: 'a-common', folderCorp: 'vcA', features: BOTH });
const kB = key({ name: 'b-common', folderCorp: 'vcB', features: BOTH });
const kSt = key({ name: 'a-storage', folderCorp: 'vcA', features: ['bm-storage'] });
const kSrv = key({ name: 'a9-only', folderCorp: 'vcA', folderServer: 'db-a9', features: BOTH });
const kAll = key({ name: 'legacy-all' });   // 폴더 · 허용 기능 없음(예전 방식 — 모든 기능)
const acc = (o) => { const r = KS.saveAccount({ kind: 'os', ...o }, { by: 'own' }); assert.equal(r.ok, true, JSON.stringify(r)); return r.account; };
const accA = acc({ name: 'a-ops', corp: 'vcA', username: 'mon', keyRef: kA.id });
const accSt = acc({ name: 'a-st', corp: 'vcA', username: 'mon2', keyRef: kSt.id });
// 기존 항목(실제 등록부 — 승인된 묶음): e1 은 제자리 키 · e2 는 이미 다른 법인 폴더 키(예전 상태 — 이 쓰기가 만든 문제가 아니다)
const save = (o) => { const r = BM.saveBmServer({ username: 'mon', mounts: ['/'], bindApproved: true, ...o }); assert.equal(r.ok, true, JSON.stringify(r)); return r.server; };
const e1 = save({ name: 'db-e1', host: '10.40.2.1', vcenterId: 'vcA', keyRef: kA.id });
const e2 = save({ name: 'db-e2', host: '10.40.2.2', vcenterId: 'vcA', keyRef: kB.id });

const csv = (lines) => Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
const HDR = 'name,corp,idrac_host,idrac_cred,service_tag,os_host,os_port,os_cred,os_key,collect_via,mounts,enabled,note';
const corps = [{ id: 'vcA', name: 'KR-SEL' }, { id: 'vcB', name: 'PL-WAW' }];
async function ctxOf({ isEdge = false, myCorps = [] } = {}) {
  const D = await RUN.defaultOnboardDeps();
  return RUN.buildOnboardCtx({ D, corps, isEdge, myCorps, edgeOf: () => null, rttOf: () => ({ rttMs: 40 }), canView: () => true, canWrite: () => true, fullScope: true, ownerTier: true }).ctx;
}
const byName = (a) => Object.fromEntries(a.rows.map((r) => [r.name, r]));
const resolveOf = (name, feature) => REFS.withResolvedAuth(BM.listBmServersRaw().filter((s) => s.name === name), { feature })[0];

/* ── D1 ─────────────────────────────────────────────────────────────────── */
test('D1 ① 온보딩 분석(중앙) — 폴더 밖 키는 거부(직접 고른 키 · 공통 계정 기본 키 · 서버별 폴더 · 법인 변경) · 허용 기능 제한은 경고 · 키와 무관한 갱신은 막지 않는다', async () => {
  const a = await RUN.analyzeUpload(csv([HDR,
    'db-a1,KR-SEL,,,,10.40.0.1,,개별:mon,b-common,central,/,,',     // 재현 ①: 기준판은 new → 적용 → 수집 key-folder
    'db-a2,KR-SEL,,,,10.40.0.2,,개별:mon,a-storage,central,/,,',    // 재현 ②: 기준판은 경고 없이 new → 적용 → bm-usage key-feature
    'db-a3,KR-SEL,,,,10.40.0.3,,개별:mon,a-common,central,/,,',
    'db-a9,KR-SEL,,,,10.40.0.9,,개별:mon,a9-only,central,/,,',
    'db-a8,KR-SEL,,,,10.40.0.8,,개별:mon,a9-only,central,/,,',      // 서버별 폴더 키 · 다른 서버
    'db-u1,미귀속,,,,10.40.0.11,,a-ops,,central,/,,',                 // 공통 계정 기본 키(vcA 폴더) · 귀속 없는 서버
    'db-a4,KR-SEL,,,,10.40.0.4,,a-st,,central,/,,',                  // 공통 계정 기본 키가 스토리지 전용
    'db-a5,KR-SEL,,,,10.40.0.5,,개별:mon,legacy-all,central,/,,',
    'db-e1,PL-WAW,,,,10.40.2.1,,,,central,/,,',                      // 기존 항목의 법인만 바꿈 — 이어지는 키가 새 법인 폴더 밖
    'db-e2,KR-SEL,,,,10.40.2.2,,,,central,/;/data,,',                 // 기존 항목(이미 폴더 밖)의 마운트만 — 이 쓰기가 만든 문제가 아니다
  ]), { ctx: await ctxOf() });
  assert.equal(a.ok, true, JSON.stringify(a));
  const r = byName(a);
  for (const n of ['db-a1', 'db-a8', 'db-u1', 'db-e1']) {
    assert.equal(r[n].action, 'reject', `${n}: ${JSON.stringify(r[n])}`);
    assert.equal(r[n].code, 'key-folder', n);
    assert.match(r[n].reason, /다른 법인 · 다른 서버의 폴더/);
  }
  assert.ok(!/vcB|b-common/.test(r['db-a1'].reason), '거부 문구에 키 폴더 값 · 이름을 싣지 않는다');
  const kf = (n) => r[n].warnings.find((w) => w.code === 'key-feature');
  assert.equal(r['db-a2'].action, 'new'); assert.match(kf('db-a2')?.text || '', /막히는 수집: 베어메탈 사용률$/, JSON.stringify(r['db-a2'].warnings));
  assert.equal(r['db-a4'].action, 'new'); assert.match(kf('db-a4')?.text || '', /베어메탈 사용률/, '공통 계정의 기본 키도 같은 판정');
  for (const n of ['db-a3', 'db-a9', 'db-a5']) { assert.equal(r[n].action, 'new', n); assert.equal(kf(n), undefined, n); }
  assert.equal(r['db-e2'].action, 'update', JSON.stringify(r['db-e2'])); assert.equal(kf('db-e2'), undefined);
  assert.equal(a.summary.reject, 4);
  // 적용 → 실제 접속 자격 해석(폴러 · 연결 시험과 같은 resolveOsAuth): 경고가 말한 그대로다 · 적용한 서버에 key-folder 는 없다
  const D = await RUN.defaultOnboardDeps();
  const ap = RUN.applyOnboard(a.rows, { D, by: 'own', fileSha: a.fileSha });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  assert.equal(resolveOf('db-a2', 'bm-usage').authErrorCode, 'key-feature');
  assert.equal(resolveOf('db-a2', 'bm-storage').authErrorCode, undefined);
  assert.equal(resolveOf('db-a4', 'bm-usage').authErrorCode, 'key-feature');
  for (const n of ['db-a3', 'db-a9', 'db-a5']) assert.equal(resolveOf(n, 'bm-usage').authErrorCode, undefined, n);
  assert.equal(BM.listBmServersRaw().some((s) => ['db-a1', 'db-a8', 'db-u1'].includes(s.name)), false, '거부 행은 쓰지 않았다');
  assert.equal(BM.listBmServersRaw().find((s) => s.id === e1.id).vcenterId, 'vcA', 'db-e1 법인을 바꾸지 않았다');
  // 같은 판정의 접속 때 결과(거부한 행을 그대로 썼다면 — 기준판 재현 꼴): key-folder
  save({ name: 'db-x1', host: '10.40.1.1', vcenterId: 'vcA', keyRef: kB.id });
  const x = resolveOf('db-x1', 'bm-usage');
  assert.equal(x.authErrorCode, 'key-folder');
  // 수집 건강은 cred-config 로 묶지만 서버 상세(osError)는 사유 문구 그대로 — key-folder · key-feature 가 구분된다
  const OSc = await import('../src/bmusage/collectors/osSsh.js');
  const MR = await import('../src/bmusage/missReason.js');
  const cf = await OSc.collectOsUsage(x); const ce = await OSc.collectOsUsage(resolveOf('db-a2', 'bm-usage'));
  assert.equal(cf.error, REFS.AUTH_ERROR['key-folder']); assert.equal(ce.error, REFS.AUTH_ERROR['key-feature']);
  assert.equal(MR.osMissOf(cf), 'cred-config'); assert.equal(MR.osMissOf(ce), 'cred-config');
});

test('D1 ② 엣지 적용(엣지 노드 · 실제 applyEdgeDeployment) — 같은 분석이 자기 키로 폴더 밖을 거부하고 중앙에 code 로 보고한다', async () => {
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  const D = await RUN.defaultOnboardDeps();
  const row = (name, ip, osKey) => ({ name, corp: 'vcA', osHost: ip, osUser: 'mon', osKey, mounts: ['/'], enabled: true, bindOk: true });
  const r = await EA.applyEdgeDeployment([row('ed-1', '10.41.0.1', 'b-common'), row('ed-2', '10.41.0.2', 'a-common')],
    { sig: '4'.repeat(32), D, corps, myCorps: ['vcA'], pending: [], currentTargets: async () => ({ targets: [], skipped: [] }) });
  assert.deepEqual(r.rejects, [{ name: 'ed-1', code: 'key-folder' }], JSON.stringify(r));
  assert.equal(BM.listBmServersRaw().some((s) => s.name === 'ed-1'), false);
  assert.ok(BM.listBmServersRaw().some((s) => s.name === 'ed-2'));
});

test('D1 ③ bm-storage 저장(bmBindCheck · 실제 라우터) — 저장 뒤 효력 키가 폴더 밖이면 409 key-folder · 제자리 키 · 비밀번호 고정 · 키와 무관한 수정은 그대로', async (t) => {
  const { bmBindCheck } = await import('../src/routes/api/bmstor.js');
  // 재현 ③: 기준판은 { binds: true }(오류 없음 — OTP 뒤 저장)
  const f1 = await bmBindCheck({ name: 'db-b1', host: '10.42.0.1', username: 'mon', vcenterId: 'vcA', keyRef: kB.id });
  assert.deepEqual([f1.code, f1.status, f1.binds], ['key-folder', 409, undefined], JSON.stringify(f1)); assert.match(f1.error, /다른 법인 · 다른 서버의 폴더/);
  assert.deepEqual(await bmBindCheck({ name: 'db-b1', host: '10.42.0.1', username: 'mon', vcenterId: 'vcA', keyRef: kA.id }), { binds: true });
  assert.equal((await bmBindCheck({ name: 'db-b2', host: '10.42.0.2', username: 'mon', vcenterId: 'vcB', credRef: accA.id })).code, 'key-folder', '공통 계정의 기본 키도 같은 판정');
  assert.deepEqual(await bmBindCheck({ name: 'db-b3', host: '10.42.0.3', username: 'mon', vcenterId: 'vcB', credRef: accA.id, osAuth: 'password' }), { binds: true }, '비밀번호 고정이면 키를 쓰지 않는다');
  // 이 화면은 법인(vcenterId)을 보내지 않는다 — 새 항목은 귀속이 없어 법인 폴더 키는 접속 때도 key-folder 다(같은 판정)
  const f4 = await bmBindCheck({ name: 'db-b4', host: '10.42.0.4', username: 'mon', keyRef: kA.id });
  assert.equal(f4.code, 'key-folder');
  // 재확인 I1: 귀속이 없는 서버에는 '이 법인 폴더 키를 고르세요' 가 아니라 갈 길(전역 키 · 서버 등록에서 법인 지정)을 말한다 · 키 이름 · 폴더는 싣지 않는다
  assert.match(f4.error, /법인\(vCenter\) 귀속이 없어/); assert.match(f4.error, /전역 키/); assert.doesNotMatch(f4.error, /이 서버 법인\(또는 이 서버\)의 폴더에 있는 키를 고르세요/);
  assert.doesNotMatch(f4.error, new RegExp(`${kA.name}|vcA`), '키 이름 · 폴더 법인을 흘리지 않는다');
  assert.deepEqual(await bmBindCheck({ name: 'db-b4', host: '10.42.0.4', username: 'mon', keyRef: kAll.id }), { binds: true });
  // 기존 항목: 키 · 법인 · 이름이 그대로인 수정(마운트)은 판정하지 않는다 · 같은 항목에 폴더 밖 키를 새로 고르면 거부
  assert.deepEqual(await bmBindCheck({ id: e1.id, name: 'db-e1', host: '10.40.2.1', username: 'mon', mounts: ['/', '/data'] }), { binds: false });
  assert.deepEqual(await bmBindCheck({ id: e2.id, name: 'db-e2', host: '10.40.2.2', username: 'mon', mounts: ['/', '/data'] }), { binds: false }, '이미 폴더 밖인 항목의 무관한 수정은 막지 않는다');
  assert.equal((await bmBindCheck({ id: e1.id, name: 'db-e1', host: '10.40.2.1', username: 'mon', keyRef: kB.id })).code, 'key-folder');
  assert.equal((await bmBindCheck({ id: e1.id, name: 'db-e1-renamed', host: '10.40.2.1', username: 'mon', keyRef: kSrv.id })).code, 'key-folder', '서버별 폴더 키는 그 서버 이름에만');
  // 실제 라우터: OTP 게이트 전에 409 + 사유(저장하지 않는다)
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = { adm: { username: 'adm', role: 'admin', scope: null } };
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/bm-storage/servers`, { method: 'POST', headers: { 'x-u': 'adm', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'db-b9', host: '10.42.0.9', username: 'mon', mounts: ['/'], vcenterId: 'vcA', keyRef: kB.id }) });
  const j = await res.json();
  assert.equal(res.status, 409, JSON.stringify(j)); assert.equal(j.code, 'key-folder');
  assert.equal(BM.listBmServersRaw().some((s) => s.name === 'db-b9'), false);
});

test('D1 ④ 회전 — 옛 키로 되던 수집 기능이 새 키에 없으면 경고(회전은 한다) · 같은 기능이면 경고 없음 · 폴더 밖은 예전처럼 거부 · 실제 라우터 응답에 경고', async (t) => {
  const old1 = key({ name: 'rot-old-1', folderCorp: 'vcA', features: BOTH });
  const new1 = key({ name: 'rot-new-1', folderCorp: 'vcA', features: ['bm-storage'] });
  save({ name: 'db-r1', host: '10.43.0.1', vcenterId: 'vcA', keyRef: old1.id });
  // 재현 ④: 기준판은 { ok, servers:[1] } 경고 없음 — 회전 뒤 bm-usage key-feature · 연결 시험(conn-test)은 통과
  const r = REFS.rotateKey(old1.id, new1.id);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.servers.length, 1);
  assert.deepEqual(r.warnings?.map((w) => [w.code, w.features]), [['key-feature', ['bm-usage']]]);
  assert.match(r.warnings[0].text, /베어메탈 사용률/); assert.match(r.warnings[0].text, /연결 시험은 이 제한을 보지 않아/);
  assert.equal(resolveOf('db-r1', 'bm-usage').authErrorCode, 'key-feature', '경고가 말한 그대로');
  assert.equal(REFS.resolveOsAuth(BM.listBmServersRaw().find((s) => s.name === 'db-r1'), { feature: 'conn-test' }).ok, true);
  // 같은 기능(또는 넓은 기능)으로 회전 · 쓰는 곳이 없는 회전 → 경고 없음
  const new2 = key({ name: 'rot-new-2', folderCorp: 'vcA', features: BOTH });
  assert.equal(REFS.rotateKey(new1.id, new2.id).warnings, undefined);
  const idle = key({ name: 'rot-idle', folderCorp: 'vcA', features: BOTH }); const narrow = key({ name: 'rot-narrow', folderCorp: 'vcA', features: [] });
  const ri = REFS.rotateKey(idle.id, narrow.id); assert.equal(ri.ok, true); assert.equal(ri.warnings, undefined, '바뀐 곳이 없으면 경고하지 않는다');
  // 공통 계정이 쓰던 키(서버 참조 0 · 계정 1)도 경고
  const accOld = key({ name: 'acc-old', folderCorp: 'vcA', features: BOTH }); const accNew = key({ name: 'acc-new', folderCorp: 'vcA', features: ['bm-usage'] });
  acc({ name: 'rot-acc', corp: 'vcA', username: 'mon3', keyRef: accOld.id });
  const ra = REFS.rotateKey(accOld.id, accNew.id);
  assert.equal(ra.accounts, 1); assert.deepEqual(ra.warnings?.[0]?.features, ['bm-storage']);
  // 폴더 밖은 예전처럼 거부(B-4 — placementConflicts)
  const other = key({ name: 'rot-other', folderCorp: 'vcB', features: BOTH });
  assert.equal(REFS.rotateKey(new2.id, other.id).code, 'folder-conflict');
  // 같은 판정(placement.lostFeatures = keyPlacementIssue) · 이름은 SSH 공용 접속 기능 목록과 같다
  assert.deepEqual(PL.lostFeatures({ features: null }, { features: ['bm-storage'] }), ['bm-usage']);
  assert.deepEqual(PL.lostFeatures({ features: ['bm-storage'] }, { features: [] }), ['bm-storage']);
  assert.deepEqual(PL.lostFeatures({ features: [] }, { features: [] }), []);
  const SVC = await import('../src/sshaccess/service.js');
  for (const f of PL.COLLECT_FEATURES) assert.equal(SVC.FEATURE_CATALOG.find((x) => x.id === f)?.label, PL.FEATURE_LABEL[f], f);
  assert.equal(REFS.keyPlacementIssue, PL.keyPlacementIssue, 'refs 가 같은 함수를 다시 내보낸다(판정 하나)');
  // 실제 라우터(설정 소유자 + 본인 OTP) — 응답에 경고가 실린다
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  const USERS = { own: { username: 'own', role: 'admin', scope: null } };
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const old3 = key({ name: 'rot-old-3', folderCorp: 'vcA', features: BOTH }); const new3 = key({ name: 'rot-new-3', folderCorp: 'vcA', features: ['bm-usage'] });
  save({ name: 'db-r3', host: '10.43.0.3', vcenterId: 'vcA', keyRef: old3.id });
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 12_000) await new Promise((r) => setTimeout(r, left + 50));
  const otp = generateToken(SECRET, { counter: Math.floor(Date.now() / 30_000) });
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/ssh-keys/rotate`, { method: 'POST', headers: { 'x-u': 'own', 'content-type': 'application/json' }, body: JSON.stringify({ from: old3.id, to: new3.id, otp }) });
  const j = await res.json();
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.deepEqual(j.warnings?.map((w) => [w.code, w.features]), [['key-feature', ['bm-storage']]], JSON.stringify(j));
});

test('D1 ⑤ 판정 하나 — keyWriteIssue 는 keyPlacementIssue 그대로(폴더 = conn-test 판정 · 기능 = 수집 기능별) · 전과 같으면 판정하지 않는다', () => {
  const k = { id: 'k1', folderCorp: 'vcA', folderServer: '', features: ['bm-storage'] };
  assert.deepEqual(PL.keyWriteIssue(k, { vcenterId: 'vcB', name: 'x' }), { folder: 'key-folder', blocked: ['bm-usage'] });
  assert.deepEqual(PL.keyWriteIssue(k, { vcenterId: 'vcA', name: 'x' }), { folder: null, blocked: ['bm-usage'] });
  assert.deepEqual(PL.keyWriteIssue(k, { vcenterId: 'vcB', name: 'X' }, { keyId: 'k1', vcenterId: 'vcB', name: 'x' }), { folder: null, blocked: [] }, '키 · 법인 · 이름이 그대로');
  assert.deepEqual(PL.keyWriteIssue(null, { vcenterId: 'vcB' }), { folder: null, blocked: [] });
  assert.deepEqual(PL.keyWriteIssue({ id: 'k2', folderCorp: 'vcA', folderServer: 'DB-A9', features: null }, { vcenterId: 'vcA', name: 'db-a9' }), { folder: null, blocked: [] }, '서버 이름은 대소문자 무시(keyPlacementIssue 와 같다)');
  const look = { keyById: (id) => ({ k1: k })[id] || null, accountById: (id) => ({ a1: { kind: 'os', keyRef: 'k1' }, i1: { kind: 'idrac', keyRef: 'k1' } })[id] || null };
  assert.equal(PL.effectiveKeyOf({ cred: 'a1' }, look)?.id, 'k1');
  assert.equal(PL.effectiveKeyOf({ cred: 'a1', osAuth: 'password' }, look), null);
  assert.equal(PL.effectiveKeyOf({ cred: 'i1' }, look), null);
  assert.equal(PL.effectiveKeyOf({ key: 'nope', cred: 'a1' }, look), null, '서버 키가 있으면 그것(없는 키면 없음 — 계정 키로 넘어가지 않는다)');
  assert.equal('privateKey' in PL.keyShape({ id: 'x', privateKey: 'SECRET' }), false, '판정 모양에 비밀 칸 없음');
});

/* ── D2 ─────────────────────────────────────────────────────────────────── */
const T = await import('../src/bmusage/targets.js');
const { missingCheck } = await import('../src/bmusage/onboard/missing.js');
const RC = { readable: true, names: new Map(), byId: new Map([['edge-pl-id', { id: 'edge-pl-id', name: 'edge-pl' }]]), byName: new Map([['edge-pl', { id: 'edge-pl-id', name: 'edge-pl' }]]), firstAlias: new Map(), urlById: new Map() };
const BM1 = [{ serverId: 's-1', name: 'db01.corp.example', serviceTag: 'TAG01', vcenterId: 'vcA' }];
const OSR = (o = {}) => [{ id: 'o-1', name: 'db01', host: 'db01.corp.example', username: 'mon', password: 'pw', vcenterId: 'vcA', ...o }];
const missRows = ({ reg = [], os = OSR(), settings = { corps: { vcA: true }, idracTelemetry: true, osSsh: true } } = {}) => {
  const tg = T.resolveTargets({ bareMetal: BM1, registry: reg, bmServers: os, settings, remoteCollectors: RC });
  return { tg, rows: missingCheck({ targets: tg.targets, skipped: tg.skipped, entryByKey: new Map(), osRegistry: os }).rows.map((r) => [r.key, r.bucket, r.reason]) };
};

test('D2 ① 누락 점검 — 꺼진 · 엣지 지정 OS 등록(이름이 함대와 다름)이 ‘등록부에만 있음’ 으로 한 번 더 나오지 않는다(기준판 55d8e121 과 같은 1행)', () => {
  // 기준판 55d8e121: 켬 · 끔 · agent 어느 경우나 [TAG01] 1행. 대상판(47afbb1c): 끔 · agent 에 [os:o-1 untracked registry-only] 가 더해졌다(재현).
  assert.deepEqual(missRows().rows, [['TAG01', 'unknown', 'no-record']], '켬');
  assert.deepEqual(missRows({ os: OSR({ enabled: false }) }).rows, [['TAG01', 'none', 'os-disabled']], '끔');
  assert.deepEqual(missRows({ os: OSR({ agent: 'edge-pl' }) }).rows, [['TAG01', 'unknown', 'edge-no-record']], 'agent(엣지 위임)');
  const IDR = [{ id: 's-1', host: 'https://10.0.0.11', username: 'u', password: 'p' }];
  assert.deepEqual(missRows({ reg: IDR, os: OSR({ enabled: false }) }).rows, [['TAG01', 'unknown', 'no-record']], 'iDRAC 경로 + 꺼진 OS 등록');
  assert.deepEqual(missRows({ reg: IDR, os: OSR({ agent: 'edge-pl' }) }).rows, [['TAG01', 'unknown', 'no-record']], 'iDRAC 경로 + 엣지 지정 OS 등록');
  // 법인 꺼짐 · 귀속 없음 제외도 같은 등록을 고른 서버다(함대에 있다)
  assert.deepEqual(missRows({ settings: { corps: {}, idracTelemetry: true, osSsh: true } }).rows, [['TAG01', 'none', 'corp-off']]);
  // 함대 어느 서버도 고르지 않은 등록은 예전처럼 ‘등록부에만 있음’(반증 F4 그대로)
  const lone = missRows({ os: [...OSR(), { id: 'o-9', name: 'lone', host: '10.9.9.9', username: 'mon', password: 'pw' }] }).rows;
  assert.deepEqual(lone, [['os:o-9', 'untracked', 'registry-only'], ['TAG01', 'unknown', 'no-record']]);
  // 고른 등록 id 는 응답에 싣지 않는다(publicTarget · publicSkipped)
  const { tg } = missRows({ reg: IDR, os: OSR({ enabled: false }) });
  assert.equal(tg.targets[0].osRegId, 'o-1'); assert.equal('osRegId' in T.publicTarget(tg.targets[0]), false);
  const sk = missRows({ os: OSR({ enabled: false }) }).tg.skipped[0];
  assert.equal(sk.osRegId, 'o-1'); assert.equal('osRegId' in T.publicSkipped(sk), false); assert.equal(T.publicSkipped(sk).reason, 'os-disabled');
});

test('D2 ② 실제 등록부 → currentTargets → 실제 라우터(누락 점검 · 주 조회) — 1행 · 응답에 osRegId 없음', { skip: !sqlite && 'node:sqlite 없음' }, async (t) => {
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: true }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const off = save({ name: 'db01', host: 'db01.corp.example', vcenterId: 'vcA', password: 'pw', enabled: false });   // 함대 이름(db01.corp.example)과 다른 등록 이름 · 주소 = 함대 이름
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(async () => ({ bareMetal: BM1, virtualizationHosts: [] }));
  t.after(() => P._setFleetForTest(null));
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  const USERS = { adm: { username: 'adm', role: 'admin', scope: null } };
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api${p}`, { headers: { 'x-u': 'adm' } }); return { s: r.status, txt: await r.text() }; };
  const m = await get('/tools/bm-usage/onboard/missing');
  assert.equal(m.s, 200, m.txt);
  const rows = JSON.parse(m.txt).rows;
  assert.deepEqual(rows.filter((r) => r.key === 'TAG01' || r.key === `os:${off.id}`).map((r) => [r.key, r.bucket, r.reason]), [['TAG01', 'none', 'os-disabled']], m.txt.slice(0, 600));
  const u = await get('/tools/bm-usage');
  assert.equal(u.s, 200, u.txt.slice(0, 300));
  assert.ok(JSON.parse(u.txt).skipped.some((s) => s.key === 'TAG01' && s.reason === 'os-disabled'));
  assert.ok(!u.txt.includes('osRegId'), '주 조회 응답에 고른 등록 id 칸이 없다');
});

/* ── D3 ─────────────────────────────────────────────────────────────────── */
test('D3 로그 공통 원인 후보 — 이 노드 vcA 10.0.0.5 + 엣지 vcB 10.0.0.5 는 두 서버(예전: 키 하나로 접혀 후보 0) · 같은 쌍은 한 번 · 귀속 없음은 노드까지', async () => {
  const R = await import('../src/routes/api/bmLogs.js');
  const top = (min) => [{ ruleId: 'HW-MCE', cls: 'fault', severity: 'high', count: 5, last: NOW - min * MIN }];
  const run = async ({ local, edge }) => {
    const deps = {
      currentTargets: async () => ({ targets: local.map(([key, vcenterId, name]) => ({ key, vcenterId, name })) }),
      summary: async () => ({ at: NOW, list: local.map(([key, , , min]) => ({ key, wasRead: true, cls: { fault: { patterns: 1, lines: 5, cover: 'all', missing: [] } }, top: top(min) })) }),
      listEdgeBmUsage: async () => [{ agent: 'edge-b', snapAt: NOW, snap: { logsVer: 1, targets: edge.map(([key, vcenterId, name]) => ({ key, vcenterId, name })), logSummary: edge.map(([key, , , min]) => ({ key, wasRead: true, cls: { fault: { patterns: 1, lines: 5, cover: 'all', missing: [] } }, top: top(min) })) } }],
      bmAddressHosts: async () => [],
    };
    return R.bmLogsFleet({ user: { username: 'adm', role: 'admin', scope: null } }, { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] }, deps);
  };
  // 재현: 기준판은 servers 2 · faultServers 2 인데 common [] (키 하나 — 10.0.0.5 가 한 대로 접힘)
  const a = await run({ local: [['10.0.0.5', 'vcA', 'db-a', 10]], edge: [['10.0.0.5', 'vcB', 'db-b', 10]] });
  assert.equal(a.servers.length, 2); assert.equal(a.kpi.faultServers, 2);
  assert.equal(a.common.length, 1, JSON.stringify(a.common));
  assert.deepEqual(a.common[0].servers.map((s) => `${s.name}@${s.vcenterId}`).sort(), ['db-a@vcA', 'db-b@vcB']); assert.equal(a.common[0].count, 2);
  // 셋이면 셋(예전: 하나 적고 한 대가 목록에서 빠졌다)
  const b = await run({ local: [['10.0.0.5', 'vcA', 'db-a', 10], ['10.0.0.6', 'vcA', 'db-c', 12]], edge: [['10.0.0.5', 'vcB', 'db-b', 11]] });
  assert.equal(b.common[0].count, 3);
  // 같은 서버가 두 노드에 잠시 함께(담당 이동 — 같은 법인 · 같은 키) → 한 번
  const c = await run({ local: [['10.0.0.5', 'vcA', 'db-a', 10], ['10.0.0.7', 'vcA', 'db-d', 10]], edge: [['10.0.0.5', 'vcA', 'db-a', 9]] });
  assert.equal(c.common[0].count, 2); assert.deepEqual(c.common[0].servers.map((s) => s.name).sort(), ['db-a', 'db-d']);
  // 귀속 없음(법인 '')은 노드까지 가른다(resolvePerfTarget 과 같은 규칙) — 두 노드의 같은 키는 두 서버
  const { commonCauseCandidates } = await import('../src/bmusage/logs/view.js');
  const un = commonCauseCandidates([{ key: 'K', vcenterId: '', agent: '', top: top(5) }, { key: 'K', vcenterId: '', agent: 'edge-b', top: top(6) }]);
  assert.equal(un[0]?.count, 2);
  const { nodePairIdOf, targetIdOf } = await import('../src/bmusage/maint/judge.js');
  assert.equal(nodePairIdOf({ key: 'K', vcenterId: 'vcA' }, 'x'), targetIdOf({ key: 'K', vcenterId: 'vcA' }));
  assert.equal(nodePairIdOf({ key: 'K', vcenterId: '' }, 'edge-b'), '|K@edge-b');
});
