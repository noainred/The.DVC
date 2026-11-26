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
 *   · vCenter 예제 템플릿 폴백은 `config.js` 가 설정 폴더가 아니라 **저장소의 config 폴더**에서 읽으므로 영향이 없다.
 *
 * ⚠ 시험 파일 하나만 직접 돌릴 때(`node --test test/x.test.js`)는 이 파일이 불리지 않는다 — `--import ./test/_isolateConfig.js` 를 붙인다
 *   (`.claude/skills/verify/SKILL.md`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.CONFIG_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-test-cfg-'));
  process.env.CONFIG_DIR = dir;
  process.env.DVC_TEST_ISOLATED_CONFIG = dir;   // 시험이 '격리 중인가' 를 확인할 때 쓴다(isolateConfig.test.js)
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
  process.on('exit', cleanup);
  // 정리는 **마지막 exit 리스너**여야 한다 — 종료 flush 레지스트리(`src/util/exitFlush.js`)처럼 뒤에 걸린 exit 훅이 디바운스 저장을 쓰면서 폴더를 다시
  //   만든다(첫 전량 실행에서 sanswitch-activity.json · central-agent-sanswitch.json 을 담은 폴더 1개가 남았다 — 실측). exit 리스너가 새로 걸릴 때마다
  //   정리를 맨 뒤로 옮긴다. newListener 는 리스너가 붙기 **전에** 불리므로, 붙은 뒤(마이크로태스크)에 옮긴다.
  process.on('newListener', (ev, fn) => {
    if (ev !== 'exit' || fn === cleanup) return;
    queueMicrotask(() => { process.removeListener('exit', cleanup); process.on('exit', cleanup); });
  });
}
