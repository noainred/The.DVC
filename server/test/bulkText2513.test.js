/**
 * v2.513 — 대량 등록 자유텍스트/조언/연결테스트 실행기 회귀.
 *
 * 사용자 요청(2026-09-15): CSV + **자유텍스트** import/export · 샘플 다운로드 ·
 * "실제로 테스트해서 동작하는지 검증" · "검증을 통과한 일부만 등록" ·
 * "실패한 부분을 text 의 어떤 부분을 고치라고 조언".
 *
 * 여기서 고정하는 핵심:
 *  · 구분자 판정 순서(탭 → | → 쉼표 → 공백) — 뒤집으면 엑셀 붙여넣기가 전부 깨진다.
 *  · 기본값은 **빈 필드만** 채운다(줄에 적힌 값을 덮지 않는다).
 *  · 잘라낸 것·무시한 것은 **개수/사유를 밝힌다**(조용한 절단 금지).
 *  · 조언은 **어느 줄 몇 번째 항목**인지 말하고, 특정 못 하면 지어내지 않는다.
 *  · 연결 테스트는 재진입 가드·자동 재시도 금지·'테스트 불가'와 '실패' 구분.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFreeRows, rowsToFreeText, splitLine, parseKeyed, unmark, EMPTY_MARK } from '../src/util/bulkText.js';
import { fieldOfIssue, expectationFor, tokenPos, adviseRow, preflightHints } from '../src/util/bulkAdvice.js';
import { startBulkTest, publicRun, passedLines, isBusy, _resetForTest } from '../src/util/bulkRun.js';

const FIELDS = ['type', 'name', 'host', 'username', 'password'];
const ALIASES = { 타입: 'type', 표시명: 'name', ip: 'host', 계정: 'username', 비밀번호: 'password' };
const P = (t, extra = {}) => parseFreeRows(t, { fields: FIELDS, aliases: ALIASES, ...extra });

/* ────────────────── 구분자·형식 ────────────────── */

test('구분자 판정 순서 — 탭 > | > 쉼표 > 공백(값 안의 공백을 열로 오해하지 않는다)', () => {
  // 탭이 있으면 공백으로 쪼개지 않는다 → 'WA Isilon 01' 이 한 값으로 남는다.
  assert.deepEqual(splitLine('isilon\tWA Isilon 01\t10.0.0.1'), ['isilon', 'WA Isilon 01', '10.0.0.1']);
  assert.deepEqual(splitLine('isilon | WA Isilon 01 | 10.0.0.1'), ['isilon', 'WA Isilon 01', '10.0.0.1']);
  assert.deepEqual(splitLine('isilon, WA Isilon 01, 10.0.0.1'), ['isilon', 'WA Isilon 01', '10.0.0.1']);
  // 구분자가 없으면 공백으로만 쪼갠다.
  assert.deepEqual(splitLine('isilon   WA-01  10.0.0.1'), ['isilon', 'WA-01', '10.0.0.1']);
});

test('위치형 — fields 순서대로 대입, 주석·빈 줄 건너뜀, _line 은 원문 줄 번호', () => {
  const r = P([
    '# 주석',
    '',
    'isilon\tWA-01\t10.0.0.1\troot\tpw1',
    'powerstore\tKR-PS\t10.0.0.2\tadmin\tpw2',
  ].join('\n'));
  assert.equal(r.error, undefined);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { _line: 3, type: 'isilon', name: 'WA-01', host: '10.0.0.1', username: 'root', password: 'pw1' });
  assert.equal(r.rows[1]._line, 4, '원문 줄 번호를 쓴다(주석·빈 줄을 세지 않으면 조언이 엉뚱한 줄을 가리킨다)');
});

test('키=값형 — 값 안의 공백 보존, 한글 별칭, 모르는 키는 경고로 밝힌다', () => {
  const r = P('name=WA 아카이브 01 host=10.0.0.1 type=isilon 계정=root bogus=x');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].name, 'WA 아카이브 01', '다음 키 직전까지가 값이다');
  assert.equal(r.rows[0].host, '10.0.0.1');
  assert.equal(r.rows[0].username, 'root', '한글 별칭도 받는다');
  assert.ok(r.warnings.some((w) => /bogus/.test(w)), '모르는 키를 조용히 버리지 않는다');
});

test('키=값형은 `key: value` 표기도 받는다(값의 `:` 는 보존)', () => {
  const { values } = parseKeyed('host: 10.0.0.1 note: a:b:c', { aliasOf: (k) => ({ host: 'host', note: 'note' }[k.toLowerCase()] || null) });
  assert.equal(values.host, '10.0.0.1');
  assert.equal(values.note, 'a:b:c', '첫 구분자만 쓰므로 값 안의 콜론이 살아남는다');
});

test('헤더 줄 — 토큰이 전부 필드/별칭일 때만 열 순서로 쓴다', () => {
  const r = P(['host\tname\ttype', '10.0.0.9\tKR-01\tunity'].join('\n'));
  assert.deepEqual(r.headerUsed, ['host', 'name', 'type']);
  assert.equal(r.rows[0].host, '10.0.0.9');
  assert.equal(r.rows[0].name, 'KR-01');
  // 한 토큰이라도 모르면 데이터 행이다 — 첫 줄을 헤더로 삼켜 장비 하나를 잃으면 안 된다.
  const r2 = P('isilon\tWA-01\t10.0.0.1');
  assert.equal(r2.headerUsed, null);
  assert.equal(r2.rows.length, 1, '데이터 행이 헤더로 소비되지 않는다');
});

test('헤더는 파일 중간에도 받는다 — 세 표기를 한 파일에 담은 샘플이 깨지지 않게', () => {
  // 실제 결함: '데이터 전에만 헤더' 였을 때, 샘플의 ③ 헤더형이 데이터 행으로 파싱돼
  // `type='host'` 쓰레기 행이 생겼다(샘플을 그대로 가져오면 오류가 났다).
  const r = P([
    'isilon\tWA-01\t10.0.0.1',
    'host\tname\ttype',
    '10.0.0.9\tKR-01\tunity',
  ].join('\n'));
  assert.equal(r.rows.length, 2, '중간 헤더가 데이터 행이 되지 않는다');
  assert.equal(r.rows[1].host, '10.0.0.9');
  assert.equal(r.rows[1].name, 'KR-01');
  assert.equal(r.rows[1].type, 'unity');
  assert.ok(r.warnings.some((w) => /열 순서를/.test(w)), '순서가 바뀐 사실을 조용히 넘기지 않는다');
});

test('기본값은 빈 필드만 채운다 — 줄에 적힌 값을 덮지 않는다', () => {
  const r = P(['10.0.0.1', 'isilon\tX\t10.0.0.2'].join('\n'), { defaults: { type: 'unity', username: 'admin' } });
  // 1줄: 위치형 첫 열은 type 이라 '10.0.0.1' 이 type 에 들어간다(사용자가 헤더/키를 줘야 한다) —
  // 이 동작을 고정한다. 기본값은 비어 있는 name/host/password 에만 적용된다.
  assert.equal(r.rows[0].type, '10.0.0.1');
  assert.equal(r.rows[0].username, 'admin', '빈 필드는 기본값');
  assert.equal(r.rows[1].type, 'isilon', '적힌 값은 기본값이 덮지 않는다');
  assert.equal(r.rows[1].username, 'admin');
});

test('상한·절단은 개수와 사유를 밝힌다(조용한 절단 금지)', () => {
  const many = Array.from({ length: 5 }, (_, i) => `isilon\tN${i}\t10.0.0.${i}`).join('\n');
  const r = P(many, { limits: { maxRows: 2 } });
  assert.equal(r.rows.length, 2);
  assert.ok(r.warnings.some((w) => /행 상한/.test(w) && /3줄 남음/.test(w)));

  const long = `isilon\t${'a'.repeat(50)}\t10.0.0.1`;
  const r2 = P(long, { limits: { maxCell: 10 } });
  assert.equal(r2.rows[0].name.length, 10);
  assert.ok(r2.warnings.some((w) => /잘랐습니다/.test(w)));

  const r3 = P('isilon\tA\t10.0.0.1\troot\tpw\tEXTRA1\tEXTRA2');
  assert.ok(r3.warnings.some((w) => /뒤 2개를 무시/.test(w)));
});

test('제어문자·NBSP 는 값에서 제거한다(비밀번호가 셸·검증으로 흘러가는 필드다)', () => {
  const r = P('isilon\tA\t10.0.0.1\troot\tp\u0007w');
  assert.equal(r.rows[0].password, 'pw');
  const r2 = P('isilon\u00a0A\u00a010.0.0.1');   // NBSP 는 공백으로 정규화 → 공백 분리
  assert.equal(r2.rows[0].name, 'A');
});

test('읽을 게 없으면 오류로 밝힌다(빈 입력을 성공 0건으로 위장하지 않는다)', () => {
  for (const bad of ['', '   ', '# only comment', null, undefined]) {
    const r = P(bad);
    assert.equal(r.rows.length, 0);
    assert.ok(r.error, `입력 ${JSON.stringify(bad)} 은 오류여야 한다`);
  }
});

test('줄 수 하드 상한 — 거대 붙여넣기는 파싱 전에 거절', () => {
  const r = P(Array.from({ length: 30 }, () => 'x').join('\n'), { limits: { maxLines: 10 } });
  assert.match(r.error, /줄이 너무 많습니다/);
});

/* ────────────────── 내보내기 왕복 ────────────────── */

test('내보내기 → 가져오기 왕복: 빈칸은 `-`, 공백 포함 값은 인용', () => {
  const rows = [
    { type: 'isilon', name: 'WA 아카이브', host: '10.0.0.1', username: 'root', password: '' },
    { type: 'unity', name: 'KR-01', host: '10.0.0.2', username: '', password: '' },
  ];
  const txt = rowsToFreeText(rows, FIELDS);
  assert.ok(txt.split('\n')[0].startsWith('#'), '헤더는 주석으로 — 되가져올 때 데이터로 오해되지 않는다');
  assert.ok(txt.includes('"WA 아카이브"'), '공백 포함 값은 인용해 열 경계를 지킨다');
  assert.ok(txt.includes(EMPTY_MARK), '빈칸은 표시로 채워 열이 밀리지 않게 한다');

  const back = P(txt);
  assert.equal(back.rows.length, 2, '헤더 주석은 행으로 세지 않는다');
  assert.equal(unmark(back.rows[0].name), 'WA 아카이브');
  assert.equal(unmark(back.rows[1].username), '', '`-` 는 빈 값으로 되돌린다');
});

/* ────────────────── 실패 조언 ────────────────── */

test('fieldOfIssue — registry 문구에서 필드를 뽑고, 모르면 지어내지 않는다', () => {
  assert.equal(fieldOfIssue('알 수 없는 스위치 타입: foo'), 'type');
  assert.equal(fieldOfIssue('host 형식 오류 — IP/호스트명만'), 'host');
  assert.equal(fieldOfIssue('표시명 형식 오류(1~64자)'), 'name');
  assert.equal(fieldOfIssue('접속 계정을 입력하세요.'), 'username');
  assert.equal(fieldOfIssue('sshPort 는 1~65535 정수만 가능합니다.'), 'sshPort');
  assert.equal(fieldOfIssue('Virtual Fabric ID 는 1~128 정수만'), 'vfId');
  assert.equal(fieldOfIssue('뭔가 알 수 없는 오류'), null, '특정 못 하면 null — 엉뚱한 열을 고치라고 하면 멀쩡한 값이 망가진다');
});

test('tokenPos — 위치형은 몇 번째 항목인지, 키형은 그 키를, 없으면 missing', () => {
  const order = ['type', 'name', 'host'];
  assert.deepEqual(tokenPos('isilon\tWA-01\t10.0.0.1', 'host', order), { col: 3, at: null, len: 8, form: 'positional' });
  assert.equal(tokenPos('host=10.0.0.1 type=isilon', 'host', order).form, 'keyed');
  assert.equal(tokenPos('isilon\tWA-01', 'host', order).form, 'missing', '항목 자체가 없는 것과 값이 틀린 것은 다르다');
  assert.equal(tokenPos('isilon', 'password', order), null, '열 순서에 없으면 강조하지 않는다');
});

test('adviseRow — 어느 줄 몇 번째 항목인지 + 후보 값을 말한다', () => {
  const row = { _line: 7, type: 'iSilon2', name: 'A', host: '10.0.0.1' };
  const a = adviseRow(row, "알 수 없는 타입 'iSilon2'", {
    lineText: 'iSilon2\tA\t10.0.0.1', order: ['type', 'name', 'host'], format: 'text',
    ctx: { types: ['isilon', 'powerstore', 'unity'] },
  });
  assert.equal(a.field, 'type');
  assert.equal(a.line, 7);
  assert.match(a.advice, /7줄의 1번째 항목/);
  assert.match(a.advice, /iSilon2/, '현재 값을 보여 준다');
  assert.match(a.advice, /isilon/, '고칠 후보를 보여 준다');
  assert.equal(a.issue, "알 수 없는 타입 'iSilon2'", 'registry 원문을 보존해 함께 싣는다');
});

test('adviseRow — CSV 는 "열", 자유텍스트는 "n번째 항목" 으로 말한다', () => {
  const row = { _line: 2, host: '' };
  const csv = adviseRow(row, 'host 형식 오류', { lineText: 'isilon,A,,root', order: ['type', 'name', 'host', 'username'], format: 'csv' });
  assert.match(csv.advice, /'host' 열/);
  const txt = adviseRow(row, 'host 형식 오류', { lineText: 'isilon A  root', order: ['type', 'name', 'host', 'username'], format: 'text' });
  assert.match(txt.advice, /번째 항목|'host'/);
});

test('adviseRow — 필드를 특정 못 하면 줄만 말하고 고칠 열을 지목하지 않는다', () => {
  const a = adviseRow({ _line: 3 }, '알 수 없는 저장 실패', { lineText: 'x y z', order: ['type'] });
  assert.equal(a.field, null);
  assert.equal(a.token, null);
  assert.match(a.advice, /3줄/);
  assert.doesNotMatch(a.advice, /번째 항목/);
});

test('preflightHints — 실제로 본 실수만 잡는다(URL·포트·전각·스마트 인용부호)', () => {
  const rows = [
    { _line: 1, host: 'https://10.0.0.1/', name: 'A' },
    { _line: 2, host: '10.0.0.2:22', name: 'B' },
    { _line: 3, host: '10.0.0.3', name: '테스트　장비' },
    { _line: 4, host: '10.0.0.4', name: '‘A’' },
    { _line: 5, host: '10.0.0.5', name: 'OK' },
  ];
  const h = preflightHints(rows, ['name', 'host']);
  assert.ok(h.some((x) => x.line === 1 && /URL/.test(x.advice)));
  assert.ok(h.some((x) => x.line === 2 && /포트/.test(x.advice)));
  assert.ok(h.some((x) => x.line === 3 && /전각/.test(x.advice)));
  assert.ok(h.some((x) => x.line === 4 && /스마트 인용부호/.test(x.advice)));
  assert.ok(!h.some((x) => x.line === 5), '정상 행에는 조언을 만들지 않는다');
  assert.ok(h.every((x) => x.severity === 'warn'), '사전 힌트는 경고 — 저장을 막지 않는다');
});

test('expectationFor — 후보가 유한하면 enum, 아니면 형식 설명. 비밀번호는 "비우면 유지"를 말한다', () => {
  assert.deepEqual(expectationFor('collectMethod').values, ['ssh', 'api']);
  assert.equal(expectationFor('host').kind, 'format');
  assert.match(expectationFor('password').hint, /기존 비밀번호를 유지/);
  assert.equal(expectationFor('알수없는필드').kind, 'none');
});

/* ────────────────── 연결 테스트 실행기 ────────────────── */

const settle = async (id, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (publicRun(id)?.status === 'done') return publicRun(id);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('run 이 끝나지 않았다');
};

test("연결 테스트 — 성공/실패/'테스트 불가'를 구분하고 통과 줄만 골라 준다", async () => {
  _resetForTest();
  const rows = [
    { _line: 1, name: 'ok1', host: '10.0.0.1' },
    { _line: 2, name: 'bad', host: '10.0.0.2' },
    { _line: 3, name: 'edge', host: '10.0.0.3', agent: 'WA' },
    { _line: 4, name: 'ok2', host: '10.0.0.4' },
  ];
  const r = startBulkTest({
    kind: 'unit-a', rows,
    skipReason: (row) => (row.agent ? '엣지 위임 장비 — 중앙에서 직접 접속할 수 없습니다.' : null),
    testOne: async (row) => (row.name.startsWith('ok') ? { ok: true, detail: { summary: '로그인 성공' } } : { ok: false, reason: '인증 실패' }),
  });
  assert.equal(r.ok, true);
  const run = await settle(r.id);
  assert.equal(run.total, 4);
  assert.deepEqual(run.summary, { ok: 2, fail: 1, skipped: 1, pending: 0 });
  assert.deepEqual(passedLines(r.id), [1, 4], "'통과한 것만 등록' 이 이 줄 번호로 행을 고른다");
  const edge = run.results.find((x) => x.line === 3);
  assert.equal(edge.status, 'skipped');
  assert.match(edge.reason, /엣지 위임/, "닿지 못한 것을 '연결 실패' 라고 말하지 않는다");
  assert.equal(isBusy('unit-a'), false, '끝나면 가드가 풀린다');
});

test('재진입 가드 — 진행 중 같은 도구의 새 실행을 거절한다(로그인 시도 중복 방지)', async () => {
  _resetForTest();
  let release;
  const gate = new Promise((res) => { release = res; });
  const first = startBulkTest({ kind: 'unit-b', rows: [{ _line: 1, host: 'h' }], testOne: async () => { await gate; return { ok: true }; } });
  assert.equal(first.ok, true);
  const second = startBulkTest({ kind: 'unit-b', rows: [{ _line: 1, host: 'h' }], testOne: async () => ({ ok: true }) });
  assert.equal(second.ok, false);
  assert.match(second.reason, /진행 중/);
  assert.equal(isBusy('unit-b'), true);
  release();
  await settle(first.id);
  assert.equal(isBusy('unit-b'), false);
});

test('시한 초과는 사람 말로 보고한다(AbortError 원문을 그대로 내보내지 않는다)', async () => {
  _resetForTest();
  const r = startBulkTest({
    kind: 'unit-c', rows: [{ _line: 1, host: 'h' }], timeoutMs: 20,
    testOne: (row, signal) => new Promise((res, rej) => {
      signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    }),
  });
  const run = await settle(r.id);
  assert.equal(run.results[0].status, 'fail');
  assert.match(run.results[0].reason, /시한 초과/);
});

test('testOne 이 던져도 그 행만 실패로 남고 나머지는 계속된다', async () => {
  _resetForTest();
  const r = startBulkTest({
    kind: 'unit-d',
    rows: [{ _line: 1, host: 'a' }, { _line: 2, host: 'b' }],
    testOne: async (row) => { if (row.host === 'a') throw new Error('폭발'); return { ok: true }; },
  });
  const run = await settle(r.id);
  assert.equal(run.results[0].reason, '폭발');
  assert.equal(run.results[1].status, 'ok');
});

test('빈 목록·없는 run 은 조용히 성공으로 위장하지 않는다', async () => {
  _resetForTest();
  assert.equal(startBulkTest({ kind: 'unit-e', rows: [], testOne: async () => ({ ok: true }) }).ok, false);
  assert.equal(publicRun('nope'), null);
  assert.equal(passedLines('nope'), null);
});

test('응답에는 자격증명이 실리지 않는다', async () => {
  _resetForTest();
  const r = startBulkTest({
    kind: 'unit-f', rows: [{ _line: 1, name: 'A', host: 'h', username: 'root', password: 'S3cret!' }],
    testOne: async () => ({ ok: true }),
  });
  const run = await settle(r.id);
  assert.ok(!JSON.stringify(run).includes('S3cret!'), '비밀번호가 응답 어디에도 없어야 한다');
  assert.ok(!JSON.stringify(run).includes('root'));
});
