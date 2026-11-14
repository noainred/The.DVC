// 공통 기능 목록(docs/COMMON.md · scripts/common-doc.mjs) 회귀 고정.
//
// 배경: 생성기는 **코드를 정규식으로 훑어** 공용 모듈의 내보내는 이름·사용처·테스트 수를 센다. 정규식이 못 잡는 형태가 생기면
// 숫자가 조용히 틀리는데 생성은 성공하고 `--check` 도 통과한다(v2.563 `docsGen2452` 와 같은 사고 모양). 초판에서 실제로 겪은 것:
//   ① `export const SEL = '.a, .b'` 의 문자열을 import 대상으로 읽었다(2건 — 없는 파일을 가리켜 실패로 드러났다).
//   ② 테스트의 조합 경로 동적 import(`import(pathToFileURL(path.join(SRC, 'util/x.js')))`) 600여 건을 세지 못해
//      '테스트 0' 인 공용 모듈이 35개로 부풀었다(경로 문자열로 세도록 바꾼 뒤 24개).
//   ③ 머리 주석이 import 문 뒤에 오는 `util/atomicWrite.js`(사용처 1위)가 '머리 주석 없음' 으로 실렸다.
// 그래서 여기서는 '문서가 최신인가' 와 함께 **'스캐너가 이 형태들을 여전히 옳게 읽는가'** 를 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';
import {
  SCOPES, SHARED_MIN_AREAS, TEST_FILES_MAX, areaOf, buildCatalog, buildJson, esc, headSummary, isTestFile, renderJson, renderMd,
  scanExports, scanImports, scanPathLiterals,
} from '../../scripts/common-doc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UTIL = path.join(ROOT, 'server/src/util');
const CAT = buildCatalog();
const byFile = new Map(CAT.scopes.flatMap((s) => s.modules).map((m) => [m.file, m]));

test('docs/COMMON.md 가 최신이다 — 생성기 --check 통과', () => {
  const r = spawnSync(process.execPath, ['scripts/common-doc.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}\n→ node scripts/common-doc.mjs 로 갱신할 것`);
});

test('읽지 못한 것이 없다 — problems 0 · 공용 위치마다 모듈이 있다', () => {
  assert.deepEqual(CAT.problems, []);
  for (const sc of CAT.scopes) assert.ok(sc.modules.length > 0, `${sc.dir} 가 비었다`);
  assert.equal(CAT.scopes.length, SCOPES.length);
});

test('내보내는 이름 — 서버 공용 유틸 전수를 실제 모듈 네임스페이스와 대조한다(정규식이 놓치거나 지어내지 않는다)', async () => {
  // 메인 스레드에서 import 할 수 없는 것만 뺀다 — 워커 진입점(parentPort 가 null 이라 로드에서 던진다).
  const SKIP = new Set(['parseWorker.js']);
  const files = fs.readdirSync(UTIL).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length >= 80, `util 모듈 ${files.length}개 — 폴더를 잘못 읽었는지 확인`);
  let compared = 0;
  for (const f of files) {
    if (SKIP.has(f)) continue;
    const scanned = scanExports(stripComments(fs.readFileSync(path.join(UTIL, f), 'utf8')));
    assert.deepEqual(scanned.unreadable, [], `${f}: 읽지 못한 export 형태`);
    const real = Object.keys(await import(pathToFileURL(path.join(UTIL, f)).href)).sort();
    assert.deepEqual([...scanned.names].sort(), real, `${f}: 스캔한 이름이 실제 export 와 다르다`);
    // 문서에 실리는 값도 같은 것이어야 한다.
    assert.deepEqual([...byFile.get(`server/src/util/${f}`).exports].sort(), real, `${f}: 카탈로그 exports`);
    compared += 1;
  }
  assert.ok(compared >= 80, `대조한 모듈 ${compared}개`);
});

test('scanExports — 형태별로 읽고, 이름을 뽑지 못하는 구조 분해는 unreadable 로 올린다', () => {
  const s = stripComments(`
    export function a() {}
    export async function b() {}
    export function* c() {}
    export const d = 1;
    export class E {}
    const x = 1, y = 2;
    export { x, y as z };
    export { q as default } from './q.js';
    export * as ns from './n.js';
    // export const ghost = 1;
  `);
  const r = scanExports(s);
  assert.deepEqual([...r.names].sort(), ['E', 'a', 'b', 'c', 'd', 'default', 'ns', 'x', 'z']);
  assert.deepEqual(r.unreadable, []);
  const bad = scanExports('export const { a, b } = obj;');
  assert.equal(bad.unreadable.length, 1, '구조 분해 export 는 실패로 올려야 한다(조용히 빠지면 안 된다)');
});

test('scanImports — from 을 거친 것만 import 로 읽는다(문자열 상수를 import 로 읽던 초판 오탐)', () => {
  const r = scanImports(stripComments(`
    import a from './a.js';
    import { b,
      c } from "../b.js";
    import './side.css';
    export { d } from './d.js';
    export * from './e.js';
    export const TOP_SEL = '.v6 .v6-top, .topbar';
    export const ACCEPT = '.csv,.json';
    const lazy = () => import('./lazy.js');
    const dyn = await import(modPath);
    obj.import('./notImport.js');
    // import ghost from './ghost.js';
  `));
  assert.deepEqual([...r.specs].sort(), ['../b.js', './a.js', './d.js', './e.js', './lazy.js', './side.css']);
  assert.equal(r.dynamicUnknown, 1, '경로를 조합하는 동적 import 는 건수로 센다');
});

test('scanPathLiterals — 테스트가 가리키는 모듈 경로(조합 경로·캐시 무효화 접미·템플릿)', () => {
  const lits = scanPathLiterals(stripComments([
    "const m = await import(pathToFileURL(path.join(SRC, 'util/numOrNull.js')).href);",
    'const again = await import(`../src/alerts.js?reload=${Math.random()}`);',
    "const src = read(path.join(WEB, \"components/STable.jsx\"));",
    "const notModule = 'hello.json';",
  ].join('\n')));
  assert.deepEqual(lits, ['util/numOrNull.js', '../src/alerts.js', 'components/STable.jsx']);
});

test('headSummary — import 뒤 머리 주석 · 장식 줄 · 자기 파일 이름 접두 · 길이 상한', () => {
  assert.equal(headSummary("import fs from 'node:fs';\nimport path from 'node:path';\n\n/**\n * 원자적 파일 쓰기.\n *\n * 둘째 단락.\n */\nexport const a = 1;"), '원자적 파일 쓰기.');
  assert.equal(headSummary('// ────────────\n// 권한 프레임워크\n// ────────────\nexport const a = 1;'), '권한 프레임워크');
  assert.equal(headSummary('/**\n * util/chunkedPrune.js — 청크 삭제 (v2.453).\n */', 'server/src/util/chunkedPrune.js'), '청크 삭제 (v2.453).');
  assert.equal(headSummary('#!/usr/bin/env node\n/** 한 줄 요약 */\n'), '한 줄 요약');
  assert.equal(headSummary('export const a = 1;\n/** 코드 뒤 주석은 모듈 설명이 아니다 */'), '');
  assert.equal(headSummary('/**\n * 설명.\n * @param {number} a\n */'), '설명.');
  const long = headSummary(`/** ${'가'.repeat(400)} */`);
  assert.equal([...long].length, 151, '150자 + 말줄임');
  assert.ok(long.endsWith('…'));
  // 코드 표기 한가운데서 잘리면 닫는다(열린 백틱은 표의 나머지 칸을 코드로 만든다).
  const cut = headSummary(`/** ${'가'.repeat(140)} \`${'a'.repeat(40)}\` 끝 */`);
  assert.equal((cut.split('`').length - 1) % 2, 0, cut);
  // 실제 파일: 사용처가 가장 많은 모듈이 '설명 없음' 으로 실리면 안 된다.
  assert.ok(byFile.get('server/src/util/atomicWrite.js').summary.startsWith('원자적 파일 쓰기'));
});

test('esc — 칸 구분자는 어디서든, 꺾쇠는 코드 표기 밖에서만 바꾼다', () => {
  assert.equal(esc('`<table>` 대체 — <b> 가 아님 | 끝'), '`<table>` 대체 — &lt;b> 가 아님 \\| 끝');
  assert.equal(esc('`a|b`'), '`a\\|b`');
});

test('areaOf · isTestFile — 영역과 테스트 구분', () => {
  assert.equal(areaOf('server/src/storage/poller.js'), 'server:storage');
  assert.equal(areaOf('server/src/routes/api/x.js'), 'server:routes');
  assert.equal(areaOf('server/src/index.js'), 'server:(루트)');
  assert.equal(areaOf('web/src/views/tools/Gpu.jsx'), 'web:views/tools');
  assert.equal(areaOf('web/src/views/Overview.jsx'), 'web:views');
  assert.equal(areaOf('web/src/App.jsx'), 'web:(루트)');
  assert.equal(isTestFile('server/test/a.test.js'), true);
  assert.equal(isTestFile('server/test/_stripComments.js'), true);
  assert.equal(isTestFile('web/src/components/STable.test.jsx'), true);
  assert.equal(isTestFile('web/src/components/STable.jsx'), false);
});

test('카탈로그 기준점 — 널리 쓰이는 코어가 사용처·테스트와 함께 실린다', () => {
  const num = byFile.get('server/src/util/numOrNull.js');
  assert.ok(num.users >= 100 && num.areas >= 30, `numOrNull 사용처 ${num.users} · 영역 ${num.areas}`);
  assert.ok(num.tests >= 1);
  assert.ok(num.exports.includes('numOrNull'));
  // 조합 경로 동적 import 로만 테스트하는 모듈도 테스트가 세어진다(초판은 0 이었다).
  const stable = byFile.get('web/src/components/STable.jsx');
  assert.ok(stable.users >= 100, `STable 사용처 ${stable.users}`);
  assert.ok(stable.tests >= 1, 'STable 을 가리키는 테스트');
  // 테스트 파일·진입점은 공용 모듈로 실리지 않는다.
  for (const f of byFile.keys()) assert.equal(isTestFile(f), false, f);
  assert.equal(byFile.has('web/src/App.jsx'), false);
  assert.equal(byFile.has('web/src/main.jsx'), false);
  // 공용 위치 밖 목록에는 공용 위치의 모듈이 섞이지 않고, 서버는 기준 영역 수를 넘는다.
  assert.ok(CAT.shared.some((m) => m.file === 'server/src/config.js'));
  for (const m of CAT.shared) {
    assert.equal(byFile.has(m.file), false, m.file);
    if (m.side === 'server') assert.ok(m.otherAreas >= SHARED_MIN_AREAS, m.file);
  }
  // 서버·웹 두 벌 — numOrNull 은 양쪽에 있다(루트 CLAUDE.md).
  assert.ok(CAT.twins.some((t) => t.name === 'numOrNull'));
});

test('renderMd — 모든 공용 모듈이 한 줄씩 실리고, 두 번 만들어도 같다(생성 시각을 싣지 않는다)', () => {
  const md = renderMd(CAT);
  for (const sc of CAT.scopes) {
    for (const m of sc.modules) {
      const name = m.file.slice(sc.dir.length + 1);
      assert.ok(md.includes(`| \`${name}\` |`), `${m.file} 가 문서에 없다`);
    }
  }
  // 생성 시각을 실으면 매 실행이 diff 를 만든다(머리 주석에서 온 날짜는 내용이라 괜찮다).
  assert.equal(/마지막 갱신|생성 시각|generatedAt/.test(md), false);
  assert.equal(md, renderMd(buildCatalog()), '두 번 만들어도 같다');
});

test('화면용 JSON — 문서와 같은 모듈 · 영역별 개수의 합 = 사용처 · 두 벌은 서로를 가리킨다 · 생성 시각 · 버전을 싣지 않는다', () => {
  const j = buildJson(CAT);
  const common = j.modules.filter((m) => m.scope !== 'outside');
  assert.equal(common.length, byFile.size, '공용 위치의 모듈 수가 문서와 같다');
  assert.equal(j.modules.length - common.length, CAT.shared.length);
  assert.deepEqual(j.scopes.map((s) => s.count), [...CAT.scopes.map((s) => s.modules.length), CAT.shared.length]);
  const byKey = new Map(j.modules.map((m) => [m.file, m]));
  for (const m of j.modules) {
    assert.equal(m.areaCounts.reduce((n, [, c]) => n + c, 0), m.users, `${m.file}: 영역별 개수의 합`);
    assert.equal(m.areaCounts.length, m.areas, `${m.file}: 영역 수`);
    assert.ok(m.testFiles.length <= TEST_FILES_MAX && m.testFiles.length <= m.tests, `${m.file}: 테스트 파일 상한`);
    if (m.twin) assert.equal(byKey.get(m.twin)?.twin, m.file, `${m.file}: 두 벌은 서로를 가리킨다`);
    // 사용처 **파일 목록**은 싣지 않는다(한 모듈이 수백 개 — 설계 §4.2).
    assert.equal('importers' in m || 'users_files' in m, false);
  }
  assert.equal(byKey.get('server/src/util/numOrNull.js').twin, 'web/src/numOrNull.js');
  // 영역은 많은 순.
  const dl = byKey.get('server/src/util/deadline.js');
  assert.deepEqual(dl.areaCounts.map(([, c]) => c), [...dl.areaCounts.map(([, c]) => c)].sort((a, b) => b - a));
  const text = renderJson(j);
  assert.deepEqual(JSON.parse(text), j, '글자로 낸 것을 다시 읽으면 같은 객체다');
  assert.equal(text.split('\n').filter((l) => l.startsWith('    {')).length, j.modules.length, '모듈 하나가 한 줄');
  // 버전 · 시각을 실으면 릴리스의 버전업마다 다시 만들어야 한다.
  assert.equal(/"(?:version|generatedAt|at)"\s*:/.test(text), false);
  assert.equal(text, renderJson(buildJson(buildCatalog())), '두 번 만들어도 같다');
});

test('못 읽으면 실패한다 — 풀리지 않는 import · 빈 공용 위치 · 구조 분해 export', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'common-doc-'));
  try {
    const put = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), body);
    };
    put('server/src/util/ok.js', '/** 정상 모듈 */\nexport const ok = 1;\n');
    put('server/src/util/destruct.js', 'export const { a, b } = {};\n');
    put('server/src/storage/poller.js', "import { ok } from '../util/ok.js';\nimport { gone } from '../util/gone.js';\nexport const p = ok + gone;\n");
    put('server/test/ok.test.js', "import { ok } from '../src/util/ok.js';\nconst fake = './fixture-only.js';\n");
    const cat = buildCatalog(tmp);
    const text = cat.problems.join('\n');
    assert.match(text, /server\/src\/storage\/poller\.js: import '\.\.\/util\/gone\.js' 를 파일로 풀지 못했습니다/);
    assert.match(text, /server\/src\/util\/destruct\.js: 내보내기 형태를 읽지 못했습니다/);
    assert.match(text, /공용 위치 'web\/src\/components' 에서 모듈을 하나도 찾지 못했습니다/);
    // 테스트 안의 가짜 경로는 실패가 아니고(픽스처), 실재하는 것만 센다.
    assert.equal(/fixture-only/.test(text), false);
    const ok = cat.scopes[0].modules.find((m) => m.file === 'server/src/util/ok.js');
    assert.deepEqual([ok.users, ok.areas, ok.tests, ok.summary], [1, 1, 1, '정상 모듈']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
