// v2.631 감사 그룹 c — 게스트 디스크 부분 합 보류가 vm_latest 를 얼리던 것(R2631-01) · 폴러 상태에 부분 합 개수(A6-2631-04) ·
// IPAM 예약 만료일 되읽기(R2631-02·A6-2631-02) · 저장 디렉터리 검사의 win32 '/' 시작·'.' 세그먼트(R2631-05).
// 기준 시각은 Date.now() 가 아니라 고정값(CLAUDE.md 규약). DB 는 임시 디렉터리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2631c-'));
process.env.CONFIG_DIR = TMP;
const DB = path.join(TMP, 'guest-disk.db');
process.env.GUESTDISK_DB_PATH = DB;

const sqlite = await import('node:sqlite').catch(() => null);
const SKIP = !sqlite ? 'node:sqlite 미지원 런타임' : false;

// 구버전 DB(vm_latest 에 partial 열 없음)를 먼저 만들어 둔다 — open 이 열을 더하고 옛 행은 온전한 행으로 읽혀야 한다.
if (sqlite) {
  const old = new sqlite.DatabaseSync(DB);
  old.exec(`CREATE TABLE vm_latest (vm_id TEXT PRIMARY KEY, vcenter_id TEXT NOT NULL, vcenter_name TEXT NOT NULL DEFAULT '',
    vm_name TEXT NOT NULL DEFAULT '', alloc_gb REAL NOT NULL DEFAULT 0, used_gb REAL NOT NULL DEFAULT 0,
    part_count INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL)`);
  old.prepare('INSERT INTO vm_latest VALUES (?,?,?,?,?,?,?,?)').run('vcOld:vm-9', 'vcOld', 'VC', 'old', 50, 10, 1, 500);
  old.close();
}

const gd = await import('../src/guestdisk/db.js');
const { sanitizeGuestDiskVms } = await import('../src/guestdisk/analyze.js');
const { reservedUntilIso, reservedUntilDay } = await import('../src/ipam/overrides.js');
const { dirPathIssue } = await import('../src/util/dirPathGuard.js');

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1, 3, 30, 0);   // 고정 기준 시각

function vm(id, parts) {
  let alloc = 0; let used = 0;
  for (const p of parts) if (p.usedGB != null) { alloc += p.capGB; used += p.usedGB; }
  return sanitizeGuestDiskVms([{ vmId: id, vmName: id, allocGB: alloc, usedGB: used, parts }])[0];
}
const one = async (vc, id) => (await gd.listLatest([vc])).find((r) => r.vmId === id);

test('R2631-01 마이그레이션: 옛 DB 에 partial 열을 더하고 옛 행은 온전한 행으로 읽힌다', { skip: SKIP }, async () => {
  const r = await one('vcOld', 'vcOld:vm-9');
  assert.ok(r, '옛 행이 남아 있어야 한다');
  assert.equal(r.partial, undefined);
  assert.equal(r.usedGB, 10);
});

test('R2631-01 재현: 첫 관측이 부분 합이면 다음 부분 합이 값·시각을 갱신한다(얼지 않는다) · 표지로 밝힌다 · 추이에는 넣지 않는다', { skip: SKIP }, async () => {
  const vc = 'vcA'; const id = 'vcA:vm-1';
  let r = await gd.commitCollection(vc, 'VC', [vm(id, [{ path: 'C:\\', capGB: 100, usedGB: 10 }, { path: 'D:\\', capGB: 500, usedGB: null }])], { ts: T0 });
  assert.equal(r.partialVms, 1); assert.equal(r.partialShown, 1); assert.equal(r.partialHeld, 0);
  let l = await one(vc, id);
  assert.equal(l.usedGB, 10); assert.equal(l.partial, true); assert.equal(l.ts, T0);
  r = await gd.commitCollection(vc, 'VC', [vm(id, [{ path: 'C:\\', capGB: 100, usedGB: 80 }, { path: 'D:\\', capGB: 500, usedGB: null }])], { ts: T0 + HOUR });
  l = await one(vc, id);
  assert.equal(l.usedGB, 80, '부분 합 행을 직전 온전한 값으로 오인해 얼리면 안 된다');
  assert.equal(l.ts, T0 + HOUR);
  assert.equal(l.partial, true);
  assert.equal(r.partialHeld, 0);
  assert.deepEqual(await gd.vmSeries(id, 0), [], '부분 합은 vm_series 에 적재하지 않는다');
  const lo = await gd.latestOne(id);
  assert.equal(lo.partial, true);
});

test('R2631-01 보류 시한: 온전한 직전 값은 시한 안에서만 유지되고, 넘으면 부분 합 + 표지로 바뀐다', { skip: SKIP }, async () => {
  const vc = 'vcB'; const id = 'vcB:vm-1';
  const whole = vm(id, [{ path: 'C:\\', capGB: 100, usedGB: 50 }, { path: 'D:\\', capGB: 500, usedGB: 400 }]);
  await gd.commitCollection(vc, 'VC', [whole], { ts: T0 });
  const part = (u) => vm(id, [{ path: 'C:\\', capGB: 100, usedGB: u }, { path: 'D:\\', capGB: 500, usedGB: null }]);
  let r = await gd.commitCollection(vc, 'VC', [part(55)], { ts: T0 + HOUR, holdMaxMs: 6 * HOUR });
  assert.equal(r.partialHeld, 1);
  let l = await one(vc, id);
  assert.equal(l.allocGB, 600); assert.equal(l.ts, T0); assert.equal(l.partial, undefined, '보류 중인 행은 온전한 관측이다');
  r = await gd.commitCollection(vc, 'VC', [part(60)], { ts: T0 + 7 * HOUR, holdMaxMs: 6 * HOUR });
  assert.equal(r.partialHeld, 0); assert.equal(r.partialShown, 1);
  l = await one(vc, id);
  assert.equal(l.allocGB, 100); assert.equal(l.usedGB, 60); assert.equal(l.ts, T0 + 7 * HOUR); assert.equal(l.partial, true);
  // 전부 미보고(알고 있는 파티션 0) — 0/0 을 지어내지 않고 직전 행(부분 합 표지 그대로)을 둔다
  r = await gd.commitCollection(vc, 'VC', [vm(id, [{ path: 'C:\\', capGB: 100, usedGB: null }, { path: 'D:\\', capGB: 500, usedGB: null }])], { ts: T0 + 8 * HOUR, holdMaxMs: 6 * HOUR });
  assert.equal(r.partialStale, 1);
  l = await one(vc, id);
  assert.equal(l.usedGB, 60); assert.equal(l.ts, T0 + 7 * HOUR); assert.equal(l.partial, true);
  // 다시 온전해지면 표지가 지워지고 추이에 적재된다
  r = await gd.commitCollection(vc, 'VC', [vm(id, [{ path: 'C:\\', capGB: 100, usedGB: 70 }, { path: 'D:\\', capGB: 500, usedGB: 400 }])], { ts: T0 + 9 * HOUR, holdMaxMs: 6 * HOUR });
  l = await one(vc, id);
  assert.equal(l.partial, undefined); assert.equal(l.usedGB, 470);
  assert.equal(r.vmSeriesRows, 1);
});

test('A6-2631-04 폴러 상태: 부분 합 개수를 lastResult 에 싣는다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/guestdisk/poller.js', import.meta.url), 'utf8'));
  for (const k of ['partialVms', 'partialHeld', 'partialShown', 'partialStale']) assert.match(src, new RegExp(`r\\.commit\\?\\.${k}`), k);
  assert.match(src, /lastResult = \{[^;]*partialVms/, 'lastResult 에 partialVms');
});

test('R2631-02 예약 만료일: 저장 → 되읽기 → 저장을 반복해도 날짜가 밀리지 않는다(오프셋 540·0·-300·330)', () => {
  for (const off of [540, 0, -300, 330]) {
    let d = '2026-10-01';
    for (let i = 0; i < 4; i++) d = reservedUntilDay(reservedUntilIso(d, off), off);
    assert.equal(d, '2026-10-01', `offset ${off}`);
  }
  assert.equal(reservedUntilDay('2026-10-01', 540), '2026-10-01', '날짜만 온 값은 그대로');
  assert.equal(reservedUntilDay('', 540), '');
  assert.equal(reservedUntilDay(null, 540), '');
  assert.equal(reservedUntilDay('xx', 540), '');
  // 예전 되읽기(slice(0,10))가 틀리던 사례: 오프셋 0 이면 다음 날
  assert.equal(String(reservedUntilIso('2026-10-01', 0)).slice(0, 10), '2026-10-02');
});

test('R2631-02 라우트: IP 조회 응답이 reservedUntilDay·tzOffsetMin 을, 목록·meta 가 tzOffsetMin 을 싣는다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/ipamExport.js', import.meta.url), 'utf8'));
  assert.match(src, /override: ov, reservedUntilDay:/);
  assert.match(src, /rows, tzOffsetMin: DAY_OFFSET_MIN/);
  assert.match(src, /policiesSummary\(polList\), tzOffsetMin: DAY_OFFSET_MIN/);
});

test('R2631-05 dirPathIssue: win32 의 / 시작 경로도 Windows 목록 · . 세그먼트 정규화', () => {
  const w = { platform: 'win32' }; const l = { platform: 'linux' };
  assert.equal(dirPathIssue('/Windows/System32', w), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('/program files/x', w), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('C:\\.\\Windows\\x', w), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('C:\\\\Windows', w), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('C:\\Windows.\\x', w), '시스템 디렉터리 불가', 'Windows 는 이름 끝 점을 무시한다');
  assert.equal(dirPathIssue('D:\\logs', w), '');
  assert.equal(dirPathIssue('/var/log/portal', w), '');
  assert.equal(dirPathIssue('/./etc/x', l), '시스템 디렉터리 불가');
  assert.equal(dirPathIssue('/var/./log', l), '');
  assert.equal(dirPathIssue('/a/../etc', l), '상위 경로(..) 불가');
  // 긴 점 열에서도 선형
  const t = process.hrtime.bigint();
  dirPathIssue(`/${'.'.repeat(200_000)}x/y`, w);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 1000);
});
