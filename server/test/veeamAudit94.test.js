/**
 * test/veeamAudit94.test.js — 전체 점검 94회차(Veeam B&R · Enterprise Manager · 실행 run · 관리 2차).
 *
 *  F1 (87회차 85 E2 확정) veeam/registry.js applyPulledServers 가 db.servers 를 **쓰기 전에** 바꿨다 — 저장 실패(ENOSPC · 봉인 정책 잠금 · EISDIR) 뒤
 *     다음 pull 의 removed · moved 가 비어 빠진 서버의 결과 · 인증 정지가 남고, 접속처를 고친 서버가 옛 접속처의 인증 정지로 계속 멈췄다.
 *     같은 꼴: saveServer · deleteServer · em/registry.js saveEm · deleteEm(실패 400 인데 폴러는 새 접속처 · 비밀번호로 돎) ·
 *     snapEvents saveManualAccounts · applyPulledAccountsEx(실패한 적용을 메모리에 남겨 다음 pull 이 'same' 으로 끝내 쓰지 않음) · run/settings saveRunSettings.
 *  F2 결정 G2(읽기 오류 ≠ 손상)의 형제 꼴이 Veeam 저장 파일 아홉 곳에 남아 있었다 — 읽기 · JSON.parse 를 catch 하나로 받아 **읽기 오류**도 손상으로 보고
 *     온전한 원본을 `.corrupt.*` 로 옮겼다: backup-marks(VM 정책 · 중요도 · 메모 최대 5만) · veeam-backup-run(서버별 저장소) · veeam-backup-runs
 *     (진행 중 실행 — 409 가드가 풀려 같은 서버로 다시 보낼 수 있었다) · veeam-vc-accounts(재시작 뒤 빈 목록이 엣지로 내려감) · veeam-em-map ·
 *     vm-list-prefs · veeam-portal-vms · veeam-em-vms · backup-stale-alert.
 *  I1 agent/veeamRunWorker.js 회신 · 인출 오류 본문을 상한 없는 res.json() 으로 읽었다(85 E3 형제 — readJsonCapped).
 * 재현은 EISDIR(파일 자리에 디렉터리 — root 컨테이너에서 EACCES 를 만들 수 없어 같은 갈래인 읽기 단계 실패로 본다 · 78 · 92회차와 같은 방법).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamAudit94-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'live' });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { config } = await import('../src/config.js');
const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileRead.js');
// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(재읽기 간격 30초를 시계로 넘긴다).
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
_setJsonFileLoadClockForTest(() => NOW);
after(() => _setJsonFileLoadClockForTest());
const tick = () => { NOW += 31_000; };

const file = (n) => path.join(TMP, n);
const corruptCopies = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
/** 파일 자리에 디렉터리를 둔다 — readFileSync 는 EISDIR(읽기 단계 실패), 원자적 쓰기의 rename 도 EISDIR 로 던진다. */
function makeUnreadable(n) { try { fs.rmSync(file(n), { recursive: true, force: true }); } catch { /* */ } fs.mkdirSync(file(n)); }
function restore(n, body) { fs.rmSync(file(n), { recursive: true, force: true }); if (body != null) fs.writeFileSync(file(n), body); }
const intact = (n) => { assert.ok(fs.statSync(file(n)).isDirectory(), `${n}: 원본 자리를 옮기지 않았다`); assert.equal(corruptCopies(n).length, 0, `${n}: 읽기 오류는 손상 보존본을 만들지 않는다`); };
async function quiet(fn) {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
}
const S = (id, host) => ({ id, name: id, host, port: 9419, username: 'svc', password: 'pw', vcenterIds: ['vc1'] });

test('94 F1 applyPulledServers — 저장 실패면 메모리는 이전 목록 그대로 · 다음 pull 이 removed · moved 를 다시 계산한다(87회차 85 E2 확정)', async () => {
  const reg = await import('../src/veeam/registry.js');
  config.agent.name = 'edge1';
  reg._resetForTest(); restore('veeam-servers.json', null);
  await quiet(() => {
    assert.deepEqual(reg.applyPulledServers([S('A', '10.0.0.1'), S('B', '10.0.0.2')]).removed, []);
    makeUnreadable('veeam-servers.json');   // 쓰기(rename)가 EISDIR 로 실패한다
    assert.throws(() => reg.applyPulledServers([S('A', '10.0.0.9')]), (e) => e.code === 'EISDIR');
    assert.deepEqual(reg.listServers().map((d) => `${d.id}@${d.host}`).sort(), ['A@10.0.0.1', 'B@10.0.0.2'], '실패한 적용은 메모리에 남지 않는다');
    restore('veeam-servers.json', null);
    const r = reg.applyPulledServers([S('A', '10.0.0.9')]);
    assert.deepEqual(r.removed, ['B'], '빠진 서버를 다시 알린다(결과 · 인증 정지를 지울 수 있게)');
    assert.deepEqual(r.moved, ['A'], '접속처가 바뀐 서버를 다시 알린다(옛 접속처 인증 정지를 풀 수 있게)');
  });
});

test('94 F1 saveServer · deleteServer · saveEm · deleteEm — 쓰기 실패면 메모리의 접속처 · 비밀번호 · 목록이 그대로', async () => {
  const reg = await import('../src/veeam/registry.js');
  const em = await import('../src/veeam/em/registry.js');
  config.agent.name = '';
  reg._resetForTest(); restore('veeam-servers.json', null);
  em._resetEmRegistryForTest(); restore('veeam-em.json', null);
  await quiet(() => {
    const d = reg.saveServer({ name: 'vbr1', host: '10.1.0.1', username: 'svc', password: 'old-pw', vcenterIds: ['vc1'] });
    makeUnreadable('veeam-servers.json');
    assert.throws(() => reg.saveServer({ id: d.id, name: 'vbr1', host: '10.1.0.2', username: 'svc', password: 'new-pw', vcenterIds: ['vc1'] }));
    const cur = reg.getServerWithSecret(d.id);
    assert.equal(cur.host, '10.1.0.1', '저장에 실패한 새 접속처로 돌지 않는다');
    assert.equal(cur.password, 'old-pw');
    assert.throws(() => reg.saveServer({ name: 'vbr2', host: '10.1.0.3', username: 'svc', password: 'pw', vcenterIds: ['vc1'] }));
    assert.equal(reg.listServers().length, 1, '실패한 추가는 목록에 남지 않는다');
    assert.throws(() => reg.deleteServer(d.id));
    assert.ok(reg.getServerWithSecret(d.id), '실패한 삭제는 메모리에서 빠지지 않는다');
    restore('veeam-servers.json', null);

    const e = em.saveEm({ name: 'em1', host: '10.2.0.1', username: 'svc', password: 'old-pw' });
    makeUnreadable('veeam-em.json');
    assert.throws(() => em.saveEm({ id: e.id, name: 'em1', host: '10.2.0.2', username: 'svc', password: 'new-pw' }));
    assert.equal(em.getEmWithSecret(e.id).host, '10.2.0.1');
    assert.equal(em.getEmWithSecret(e.id).password, 'old-pw');
    assert.throws(() => em.deleteEm(e.id));
    assert.ok(em.getEmWithSecret(e.id));
    restore('veeam-em.json', null);
    assert.equal(em.saveEm({ id: e.id, name: 'em1', host: '10.2.0.2', username: 'svc' }).moved, true, '되살아난 뒤 저장은 예전처럼(접속처 변경)');
  });
});

test('94 F2 backupMarks — 읽기 오류는 원본을 옮기지 않고 저장 거절 · 30초 뒤 다시 읽어 풀린다 · 손상은 예전처럼 보존', async () => {
  const BM = await import('../src/veeam/backupMarks.js');
  const body = JSON.stringify({ 'vc1:vm-1': { crit: 'high', method: 'veeam', need: true, memo: 'm', name: 'a', vcenterId: 'vc1' } });
  BM._resetMarksForTest(); fs.writeFileSync(file('backup-marks.json'), body);
  makeUnreadable('backup-marks.json');
  await quiet(() => {
    const rev0 = BM.marksRev();
    assert.equal(BM.marksUnreadable(), true, '읽기 오류 동안은 모름(수는 null)');
    assert.ok(BM.marksRev() > rev0, '상태가 바뀌면 응답 캐시 키가 바뀐다');
    const w = BM.setMarks([{ id: 'vc1:vm-2', name: 'b', vcenterId: 'vc1' }], { crit: 'low' }, { username: 'op' });
    assert.equal(w.ok, false); assert.equal(w.status, 503); assert.equal(w.readError, true);
    intact('backup-marks.json');
    restore('backup-marks.json', body);
    assert.equal(BM.marksUnreadable(), true, '간격(30초) 안에는 디스크를 다시 보지 않는다');
    tick();
    assert.equal(BM.marksUnreadable(), false, '읽히면 재시작 없이 풀린다');
    assert.equal(BM.getMarks()['vc1:vm-1'].memo, 'm', '원본 그대로');
    // 손상은 예전과 같다
    BM._resetMarksForTest(); fs.writeFileSync(file('backup-marks.json'), '{"x":');
    assert.equal(BM.marksUnreadable(), true);
    assert.equal(corruptCopies('backup-marks.json').length, 1, '손상만 보존본으로 옮긴다');
  });
});

test('94 F2 run/settings — 읽기 오류는 원본을 옮기지 않고 저장 409 · 읽히면 서버별 저장소가 그대로', async () => {
  const st = await import('../src/veeam/run/settings.js');
  const body = JSON.stringify({ version: 1, jobPrefix: 'PORTAL-', servers: { 'vbr-1': { repositoryId: 'repo-1', retention: 9 } }, hosts: {} });
  st._resetForTest(); fs.writeFileSync(file('veeam-backup-run.json'), body);
  makeUnreadable('veeam-backup-run.json');
  await quiet(() => {
    assert.equal(st.settingsLoadError()?.readError, true);
    const r = st.saveRunSettings({ jobPrefix: 'X-' });
    assert.equal(r.ok, false); assert.equal(r.status, 409);
    intact('veeam-backup-run.json');
    restore('veeam-backup-run.json', body); tick();
    assert.equal(st.settingsLoadError(), null);
    assert.equal(st.serverRunSettings('vbr-1').repositoryId, 'repo-1');
    assert.equal(st.saveRunSettings({ jobPrefix: 'X-' }).ok, true, '읽히면 저장이 다시 열린다(서버별 값은 합친다)');
    assert.equal(st.serverRunSettings('vbr-1').retention, 9);
  });
});

test('94 F2 runs — 실행 기록 읽기 오류면 모든 서버를 바쁨으로(이중 실행 방지) · 원본 유지 · 읽히면 진행 중 실행을 잇는다', async () => {
  const runs = await import('../src/veeam/run/runs.js');
  const run = { id: 'vbr_live', at: NOW, user: 'op', mode: 'quick', status: 'running',
    groups: [{ serverId: 'vbr-1', serverName: 'vbr1', kind: 'quick', vcenterId: 'vc1', state: 'running', sessions: [{ id: 's1', objectIds: ['vm-1'], finished: false }] }],
    vms: [{ vmId: 'vc1:vm-1', name: 'a', vcenterId: 'vc1', objectId: 'vm-1', serverId: 'vbr-1', how: 'quick', state: 'running', sessionId: 's1' }] };
  const body = JSON.stringify({ version: 1, runs: [run] });
  makeUnreadable('veeam-backup-runs.json');
  runs._resetForTest();   // 재시작과 같다(파일 자리는 디렉터리 그대로)
  await quiet(() => {
    assert.equal(runs.serverBusy('vbr-1')?.kind, 'runs-unreadable', '진행 중 실행을 모른다 — 바쁨');
    assert.equal(runs.serverBusy('vbr-2')?.kind, 'runs-unreadable', '다른 서버도 — 어느 서버가 도는지 모른다');
    assert.equal(runs.claimServer('vbr-2', 'exclude'), null, '빼기 · 삭제 자리도 차지하지 않는다');
    assert.throws(() => runs.startRun({ vms: [], groups: [] }));
    intact('veeam-backup-runs.json');
    restore('veeam-backup-runs.json', body); tick();
    assert.equal(runs.serverBusy('vbr-1')?.id, 'vbr_live', '읽히면 그 실행이 다시 409 를 건다');
    assert.equal(runs.serverBusy('vbr-2'), null);
    assert.equal(runs.getRun('vbr_live').status, 'running', '세션을 받은 실행은 추적을 잇는다');
  });
  fs.rmSync(file('veeam-backup-runs.json'), { force: true });
});

test('94 F2 · F1 snapEvents 계정 — 읽기 오류는 원본 유지 · 학습은 건너뜀 · pull 적용은 오류 · 쓰기 실패한 pull 은 메모리에 남지 않는다', async () => {
  const S2 = await import('../src/veeam/snapEvents.js');
  const body = JSON.stringify({ manual: ['CORP\\svc-veeam'], pulled: ['p1'], learned: {}, forgotten: {} });
  S2._resetForTest(); fs.writeFileSync(file('veeam-vc-accounts.json'), body);
  makeUnreadable('veeam-vc-accounts.json');
  await quiet(() => {
    assert.equal(S2.accountsUnreadable(), true, '중앙은 pull 에 계정을 싣지 않는다(빈 목록을 내려보내지 않음)');
    assert.equal(S2.rememberLearned([{ account: 'x', vm: 'a' }, { account: 'x', vm: 'b' }], NOW), 0, '학습 반영은 건너뛴다(요약은 계속)');
    assert.throws(() => S2.applyPulledAccountsEx(['p2']), (e) => e.code === 'accounts-unreadable');
    intact('veeam-vc-accounts.json');
    restore('veeam-vc-accounts.json', body); tick();
    assert.equal(S2.accountsUnreadable(), false);
    assert.deepEqual(S2.accountView(NOW).manual, ['CORP\\svc-veeam'], '사람이 적은 계정이 그대로');
    // F1 형제: 캐시가 있는 상태에서 쓰기 실패 — 메모리를 되돌린다
    makeUnreadable('veeam-vc-accounts.json');
    assert.throws(() => S2.applyPulledAccountsEx(['p2']));
    assert.deepEqual(S2.accountView(NOW).pulled, ['p1'], '실패한 적용을 메모리에 남기지 않는다');
    assert.throws(() => S2.saveManualAccounts(['n1']));
    assert.deepEqual(S2.accountView(NOW).manual, ['CORP\\svc-veeam']);
    restore('veeam-vc-accounts.json', body);
    assert.equal(S2.applyPulledAccountsEx(['p2']).changed, true, '다음 pull 이 다시 적용해 파일에 쓴다');
    assert.deepEqual(JSON.parse(fs.readFileSync(file('veeam-vc-accounts.json'), 'utf8')).pulled, ['p2']);
  });
});

test('94 F2 EM 매핑 · VM 목록 저장값 · 포탈 백업 VM · EM VM 기록 · 메일 설정 — 읽기 오류는 원본 유지 · 쓰기 거절/건너뜀 · 읽히면 그대로', async () => {
  const M = await import('../src/veeam/em/mapping.js');
  const P = await import('../src/veeam/vmListPrefs.js');
  const PV = await import('../src/veeam/run/portalVms.js');
  const V = await import('../src/veeam/em/vmStore.js');
  const A = await import('../src/veeam/staleAlert.js');
  const bodies = {
    'veeam-em-map.json': JSON.stringify({ v: 1, servers: { 'em1|bs1': { vcenterIds: ['vc1'], br: '', server: 'bs1', by: 'op', at: 'x' } } }),
    'vm-list-prefs.json': JSON.stringify({ v: 1, users: { 'u:op': { def: null, slots: [], at: 'x' } } }),
    'veeam-portal-vms.json': JSON.stringify({ version: 1, vms: [{ vmId: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', jobName: 'PORTAL-x', lastAt: 1 }] }),
    'veeam-em-vms.json': JSON.stringify({ v: 1, ems: { em1: { since: 1, target: 't', vms: { 'bs1|a': { lt: { e: 1 } } } } } }),
    'backup-stale-alert.json': JSON.stringify({ enabled: true, time: '07:15', q: { n: 3, unit: 'd' }, savedBy: 'op', savedAt: 1 }),
  };
  M._resetEmMapForTest(); P._resetVmListPrefsForTest(); PV._resetForTest(); V._resetEmVmsForTest(); A._resetForTest();
  for (const n of Object.keys(bodies)) makeUnreadable(n);
  await quiet(() => {
    assert.equal(M.emMapUnreadable(), true);
    assert.equal(M.setEmMap({ emId: 'em1', server: 'bs2', vcenterIds: ['vc1'] }, { knownVcenters: ['vc1'] }).status, 503);
    assert.equal(P.prefsUnreadable(), true);
    assert.equal(P.clearPref('op', 1).status, 503);
    assert.equal(PV.getPortalVm('vc1:vm-1'), null);
    PV.notePortalRun({ id: 'r1', at: NOW, groups: [{ serverId: 'vbr-1', kind: 'portal', vcenterId: 'vc1', jobName: 'PORTAL-x' }],
      vms: [{ vmId: 'vc1:vm-9', vcenterId: 'vc1', name: 'z', serverId: 'vbr-1', how: 'portal', state: 'running' }] });   // 임시 빈 목록 위의 한 건 — 쓰지 않는다
    assert.equal(V.getEmVms('em1'), null);
    V.dropEmVms('em1');
    assert.throws(() => V.mergeEmVms('em1', 't', { since: 1, tasks: [], points: [], complete: true }, { startedAt: NOW }), '읽기 오류 중에는 합치지 않는다(폴러가 storeError)');
    assert.equal(A.alertLoadError()?.readError, true, '메일은 보내지 않고 저장을 막는다');
    assert.throws(() => A.saveAlert({ time: '09:00', q: { n: 1, unit: 'd' } }), (e) => e.code === 'unreadable');
    for (const n of Object.keys(bodies)) intact(n);
    for (const [n, b] of Object.entries(bodies)) restore(n, b);
    tick();
    assert.equal(M.emMapUnreadable(), false); assert.ok(M.getEmMap()['em1|bs1']);
    assert.equal(P.prefsUnreadable(), false);
    assert.equal(PV.getPortalVm('vc1:vm-1')?.jobName, 'PORTAL-x');
    assert.equal(PV.getPortalVm('vc1:vm-9'), null, '읽기 오류 동안의 변경은 원본을 덮지 않았다');
    assert.ok(V.getEmVms('em1'), 'EM VM 기록이 그대로');
    assert.equal(A.alertLoadError(), null); assert.equal(A.loadAlert().time, '07:15');
  });
});

test('94 I1 Veeam 실행 대행 워커 — 중앙 응답 본문은 상한 있는 읽기(readJsonCapped)만', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/agent/veeamRunWorker.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /\.json\(\)/, 'res.json() 은 본문 상한이 없다');
  assert.match(src, /readJsonCapped\(r, 64 \* 1024/);
});

test('94 F3 licenseWatch — 이번 목록에서 빠진(아직 못 읽은) 등록 서버의 단계를 지우지 않는다 · 다시 읽혀도 같은 알림을 다시 보내지 않는다', async () => {
  const LW = await import('../src/veeam/licenseWatch.js');
  const DAY = 86_400_000;
  const keep = new Set(['vbr-1']);
  const it = (exp) => [{ id: 'vbr-1', name: 'v1', license: { expires: exp, supportExpires: null } }];
  let r = LW.evaluateLicenses(it(NOW + 20 * DAY), {}, NOW, { keep });
  assert.equal(r.fires.length, 1, 'D-30 단계 처음 — 한 번 알린다');
  r = LW.evaluateLicenses([], r.next, NOW, { keep });   // 재시작 뒤 첫 수집 전 · 실패 중이며 마지막 성공분 없음
  assert.deepEqual(Object.keys(r.next), ['vbr-1:lic'], '못 읽은 동안 단계를 그대로 둔다');
  r = LW.evaluateLicenses(it(NOW + 20 * DAY), r.next, NOW, { keep });
  assert.equal(r.fires.length, 0, '다시 읽혀도 같은 단계 알림을 다시 보내지 않는다');
  r = LW.evaluateLicenses([], r.next, NOW, { keep: new Set() });
  assert.deepEqual(r.next, {}, '등록부에서 지운 서버의 상태는 지운다(파일이 끝없이 자라지 않게)');
});
