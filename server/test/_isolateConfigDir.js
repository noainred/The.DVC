/**
 * 시험 프로세스마다 기본 설정 폴더(CONFIG_DIR)를 새 임시 폴더로 잡는 preload — `npm test`(server/package.json)가
 * `node --test --import ./test/_isolateConfigDir.js` 로 건다. node --test 는 시험 파일마다 자식 프로세스를 띄우고
 * 이 preload 는 **그 자식에서만** 돈다(러너 부모에서는 돌지 않는다 — 실측). 그래서 폴더는 시험 파일 하나에 하나다.
 *
 * 왜(2026-11-26): 시험 일부가 CONFIG_DIR 을 잡지 않은 채 프로젝트 모듈을 불러, 설정이 기본 폴더(실제 `server/config`)로 풀렸다.
 *   전량 실행 뒤 그 폴더에 auth-secret · datacenters.json · ping-monitor.db 등 시험 데이터 12종이 남았고, 같은 체크아웃의 다음 실행이
 *   그것을 읽었다(v3.41.1 arch2582 BUG-2 는 그 때문에 두 번째 실행부터 실패했다). 찾은 파일은 각자 고쳤지만(파일 맨 위에서
 *   CONFIG_DIR 을 임시 폴더로), CONFIG_DIR 을 언급하지 않고 src 모듈을 불러오는 시험이 269개라 파일별 규칙으로는 다음 누락을 막지 못한다.
 *
 * 정한 것과 이유:
 *  - **시험 파일 프로세스에서는 밖에서 준 CONFIG_DIR 도 바꾼다** — preload 는 시험 파일보다 먼저 돌므로 그때 이미 있는 값은 셸 · CI 에서 온 것뿐이다.
 *    개발 PC 셸에 실제 설치본 설정 폴더(/etc/vmware-portal 등)가 export 돼 있어도 전량 시험이 거기에 쓰지 않게 한다. 시험이 스스로 잡는
 *    폴더는 이 뒤에 대입되므로 그대로 이긴다. 시험 파일이 아닌 프로세스(execArgv 를 물려받은 fork · 워커)는 물려받은 값을 그대로 쓴다
 *    (시험이 잡아 준 폴더다) — 값이 없을 때만 새로 잡는다.
 *  - 공용 폴더 하나(npm 스크립트에서 CONFIG_DIR=…)로 주지 않는다 — `process.env.CONFIG_DIR || 자기 폴더` 꼴의 시험 15개가 같은 폴더를
 *    나눠 쓰게 되고(병렬 실행 중 같은 DB · 같은 auth-secret), 실행이 끝난 뒤 지울 곳도 셸 문법(trap)으로만 생긴다.
 *  - 지우기는 **exit 에서** 한다 — 루트 after 에서 바로 지우면 안 된다: node 22 는 시험 사이의 최상위 await 동안 루트 after 를
 *    먼저 돌린다(tmpCleanup3188 ③ · audit2590 실측). 그 exit 훅은 루트 after 에서 건다 — 모듈의 종료 flush(util/exitFlush.js)가
 *    먼저 걸린 뒤라야 우리 정리가 그보다 뒤에 돌아, 늦은 flush 가 폴더를 다시 만들지 않는다(arch2582 와 같은 꼴).
 *  - 시험 파일 프로세스가 아니면(execArgv 를 물려받은 fork 등) node:test 훅을 부르지 않고 exit 훅만 건다.
 *
 * ⚠ `node --test test/x.test.js` 처럼 파일을 직접 돌리면 이 preload 가 걸리지 않는다 — 설정 폴더에 쓰는 시험은 여전히 파일 맨 위에서
 *   CONFIG_DIR 을 임시 폴더로 잡아야 한다(arch2582 머리 주석). 고정: test/configDirIsolation.test.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// 시험 파일 프로세스인가 — 러너가 준 표식(NODE_TEST_CONTEXT)과 진입점이 시험 파일인지를 함께 본다(표식은 손자 프로세스에도 물려진다).
const isTestFile = !!process.env.NODE_TEST_CONTEXT && /\.test\.[cm]?js$/.test(process.argv[1] || '');

if (isTestFile || !process.env.CONFIG_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-test-cfg-'));
  process.env.CONFIG_DIR = dir;
  const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
  if (isTestFile) after(() => { process.once('exit', rm); });
  else process.once('exit', rm);
}
