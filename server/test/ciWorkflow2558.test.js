/**
 * ciWorkflow2558.test.js — CI 중복 실행 제거 + macOS 잡 조건부화(v2.558).
 *
 * 왜 이 테스트가 있는가
 * ---------------------
 * 둘 다 **비용이 조용히 새는** 종류의 설정이라, 되돌려도 기능은 멀쩡해 보이고 아무도 모른다.
 *
 *  ① CI 중복: v2.557 까지 `on.push.branches: ['**']` 이라 기능 브랜치에 push 하면 push 이벤트와
 *     pull_request 이벤트가 **같은 커밋에 두 번** 돌았다(실측 run #1210·#1211, 둘 다 sha 7716ede).
 *     concurrency 로는 못 막는다 — ref 가 달라 그룹이 갈린다.
 *  ② macOS 잡: macos-latest 는 분 차감 배수가 ×10 이라 46초 잡이 **10분**을 먹는데(실측 run #608),
 *     `uagmon/` 은 2026-08-24(PR #336) 이후 295 커밋 동안 한 번도 바뀌지 않았다.
 *
 * ⚠ 가장 중요한 검사는 **마커 파일명에 버전이 없다**는 것이다(`prune-assets.mjs` 를 실제로 돌려
 *   확인한다). 마커에 x.y.z 가 들어가면 prune 이 15 릴리스 뒤 지워버리고, 그러면 macOS 잡이
 *   매 릴리스마다 다시 돌아 이 변경이 통째로 무효가 된다 — 그런데 **아무 오류도 나지 않는다.**
 *
 * ⚠ 검사 전에 주석을 지운다 — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다(v2.535 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/** 전체 줄 주석(`# …`)만 제거한다 — 규칙은 전부 실제 YAML 키로 표현돼 있다. */
const stripComments = (yaml) => yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

const CI = stripComments(read('.github/workflows/ci.yml'));
const REL = stripComments(read('.github/workflows/release.yml'));

/* ------------------------------- ① CI 중복 ------------------------------- */

test("ci.yml 의 push 트리거는 main 만이다 (같은 커밋 2회 실행 방지)", () => {
  const push = CI.match(/\n {2}push:\n((?: {4}.*\n)+)/)?.[1] || '';
  assert.ok(push, 'ci.yml 에 push 트리거가 있어야 한다');
  assert.match(push, /branches:\s*\[\s*main\s*\]/,
    "push.branches 가 [main] 이 아니면 기능 브랜치 push 와 pull_request 가 같은 커밋을 두 번 돌린다");
  assert.doesNotMatch(push, /branches:\s*\[\s*'\*\*'\s*\]/, "'**' 로 되돌리면 중복이 재발한다");
});

test('ci.yml 은 pull_request 에서 계속 돈다 (검증 공백이 생기면 안 된다)', () => {
  // push 를 main 으로 좁힌 대가로 기능 브랜치 검증은 전적으로 이 트리거가 맡는다.
  assert.match(CI, /\n {2}pull_request:/, 'pull_request 트리거가 사라지면 PR 이 검사되지 않는다');
  assert.match(CI, /\n {2}workflow_dispatch:/, '수동 실행 경로(PR 없는 브랜치용)를 남겨 둔다');
});

/* ---------------------------- ② macOS 조건부 ---------------------------- */

test('macOS 잡은 판정 결과에 걸려 있다 (무조건 실행으로 되돌리지 말 것)', () => {
  const job = REL.match(/\n {2}uagmon-macos-app:\n((?: {4}.*\n)+)/)?.[1] || '';
  assert.ok(job, 'release.yml 에 uagmon-macos-app 잡이 있어야 한다');
  assert.match(job, /runs-on:\s*macos-latest/, '이 잡이 ×10 배수의 macOS 러너라는 전제');
  assert.match(job, /if:\s*needs\.build-and-publish\.outputs\.macos_build == 'true'/,
    "if 가 없으면 매 릴리스마다 10분이 차감된다");
});

test('판정 결과가 잡 출력으로 실제로 전달된다', () => {
  const outs = REL.match(/\n {4}outputs:\n((?: {6}.*\n)+)/)?.[1] || '';
  assert.match(outs, /macos_build:\s*\$\{\{ steps\.macos\.outputs\.build \}\}/);
  assert.match(outs, /uagmon_hash:\s*\$\{\{ steps\.macos\.outputs\.hash \}\}/);
  assert.match(REL, /\n\s+id: macos\n/, '판정 스텝의 id 가 macos 여야 출력이 연결된다');
});

test('되살리는 경로(build_macos 수동 입력)가 있다', () => {
  // prune 이 macOS 자산을 지운 뒤 사용자가 코드 수정 없이 복구할 수 있는 유일한 길이다.
  assert.match(REL, /workflow_dispatch:\n\s+inputs:\n\s+build_macos:/);
  assert.match(REL, /FORCE:\s*\$\{\{ inputs\.build_macos \|\| 'false' \}\}/,
    '태그 push 에서는 inputs 가 비므로 기본값 false 로 접혀야 한다');
});

test('마커는 mac 자산 업로드가 성공한 뒤에 기록한다', () => {
  // 먼저 기록하면 업로드가 실패한 릴리스도 '빌드했다'로 남아 다음 릴리스가 건너뛴다.
  const upload = REL.indexOf('gh release upload "$RELEASE_TAG" dist-mac/*');
  const marker = REL.indexOf('gh release upload "$RELEASE_TAG" "$UAGMON_MARKER"');
  assert.ok(upload > 0 && marker > 0, '두 업로드 스텝이 모두 있어야 한다');
  assert.ok(marker > upload, '마커 기록이 mac 자산 업로드보다 뒤여야 한다');
});

/* ------- ★ 핵심: 마커가 prune 에서 살아남는가 (실제로 돌려서 확인한다) ------- */

test('마커 파일명에 버전이 없다 — prune 이 지우면 이 변경이 통째로 무효가 된다', () => {
  const name = REL.match(/UAGMON_MARKER:\s*(\S+)/)?.[1];
  assert.ok(name, 'UAGMON_MARKER 가 정의돼 있어야 한다');
  assert.doesNotMatch(name, /\d+\.\d+\.\d+/,
    `마커 이름(${name})에 x.y.z 가 들어가면 prune-assets.mjs 가 15 릴리스 뒤 삭제한다`);

  // 문자열 검사로 끝내지 않고 prune 을 실제로 실행한다.
  const versions = JSON.stringify({ versions: [{ version: '9.9.9' }] });
  const vfile = join(ROOT, 'server', 'tmp', `prune-${process.pid}.json`);
  execFileSync('mkdir', ['-p', dirname(vfile)]);
  execFileSync('bash', ['-c', `cat > ${JSON.stringify(vfile)}`], { input: versions });

  const assets = [
    name,                                       // 마커 — 유지돼야 한다
    'versions.json',                            // 유지
    'uag-monitor-app-1.2.3-macos-arm64.tar.gz', // 유지 목록에 없는 버전 → 삭제 대상
    'vmware-portal-9.9.9.tar.gz',               // 유지
  ].join('\n');

  const out = execFileSync('node', [join(ROOT, 'packaging/release/prune-assets.mjs'), vfile], {
    input: assets, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
  }).split('\n').filter(Boolean);

  assert.ok(!out.includes(name), `prune 이 마커(${name})를 삭제 대상으로 골랐다: ${out.join(', ')}`);
  assert.ok(!out.includes('versions.json'));
  assert.ok(out.includes('uag-monitor-app-1.2.3-macos-arm64.tar.gz'),
    'prune 이 실제로 동작하는지(오래된 버전을 고르는지) 함께 확인한다 — 아무것도 안 고르면 위 단언이 무의미하다');
  execFileSync('rm', ['-f', vfile]);
});

test('사라질 수 있다는 사실을 문서가 말한다', () => {
  // 조용히 사라지면 사용자는 '앱이 없어졌다' 만 알고 되살리는 법을 모른다.
  const doc = read('uagmon/README.md');
  assert.match(doc, /build_macos/, 'README 가 복구 방법을 적어야 한다');
  assert.match(doc, /prune/i, 'README 가 자산이 정리될 수 있다는 사실을 적어야 한다');
});
