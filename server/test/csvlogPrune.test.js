import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
test.after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

// csvlog 는 import 시 CONFIG_DIR 을 쓴다 → 격리.
const TMP = tmpDir('csvlog-prune-');
process.env.CONFIG_DIR = TMP;
const { pruneOld } = await import('../src/svcmon/csvlog.js');

// v2.287 회귀 방지(확정 버그 #17): 회전 단위 혼재/파트 파일에서 파일명 사전식 정렬이 최신 파일을
// 오래된 것으로 오판해 먼저 삭제했다. mtime 기준으로 '진짜 오래된 것'부터 지워야 한다.
test('pruneOld: 사전식으로 앞서지만 최신(mtime)인 파일은 보존, 오래된 것부터 삭제', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'logs-'));
  const now = Date.now();
  // A: 사전식으로 앞서지만('-' < '0') 최신. B: 사전식 뒤지만 10일 전(가장 오래됨).
  const A = 'results-2026-W33.csv';   // 주별 파일명(최신 주)
  const B = 'results-20260803.csv';   // 일별 파일명(오래됨)
  fs.writeFileSync(path.join(dir, A), 'a'.repeat(100));
  fs.writeFileSync(path.join(dir, B), 'b'.repeat(100));
  const setM = (f, ms) => fs.utimesSync(path.join(dir, f), new Date(ms), new Date(ms));
  setM(A, now);                       // 최신
  setM(B, now - 10 * 86400_000);      // 오래됨

  const removed = pruneOld(dir, { keepFiles: 1, maxTotalMB: 0 });
  assert.equal(removed, 1);
  assert.ok(fs.existsSync(path.join(dir, A)), '최신(mtime) 파일은 사전식으로 앞서도 보존되어야 함');
  assert.ok(!fs.existsSync(path.join(dir, B)), '가장 오래된 파일이 삭제되어야 함');
});

test('pruneOld: keepFiles 만큼 최신 N개 보존', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'logs2-'));
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const f = `results-2026080${i}.csv`;
    fs.writeFileSync(path.join(dir, f), 'x'.repeat(50));
    fs.utimesSync(path.join(dir, f), new Date(now - (5 - i) * 86400_000), new Date(now - (5 - i) * 86400_000));
  }
  const removed = pruneOld(dir, { keepFiles: 2, maxTotalMB: 0 });
  assert.equal(removed, 3, '5개 중 최신 2개 남기고 3개 삭제');
  const left = fs.readdirSync(dir).filter((f) => /^results-.*\.csv$/.test(f)).sort();
  assert.deepEqual(left, ['results-20260803.csv', 'results-20260804.csv'], '최신 2개(i=3,4)만 남아야 함');
});
