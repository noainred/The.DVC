/**
 * 전체 점검 105회차(마지막 회차) — 최종 반증 B: 100회차(c5bdd7866) · 104회차(85ba10e74) 반증.
 *  M1  104 D1 은 매핑 저장에서만 같은 Director 묶음을 봤다 — vCenter 가 묶인 등록의 주소(· 포트 · 담당)를 다른 등록의 주소:포트로 바꾸면(PUT Director · 자동 설정)
 *      그대로 통과하고 그 뒤 저장은 grandfather 로 보아 'Director 하나에 vCenter 하나' 를 우회했다 → directorMoveBindIssue(updateDirector · checkDirectorUpdate · planDirector)
 *  M2  104 I1(knownFor mappedStorages)의 형제 — 같은 Director 의 다른 등록이 붙는 전용 콘솔을 이 등록의 계정 삭제 · 비밀번호 변경이 막지 않았다(그 등록 조회가 인증 실패로 멈춤)
 *  G1  100회차 결정 98③-2 의 형제: /gpu-physical/test 가 id + 새 비밀번호 + 다른 주소를 받으면 저장 주소로 바꿔 시험했다(입력한 서버 결과처럼 보임)
 *  T1  100회차 남긴 것 ①: 긴급중단 상태 파일 손상 = 멈춤인데 로그인 기능을 끈 설치는 2인 승인 해제가 400 — 화면이 파일 지움 + 재시작을 말한다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb105b-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';   // G1 라우트 시험(adminOnly 통과)

const S = await import('../src/bareos/settings.js');
const { planDirector } = await import('../src/bareos/autoSetup.js');
const { knownFor } = await import('../src/bareos/manage/service.js');
const { planManage } = await import('../src/bareos/manage/apply.js');
const SRC = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));

const HOST = '10.20.0.14';
const rec = (o) => ({ name: o.name, host: o.host, port: o.port ?? 9101, consoleName: o.consoleName || 'portal', password: 'x'.repeat(24), agent: o.agent ?? 'edge1' });
function reset() {
  S._resetForTest();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  S._resetForTest();
}

/* ───────── M1: 접속값 바꾸기로 D1 우회 ───────── */
test('M1: vCenter 가 묶인 등록의 주소 · 포트 · 담당을 다른 등록(다른 vCenter)과 같은 Director 로 바꾸면 거부 — 저장 판정 · 미리 판정 둘 다', () => {
  reset();
  const A = S.addDirector(rec({ name: 'A', host: HOST })).director;
  const B = S.addDirector(rec({ name: 'B', host: '10.20.0.99', consoleName: 'portal-b' })).director;
  const P = S.addDirector(rec({ name: 'P', host: HOST, port: 9102, consoleName: 'portal-p' })).director;
  const E = S.addDirector(rec({ name: 'E', host: HOST, consoleName: 'portal-e', agent: 'edge2' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: A.id }, { vcenterId: 'vc-b', directorId: B.id }, { vcenterId: 'vc-p', directorId: P.id }, { vcenterId: 'vc-e', directorId: E.id }] });
  // 주소를 A 와 같게
  assert.throws(() => S.updateDirector(B.id, { host: HOST }), (e) => e.code === 'invalid' && /‘A’/.test(e.message) && /vc-b/.test(e.message) && /vc-a/.test(e.message));
  assert.throws(() => S.checkDirectorUpdate(B.id, { host: HOST }), /같은 Director/, '엣지 대행 자동 설정이 원격을 바꾸기 전에 보는 미리 판정도 같다');
  // 포트를 A 와 같게(같은 주소 · 다른 포트였던 등록)
  assert.throws(() => S.updateDirector(P.id, { port: 9101 }), /‘A’/);
  // 담당을 A 와 같게(같은 주소 · 다른 엣지였던 등록)
  assert.throws(() => S.updateDirector(E.id, { agent: 'edge1' }), /‘A’/);
  // 거부한 뒤 파일은 그대로 — 같은 Director 묶음 없음
  assert.equal(S.directorEndpointPeers(S.loadSettings().directors).size, 0);
});

test('M1: 정상 경로는 막지 않는다 — vCenter 없는 등록 · 이미 같은 Director 이던 옛 짝 · 다른 주소로 옮김 · 설치 4단계 재등록(bindCheck:false)', () => {
  reset();
  const A = S.addDirector(rec({ name: 'A', host: HOST })).director;
  const C = S.addDirector(rec({ name: 'C', host: '10.20.0.77', consoleName: 'portal-c' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: A.id }] });
  // vCenter 가 묶이지 않은 등록은 같은 Director 로 와도 된다(콘솔 등록 하나 더 — 104 와 같다)
  S.updateDirector(C.id, { host: HOST });
  assert.deepEqual(S.directorEndpointPeers(S.loadSettings().directors).get(A.id), [C.id]);
  // 옛 짝(이미 같은 Director 로 묶여 저장된 것): 다른 칸(시한 · 비밀번호) 저장 · 같은 Director 안에서 주소 표기 바꾸기는 그대로
  reset();
  const A2 = S.addDirector(rec({ name: 'A2', host: HOST })).director;
  const B2 = S.addDirector(rec({ name: 'B2', host: HOST, consoleName: 'portal-b' })).director;
  S._seedLegacySitesForTest([{ vcenterId: 'vc-a', directorId: A2.id }, { vcenterId: 'vc-b', directorId: B2.id }]);
  S.updateDirector(B2.id, { timeoutMs: 20_000 });
  S.updateDirector(B2.id, { host: HOST, password: 'y'.repeat(24) });
  // 서로 다른 Director 였던 서비스 둘(법인 1 : 서비스 N) — 다른 서버로 옮기는 것은 막지 않는다
  reset();
  const K1 = S.addDirector(rec({ name: 'svc1', host: '10.30.0.1' })).director;
  const K2 = S.addDirector(rec({ name: 'svc2', host: '10.30.0.2', consoleName: 'portal-2' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-1', directorId: K1.id }, { vcenterId: 'vc-2', directorId: K2.id }] });
  S.updateDirector(K2.id, { host: '10.30.0.3' });
  // 완전 설치 4단계 재등록은 판정을 건너뛴다(사전 점검이 같은 서버의 다른 등록을 이미 확인 — 0단계 초기화 뒤 4단계에서 멈추지 않게)
  assert.throws(() => S.updateDirector(K2.id, { host: '10.30.0.1' }), /svc1/);
  S.updateDirector(K2.id, { host: '10.30.0.1' }, { bindCheck: false });
  const job = SRC('bareos/install/job.js');
  assert.match(job, /if \(existing\) return updateDirector\(existing\.id, v, \{ bindCheck: false \}\);/);
});

test('M1: 자동 설정(중앙 직접)은 원격을 바꾸기 전 입력 판정(planDirector)에서 같은 판정으로 거부 — 엣지 대행 · 완전 설치(ctx)는 그 경로의 판정을 쓴다', () => {
  reset();
  S.saveSettings({ defaults: { fileSet: 'VMwareFS', jobDefs: 'VMwareJobDefs', restoreJob: 'RestoreVM' } });
  const A = S.addDirector(rec({ name: 'A', host: HOST })).director;
  const B = S.addDirector(rec({ name: 'B', host: '10.20.0.99', consoleName: 'portal-b' })).director;
  S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: A.id }, { vcenterId: 'vc-b', directorId: B.id }] });
  const body = { directorId: B.id, host: HOST, password: 'pw-123456', consoleName: 'portal-b2', restoreClient: 'c', restoreStorage: 's', restorePool: 'p' };
  assert.throws(() => planDirector(body), (e) => e.code === 'invalid' && /‘A’/.test(e.message));
  // 다른 서버로의 자동 설정은 그대로
  assert.equal(planDirector({ ...body, host: '10.20.0.98' }).dir.id, B.id);
  // ctx(엣지 · 완전 설치)는 중앙 sites 가 없다 — 이 판정을 하지 않는다(엣지 대행은 중앙 checkDirectorUpdate 가 보내기 전에 본다)
  assert.equal(planDirector(body, { dir: S.directorById(B.id), cur: { directors: S.loadSettings().directors, defaults: S.loadSettings().defaults } }).dir.id, B.id);
  const route = SRC('routes/api/bareosBackup.js');
  assert.match(route, /checkDirectorUpdate\(d\.id, conn\);/, '엣지 대행 2단계는 보내기 전에 checkDirectorUpdate(같은 판정)');
});

/* ───────── M2: 같은 Director 의 다른 등록이 붙는 콘솔 ───────── */
test('M2: 법인별 설정의 계정 삭제 · 비밀번호 변경이 같은 Director 를 가리키는 다른 포탈 등록의 전용 콘솔을 막는다(판정 하나 directorEndpointPeers)', () => {
  const settings = {
    directors: [
      { id: 'dA', name: 'A', host: HOST, port: 9101, consoleName: 'portal', agent: 'edge1' },
      { id: 'dB', name: 'B', host: HOST, port: 9101, consoleName: 'portal-b', agent: 'edge1' },
      { id: 'dX', name: 'X', host: HOST, port: 9101, consoleName: 'portal-x', agent: 'edge-other' },   // 담당이 다르면 같은 Director 로 보지 않는다(104 규칙)
    ],
    sites: [],
  };
  const cfg = { results: { consoles: { ok: true, value: [{ name: 'portal' }, { name: 'portal-b' }, { name: 'portal-x' }, { name: 'ops' }] }, storages: { ok: true, value: [] }, profiles: { ok: true, value: [{ name: 'webui-admin' }] } } };
  const known = knownFor(settings.directors[0], cfg, settings, []);
  assert.deepEqual(known.peerConsoles, ['portal-b']);
  for (const act of ['console.delete', 'console.password']) {
    assert.throws(() => planManage(act, { name: 'PORTAL-B' }, known), /다른 포탈 등록이 붙는 전용 콘솔/, act);
    assert.throws(() => planManage(act, { name: 'portal' }, known), /전용 콘솔/, `${act} — 자기 등록 콘솔(예전 그대로)`);
    assert.equal(planManage(act, { name: 'ops' }, known).name, 'ops', `${act} — 사람 계정은 그대로`);
    assert.equal(planManage(act, { name: 'portal-x' }, known).name, 'portal-x', `${act} — 담당이 다른 등록은 같은 Director 로 단정하지 않는다`);
  }
  // 옛 엣지(peerConsoles 를 모르는 known)도 예전처럼 동작
  assert.equal(planManage('console.delete', { name: 'portal-b' }, { portalConsole: 'portal' }).name, 'portal-b');
  // 통합 계정 목록도 같은 판정으로 포탈 콘솔 표지(일괄 변경 이름 목록에서 빠진다)
  const svc = SRC('bareos/manage/service.js');
  assert.match(svc, /portalConsole: lc\(x\.name\) === lc\(d\.consoleName\) \|\| peers\.some\(/);
  assert.match(svc, /peerConsoles: peerConsoleNames\(d, settings\)/);
});

/* ───────── T1: 긴급중단 손상 + 인증 꺼짐 ───────── */
test('T1: 긴급중단 손상 안내가 로그인 기능을 끈 설치의 해제 길(상태 파일 지움 + 재시작)을 말한다 — 서버는 인증이 꺼지면 2인 승인을 400 으로 거절', () => {
  const route = SRC('routes/admin/statusTools.js');
  assert.match(route, /if \(!config\.auth\.enabled\) return res\.status\(400\)/, '전제: 인증을 끈 설치는 2인 승인 해제를 쓸 수 없다');
  const es = SRC('security/emergencyStop.js');
  assert.match(es, /r\.kind === 'missing'\) \{ state = \{ active: false/, '전제: 파일이 없으면 비활성으로 시작한다(지움 + 재시작 = 해제)');
  const web = fs.readFileSync(new URL('../../web/src/views/tools/ShutdownTool.jsx', import.meta.url), 'utf8');
  const i = web.indexOf('긴급중단 상태 파일이 손상되어');
  assert.ok(i > 0);
  const block = web.slice(i, web.indexOf('</div>', i));
  assert.match(block, /‘AUTH_ENABLED=false’/);
  assert.match(block, /‘emergency-stop\.json’/);
  assert.match(block, /재시작/);
  const visible = block.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  assert.equal(/`/.test(visible), false, '화면 문구에 백틱 금지');
});

/* ───────── G1: /gpu-physical/test — 새 비밀번호를 준 시험은 본문 주소로 ───────── */
test('G1: /gpu-physical/test — id + 새 비밀번호 + 다른 주소는 입력한 주소로 시험(저장 비밀 승계 없음) · 비밀번호 없이 id 만이면 저장 주소', async () => {
  const express = (await import('express')).default;
  const { registerGpuGuest } = await import('../src/routes/admin/gpuGuest.js');
  const preg = await import('../src/gpu/physicalRegistry.js');
  const gs = await import('../src/gpu/settings.js');
  gs.saveGpuGuestSettings({ timeoutMs: 1_500 });
  const add = preg.addPhysical({ id: 'pg105', host: '10.255.255.1', port: 22, username: 'gpuops', password: 'saved-pw-105' });
  assert.equal(add.ok, true, JSON.stringify(add));
  const app = express(); app.use(express.json());
  const rt = express.Router(); registerGpuGuest(rt); app.use('/api/admin', rt);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const post = async (body) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/gpu-physical/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const typed = await post({ id: 'pg105', host: '10.255.255.3', username: 'root', port: 2222, password: 'typed-pw' });
    assert.notEqual(typed.method, 'carry-refused');
    assert.equal(typed.host, '10.255.255.3', '입력한 주소');
    assert.equal(typed.port, 2222, '입력한 포트');
    const blanks = await post({ id: 'pg105', password: 'typed-pw' });
    assert.equal(blanks.host, '10.255.255.1', '빈 칸은 저장값');
    assert.equal(blanks.port, 22);
    const saved = await post({ id: 'pg105' });
    assert.equal(saved.host, '10.255.255.1', '저장 비밀번호 시험은 저장 주소(예전 그대로)');
    const refused = await post({ id: 'pg105', host: '10.255.255.3' });
    assert.equal(refused.method, 'carry-refused', '100회차 규칙 그대로');
  } finally { srv.close(); }
});
