/**
 * test/backupSummary2837.test.js — v2.837 Summary 를 시안 ① 에 맞추기(사용자 요청 '시안대로 다 맞춰줘').
 *   ① 법인 집계 확장 — 보호 안 됨 · 확인 안 됨 · Bareos 실행 중 · 24시간 결과 · 백업 기간 · 용량 · Veeam 다음 창 · 방식 불일치(모름은 따로)
 *   ② 판정 코어 — 찾기 기준 'policy'(정책에 맞는 백업만) · 다음 예정(그룹 회차 + Veeam 잡) · 웹과 같은 답
 *   ③ 라우트 — 법인 줄 w · Bareos 부가 정보 · EM 요약은 전체 범위만 · 찾기 법인 하나(범위 밖 404) · CSV(권한 · 감사 · 화면과 같은 수)
 *   ④ Veeam 대조 — 복원 지점 크기 합 · 다음 실행(가장 이른 것) · 마지막 task 시작 시각이 Detail 행까지 온다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2837-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';   // 인증 켬(도구별 접근 집행이 실제로 돈다) · 연동 없는 법인은 Veeam 없음 확정

const AG = await import('../src/veeam/backupSummaryAgg.js');
const BP = await import('../src/veeam/backupPolicy.js');
const WEB = await import('../../web/src/views/tools/backupViewText.js');
const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H;
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

const lok = (o = {}) => ({ at: null, never: true, v: null, b: null, vk: true, bk: true, ...o });
const row = (o) => ({ id: o.id, name: o.id, folder: 'DC/vm/A', power: o.power ?? 'POWERED_ON', gb: 10, p: o.p, a: o.a ?? { v: false, b: false },
  mm: 'mm' in o ? o.mm : false, lok: o.lok ?? lok(), ...('v' in o ? { v: o.v } : {}), ...('b' in o ? { b: o.b } : {}), ...(o.nx ? { nx: o.nx } : {}) });

test('① 집계 확장 — 보호 안 됨 · 확인 안 됨 · Bareos 실행 · 24시간 결과 · 기간 · 용량 · 다음 창 · 방식 불일치', () => {
  const rows = [
    row({ id: 'a', p: 'veeam', a: { v: true, b: false }, lok: lok({ at: NOW - 2 * H, never: false, v: NOW - 2 * H }),
      v: { state: 'ok', lr: 'Success', lrt: NOW - 2 * H, lrs: NOW - 3 * H, sz: 500, nr: NOW + 5 * H } }),
    row({ id: 'b', p: 'bareos', mm: true }),   // BackedUp 인데 한 번도 없음 → 보호 안 됨
    row({ id: 'c', p: 'ssh', a: { v: false, b: null }, lok: lok({ never: null, bk: false }) }),   // 결과 모름 → 확인 안 됨
    row({ id: 'd', p: 'none', power: 'POWERED_OFF' }),   // 백업 안함 — 어느 쪽에도 세지 않는다
    row({ id: 'e', p: 'check' }),   // 확인 필요(화면이 보호 안 됨에 더한다 — 여기서는 unprot 아님)
    row({ id: 'f', p: 'veeam', a: { v: true, b: true }, mm: false, lok: lok({ at: NOW - 30 * H, never: false, b: NOW - 30 * H }),
      v: { state: 'ok', lr: 'Failed', lrt: NOW - 30 * H, sz: 300, nr: NOW + 5.5 * H },
      b: { job: true, on: true, st: 'warning', at: NOW - 4 * H, sa: NOW - 6 * H, by: 1000, run: 'running' } }),
    row({ id: 'g', p: null, a: { v: null, b: null }, mm: null, lok: lok({ never: null, vk: false, bk: false }),
      b: { job: true, on: true, st: 'error', at: NOW - H, by: null, run: 'queued' } }),
  ];
  const a = AG.newSiteAgg();
  for (const r of rows) AG.addSiteVm(a, r, NOW);
  AG.countVeeamWindow(a, rows, NOW);
  const f = AG.finishSiteAgg(a);
  assert.deepEqual([f.unprot, f.unver], [1, 2], '보호 안 됨 = b · 확인 안 됨 = c(SSH 결과 모름) · g(정책 모름)');
  assert.deepEqual([f.brun, f.bwait], [1, 1]);
  assert.deepEqual(f.r24, { ok: 1, warn: 1, fail: 1 }, 'a Veeam 성공 · f Bareos 경고 · g Bareos 실패(f 의 Veeam 실패는 30시간 전 — 창 밖)');
  assert.deepEqual(f.win, { start: NOW - 6 * H, end: NOW - H }, '기간 = 아는 시작 중 가장 이른 것 ~ 끝 중 가장 늦은 것');
  assert.deepEqual([f.vbytes, f.vbytesN, f.bbytes, f.bbytesN], [800, 2, 1000, 1], '용량을 모르는 VM 은 0 으로 더하지 않고 수에도 넣지 않는다');
  assert.deepEqual([f.vnx, f.vnxN], [NOW + 5 * H, 2], '다음 창 = 가장 이른 Veeam 다음 실행 · 1시간 안 VM 수');
  assert.equal(f.bmis, 1, 'f 는 Bareos 잡이 있는데 정책 Veeam(방식 불일치) · g 는 정책을 몰라 세지 않는다');
  assert.equal(f.nx, NOW + 5 * H, '다음 예정에 Veeam 잡도 든다');
  assert.deepEqual([f.v7, f.b7], [{ ok: 1, bad: 1 }, { ok: 1, bad: 1 }], '7일 — Veeam a 성공 · f 실패 / Bareos f 경고(성공 쪽) · g 실패');
  const t = AG.sumSiteAggs([f, f]);
  assert.deepEqual([t.unprot, t.unver, t.brun, t.r24.fail, t.vbytes, t.bmis, t.vnxN], [2, 4, 2, 2, 1600, 2, 4]);
  assert.deepEqual(t.win, f.win);
});

test('① 경계 — 모름 · 지난 시각 · 창 밖 · 잘못된 시각은 세지 않는다(변이 검증이 고정)', () => {
  const one = (r) => { const a = AG.newSiteAgg(); AG.addSiteVm(a, r, NOW); AG.countVeeamWindow(a, [r], NOW); return AG.finishSiteAgg(a); };
  // 정책을 모르면 결과가 있어도 확인 안 됨(백업 안함인지 모른다)
  assert.equal(one(row({ id: 'h', p: null, mm: null, lok: lok({ at: NOW - H, never: false, v: NOW - H }) })).unver, 1);
  // 백업 안함은 결과를 몰라도 어느 쪽에도 세지 않는다
  const none = one(row({ id: 'i', p: 'none', lok: lok({ never: null, vk: false }) }));
  assert.deepEqual([none.unprot, none.unver], [0, 0]);
  // 취소된 Bareos 실행은 실패 · 시작이 끝보다 늦은(잘못된) 시각은 기간에 넣지 않는다
  const can = one(row({ id: 'j', p: 'bareos', a: { v: false, b: true }, b: { job: true, on: true, st: 'canceled', at: NOW - H, sa: NOW } }));
  assert.deepEqual([can.r24.fail, can.r24.ok], [1, 0]);
  const badStart = one(row({ id: 'k', p: 'veeam', v: { state: 'ok', lr: 'Success', lrt: NOW - 2 * H, lrs: NOW - H } }));
  assert.deepEqual(badStart.win, { start: null, end: NOW - 2 * H });
  // 크기 — Veeam 행이 있어도 크기를 모르면 수에 넣지 않는다 · 잡이 없는 Bareos 칸의 크기는 세지 않는다
  const sz = one(row({ id: 'l', p: 'veeam', v: { state: 'ok' }, b: { job: false, by: 100 } }));
  assert.deepEqual([sz.vbytesN, sz.vbytes, sz.bbytesN, sz.bbytes], [0, 0, 0, 0]);
  // 지난 Veeam 다음 실행 · 지난 그룹 회차는 다음 창 · 다음 예정에 넣지 않는다
  const past = one(row({ id: 'm', p: 'veeam', v: { state: 'ok', nr: NOW - H }, nx: { at: NOW - 2 * H, g: 'g' } }));
  assert.deepEqual([past.vnx, past.vnxN, past.nx], [null, 0, null]);
  assert.equal(AG.nextAtOf(row({ id: 'm2', p: 'bareos', nx: { at: NOW - H, g: 'g' } }), NOW), null);
  // 7일 밖 Veeam 결과는 7일 성공률에 넣지 않는다
  assert.deepEqual(one(row({ id: 'o', p: 'veeam', v: { state: 'ok', lr: 'Failed', lrt: NOW - 10 * DAY } })).v7, { ok: 0, bad: 0 });
  // 찾기 '실패만 반복' — 결과를 모르는 VM 은 실패가 있어도 세지 않는다
  const acc = AG.newStaleAcc();
  AG.addStaleRows(acc, [
    row({ id: 'u', p: 'veeam', lok: lok({ never: null, vk: false }), e: undefined }),
    { ...row({ id: 'u2', p: 'veeam', lok: lok({ never: null, vk: false }) }), e: [{ s: 'veeam', r: 'fail', at: NOW - H }] },
    { ...row({ id: 'f2', p: 'veeam' }), e: [{ s: 'veeam', r: 'fail', at: NOW - H }] },
  ], { id: 'vc', name: 'VC' }, AG.staleQueryOf({ n: 1 }), NOW);
  assert.deepEqual([acc.unknown, acc.n, acc.failing], [2, 1, 1]);
});

test('② 찾기 기준 policy · 다음 예정 — 웹과 같은 답', () => {
  assert.deepEqual([...BP.STALE_SOURCES], [...WEB.STALE_SOURCES]);
  for (const src of [...BP.STALE_SOURCES, 'bogus']) for (const p of ['veeam', 'bareos', 'ssh', 'check', null]) assert.equal(BP.staleSrcOf(src, p), WEB.staleSrcOf(src, p), `${src}/${p}`);
  // 정책 Veeam: Veeam 은 10일 전 · Bareos 는 어제 — '전부' 면 대상 아님, '정책에 맞는 백업만' 이면 기준 넘음
  const vm = row({ id: 'x', p: 'veeam', lok: lok({ at: NOW - DAY, never: false, v: NOW - 10 * DAY, b: NOW - DAY }) });
  const o = { windowMs: 3 * DAY, now: NOW };
  assert.equal(BP.staleOf(vm, { ...o, src: 'all' }), null);
  assert.equal(BP.staleOf(vm, { ...o, src: 'policy' }).kind, 'old');
  assert.deepEqual(BP.staleOf(vm, { ...o, src: 'policy' }), WEB.staleOf(vm, { ...o, src: 'policy' }));
  const vb = { ...vm, p: 'bareos' };
  assert.equal(BP.staleOf(vb, { ...o, src: 'policy' }), null, '정책 Bareos 면 Bareos 결과(어제)로 본다');
  // 다음 예정 — 지난 시각은 버리고 가장 이른 것
  const r = row({ id: 'n', p: 'veeam', v: { state: 'ok', nr: NOW + 2 * H }, nx: { at: NOW + 5 * H, g: 'grp' } });
  assert.equal(AG.nextAtOf(r, NOW), NOW + 2 * H);
  assert.equal(AG.nextAtOf({ ...r, v: { nr: NOW - H } }, NOW), NOW + 5 * H, '지난 Veeam 다음 실행은 버린다');
  assert.equal(AG.nextAtOf(row({ id: 'z', p: 'veeam' }), NOW), null);
  for (const x of [r, { ...r, v: { nr: NOW - H } }, row({ id: 'z', p: 'veeam' })]) assert.equal(WEB.nextOf(x, NOW)?.at ?? null, AG.nextAtOf(x, NOW), '웹 nextOf 와 같은 시각');
});

test('② 저장소 30일 추이 — 이력이 30일을 덮을 때만', async () => {
  const { repoTrend30 } = await import('../src/routes/api/veeam.js');
  assert.equal(repoTrend30(null), null);
  assert.equal(repoTrend30({ a: [[100, 1000, 500]] }), null, '30일 전 값이 없으면 모름');
  const t = repoTrend30({ a: [[60, 1000, 600], [70, 1000, 550], [100, 1000, 500]], b: [[70, 100, 50], [100, 100, 40]] });
  // a: 30일 전(70일차) 사용 450 → 지금 500 · b: 50 → 60 — 합 500 → 560
  assert.deepEqual(t, { pct: 12, now: 560, before: 500 });
});

test('③ 라우트 — 법인 줄 w · Bareos 부가 정보 · EM 요약은 전체 범위만 · 찾기 법인 하나 · CSV', async () => {
  const VA = 'vc-a'; const VB = 'vc-b'; const OUT = 'vc-out';
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const BM = await import('../src/veeam/backupMarks.js');
  BM._resetMarksForTest();
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VA, VB, OUT].map((id) => ({ id, name: id.toUpperCase() })), hosts: [], vms: [
    { id: `${VA}:vm-1`, vcenterId: VA, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VA}:vm-2`, vcenterId: VA, name: 'db01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VB}:vm-1`, vcenterId: VB, name: 'app01', folder: 'DC/vm/X', powerState: 'POWERED_ON' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'out01', folder: 'DC/vm/X', powerState: 'POWERED_ON' },
  ] };
  BM.setMarks([{ id: `${VA}:vm-1`, name: 'web01' }], { method: 'veeam' }, { username: 't' });
  BM.setMarks([{ id: `${VB}:vm-1`, name: 'app01' }], { method: 'bareos' }, { username: 't' });
  let user = { username: 'op1', role: 'operator', scope: { vcenters: [VA, VB], writeVcenters: [VA] } };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p) => { const r = await fetch(`${base}${p}`); const t = await r.text(); let body = t; try { body = JSON.parse(t); } catch { /* CSV */ } return { status: r.status, body, type: r.headers.get('content-type') || '' }; };
  try {
    const s = (await get('/tools/backup-summary')).body;
    const by = Object.fromEntries(s.rows.map((r) => [r.id, r]));
    assert.deepEqual([by[VA].w, by[VB].w], [true, false], '쓰기 범위(writeVcenters) 밖은 w false — 같은 범위라도 계정마다 다르다');
    assert.equal(by[VA].bMapped, false, 'Bareos 매핑 없음(설정을 읽었다 — 모름이 아니다)');
    assert.equal('stuck' in by[VA], false, '진행 현황 조회가 없으면 멈춤 의심은 모름(키 없음 — 0 이 아니다)');
    assert.equal(s.totals.stuck, null);
    assert.equal(s.em, null, 'EM 은 전 법인 자료 — 범위 계정에는 싣지 않는다');
    assert.ok(s.directors && s.directors.n === 0 && s.directors.failed === 0);
    assert.equal(s.totals.pa.unprot, 2, 'web01(정책 Veeam · 연동 없음 = 없음 확정) · app01(정책 Bareos · 잡 없음)');
    // 전체 범위 관리자 — EM 요약이 실린다(EM 이 없으면 0개)
    user = { username: 'adm', role: 'admin' };
    const sa = (await get('/tools/backup-summary')).body;
    assert.ok(sa.em && sa.em.ems === 0 && sa.em.jobs === null && sa.em.repo === null, JSON.stringify(sa.em));
    // 찾기 — 법인 하나 · 범위 밖 404
    user = { username: 'op1', role: 'operator', scope: { vcenters: [VA, VB] } };
    const one = (await get(`/tools/backup-summary/stale?n=3&unit=d&vc=${VA}`)).body;
    assert.deepEqual([...new Set(one.rows.map((x) => x.vc))], [VA], '그 법인의 VM 만(web01 · db01)');
    assert.equal(one.vcenters, 1);
    assert.equal(one.q.vc, VA);
    assert.equal((await get(`/tools/backup-summary/stale?n=3&unit=d&vc=${OUT}`)).status, 404, '범위 밖 법인은 404(존재를 흘리지 않는다)');
    assert.equal((await get('/tools/backup-summary/stale?n=3&unit=d&vc=nope')).status, 404);
    assert.ok(one.rows[0].vm && 'v' in one.rows[0].vm, '실제 백업 칸 자료(v)');
    // CSV — 화면과 같은 수 · 감사
    user = { username: 'adm', role: 'admin' };
    const all = (await get('/tools/backup-summary/stale?n=3&unit=d')).body;
    const csv = await get('/tools/backup-summary/stale.csv?n=3&unit=d');
    assert.equal(csv.status, 200);
    assert.match(csv.type, /text\/csv/);
    const lines = String(csv.body).replace(/^﻿/, '').split('\r\n');
    assert.match(lines[0], /^법인,VM,폴더,OS,전원,백업 정책,판정,마지막 성공\(UTC\),경과\(시간\),정책≠실제,실제 Veeam,실제 Bareos,최근 24시간 실패$/);
    assert.equal(lines.length - 1, all.total, 'CSV 는 화면 찾기와 같은 VM 전부');
    assert.equal((await get('/tools/backup-summary/stale.csv')).status, 400);
    const audit = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8');
    assert.match(audit, /backup-summary-stale\.csv/);
  } finally { store.snapshot = prev; }
});

test('④ Veeam 대조 — 복원 지점 크기 합 · 다음 실행 · 마지막 task 시작 시각이 Detail 행까지', async () => {
  const { matchToVcenter } = await import('../src/veeam/parse.js');
  const BS = await import('../src/veeam/backupStatus.js');
  const vc = { id: 'vc1', host: 'vc1.corp.local' };
  const vms = [{ id: 'vc1:vm-1', vcenterId: 'vc1', name: 'web01', moref: 'vm-1' }];
  const res = (name, sz, nr) => ({ server: { id: name, name }, result: { ok: true, ts: NOW, jobs: [{ id: 'j', name: `J-${name}`, lastRun: NOW - DAY, lastResult: 'Success', nextRun: nr }],
    vms: [{ n: 'web01', m: 'vm-1', h: 'vc1.corp.local', j: [0], rp: 3, sz, lt: { r: 'Success', s: NOW - 3 * H, e: NOW - 2 * H } }] } });
  const m = matchToVcenter(vc, vms, [res('A', 100, NOW + 4 * H), res('B', 50, NOW + 2 * H)]);
  const e = m.byVm['vc1:vm-1'];
  assert.ok(e, JSON.stringify(m));
  assert.equal(e.sz, 150, '두 서버의 복원 지점 크기를 더한다');
  assert.equal(e.nr, NOW + 2 * H, '가장 이른 다음 실행');
  assert.equal(e.lrs, NOW - 3 * H);
  const v = BS.vmBackupView(vms[0], e, null, { now: NOW });
  assert.deepEqual([v.v.sz, v.v.nr, v.v.lrs, v.v.lrt], [150, NOW + 2 * H, NOW - 3 * H, NOW - 2 * H]);
  const v0 = BS.vmBackupView(vms[0], { jobs: [], run: 0, rp: null, lb: null }, null, { now: NOW });
  assert.equal('sz' in v0.v, false, '크기를 모르면 키 없음(0 이 아니다)');
});
