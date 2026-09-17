/**
 * csvRoundTrip2545.test.js — v2.545 회귀 둘.
 *
 * ① **버전이 안 나오던 원인**(사용자 신고 2회: "아직 버전명이 나오지 않네")
 *    v2.544 의 버전 항목은 후보가 둘인데 후보를 넘어가는 조건이 `cliLooksError` 하나였다.
 *    실측: `cliLooksError('버전 없는 정상 출력') === false` → **첫 후보에서 체인이 끝난다**.
 *    그래서 수집은 성공인데 버전 열만 비었다. v2.525 규약('결과가 비어 있지 않다를 읽었다로
 *    쓰지 말 것')을 어긴 것이다. 이제 `spec.accept(stdout)` 가 '원하는 것을 얻었는가' 를 본다.
 *
 * ② **CSV 왕복이 수집 방식을 되돌리던 결함**
 *    `csv.js` 가 수집 방식을 `type === 'isilon'` 일 때만 내보냈다("isilon 만 유의미").
 *    그 전제가 틀렸다 — `unity480`·`powerstore` 도 `['api','ssh']` 다. 가져오기는 빈 값을
 *    타입 기본값으로 보정하므로(실측 `unity480` → `api`), **SSH 로 등록한 Unity 를 내보내
 *    고쳐서 다시 넣으면 API 로 조용히 되돌아갔다**(현장 Unity 6대가 전부 SSH 다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMethodsFor, defaultCollectMethod, normalizeCollectMethod } from '../src/storage/types.js';
import { devicesToCsv, devicesToText, parseDevicesCsv, methodChangeHints,
  exportedCollectMethod, exportedSshPort, CSV_COLUMNS } from '../src/storage/csv.js';
import { SPECS } from '../src/storage/collectors/unitySsh.js';
import { cliLooksError } from '../src/storage/collectors/cliSsh.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SVC = fs.readFileSync(path.join(here, 'fixtures', 'svc-diag-basic-2544.txt'), 'utf8');

// ── ① 버전 후보 체인 ─────────────────────────────────────────────────────────

test('★★ 버전 항목은 `오류 없음` 이 아니라 `버전·모델을 읽었다` 로 성공을 판정한다', () => {
  const sp = SPECS.find((s) => s.key === 'version');
  assert.ok(typeof sp.accept === 'function', 'accept 가 없으면 첫 후보에서 체인이 멈춘다');
  assert.equal(sp.accept(SVC), true, '실제 svc_diag 출력은 받아들여야 한다');
  // v2.544 가 멈추던 바로 그 입력 — 오류는 아니지만 버전이 없다
  const noVersion = '1:    Name = DE403204511072\n      Foo  = bar\n';
  assert.equal(cliLooksError(noVersion, ''), false, '오류로는 안 보인다(그래서 v2.544 가 멈췄다)');
  assert.equal(sp.accept(noVersion), false, '버전이 없으면 다음 후보로 넘어가야 한다');
  assert.equal(sp.accept(''), false);
});

test('★ 확인한 명령을 먼저 쓴다 — svc_diag 가 첫 후보다', () => {
  const sp = SPECS.find((s) => s.key === 'version');
  assert.equal(sp.cmds[0], 'svc_diag',
    '이 장비에서 출력을 직접 본 유일한 명령이다(못 본 형식을 앞에 두는 것이 v2.525~2.530 헛수정의 원인)');
  assert.ok(!sp.required, '버전 실패가 장비 전체 실패가 되면 안 된다');
});

test('accept 는 cliSsh 의 후보 루프가 실제로 본다(소스 계약)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'storage', 'collectors', 'cliSsh.js'), 'utf8');
  assert.match(src, /spec\.accept/, 'accept 를 보지 않으면 이 수정이 무의미하다');
  assert.match(src, /cliLooksError\(stdout, stderr\) \|\| !wanted/, '성공 판정에 accept 결과가 들어가야 한다');
});

// ── ② CSV 왕복 ───────────────────────────────────────────────────────────────

test('★★ 방식이 둘인 타입은 수집 방식을 내보낸다 — 안 그러면 왕복에서 되돌아간다', () => {
  for (const t of ['isilon', 'powerstore', 'unity480']) {
    assert.ok(collectMethodsFor(t).length >= 2, `${t}: 방식이 2개 이상이어야 이 테스트가 뜻이 있다`);
    assert.equal(exportedCollectMethod({ type: t, collectMethod: 'ssh' }), 'ssh', `${t}: ssh 가 내보내져야 한다`);
  }
  // 고를 것이 없는 타입은 비운다(정보가 없다)
  assert.equal(exportedCollectMethod({ type: 'vmax', collectMethod: 'api' }), '');
});

test('★★ Unity(ssh) → CSV → 다시 읽기: 방식이 보존된다', () => {
  const dev = { type: 'unity480', name: 'OC2-unity-01', host: '10.94.41.221', username: 'service', collectMethod: 'ssh', sshPort: 22 };
  const csv = devicesToCsv([dev], (x) => x);
  const { rows } = parseDevicesCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].collectMethod, 'ssh', `왕복 결과: ${JSON.stringify(rows[0].collectMethod)}`);
  // 저장 경로의 보정까지 통과해야 '되돌아가지 않는다' 가 성립한다
  assert.equal(normalizeCollectMethod('unity480', rows[0].collectMethod), 'ssh');
});

test('★ v2.544 의 동작을 재현하면 실제로 되돌아간다(이 테스트가 지키는 것의 증거)', () => {
  const old = (d) => (d.type === 'isilon' ? (d.collectMethod || 'ssh') : '');   // v2.544 의 규칙
  const blank = old({ type: 'unity480', collectMethod: 'ssh' });
  assert.equal(blank, '', '옛 규칙은 Unity 의 방식을 비웠다');
  assert.equal(normalizeCollectMethod('unity480', blank), 'api', '빈 값은 기본값 api 로 보정된다 — 이것이 손실이다');
  assert.notEqual(defaultCollectMethod('unity480'), 'ssh', '기본값이 ssh 라면 이 결함은 성립하지 않는다');
});

test('SSH 포트는 실제로 ssh 로 수집하는 장비에만 값이 있다', () => {
  assert.equal(exportedSshPort({ type: 'unity480', collectMethod: 'ssh', sshPort: 2222 }), '2222');
  assert.equal(exportedSshPort({ type: 'unity480', collectMethod: 'api' }), '');
  assert.equal(exportedSshPort({ type: 'isilon' }), '22', 'isilon 기본값이 ssh 라 값이 있어야 한다');
});

test('자유텍스트 내보내기도 같은 규칙을 쓴다 — 두 경로가 갈라지면 한쪽만 손실된다', () => {
  const dev = { type: 'unity480', name: 'U1', host: '10.0.0.1', username: 'service', collectMethod: 'ssh', sshPort: 22 };
  assert.match(devicesToText([dev], (x) => x), /\bssh\b/);
});

test('내보내기에 비밀번호를 담지 않는다(기본) — 열 순서도 고정', () => {
  const csv = devicesToCsv([{ type: 'unity480', host: 'h', name: 'n', username: 'u', collectMethod: 'ssh', password: 'SECRET' }], (x) => x);
  assert.ok(!csv.includes('SECRET'), '기본 내보내기에 비밀번호가 들어가면 안 된다');
  assert.equal(CSV_COLUMNS[CSV_COLUMNS.length - 1], 'password');
});

// ── ③ 옛 CSV(빈 칸)로 가져올 때 조용히 바뀌지 않게 ──────────────────────────

test('★ 빈 수집 방식이 기존 값을 바꾸면 경고한다 — 조용한 변경 금지', () => {
  const cur = new Map([['10.0.0.1|unity480', { collectMethod: 'ssh' }], ['10.0.0.2|vmax', { collectMethod: 'api' }]]);
  const find = (h, t) => cur.get(`${h}|${t}`);
  const hints = methodChangeHints([
    { host: '10.0.0.1', type: 'unity480', collectMethod: '' },    // ssh → api (경고)
    { host: '10.0.0.1', type: 'unity480', collectMethod: 'ssh' }, // 값 있음
    { host: '10.0.0.2', type: 'vmax', collectMethod: '' },        // 방식 1개
    { host: '10.9.9.9', type: 'unity480', collectMethod: '' },    // 신규
  ], find);
  assert.equal(hints.length, 1, `경고 ${hints.length}건: ${JSON.stringify(hints)}`);
  assert.match(hints[0].advice, /10\.0\.0\.1/);
  assert.match(hints[0].advice, /'ssh'/, '지금 값을 알려줘야 사용자가 고칠 수 있다');
  // ⚠ 화면은 `BoldText` 로 그린다 — `**` 외의 마크다운(백틱 등)은 글자로 샌다(v2.439·2.440 실제 사고).
  assert.ok(!hints[0].advice.includes('`'), `백틱이 그대로 화면에 찍힌다: ${hints[0].advice}`);
  assert.ok(/\*\*[^*]+\*\*/.test(hints[0].advice), '강조는 ** 로만 쓴다');
});

test('경고는 판정을 다시 하지 않는다 — hints 형태만 만든다(v2.513 규약)', () => {
  const hints = methodChangeHints([{ host: 'h', type: 'unity480', collectMethod: '' }], () => ({ collectMethod: 'ssh' }));
  assert.deepEqual(Object.keys(hints[0]), ['advice'], 'enrichAdvice().hints 와 같은 형태여야 화면이 그린다');
});
