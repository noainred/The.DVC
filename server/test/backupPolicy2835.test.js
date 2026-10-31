/**
 * test/backupPolicy2835.test.js — v2.835 백업 메뉴 개편 1차(사용자 요청 + 시안 ②): 백업 정책 · 실제 백업 · 정책≠실제 · 마지막 성공 · 24시간 실패 · 백업 안 된 VM 찾기.
 *   ① 판정 코어(veeam/backupPolicy.js) — 못 읽은 쪽은 모름(null) · 한쪽을 모르면 불일치·한 번도 없음으로 단정하지 않는다
 *   ② 정책 쓰기 규칙 — 5범주만 새로 저장(clone·config 는 400 · 파일에 남은 값은 읽기 그대로 · 화면은 '확인 필요')
 *   ③ 라우트 — Detail 행에 p · a · mm · lok · e · nx · os · 보기 필터(act-* · mismatch · policy-* · rpo-miss · os-*) · Bareos 그룹 다음 회차
 *   ④ 웹 staleOf·vmMatches 와 서버가 같은 입력에 같은 답(대조)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2835-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';

const BP = await import('../src/veeam/backupPolicy.js');
const BS = await import('../src/veeam/backupStatus.js');
const BM = await import('../src/veeam/backupMarks.js');
const WEB = await import('../../web/src/views/tools/backupViewText.js');
const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H;
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('① 정책 범주 — 5범주 · 정하지 않음·예전 값(clone·config)은 확인 필요', () => {
  assert.deepEqual([...BP.POLICY_KEYS], ['veeam', 'bareos', 'ssh', 'none', 'check']);
  assert.deepEqual(['veeam', 'bareos', 'ssh', 'none', 'check', '', 'clone', 'config', 'bogus'].map(BP.policyOf), ['veeam', 'bareos', 'ssh', 'none', 'check', 'check', 'check', 'check', 'check']);
  assert.deepEqual([...BM.WRITE_METHOD_VALUES], [...BP.POLICY_KEYS], '새로 저장할 수 있는 값 = 정책 5범주');
  assert.deepEqual(WEB.POLICIES.map((m) => m.key), [...BP.POLICY_KEYS], '웹 정책 목록도 같다');
  assert.deepEqual([...BS.NOT_VEEAM_GAP].sort(), [...BM.NOT_VEEAM_GAP_MARKS].sort());
  assert.deepEqual([...WEB.NOT_VEEAM_GAP].sort(), [...BS.NOT_VEEAM_GAP].sort());
});

test('① 실제 백업 · 정책≠실제 — 모르면 null', () => {
  const A = (row, k = true) => BP.actualOf(row, { bareosKnown: k });
  assert.deepEqual(A({}), { v: null, b: false }, 'v 키 없음 = Veeam 모름 · 원장을 읽었고 b 없음 = Bareos 잡 없음');
  assert.deepEqual(A({ v: null }), { v: false, b: false });
  assert.deepEqual(A({ v: { lb: 1 }, b: { job: true } }), { v: true, b: true });
  assert.deepEqual(A({ v: null, b: { job: false } }), { v: false, b: false }, '정책 Bareos 인데 잡 없음(미등록)');
  assert.deepEqual(A({ v: null }, false), { v: false, b: null }, '원장을 못 읽으면 Bareos 모름');
  assert.deepEqual(A({ v: null, b: null }), { v: false, b: null }, '행 b:null(원장 못 읽음) 도 모름');
  const M = BP.mismatchOf;
  assert.equal(M(null, { v: true, b: true }), null, '정책을 모르면 모름');
  assert.deepEqual(['veeam', 'bareos', 'ssh', 'none', 'check'].map((p) => M(p, { v: true, b: false })), [false, true, false, true, true]);
  assert.deepEqual(['veeam', 'bareos', 'ssh', 'none', 'check'].map((p) => M(p, { v: false, b: false })), [true, true, false, false, false]);
  assert.deepEqual(['veeam', 'bareos', 'none', 'check'].map((p) => M(p, { v: null, b: false })), [null, true, null, null], 'Veeam 을 모르면 그쪽 판정은 모름');
  assert.deepEqual(['veeam', 'bareos', 'none'].map((p) => M(p, { v: false, b: null })), [true, null, null]);
  assert.equal(M('none', { v: null, b: true }), true, '한쪽이 돌면 다른 쪽을 몰라도 불일치');
});

test('① 마지막 성공 · 24시간 실패', () => {
  const L = (row, k = true) => BP.lastOkOf(row, { bareosKnown: k });
  assert.deepEqual(L({ v: { lb: NOW - DAY }, b: { job: true, ok: NOW - H } }), { at: NOW - H, never: false, v: NOW - DAY, b: NOW - H, vk: true, bk: true });
  assert.deepEqual(L({ v: null }), { at: null, never: true, v: null, b: null, vk: true, bk: true }, '둘 다 없음으로 확인 = 한 번도 없음');
  assert.equal(L({}).never, null, 'Veeam 모름이면 한 번도 없음이 아니다');
  assert.equal(L({ v: null }, false).never, null, 'Bareos 원장을 모르면 한 번도 없음이 아니다');
  assert.deepEqual([L({ v: { lb: null, rp: 0 } }).vk, L({ v: { lb: null, rp: 3 } }).vk], [true, false], '대상인데 완료 시각을 모르면 복원 지점 0 일 때만 없음');
  assert.equal(L({ v: null, b: { job: true, ok: null } }).never, true, '잡은 있는데 성공이 한 번도 없음');
  const E = (row) => BP.recentErrorsOf(row, NOW);
  assert.deepEqual(E({ v: { lr: 'Failed', lrt: NOW - H } }), [{ s: 'veeam', r: 'fail', at: NOW - H }]);
  assert.deepEqual(E({ v: { lr: 'Warning', lrt: NOW - 2 * DAY } }), [], '24시간 밖');
  assert.deepEqual(E({ v: { lr: 'Failed' } }), [], '끝난 시각을 모르면 넣지 않는다');
  assert.deepEqual(E({ b: { job: true, st: 'canceled', at: NOW - H } }), [{ s: 'bareos', r: 'fail', at: NOW - H }], '취소는 실패로 센다');
  assert.deepEqual(E({ b: { job: true, st: 'warning', at: NOW - H } }), [{ s: 'bareos', r: 'warn', at: NOW - H }]);
  assert.deepEqual(E({ b: { job: true, st: 'ok', at: NOW - H } }), []);
  const f = BP.policyFields({ v: null, m: { method: 'clone' } }, { now: NOW });
  assert.deepEqual([f.p, f.mm, 'e' in f], ['check', false, false], '예전 값은 확인 필요 · 실패가 없으면 e 키 없음');
  assert.equal(BP.policyFields({ v: null }, { marksKnown: false, now: NOW }).p, null, '표시 파일을 못 읽으면 정책 모름');
});

// 찾기 판정 대조용 입력(웹 staleOf 와 같은 답이어야 한다)
const SV = (o) => ({ power: 'POWERED_ON', p: 'veeam', lok: { at: null, never: null, v: null, b: null, vk: true, bk: true }, ...o });
const STALE_CASES = [
  ['최근 성공', SV({ lok: { v: NOW - H, b: null, vk: true, bk: true } })],
  ['오래됨', SV({ lok: { v: NOW - 5 * DAY, b: null, vk: true, bk: true } })],
  ['한 번도 없음', SV({})],
  ['Veeam 모름 + Bareos 없음', SV({ lok: { v: null, b: null, vk: false, bk: true } })],
  ['Veeam 모름 + Bareos 최근 성공', SV({ lok: { v: null, b: NOW - H, vk: false, bk: true } })],
  ['Veeam 오래 + Bareos 모름', SV({ lok: { v: NOW - 9 * DAY, b: null, vk: true, bk: false } })],
  ['백업 안함', SV({ p: 'none' })],
  ['꺼진 VM', SV({ power: 'POWERED_OFF' })],
  ['Bareos 만 최근', SV({ lok: { v: NOW - 9 * DAY, b: NOW - H, vk: true, bk: true } })],
  ['결과 필드 없음(옛 모양)', { power: 'POWERED_ON' }],
];

test('① 백업 안 된 VM 찾기 — 창 안 성공이면 대상 아님 · 모르면 unknown · 범위(백업 안함·꺼짐) · 기준(Veeam 만·Bareos 만)', () => {
  const S = (vm, o = {}) => BP.staleOf(vm, { windowMs: 3 * DAY, now: NOW, ...o });
  const by = Object.fromEntries(STALE_CASES.map(([n, vm]) => [n, S(vm)]));
  assert.equal(by['최근 성공'], null);
  assert.deepEqual(by['오래됨'], { kind: 'old', last: NOW - 5 * DAY });
  assert.deepEqual(by['한 번도 없음'], { kind: 'never', last: null });
  assert.deepEqual(by['Veeam 모름 + Bareos 없음'], { kind: 'unknown', last: null });
  assert.equal(by['Veeam 모름 + Bareos 최근 성공'], null, '창 안에 아는 성공이 있으면 다른 쪽을 몰라도 대상 아님');
  assert.deepEqual(by['Veeam 오래 + Bareos 모름'], { kind: 'unknown', last: NOW - 9 * DAY });
  assert.equal(by['백업 안함'], null);
  assert.equal(by['꺼진 VM'], null);
  assert.equal(S(STALE_CASES[6][1], { excludeNone: false })?.kind, 'never', '백업 안함 제외를 끄면 찾는다');
  assert.equal(S(STALE_CASES[7][1], { onlyOn: false })?.kind, 'never');
  assert.equal(by['Bareos 만 최근'], null);
  assert.deepEqual(S(STALE_CASES[8][1], { src: 'veeam' }), { kind: 'old', last: NOW - 9 * DAY }, 'Veeam 만 기준이면 Bareos 성공은 보지 않는다');
  assert.equal(S(STALE_CASES[8][1], { src: 'bareos' }), null);
  assert.equal(S(STALE_CASES[2][1], { includeNever: false }), null);
  assert.equal(BP.staleOf(SV({}), { windowMs: 0, now: NOW }), null, '창이 0 이하면 찾지 않는다');
  // 웹과 같은 답(판정을 바꾸면 둘 다)
  for (const [n, vm] of STALE_CASES) {
    for (const o of [{}, { src: 'veeam' }, { src: 'bareos' }, { excludeNone: false, onlyOn: false }, { includeNever: false }, { windowMs: 10 * DAY }]) {
      const opts = { windowMs: 3 * DAY, now: NOW, ...o };
      assert.deepEqual(WEB.staleOf(vm, opts), BP.staleOf(vm, opts), `${n} ${JSON.stringify(o)}`);
    }
  }
  assert.deepEqual([...WEB.STALE_SOURCES], [...BP.STALE_SOURCES]);
});

test('② 정책 쓰기 — 5범주만 새로 저장 · 예전 값은 읽기 그대로', () => {
  BM._resetMarksForTest();
  const vms = [{ id: 'x:1', name: 'a', vcenterId: 'x' }];
  for (const m of ['veeam', 'bareos', 'ssh', 'none', 'check']) assert.equal(BM.setMarks(vms, { method: m }, { username: 'u' }).ok, true, m);
  for (const m of ['clone', 'config', 'tape']) assert.equal(BM.setMarks(vms, { method: m }, { username: 'u' }).status, 400, m);
  assert.equal(BM.setMarks(vms, { method: '' }, { username: 'u' }).ok, true, '지우기는 받는다');
  fs.writeFileSync(path.join(DIR, 'backup-marks.json'), JSON.stringify({ 'x:1': { crit: '', method: 'config', need: false, memo: '' } }));
  BM._resetMarksForTest();
  assert.equal(BM.markView(BM.getMarks()['x:1']).method, 'config', '예전 값은 읽기 그대로');
  assert.equal(BP.policyOf(BM.markView(BM.getMarks()['x:1']).method), 'check');
  fs.rmSync(path.join(DIR, 'backup-marks.json'), { force: true }); BM._resetMarksForTest();
});

test('③ 라우트 — Detail 행에 정책·실제·불일치·마지막 성공·다음 예정·OS · 보기 필터 · 웹 vmMatches 와 같은 VM', async () => {
  const VC = 'vc-p';
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const G = await import('../src/bareos/groups.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: VC, name: VC }], hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'win01', folder: 'DC/vm/A', powerState: 'POWERED_ON', guestOS: 'Microsoft Windows Server 2022 (64-bit)' },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'lin01', folder: 'DC/vm/A', powerState: 'POWERED_ON', guestOS: 'Red Hat Enterprise Linux 9 (64-bit)' },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'off01', folder: 'DC/vm/B', powerState: 'POWERED_OFF', guestOS: 'unknown' },
  ] };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin' }; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const put = (body) => fetch(`${base}/tools/backup-detail/marks`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const detail = async () => (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
  try {
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`], method: 'ssh' })).status, 200);
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-2`], method: 'bareos' })).status, 200);
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-3`], method: 'clone' })).status, 400, '예전 값은 새로 저장하지 않는다');
    // Bareos 그룹(예약 켬) — lin01 의 다음 회차
    const g = G.addGroup({ name: 'nightly', vcenterId: VC, vmIds: [`${VC}:vm-2`], schedule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '23:00', level: 'Incremental', fullDays: [] }, storage: 's', pool: 'p' }, { by: 'adm', directorId: 'dir_x', now: NOW });
    assert.ok(g?.id || g?.group?.id, JSON.stringify(g));
    const d = await detail();
    const by = Object.fromEntries(d.vms.map((v) => [v.name, v]));
    assert.deepEqual([by.win01.p, by.lin01.p, by.off01.p], ['ssh', 'bareos', 'check'], '정하지 않은 VM 은 확인 필요');
    assert.deepEqual([by.win01.os, by.lin01.os, by.off01.os], ['windows', 'linux', null], "OS — 'unknown' 은 모름");
    for (const v of d.vms) {
      assert.ok(v.a && 'v' in v.a && 'b' in v.a, `${v.name} a`);
      assert.ok(v.lok && 'vk' in v.lok && 'bk' in v.lok, `${v.name} lok`);
      assert.ok('mm' in v, `${v.name} mm`);
    }
    assert.deepEqual([by.lin01.a.b, by.lin01.mm], [false, true], '원장은 읽었고(잡 없음) 정책 Bareos 인데 잡이 없으면 불일치');
    assert.equal(by.win01.mm, false, '정책 SSH 는 불일치로 세지 않는다');
    assert.ok(Number.isFinite(by.lin01.nx?.at) && by.lin01.nx.at > NOW && by.lin01.nx.g === 'nightly', JSON.stringify(by.lin01.nx));
    assert.equal('nx' in by.win01, false, '그룹이 없는 VM 은 다음 예정 없음');
    // 보기 필터 — 서버와 웹이 같은 VM
    for (const f of ['policy-ssh', 'policy-bareos', 'policy-check', 'mismatch', 'act-none', 'os-windows', 'os-linux', 'rpo-miss']) {
      const s = d.vms.filter((v) => BS.vmViewMatches(v, f, { rpoDays: 1, now: d.at })).map((v) => v.name).sort();
      const w = d.vms.filter((v) => WEB.vmMatches(v, f, { rpoDays: 1, now: d.at })).map((v) => v.name).sort();
      assert.deepEqual(w, s, f);
    }
    assert.deepEqual(d.vms.filter((v) => BS.vmViewMatches(v, 'policy-check')).map((v) => v.name), ['off01']);
    assert.deepEqual(d.vms.filter((v) => BS.vmViewMatches(v, 'os-windows')).map((v) => v.name), ['win01']);
    // 그룹을 바꾸면 응답 캐시가 낡지 않는다(groupsRev)
    G.deleteGroup(g.id || g.group.id);
    const d2 = await detail();
    assert.equal('nx' in d2.vms.find((v) => v.name === 'lin01'), false, '그룹을 지우면 다음 예정이 바로 사라진다');
  } finally { store.snapshot = prev; }
});
