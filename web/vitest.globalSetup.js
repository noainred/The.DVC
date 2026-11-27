/**
 * vitest 전역 준비 — 웹 시험이 서버 모듈을 불러올 때 실제 설정 폴더(server/config)에 쓰지 않게(2026-11-26 시험 위생 점검 2회차).
 *
 * 웹 시험 일부(예: views/tools/bmStage6Text.test.jsx)가 서버 모듈을 불러오고, 그 길이 auth/auth.js 에 닿으면 load 때 `auth-secret` 을 **실제
 * server/config** 에 만들었다(vitest 에는 CONFIG_DIR 지정이 없었다). 서버 시험은 `server/test/_isolateConfig.js` 가 막는다 — 이것은 웹 쪽 짝이다.
 * 여기서 정한 env 는 이 뒤에 뜨는 시험 작업자(워커)에 물려진다. CONFIG_DIR 이 이미 있으면(상위 셸 지정) 건드리지 않는다.
 * 폴더는 `<tmp>/dvc-vitest-cfg-<uid>/<pid>-XXXXXX` — 실행이 죽어(Ctrl-C · KILL) 정리가 돌지 않으면 다음 실행이 지운다(서버와 같은 `server/test/_tmpRoot.js`).
 */
import fs from 'node:fs';
import { makeOwnTmpDir } from '../server/test/_tmpRoot.js';

export default function setup() {
  if (process.env.CONFIG_DIR) return undefined;
  const dir = makeOwnTmpDir('dvc-vitest-cfg');
  process.env.CONFIG_DIR = dir;
  return () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
}
