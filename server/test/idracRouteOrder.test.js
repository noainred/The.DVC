import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

// 격리된 CONFIG_DIR(라우터 import 시 설정 파일 접근 대비).
process.env.CONFIG_DIR = tmpDir('idrac-route-');

let adminRouter;
before(async () => { ({ adminRouter } = await import('../src/routes/admin.js')); });

// PUT/DELETE '/idrac/:id'(파라미터)는 반드시 리터럴 '/idrac/scan-ranges'·'/idrac/power-settings'
// 보다 '뒤'에 등록돼야 한다. 그렇지 않으면 PUT /idrac/scan-ranges가 :id에 매칭돼
// updateServer('scan-ranges') → '없는 서버: scan-ranges'로 잘못 처리된다(회귀 방지).
test('iDRAC 라우트 순서: 리터럴 PUT이 /idrac/:id보다 먼저 등록', () => {
  const layers = adminRouter.stack.filter((l) => l.route);
  const idxOf = (method, p) => layers.findIndex((l) => l.route.path === p && l.route.methods[method]);

  const putParam = idxOf('put', '/idrac/:id');
  const delParam = idxOf('delete', '/idrac/:id');
  const putScanRanges = idxOf('put', '/idrac/scan-ranges');
  const putPowerSettings = idxOf('put', '/idrac/power-settings');

  assert.ok(putParam >= 0, 'PUT /idrac/:id 라우트가 존재해야 함');
  assert.ok(putScanRanges >= 0, 'PUT /idrac/scan-ranges 라우트가 존재해야 함');
  assert.ok(putPowerSettings >= 0, 'PUT /idrac/power-settings 라우트가 존재해야 함');

  assert.ok(putScanRanges < putParam, 'PUT /idrac/scan-ranges는 /idrac/:id보다 먼저 등록돼야 함');
  assert.ok(putPowerSettings < putParam, 'PUT /idrac/power-settings는 /idrac/:id보다 먼저 등록돼야 함');
  // DELETE 리터럴은 2-세그먼트라 가려지지 않지만, :id 파라미터는 마지막 부근이어야 안전.
  assert.ok(delParam >= putParam, 'DELETE /idrac/:id도 파라미터 라우트로 뒤쪽에 위치');
});
