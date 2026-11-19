/**
 * 전체 점검 125회차 — 공용 '데이터 안전' 유틸 2차(읽기 판정 · 원자 쓰기 · 지연 쓰기 · 상태 파일) 회귀.
 *   108회차가 '코드만 훑었다 · 실패 주입을 해 보지 않았다' 로 남긴 묶음을 실제로 돌려(오류 주입 · 권한을 내린 프로세스 · tmpfs ENOSPC) 찾은 것.
 *
 *  F1 util/atomicWrite atomicWriteFileSync — v3.10.3 이 '그 밖의 값' 을 String(data ?? '') 로 바꿔 쓰게 하면서 `JSON.stringify(undefined)`(= undefined) ·
 *     null 이 **0바이트 파일로 원본을 대신**했다(객체는 '[object Object]'). 그 전에는 fs.writeSync 가 ERR_INVALID_ARG_TYPE 로 던져 원본이 남았다.
 *  F2 util/jsonFileRead makeJsonFileReader · util/jsonFileLoad(recheckDue · probe) · util/sqliteOpen createLockRetry — 재읽기 간격을 `now < retryAt` 로만 봐서
 *     벽시계가 뒤로 가면 그 차만큼 간격이 늘어났다(9시간 뒤로 = 파일을 바로잡아도 9시간 쓰기 거절 · DB 는 9시간 다시 열지 않음).
 *  F3 util/bulkAdvice preflightHints — `.replace(/\/.*$/, '')` 가 줄바꿈이 든 host 칸에서 O(n²)(셀 8,192자 한 칸 약 45ms × 행 2,000).
 *  F4 util/scanJournal processScanResumes — 재개 함수를 기다리는 사이 같은 대상이 다른 경로로 시작되면 같은 실행이 이력에 두 줄 ·
 *     이미 이력으로 간 뒤 항목의 재개 함수도 불렀다(끝난 스캔을 한 번 더 시작할 수 있다).
 *  F5 util/atomicWrite preserveCorrupt — 옮기기 실패가 무음(원본은 그 자리 · 보존본 0개 · 콘솔 0줄).
 *
 *  확인만 한 것(결함 없음 — 고정해 둔다): 읽기 오류 분류표(ENOENT 만 없음 · 그 밖의 읽기 단계 실패는 원본을 옮기지 않는다 · parse 실패만 보존) ·
 *    쓰기 실패(ENOSPC · 짧은 쓰기 · fsync · rename)에서 원본 온전 + 임시 파일 없음 · userDocWriter 의 '마지막 값이 이긴다' 와 종료 flush 순서.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'utilSafety125-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { atomicWriteFileSync, preserveCorrupt } = await import('../src/util/atomicWrite.js');
const jr = await import('../src/util/jsonFileRead.js');
const { makeJsonFileLoader } = await import('../src/util/jsonFileLoad.js');
const { recheckSettingsFiles } = await import('../src/util/settingsLoadError.js');
const { makeLoadError } = await import('../src/util/registryCore.js');
const { createLockRetry } = await import('../src/util/sqliteOpen.js');
const { preflightHints } = await import('../src/util/bulkAdvice.js');
const { createUserDocWriter } = await import('../src/util/userDocWriter.js');
const J = await import('../src/util/scanJournal.js');

let seq = 0;
const caseDir = () => { const d = path.join(TMP, `c${++seq}`); fs.mkdirSync(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 콘솔을 잠시 모은다(경고 줄 수를 세고, 테스트 출력도 조용히). */
function quiet(fn) {
  const w = console.warn; const e = console.error; const lines = [];
  console.warn = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
  const done = () => { console.warn = w; console.error = e; };
  let r;
  try { r = fn(lines); } catch (err) { done(); throw err; }
  if (r && typeof r.then === 'function') return r.finally(done).then(() => lines);
  done();
  return lines;
}
/** 그 파일의 readFileSync 를 code 로 실패시킨다(읽기 단계 오류 주입). 되돌리는 함수를 준다. */
function failRead(file, state) {
  const real = fs.readFileSync;
  fs.readFileSync = function patched(p, ...a) {
    if (String(p) === file) { state.reads = (state.reads || 0) + 1; if (state.code) throw Object.assign(new Error(`${state.code}: injected, open '${p}'`), { code: state.code }); }
    return real.call(this, p, ...a);
  };
  return () => { fs.readFileSync = real; };
}
// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md) — 여기서는 상대 차이만 본다.
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 17 * 60_000;

/* ── F1 atomicWriteFileSync 본문 형식 ─────────────────────────────────────── */
test('F1 문자열 · Buffer 가 아닌 본문은 던지고 원본 · 폴더를 건드리지 않는다(예전: 0바이트로 원본을 대신)', () => {
  const ORIG = '{"devices":[{"id":"a"},{"id":"b"}]}';
  for (const [label, data] of [['undefined', JSON.stringify(undefined)], ['null', null], ['수', 5], ['객체', { a: 1 }], ['배열', [1]], ['ArrayBuffer', new Uint8Array([123, 125]).buffer], ['참', true]]) {
    const d = caseDir(); const f = path.join(d, 'reg.json'); fs.writeFileSync(f, ORIG);
    assert.throws(() => atomicWriteFileSync(f, data), (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE', `${label} 본문이 통과했다`);
    assert.equal(fs.readFileSync(f, 'utf8'), ORIG, `${label}: 원본이 바뀌었다`);
    assert.deepEqual(fs.readdirSync(d), ['reg.json'], `${label}: 임시 파일이 남았다`);
  }
  // 없는 폴더는 만들지도 않는다(임시 파일 · mkdir 전에 던진다)
  const nd = path.join(TMP, 'f1-nodir');
  assert.throws(() => atomicWriteFileSync(path.join(nd, 'x.json'), undefined), TypeError);
  assert.equal(fs.existsSync(nd), false);
  // 오류 문구에 본문 · 전체 경로가 없다(파일 이름만)
  try { atomicWriteFileSync(path.join(TMP, 'secret-dir-name', 'x.json'), { password: 'S3cret!' }); assert.fail('던져야 한다'); } catch (e) {
    assert.ok(!e.message.includes('S3cret') && !e.message.includes('secret-dir-name') && e.message.includes('x.json'), e.message);
  }
});

test('F1 문자열(빈 글 포함) · Buffer · TypedArray · DataView 는 예전대로 쓴다', () => {
  const d = caseDir(); const f = path.join(d, 'a.bin');
  atomicWriteFileSync(f, '가나다'); assert.equal(fs.readFileSync(f, 'utf8'), '가나다');
  atomicWriteFileSync(f, ''); assert.equal(fs.statSync(f).size, 0);
  atomicWriteFileSync(f, Buffer.from([1, 2, 3])); assert.deepEqual([...fs.readFileSync(f)], [1, 2, 3]);
  atomicWriteFileSync(f, new Uint8Array([4, 5])); assert.deepEqual([...fs.readFileSync(f)], [4, 5]);
  atomicWriteFileSync(f, new DataView(new Uint8Array([6, 7, 8]).buffer, 1, 2)); assert.deepEqual([...fs.readFileSync(f)], [7, 8]);
  atomicWriteFileSync(f, new Uint16Array([0x0201]).subarray(0, 1)); assert.equal(fs.statSync(f).size, 2);
  assert.deepEqual(fs.readdirSync(d), ['a.bin']);
});

/* ── 확인: 쓰기 실패에서 원본 온전 · 임시 파일 없음 ───────────────────────── */
test('확인: 쓰기 실패(ENOSPC · 0바이트 쓰기 · fsync · rename)에서 원본이 온전하고 임시 파일이 남지 않는다 · 짧은 쓰기는 끝까지 쓴다', () => {
  const cases = [
    ['writeSync ENOSPC', 'writeSync', (real) => { let n = 0; return (fd, b, o, l) => { if (n++ === 0) return real(fd, b, o, Math.min(l, 3)); throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); }; }, 'ENOSPC'],
    ['writeSync 0', 'writeSync', () => () => 0, null],
    ['fsync EIO', 'fsyncSync', () => () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }, 'EIO'],
    ['rename EXDEV', 'renameSync', () => () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); }, 'EXDEV'],
  ];
  for (const [label, fnName, mk, code] of cases) {
    const d = caseDir(); const f = path.join(d, 'reg.json'); fs.writeFileSync(f, 'ORIG');
    const real = fs[fnName]; fs[fnName] = mk(real);
    try { assert.throws(() => atomicWriteFileSync(f, 'NEW-CONTENT-0123456789'), (e) => (code ? e.code === code : /진행되지/.test(e.message)), label); } finally { fs[fnName] = real; }
    assert.equal(fs.readFileSync(f, 'utf8'), 'ORIG', `${label}: 원본이 바뀌었다`);
    assert.deepEqual(fs.readdirSync(d), ['reg.json'], `${label}: 임시 파일이 남았다`);
  }
  const d = caseDir(); const f = path.join(d, 'reg.json'); fs.writeFileSync(f, 'ORIG');
  const real = fs.writeSync; fs.writeSync = (fd, b, o, l) => real(fd, b, o, Math.min(l, 3));
  try { atomicWriteFileSync(f, 'NEW-CONTENT-0123456789'); } finally { fs.writeSync = real; }
  assert.equal(fs.readFileSync(f, 'utf8'), 'NEW-CONTENT-0123456789');
});

/* ── 확인: 읽기 판정 분류표 ──────────────────────────────────────────────── */
test('확인: 읽기 분류표 — 없음은 ENOENT 뿐 · 읽기 단계 실패는 원본을 옮기지 않고 쓰기를 거절 · parse 실패만 보존본으로', () => quiet(() => {
  const moved = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(`${path.basename(f)}.corrupt.`)).length;
  // 없음
  { const d = caseDir(); const f = path.join(d, 'x.json'); assert.equal(jr.readJsonFile(f).kind, 'missing'); }
  // 읽기 단계 실패(진짜): 경로 중간이 파일 · 그 자리에 폴더 · 링크 고리 · 이름 초과
  { const d = caseDir(); fs.writeFileSync(path.join(d, 'mid'), 'x'); const r = jr.readJsonFile(path.join(d, 'mid', 'x.json')); assert.equal(r.kind, 'read-error'); assert.equal(r.error.code, 'ENOTDIR'); }
  { const d = caseDir(); const f = path.join(d, 'x.json'); fs.mkdirSync(f); const r = jr.readJsonFile(f); assert.equal(r.kind, 'read-error'); assert.equal(r.error.code, 'EISDIR'); assert.equal(moved(f), 0); }
  { const d = caseDir(); const f = path.join(d, 'x.json'); fs.symlinkSync(f, path.join(d, 'y.json')); fs.symlinkSync(path.join(d, 'y.json'), f); assert.equal(jr.readJsonFile(f).error?.code, 'ELOOP'); }
  { const d = caseDir(); assert.equal(jr.readJsonFile(path.join(d, `${'a'.repeat(300)}.json`)).error?.code, 'ENAMETOOLONG'); }
  // 읽기 단계 실패(주입): 등록부 판정까지 — 원본 그대로 · 쓰기 거절 · 손상 보존 없음
  for (const code of ['EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EIO', 'ESTALE', 'EBUSY', 'ENOMEM', 'ERR_FS_FILE_TOO_LARGE', 'ERR_STRING_TOO_LONG']) {
    const d = caseDir(); const f = path.join(d, 'x.json'); fs.writeFileSync(f, '{"a":1}');
    const st = { code }; const undo = failRead(f, st);
    try {
      const le = makeLoadError(); const r = le.read(f); le.checkCorruptOnly(f);
      assert.deepEqual(r, { kind: 'read-error', code }, code);
      assert.equal(le.writeRefusal('X')?.code, 'registry-unreadable', `${code}: 쓰기가 열렸다`);
      assert.throws(() => le.assertWritable('X'), (e) => e.readError === true);
      const L = makeJsonFileLoader(() => f, { label: `t-${code}`, confirm: () => {} });
      assert.equal(L.load().kind, 'read-error'); assert.equal(L.refusal('X')?.readError, true);
    } finally { undo(); }
    assert.equal(moved(f), 0, `${code}: 읽기 오류인데 원본을 옮겼다`);
    assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  }
  // parse 실패: 0바이트 · 공백 · BOM · NUL · 잘림 → 손상(보존본 1개)
  for (const [label, body] of [['0바이트', ''], ['공백', ' \n\t'], ['BOM', '﻿{"a":1}'], ['NUL', Buffer.alloc(32)], ['잘림', '{"devices":[{"id":"a","pw":"S3c']]) {
    const d = caseDir(); const f = path.join(d, 'x.json'); fs.writeFileSync(f, body);
    const r = jr.readJsonFile(f);
    assert.equal(r.kind, 'corrupt', label); assert.equal(moved(f), 1, label); assert.equal(fs.existsSync(f), false, label);
  }
  // 객체 판정(기본 parse): null 은 {} · 배열 · 수 · 글자는 손상
  { const d = caseDir(); const f = path.join(d, 'x.json'); fs.writeFileSync(f, 'null'); assert.deepEqual(jr.readJsonFile(f).value, {}); }
  for (const body of ['[1,2]', '5', '"live"']) { const d = caseDir(); const f = path.join(d, 'x.json'); fs.writeFileSync(f, body); assert.equal(jr.readJsonFile(f).kind, 'corrupt', body); }
}));

/* ── F2 재읽기 간격 — 벽시계가 뒤로 감 ───────────────────────────────────── */
test('F2 inRetryWindow — 간격 안만 참 · 간격을 건 시각보다 앞(시계가 뒤로 감)이면 거짓', () => {
  const at = T0 + 30_000;
  assert.equal(jr.inRetryWindow(T0, at, 30_000), true);
  assert.equal(jr.inRetryWindow(T0 + 29_999, at, 30_000), true);
  assert.equal(jr.inRetryWindow(T0 + 30_000, at, 30_000), false);
  assert.equal(jr.inRetryWindow(T0 - 1, at, 30_000), false);
  assert.equal(jr.inRetryWindow(T0 - 9 * 3_600_000, at, 30_000), false);
  assert.equal(jr.inRetryWindow(T0, 0, 30_000), false);
});

test('F2 reader — 읽기 오류 뒤 시계가 1시간 뒤로 가도 곧바로 다시 읽는다 · 간격 안에서는 디스크를 보지 않는다', () => quiet(() => {
  let T = T0; jr._setJsonFileLoadClockForTest(() => T);
  const d = caseDir(); const f = path.join(d, 'a.json'); fs.writeFileSync(f, '{"a":1}');
  const st = { code: 'EACCES' }; const undo = failRead(f, st);
  try {
    const rd = jr.makeJsonFileReader(() => f);
    assert.equal(rd.read().kind, 'read-error');
    const n0 = st.reads; T += 10_000;
    for (let i = 0; i < 50; i++) assert.equal(rd.read().deferred, true);
    assert.equal(st.reads, n0, '간격 안인데 디스크를 읽었다');
    st.code = null;                 // 권한을 바로잡았다
    T += 19_999; assert.equal(rd.read().deferred, true, '29.999초 — 아직 간격 안');
    T -= 3_600_000;                 // 시계가 1시간 뒤로
    assert.equal(rd.read().kind, 'ok', '시계가 뒤로 갔는데 간격이 그 차만큼 늘어났다');
    // 다시 오류 → 정상 간격은 그대로(30초 뒤 다시 읽는다)
    st.code = 'EIO'; assert.equal(rd.read().kind, 'read-error'); st.code = null;
    T += 29_999; assert.equal(rd.read().deferred, true);
    T += 2; assert.equal(rd.read().kind, 'ok');
  } finally { undo(); jr._setJsonFileLoadClockForTest(); }
}));

test('F2 등록부 · 설정 로더 — 시계가 9시간 뒤로 가도 파일을 바로잡으면 쓰기 거절이 곧바로 풀린다', () => quiet(() => {
  let T = T0; jr._setJsonFileLoadClockForTest(() => T);
  const d = caseDir(); const f = path.join(d, 'b.json'); const g = path.join(d, 'c.json');
  fs.writeFileSync(f, '{"a":1}'); fs.writeFileSync(g, '{"a":1}');
  const sf = { code: 'EIO' }; const sg = { code: 'EIO' }; const undoF = failRead(f, sf);
  try {
    const le = makeLoadError();
    assert.equal(le.read(f).kind, 'read-error'); assert.ok(le.writeRefusal('X'));
    sf.code = null; T -= 9 * 3_600_000;
    assert.equal(le.read(f).kind, 'ok'); assert.equal(le.writeRefusal('X'), null); assert.equal(le.get(), null);
  } finally { undoF(); }
  const undoG = failRead(g, sg);
  try {
    T = T0;
    const L = makeJsonFileLoader(() => g, { label: 'f2-loader', confirm: () => {} });
    assert.equal(L.load().kind, 'read-error'); assert.equal(L.recheckDue(), false, '간격 안 — 아직 다시 읽을 때가 아니다');
    sg.code = null; T -= 9 * 3_600_000;
    assert.equal(L.recheckDue(), true, '시계가 뒤로 갔는데 다시 판정하지 않는다');
    assert.equal(L.load().kind, 'ok'); assert.equal(L.refusal('X'), null);
    // 서비스 점검 조회(probe)도 같다
    sg.code = 'EIO'; T = T0 + 3_600_000; assert.equal(L.load().kind, 'read-error');
    sg.code = null; T -= 9 * 3_600_000;
    assert.equal(recheckSettingsFiles() >= 1, true, '서비스 점검 재판정이 시계가 뒤로 간 동안 멈췄다');
    assert.equal(L.recheckDue(), true); assert.equal(L.load().kind, 'ok');
  } finally { undoG(); jr._setJsonFileLoadClockForTest(); }
}));

test('F2 createLockRetry — 잠금 뒤 30초는 막고, 시계가 뒤로 가면 막지 않는다', () => {
  const lr = createLockRetry(30_000);
  const lock = Object.assign(new Error('database is locked'), { errcode: 5 });
  assert.equal(lr.blocked(T0), false);
  assert.equal(lr.onFail(lock, T0), true);
  assert.equal(lr.blocked(T0), true); assert.equal(lr.blocked(T0 + 29_999), true); assert.equal(lr.blocked(T0 + 30_000), false);
  assert.equal(lr.blocked(T0 - 1), false); assert.equal(lr.blocked(T0 - 9 * 3_600_000), false, '시계가 9시간 뒤로 갔는데 9시간 동안 다시 열지 않는다');
  assert.equal(lr.onFail(new Error('disk I/O error'), T0), false);
  lr.ok(); assert.equal(lr.blocked(T0 + 1), false);
});

/* ── F3 bulkAdvice ───────────────────────────────────────────────────────── */
test('F3 preflightHints — URL 조언은 첫 / 앞까지의 주소를 보여 준다(줄바꿈이 있어도)', () => {
  const adv = (host) => preflightHints([{ _line: 3, host }], []).map((h) => h.advice);
  assert.ok(adv('https://10.0.0.1')[0].includes('— 10.0.0.1 처럼'));
  assert.ok(adv('https://10.0.0.1/ui/login')[0].includes('— 10.0.0.1 처럼'));
  assert.ok(adv('HTTP://vc.example.com:8443/x')[0].includes('— vc.example.com:8443 처럼'));
  assert.ok(adv('https://10.0.0.1/a\nb/c')[0].includes('— 10.0.0.1 처럼'));
  assert.equal(adv('10.0.0.1').length, 0);
});

test('F3 preflightHints — 슬래시가 이어지고 줄바꿈이 든 host 에서 시간이 길이에 비례한다(예전: 제곱)', () => {
  const rows = (n) => Array.from({ length: 20 }, (_, i) => ({ _line: i + 1, host: `https://${'/'.repeat(n)}\nx` }));
  const small = rows(1_000); const large = rows(8_000);
  const time = (r) => { const t0 = performance.now(); preflightHints(r, ['host']); return performance.now() - t0; };
  time(small); time(large);   // 예열
  let s = Infinity; let l = Infinity;
  for (let i = 0; i < 5; i++) { s = Math.min(s, time(small)); l = Math.min(l, time(large)); }   // 번갈아 재 각각 최솟값(docs/rules/common.md)
  const ratio = l / Math.max(s, 0.02);
  assert.ok(ratio < 24, `8배 입력에 ${ratio.toFixed(1)}배(작은 쪽 ${s.toFixed(2)}ms · 큰 쪽 ${l.toFixed(2)}ms) — 선형이면 8 안팎, 제곱이면 64`);
});

/* ── F4 scanJournal ─────────────────────────────────────────────────────── */
test('F4 재개 함수를 기다리는 사이 다른 경로로 시작된 스캔 — 이력은 한 줄 · 이미 이력으로 간 항목의 재개 함수는 부르지 않는다', async () => {
  await quiet(async () => {
    J._resetForTest();
    J.scanStarted('isidu', 't1', { label: 'T1', trigger: 'cycle' });
    J.scanStarted('isidu', 't2', { label: 'T2', trigger: 'cycle' });
    J._reloadForTest();   // 새 기동 — 둘 다 '재시작으로 중단됨'
    assert.equal(J.scanJournalStatus().interrupted.length, 2);
    const called = [];
    let release; const gate = new Promise((r) => { release = r; });
    J.registerScanResumer('isidu', async (e) => {
      called.push(e.key);
      if (e.key === 't1') { await gate; return { outcome: 'covered', note: '이미 다시 조사 중입니다' }; }
      return { outcome: 'started', note: '다시 시작' };
    });
    const p = J.processScanResumes();
    await sleep(5);
    // t1 의 재개 함수가 기다리는 사이: t1 은 수동 실행이 시작(진행 중) · t2 는 수동 실행이 시작해 이미 끝났다
    J.scanStarted('isidu', 't1', { label: 'T1', trigger: 'manual' });
    J.scanStarted('isidu', 't2', { label: 'T2', trigger: 'manual' }); J.scanFinished('isidu', 't2');
    release(); await p;
    const st = J.scanJournalStatus();
    const rows = (k) => st.recent.filter((x) => x.kind === 'isidu' && x.key === k);
    assert.equal(rows('t1').length, 1, `t1 이력이 ${rows('t1').length}줄: ${rows('t1').map((x) => x.outcome).join(',')}`);
    assert.equal(rows('t1')[0].outcome, 'covered');
    assert.deepEqual(called, ['t1'], '이미 다른 경로로 시작돼 이력으로 간 t2 의 재개 함수를 불렀다(끝난 스캔을 다시 시작한다)');
    assert.equal(rows('t2').length, 1); assert.equal(st.interrupted.length, 0);
    J.scanFinished('isidu', 't1');
    J._resetForTest();
  });
});

test('F4 확인: 재개 결과(gone · error · busy 상한)는 예전대로 한 줄씩 남는다', async () => {
  await quiet(async () => {
    J._resetForTest();
    J.scanStarted('ipscan', 'r1', { label: 'R1' }); J.scanStarted('isidu', 't9', { label: 'T9' });
    J._reloadForTest();
    let busyCalls = 0;
    J.registerScanResumer('ipscan', async () => { throw new Error('boom'); });
    J.registerScanResumer('isidu', async () => { busyCalls++; return { outcome: 'busy', note: '다른 스캔 중' }; });
    const at = Date.now();
    await J.processScanResumes({ at });
    await J.processScanResumes({ at: at + 1_000 });   // nextAt 전 — 다시 부르지 않는다
    assert.equal(busyCalls, 1);
    let st = J.scanJournalStatus();
    assert.deepEqual(st.recent.filter((x) => x.kind === 'ipscan').map((x) => x.outcome), ['error']);
    assert.equal(st.interrupted.length, 1); assert.equal(st.interrupted[0].tries, 1);
    for (let i = 1; i <= J.BUSY_RETRY_MAX + 1; i++) await J.processScanResumes({ at: at + i * J.BUSY_RETRY_MS + 1 });
    st = J.scanJournalStatus();
    assert.deepEqual(st.recent.filter((x) => x.kind === 'isidu').map((x) => x.outcome), ['gave-up']);
    assert.equal(st.interrupted.length, 0);
    J._resetForTest();
  });
});

/* ── F5 preserveCorrupt 옮기기 실패 ─────────────────────────────────────── */
test('F5 preserveCorrupt — 옮기지 못하면 콘솔에 한 번 남긴다(파일마다 한 번 · 원문 · 전체 경로 없음) · 반환은 null · 원본은 그 자리', () => {
  const d = caseDir(); const f = path.join(d, 'reg.json'); fs.writeFileSync(f, '{"password": SuperSecret123!');
  const real = fs.renameSync;
  const lines = quiet((out) => {
    fs.renameSync = () => { throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${f}'`), { code: 'EBUSY' }); };
    try {
      assert.equal(preserveCorrupt(f, 'Unexpected token S in JSON'), null);
      assert.equal(preserveCorrupt(f, 'Unexpected token S in JSON'), null);
      assert.equal(out.length, 1, '파일마다 한 번만 남긴다');
    } finally { fs.renameSync = real; }
    // 그 뒤 옮길 수 있게 되면 예전 문구 그대로
    const bak = preserveCorrupt(f, 'Unexpected token S in JSON');
    assert.ok(bak && fs.existsSync(bak) && !fs.existsSync(f));
  });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('reg.json') && lines[0].includes('옮기지 못했습니다') && lines[0].includes('EBUSY'), lines[0]);
  assert.ok(!lines[0].includes('SuperSecret') && !lines[0].includes(d), '원문 · 전체 경로가 콘솔에 실렸다');
  assert.ok(lines[1].includes('로 보존하고 빈 값으로 시작합니다'), lines[1]);
  // 없는 파일은 예전처럼 조용히 null
  assert.deepEqual(quiet(() => { assert.equal(preserveCorrupt(path.join(d, 'none.json'), 'x'), null); }), []);
});

/* ── 확인: userDocWriter 순서 · 종료 flush ───────────────────────────────── */
test('확인: userDocWriter — 느린 앞 쓰기가 뒤 값을 덮지 않고(마지막 값이 이긴다), 진행 중인 쓰기와 겹친 flushNow 뒤에도 새 본문이 남는다', async () => {
  await quiet(async () => {
    const mk = (tag) => {
      const d = caseDir(); const f = path.join(d, 'doc.json'); const st = { v: 0 };
      const w = createUserDocWriter({ tag, file: () => f, serialize: () => JSON.stringify({ v: st.v }), delayMs: 10 });
      return { d, f, st, w, v: () => JSON.parse(fs.readFileSync(f, 'utf8')).v };
    };
    { // 느린 앞 쓰기
      const c = mk('u125-a'); let slow = true;
      c.w.setIoForTest({ writeTmp: async (tmp, body) => { if (slow) { slow = false; await sleep(80); } await fs.promises.writeFile(tmp, body); } });
      c.st.v = 1; c.w.changed(); await sleep(25);
      c.st.v = 2; c.w.changed(); c.st.v = 3; c.w.changed(); await sleep(15); c.st.v = 4; c.w.changed();
      const p = await c.w.waitPersist(c.w.seq(), { maxMs: 2_000 });
      assert.equal(p.state, 'saved'); assert.equal(c.v(), 4); assert.deepEqual(fs.readdirSync(c.d), ['doc.json']);
      c.w.setIoForTest(null); c.w.reset();
    }
    for (const stage of ['mkdir', 'writeTmp', 'rename', 'syncDir']) { // 그 단계에서 멈춘 비동기 쓰기(v=1) + 종료 flush(v=2)
      const c = mk(`u125-${stage}`); let open; const held = new Promise((r) => { open = r; });
      const over = {};
      if (stage === 'mkdir') over.mkdir = async (dir) => { await held; return fs.promises.mkdir(dir, { recursive: true }); };
      if (stage === 'writeTmp') over.writeTmp = async (tmp, body) => { await fs.promises.writeFile(tmp, body); await held; };
      if (stage === 'rename') over.rename = async (a, b) => { await held; return fs.promises.rename(a, b); };
      if (stage === 'syncDir') over.syncDir = async () => { await held; };
      c.w.setIoForTest(over);
      c.st.v = 1; c.w.changed(); await sleep(40);
      c.st.v = 2; c.w.changed();
      assert.equal(c.w.flushNow(), true, stage); assert.equal(c.v(), 2, `${stage}: flush 직후`);
      open(); await sleep(30); await c.w.idle();
      assert.equal(c.v(), 2, `${stage}: 늦게 끝난 옛 본문이 새 본문을 덮었다`);
      assert.deepEqual(fs.readdirSync(c.d), ['doc.json'], `${stage}: 임시 파일이 남았다`);
      assert.equal(c.w.persist().state, 'saved');
      c.w.setIoForTest(null); c.w.reset();
    }
    { // 실패는 버려지지 않는다 — failed 표지 · 재시도 · 회복
      const c = mk('u125-fail'); let fail = true;
      c.w.setIoForTest({ rename: async (a, b) => { if (fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', syscall: 'rename' }); return fs.promises.rename(a, b); } }, { max: 2, baseMs: 20, capMs: 40 });
      c.st.v = 7; c.w.changed();
      assert.equal((await c.w.waitPersist(c.w.seq(), { maxMs: 500 })).state, 'failed');
      assert.equal(c.w.persist({ admin: true }).lastWriteError.code, 'ENOSPC');
      assert.deepEqual(fs.readdirSync(c.d), [], '실패한 쓰기의 임시 파일이 남았다');
      fail = false; c.st.v = 8; c.w.changed();
      assert.equal((await c.w.waitPersist(c.w.seq(), { maxMs: 2_000 })).state, 'saved'); assert.equal(c.v(), 8);
      c.w.setIoForTest(null); c.w.reset();
    }
  });
});
