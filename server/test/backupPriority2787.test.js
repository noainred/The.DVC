/**
 * v2.787 — Veeam 백업 현황 Summary '우선순위 VM — 먼저 볼 것'(사용자 요청 + 시안).
 *  · priorityCandidates(순수): 미백업(gap)은 Veeam 을 알 때만 · 실패 · 하루 넘은 스냅샷 잔존 · 하루 넘은 마지막 백업 · 문제 없는 VM 은 싣지 않는다
 *  · priorityRank: 중요도 상 → 백업 필요 → 나머지 · 같은 단계에서 미백업 → 실패 → 잔존 → 오래된(이른 순) · 웹 priorityView 와 같은 순서
 *  · 라우트: 범위(scope 교집합) 안 VM 만 · Detail 도구가 거부된 계정에는 VM 목록을 싣지 않는다(응답 캐시 키에도 든다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2787-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // Veeam 연결
const SN = 'apac:vc02';   // 연동 없음(Veeam '없음' 확정)
const OUT = 'us:vc04';    // 범위 밖
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VC, SN, OUT].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/backupStatus.js');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const H = 3_600_000;

test('A-1 priorityCandidates — 미백업은 Veeam 을 알 때만(모름·부재 모름이면 빼고) · 실패 · 오래된 · 문제 없는 VM 은 싣지 않는다', () => {
  const vms = [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }, { id: 'd', name: 'd' }, { id: 'e', name: 'e' }];
  const byVm = { b: { lb: NOW - 2 * H, lr: 'Failed' }, c: { lb: NOW - 30 * H }, d: { lb: NOW - 2 * H } };
  const marks = { a: { crit: 'high' }, e: { need: true }, d: { crit: 'high', need: true } };
  const ids = (o) => S.priorityCandidates(vms, { byVm, marks, now: NOW, ...o }).map((x) => `${x.id}:${['gap', 'fail', 'stale'].filter((k) => x[k]).join('+')}`);
  assert.deepEqual(ids({ veeamKnown: true }), ['a:gap', 'b:fail', 'c:', 'e:gap'], 'd 는 표시가 있어도 문제가 없다 · c 는 하루 넘음(오래된 후보)');
  assert.deepEqual(ids({ veeamKnown: false }), ['b:fail', 'c:'], 'Veeam 을 모르면 미백업이라고 지어내지 않는다');
  assert.deepEqual(ids({ veeamKnown: true, absentKnown: false }), ['b:fail', 'c:'], '첫 수집 전 서버가 있으면 부재는 모름');
  const one = S.priorityCandidates([{ id: 'x', name: 'x', folder: 'D/vm/F' }], { byVm: {}, marks: { x: { crit: 'zzz', need: 'yes' } }, veeamKnown: true, now: NOW });
  assert.deepEqual(one, [], '모르는 표시 값은 표시 없음(미백업 후보 아님)');
  assert.equal(S.priorityCandidates(null, {}).length, 0);
});

test('A-2 priorityRank — 중요도 상 → 백업 필요 → 나머지 · 미백업 → 실패 → 잔존 → 오래된 · 웹 priorityView 와 같은 순서', async () => {
  const items = [
    { id: '1', name: 'n-old', crit: '', need: false, gap: false, fail: false, stale: false, lb: NOW - 50 * H },
    { id: '2', name: 'need-fail', crit: 'mid', need: true, gap: false, fail: true, stale: false, lb: NOW - 2 * H },
    { id: '3', name: 'high-old', crit: 'high', need: false, gap: false, fail: false, stale: false, lb: NOW - 80 * H },
    { id: '4', name: 'high-gap', crit: 'high', need: true, gap: true, fail: false, stale: false, lb: null },
    { id: '5', name: 'n-stale', crit: '', need: false, gap: false, fail: false, stale: true, lb: NOW - 2 * H },
    { id: '6', name: 'n-older', crit: '', need: false, gap: false, fail: false, stale: false, lb: NOW - 90 * H },
  ];
  const srv = items.slice().sort(S.priorityRank).map((x) => x.name);
  assert.deepEqual(srv, ['high-gap', 'high-old', 'need-fail', 'n-stale', 'n-older', 'n-old']);
  const W = await import('../../web/src/views/tools/backupViewText.js');
  const web = W.priorityView(items, { rpoDays: 1, now: NOW });
  assert.deepEqual(web.items.map((x) => x.name), srv, '웹과 서버가 같은 순서(판정 두 벌 — 같은 입력으로 대조)');
  assert.deepEqual(web.counts, { all: 6, gap: 1, high: 2, fail: 1, old: 3, stale: 1 }, 'n-stale 은 마지막 백업이 2시간 전 — 오래된 백업에는 세지 않는다');
  assert.equal(W.priorityView(items, { rpoDays: 3, now: NOW }).items.map((x) => x.name).join(), 'high-gap,high-old,need-fail,n-stale,n-older',
    '기준 3일이면 50시간 전 백업은 문제가 아니다 → 빠진다');
});

test('B 라우트 — 범위 안 VM 만 · 연동 없음은 미백업 확정 · Detail 거부 계정은 목록을 싣지 않는다(캐시 키) · 상한', async () => {
  const BM = await import('../src/veeam/backupMarks.js');
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const P = await import('../src/auth/permissions.js');
  BM._resetMarksForTest();
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'J', type: 'Backup', lastResult: 'Failed' }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3 },
  ] });
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VC, SN, OUT].map((id) => ({ id, name: id })), hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'off01', folder: 'DC/vm/A', powerState: 'POWERED_OFF' },
    { id: `${SN}:vm-1`, vcenterId: SN, name: 'app01', powerState: 'POWERED_ON' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', powerState: 'POWERED_ON' },
  ] };
  BM.setMarks([{ id: `${VC}:vm-2`, name: 'db01' }], { crit: 'high' }, { username: 't' });
  BM.setMarks([{ id: `${SN}:vm-1`, name: 'app01' }], { need: true }, { username: 't' });
  BM.setMarks([{ id: `${VC}:vm-3`, name: 'off01' }], { need: true }, { username: 't' });
  BM.setMarks([{ id: `${OUT}:vm-1`, name: 'o1' }], { crit: 'high', need: true }, { username: 't' });
  let user = { username: 'op1', role: 'operator', scope: { vcenters: [VC, SN] } };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const prioOf = async (q = '?power=on') => (await (await fetch(`${base}/tools/backup-summary${q}`)).json()).priority;
  assert.ok((await prioOf('')).items.some((x) => x.name === 'off01'), '전원 전체면 꺼진 VM 도 후보');
  const p = await prioOf();
  const byName = Object.fromEntries(p.items.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName).sort(), ['app01', 'db01'], '범위 밖 o1 은 없다 · web01 은 문제 없음(오늘 백업 · 표시 없음) · 전원 켜짐만이면 off01 도 없다(다른 수와 같은 범위)');
  assert.deepEqual([byName.db01.gap, byName.db01.crit, byName.db01.vcenterId], [true, 'high', VC], '중요도 상인데 Veeam 대상 아님');
  assert.deepEqual([byName.app01.gap, byName.app01.need, byName.app01.vcName], [true, true, SN], '연동 없는 vCenter 는 Veeam 없음 확정');
  assert.equal(p.items[0].name, 'db01', '중요도 상이 먼저');
  assert.equal(p.total, 2);
  assert.ok(!JSON.stringify(p).includes('PW-secret'));

  // Detail 도구가 거부된 계정 — 같은 범위·역할이어도 캐시된 목록이 새지 않는다
  assert.equal(P.setUserTools('op3', { mode: 'deny', tools: ['backup-detail'], by: 't' }).ok, true);
  user = { username: 'op3', role: 'operator', scope: { vcenters: [VC, SN] } };
  const w = await prioOf();
  assert.deepEqual(w, { withheld: 'detail-tool' });
  user = { username: 'op1', role: 'operator', scope: { vcenters: [VC, SN] } };
  assert.equal((await prioOf()).items.length, 2, '허용 계정은 그대로');
  user = { username: 'adm', role: 'admin' };
  assert.deepEqual((await prioOf()).items.map((x) => x.name).sort(), ['app01', 'db01', 'o1'], '전체 범위 관리자는 전 법인(전원 켜짐만)');
});

test('C 소스 — 응답 캐시 키에 Detail 접근 · 상한 상수 · 판정 사용자 하나(toolActorOf)', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(src, /extraKey: `\$\{scopeKey\(req\.user, snap\)\}\|\$\{admin \? 'admin' : 'user'\}\|m\$\{marksRev\(\)\}\|d\$\{detailToolOk\(req\) \? 1 : 0\}(?:\|em\$\{emSourcesRev\(\)\})?(?:\|c\$\{jobsRev\(\)\})?(?:\|b\$\{bareosRegistryRev\(\)\}\|g\$\{bareosGroupsRev\(\)\})?`/);   // v2.795 EM 출처 리비전 · v2.806 복제 잡 리비전 · v2.836 Bareos 원장·그룹 리비전(법인 집계)
  assert.match(src, /const detailToolOk = \(req\) => !issueFor\(toolActorOf\(req\), 'backup-detail'\)/);
  assert.equal(S.PRIORITY_MAX, 500);
  const api = fs.readFileSync(new URL('../src/routes/api.js', import.meta.url), 'utf8');
  assert.match(api, /const toolGateUser = toolActorOf;/, '도구 게이트와 같은 판정 사용자');
});
