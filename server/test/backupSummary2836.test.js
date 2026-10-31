/**
 * test/backupSummary2836.test.js — v2.836 백업 메뉴 개편 1-b(사용자 요청 '서머리에는 veeam/bareos/ssh 를 합쳐 BackedUp · 백업 안함 · 확인 필요' ·
 *   '폴더를 클릭하면 VM list' · '지정한 시간만큼 백업되지 않은 VM 찾기' + 시안 ① Summary).
 *   ① 법인 집계(veeam/backupSummaryAgg.js) — 세기만 한다 · 못 읽은 값은 따로(pol null · polUnk · act.unk · mmUnk · rpo unk)
 *   ② 웹과 같은 판정 — rpoOf ↔ 웹 rpoCell · 찾기 ↔ 웹 findStale(같은 입력에 같은 수·같은 순서)
 *   ③ 라우트 — Summary 법인 줄 pa 가 Detail 행을 센 값과 같다 · 전체 법인 찾기(범위 · Detail 거부 403 · 기간 400 · 상한)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2836-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';   // 인증 켬(도구별 접근 집행이 실제로 돈다 — backupPriority2787 과 같은 환경) · 연동 없는 법인은 Veeam 없음 확정

const AG = await import('../src/veeam/backupSummaryAgg.js');
const WEB = await import('../../web/src/views/tools/backupViewText.js');
const H = 3_600_000; const DAY = 24 * H;
const NOW = Math.floor(Date.now() / H) * H;
const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

/** Detail 행 모양(필요한 필드만). */
const row = (o) => ({ id: o.id || 'x', name: o.name || o.id || 'x', folder: 'DC/vm/A', power: o.power ?? 'POWERED_ON', gb: 'gb' in o ? o.gb : 10, p: o.p, a: o.a ?? { v: false, b: false },
  mm: 'mm' in o ? o.mm : false, lok: o.lok ?? { at: null, never: true, v: null, b: null, vk: true, bk: true }, ...(o.e ? { e: o.e } : {}), ...(o.nx ? { nx: o.nx } : {}), ...(o.v ? { v: o.v } : {}) });
const ok = (t) => ({ at: t, never: false, v: t, b: null, vk: true, bk: true });
const ROWS = [
  row({ id: 'a', p: 'veeam', a: { v: true, b: false }, lok: ok(NOW - 2 * H), v: { state: 'run' }, nx: { at: NOW + 5 * H } }),
  row({ id: 'b', p: 'bareos', a: { v: false, b: false }, mm: true, lok: { at: null, never: true, v: null, b: null, vk: true, bk: true }, gb: null }),
  row({ id: 'c', p: 'ssh', a: { v: false, b: null }, mm: false, lok: { at: null, never: null, v: null, b: null, vk: true, bk: false } }),
  row({ id: 'd', p: 'none', a: { v: true, b: false }, mm: true, lok: ok(NOW - 30 * DAY), power: 'POWERED_OFF' }),
  row({ id: 'e', p: 'check', a: { v: true, b: false }, mm: true, lok: ok(NOW - 4 * DAY), e: [{ s: 'veeam', r: 'fail', at: NOW - H }, { s: 'bareos', r: 'warn', at: NOW - H }], nx: { at: NOW + 2 * H } }),
  row({ id: 'f', p: null, a: { v: null, b: null }, mm: null, lok: { at: null, never: null, v: null, b: null, vk: false, bk: false } }),
];

test('① 법인 집계 — BackedUp 재료(정책 5범주) · 실제 · 불일치 · RPO · 실패 · 실행 중 · 다음 예정 · 모름은 따로', () => {
  const a = AG.newSiteAgg();
  for (const r of ROWS) AG.addSiteVm(a, r, NOW);
  const f = AG.finishSiteAgg(a);
  assert.equal(f.n, 6);
  assert.equal(f.on, 5);
  assert.deepEqual(f.pol, { veeam: 1, bareos: 1, ssh: 1, none: 1, check: 1 });
  assert.equal(f.polUnk, 1, '정책을 모르는 VM(표시 파일 손상)은 확인 필요로 세지 않는다');
  assert.deepEqual(f.act, { v: 3, b: 0, none: 1, unk: 2 });
  assert.deepEqual([f.mm, f.mmUnk, f.mmBy], [3, 1, { veeam: 0, bareos: 1, other: 2 }]);
  // RPO 1일: a 충족 · b 한 번도 없음(미달) · c 모름(Bareos 모름) · d 대상 아님 · e 4일 전(미달) · f 정책 모름
  assert.deepEqual(f.rpo.d1, { ok: 1, miss: 2, unk: 2 });
  assert.deepEqual(f.rpo.d7, { ok: 2, miss: 1, unk: 2 }, 'e 는 7일 안 성공');
  assert.deepEqual(f.err, { vms: 1, fail: 1, warn: 1 });
  assert.equal(f.run, 1);
  assert.equal(f.lok, NOW - 2 * H, '마지막 백업 = 가장 늦은 성공');
  assert.equal(f.nx, NOW + 2 * H, '다음 예정 = 가장 이른 회차');
  assert.deepEqual([f.gb, f.gbUnk], [50, 1], '용량을 모르는 VM 은 0 으로 더하지 않는다');
  // 정책을 하나도 모르면 pol 은 null(0 이 아니다)
  const u = AG.newSiteAgg(); AG.addSiteVm(u, ROWS[5], NOW);
  assert.equal(AG.finishSiteAgg(u).pol, null);
  // 합계 — pol null 법인은 빼고 따로 센다(부분 합)
  const t = AG.sumSiteAggs([f, AG.finishSiteAgg(u)]);
  assert.deepEqual([t.n, t.pol.veeam, t.polUnkSites, t.polUnk, t.rpo.d1.unk], [7, 1, 1, 2, 3]);
  assert.deepEqual(AG.BACKED_UP_KEYS, ['veeam', 'bareos', 'ssh']);
  // 정책을 모르면(표시 파일 손상) 백업 안함인지 모른다 — 결과가 있어도 RPO 충족으로 세지 않는다(웹 rpoCell 과 같다)
  assert.equal(AG.rpoOf(row({ id: 'g', p: null, lok: ok(NOW - H) }), 1, NOW), 'unk');
});

test('② RPO · 찾기 — 웹 rpoCell · findStale 과 같은 답(같은 입력 대조)', () => {
  assert.deepEqual([...AG.SUMMARY_RPO_DAYS], [...WEB.RPO_DAYS], 'RPO 기준 일수');
  const tone = { ok: 'ok', bad: 'miss', unknown: 'unk', none: null };
  for (const d of AG.SUMMARY_RPO_DAYS) for (const r of [...ROWS, row({ id: 'g', p: null, lok: ok(NOW - H) })]) {
    assert.equal(AG.rpoOf(r, d, NOW), tone[WEB.rpoCell(r, { rpoDays: d, now: NOW }).tone], `${r.id} d${d}`);
  }
  const units = Object.fromEntries(WEB.STALE_UNITS.map(([k, , ms]) => [k, ms]));
  assert.deepEqual(units, { ...AG.STALE_UNIT_MS }, '기간 단위');
  const combos = [
    { n: 1, unit: 'd' }, { n: 3, unit: 'd', src: 'veeam' }, { n: 12, unit: 'h', src: 'bareos', onlyOn: '0' },
    { n: 1, unit: 'w', excludeNone: '0', includeNever: '0' }, { n: 2, unit: 'd', onlyOn: '0', excludeNone: '0' },
  ];
  for (const c of combos) {
    const o = AG.staleQueryOf(c);
    const acc = AG.addStaleRows(AG.newStaleAcc(), ROWS, { id: 'vc', name: 'VC' }, o, NOW);
    const fin = AG.finishStaleRows(acc);
    const w = WEB.findStale(ROWS, { n: c.n, unit: c.unit, src: c.src || 'all', excludeNone: c.excludeNone !== '0', onlyOn: c.onlyOn !== '0', includeNever: c.includeNever !== '0', now: NOW });
    const key = JSON.stringify(c);
    assert.deepEqual([acc.n, acc.never, acc.old, acc.unknown, acc.excluded], [w.n, w.never, w.old, w.unknown, w.excluded], key);
    assert.deepEqual(fin.rows.map((x) => `${x.vm.id}:${x.kind}`), w.rows.map((x) => `${x.vm.id}:${x.kind}`), `순서 ${key}`);
  }
});

test('② 찾기 조건 정규화 · 상한', () => {
  assert.deepEqual(AG.staleQueryOf({}), { n: null, unit: 'd', src: 'all', excludeNone: true, onlyOn: true, includeNever: true, windowMs: null }, 'n 이 없으면 찾지 않는다');
  assert.equal(AG.staleQueryOf({ n: '3', unit: 'h' }).windowMs, 3 * H);
  for (const bad of ['0', '1000', '2.5', '-1', 'abc']) assert.equal(AG.staleQueryOf({ n: bad }).windowMs, null, bad);
  assert.deepEqual([AG.staleQueryOf({ n: 1, unit: 'y', src: 'x' }).unit, AG.staleQueryOf({ n: 1, unit: 'y', src: 'x' }).src], ['d', 'all'], '모르는 값은 기본');
  const acc = AG.newStaleAcc();
  const many = Array.from({ length: 7 }, (_, i) => row({ id: `m${i}`, name: `vm${i}`, p: 'veeam', lok: { at: null, never: true, v: null, b: null, vk: true, bk: true } }));
  AG.addStaleRows(acc, many, { id: 'vc', name: 'VC' }, AG.staleQueryOf({ n: 1 }), NOW);
  const fin = AG.finishStaleRows(acc, 5);
  assert.deepEqual([fin.rows.length, fin.total, fin.truncated], [5, 7, true]);
  assert.equal(acc.n, 7, '수는 상한과 무관하게 전부 센다');
  assert.ok(!('gb' in fin.rows[0].vm) && fin.rows[0].vm.lok, '결과 행은 화면에 필요한 필드만');
});

test('③ 라우트 — Summary 법인 줄 pa = Detail 행을 센 값 · 전체 법인 찾기(범위 · Detail 거부 403 · 기간 400)', async () => {
  const VA = 'vc-a'; const VB = 'vc-b'; const OUT = 'vc-out';
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const BM = await import('../src/veeam/backupMarks.js');
  const P = await import('../src/auth/permissions.js');
  BM._resetMarksForTest();
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VA, VB, OUT].map((id) => ({ id, name: id.toUpperCase() })), hosts: [], vms: [
    { id: `${VA}:vm-1`, vcenterId: VA, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VA}:vm-2`, vcenterId: VA, name: 'db01', folder: 'DC/vm/A/B', powerState: 'POWERED_ON' },
    { id: `${VA}:vm-3`, vcenterId: VA, name: 'off01', folder: 'DC/vm/C', powerState: 'POWERED_OFF' },
    { id: `${VB}:vm-1`, vcenterId: VB, name: 'app01', folder: 'DC/vm/X', powerState: 'POWERED_ON' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'out01', folder: 'DC/vm/X', powerState: 'POWERED_ON' },
  ] };
  BM.setMarks([{ id: `${VA}:vm-1`, name: 'web01' }], { method: 'ssh' }, { username: 't' });
  BM.setMarks([{ id: `${VA}:vm-2`, name: 'db01' }], { method: 'none' }, { username: 't' });
  BM.setMarks([{ id: `${VB}:vm-1`, name: 'app01' }], { method: 'bareos' }, { username: 't' });
  let user = { username: 'op1', role: 'operator', scope: { vcenters: [VA, VB] } };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
  try {
    const s = (await get('/tools/backup-summary')).body;
    assert.deepEqual(s.rows.map((r) => r.id), [VA, VB], '범위 밖 법인은 없다');
    for (const r of s.rows) {
      const d = (await get(`/tools/backup-detail?vcenterId=${r.id}`)).body;
      const a = AG.newSiteAgg(); for (const v of d.vms) AG.addSiteVm(a, v, s.at);
      const want = AG.finishSiteAgg(a);
      assert.deepEqual({ n: r.pa.n, pol: r.pa.pol, act: r.pa.act, mm: r.pa.mm }, { n: want.n, pol: want.pol, act: want.act, mm: want.mm }, `${r.id} — Detail 과 같은 VM 행을 센다`);
    }
    const ra = s.rows.find((r) => r.id === VA).pa;
    assert.deepEqual(ra.pol, { veeam: 0, bareos: 0, ssh: 1, none: 1, check: 1 }, 'BackedUp(SSH 1) · 백업 안함 1 · 확인 필요 1(정하지 않음)');
    assert.equal(s.totals.pa.n, 4);
    assert.deepEqual(s.totals.pa.pol, { veeam: 0, bareos: 1, ssh: 1, none: 1, check: 1 });
    assert.ok(s.bareosGroups && s.bareosGroups.n === 0, 'Bareos 그룹 수(범위 안)');
    assert.ok(!JSON.stringify(s).includes('스냅샷'), 'Summary 응답에 화면 문구를 싣지 않는다');

    // 전체 법인 찾기 — 범위 안 법인만 · 법인 이름 · 켜진 VM 만 · 백업 안함 제외
    const st = await get('/tools/backup-summary/stale?n=3&unit=d');
    assert.equal(st.status, 200, JSON.stringify(st.body));
    const names = st.body.rows.map((x) => `${x.vcName}/${x.vm.name}`).sort();
    // 같은 VM 행(Detail)에 웹 찾기를 돌린 결과와 같다 — 데모 Veeam 대조가 어떤 VM 을 백업됐다고 보든
    const dvms = [];
    for (const id of [VA, VB]) for (const v of (await get(`/tools/backup-detail?vcenterId=${id}`)).body.vms) dvms.push({ ...v, _vc: id.toUpperCase() });
    const w = WEB.findStale(dvms, { n: 3, unit: 'd', now: st.body.at });
    assert.deepEqual(names, w.rows.map((x) => `${x.vm._vc}/${x.vm.name}`).sort(), '웹 findStale 과 같은 VM');
    assert.ok(names.includes('VC-B/app01'), '정책 Bareos 인데 잡 없음 — 한 번도 없음');
    assert.equal(st.body.rows.find((x) => x.vm.name === 'app01').kind, 'never');
    assert.ok(!names.some((x) => /db01|off01/.test(x)), '백업 안함 정책 · 꺼진 VM 은 빠진다');
    assert.deepEqual(st.body.excluded, { none: 1, off: 1 });
    assert.equal(st.body.vcenters, 2);
    assert.ok(!st.body.rows.some((x) => x.vc === OUT));
    assert.equal((await get('/tools/backup-summary/stale?n=0')).status, 400, '기간 1~999');
    assert.equal((await get('/tools/backup-summary/stale')).status, 400, '기간이 없으면 찾지 않는다');
    // Detail 이 거부된 계정 — VM 목록이 새지 않는다(캐시도)
    assert.equal(P.setUserTools('op3', { mode: 'deny', tools: ['backup-detail'], by: 't' }).ok, true);
    user = { username: 'op3', role: 'operator', scope: { vcenters: [VA, VB] } };
    const denied = await get('/tools/backup-summary/stale?n=3&unit=d');
    assert.equal(denied.status, 403);
    assert.ok(!JSON.stringify(denied.body).includes('web01'));
    // 전체 범위 관리자는 전 법인
    user = { username: 'adm', role: 'admin' };
    const all = (await get('/tools/backup-summary/stale?n=3&unit=d')).body;
    assert.ok(all.rows.some((x) => x.vc === OUT), '전체 범위는 전 법인');
  } finally { store.snapshot = prev; }
});
