/**
 * v2.785(GR R-B2 · R-B3) — 백업 표시 파일(backup-marks.json)을 못 읽었을 때 '0' 을 내지 않는다('못 읽은 값은 0 이 아니다').
 *  · 같은 프로세스에서 손상을 만났으면: 서머리·세부 행 marks = null · 합계 값 null + marksUnknown(그 행 수) · 서머리 CSV 표시 열 빈칸 ·
 *    세부 CSV 중요도·백업 필요 '모름' · 쓰기 503(기존)
 *  · 재시작 뒤(원본은 preserveCorrupt 가 옆으로 옮겨 '파일 없음'): veeam/snapEvents.js corruptKept 와 같은 규칙 — 손상 사본
 *    (backup-marks.json.corrupt.*)이 있는 동안 marksCorruptKept 안내를 응답에 싣고(쓰기는 막지 않는다), 사본을 치우면 사라진다.
 *  · 웹 BackupDetailTool 저장 직후 재조회는 저장한 vCenter·옵션이 지금 고른 것과 같을 때만(R-B3 — 소스 계약은 웹 테스트).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2785f-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';
const SN = 'apac:vc02';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VC, SN].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const BM = await import('../src/veeam/backupMarks.js');
const S = await import('../src/veeam/backupStatus.js');
const FILE = path.join(DIR, 'backup-marks.json');
const corruptCopies = () => fs.readdirSync(DIR).filter((f) => f.startsWith('backup-marks.json.corrupt.'));

test('R-B2 합계 — marks 가 null 인 행은 0 으로 더하지 않는다(값 null + marksUnknown)', () => {
  const ok = { vm: 2, veeam: 1, veeamState: 'ok', snap: 1, split: { both: 1, vOnly: 0, sOnly: 0, none: 1 }, marks: { high: 1, mid: 0, low: 0, need: 1, needGap: 0 } };
  const t = S.backupTotals([ok, { ...ok, marks: null }]);
  assert.equal(t.marksUnknown, 1);
  assert.deepEqual(t.marks, { high: null, mid: null, low: null, need: null, needGap: null, needGapUnknown: 0, method: null }, '부분 합을 합계로 내지 않는다(v2.803 백업 방식 수도)');
  const k = S.backupTotals([ok]);
  assert.equal(k.marksUnknown, 0);
  assert.deepEqual(k.marks, { high: 1, mid: 0, low: 0, need: 1, needGap: 0, needGapUnknown: 0, method: { veeam: 0, clone: 0, config: 0, none: 0, check: 0, unset: 0 } }, '읽은 경우는 그대로(옛 행 — method 없음은 0)');
});

test('R-B2 라우트 — 손상 파일: 서머리·세부 marks null · 합계 null · CSV 빈칸/모름 · 재시작 뒤 손상 사본 안내(지우면 사라진다)', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const snapAt = (g) => ({ source: 'live', generatedAt: g, vcenters: [VC, SN].map((id) => ({ id, name: id })), hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON' },
    { id: `${SN}:vm-1`, vcenterId: SN, name: 'app01', folder: 'DC/vm/B', powerState: 'POWERED_ON' },
  ] });
  const user = { username: 'adm', role: 'admin' };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const j = async (p) => (await fetch(`${base}${p}`)).json();
  const tx = async (p) => (await (await fetch(`${base}${p}`)).text()).replace(/^﻿/, '').split('\r\n');
  try {
    // ① 같은 프로세스에서 손상을 만난다(이전에 표시가 있었다 — 0 이 아니라 모름)
    fs.writeFileSync(FILE, '{"apac:vc01:vm-1": {"crit": "hi');
    BM._resetMarksForTest();
    store.snapshot = snapAt(NOW);
    const sum = await j('/tools/backup-summary');
    assert.equal(sum.marksUnreadable, true);
    for (const r of sum.rows) assert.equal(r.marks, null, `${r.id} 행 marks 는 모름(null) — 0 이 아니다`);
    assert.equal(sum.totals.marksUnknown, 2);
    for (const k of ['high', 'mid', 'low', 'need', 'needGap']) assert.equal(sum.totals.marks[k], null, `totals.marks.${k}`);
    const det = await j(`/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`);
    assert.equal(det.marksUnreadable, true);
    assert.equal(det.row.marks, null);
    const c1 = await tx('/tools/backup-summary.csv');
    const head = c1[0].split(',');
    const iHigh = head.indexOf('중요도 상');
    assert.ok(iHigh > 0);
    for (const line of c1.slice(1)) assert.deepEqual(line.split(',').slice(iHigh), ['', '', '', '', ''], `서머리 CSV 표시 열은 빈칸: ${line}`);
    const c2 = await tx(`/tools/backup-detail.csv?vcenterId=${encodeURIComponent(VC)}`);
    assert.match(c2[1], /,web01,.*,모름,모름,$/, '세부 CSV — 중요도·백업 필요는 모름(빈칸이면 \'없음\' 으로 읽힌다)');
    const w = BM.setMarks([{ id: `${VC}:vm-1`, name: 'web01' }], { need: true }, { username: 'adm' });
    assert.equal(w.status, 503, '쓰기 거부는 그대로');
    assert.equal(corruptCopies().length, 1);
    assert.equal(fs.existsSync(FILE), false, 'preserveCorrupt 가 원본을 옆으로 옮겼다');

    // ② 재시작 — 원본 없음 + 손상 사본: 조용히 0 으로 보이지 않게 안내(snapEvents corruptKept 와 같은 규칙 — 쓰기는 연다)
    BM._resetMarksForTest();
    store.snapshot = snapAt(NOW + 1);
    assert.equal(BM.marksUnreadable(), false);
    assert.equal(BM.marksCorruptKept(), true);
    const sum2 = await j('/tools/backup-summary');
    assert.equal(sum2.marksUnreadable, undefined);
    assert.equal(sum2.marksCorruptKept, true, '서머리에 손상 사본 안내');
    const det2 = await j(`/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`);
    assert.equal(det2.marksCorruptKept, true, '세부에 손상 사본 안내');
    assert.equal(BM.setMarks([{ id: `${VC}:vm-1`, name: 'web01' }], { need: true }, { username: 'adm' }).ok, true, '재시작 뒤 쓰기는 열린다(새 파일)');
    assert.equal(BM.marksCorruptKept(), true, '새 파일이 생겨도 사본이 있는 동안은 안내를 유지한다(snapEvents 와 같다)');

    // ③ 관리자가 사본을 치우면 안내가 사라진다
    for (const f of corruptCopies()) fs.rmSync(path.join(DIR, f));
    store.snapshot = snapAt(NOW + 2);
    assert.equal(BM.marksCorruptKept(), false);
    const sum3 = await j('/tools/backup-summary');
    assert.equal(sum3.marksCorruptKept, undefined);
    const { method: _m3, ...marks3 } = sum3.rows.find((r) => r.id === VC).marks;   // v2.803 백업 방식 수는 backupMethod2803 이 본다
    assert.deepEqual(marks3, { high: 0, mid: 0, low: 0, need: 1, needGap: 1 });
  } finally { store.snapshot = prev; }
});

test('R-B2 소스 — 손상 상태에서 marks 를 markCounts 로 세지 않는다 · 같은 프로세스 손상이면 손상 사본 안내는 겹쳐 싣지 않는다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(src, /row\.marks = marksUnreadable\(\) \? null : markCounts\(/);
  assert.equal((src.match(/marksCorruptKept: \(!unreadable && marksCorruptKept\(\)\) \|\| undefined/g) || []).length, 2, '서머리·세부 둘 다');
});
