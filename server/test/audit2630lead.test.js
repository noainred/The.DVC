/**
 * v2.630 리드 통합분 회귀.
 * A4-02 후속: 중앙 수신 모듈(스토리지)이 '지금 수집' 완료 판정에 **엣지 시계 원본**(edgeCollectedAt)을 쓴다.
 *   수신 시각으로 clamp 한 collectedAt 을 쓰면, 엣지 시계가 빠를 때 옛 스냅샷 재전송이 완료로 보인다.
 * 기준 시각은 Date.now() 를 쓰지 않고 고정한다(CLAUDE.md v2.517 규약) — 단 큐는 내부에서 Date.now() 로 인출 시각을 찍으므로
 *   여기서는 '기준선보다 새 수집인가' 만 본다(시각 경계와 무관).
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
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

process.env.CONFIG_DIR = tmpDir('audit2630lead-');

const reqs = await import('../src/storage/collectRequests.js');
const edge = await import('../src/central/storageEdge.js');

test('A4-02: 엣지 시계가 빨라도 옛 스냅샷 재전송은 지금 수집 요청을 완료시키지 않는다', () => {
  const OLD = 1_900_000_000_000 - 30 * 60_000;    // 엣지가 전에 보낸 수집 시각(엣지 시계 — 중앙보다 빠르다)
  // 기준선: 보관 중인 스냅샷(표시용 collectedAt 은 clamp 되어 작지만 원본은 OLD)
  edge.saveEdgeStorage('edgeA', [{ deviceId: 'dev1', ok: true, collectedAt: OLD - 3_600_000, edgeCollectedAt: OLD }]);
  reqs.requestCollect('dev1', 'edgeA');
  const taken = reqs.takeRequestsForAgent('edgeA');
  assert.ok(taken.some((x) => String(x.deviceId ?? x.id ?? x) === 'dev1'), '인출됨');
  // 같은 스냅샷 재전송(원본 OLD). clamp 값은 수신 시각이라 더 커 보이지만 완료가 아니어야 한다.
  edge.saveEdgeStorage('edgeA', [{ deviceId: 'dev1', ok: true, collectedAt: OLD - 60_000, edgeCollectedAt: OLD }]);
  assert.equal(reqs.hasPendingRequest('dev1'), true, '옛 스냅샷 재전송은 완료가 아니다');
  // 새 수집(원본이 OLD 보다 뒤)이면 완료.
  edge.saveEdgeStorage('edgeA', [{ deviceId: 'dev1', ok: true, collectedAt: OLD - 30_000, edgeCollectedAt: OLD + 60_000 }]);
  assert.equal(reqs.hasPendingRequest('dev1'), false, '새 수집이 오면 완료');
});
