/**
 * v2.780 — 백업 서머리·세부내용 옵션(사용자 요청 '켜져있는 VM 과 꺼져있는 VM 선택하는 옵션' + 고른 제안 4개:
 *   오래된 백업(RPO) · 실패·경고 · 템플릿·vCLS 제외 · CSV 내보내기. 일시 중지는 꺼짐에 넣는다).
 *  · 범위(전원·제외)는 서버가 정한다(vmScope) — 서머리 행과 세부 머리 수가 같은 backupRow 로 나온다 · 전원 모름은 켜짐·꺼짐 어디에도 넣지 않고 센다.
 *  · ⚠ 매칭·스냅샷 요약(cachedSnapEvents — vCenter 별 캐시)은 늘 전체 VM 으로 — 부분 목록으로 부르면 다른 화면 값이 바뀐다.
 *  · CSV: data.csv 권한 · 감사 로그 · 범위 밖 404 · 비밀 없음 · 화면 보기 필터와 같은 판정(vmViewMatches).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2780-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';
const OUT = 'us:vc04';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
  { id: OUT, name: 'vc04', host: 'vc04.corp.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/backupStatus.js');
const P = await import('../src/veeam/parse.js');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('A-1 vmScope — 켜짐=POWERED_ON · 꺼짐=그 밖의 값(일시 중지 포함) · 전원 모름은 따로 · 템플릿·vCLS 는 기본 제외', () => {
  const vms = [
    { id: '1', name: 'web', powerState: 'POWERED_ON' }, { id: '2', name: 'db', powerState: 'POWERED_OFF' },
    { id: '3', name: 'sus', powerState: 'SUSPENDED' }, { id: '4', name: 'unk' }, { id: '5', name: 'tpl', template: true, powerState: 'POWERED_OFF' },
    { id: '6', name: 'vCLS-abc', powerState: 'POWERED_ON' }, { id: '7', name: 'blank', powerState: '  ' },
  ];
  const ids = (r) => r.vms.map((v) => v.id);
  let r = S.vmScope(vms);
  assert.deepEqual([ids(r), r.excluded, r.powerUnknown, r.power, r.excl], [['1', '2', '3', '4', '7'], 2, 0, 'all', true], '전체면 전원 모름도 든다');
  r = S.vmScope(vms, { power: 'on' });
  assert.deepEqual([ids(r), r.powerUnknown], [['1'], 2]);
  r = S.vmScope(vms, { power: 'off' });
  assert.deepEqual([ids(r), r.powerUnknown], [['2', '3'], 2], '일시 중지는 꺼짐');
  r = S.vmScope(vms, { power: 'off', excl: false });
  assert.deepEqual([ids(r), r.excluded], [['2', '3', '5'], 0]);
  assert.equal(S.vmScope(vms, { power: 'zzz' }).power, 'all', '모르는 값은 기본');
  assert.equal(S.isSystemVm({ name: 'vcls-1' }), true); assert.equal(S.isSystemVm({ name: 'my-vCLS' }), false, '앞에 붙은 것만');
});

test('A-2 backupRow 부분 목록 — Veeam·스냅샷·나눔·RPO·결과 모두 넘긴 VM 만 센다 · Veeam 모르면 RPO·결과도 모름', () => {
  const vms = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const match = { byVm: {
    a: { lb: NOW - 2 * HOUR, lr: 'Success' }, b: { lb: NOW - 2 * DAY, lr: 'Failed' },
    c: { lb: NOW - 8 * DAY, lastResult: 'Warning' }, d: { run: 1, lr: 'Warning' },
  } };
  const ev = { status: 'ok', source: 'local', days: 7, byVm: { a: [NOW - HOUR, 1], c: [NOW - HOUR, 1] }, at: NOW, collectedAt: NOW };
  const sc = { n: 2 };
  const full = S.backupRow({ vms, linked: true, vcnt: { src: 'veeam', n: 4 }, match, sc, ev, now: NOW });
  assert.deepEqual(full.rpo, { d1: 2, d3: 1, d7: 1, unknown: 1 }, 'd 는 시각 모름');
  assert.deepEqual(full.results, { failed: 1, warning: 2 }, 'VM 결과(lr)가 먼저 · 없으면 작업 결과');
  const part = S.backupRow({ vms: [{ id: 'a' }, { id: 'b' }], linked: true, vcnt: { src: 'veeam', n: 4 }, match, sc, ev, now: NOW });
  assert.deepEqual([part.vm, part.veeam, part.snap, part.running], [2, 2, 1, 0], '범위 밖 VM 의 Veeam·스냅샷·백업 중은 세지 않는다');
  assert.deepEqual(part.split, { both: 1, vOnly: 1, sOnly: 0, none: 0 });
  assert.deepEqual([part.rpo, part.results], [{ d1: 1, d3: 0, d7: 0, unknown: 0 }, { failed: 1, warning: 0 }]);
  const unk = S.backupRow({ vms, linked: true, vcnt: { src: 'veeam', n: null, reason: 'veeam-failed' }, match: null, sc, ev, now: NOW });
  assert.deepEqual([unk.rpo, unk.results], [null, null]);
  const t = S.backupTotals([{ ...full, excluded: 3, powerUnknown: 1 }, { ...unk, excluded: 1 }]);
  assert.deepEqual([t.rpo, t.failed, t.warning, t.excluded, t.powerUnknown], [{ d1: 2, d3: 1, d7: 1, unknown: 1 }, 1, 2, 4, 1], '모르는 vCenter 의 RPO 는 더하지 않는다');
});

test('A-3 matchToVcenter lr — 그 VM 의 가장 늦게 끝난 task 결과 · 기존 판정은 그대로', () => {
  const vms = [{ id: `${VC}:vm-1`, name: 'web01' }];
  const res = [{ server: { id: 's', name: 'A' }, result: { jobs: [{ name: 'J', type: 'Backup', lastResult: 'Success' }], vms: [
    { m: 'vm-1', n: 'web01', h: 'vc01.corp.local', j: [0], lt: { r: 'Failed', e: NOW - 2 * HOUR } },
  ] } }, { server: { id: 's2', name: 'B' }, result: { jobs: [{ name: 'K', type: 'Backup' }], vms: [
    { m: 'vm-1', n: 'web01', h: 'vc01.corp.local', j: [0], lt: { r: 'Warning', e: NOW - HOUR } },
  ] } }];
  const m = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, vms, res);
  assert.equal(m.byVm[`${VC}:vm-1`].lr, 'Warning', '두 서버 중 늦게 끝난 것');
  const v = S.vmBackupView(vms[0], m.byVm[`${VC}:vm-1`], undefined, { now: NOW });
  assert.equal(v.v.lr, 'Warning');
});

test('A-4 보기 필터(서버 vmViewMatches) — 오래된 백업은 rpoDays · 실패·경고 · 모름은 넣지 않는다', () => {
  const o = { rpoDays: 3, now: NOW };
  const old = { v: { state: 'ok', lb: NOW - 4 * DAY, lr: 'Success' }, s: { ev: null, now: null } };
  const fail = { v: { state: 'ok', lb: NOW - HOUR, lr: 'Failed' }, s: { ev: null, now: null } };
  const unk = { s: { now: null } };
  assert.deepEqual([S.vmViewMatches(old, 'rpo', o), S.vmViewMatches(old, 'rpo', { rpoDays: 7, now: NOW }), S.vmViewMatches(fail, 'rpo', o)], [true, false, false]);
  assert.deepEqual([S.vmViewMatches(fail, 'fail', o), S.vmViewMatches(old, 'fail', o), S.vmViewMatches(unk, 'fail', o), S.vmViewMatches(unk, 'none', o)], [true, false, false, false]);
  assert.equal(S.vmViewMatches({ v: { state: 'ok', lb: null, lastResult: 'Warning' }, s: {} }, 'fail', o), true, 'VM 결과가 없으면 작업 결과');
});

test('B 라우트 — power·excl 파라미터 · 세부 VM 목록도 같은 범위 · 스냅샷 캐시는 전체 VM 으로 · CSV 권한·감사·범위 밖 404·비밀 없음', async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const { listAudit } = await import('../src/audit.js');
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'J-web', type: 'Backup', lastResult: 'Success' }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3, lt: { r: 'Success', e: Date.now() - HOUR } },
    { n: 'db01', m: 'vm-2', h: 'vc01.corp.local', j: [0], rp: 1, lt: { r: 'Failed', e: Date.now() - 2 * HOUR } },
    { n: 'old01', m: 'vm-3', h: 'vc01.corp.local', j: [0], rp: 1, lt: { r: 'Success', e: Date.now() - 5 * DAY } },
  ] });
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  const base0 = { source: 'live', generatedAt: NOW, vcenters: [VC, OUT].map((id) => ({ id, name: id })), hosts: [] };
  store.snapshot = { ...base0, vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC1/vm/A', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC1/vm/A', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'old01', folder: 'DC1/vm/B', powerState: 'POWERED_OFF' },
    { id: `${VC}:vm-4`, vcenterId: VC, name: 'tpl01', folder: 'DC1/vm/T', powerState: 'POWERED_OFF', template: true },
    { id: `${VC}:vm-5`, vcenterId: VC, name: 'vCLS-1', folder: 'DC1/vm/vCLS', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-6`, vcenterId: VC, name: 'nopower', folder: 'DC1/vm/B' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', powerState: 'POWERED_ON' },
  ] };
  let user = { username: 'o', role: 'operator', scope: { vcenters: [VC] } };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const vcq = `vcenterId=${encodeURIComponent(VC)}`;
  const row = async (qs) => { const j = await (await fetch(`${base}/tools/backup-summary${qs}`)).json(); return j.rows.find((r) => r.id === VC); };
  try {
    let r = await row('');
    assert.deepEqual([r.vm, r.veeam, r.excluded, r.powerUnknown], [4, 3, 2, 0], '기본 = 전체 전원 · 템플릿·vCLS 제외');
    assert.deepEqual(r.results, { failed: 1, warning: 0 });
    assert.deepEqual([r.rpo.d1, r.rpo.d3, r.rpo.d7], [1, 1, 0]);
    const snapAll = r.snap;
    r = await row('?power=on');
    assert.deepEqual([r.vm, r.veeam, r.powerUnknown, r.results.failed], [2, 2, 1, 1], '켜짐 = web01·db01 · 전원 모름 1대는 따로');
    r = await row('?power=off');
    assert.deepEqual([r.vm, r.veeam, r.rpo.d3], [1, 1, 1], '꺼짐 = old01(템플릿 제외)');
    r = await row('?power=off&excl=0');
    assert.deepEqual([r.vm, r.excluded], [2, 0], '제외를 끄면 템플릿도 든다');
    assert.equal((await row('')).snap, snapAll, '전원 범위 요청 뒤에도 전체 요청의 스냅샷 수가 같다(캐시 오염 없음)');
    const sum = await (await fetch(`${base}/tools/backup-summary?power=on`)).json();
    assert.deepEqual(sum.scope, { power: 'on', excl: true });
    assert.equal(sum.totals.powerUnknown, 1);

    const det = await (await fetch(`${base}/tools/backup-detail?${vcq}&power=on`)).json();
    assert.deepEqual(det.vms.map((v) => v.name).sort(), ['db01', 'web01'], '세부 VM 목록도 같은 범위');
    assert.equal(det.row.vm, det.vms.length, '머리 수 = 목록 수');
    assert.equal(det.vms.find((v) => v.name === 'db01').v.lr, 'Failed');
    assert.equal((await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(OUT)}&power=on`)).status, 404);

    // CSV — 운영자는 data.csv 가 없다(관리자 전용 권한)
    assert.equal((await fetch(`${base}/tools/backup-summary.csv`)).status, 403);
    assert.equal((await fetch(`${base}/tools/backup-detail.csv?${vcq}`)).status, 403);
    user = { username: 'adm', role: 'admin' };
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 1 };
    const c1 = await fetch(`${base}/tools/backup-summary.csv?power=on`);
    assert.equal(c1.status, 200);
    assert.match(c1.headers.get('content-disposition') || '', /attachment; filename="backup-summary-[\w-]+\.csv"/);
    const b1 = Buffer.from(await c1.arrayBuffer());
    assert.deepEqual([...b1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM(엑셀 한글) — fetch text() 는 BOM 을 떼므로 바이트로 본다');
    const t1 = b1.toString('utf8');
    const lines1 = t1.split('\r\n');
    assert.equal(lines1.length, 3, '머리 + 범위 안 vCenter 둘(관리자 = 전체)');
    assert.match(lines1.find((l) => l.startsWith('apac:vc01')), /켜진 VM · 템플릿·vCLS 제외/);
    const c2 = await fetch(`${base}/tools/backup-detail.csv?${vcq}&filter=fail`);
    const t2 = await c2.text();
    assert.equal(c2.status, 200);
    assert.deepEqual(t2.split('\r\n').slice(1).map((l) => l.split(',')[2]), ['db01'], '화면 보기 필터와 같은 판정(실패·경고)');
    const c3 = await (await fetch(`${base}/tools/backup-detail.csv?${vcq}&filter=rpo&rpoDays=3`)).text();
    assert.deepEqual(c3.split('\r\n').slice(1).map((l) => l.split(',')[2]), ['old01'], '오래된 백업 3일');
    assert.equal((await fetch(`${base}/tools/backup-detail.csv?vcenterId=nope`)).status, 404);
    for (const leak of ['svc-bk', 'PW-secret-1', 'vbr-a.corp.local']) assert.equal((t1 + t2 + c3).includes(leak), false, leak);
    const au = listAudit({ limit: 20 });
    const rows = Array.isArray(au) ? au : au.rows || au.items || [];
    const acts = rows.map((x) => x.action);
    assert.ok(acts.includes('backup-summary.csv') && acts.includes('backup-detail.csv'), `감사 로그 ${JSON.stringify(acts)}`);
  } finally { store.snapshot = prev; }
});

test('C 소스 — 스냅샷 요약·매칭은 전체 vms · backupRow 에만 범위 목록', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function vcBackup(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /cachedSnapEvents\(vc\.id, vms,/);
  assert.match(body, /snapCount\(\{ ev, vms \}\)/);
  assert.match(body, /matchToVcenter\(\{ id: vc\.id, host: r\.host \}, vms,/);
  assert.match(body, /backupRow\(\{ vms: sv\.vms,/);
  for (const r of ["'/tools/backup-summary.csv', csvPerm, toolsPerm", "'/tools/backup-detail.csv', csvPerm, toolsPerm"]) assert.ok(src.includes(r), r);
});
