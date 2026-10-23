/**
 * v2.770 5회차 점검 G2(스토리지) — E2-01 · E2-02 · E2-03 · E2-04.
 *
 *  E2-01  중앙 정제 narrowStoragePower(v2.680)의 화이트리스트에 v2.682(R3D-03)가 더한 부분 합 표지(partial·missing)가 없어
 *         엣지 장비의 부분 합을 중앙 power/total.js 가 '측정' 으로 셌다(sto.partial·partialWatts 과소 · 항목에 '일부' 표지 없음).
 *  E2-02  isilonSsh.parseIsiStatus 의 Size/Used 정규식이 'm' 플래그 + [^)]* 라 줄 안의 외로운 \r 마다 O(n²)(160KB 약 3.6초).
 *  E2-03  cliSsh.parseKeyValueBlocks 에 v2.744 GH-R2 가 uemcli recStart 에서 고친 `/^(\d+):\s*(.*)$/` 가 남아 있었다(XtremIO·VPLEX SSH).
 *  E2-04  storage/poller.js 주기 수집이 _inFlight 를 보지 않아 수동 '지금 수집' 중인 장비에 세션을 하나 더 열었다.
 *
 * 시간 단언은 옛 정규식 대비 비율로만 한다(v2.611 · TESTDOC2613-02 — 절대 ms 금지). 큰 배열은 isDeepStrictEqual + assert.ok(v2.731).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2770b-'));
process.env.CONFIG_DIR = TMP;
process.env.DB_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';

// 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(docs/rules/common.md)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

// ⚠ 동적 import 는 첫 test() 등록 앞에 · 모듈 이름공간으로 받는다(새 export 가 없는 판본에서 파일 전체가 링크 오류로 죽지 않게).
const { setDataSource } = await import('../src/runtime-settings.js');
setDataSource('live');
const edge = await import('../src/central/storageEdge.js');
const spower = await import('../src/storage/power.js');
const total = await import('../src/power/total.js');
const isi = await import('../src/storage/collectors/isilonSsh.js');
const cli = await import('../src/storage/collectors/cliSsh.js');
const xio = await import('../src/storage/collectors/xtremioSsh.js');
const reg = await import('../src/storage/registry.js');
const poller = await import('../src/storage/poller.js');
const store = await import('../src/storage/store.js');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

/** 고정 시드 PRNG(LCG) — 결정적 무작위 입력. */
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 1) / 0x7fffffff; };
}
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const timeIt = (fn, reps = 1) => { const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(); return performance.now() - t0; };
const ch = (n) => String.fromCharCode(n);

// ───────────────────────────── E2-01 엣지 전력 부분 합 표지 ─────────────────────────────

test('E2-01 ① 엣지 수집기의 부분 합(PSU 2개 중 1개 못 읽음)이 중앙 저장 → 전체 소비 전력에서 partial 로 세어진다', () => {
  // 엣지: 실제 수집기 함수로 extra.power 를 만든다(storage/power.js powerResult — missing>0 이면 partial:true).
  const extra = {};
  spower.applyScannedPower(extra, [{ inputPower: 300, state: 'ok' }, { inputPower: null, state: 'ok' }], { source: 'test' });
  assert.equal(extra.power?.partial, true, `수집기 전제: ${JSON.stringify(extra.power)}`);
  assert.equal(extra.power.missing, 1);
  extra.power.at = NOW;
  // 중앙: 실제 수신 저장 함수(saveEdgeStorage — narrowStorageSnapshot 경유) → 보관분 조회
  const n = edge.saveEdgeStorage('edge-e201', [{ deviceId: 'sto-e201', name: 'pwr', type: 'powerstore', ok: true, collectedAt: NOW, extra }]);
  assert.equal(n, 1);
  const snap = edge.edgeStorageSnapshots().find((d) => d.deviceId === 'sto-e201');
  assert.ok(snap, '중앙 보관분');
  assert.equal(snap.extra.power.partial, true, `중앙 정제가 partial 을 지웠다: ${JSON.stringify(snap.extra.power)}`);
  assert.equal(snap.extra.power.missing, 1);
  // 전체 소비 전력(overviewCards powerTotal 과 같은 입력 모양)
  const r = total.buildPowerTotal({ now: NOW, storage: [{ id: 'sto-e201', name: 'pwr', type: 'powerstore', snap }] });
  assert.equal(r.storage.watts, 300);
  assert.equal(r.storage.partial, 1, JSON.stringify(r.storage));
  assert.equal(r.storage.partialWatts, 300);
  assert.equal(r.storage.measured, 0, '부분 합을 측정으로 세면 안 된다');
  assert.equal(r.storage.items[0].partial, true);
  assert.equal(r.storage.items[0].missing, 1);
});

test('E2-01 ② narrowStoragePower — missing 이 양의 정수(상한 이하)일 때만 partial · 문자열 수치는 수로 · 표지를 지어내지 않는다', () => {
  const base = { watts: 500, source: 's', at: NOW };
  const one = (p) => { const ex = { power: { ...base, ...p } }; edge.narrowStoragePower(ex, NOW); return ex.power; };
  const pm = (p) => { const o = one(p); return [o.partial, o.missing]; };
  assert.deepEqual(pm({ partial: true, missing: 2 }), [true, 2]);
  assert.deepEqual(pm({ missing: '3' }), [true, 3], '문자열 수치는 수로');
  assert.deepEqual(pm({ missing: 2.6 }), [true, 3], '수집기와 같이 반올림');
  assert.deepEqual(pm({ partial: true }), [undefined, undefined], '개수 없이 partial 만 — 지어내지 않는다(수집기 규칙: missing>0 일 때만)');
  for (const bad of [0, -1, '', null, 'abc', {}, [], 0.2, Infinity, edge.POWER_MISSING_MAX + 1]) {
    assert.deepEqual(pm({ partial: true, missing: bad }), [undefined, undefined], `missing=${JSON.stringify(bad)}`);
  }
  assert.deepEqual(pm({ partial: 'yes', missing: edge.POWER_MISSING_MAX }), [true, edge.POWER_MISSING_MAX]);
  // 부분 합이 아닌 값은 예전 모양 그대로(키가 생기지 않는다)
  assert.deepEqual(Object.keys(one({ parts: 2, keys: ['inputPower'] })).sort(), ['at', 'basis', 'keys', 'parts', 'scope', 'source', 'watts']);
});

// ───────────────────────────── E2-02 isi status O(n²) ─────────────────────────────

// 감사 기준(v2.769 HEAD) 정규식 — 비율의 기준(짧은 입력에만 쓴다).
const OLD_ISI_TWO = new RegExp('^Size:\\s+([\\d.]+[kKMGTP]?)(?:\\s*\\([^)]*\\))?\\s+([\\d.]+[kKMGTP]?)(?:\\s*\\([^)]*\\))?', 'm');

const ISI_VAL = ['2.5P', '0', '282.8T', '6.1P', '1.0', '55.1T', '12', '.5G', '107T', '1.1P', 'x', '3k'];
const ISI_PAREN = ['(2.5P Raw)', '(0 Raw)', '(n/a)', '(2%)', '(85%)', '(2%)', '(19%)', '(7.5%)', '(n/a)', '( 2%)', '(x)', '', '', '()', '(unclosed', '(1.2P Raw', '(%)'];
const ISI_WS = [' ', '  ', '\t', '     ', ' \t ', ' ', ''];
const ISI_LABEL = ['Size', 'Used', 'Size', 'Used', 'Avail', 'VHS Size', 'Size ', ' Size', 'Used ', 'size', 'Used:'];
const ISI_OTHER = ['Cluster Name: WA-ISI', 'Cluster Health:     [  OK ]', 'Data Reduction:     1.00 : 1', 'Cluster Storage:  HDD                 SSD Storage',
  '  1|10.94.41.202  | OK  | C |    0| 463M| 463M|(No Storage HDDs)|17.6T/20.7T( 85%)', ' 20|10.94.41.191  | -A- | N |48.4k|78.1M|78.2M|86.8T/ 108T( 80%)|      L3:  1.5T',
  'Cluster Totals:                 |    0| 2.2M| 2.2M|55.1T/ 2.5P( 2%)|   L3:  8.7T', '', 'garbage ( ) (( ))'];
function isiParen(rnd) {
  const r = rnd();
  if (r < 0.15) return '(' + 'R '.repeat(Math.floor(rnd() * 30)) + ')';   // 괄호 안 60자 이하
  return pick(rnd, ISI_PAREN);
}
function isiStorageLine(rnd) {
  let l = pick(rnd, ISI_LABEL) + ':' + pick(rnd, ISI_WS) + pick(rnd, ISI_VAL) + pick(rnd, ISI_WS) + isiParen(rnd);
  if (rnd() < 0.8) l += pick(rnd, ISI_WS) + pick(rnd, ISI_VAL) + pick(rnd, ISI_WS) + isiParen(rnd);
  if (rnd() < 0.2) l += pick(rnd, ISI_WS) + pick(rnd, ['tail', '(z)', '9', '%']);
  return l;
}
/** isi status 입력 — 줄 안에 줄 끝 문자(\r·U+2028·U+2029)를 넣지 않는다(정상 출력의 범위: CRLF 의 \r 은 줄 끝). */
function isiCorpus(seed, n = 1500) {
  const rnd = prng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = 1 + Math.floor(rnd() * 9);
    const lines = [];
    for (let j = 0; j < k; j++) lines.push(rnd() < 0.7 ? isiStorageLine(rnd) : pick(rnd, ISI_OTHER));
    out.push(lines.join(rnd() < 0.4 ? '\r\n' : '\n') + (rnd() < 0.5 ? '\r\n' : ''));
  }
  return out;
}
// 감사 기준 판본(v2.769 HEAD cbeebb45 의 isilonSsh.js)으로 계산했다. 파서 동작을 의도적으로 바꾸면 다시 계산할 것.
const ISI_SHA256 = 'c56e76e2ed51d65f1c733c6f48c44761dfa8a1d75e72f4f703f9a356df7680b6';

test('E2-02 ① parseIsiStatus — 정상 출력(LF·CRLF, 괄호 표기 변형) 결과가 감사 기준 판본과 같다(결정적 입력 1,500건 · sha256)', () => {
  const h = crypto.createHash('sha256');
  let parsed = 0;
  for (const t of isiCorpus(277002)) {
    const r = isi.parseIsiStatus(t);
    if (r.hdd) parsed += 1;
    h.update(JSON.stringify(r)).update('\u0000');
  }
  assert.ok(parsed > 200, `입력이 Size 줄을 충분히 덮어야 한다(${parsed})`);
  assert.equal(h.digest('hex'), ISI_SHA256);
});

test('E2-02 ② 외로운 \\r 이 섞인 긴 줄에서 선형 — 실제 파서 함수 · 옛 정규식 대비 비율', () => {
  const line = 'Size: 1 (' + '\rSize: 1 ('.repeat(4000);
  const tOld = timeIt(() => OLD_ISI_TWO.exec(line));
  const tNew = timeIt(() => isi.parseIsiStatus(line), 3) / 3;
  assert.ok(tOld > 40 && tOld > tNew * 5, `옛 ${tOld.toFixed(1)}ms · 새 ${tNew.toFixed(2)}ms`);
  // 정상 CRLF 실물 모양은 그대로 읽는다
  const p = isi.parseIsiStatus('Size:             6.1P (6.1P Raw)     282.8T (293.5T Raw)\r\nUsed:             5.0P (81%)          239.8T (85%)\r\n');
  assert.equal(p.hdd.usedPct, 81); assert.equal(p.ssd.usedPct, 85);
  assert.equal(p.ssd.sizeBytes, isi.parseSize('282.8T'));
});

test('E2-02 ③ 소스 — Size/Used 정규식에 m 플래그·무제한 [^)]* 가 없다(주석 제거 후)', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'storage/collectors/isilonSsh.js'), 'utf8'));
  const fn = s.slice(s.indexOf('const twoCols'), s.indexOf("const size = twoCols('Size')"));
  assert.ok(fn.length > 50, '구간을 찾지 못했다');
  assert.doesNotMatch(fn, /,\s*'m'\s*\)/, "'m' 플래그");
  assert.doesNotMatch(fn, /\[\^\)\]\*/, '무제한 [^)]*');
});

// ───────────────────────────── E2-03 parseKeyValueBlocks ─────────────────────────────

// 감사 기준 판본(v2.769 HEAD)의 parseKeyValueBlocks — 결과 동일성 대조의 기준(짧은 입력에만 쓴다).
function oldParseKeyValueBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { if (cur && Object.keys(cur).length) { blocks.push(cur); cur = null; } continue; }
    const idx = /^(\d+):\s*(.*)$/.exec(t);
    const body = idx ? idx[2] : t;
    if (idx) { if (cur && Object.keys(cur).length) blocks.push(cur); cur = {}; }
    const sep = body.search(/[=:]/);
    if (sep < 1) continue;
    if (!cur) cur = {};
    cur[body.slice(0, sep).trim()] = body.slice(sep + 1).trim();
  }
  if (cur && Object.keys(cur).length) blocks.push(cur);
  return blocks;
}
// 공백(정규식 \s 와 String.trim 이 같은 집합인지까지)·줄 끝 문자·값 글자 — audit2744rg 와 같은 재료
const KV_WS = [' ', '  ', '\t', '\r', ch(0x2028), ch(0x2029), ch(0xa0), ch(0x3000), ch(0xfeff), ch(0x1680), '\v', '\f'];
const KV_VAL = ['a', 'ID', 'spa', '0', '12', '.', '-', ':', '=', '"', '(', ')', 'x y', 'Health state = OK (5)', ch(0x180e), ch(0x200b)];
const KV_HEAD = ['1:', '12:', '2', ':', '1 :', '3:    ID = spa', 'Name = p1', 'Total space: 117544396521472 (106.9T)', '', '007:x=1', 'a:b'];
function kvLine(rnd) {
  let s = pick(rnd, KV_HEAD);
  const r = rnd();
  if (r < 0.2) s = pick(rnd, KV_WS) + s;
  else if (r < 0.3) { const i = Math.floor(rnd() * (s.length + 1)); s = s.slice(0, i) + pick(rnd, [...KV_WS, ...KV_VAL]) + s.slice(i); }
  const n = Math.floor(rnd() * 10);
  for (let i = 0; i < n; i++) s += rnd() < 0.45 ? pick(rnd, KV_WS) : pick(rnd, KV_VAL);
  return s;
}

test('E2-03 ① parseKeyValueBlocks — 감사 기준 판본과 결과가 같다(고정 시드 무작위 4,000건 · 외로운 \\r·U+2028·NBSP 포함)', () => {
  const rnd = prng(277003);
  let records = 0;
  for (let i = 0; i < 4000; i++) {
    const k = 1 + Math.floor(rnd() * 8);
    const lines = [];
    for (let j = 0; j < k; j++) lines.push(kvLine(rnd));
    const text = lines.join(rnd() < 0.3 ? '\r\n' : '\n');
    const want = oldParseKeyValueBlocks(text);
    const got = cli.parseKeyValueBlocks(text);
    records += want.length;
    if (!isDeepStrictEqual(want, got)) assert.fail(`${JSON.stringify(text)} → 옛 ${JSON.stringify(want)} · 새 ${JSON.stringify(got)}`);
  }
  assert.ok(records > 2000, `입력이 레코드를 충분히 만들어야 한다(${records})`);
});

test('E2-03 ② 긴 공백 + 외로운 \\r 줄에서 선형 — parseKeyValueBlocks·xtremio parseTable 폴백 · 옛 정규식 대비 비율', () => {
  const line = '1:' + ' '.repeat(12000) + 'a\rb';
  const OLD = /^(\d+):\s*(.*)$/;
  const tOld = timeIt(() => OLD.exec(line));
  for (const [name, run] of [['parseKeyValueBlocks', () => cli.parseKeyValueBlocks(line)], ['xtremio.parseTable', () => xio.parseTable(line)]]) {
    const tNew = timeIt(run, 3) / 3;
    assert.ok(tOld > 40 && tOld > tNew * 5, `${name}: 옛 ${tOld.toFixed(1)}ms · 새 ${tNew.toFixed(2)}ms`);
  }
  // 줄 끝 문자가 값에 남으면 레코드 시작이 아니다(옛 정규식과 같은 뜻) — 그 줄은 몸통으로 읽힌다
  assert.ok(isDeepStrictEqual(cli.parseKeyValueBlocks('1:  ID = a\rb\n   Name = n'), [{ '1': 'ID = a\rb', Name: 'n' }]));
});

// ───────────────────────────── E2-04 주기 수집 _inFlight ─────────────────────────────

const capture = async (fn) => {
  const w = console.warn; const l = console.log; const lines = [];
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  console.log = (...a) => lines.push(a.map(String).join(' '));
  try { return { r: await fn(), lines }; } finally { console.warn = w; console.log = l; }
};

test('E2-04 ① 수동 수집 중인 장비는 주기 수집이 건너뛰고(실패 아님 — inFlightSkipped) 진행중 항목을 지우지 않는다', async () => {
  // 닿지 않는 주소(.invalid — 이름 해석이 실패할 때까지 비동기로 걸린다)
  const d = reg.saveDevice({ type: 'unity480', name: 'e204', host: 'e204.a2770b.invalid', username: 'u', password: 'p', collectMethod: 'api' });
  const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {};
  let manual;
  try { manual = poller.collectDeviceNow(d.id); } finally { console.warn = w; console.log = l; }
  assert.ok(poller.storagePollerStatus().inFlight.some((x) => x.id === d.id), '수동 수집이 진행중이어야 한다(전제)');
  const { r, lines } = await capture(() => poller.pollStorageOnce());
  assert.equal(r.skipped, undefined, JSON.stringify(r));
  assert.equal(r.inFlightSkipped, 1, `건너뛴 수를 따로 센다: ${JSON.stringify(r)}`);
  assert.equal(r.fail, 0, '이미 수집 중인 장비를 실패로 세지 않는다(예전: 같은 장비에 세션을 하나 더 열고 실패 1)');
  assert.equal(r.ok, 0);
  assert.equal(poller.storagePollerStatus().inFlightSkipped, 1, '상태에도 남긴다');
  assert.ok(lines.some((x) => x.includes('이미 수집 중인 장비 1대') && x.includes(d.id)), `콘솔에 남긴다(무음 금지): ${lines.join(' | ')}`);
  assert.ok(poller.storagePollerStatus().inFlight.some((x) => x.id === d.id), '주기 쪽이 수동 수집의 진행중 항목을 지우면 안 된다');
  const { r: done } = await capture(() => manual);
  assert.equal(done, true);
  assert.equal(poller.storagePollerStatus().inFlight.some((x) => x.id === d.id), false, '수동 수집이 끝나면 지운다');
  // 아무것도 겹치지 않은 주기는 예전 모양(키가 생기지 않는다)
  const { r: r2 } = await capture(() => poller.pollStorageOnce());
  assert.equal(r2.inFlightSkipped, undefined);
  assert.equal(r2.ok + r2.fail, reg.listDevices().length);
  store.flushSnapshotsNow();
});

test('E2-04 ② 소스 — collectOne 은 확인과 등록 사이에 await 가 없고 finally 는 자기 항목만 지운다(주석 제거 후)', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'storage/poller.js'), 'utf8'));
  const fn = s.slice(s.indexOf('async function collectOne('), s.indexOf('async function saveDemoAreas'));
  assert.ok(fn.length > 100, '구간을 찾지 못했다');
  const has = fn.indexOf('_inFlight.has(dev.id)'); const set = fn.indexOf('_inFlight.set(dev.id');
  assert.ok(has > 0 && set > has, '수집 시작 전에 진행중인지 확인한다');
  assert.equal(fn.slice(has, set).includes('await'), false, '확인과 등록 사이에 await 가 있으면 두 실행이 함께 통과한다');
  assert.match(fn, /finally\s*\{[^}]*_inFlight\.get\(dev\.id\)\s*===\s*entry[^}]*_inFlight\.delete\(dev\.id\)/, 'finally 는 소유 대조 후 지운다');
});
