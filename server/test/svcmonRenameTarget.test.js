/**
 * 대상(등록 노드) 이름 변경 회귀 방지 — 트리 컨텍스트 메뉴 '이름 변경'이 쓰는 경로.
 * PUT /svcmon/targets/:id 에 { name } 만 보내면 updateTarget 부분 업데이트로 이름만 바뀌고
 * 호스트·점검·경로·enabled 는 그대로 보존돼야 한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('svcmon-rename-');
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');

test('대상 이름만 변경하면 호스트·점검·경로가 보존된다', () => {
  const t = store.addTarget({ kind: 'infra', path: 'RN', name: 'old-name', host: '10.9.0.1' });
  store.addTest(t.id, { name: 'ping', type: 'ping', intervalSec: 60 });
  const before = store.getTarget(t.id);
  assert.equal(before.tests.length, 1);

  const up = store.updateTarget(t.id, { name: 'new-name' });   // 이름만 부분 업데이트
  assert.equal(up.name, 'new-name', '이름 변경됨');
  assert.equal(up.host, '10.9.0.1', '호스트 보존');
  assert.equal(up.path, 'RN', '경로 보존');
  assert.equal(up.tests.length, 1, '점검 보존');
});

test('빈/공백 이름으로 업데이트하면 기존 이름을 유지한다(부분 업데이트 기본값 폴백)', () => {
  const t = store.addTarget({ kind: 'infra', path: 'RN', name: 'keep', host: '10.9.0.2' });
  const up = store.updateTarget(t.id, { name: '   ' });
  assert.equal(up.name, 'keep', '공백 이름은 무시되고 기존 이름을 유지(프론트도 빈 이름을 막는다)');
});
