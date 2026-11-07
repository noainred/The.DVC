/**
 * v2.933 정정 — 엣지 기능 게이트(최소 엣지 버전)는 **실제로 게시된 번호**여야 한다.
 *
 * 4단계(진단 스냅샷)는 2.923 예정이었다가 다른 작업과 번호가 겹쳐 2.926.0 으로 게시됐는데, 게이트 상수는 예정 번호 2.923.0 으로
 * 남았다. 2.923~2.925 는 다른 작업의 릴리스라 스냅샷 대행 라우트가 없고, 중앙은 그 엣지를 ‘가능’ 으로 보고 요청해 404 를 받았다.
 * 같은 사고가 재발하지 않게 릴리스 노트(사실의 원천)에서 그 기능을 처음 실은 번호를 찾아 상수와 대조한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_MIN_EDGE_VERSION, TREND_MIN_EDGE_VERSION } from '../src/central/bmUsageEdgePull.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const notes = JSON.parse(fs.readFileSync(path.join(here, '../src/release-notes.json'), 'utf8')).notes;
const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
/** 제목에 표지 문구가 처음 나온(가장 낮은) 게시 번호. */
const firstRelease = (re) => notes.filter((n) => re.test(String(n.title || ''))).map((n) => n.version).sort(cmp)[0] || null;

test('진단 스냅샷 엣지 대행 게이트 = 그 기능을 처음 실은 게시 번호(4단계 · 진단 스냅샷)', () => {
  const v = firstRelease(/리눅스 통합 성능 모니터링 4단계/);
  assert.ok(v, '릴리스 노트에서 4단계 항목을 찾지 못함');
  assert.equal(SNAPSHOT_MIN_EDGE_VERSION, v, `상수 ${SNAPSHOT_MIN_EDGE_VERSION} ≠ 게시 ${v} — 예정 번호가 남았는지 확인`);
});

test('추이 엣지 대행 게이트 = 3단계(추이 탭 · 저장 구조)를 처음 실은 게시 번호', () => {
  const v = firstRelease(/리눅스 통합 성능 모니터링 3(단계|a)/);
  assert.ok(v, '릴리스 노트에서 3단계 항목을 찾지 못함');
  assert.equal(TREND_MIN_EDGE_VERSION, v);
});
