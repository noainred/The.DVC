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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  assert.ok(dir.startsWith(os.tmpdir()), dir);
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
    const old = (Date.now() - 20 * 60_000) / 1000; fs.utimesSync(left, old, old);
    child({}, `console.log(JSON.stringify({ d: process.env.CONFIG_DIR }));`);
    assert.equal(fs.existsSync(left), false, `죽은 자식이 남긴 폴더(${left})를 다음 실행이 지운다`);
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
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-isolate-acct-'));
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
