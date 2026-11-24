/**
 * v3.10.3 — 공통 기능 점검 1회차(서버 공용 유틸 사용처 상위 30개) 회귀.
 *
 *  ① exportBusy — 잠금에 시한: 시한을 넘긴 점유는 다음 요청이 넘겨받고, 늦게 끝난 옛 작업의 release 는 새 점유를 지우지 않는다.
 *     (실제 사고 — 끊긴 소켓의 drain 을 기다리던 GPU 내보내기가 재시작 전까지 이름을 붙잡았다: routes/api/hardwareGpu.js 주석)
 *  ② ipv4.cidrMatch — IPv4 수가 아닌 n(null · NaN · 음수 · 소수 · 2^32 이상)은 판정하지 않는다(null). 예전에는 0(= 0.0.0.0)으로 읽혀 '0.0.0.0/0' 과 일치했다.
 *  ③ dayKey.dayLabel · localClock — 수가 아닌 입력에서 RangeError 로 던지지 않는다.
 *  ④ atomicWrite — 같은 ms 에 같은 파일을 두 번 써도 임시 이름이 겹치지 않고, 문자열 · Buffer · 기타 값이 그대로 쓰인다.
 *  ⑤ withDeadline — 시한 오류가 원래 오류를 cause 로 남긴다. ⑥ secretCarry — 본문이 null 이어도 던지지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireExport, exportBusyOf, exportLockMaxMs, _resetExportBusy } from '../src/util/exportBusy.js';
import { cidrMatch, ipToNum } from '../src/util/ipv4.js';
import { dayLabel, localClock, dayIndex, DAY_MS } from '../src/util/dayKey.js';
import { atomicWriteFileSync } from '../src/util/atomicWrite.js';
import { withDeadline } from '../src/util/deadline.js';
import { accessMoved, dropCarriedSecrets } from '../src/util/secretCarry.js';

test('① exportBusy — 시한을 넘긴 점유는 넘겨받는다 · 옛 release 는 새 점유를 지우지 않는다', () => {
  _resetExportBusy();
  const t0 = 1_700_000_000_000;
  const a = acquireExport('x', { user: { username: 'u1' } }, { now: t0, maxMs: 60_000 });
  assert.equal(a.ok, true);
  // 시한 안 — 409.
  const b = acquireExport('x', { user: { username: 'u2' } }, { now: t0 + 59_000, maxMs: 60_000 });
  assert.equal(b.ok, false);
  assert.equal(b.status, 409);
  assert.equal(/u1/.test(b.body.reason), false, '다른 사용자의 계정명을 싣지 않는다');
  // 시한 지남 — 넘겨받는다.
  const warn = console.warn; const warned = [];
  console.warn = (m) => warned.push(String(m));
  let c;
  try { c = acquireExport('x', { user: { username: 'u2' } }, { now: t0 + 61_000, maxMs: 60_000 }); } finally { console.warn = warn; }
  assert.equal(c.ok, true);
  assert.equal(warned.length, 1);
  assert.equal(/u1|u2/.test(warned[0]), false, '경고에도 계정명을 싣지 않는다');
  // 늦게 끝난 옛 작업의 release — 새 점유는 그대로.
  a.release();
  assert.equal(exportBusyOf('x')?.user, 'u2');
  c.release();
  assert.equal(exportBusyOf('x'), null);
  _resetExportBusy();
});

test('① exportLockMaxMs — 기본 30분 · 1분~6시간 · 숫자가 아니면 기본', () => {
  assert.equal(exportLockMaxMs({}), 30 * 60_000);
  assert.equal(exportLockMaxMs({ EXPORT_LOCK_MAX_MS: '' }), 30 * 60_000);
  assert.equal(exportLockMaxMs({ EXPORT_LOCK_MAX_MS: 'abc' }), 30 * 60_000);
  assert.equal(exportLockMaxMs({ EXPORT_LOCK_MAX_MS: '-5' }), 30 * 60_000);
  assert.equal(exportLockMaxMs({ EXPORT_LOCK_MAX_MS: '10' }), 60_000);
  assert.equal(exportLockMaxMs({ EXPORT_LOCK_MAX_MS: String(10 * 3_600_000) }), 6 * 3_600_000);
  assert.equal(exportLockMaxMs({ EXPORT_LOCK_MAX_MS: '600000' }), 600_000);
});

test('② cidrMatch — IPv4 수가 아니면 null(0.0.0.0 으로 읽지 않는다)', () => {
  for (const bad of [null, undefined, NaN, -1, 1.5, 2 ** 32, '10.0.0.1', '']) {
    assert.equal(cidrMatch(bad, '0.0.0.0/0'), null, `${String(bad)} 가 0.0.0.0/0 과 일치하면 안 된다`);
    assert.equal(cidrMatch(bad, '0.0.0.0/8'), null);
  }
  assert.equal(cidrMatch(0, '0.0.0.0/8'), true, '진짜 0.0.0.0 은 그대로 판정한다(transportPolicy 의 항목 검증이 0 을 쓴다)');
  assert.equal(cidrMatch(ipToNum('10.1.2.3'), '10.0.0.0/8'), true);
  assert.equal(cidrMatch(ipToNum('11.1.2.3'), '10.0.0.0/8'), false);
  assert.equal(cidrMatch(ipToNum('255.255.255.255'), '255.255.255.255'), true);
  assert.equal(cidrMatch(ipToNum('10.1.2.3'), 'x/8'), null);
});

test('③ dayLabel · localClock — 수가 아닌 입력에서 던지지 않는다', () => {
  assert.equal(dayLabel(NaN), '');
  assert.equal(dayLabel(dayIndex('2026-11-14T00:00:00Z')), '', 'ISO 문자열을 dayIndex 에 넣으면 NaN — 예전에는 RangeError');
  assert.equal(dayLabel(undefined), '');
  assert.equal(dayLabel(1e12), '', '날짜 범위 밖');
  const day = dayIndex(Date.UTC(2026, 10, 14, 3, 0, 0), 540);
  assert.equal(dayLabel(day, 540), '2026-11-14');
  assert.equal(dayLabel(20406, 0), new Date(20406 * DAY_MS).toISOString().slice(0, 10));
  assert.deepEqual(localClock('2026-11-14', 540), { day: '', hour: null, minute: null, offsetMin: 540 });
  assert.deepEqual(localClock(NaN, 0), { day: '', hour: null, minute: null, offsetMin: 0 });
  assert.deepEqual(localClock(Date.UTC(2026, 10, 14, 15, 30), 540), { day: '2026-11-15', hour: 0, minute: 30, offsetMin: 540 });
});

test('④ atomicWrite — 같은 ms 에 두 번 써도 임시 이름이 겹치지 않고 내용이 그대로', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw3102-'));
  try {
    const f = path.join(dir, 'a.json');
    const realNow = Date.now;
    const seen = [];
    const realOpen = fs.openSync;
    Date.now = () => 1_700_000_000_000;
    fs.openSync = function patched(p, ...rest) { if (String(p).includes('.tmp-')) seen.push(path.basename(String(p))); return realOpen.call(this, p, ...rest); };
    try {
      atomicWriteFileSync(f, '첫째');
      atomicWriteFileSync(f, '둘째 — 한글 · 이모지 없이 긴 글 '.repeat(2000));
    } finally { Date.now = realNow; fs.openSync = realOpen; }
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1], `같은 ms 의 임시 이름이 겹쳤다: ${seen[0]}`);
    assert.equal(fs.readFileSync(f, 'utf8'), '둘째 — 한글 · 이모지 없이 긴 글 '.repeat(2000));
    atomicWriteFileSync(f, Buffer.from([1, 2, 3]));
    assert.deepEqual([...fs.readFileSync(f)], [1, 2, 3]);
    atomicWriteFileSync(f, new Uint8Array([4, 5]));
    assert.deepEqual([...fs.readFileSync(f)], [4, 5]);
    assert.deepEqual(fs.readdirSync(dir), ['a.json'], '임시 파일이 남지 않는다');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('⑤ withDeadline — 시한 오류가 원래 오류를 cause 로 남긴다', async () => {
  const err = await withDeadline(1_000, (signal) => new Promise((_, rej) => {
    signal.addEventListener('abort', () => rej(new Error('소켓을 끊었다')));
  }), '수집 타임아웃').catch((e) => e);
  assert.equal(err.message, '수집 타임아웃(1초)');
  assert.equal(err.cause?.message, '소켓을 끊었다');
  // 시한 전에 실패하면 원래 오류 그대로.
  const plain = await withDeadline(1_000, async () => { throw new Error('바로 실패'); }).catch((e) => e);
  assert.equal(plain.message, '바로 실패');
});

test('⑥ secretCarry — 본문이 null 이어도 던지지 않는다', () => {
  assert.equal(accessMoved({ host: 'a' }, null), false);
  assert.equal(accessMoved({ host: 'a' }, { host: 'b' }), true);
  const t = { password: 'x', host: 'a' };
  assert.deepEqual(dropCarriedSecrets(t, null, ['password']), ['password']);
  assert.equal(t.password, undefined);
  assert.deepEqual(dropCarriedSecrets(null, {}, ['password']), []);
});
