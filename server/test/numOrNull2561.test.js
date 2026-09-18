/**
 * v2.561 회귀 — '읽지 못한 수치' 를 0 으로 둔갑시키지 않는다 + 무음 실패 워커.
 *
 * 이 파일이 고정하는 것 셋:
 *  ① `util/numOrNull.js` 의 판정(`null`·`''`·`[]`·`{}`·boolean → null)
 *  ② 스토리지 용량 적재가 `usedBytes: null` 을 **null 로** 넣는다(예전에는 0 — 실제 결함)
 *     + 그 결과 `growth.js` 의 `unknownUsed`(정직 안내의 근거)가 되살아난다
 *  ③ 지역 사본 금지 — 소스에서 `Number.isFinite(Number(v)) ? Number(v) : null` 형태가 0 이어야 한다
 *     (v2.561 전에는 13벌 중 7벌이 이 틀린 형태였다)
 *  ④ `logQueryWorker` 가 상태를 남기고(`logQueryWorkerStatus`) `edgelog/spec.js` 표에 등재돼 있다
 *  ⑤ `/api/central/log-query-result` 가 BIG_JSON 에 등록돼 있다
 *
 * ⚠ 소스 검사는 **주석을 먼저 제거**한다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다
 *   (v2.535 규약). 그래서 `util/numOrNull.js` 자신의 머리말 예시는 검사에서 빠진다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'numornull-test-'));

const SRC = new URL('../src/', import.meta.url).pathname;
const { numOrNull } = await import('../src/util/numOrNull.js');

/** 줄 주석·블록 주석을 제거한 소스(규칙을 설명하는 주석이 통과 근거가 되지 않게). */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|vendor/.test(e.name)) walk(p, out); continue; }
    if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('① numOrNull — 읽지 못한 값은 0 이 아니라 null 이다', () => {
  // ⚠ 이 네 줄이 이 모듈의 존재 이유다. Number() 는 전부 0 을 준다.
  assert.equal(numOrNull(null), null, 'Number(null) === 0 이라 0 이 되던 것');
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null, "Number('') === 0 이라 0 이 되던 것");
  assert.equal(numOrNull('   '), null, '공백만인 문자열도 0 이 된다');
  assert.equal(numOrNull([]), null, 'Number([]) === 0');
  assert.equal(numOrNull([5]), null, 'Number([5]) === 5 로 조용히 통과한다');
  assert.equal(numOrNull({}), null);
  assert.equal(numOrNull(true), null, 'Number(true) === 1');
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(Infinity), null);
  // 정상 값은 그대로
  assert.equal(numOrNull(0), 0, '진짜 0 은 0 이다 — 값을 죽이지 않는다');
  assert.equal(numOrNull(-3.5), -3.5);
  assert.equal(numOrNull('42'), 42);
  assert.equal(numOrNull(117544396521472), 117544396521472);
});

test('② 용량 적재 — usedBytes 가 null 이면 0 이 아니라 null 로 들어간다', async () => {
  const db = await import('../src/storage/db.js');
  const g = await import('../src/storage/growth.js');
  const DAY = 86400000;
  // ⚠ 기준 시각은 경계에서 떨어뜨려 고정한다(v2.517 규약) — Date.now() 를 쓰지 않는다.
  const base = 1789000000000;
  const dev = 'UNITY-NULLUSED';

  for (let i = 0; i < 3; i++) {
    const r = await db.saveCapacityPoint({
      ok: true, deviceId: dev, collectedAt: base + i * DAY,
      capacity: { totalBytes: 117544396521472, usedBytes: 27.0e12 + i * 0.1e12 }, extra: {},
    });
    if (!r.saved && r.reason === 'db-unavailable') return;  // node:sqlite 없는 환경
  }
  /*
   * 도달 경로: `unitySsh.js` 는 풀 목록을 못 읽고 `general/system show` 만 성공하면
   * `{ totalBytes: <읽음>, usedBytes: null }` 을 내보낸다. `capacityPointEligible` 은
   * **total 만** 보므로 이 스냅샷은 게이트를 통과한다 — 그래서 sink 가 정직해야 한다.
   */
  const gate = db.capacityPointEligible({ ok: true, capacity: { totalBytes: 117544396521472, usedBytes: null }, extra: {} });
  assert.equal(gate.ok, true, '게이트는 total 만 본다 — 이 전제가 깨지면 이 테스트의 의미가 바뀐다');

  await db.saveCapacityPoint({
    ok: true, deviceId: dev, collectedAt: base + 3 * DAY,
    capacity: { totalBytes: 117544396521472, usedBytes: null }, extra: {},
  });

  const rows = await db.dailySeries(dev, 0);
  const last = rows[rows.length - 1];
  assert.equal(last.used_bytes, null, "0 으로 적재되면 화면이 '사용량 0' 이라는 거짓을 말한다");
  assert.equal(last.max_used, null, '일 롤업의 최대도 0 이 되면 안 된다');
  assert.equal(last.total_bytes, 117544396521472, '읽은 값은 그대로 남는다');

  // 정직 안내의 근거가 살아 있는지 — 0 이면 '미상 0대' 가 되어 안내가 무력화된다.
  const m = g.growthMatrix(rows, { periods: g.normalizePeriods([1]) });
  assert.equal(m.totals.unknownUsed, 1, "StorageGrowthTool 의 '사용량을 읽지 못한 장비 N대' 안내 근거");
  assert.equal(m.devices[0].usedBytes, null, '현재 사용량은 —(null) 이어야 한다');
  assert.equal(m.devices[0].pct, null, '사용률 0% 는 거짓이다');
  assert.equal(m.devices[0].freeBytes, null, '남은 용량을 전체와 같게 보고하면 없는 공간에 LUN 을 만든다');
  // 그리고 거짓 급변(하루에 -27.6T)이 없어야 한다.
  assert.equal(m.devices[0].growth['1d'].bytes, null);
  assert.equal(m.devices[0].growth['1d'].reason, 'no-latest-used');
});

/*
 * 검토를 마치고 **그대로 두기로 한** 자리 — 각각 사유가 있다. 여기에 줄을 더할 때는
 * 반드시 '도달 불가' 를 **실행으로 확인한 근거**를 함께 적을 것(v2.506 'TOOL_ENFORCEMENT_NOTES'
 * 와 같은 관례 — "그 필드는 없으니까 안전하다" 는 근거는 다음 리팩터에 무효가 된다).
 */
const REVIEWED_SAFE = new Map([
  ['storage/db.js:rawKeepDays', '보존일. `loadGrowthSettings()` 가 명시적 null 을 기본값(90/1825)으로 막는다 — v2.561 에 손상 설정 파일로 실행해 확인했다. 여기서 0 이 되면 `0 ?? 기본값 === 0` 이라 전량 삭제가 되므로 경로가 열리면 즉시 고칠 것.'],
  ['storage/db.js:dailyKeepDays', '같은 이유(위 줄과 한 쌍).'],
  ['storage/growth.js:asOfDay', "호출부(`routes/api/storageMon.js:530`)가 항상 `dayIndex(Date.now())` — 수를 넘긴다. null 이 오면 day 0(1970)이 되어 전 장비가 조용히 목록에서 빠진다."],
]);

test('③ 지역 사본 금지 — 틀린 형태의 수치 헬퍼가 소스에 없다', () => {
  const bad = [];
  for (const f of walk(SRC)) {
    if (f.endsWith(`util${path.sep}numOrNull.js`)) continue;   // 이 모듈의 머리말이 그 형태를 인용한다
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    /*
     * 문제의 형태는 **`: null` 로 끝나는 것**이다 — '읽지 못하면 null' 이라는 계약을 선언해
     * 놓고 `Number(null) === 0` 때문에 0 을 주는 것. `: 0` 으로 끝나는 것은 '보고가 없으면
     * 0' 이 의도인 카운터이므로(예: `central/svcmonEdge.js` 의 items·reported) 대상이 아니다.
     */
    const re = /Number\.isFinite\(Number\(([A-Za-z_$][\w$]*)\)\)\s*\?\s*Number\(\1\)\s*:\s*null/g;
    let m;
    while ((m = re.exec(src))) {
      const v = m[1];
      const before = src.slice(Math.max(0, m.index - 100), m.index);
      // `v == null || v === '' ? null : (...)` / `v != null && ...` 처럼 앞에서 걸러낸 형태는 안전하다
      if (new RegExp(`${v}\\s*[!=]=\\s*null`).test(before)) continue;
      const key = `${path.relative(SRC, f).split(path.sep).join('/')}:${v}`;
      if (REVIEWED_SAFE.has(key)) continue;
      bad.push(key);
    }
  }
  assert.deepEqual(bad, [], `틀린 형태의 지역 사본이 되살아났다 — util/numOrNull.js 를 쓰거나, 도달 불가를 실행으로 확인한 뒤 REVIEWED_SAFE 에 근거와 함께 적을 것:\n  ${bad.join('\n  ')}`);
});

test('③-b 고친 파일들이 실제로 공용 판정을 쓴다', () => {
  // ⚠ 파일 목록을 지우지 말 것 — v2.561 에 이 7곳이 null 을 0 으로 바꾸고 있었다.
  const fixed = [
    'storage/db.js', 'storage/growth.js', 'storage/collectors/powermax.js',
    'storage/collectors/powerstore.js', 'storage/collectors/powerstoreSsh.js',
    'vmtrack/diff.js', 'idrac/scanLog.js', 'central/sanSwitchPerfEdge.js',
    'linkcheck/db.js', 'bmusage/db.js', 'bmusage/usage.js', 'bmusage/alertRules.js',
    'bmusage/rates.js', 'partfault/extract/sanswitch.js',
  ];
  const missing = fixed.filter((rel) => !/^import \{ numOrNull \}/m.test(fs.readFileSync(path.join(SRC, rel), 'utf8')));
  assert.deepEqual(missing, [], `공용 판정 import 가 사라졌다: ${missing.join(', ')}`);
});

test('④ logQueryWorker — 상태를 남기고 spec 표에 등재돼 있다(무음 실패 금지)', async () => {
  const w = await import('../src/agent/logQueryWorker.js');
  assert.equal(typeof w.logQueryWorkerStatus, 'function', '상태 함수가 없으면 진단할 길이 없다');
  const st = w.logQueryWorkerStatus();
  for (const k of ['enabled', 'intervalMs', 'busy', 'last']) assert.ok(k in st, `상태에 ${k} 가 있어야 한다`);

  /*
   * 결과 POST 실패를 조용히 삼키지 않는다. ⚠ 타이머 콜백의
   * `runLogQueryWorkerOnce().catch(() => {})` 는 **정당하다** — 그 안쪽이 이미 상태를 남기므로
   * setInterval 이 unhandled rejection 을 내지 않게 하는 관례다. 검사는 `resilientFetch`
   * 호출에 붙은 빈 catch 만 본다(그것이 v2.560 까지의 무음 실패 지점이었다).
   */
  const src = stripComments(fs.readFileSync(path.join(SRC, 'agent/logQueryWorker.js'), 'utf8'));
  assert.ok(
    !/resilientFetch\([\s\S]{0,400}?\}\)\s*\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(src),
    '결과 보고 실패를 빈 catch 로 삼키면 중앙이 영원히 pending 이고 화면이 무한 대기한다',
  );
  assert.ok(/console\.warn/.test(src), '실패는 콘솔에도 남긴다');
  assert.ok(/413/.test(src), '413 은 재시도 대상이 아니라 조용한 소실이므로 사유를 구분해야 한다');

  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  const row = STATUS_SPEC.find((r) => r.fn === 'logQueryWorkerStatus');
  assert.ok(row, '새 엣지 워커는 edgelog/spec.js 표에 함께 넣는다(v2.554 규약)');
  assert.equal(row.mod, '../agent/logQueryWorker.js');
});

test('⑤ /api/central/log-query-result 는 BIG_JSON 에 등록돼 있다', () => {
  const src = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  // ⚠ 주석을 제거하고 검사한다 — 주석에 경로를 적어 둔 것이 통과 근거가 되면 안 된다.
  const code = stripComments(src);
  assert.ok(
    /app\.use\(\s*'\/api\/central\/log-query-result'\s*,\s*BIG_JSON\s*\)/.test(code),
    '500행 × message 1,900자 = 981KB 로 기본 1mb 에 닿는다. 413 은 그 조회 결과의 조용한 전량 소실이다',
  );
});
