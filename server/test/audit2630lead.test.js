/**
 * v2.630 리드 통합분 회귀.
 * A4-02 후속: 중앙 수신 모듈(스토리지)이 '지금 수집' 완료 판정에 **엣지 시계 원본**(edgeCollectedAt)을 쓴다.
 *   수신 시각으로 clamp 한 collectedAt 을 쓰면, 엣지 시계가 빠를 때 옛 스냅샷 재전송이 완료로 보인다.
 * 기준 시각은 Date.now() 를 쓰지 않고 고정한다(CLAUDE.md v2.517 규약) — 단 큐는 내부에서 Date.now() 로 인출 시각을 찍으므로
 *   여기서는 '기준선보다 새 수집인가' 만 본다(시각 경계와 무관).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2630lead-'));

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
