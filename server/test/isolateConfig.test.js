/**
 * isolateConfig.test.js — 서버 시험이 실제 설정 폴더(server/config)에 쓰지 않게 하는 미리 불러오기(`test/_isolateConfig.js`) 고정.
 *
 * 사용자 요청(2026-11-26): "테스트가 설정 폴더에 쓰는 것도 고쳐줘". 전량 실행 뒤 server/config 에 시험 데이터 12종이 남았고(gitignore 대상이라
 * 눈에 띄지 않는다), 같은 체크아웃에서 다시 돌리면 그것을 읽어 arch2582 BUG-2 가 두 번째 실행부터 실패했다.
 *
 * 고정하는 것:
 *  ① npm test 명령이 미리 불러오기를 붙인다(빠지면 이 보호가 통째로 사라진다).
 *  ② CONFIG_DIR 이 없으면 빈 임시 폴더를 잡고 · 있으면 건드리지 않는다 · 프로세스가 끝나면 지운다.
 *  ③ 시험 실행기는 시험 파일마다 자식 프로세스에서 이 파일을 불러온다 — 파일마다 다른 폴더(실측 고정: 부모에서만 돌면 이 보호는 성립하지 않는다).
 *  ④ 죽은 실행이 남긴 폴더 청소 · ⑤ 상위 폴더가 심링크 · 남의 것이면 쓰지 않는다 · ⑥ 웹 vitest 전역 준비도 같은 규칙(`_tmpRoot.js` 하나).
 *  ⑦ (2026-11-28) 기본 설정 폴더에 **쓴** 시험 파일은 첫 import 로 `./_isolateConfig.js` 를 스스로 부른다 — 아니면 그 파일을 실패시킨다.
 *     미리 불러오기는 `npm test` 에만 붙는다: 선언이 없는 파일을 `node --test test/x.test.js` 로 직접 돌리면 실제 server/config 에 쓴다
 *     (이번에 파일마다 빈 상자로 다시 훑으니 11-26 의 '12개' 보다 훨씬 많았다 — 같은 파일은 먼저 쓴 시험만 보여 가려졌다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const PRELOAD = path.join(HERE, '_isolateConfig.js');

test('① npm test 는 미리 불러오기(_isolateConfig.js)를 붙인다', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /^node --test --import \.\/test\/_isolateConfig\.js /);
  assert.match(pkg.scripts.test, / test\/\*\.test\.js$/);
  // 미리 불러오기 파일은 시험 글롭(*.test.js)에 걸리지 않아야 한다(시험으로 돌면 안 된다)
  assert.doesNotMatch(path.basename(PRELOAD), /\.test\.js$/);
});

test('① 이 시험 자체가 npm test 로 돌 때는 격리된 폴더를 받는다(직접 실행이면 건너뛴다)', { skip: !process.env.DVC_TEST_ISOLATED_CONFIG && '미리 불러오기 없이 직접 실행' }, () => {
  const dir = process.env.CONFIG_DIR;
  assert.equal(dir, process.env.DVC_TEST_ISOLATED_CONFIG);
  assert.ok(dir.startsWith(path.join(process.env.DVC_TEST_ORIG_TMPDIR, '')), dir);
  // 임시 폴더(TMPDIR)도 같은 상자 안 — 시험이 os.tmpdir() 에 만든 폴더가 상자째 지워진다(전량 한 번에 /tmp 에 약 50개 남던 것)
  assert.equal(path.dirname(os.tmpdir()), path.dirname(dir), `${os.tmpdir()} · ${dir}`);
  assert.ok(!path.resolve(dir).startsWith(path.join(SERVER, 'config')), '실제 설정 폴더가 아니다');
});

/** 미리 불러오기를 붙인 자식 node 를 띄워 CONFIG_DIR 과 그 폴더의 존재를 돌려받는다. */
function child(extraEnv, code) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['CONFIG_DIR', 'DVC_TEST_ISOLATED_CONFIG']) if (!(k in extraEnv)) delete env[k];
  const out = execFileSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(out.trim().split('\n').pop());
}

test('② CONFIG_DIR 이 없으면 빈 임시 폴더를 잡고, 프로세스가 끝나면 지운다', () => {
  const r = child({}, `import fs from 'node:fs';
const d = process.env.CONFIG_DIR;
fs.writeFileSync(d + '/x.json', '{}'); fs.mkdirSync(d + '/sub'); fs.writeFileSync(d + '/sub/y.db', 'z');
console.log(JSON.stringify({ d, mark: process.env.DVC_TEST_ISOLATED_CONFIG, empty: fs.readdirSync(d).length }));`);
  assert.ok(r.d && r.d.startsWith(path.join(os.tmpdir(), `dvc-test-cfg-${process.getuid()}`, '')), r.d);
  assert.equal(r.mark, r.d);
  assert.equal(fs.existsSync(r.d), false, '끝나면 하위 파일까지 지운다');
  assert.equal(fs.existsSync(path.dirname(r.d)), false, '상자(설정 · 임시 폴더)째 지운다');
});

test('② 다른 exit 훅(종료 flush 레지스트리)이 뒤에 걸려 폴더에 써도 정리가 마지막에 돈다 — 폴더가 남지 않는다', () => {
  // 첫 전량 실행에서 sanswitch 활동 기록 · 엣지 사본을 담은 폴더 1개가 남았다: 정리(exit)가 먼저 돌고, 그 뒤 exitFlush 의 exit 훅이 디바운스 저장을 써 폴더를 다시 만들었다.
  const r = child({}, `import fs from 'node:fs';
const { registerExitFlush } = await import(${JSON.stringify(new URL('../src/util/exitFlush.js', import.meta.url).href)});
const d = process.env.CONFIG_DIR;
registerExitFlush('late-writer', () => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + '/late.json', '{}'); });
process.once('exit', () => { fs.mkdirSync(d + '/x', { recursive: true }); fs.writeFileSync(d + '/x/late2.json', '{}'); });
console.log(JSON.stringify({ d }));`);
  assert.equal(fs.existsSync(r.d), false, `뒤에 걸린 exit 훅이 쓴 뒤에도 폴더가 지워져야 한다: ${r.d}`);
});

test('② process.exit() 로 끝나도 지운다', () => {
  const r = child({}, `import fs from 'node:fs';
const d = process.env.CONFIG_DIR; fs.writeFileSync(d + '/a.json', '{}');
console.log(JSON.stringify({ d })); process.exit(0);`);
  assert.equal(fs.existsSync(r.d), false);
});

test('② CONFIG_DIR 이 이미 있으면 건드리지 않는다(현장 · CI · 상위 셸 지정)', () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-keep-'));
  try {
    const r = child({ CONFIG_DIR: mine }, `console.log(JSON.stringify({ d: process.env.CONFIG_DIR, mark: process.env.DVC_TEST_ISOLATED_CONFIG || null }));`);
    assert.equal(r.d, mine);
    assert.equal(r.mark, null);
    assert.equal(fs.existsSync(mine), true, '남이 정한 폴더는 지우지 않는다');
  } finally { fs.rmSync(mine, { recursive: true, force: true }); }
});

test('② config.js 는 미리 불러오기가 잡은 폴더를 설정 폴더로 쓴다(실제 server/config 가 아니다)', () => {
  const r = child({}, `const { config } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
console.log(JSON.stringify({ dir: config.configDir, env: process.env.CONFIG_DIR }));
process.exit(0);`);
  assert.equal(r.dir, r.env);
  assert.notEqual(path.resolve(r.dir), path.join(SERVER, 'config'));
});

test('③ 시험 실행기는 시험 파일마다 자식 프로세스에서 미리 불러온다 — 파일마다 다른 폴더', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-runner-'));
  try {
    const body = `import { test } from 'node:test'; test('t', () => { console.log('CFG=' + process.env.CONFIG_DIR); });\n`;
    fs.writeFileSync(path.join(tmp, 'a.test.mjs'), body);
    fs.writeFileSync(path.join(tmp, 'b.test.mjs'), body);
    const env = { ...process.env }; delete env.CONFIG_DIR; delete env.DVC_TEST_ISOLATED_CONFIG; delete env.NODE_TEST_CONTEXT;
    const out = execFileSync(process.execPath, ['--test', '--import', PRELOAD, 'a.test.mjs', 'b.test.mjs'], { cwd: tmp, env, encoding: 'utf8', timeout: 60_000 });
    const dirs = [...out.matchAll(/CFG=(\S+)/g)].map((m) => m[1]);
    assert.equal(dirs.length, 2, out);
    assert.notEqual(dirs[0], dirs[1], '파일마다 다른 임시 폴더');
    for (const d of dirs) {
      assert.ok(d.startsWith(path.join(os.tmpdir(), `dvc-test-cfg-${process.getuid()}`, '')), d);
      assert.equal(fs.existsSync(d), false, '자식이 끝나면 지워진다');
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('④ 죽은 시험 프로세스(시한 초과 · Ctrl-C)가 남긴 폴더는 다음 실행이 지운다 — 살아 있는 프로세스 · 최근 폴더는 두고', () => {
  const ROOT = path.join(os.tmpdir(), `dvc-test-cfg-${process.getuid()}`);
  fs.mkdirSync(ROOT, { recursive: true });
  // 없는 pid(32비트 끝 근처 — pid_max 를 넘는다) · 오래됨 → 지운다
  const dead = fs.mkdtempSync(path.join(ROOT, '2147483000-'));
  fs.writeFileSync(path.join(dead, 'a.json'), '{}');
  const old = (Date.now() - 20 * 60_000) / 1000; fs.utimesSync(dead, old, old);
  // 없는 pid · 최근 → 둔다(다른 이름공간의 살아 있는 시험일 수 있다)
  const fresh = fs.mkdtempSync(path.join(ROOT, '2147483001-'));
  // 살아 있는 pid(이 프로세스) · 오래됨 → 둔다
  const alive = fs.mkdtempSync(path.join(ROOT, `${process.pid}-`)); fs.utimesSync(alive, old, old);
  try {
    child({}, `console.log(JSON.stringify({ d: process.env.CONFIG_DIR }));`);
    assert.equal(fs.existsSync(dead), false, '죽은 pid · 오래된 폴더는 지운다');
    assert.equal(fs.existsSync(fresh), true, '최근 폴더는 둔다');
    assert.equal(fs.existsSync(alive), true, '살아 있는 pid 의 폴더는 둔다');
  } finally { for (const d of [dead, fresh, alive]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('④ 시험 실행기가 자식을 시한 초과로 죽여도 다음 실행에서 지워진다(실제 실행기)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-kill-'));
  try {
    fs.writeFileSync(path.join(tmp, 'hang.test.mjs'), `import { test } from 'node:test'; import fs from 'node:fs';
test('hang', async () => { fs.writeFileSync(process.env.CONFIG_DIR + '/pid', String(process.pid)); console.log('CFG=' + process.env.CONFIG_DIR); await new Promise(() => setInterval(() => {}, 1000)); });\n`);
    const env = { ...process.env }; delete env.CONFIG_DIR; delete env.DVC_TEST_ISOLATED_CONFIG; delete env.NODE_TEST_CONTEXT;
    let out = '';
    try { out = execFileSync(process.execPath, ['--test', '--test-timeout=1500', '--import', PRELOAD, 'hang.test.mjs'], { cwd: tmp, env, encoding: 'utf8', timeout: 60_000 }); }
    catch (e) { out = String(e.stdout || ''); }
    const left = /CFG=(\S+)/.exec(out)?.[1];
    assert.ok(left, `자식이 설정 폴더를 알리지 않았다: ${out.slice(0, 400)}`);
    if (!fs.existsSync(left)) { t.skip('이 node 판은 시한 초과에도 exit 훅을 돌려 폴더가 남지 않는다(확인할 것 없음 — node 22.23 실측은 남는다)'); return; }
    const boxOf = path.dirname(left);   // 상자(<pid>-XXXXXX) 안의 cfg — 청소는 상자의 시각을 본다
    const old = (Date.now() - 20 * 60_000) / 1000; fs.utimesSync(boxOf, old, old);
    child({}, `console.log(JSON.stringify({ d: process.env.CONFIG_DIR }));`);
    assert.equal(fs.existsSync(boxOf), false, `죽은 자식이 남긴 상자(${boxOf})를 다음 실행이 지운다`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('⑤ 상위 폴더가 심링크면 따라가지 않는다 — 청소가 가리키는 곳의 하위를 지우지 않고, 예전처럼 /tmp 에 바로 만든다(2026-11-26 점검 2회차 재현)', () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-link-'));
  try {
    const victim = path.join(box, 'victim'); fs.mkdirSync(victim);
    const keep = fs.mkdtempSync(path.join(victim, '2019-'));   // 이름이 '<숫자>-' 꼴 · 오래됨 — 청소 대상처럼 보이는 남의 폴더
    const old = (Date.now() - 20 * 60_000) / 1000; fs.utimesSync(keep, old, old);
    const tmp = path.join(box, 'tmp'); fs.mkdirSync(tmp);
    fs.symlinkSync(victim, path.join(tmp, `dvc-test-cfg-${process.getuid()}`));
    const r = child({ TMPDIR: tmp }, `console.log(JSON.stringify({ d: process.env.CONFIG_DIR }));`);
    assert.equal(fs.existsSync(keep), true, '심링크를 따라가 남의 폴더를 지우면 안 된다');
    assert.ok(r.d.startsWith(path.join(tmp, 'dvc-test-cfg-')) && !r.d.startsWith(path.join(tmp, `dvc-test-cfg-${process.getuid()}`, '')), `예전처럼 /tmp 에 바로: ${r.d}`);
    assert.equal(fs.readdirSync(victim).length, 1, '가리키는 곳에 새 폴더를 만들지 않는다');
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('⑤ 상위 폴더를 다른 계정이 만들어 쓸 수 없어도 시험이 멈추지 않는다(예전처럼 /tmp 에 바로)', { skip: typeof process.getuid !== 'function' || process.getuid() !== 0 ? 'root 로 돌 때만(다른 계정으로 자식을 띄운다)' : false }, () => {
  // 다른 계정이 들어올 수 있는 곳에 — 이 프로세스의 os.tmpdir() 는 0700 상자 안이다(바꾸기 전 임시 폴더)
  const box = fs.mkdtempSync(path.join(process.env.DVC_TEST_ORIG_TMPDIR || os.tmpdir(), 'dvc-isolate-acct-'));
  try {
    fs.chmodSync(box, 0o777);
    const tmp = path.join(box, 'tmp'); fs.mkdirSync(tmp, { mode: 0o1777 }); fs.chmodSync(tmp, 0o1777);
    // root 가 먼저 만든 계정별 폴더는 다른 계정 이름이라 겹치지 않는다 — 같은 이름을 남이 만든 경우를 흉내 내려고 nobody 의 이름으로 root 가 만든다
    fs.mkdirSync(path.join(tmp, 'dvc-test-cfg-65534'), { mode: 0o755 });
    const env = { ...process.env, TMPDIR: tmp }; delete env.CONFIG_DIR; delete env.DVC_TEST_ISOLATED_CONFIG;
    const out = execFileSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', 'console.log(JSON.stringify({ d: process.env.CONFIG_DIR }))'],
      { env, encoding: 'utf8', timeout: 30_000, uid: 65534, gid: 65534 });
    const d = JSON.parse(out.trim().split('\n').pop()).d;
    assert.ok(d.startsWith(path.join(tmp, 'dvc-test-cfg-')) && !d.startsWith(path.join(tmp, 'dvc-test-cfg-65534', '')), `남의 폴더가 아니라 /tmp 에 바로: ${d}`);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('⑥ 웹 vitest 전역 준비도 같은 규칙 — 계정별 상위 폴더 · 정리 · 죽은 실행이 남긴 폴더는 다음 실행이 지운다(Ctrl-C · KILL 로 정리가 돌지 않던 것)', () => {
  const SETUP = path.resolve(SERVER, '../web/vitest.globalSetup.js');
  const ROOT = path.join(os.tmpdir(), `dvc-vitest-cfg-${process.getuid()}`);
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const dead = fs.mkdtempSync(path.join(ROOT, '2147483000-'));
  fs.writeFileSync(path.join(dead, 'auth-secret'), 'x');
  const old = (Date.now() - 20 * 60_000) / 1000; fs.utimesSync(dead, old, old);
  try {
    const env = { ...process.env }; delete env.CONFIG_DIR; delete env.DVC_TEST_ISOLATED_CONFIG;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(SETUP).href)}); const fs = await import('node:fs');
       const td = m.default(); const d = process.env.CONFIG_DIR; fs.writeFileSync(d + '/auth-secret', 'y'); const had = fs.existsSync(d); td();
       console.log(JSON.stringify({ d, had, gone: !fs.existsSync(d) }));`], { env, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').at(-1));
    assert.ok(r.d.startsWith(path.join(ROOT, '')), `계정별 상위 폴더 아래: ${r.d}`);
    assert.equal(r.had, true); assert.equal(r.gone, true, '정리(teardown)가 지운다');
    assert.equal(fs.existsSync(dead), false, '죽은 pid · 오래된 폴더는 다음 실행이 지운다');
    // CONFIG_DIR 이 이미 있으면 건드리지 않는다
    const keep = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(pathToFileURL(SETUP).href)}); console.log(String(m.default()) + '|' + process.env.CONFIG_DIR);`],
    { env: { ...env, CONFIG_DIR: '/nonexistent-keep' }, encoding: 'utf8' }).trim();
    assert.equal(keep, 'undefined|/nonexistent-keep');
  } finally { fs.rmSync(dead, { recursive: true, force: true }); }
});

/* ── ⑦ 기본 설정 폴더에 쓴 시험을 잡는다(2026-11-28) ─────────────────────────────────────────────────────────── */
// 실제 실행기로 돌린다: 임시 폴더에 격리 파일 셋(_isolateConfig · _tmpRoot · _stripComments)의 **사본**과 시험 파일을 두고 `node --test --import ./_isolateConfig.js`.
//   사본인 이유 — 선언은 시험 파일 **옆의** './_isolateConfig.js' 를 부르는 줄이다(미리 불러오기와 같은 모듈이어야 한 번만 평가된다).
const HELPERS = ['_isolateConfig.js', '_tmpRoot.js', '_stripComments.js'];
/** @returns {{status:number|null, out:string, left:string[]}} left = 끝난 뒤 임시 폴더에 남은 이름(사본 · 시험 파일 포함) */
function runGuard(files, { preload = true, env: extra = {}, runner = ['--test', '--test-reporter=spec'] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-guard-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }\n');
    for (const h of HELPERS) fs.copyFileSync(path.join(HERE, h), path.join(tmp, h));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(tmp, name), body);
    const env = { ...process.env, ...extra };
    for (const k of ['CONFIG_DIR', 'DVC_TEST_ISOLATED_CONFIG', 'NODE_TEST_CONTEXT']) if (!(k in extra)) delete env[k];
    const names = Object.keys(files).filter((n) => /\.test\.[cm]?js$/.test(n));
    const r = spawnSync(process.execPath, [...runner, ...(preload ? ['--import', './_isolateConfig.js'] : []), ...names],
      { cwd: tmp, env, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}`, left: fs.readdirSync(tmp).sort() };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const HEAD = `import { test } from 'node:test'; import fs from 'node:fs';\n`;
const DECL = `import './_isolateConfig.js';\n`;
const WRITE = `test('w', () => { fs.writeFileSync(process.env.CONFIG_DIR + '/x.json', '{}'); console.log('CFG=' + process.env.CONFIG_DIR); });\n`;
const FLAG = /\[시험 격리\] (\S+)/g;
const flagged = (out) => [...out.matchAll(FLAG)].map((m) => m[1]).sort();

test('⑦ 선언 없이 기본 설정 폴더에 쓴 시험 파일은 실패한다 — 안내문이 파일 · 남긴 것 · 고치는 법을 말하고, 같이 돈 다른 파일은 그대로 통과', () => {
  // 픽스처 확장자는 저장소 시험 파일 전부와 같은 `.test.js` 다 — `.mjs` 만 쓰면 시험 파일 판정을 `.mjs` 로 좁혀도(실제 파일 전부에서 검사가 꺼진다) 통과했다(반증 F1 — 재현).
  const r = runGuard({ 'w.test.js': HEAD + WRITE, 'c.test.js': `import { test } from 'node:test';\ntest('c', () => {});\n` });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(flagged(r.out), ['w.test.js'], r.out);
  assert.match(r.out, /남긴 것: x\.json/);
  assert.match(r.out, /import '\.\/_isolateConfig\.js';/, '고치는 법(넣을 줄)을 그대로 보여 준다');
  assert.match(r.out, /실제 server\/config 에 쓸 수 있다/);
  assert.match(r.out, /pass 2\b/, `시험 자체는 둘 다 통과했다: ${r.out}`);
  assert.match(r.out, /fail 1\b/, '실패는 쓴 파일 하나(파일 단위)');
});

test('⑦ 첫 import 로 선언한 파일은 써도 통과하고 상자는 지워진다 — 쓰지 않은 파일은 선언이 없어도 통과', () => {
  const r = runGuard({
    'd.test.mjs': DECL + HEAD + WRITE,
    // 폴더가 있는지 보고 · 읽고 · 이미 있는 폴더를 recursive 로 만드는 것은 쓰기가 아니다
    'n.test.mjs': HEAD + `test('n', () => { const d = process.env.CONFIG_DIR; fs.mkdirSync(d, { recursive: true }); fs.readdirSync(d); fs.existsSync(d + '/auth-secret'); });\n`,
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(flagged(r.out), []);
  const cfg = /CFG=(\S+)/.exec(r.out)?.[1];
  assert.ok(cfg, r.out);
  assert.equal(fs.existsSync(cfg), false, '끝나면 지워진다');
});

test('⑦ 쓰고 지운 것 · 종료 훅의 늦은 저장 · 물려받은 자식 프로세스의 쓰기 · 폴더째 지우기도 잡는다(남은 파일만 보면 놓친다)', () => {
  const r = runGuard({
    // hangClear2560 · storageAuthGuard2528 꼴: 남지 않아 폴더 검사로는 보이지 않지만, 직접 돌리면 개발 PC 의 실제 파일을 지운다
    'gone.test.mjs': HEAD + `test('g', () => { const f = process.env.CONFIG_DIR + '/gone.json'; fs.writeFileSync(f, '{}'); fs.rmSync(f); });\n`,
    // util/exitFlush.js 꼴: 디바운스 저장이 exit 훅에서 쓴다
    'late.test.mjs': HEAD + `test('l', () => { const d = process.env.CONFIG_DIR; process.once('exit', () => { fs.writeFileSync(d + '/late.json', '{}'); }); });\n`,
    // 시험이 띄운 node 가 물려받은 CONFIG_DIR 에 쓴다 — 주인은 시험 파일이다
    'kid.test.mjs': HEAD + `import { execFileSync } from 'node:child_process';
test('k', () => { execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.env.CONFIG_DIR + '/kid.json', '{}')"], { env: { ...process.env } }); });\n`,
    'rm.test.mjs': HEAD + `test('r', () => { fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }); });\n`,
    // 폴더 시각이 그대로여도(시각 표지를 못 쓰는 파일시스템 흉내 — 쓴 뒤 시각을 되돌린다) 남은 항목으로 잡는다
    'keep.test.mjs': HEAD + `test('m', () => { const d = process.env.CONFIG_DIR; fs.writeFileSync(d + '/keep.json', '{}'); fs.utimesSync(d, 1, 1); });\n`,
    // 폴더 자리에 파일을 둔다 — 읽기 실패가 '없음' 이 아니면 '지웠다' 고 단정하지 않고 사유를 그대로 말한다
    'unread.test.mjs': HEAD + `test('u', () => { const d = process.env.CONFIG_DIR; fs.rmSync(d, { recursive: true, force: true }); fs.writeFileSync(d, 'x'); });\n`,
  });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(flagged(r.out), ['gone.test.mjs', 'keep.test.mjs', 'kid.test.mjs', 'late.test.mjs', 'rm.test.mjs', 'unread.test.mjs'], r.out);
  assert.match(r.out, /unread\.test\.mjs — 기본 설정 폴더에 썼다\(기본 설정 폴더를 읽을 수 없게 바꿨다\(ENOTDIR\)\)/);
  assert.match(r.out, /keep\.test\.mjs — 기본 설정 폴더에 썼다\(남긴 것: keep\.json\)/);
  assert.match(r.out, /gone\.test\.mjs — 기본 설정 폴더에 썼다\(쓰고 지웠다\)/);
  assert.match(r.out, /late\.test\.mjs — 기본 설정 폴더에 썼다\(남긴 것: late\.json\)/);
  assert.match(r.out, /kid\.test\.mjs — 기본 설정 폴더에 썼다\(남긴 것: kid\.json\)/);
  assert.match(r.out, /rm\.test\.mjs — 기본 설정 폴더에 썼다\(기본 설정 폴더를 지웠다\)/);
});

test('⑦ 선언은 **첫 import** 여야 한다 — 뒤에 두거나 주석 안이면 선언이 아니다(안내문이 갈린다)', () => {
  const r = runGuard({
    'helper.mjs': 'export const x = 1;\n',
    'second.test.mjs': `import { x } from './helper.mjs';\n${DECL}${HEAD}${WRITE}void x;\n`,
    'comment.test.mjs': `// import './_isolateConfig.js';\n/* import './_isolateConfig.js'; */\n${HEAD}${WRITE}`,
    // `export … from` 도 모듈 요청이다 — 선언보다 앞이면 그쪽이 먼저 평가된다(반증 F5 — 직접 실행에서 실제 폴더에 썼다)
    'exportfrom.test.mjs': `export { x as _x } from './helper.mjs';\n${DECL}${HEAD}${WRITE}`,
    // 코드 안의 문자열(파일 이름)은 선언 줄이 아니다 — '있지만 첫 import 가 아니다' 로 잘못 안내하지 않는다(반증 F8)
    'string.test.mjs': `${HEAD}const PRE = './_isolateConfig.js'; void PRE;\n${WRITE}`,
  });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(flagged(r.out), ['comment.test.mjs', 'exportfrom.test.mjs', 'second.test.mjs', 'string.test.mjs'], r.out);
  const exportFrom = r.out.slice(r.out.indexOf('[시험 격리] exportfrom.test.mjs'));
  assert.match(exportFrom.slice(0, 600), /첫 import 가 아니다/);
  const str = r.out.slice(r.out.indexOf('[시험 격리] string.test.mjs'));
  assert.match(str.slice(0, 600), /고치는 법/);
  const second = r.out.slice(r.out.indexOf('[시험 격리] second.test.mjs'));
  assert.match(second.slice(0, 600), /첫 import 가 아니다/);
  const comment = r.out.slice(r.out.indexOf('[시험 격리] comment.test.mjs'));
  assert.match(comment.slice(0, 600), /고치는 법/);
});

test('⑦ 왜 첫 import 인가 — 미리 불러오기 없이 직접 돌릴 때: 첫 줄이면 기본 폴더(실제 설정 폴더 흉내)에 쓰지 않고, 뒤에 두면 쓴다', () => {
  // cfg.mjs 는 src/config.js 흉내 — 로드할 때 경로를 굳힌다(CONFIG_DIR 이 없으면 옆의 real-config).
  const cfg = `export const dir = process.env.CONFIG_DIR || new URL('./real-config', import.meta.url).pathname;\n`;
  const body = `test('w', () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/x.json', '{}'); console.log('CFG=' + dir); });\n`;
  const first = runGuard({ 'cfg.mjs': cfg, 'a.test.mjs': `${DECL}${HEAD}import { dir } from './cfg.mjs';\n${body}` }, { preload: false });
  assert.equal(first.status, 0, first.out);
  assert.ok(!first.left.includes('real-config'), `첫 import 로 선언하면 기본 폴더에 쓰지 않는다: ${first.left}`);
  const used = /CFG=(\S+)/.exec(first.out)?.[1];
  assert.ok(used && /dvc-test-cfg-/.test(used), first.out);
  assert.equal(fs.existsSync(used), false, '직접 돌려도 상자는 끝나면 지워진다');
  // 대조: 같은 파일에서 선언을 config 흉내 뒤에 두면 정적 import 순서대로 cfg.mjs 가 먼저 굳는다 → 기본 폴더에 쓴다(이 시험이 순서에 민감하다는 증거)
  const late = runGuard({ 'cfg.mjs': cfg, 'a.test.mjs': `${HEAD}import { dir } from './cfg.mjs';\n${DECL}${body}` }, { preload: false });
  assert.ok(late.left.includes('real-config'), `뒤에 두면 기본 폴더에 쓴다: ${late.left} · ${late.out.slice(0, 300)}`);
});

test('⑦ 실제 시험 파일 — 선언한 파일(src 를 정적 import 한다)을 미리 불러오기 없이 직접 돌려도 실제 설정 폴더(server/config)에 쓰지 않는다', () => {
  // 위 시험은 config.js 흉내로 순서를 본다 — 이것은 진짜 src/config.js · auth.js 로 본다. bareosInventory 는 src 를 정적 import 하고, 인증 모듈이 로드될 때 auth-secret 을 만든다
  //   (선언을 빼면 그 파일이 실제 server/config 에 생긴다 — 2026-11-28 수정 전 판본으로 A/B 확인).
  const REAL = path.join(SERVER, 'config');
  const names = () => (fs.existsSync(REAL) ? fs.readdirSync(REAL).sort() : []);
  const before = names();
  const env = { ...process.env };
  for (const k of ['CONFIG_DIR', 'DVC_TEST_ISOLATED_CONFIG', 'NODE_TEST_CONTEXT', 'AUTH_SECRET']) delete env[k];
  const r = spawnSync(process.execPath, ['--test', '--experimental-sqlite', '--test-reporter=spec', 'test/bareosInventory.test.js'], { cwd: SERVER, env, encoding: 'utf8', timeout: 100_000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(r.status, 0, out.slice(-800));
  const made = /AUTH_SECRET 미설정 — (\S+auth-secret) 에/.exec(out)?.[1];
  assert.ok(made, `auth-secret 을 만든 곳을 알리는 줄이 없다(실제 폴더에 이미 있어 읽기만 했다면 격리되지 않은 것이다): ${out.slice(0, 400)}`);
  assert.ok(!path.resolve(made).startsWith(REAL + path.sep), `실제 설정 폴더에 만들었다: ${made}`);
  assert.match(made, /dvc-test-cfg-[^/]+\/\d+-[^/]+\/cfg\/auth-secret$/, '격리 상자의 cfg 안');
  assert.equal(fs.existsSync(made), false, '상자는 끝나면 지워진다');
  assert.deepEqual(names(), before, '실제 설정 폴더에 새 파일이 생겼다');
});

test('⑦ 실행기 없이(node --import … x.test.js) 돌려도 잡는다 — 시험이 cwd 를 바꿔도 파일을 찾고, 이미 정한 종료 코드는 덮지 않는다', () => {
  const body = (extra) => `import fs from 'node:fs'; import os from 'node:os';\nprocess.chdir(os.tmpdir());\nfs.writeFileSync(process.env.CONFIG_DIR + '/x.json', '{}');\n${extra}`;
  const r = runGuard({ 'chdir.test.js': body('') }, { runner: [] });
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(flagged(r.out), ['chdir.test.js'], '상대 경로 인자 + cwd 변경에도 시험 파일을 읽어 판정한다');
  const kept = runGuard({ 'code.test.js': body('process.exitCode = 3;\n') }, { runner: [] });
  assert.equal(kept.status, 3, `시험이 정한 종료 코드를 덮지 않는다: ${kept.out}`);
  assert.deepEqual(flagged(kept.out), ['code.test.js']);
});

// 격리를 끄는 플래그는 node 22.8 부터다(engines 는 22.5 부터) — 받아 주는 판에서만 돈다.
const ISOLATION_NONE = spawnSync(process.execPath, ['--experimental-test-isolation=none', '-e', '0'], { encoding: 'utf8', timeout: 30_000 }).status === 0;
test('⑦ 시험 파일 여럿을 한 프로세스에서 돌리면(격리를 끈 실행) 탓하지 않는다 — 누가 썼는지 알 수 없다', { skip: !ISOLATION_NONE && '이 node 판에는 --experimental-test-isolation 이 없다' }, () => {
  // 예전 판은 argv 의 첫 시험 파일(쓰지 않은 aa)을 탓하고 종료 코드를 올렸다(반증 F8 — 재현). npm test 는 이 방식을 쓰지 않는다.
  const r = runGuard({ 'aa-clean.test.mjs': `import { test } from 'node:test';\ntest('c', () => {});\n`, 'zz-writer.test.mjs': HEAD + WRITE },
    { runner: ['--test', '--test-reporter=spec', '--experimental-test-isolation=none'] });
  assert.deepEqual(flagged(r.out), [], r.out);
  assert.equal(r.status, 0, r.out);
});

test('⑦ CONFIG_DIR 이 이미 있으면(현장 · CI · 상위 셸) 검사하지 않는다 — 그 폴더는 부른 쪽이 정한 것이다', () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-given-'));
  try {
    const r = runGuard({ 'w.test.mjs': HEAD + WRITE }, { env: { CONFIG_DIR: mine } });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(flagged(r.out), []);
    assert.equal(fs.existsSync(path.join(mine, 'x.json')), true, '정해 준 폴더에 쓴다');
  } finally { fs.rmSync(mine, { recursive: true, force: true }); }
});

test('⑦ declaresIsolation — 주석을 뺀 소스의 첫 모듈 요청(import · export … from)만 본다', async () => {
  const { declaresIsolation } = await import('./_isolateConfig.js');
  const yes = [
    `import './_isolateConfig.js';\nimport x from '../src/a.js';`,
    `import "./_isolateConfig.js"\nimport { test } from 'node:test';`,
    `/**\n * 머리말 — import 라는 낱말이 주석에 있어도 된다\n * import { a } from './b.js';\n */\nimport './_isolateConfig.js';   // 설명\nimport { test } from 'node:test';`,
    `// import { test } from 'node:test';\nimport './_isolateConfig.js' ;\n`,
    `/*\nimport x from 'y';\n*/\nimport './_isolateConfig.js';\nimport { test } from 'node:test';`,   // 블록 주석 안의 줄은 import 가 아니다
    `import './_isolateConfig.js';\r\nimport { test } from 'node:test';\r\n`,                                 // CRLF(Windows 체크아웃) — 줄 끝 \r 때문에 선언을 놓치지 않는다(반증 F3)
    `\uFEFFimport './_isolateConfig.js';\nimport { test } from 'node:test';`,                                   // BOM
    `import './_isolateConfig.js'; import { test } from 'node:test';`,                                           // 같은 줄의 다음 import — 순서는 그대로다
    `import'./_isolateConfig.js';\nimport fs from 'node:fs';`,
    `export const a = 1;\nimport './_isolateConfig.js';\nimport fs from 'node:fs';`,                             // from 없는 export 는 모듈 요청이 아니다
  ];
  const no = [
    '', 'const a = 1;',
    `import { test } from 'node:test';\nimport './_isolateConfig.js';`,
    `// import './_isolateConfig.js';\nimport { test } from 'node:test';`,
    `/* import './_isolateConfig.js'; */\nimport fs from 'node:fs';`,
    `/*\nimport './_isolateConfig.js';\n*/\nimport { test } from 'node:test';`,                             // 주석 안의 선언은 선언이 아니다
    `import {\n  test } from 'node:test';\nimport './_isolateConfig.js';`,
    `import './_isolateConfig.mjs';`, `import '../_isolateConfig.js';`, `import './x_isolateConfig.js';`,
    `import iso from './_isolateConfig.js';`,
    `export { x } from './cfg.js';\nimport './_isolateConfig.js';`,                                             // export … from 이 먼저 평가된다(반증 F5)
    `export * from './cfg.js';\r\nimport './_isolateConfig.js';\r\n`,
  ];
  for (const s of yes) assert.equal(declaresIsolation(s), true, JSON.stringify(s));
  for (const s of no) assert.equal(declaresIsolation(s), false, JSON.stringify(s));
  assert.equal(declaresIsolation(null), false); assert.equal(declaresIsolation(undefined), false);
});
