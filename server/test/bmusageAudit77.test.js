/**
 * bmusageAudit77.test.js — 전체 점검 77회차(베어메탈 사용률 2차 ① — 온보딩 · SSH 키 · 정비 창 · 로그).
 *
 * 34회차 '남긴 것'(같은 catch → preserveCorrupt 꼴)이 이 범위 다섯 파일에 남아 있었다 — **읽기 오류**(EACCES · EIO · EISDIR)도 손상으로 보고
 *   온전한 원본을 `<file>.corrupt.<시각>` 으로 옮겼다(재현: fs.readFileSync 가 EACCES 를 던지게 하면 다섯 파일 모두 옮겨졌다).
 *  F1 ssh-keys.json — 봉인본이 유일한 사본인데 옮겨져 키 저장소가 빈 채로 굳었다(보존본만 남아 재시작 뒤에도 오류 · 키 인증 수집 전부 끊김)
 *  F2 bm-onboard-edge.json(중앙 엣지 배포 목록) — 옮겨져 사람이 되돌리기 전까지 배포 503
 *  F3 bm-onboard-applied.json(엣지 적용 상태) — 옮긴 뒤 그 자리에 lost 파일을 써서 ‘만든 항목’ 목록을 잃고 7일 lost 보류
 *  F4 maintenance-windows-deployed.json(엣지 정비 창 배포본) — 옮겨짐
 *  F5 maintenance-stats.json(억제 계수) — 옮기고 0 부터 세어 다음 저장이 0 으로 덮음
 *  고친 뒤: 판정은 공용 util/jsonFileLoad.js(읽기 단계 실패 = read-error · parse 실패 = corrupt) — 읽기 오류면 원본을 옮기지도 덮지도 않고, 쓰기를 거절하고,
 *   다시 읽히면 스스로 풀린다. 손상(parse 실패)은 예전과 같이 보존본으로 옮긴다.
 *  개선: 정비 창 파일(maintenance-windows.json) 읽기 오류도 로드 오류 상태(서비스 점검 · 중앙 배포 503 표지)에 올린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-audit77-'));
process.env.CONFIG_DIR = DIR;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const F = (n) => path.join(DIR, n);
const corruptCopies = (name) => fs.readdirSync(DIR).filter((f) => f.startsWith(`${name}.corrupt.`));
const realRead = fs.readFileSync;
/** 그 경로 읽기만 EACCES(서비스 계정이 못 읽는 root 소유 파일 — root 로 도는 시험에서는 chmod 로 재현되지 않는다). */
function denyRead(file, fn) {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try { return fn(); } finally { fs.readFileSync = realRead; }
}
async function denyReadAsync(file, fn) {
  fs.readFileSync = function (p, ...a) {
    if (String(p) === file) { const e = new Error(`EACCES: permission denied, open '${p}'`); e.code = 'EACCES'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try { return await fn(); } finally { fs.readFileSync = realRead; }
}
// 재읽기 간격(30초)을 시험 시계로 넘긴다 — 정시 경계로 떨어뜨린 실제 시각 기준
const HOUR = 3_600_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR;
let clock = BASE;
const JFL = await import('../src/util/jsonFileLoad.js');
JFL._setJsonFileLoadClockForTest(() => clock);
test.after(() => JFL._setJsonFileLoadClockForTest());

test('F1 SSH 키 저장소 — 읽기 오류는 원본을 옮기지 않고 쓰기를 거절하며, 다시 읽히면 스스로 풀린다 · 손상은 예전처럼 보존', async () => {
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const file = F('ssh-keys.json');
  const body = JSON.stringify({ keys: [{ id: 'k_aaaaaa', name: 'kr-ops', algo: 'ed25519', fingerprint: 'SHA256:x', publicKey: 'ssh-ed25519 AAAA', privateKey: 'enc-or-plain', status: 'active' }], accounts: [] });
  fs.writeFileSync(file, body);
  KS._resetKeyStoreForTest();
  denyRead(file, () => {
    assert.equal(KS.listKeysRaw().length, 0, '못 읽은 동안은 빈 목록');
    const e = KS.keyStoreLoadError();
    assert.ok(e && e.readError === true, '로드 오류 = 읽기 오류');
    const w = KS.updateKeyMeta('k_aaaaaa', { name: 'kr-ops2' });
    assert.equal(w.ok, false); assert.equal(w.code, 'registry-unreadable'); assert.equal(w.readError, true);
    assert.match(w.reason, /읽기 오류/); assert.doesNotMatch(w.reason, /손상 보존본/);
    assert.match(KS.keyStoreUnreadableReason(e), /원본은 그대로/);
  });
  assert.deepEqual(corruptCopies('ssh-keys.json'), [], '읽기 오류로 원본을 옮기지 않는다');
  assert.equal(realRead(file, 'utf8'), body, '원본 그대로');
  // 간격 안에서는 디스크를 다시 보지 않는다(같은 오류) — 간격이 지나면 다시 읽어 풀린다
  assert.ok(KS.keyStoreLoadError()?.readError, '간격(30초) 안에는 그대로');
  clock += JFL.READ_RETRY_MS + 1;
  assert.equal(KS.keyStoreLoadError(), null, '다시 읽히면 오류가 풀린다(재시작 · 수동 되돌리기 없이)');
  assert.deepEqual(KS.listKeysRaw().map((k) => k.name), ['kr-ops']);
  // 손상은 예전과 같다 — 보존본 + 쓰기 거절(사유는 손상)
  fs.writeFileSync(file, '{"keys": [');
  KS._resetKeyStoreForTest();
  const e2 = KS.keyStoreLoadError();
  assert.ok(e2 && !e2.readError, '손상');
  assert.equal(corruptCopies('ssh-keys.json').length, 1, '손상은 보존본으로 옮긴다');
  const w2 = KS.updateKeyMeta('k_aaaaaa', { name: 'x' });
  assert.equal(w2.code, 'registry-unreadable'); assert.match(w2.reason, /손상 보존본/);
  // 점검용 읽기(diskDrift · plainStoredKeyIds)는 옮기지 않는다
  for (const f of corruptCopies('ssh-keys.json')) fs.rmSync(F(f));
  fs.writeFileSync(file, body); KS._resetKeyStoreForTest(); KS.listKeysRaw();
  denyRead(file, () => {
    assert.equal(KS.plainStoredKeyIds(), null, '못 읽으면 모름');
    const d = KS.diskDrift();
    assert.equal(d.ok, false); assert.match(d.reason, /read-failed:EACCES/);
  });
  assert.deepEqual(corruptCopies('ssh-keys.json'), []);
});

test('F6 키 저장소 손상 사유는 요약 — ‘다시 읽기’ 응답에 파일 조각(V8 JSON.parse 원문)을 싣지 않는다 · 키 점검 문구는 읽기 오류와 손상을 가른다', async () => {
  const KS = await import('../src/bmusage/onboard/keyStore.js');
  const file = F('ssh-keys.json');
  for (const f of corruptCopies('ssh-keys.json')) fs.rmSync(F(f));
  fs.writeFileSync(file, '{"keys":[{"id":"k_1","privateKey":"-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAA"}, SECRETb3BlbnNzaC1rZXk ]}');
  const r = KS.reloadKeyStoreFromDisk();
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /SECRET|b3Bl|jEAAAA|"/, `파일 조각이 응답에 실린다: ${r.reason}`);
  assert.doesNotMatch(String(KS.keyStoreLoadError()?.reason || ''), /SECRET|b3Bl/);
  const C = await import('../src/sshaccess/check.js');
  assert.match(JSON.stringify(C.buildKeyCheck({ now: BASE }).items), /손상 보존본을 확인하세요/);
  fs.writeFileSync(file, JSON.stringify({ keys: [], accounts: [] }));
  for (const f of corruptCopies('ssh-keys.json')) fs.rmSync(F(f));
  KS._resetKeyStoreForTest();
  denyRead(file, () => {
    const items = JSON.stringify(C.buildKeyCheck({ now: BASE }).items);
    assert.match(items, /읽기 오류 — 원본은 그대로/); assert.doesNotMatch(items, /손상 보존본/);
  });
  clock += JFL.READ_RETRY_MS + 1;
  assert.equal(KS.keyStoreLoadError(), null);
});

test('F2 엣지 배포 목록 — 읽기 오류는 옮기지 않고 쓰기를 거절 · 다시 읽히면 풀린다', async () => {
  const ED = await import('../src/bmusage/onboard/edgeDeploy.js');
  const file = F('bm-onboard-edge.json');
  const body = JSON.stringify({ agents: { 'edge-kr': { rows: [{ name: 'bm-kr1', corp: 'vc-kr' }], pending: [], at: 1, by: 'a' } } });
  fs.writeFileSync(file, body);
  ED._resetEdgeDeployForTest();
  denyRead(file, () => {
    assert.ok(ED.edgeDeployLoadError()?.readError);
    const w = ED.applyEdgeChanges({ removes: [{ agent: 'edge-kr', name: 'bm-kr1' }] }, { by: 't' });
    assert.equal(w.ok, false); assert.equal(w.code, 'registry-unreadable');
  });
  assert.deepEqual(corruptCopies('bm-onboard-edge.json'), []);
  assert.equal(realRead(file, 'utf8'), body);
  clock += JFL.READ_RETRY_MS + 1;
  assert.equal(ED.edgeDeployLoadError(), null);
  assert.deepEqual(ED.edgeRowsFor('edge-kr').map((r) => r.name), ['bm-kr1']);
  // 객체가 아닌 JSON(배열)은 손상이다(예전에는 빈 목록으로 읽혀 다음 저장이 덮었다)
  fs.writeFileSync(file, '[]'); ED._resetEdgeDeployForTest();
  assert.ok(ED.edgeDeployLoadError() && !ED.edgeDeployLoadError().readError);
  assert.equal(corruptCopies('bm-onboard-edge.json').length, 1);
});

test('F3 엣지 적용 상태 — 읽기 오류는 옮기지도 lost 파일을 쓰지도 않고, 그 판은 적용하지 않는다(만든 항목 목록을 지킨다)', async () => {
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  const file = F('bm-onboard-applied.json');
  const body = JSON.stringify({ sig: 'a'.repeat(32), created: { 'bm-kr1': { os: 'os_1' } }, at: BASE });
  fs.writeFileSync(file, body);
  const r = denyRead(file, () => EA.readAppliedState());
  assert.equal(r.ok, false); assert.equal(r.readError, true); assert.equal(r.state.sig, '', '인출 쿼리는 빈 서명(중앙 제거 대기 유지)');
  assert.deepEqual(corruptCopies('bm-onboard-applied.json'), []);
  assert.equal(realRead(file, 'utf8'), body, 'lost 파일로 덮지 않는다');
  // 적용 — 등록부를 건드리기 전에 멈춘다(D 의 어떤 함수도 부르지 않는다)
  const touched = [];
  const D = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); return new Proxy({}, { get: () => () => { throw new Error('등록부를 건드렸다'); } }); } });
  const a = await denyReadAsync(file, () => EA.applyEdgeDeployment([{ name: 'bm-kr2', corp: 'vc-kr' }], { sig: 'b'.repeat(32), D, myCorps: ['vc-kr'] }));
  assert.equal(a.ok, false); assert.equal(a.readError, true); assert.match(a.reason, /읽기 오류/);
  assert.deepEqual(touched, [], '등록부를 읽거나 쓰지 않는다');
  assert.equal(realRead(file, 'utf8'), body, '상태 파일도 그대로');
  // 다시 읽히면 예전 상태 그대로
  const ok = EA.readAppliedState();
  assert.equal(ok.ok, true); assert.deepEqual(ok.state.created, { 'bm-kr1': { os: 'os_1' } }); assert.equal(ok.state.lost, false);
  // 손상은 예전과 같다(보존 + lost 기록)
  fs.writeFileSync(file, '{"sig":');
  const c = EA.readAppliedState();
  assert.equal(c.ok, false); assert.equal(c.state.lost, true); assert.ok(!c.readError);
  assert.equal(corruptCopies('bm-onboard-applied.json').length, 1);
  assert.equal(JSON.parse(realRead(file, 'utf8')).lost, true);
});

test('F4 정비 창 배포본 — 읽기 오류는 옮기지 않고 못 읽음(억제하지 않는 쪽) · 손상은 보존', async () => {
  const ST = await import('../src/bmusage/maint/store.js');
  const file = F('maintenance-windows-deployed.json');
  const body = JSON.stringify({ v: 1, at: BASE, sig: 's', items: [], history: [] });
  fs.writeFileSync(file, body);
  ST._resetMaintStoreForTest();
  const d = denyRead(file, () => ST.loadDeployed(BASE + 60_000));
  assert.equal(d.unreadable, true); assert.equal(d.readError, true); assert.deepEqual(d.items, []);
  assert.deepEqual(corruptCopies('maintenance-windows-deployed.json'), []);
  assert.equal(realRead(file, 'utf8'), body);
  const ok = ST.loadDeployed(BASE + 60_000);
  assert.ok(ok && !ok.unreadable); assert.equal(ok.sig, 's');
  fs.writeFileSync(file, '{"items": 5}'); ST._resetMaintStoreForTest();
  const c = ST.loadDeployed(BASE + 60_000);
  assert.equal(c.unreadable, true); assert.ok(!c.readError);
  assert.equal(corruptCopies('maintenance-windows-deployed.json').length, 1, '형식 밖은 손상 — 보존');
});

test('개선 — 정비 창 파일 읽기 오류도 로드 오류 상태에 올린다(원본은 그대로 · 확정 불가) · 읽히면 풀린다', async () => {
  const ST = await import('../src/bmusage/maint/store.js');
  const file = F('maintenance-windows.json');
  const body = JSON.stringify({ v: 1, seq: 0, items: [] });
  fs.writeFileSync(file, body);
  ST._resetMaintStoreForTest();
  const e = denyRead(file, () => ST.maintLoadError());
  assert.ok(e && e.readError === true, '서비스 점검 · 중앙 배포 503 표지');
  assert.deepEqual(corruptCopies('maintenance-windows.json'), []);
  const { listSettingsLoadErrors } = await import('../src/util/settingsLoadError.js');
  // (다음 load 전) 서비스 점검 줄은 확정할 수 없다 — 기본값으로 확정하면 못 읽었을 뿐인 원본을 빈 목록으로 덮는다
  const row = listSettingsLoadErrors().find((x) => x.file === 'maintenance-windows.json');
  assert.ok(row && row.confirmable === false && row.readError === true);
  assert.equal(ST.maintLoadError(), null, '다시 읽히면 풀린다');
  assert.equal(realRead(file, 'utf8'), body);
});

test('F5 억제 계수 — 읽기 오류는 옮기지도 0 으로 덮지도 않는다 · 다시 읽히면 파일 값', async () => {
  const RT = await import('../src/bmusage/maint/runtime.js');
  const file = F('maintenance-stats.json');
  const body = JSON.stringify({ v: 1, byWindow: { 'mw-abcdef12': { alerts: 7, after: 1, hold: 0, focus: 0, collect: 0, collectFail: 0, at: BASE } }, leak: { n: 0, last: 3, at: BASE } });
  fs.writeFileSync(file, body);
  RT._resetMaintRuntimeForTest({ unlink: false });
  denyRead(file, () => {
    const s = RT.maintStats();
    assert.equal(s.readError, true); assert.deepEqual(s.byWindow, {});
    RT.countSuppression('alerts', ['mw-abcdef12'], { now: BASE });
    RT.flushMaintStats();
  });
  assert.deepEqual(corruptCopies('maintenance-stats.json'), []);
  assert.equal(realRead(file, 'utf8'), body, '못 읽은 동안 저장이 원본을 덮지 않는다');
  clock += JFL.READ_RETRY_MS + 1;
  const s2 = RT.maintStats();
  assert.ok(!s2.readError); assert.equal(s2.byWindow['mw-abcdef12'].alerts, 7, '파일 값으로 돌아간다');
  // 손상은 예전과 같다(보존 + 0 부터 · unreadable 표지)
  fs.writeFileSync(file, '{"byWindow":'); RT._resetMaintRuntimeForTest({ unlink: false });
  const s3 = RT.maintStats();
  assert.ok(s3.unreadable && !s3.readError);
  assert.equal(corruptCopies('maintenance-stats.json').length, 1);
});
