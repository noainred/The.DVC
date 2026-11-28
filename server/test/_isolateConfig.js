/**
 * test/_isolateConfig.js — 서버 시험의 기본 설정 폴더를 **파일마다 임시 폴더**로(2026-11-26 · 미리 불러오기 `--import` · 시험 전용이라 릴리스 없음).
 *
 * 왜: `CONFIG_DIR` 을 잡지 않은 시험은 실제 설정 폴더 `server/config/`(config.js 기본값)에 시험 데이터를 남겼다 — 전량 실행 뒤
 *   audit.ndjson · auth-secret · bm-usage.db · datacenters.json · fleet-*.json · gpu-guest.json · idrac-power.db · part-faults.db ·
 *   ping-*.db/json · vcenter-logs.db 가 생겼다(2026-11-26 실측). 그 폴더는 gitignore 대상이라 눈에 띄지 않고, 같은 체크아웃에서 다시 돌리면
 *   앞 실행의 잔여 파일을 읽는다 — arch2582 BUG-2 가 그렇게 **두 번째 실행부터** 실패했다(v3.41.1). CI 는 새 체크아웃이라 드러나지 않는다.
 *
 * 어떻게: `npm test`(= package.json `node --test --import ./test/_isolateConfig.js …`)에서 node 시험 실행기는 **시험 파일마다 자식 프로세스**를
 *   띄우고 이 파일을 그 자식마다 먼저 불러온다(실측 — 부모가 아니라 자식 프로세스 번호로 돈다). 그래서 파일마다 빈 임시 설정 폴더를 받는다
 *   (파일끼리 설정을 나눠 쓰지 않는다 — 예전에는 병렬로 도는 파일들이 같은 폴더를 썼다).
 *   · `CONFIG_DIR` 이 이미 있으면(현장이나 CI 가 정했거나, 상위 셸에서 지정) 건드리지 않는다.
 *   · 시험 파일이 스스로 `CONFIG_DIR` 을 다시 잡는 것은 그대로 된다(이 파일은 그보다 먼저 돈다 — 기본값만 바꾼다).
 *   · 자식 프로세스를 `{ ...process.env }` 로 띄우는 시험은 같은 임시 폴더를 물려준다. env 를 통째로 새로 짜서 넘기는 시험은 이 보호 밖이다.
 *   · 프로세스가 끝날 때 지운다(exit 훅 — 시험이 만든 하위 파일까지 · 다른 exit 훅보다 **뒤에**). 지우지 못해도 시험 결과는 바꾸지 않는다.
 *   · 임시 폴더(`TMPDIR`)도 같은 상자 안으로 돌린다 — 상자 `<pid>-XXXXXX` 안에 `cfg`(CONFIG_DIR) · `tmp`(TMPDIR). 시험이 os.tmpdir() 에 만든 폴더가 /tmp 에
 *     남던 것(전량 한 번에 약 50개 — 2026-11-26 실측)을 파일마다 고치지 않고 상자째 지운다. 바꾸기 전 임시 폴더는 `DVC_TEST_ORIG_TMPDIR`(다른 계정으로 도는 시험용 — 상자는 0700).
 *   · 시험 실행기가 자식을 **죽이면**(파일 시한 초과 · Ctrl-C) exit 훅이 돌지 않아 폴더가 남는다 — 그래서 상자를 `<tmp>/dvc-test-cfg-<uid>/<pid>-XXXXXX` 에 만들고,
 *     다음에 이 파일이 불릴 때 **프로세스가 없고(pid 확인) 10분 넘게 손대지 않은** 폴더를 지운다(같은 상위 폴더만 읽는다 — /tmp 전체를 훑지 않는다).
 *     상위 폴더는 계정마다 · 0700 · 심링크가 아닌 내 폴더일 때만 쓴다(아니면 예전처럼 /tmp 에 바로 — 청소 없음).
 *   · 남는 틈: exit 리스너를 붙인 같은 동기 틱 안에서 process.exit 를 부르면 정리를 뒤로 옮기기 전에 끝나 폴더가 남는다(실제 코드에서 그런 경로는 찾지 못했다 —
 *     남으면 위 청소가 다음 실행에서 지운다).
 *   · vCenter 예제 템플릿 폴백은 `config.js` 가 설정 폴더가 아니라 **저장소의 config 폴더**에서 읽으므로 영향이 없다.
 *
 * ⚠ 시험 파일 하나만 직접 돌릴 때(`node --test test/x.test.js`)는 미리 불러오기가 붙지 않는다 — 그래서 **기본 설정 폴더에 쓰는 시험 파일은 이 파일을
 *   첫 import 로 스스로 부른다**(2026-11-28): `import './_isolateConfig.js';`. 정적 import 는 적힌 순서대로 평가되므로 첫 줄에 두면 그 파일의 `../src/` import
 *   (정적 · 동적 모두)보다 먼저 CONFIG_DIR 이 잡힌다. `npm test` 에서는 이미 불려 있어 아무 일도 하지 않는다(같은 모듈 — 한 번만 평가된다).
 *
 * 자동 검사(2026-11-28 — 아래 `checkDefaultConfigWrites`): 이 파일이 준 기본 설정 폴더(상자의 cfg)에 시험이 **썼는데** 그 시험 파일의 첫 import 가 이 파일이 아니면,
 *   안내문을 내고 **그 시험 파일을 실패**시킨다(종료 코드 1 — 시험이 다 통과해도 파일 단위 실패).
 *   잡는 것: 남긴 항목 · 쓰고 지운 것(폴더를 만들자마자 mtime 을 옛날로 돌려 두고 끝날 때 본다 — 항목이 생기거나 없어지면 '지금' 으로 바뀐다) · 종료 훅의 늦은 저장 ·
 *     CONFIG_DIR 을 물려받은 자식 프로세스 · 워커 스레드의 쓰기 · 폴더째 지우기 · 폴더를 읽을 수 없게 바꾸기.
 *   왜 실패까지: 2026-11-26 에는 '실제 폴더에 누가 썼나' 를 한 번 훑어 12개를 고쳤는데, 같은 파일(auth-secret)은 **먼저 쓴 시험만** 보여 나머지가 가려졌다 —
 *     파일마다 빈 상자를 주고 다시 훑으니 57개였다(그중 47개는 직접 돌리면 실제 `server/config` 에 `auth-secret` 을 남긴다 — 하나씩 A/B). 사람이 훑는 대신 전량 실행이 매번 본다.
 *   걸리지 않는 꼴: 프로젝트 모듈을 부르기 전에 **무조건 대입**(`process.env.CONFIG_DIR = <임시>`)으로 스스로 잡는 시험(configDirPerFile.test.js 의 12개 꼴 — 기본 폴더에 쓰지 않는다).
 *   걸리는 꼴: `process.env.CONFIG_DIR = process.env.CONFIG_DIR || <임시>` 로 **물려받는** 시험 — 미리 불러오기가 준 폴더를 그대로 쓴다. 직접 돌리면 자기 임시 폴더를 쓰지만
 *     상위 셸의 CONFIG_DIR(실제 설치본 폴더)도 그대로 물려받는 꼴이다. 선언 한 줄을 둔다(57개 중 10개가 이 꼴).
 *   · CONFIG_DIR 이 이미 있으면(현장 · CI · 상위 셸) 상자를 만들지 않으므로 검사도 없다. · 시험 파일이 아닌 프로세스(시험이 띄운 보조 스크립트)는 보지 않는다 —
 *     그 프로세스가 물려받은 상자에 쓴 것은 상자 주인(시험 파일)의 종료 때 잡힌다. · 시험 파일 여럿을 한 프로세스에서 돌리면(시험 격리를 끈 실행) 누가 썼는지 알 수 없어 검사하지 않는다.
 *   못 잡는 것(반증 2026-11-28 — 재현): ① **지우기만** 하거나 '있으면 고쳐 쓰는' 시험 — 빈 상자에는 지울 것 · 고칠 것이 없다(직접 돌리면 실제 폴더의 파일을 건드린다)
 *     ② exit 리스너가 `process.exit()` 를 부르거나 던지면 그 뒤의 리스너(이 검사 · 정리)가 돌지 않는다 ③ 분리된(detached) 자식이 시험 종료 **뒤에** 쓰는 것
 *     ④ 정적 import 가 하나도 없는 파일의 템플릿 문자열 안에 줄 머리로 적힌 선언(문자열은 지우지 않는다). 지금 시험에서 ① ~ ④ 꼴은 찾지 못했다.
 *   ⚠ 시간에 달린 쓰기: 종료 저장 없이 unref 타이머로만 저장하는 모듈은 시험 프로세스가 그 지연보다 오래 살았을 때만 쓴다 — 그러면 이 검사가 **가끔만** 실패한다(느린 러너).
 *     그 실패도 사실이다(직접 돌려 오래 살면 실제 폴더에 쓴다) — 안내문대로 선언 한 줄을 넣는다. 2026-11-28 에 종료 직전 대기 중인 unref 타이머를 불러 주는 preload 로 전량을 훑어
 *     `centralFleet.test.js` 하나를 찾아 선언을 넣었다(`central/fleet.js` 의 5초 저장 타이머 — docs/rules/common.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOwnTmpDir } from './_tmpRoot.js';
import { stripComments } from './_stripComments.js';

/**
 * 시험 파일이 기본 설정 폴더 격리를 **스스로 선언**했는가 — 주석을 뺀 소스의 **첫 모듈 요청**이 `import './_isolateConfig.js'` 인가.
 * '첫' 이어야 하는 이유: 정적 import · `export … from` 은 적힌 순서대로 평가된다 — 앞에 다른 프로젝트 모듈이 있으면 그쪽이 config.js 를 실제 폴더로 먼저 굳힌다.
 * 줄 끝은 보지 않는다(CRLF · 같은 줄의 다음 import — 순서는 그대로다). 맨 앞 BOM 은 뗀다.
 */
const MODULE_REQUEST = /^[ \t]*(?:import\b|export\b[^\n]*\bfrom\s*['"])[^\n]*/m;
const DECLARATION = /^[ \t]*import\s*(['"])\.\/_isolateConfig\.js\1/;
export function declaresIsolation(source) {
  const s = stripComments(String(source ?? '').replace(/^\uFEFF/, ''));
  const first = MODULE_REQUEST.exec(s);
  return !!first && DECLARATION.test(first[0]);
}
/** 선언 줄이 있기는 한가(첫 모듈 요청이 아니어도) — 안내문을 가른다. 문자열 안의 파일 이름은 선언이 아니다. */
const mentionsDeclaration = (source) => new RegExp(DECLARATION.source, 'm').test(stripComments(String(source ?? '').replace(/^\uFEFF/, '')));

/**
 * 이 프로세스가 돌리는 시험 파일(절대 경로 — node 가 스크립트 인자를 절대 경로로 주지만, 시험이 cwd 를 바꿔도 읽히게 여기서도 굳힌다). 없으면 ''(시험이 띄운 보조 스크립트 · -e).
 * 여럿이면 ''(시험 격리를 끈 실행 — 한 프로세스에서 여러 파일이 돌아 누가 썼는지 알 수 없다. 첫 파일을 탓하지 않는다).
 */
const TEST_FILE = (() => {
  const fs_ = process.argv.slice(1).filter((a) => /\.test\.[cm]?js$/.test(String(a)));
  try { return fs_.length === 1 ? path.resolve(String(fs_[0])) : ''; } catch { return ''; }
})();
/** 기본 설정 폴더를 만든 직후 돌려 두는 시각(초). 그 안에 항목이 생기거나 지워지면 폴더 mtime 이 '지금' 으로 바뀐다 — 쓰고 지운 것도 남는다. */
const UNTOUCHED_S = 1;

// 상위 폴더 · 청소 규칙은 `_tmpRoot.js` 하나(웹 vitest.globalSetup.js 와 같이 쓴다) — 계정마다 · 0700 · 심링크가 아닌 내 폴더일 때만 청소(2회차 재현 두 건).
if (!process.env.CONFIG_DIR) {
  // 한 프로세스 = 한 상자(`<pid>-XXXXXX`) — 안에 설정 폴더(cfg)와 임시 폴더(tmp). 임시 폴더도 돌리는 이유(2026-11-26 점검 — 실측): 시험 파일들이 os.tmpdir() 에
  //   스스로 만든 폴더가 전량 한 번에 약 50개 /tmp 에 남았다(after() 를 안 두거나, 지운 뒤 종료 저장이 다시 만들거나). TMPDIR 을 상자 안으로 돌리면 os.tmpdir() ·
  //   mktemp 를 쓰는 시험과 그 자식 프로세스의 폴더가 모두 상자째 지워진다(파일마다 고치지 않는다).
  const origTmp = os.tmpdir();
  const box = makeOwnTmpDir('dvc-test-cfg');
  const dir = path.join(box, 'cfg'); const tmp = path.join(box, 'tmp');
  fs.mkdirSync(dir, { mode: 0o700 }); fs.mkdirSync(tmp, { mode: 0o700 });
  let marked = false;
  try { fs.utimesSync(dir, UNTOUCHED_S, UNTOUCHED_S); marked = fs.statSync(dir).mtimeMs === UNTOUCHED_S * 1000; } catch { /* 시각을 못 돌리는 파일시스템 — 남은 항목만 본다 */ }
  process.env.CONFIG_DIR = dir;
  process.env.DVC_TEST_ISOLATED_CONFIG = dir;   // 시험이 '격리 중인가' 를 확인할 때 쓴다(isolateConfig.test.js)
  if (!process.env.DVC_TEST_ORIG_TMPDIR) process.env.DVC_TEST_ORIG_TMPDIR = origTmp;   // 바꾸기 전 임시 폴더 — 다른 계정으로 도는 시험용(상자는 0700 이라 남이 못 들어온다)
  process.env.TMPDIR = tmp;
  /**
   * 기본 설정 폴더에 쓴 시험을 잡는다(머리말 '자동 검사'). 정리 직전 = 마지막 exit 리스너에서 본다 — 종료 flush 가 늦게 쓴 것까지.
   * 판정을 지어내지 않는다: 시험 파일을 못 읽으면 아무것도 하지 않는다.
   */
  const checkDefaultConfigWrites = () => {
    if (!TEST_FILE) return;
    // 폴더를 못 읽으면: 없어졌으면 지운 것 · 그 밖(EACCES · ENOTDIR …)은 읽을 수 없게 바꾼 것 — 만들 때는 내 0700 폴더였다.
    const lost = (e) => (e?.code === 'ENOENT' ? '기본 설정 폴더를 지웠다' : `기본 설정 폴더를 읽을 수 없게 바꿨다(${String(e?.code || '읽기 오류')})`);
    let names = null; let what = ''; let moved = false;
    try { names = fs.readdirSync(dir); moved = marked && fs.statSync(dir).mtimeMs !== UNTOUCHED_S * 1000; } catch (e) { names = null; what = lost(e); }
    if (names && !names.length && !moved) return;                        // 손대지 않았다
    let src;
    try { src = fs.readFileSync(TEST_FILE, 'utf8'); } catch { return; }
    if (declaresIsolation(src)) return;
    if (names) what = names.length ? `남긴 것: ${names.slice(0, 8).join(' · ')}${names.length > 8 ? ` 외 ${names.length - 8}개` : ''}` : '쓰고 지웠다';
    const msg = `\n✖ [시험 격리] ${path.basename(TEST_FILE)} — 기본 설정 폴더에 썼다(${what}).\n`
      + '  npm test 는 파일마다 임시 폴더를 주지만, 이 파일을 직접 돌리면(node --test test/<파일>) 실제 server/config 에 쓸 수 있다\n'
      + '  (CONFIG_DIR 을 물려받는 꼴이면 상위 셸이 정한 실제 설치본 폴더에 쓴다).\n'
      + (mentionsDeclaration(src)
        ? "  import './_isolateConfig.js' 가 있지만 첫 import 가 아니다 — 맨 앞으로 옮길 것(정적 import · export … from 은 적힌 순서대로 평가된다).\n"
        : "  고치는 법: 파일의 첫 import 로  import './_isolateConfig.js';  를 둔다(또는 프로젝트 모듈을 부르기 전에 CONFIG_DIR 을 임시 폴더로 무조건 대입한다).\n")
      + '  상세: docs/rules/common.md \'설정에 쓰는 시험은 …\' · test/_isolateConfig.js 머리말.\n';
    try { fs.writeSync(2, msg); } catch { /* 표준 오류가 닫혔다 */ }
    if (!process.exitCode) process.exitCode = 1;
  };
  const cleanup = () => {
    try { checkDefaultConfigWrites(); } catch { /* 검사 실패는 시험 결과가 아니다 */ }
    try { fs.rmSync(box, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ }
  };
  process.on('exit', cleanup);
  // 정리는 **마지막 exit 리스너**여야 한다 — 종료 flush 레지스트리(`src/util/exitFlush.js`)처럼 뒤에 걸린 exit 훅이 디바운스 저장을 쓰면서 폴더를 다시
  //   만든다(첫 전량 실행에서 sanswitch-activity.json · central-agent-sanswitch.json 을 담은 폴더 1개가 남았다 — 실측). exit 리스너가 새로 걸릴 때마다
  //   정리를 맨 뒤로 옮긴다. newListener 는 리스너가 붙기 **전에** 불리므로, 붙은 뒤(마이크로태스크)에 옮긴다.
  process.on('newListener', (ev, fn) => {
    if (ev !== 'exit' || fn === cleanup) return;
    queueMicrotask(() => { process.removeListener('exit', cleanup); process.on('exit', cleanup); });
  });
}
