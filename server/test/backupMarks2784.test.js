/**
 * v2.784 — 백업 표시(사용자 요청 '업무 중요도 아이콘 · 백업 필요 아이콘 · 백업 관련 메모' + 상단 수 · 서머리 합계 · 다중 선택 일괄 적용).
 *  · 저장소(veeam/backupMarks.js): 있는 키만 바꾼다 · 셋 다 비면 지운다 · 메모는 한 대씩 · 손상이면 보존하고 쓰기 거부(빈 맵 위에 덮지 않는다)
 *  · 집계(markCounts): 범위 목록만 · 미백업(needGap)은 Veeam 을 모르면 null(0 이 아니다)
 *  · 라우트: 역할 → 조회 밖 404 → 쓰기 밖 403 → 그 vCenter 의 VM 만 → 감사 · 저장 즉시 서머리·세부 수가 바뀐다(응답 캐시 키) · CSV 열
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2784-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // Veeam 연결
const SN = 'apac:vc02';   // 연동 없음
const OUT = 'us:vc04';    // 범위 밖
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VC, SN, OUT].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const BM = await import('../src/veeam/backupMarks.js');
const FILE = path.join(DIR, 'backup-marks.json');
const U = { username: 'op1' };

test('A-1 저장소 — 있는 키만 바꾼다 · 셋 다 비면 지운다 · 메모 절단·제어문자 · 다중 메모 400 · 모르는 중요도 400', () => {
  BM._resetMarksForTest(); try { fs.rmSync(FILE); } catch { /* */ }
  const vms = [{ id: 'x:1', name: 'a', vcenterId: 'x' }, { id: 'x:2', name: 'b', vcenterId: 'x' }];
  const r0 = BM.marksRev();
  assert.deepEqual(BM.setMarks(vms, { crit: 'high', need: true }, U), { ok: true, changed: 2, removed: 0 });
  assert.ok(BM.marksRev() > r0, '저장하면 리비전이 오른다(응답 캐시 키)');
  assert.equal(BM.setMarks([vms[0]], { memo: `  메모\u0007${'가'.repeat(1200)}  ` }, U).ok, true);
  let m = BM.getMarks()['x:1'];
  assert.deepEqual([m.crit, m.need, m.memo.length, m.memo.includes('\u0007'), m.by, m.name], ['high', true, BM.MEMO_MAX, false, 'op1', 'a']);
  BM.setMarks(vms, { crit: 'low' }, U);   // 일괄 중요도 — 메모·백업 필요는 그대로
  m = BM.getMarks()['x:1'];
  assert.deepEqual([m.crit, m.need, m.memo.length], ['low', true, BM.MEMO_MAX]);
  assert.equal(BM.setMarks(vms, { memo: 'x' }, U).status, 400, '메모는 한 대씩');
  assert.equal(BM.setMarks(vms, { crit: 'urgent' }, U).status, 400);
  assert.equal(BM.setMarks(vms, { need: 'yes' }, U).status, 400);
  assert.equal(BM.setMarks(vms, {}, U).status, 400);
  BM.setMarks([vms[1]], { crit: '', need: false }, U);
  assert.equal(BM.getMarks()['x:2'], undefined, '셋 다 비면 지운다');
  BM._resetMarksForTest();
  assert.equal(BM.getMarks()['x:1'].crit, 'low', '파일에서 다시 읽는다');
});

test('A-2 손상 — 원본을 보존하고 쓰기는 503(빈 맵 위에 덮지 않는다) · 읽기는 unreadable 을 알린다', () => {
  fs.writeFileSync(FILE, '{"x:1": {"crit": "hi');
  BM._resetMarksForTest();
  assert.deepEqual(BM.getMarks(), {});
  assert.equal(BM.marksUnreadable(), true);
  const r = BM.setMarks([{ id: 'x:9', name: 'z' }], { need: true }, U);
  assert.deepEqual([r.ok, r.status, r.code], [false, 503, 'marksUnreadable']);
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('backup-marks.json.corrupt')), '손상 사본을 남긴다');
  BM._resetMarksForTest(); try { fs.rmSync(FILE); } catch { /* */ }
});

test('A-3 markCounts — 범위 목록만 · 미백업은 Veeam 대상이 아닌 백업 필요 · Veeam 모르면(또는 대조 부재가 모름이면) null', () => {
  const marks = { a: { crit: 'high', need: true }, b: { crit: 'mid', need: true }, c: { crit: 'low' }, z: { crit: 'high', need: true } };
  const vms = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(BM.markCounts(vms, marks, { a: {} }, { veeamKnown: true }), { high: 1, mid: 1, low: 1, need: 2, needGap: 1, method: { veeam: 0, clone: 0, bareos: 0, ssh: 0, config: 0, none: 0, check: 0, unset: 3 } });   // v2.803 백업 방식 — 정하지 않음 3
  assert.equal(BM.markCounts(vms, marks, null, { veeamKnown: false }).needGap, null);
  assert.equal(BM.markCounts(vms, marks, { a: {} }, { veeamKnown: true, absentKnown: false }).needGap, null, '첫 수집 전 서버가 있으면 부재는 모름');
});

test('B 라우트 — 권한·범위·소속 검사 · 감사 · 저장 즉시 수가 바뀐다 · writable · CSV 열 · 비밀 없음', async () => {
  BM._resetMarksForTest(); try { fs.rmSync(FILE); } catch { /* */ }
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const { listAudit } = await import('../src/audit.js');
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'J', type: 'Backup', lastResult: 'Success' }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3 },
  ] });
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VC, SN, OUT].map((id) => ({ id, name: id })), hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${SN}:vm-1`, vcenterId: SN, name: 'app01', powerState: 'POWERED_ON' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', powerState: 'POWERED_ON' },
  ] };
  let user = { username: 'op1', role: 'operator', scope: { vcenters: [VC, SN] } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const put = (body) => fetch(`${base}/tools/backup-detail/marks`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sumRow = async (id) => { const r = (await (await fetch(`${base}/tools/backup-summary`)).json()).rows.find((x) => x.id === id); if (r?.marks) delete r.marks.method; return r; };   // v2.803 백업 방식 수는 backupMethod2803 이 본다
  try {
    assert.deepEqual((await sumRow(VC)).marks, { high: 0, mid: 0, low: 0, need: 0, needGap: 0 }, '먼저 한 번 읽어 응답 캐시를 채운다');
    const det0 = await (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
    assert.equal(det0.writable, true);

    // 범위 밖 404 · 없는 vCenter 404 · 남의 vCenter VM id 400 · 메모 여러 대 400
    assert.equal((await put({ vcenterId: OUT, vmIds: [`${OUT}:vm-1`], need: true })).status, 404);
    assert.equal((await put({ vcenterId: 'nope', vmIds: ['x'], need: true })).status, 404);
    assert.equal((await put({ vcenterId: VC, vmIds: [`${SN}:vm-1`], need: true })).status, 400, '다른 vCenter 의 VM 으로 쓰지 않는다');
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`, `${VC}:vm-2`], memo: 'm' })).status, 400);
    assert.equal(Object.keys(BM.getMarks()).length, 0, '거부된 요청은 아무것도 쓰지 않는다');

    // 일괄 적용 — 저장 즉시 서머리·세부의 수가 바뀐다(캐시 키에 리비전)
    let r = await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`, `${VC}:vm-2`], crit: 'high', need: true });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual((await sumRow(VC)).marks, { high: 2, mid: 0, low: 0, need: 2, needGap: 1 }, 'db01 은 Veeam 대상이 아니다');
    r = await put({ vcenterId: VC, vmIds: [`${VC}:vm-2`], memo: '매일 22시 전체 백업' });
    assert.equal(r.status, 200);
    const det = await (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
    const db = det.vms.find((v) => v.name === 'db01');
    assert.deepEqual([db.m.crit, db.m.need, db.m.memo, db.m.by], ['high', true, '매일 22시 전체 백업', 'op1']);
    assert.equal(det.vms.find((v) => v.name === 'web01').m.memo, '');
    // 연동 없는 vCenter 는 Veeam '없음' 확정 — 백업 필요 표시는 모두 미백업
    assert.equal((await put({ vcenterId: SN, vmIds: [`${SN}:vm-1`], need: true })).status, 200);
    const sum = await (await fetch(`${base}/tools/backup-summary`)).json();
    assert.equal(sum.rows.find((x) => x.id === SN).marks.needGap, 1);
    const { method: _tm, ...tmarks } = sum.totals.marks;
    assert.deepEqual(tmarks, { high: 2, mid: 0, low: 0, need: 3, needGap: 2, needGapUnknown: 0 });

    // 감사 — 대수·바꾼 필드 · 메모는 길이만
    const au = listAudit({ limit: 20 });
    const rows = (Array.isArray(au) ? au : au.rows || au.items || []).filter((x) => x.action === 'backup-marks');
    assert.ok(rows.length >= 3, JSON.stringify(rows));
    assert.ok(rows.some((x) => /2대 · 중요도=high · 백업 필요=표시/.test(x.detail)));
    assert.ok(rows.every((x) => !String(x.detail).includes('22시')), '메모 본문은 감사에 싣지 않는다');

    // 쓰기 범위 밖(조회는 됨) 403 · writable false · viewer(역할) 403
    user = { username: 'op2', role: 'operator', scope: { vcenters: [VC, SN], writeVcenters: [SN] } };
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`], need: false })).status, 403);
    assert.equal((await (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json()).writable, false, '쓰기 가능 여부도 계정마다(캐시 키)');
    user = { username: 'v', role: 'viewer', permissions: ['tools'] };
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`], need: false })).status, 403);
    user = { username: 'demo', role: 'operator', demoGuest: true };
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`], need: false })).status, 403);
    assert.equal(BM.getMarks()[`${VC}:vm-1`].need, true, '거부된 계정은 바꾸지 못했다');

    // CSV — 표시 열 · 비밀 없음
    user = { username: 'adm', role: 'admin' };
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 1 };
    const c1 = await (await fetch(`${base}/tools/backup-detail.csv?vcenterId=${encodeURIComponent(VC)}&filter=needgap`)).text();
    const lines = c1.replace(/^\uFEFF/, '').split('\r\n');
    assert.match(lines[0], /,중요도,백업 필요,메모$/);
    assert.equal(lines.length, 2, '미백업 보기 = db01 하나');
    assert.match(lines[1], /,db01,.*,상,예,매일 22시 전체 백업$/);
    const c2 = await (await fetch(`${base}/tools/backup-summary.csv`)).text();
    assert.match(c2.split('\r\n')[0], /,중요도 상,중요도 중,중요도 하,백업 필요,백업 필요·미백업$/);
    for (const leak of ['svc-bk', 'PW-secret-1', 'vbr-a.corp.local']) assert.equal((c1 + c2).includes(leak), false, leak);
  } finally { store.snapshot = prev; }
});

test('C 소스 — PUT 순서(역할 → 404 → 403 → 소속) · 응답 캐시 키에 표시 리비전', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  const i = src.indexOf("api.put('/tools/backup-detail/marks'");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n  });', i));
  assert.match(body, /toolsPerm, requireRole\('admin', 'operator'\)/);
  const at = (re) => body.search(re);
  const w403 = at(/수정 권한이 없습니다/);
  assert.ok(at(/status\(404\)/) > 0 && at(/status\(404\)/) < w403 && w403 < at(/VM 이 아닌 항목/), '조회 밖 404 → 쓰기 밖 403 → 소속');
  assert.equal((src.match(/\|m\$\{marksRev\(\)\}/g) || []).length, 2, '서머리·세부 둘 다');
});
