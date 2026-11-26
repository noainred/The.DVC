/**
 * 2026-11-26 — 전량 시험이 실제 설정 폴더(`server/config`)에 시험 데이터를 남기지 않는다(재발 방지 고정).
 *
 * 배경: 전량 실행 뒤 `server/config` 에 시험 데이터 12종(auth-secret · datacenters.json · ping-monitor.db …)이 남았고, 같은 체크아웃의
 *   다음 실행이 그것을 읽었다(v3.41.1 arch2582 BUG-2 는 그래서 두 번째 실행부터 실패했다). 원인은 CONFIG_DIR 을 잡지 않은 채
 *   프로젝트 모듈을 부른 시험들 — 설정이 기본 폴더로 풀린다. 귀속은 fs · node:sqlite 쓰기를 가로채는 preload 로 전량을 돌려 했다.
 *
 * 고정하는 것:
 *  ① `npm test` 가 preload(test/_isolateConfigDir.js)를 건다 — 시험 파일마다 새 임시 설정 폴더(이미 CONFIG_DIR 이 있으면 그대로).
 *  ② preload 동작(실제로 node --test 를 띄워 본다): 파일마다 서로 다른 폴더 · os.tmpdir 아래 · 끝나면 지운다 · 밖(셸 · CI)에서 준
 *     CONFIG_DIR 은 시험 파일에서 쓰지 않고 건드리지도 않는다(시험이 스스로 잡은 값은 이긴다) · 시험 파일이 아닌 프로세스는 물려받은 값 ·
 *     시험 사이 최상위 await 동안에도 폴더가 남아 있다(루트 after 가 먼저 돌아도) · 모듈이 먼저 건 exit 훅(종료 flush)이 쓴 뒤에 지운다.
 *  ③ 이번에 고친 시험 파일은 프로젝트 모듈을 부르기 전에 CONFIG_DIR 을 임시 폴더로 잡는다 — preload 가 없는 직접 실행
 *     (`node --test test/x.test.js`)에서도 `server/config` 에 쓰지 않게.
 * ⚠ 소스 검사는 주석을 먼저 제거한다(test/_stripComments.js).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const PRELOAD = path.join(HERE, '_isolateConfigDir.js');

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

// 이번 회차에 고친 파일(목록 고정 — 파일을 지우거나 이름을 바꾸면 여기서도 고칠 것).
//   괄호 안은 그 파일이 실제 `server/config` 에 쓰던 것(2026-11-26 실측 — 추적 preload 전량 실행 + 파일별 단독 실행).
const FIXED = `
arch2583.test.js
bmUsage2550.test.js
datacenterStore.test.js
edgeLog2549.test.js
fleetStores.test.js
gpuGuestIpOverride.test.js
hangClear2560.test.js
hwExport2967.test.js
pingMonitor.test.js
rebut71.test.js
roomTempCycle2634.test.js
storageAuthGuard2528.test.js
`.split(/\s+/).filter(Boolean);
// arch2583(auth-secret) · bmUsage2550(auth-secret · bm-usage.db) · datacenterStore(datacenters.json) · edgeLog2549(auth-secret · vcenter-logs.db) ·
// fleetStores(fleet-assign.json · fleet-tags.json) · gpuGuestIpOverride(gpu-guest.json — 정적 import 가 대입보다 먼저 돌았다) ·
// hangClear2560(perf-hangs.ndjson 을 쓰고 지움) · hwExport2967(auth-secret · audit.ndjson · idrac-power.db) · pingMonitor(ping-targets.json · ping-monitor.db) ·
// rebut71(vcenter-logs.db) · roomTempCycle2634(part-faults.db · vcenter-logs.db) · storageAuthGuard2528(storage-auth-stops.json 을 쓰고 지움).

test('① npm test 스크립트가 설정 폴더 격리 preload 를 건다', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
  const s = String(pkg.scripts?.test || '');
  assert.match(s, /^node --test /, 'node --test 로 돈다');
  assert.match(s, /\s--import \.\/test\/_isolateConfigDir\.js\s/, `preload 가 빠졌다: ${s}`);
  assert.match(s, /\stest\/\*\.test\.js$/, '시험 글롭은 그대로');
  assert.ok(fs.existsSync(PRELOAD));
});

/** 작은 시험 파일들을 preload 를 건 node --test 로 돌린다. 각 시험은 자기 CONFIG_DIR 을 RESULT 파일에 한 줄씩 적는다. */
function runWithPreload(files, envExtra = {}) {
  const dir = tmpDir('cfgiso-run-');
  const result = path.join(dir, 'result.txt');
  const paths = Object.entries(files).map(([name, src]) => { const p = path.join(dir, name); fs.writeFileSync(p, src); return p; });
  const env = { ...process.env, CFGISO_RESULT: result, ...envExtra };
  if (!('CONFIG_DIR' in envExtra)) delete env.CONFIG_DIR;
  delete env.NODE_TEST_CONTEXT;   // 이 시험 자신이 러너의 자식이다 — 표식을 물려주면 안쪽 러너가 다르게 돈다
  const r = spawnSync(process.execPath, ['--test', '--import', PRELOAD, '--test-reporter=tap', ...paths], { env, cwd: dir, encoding: 'utf8', timeout: 60_000 });
  const lines = fs.existsSync(result) ? fs.readFileSync(result, 'utf8').split('\n').filter(Boolean) : [];
  return { r, lines };
}

const NOTE = `import fs from 'node:fs';
const note = (tag) => fs.appendFileSync(process.env.CFGISO_RESULT, tag + '\\t' + process.env.CONFIG_DIR + '\\n');`;

test('② preload — 시험 파일마다 서로 다른 임시 폴더 · os.tmpdir 아래(server 밖) · 끝나면 지운다', () => {
  const body = (tag) => `import { test } from 'node:test';\n${NOTE}\ntest('t', () => { fs.writeFileSync(process.env.CONFIG_DIR + '/probe.json', '{}'); note('${tag}'); });\n`;
  const { r, lines } = runWithPreload({ 'a.test.mjs': body('a'), 'b.test.mjs': body('b') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(lines.length, 2, lines.join('\n'));
  const dirs = lines.map((l) => l.split('\t')[1]);
  assert.notEqual(dirs[0], dirs[1], '파일마다 따로');
  for (const d of dirs) {
    assert.ok(d.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) || d.startsWith(os.tmpdir() + path.sep), `임시 폴더 아래가 아니다: ${d}`);
    assert.ok(!d.startsWith(SERVER + path.sep), `server 아래다: ${d}`);
    assert.equal(fs.existsSync(d), false, `끝난 뒤에도 남았다: ${d}`);
  }
});

test('② preload — 밖(셸 · CI)에서 준 CONFIG_DIR 은 시험 파일에서 쓰지 않고(바꾼다) 건드리지도 않는다 · 시험이 스스로 잡은 값은 이긴다', () => {
  // 개발 PC 셸에 실제 설치본 설정 폴더가 export 돼 있어도 전량 시험이 거기에 쓰지 않아야 한다.
  const given = tmpDir('cfgiso-given-');
  fs.writeFileSync(path.join(given, 'keep.json'), '{"real":true}');
  const own = path.join(tmpDir('cfgiso-own-'), 'cfg');
  const { r, lines } = runWithPreload({
    'c.test.mjs': `import { test } from 'node:test';\n${NOTE}\ntest('t', () => { fs.writeFileSync(process.env.CONFIG_DIR + '/probe.json', '{}'); note('c'); });\n`,
    'e.test.mjs': `import { test } from 'node:test';\n${NOTE}\nprocess.env.CONFIG_DIR = ${JSON.stringify(own)};\ntest('t', () => note('e'));\n`,
  }, { CONFIG_DIR: given });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const by = Object.fromEntries(lines.map((l) => l.split('\t')));
  assert.notEqual(by.c, given, '밖에서 준 폴더를 시험이 그대로 썼다');
  assert.equal(by.e, own, '시험이 스스로 잡은 폴더가 이겨야 한다');
  assert.deepEqual(fs.readdirSync(given), ['keep.json'], '밖에서 준 폴더에 쓰거나 지웠다');
});

test('② preload — 시험 파일이 아닌 프로세스(execArgv 를 물려받은 fork 등)는 물려받은 CONFIG_DIR 을 그대로 쓴다', () => {
  const given = tmpDir('cfgiso-fork-');
  const env = { ...process.env, CONFIG_DIR: given };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '-e', 'process.stdout.write(process.env.CONFIG_DIR)'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, given);
  assert.ok(fs.existsSync(given), '물려받은 폴더를 지웠다');
});

test('② preload — 시험 사이 최상위 await 동안에도 폴더가 남아 있고, 먼저 걸린 exit 훅(종료 flush)이 쓴 뒤에 지운다', () => {
  // 최상위 await 동안 node 22 는 루트 after 를 먼저 돌린다(tmpCleanup3188 ③) — preload 가 after 에서 바로 지우면 뒤 시험이 깨진다.
  // 모듈 로드 때 걸린 exit 훅(util/exitFlush.js 꼴)은 preload 의 정리보다 먼저 돌아야 폴더를 다시 만들지 않는다.
  const src = `import { test } from 'node:test';\n${NOTE}
process.once('exit', () => { fs.mkdirSync(process.env.CONFIG_DIR + '/late', { recursive: true }); fs.writeFileSync(process.env.CONFIG_DIR + '/late/flush.json', '{}'); });
test('앞', () => note('front'));
await new Promise((r) => setTimeout(r, 300));
test('뒤', () => { fs.writeFileSync(process.env.CONFIG_DIR + '/after-await.json', '{}'); note('back'); });
`;
  const { r, lines } = runWithPreload({ 'd.test.mjs': src });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(lines.map((l) => l.split('\t')[0]), ['front', 'back'], lines.join('\n'));
  const d = lines[0].split('\t')[1];
  assert.equal(lines[1].split('\t')[1], d);
  assert.equal(fs.existsSync(d), false, `늦은 exit 쓰기 뒤에 지우지 못했다: ${d}`);
});

test('③ 고친 파일은 프로젝트 모듈을 부르기 전에 CONFIG_DIR 을 임시 폴더로 잡는다', () => {
  const bad = [];
  for (const f of FIXED) {
    const s = stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));
    const set = s.search(/^process\.env\.CONFIG_DIR = (?!process\.env\.CONFIG_DIR)/m);
    const firstSrc = s.search(/from '\.\.\/src\/|import\(\s*['`]\.\.\/src\/|import\(\s*f\)|import\(\s*path\.|import\(\s*pathToFileURL/);
    if (set < 0) { bad.push(`${f}(CONFIG_DIR 을 최상위에서 잡지 않는다)`); continue; }
    if (/^(?:import [^\n]*|\} )from '\.\.\/src\//m.test(s)) { bad.push(`${f}(src 정적 import — 호이스팅돼 CONFIG_DIR 보다 먼저 돈다)`); continue; }
    if (firstSrc >= 0 && firstSrc < set) bad.push(`${f}(src import 가 ${firstSrc} < CONFIG_DIR ${set})`);
    if (!/^(?:test\.)?after\(\(\) => \{ rmTmpDirs\(\);/m.test(s)) bad.push(`${f}(임시 폴더를 after 에서 지우지 않는다 — tmpCleanup3188 꼴)`);
  }
  assert.deepEqual(bad, [], bad.join(', '));
});
