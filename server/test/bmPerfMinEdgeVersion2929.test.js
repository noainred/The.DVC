/**
 * v2.929(5단계 · 반증 F15) — 베어메탈 성능 5단계 엣지 대행 안내 문구의 최소 엣지 버전은 **실제로 게시된 번호**다.
 * main 의 bmUsageMinEdgeVersion2933.test.js 와 같은 꼴: 릴리스 노트(사실의 원천)에서 그 기능을 처음 실은 번호를 찾아 대조한다.
 * 다른 점: 이 값은 손으로 맞추는 상수가 아니라 perfOpsMinEdgeVersion() 이 노트에서 읽는다 — 노트에 아직 없으면(개발 중 · 릴리스 직전) 지금 package.json 번호.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { perfOpsMinEdgeVersion, PERF_OPS_RELEASE_TITLE_RE, _resetPerfOpsMinEdgeVersionForTest } from '../src/central/bmPerfOpsPull.js';
import { currentVersion } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const notes = JSON.parse(fs.readFileSync(path.join(here, '../src/release-notes.json'), 'utf8')).notes;
const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const firstRelease = (re) => notes.filter((n) => re.test(String(n.title || ''))).map((n) => n.version).sort(cmp)[0] || null;

test('5단계 엣지 대행 최소 버전 = 릴리스 노트에서 5단계를 처음 실은 번호(없으면 지금 package.json 번호)', () => {
  _resetPerfOpsMinEdgeVersionForTest();
  const v = firstRelease(/리눅스 통합 성능 모니터링 5단계/);
  assert.equal(perfOpsMinEdgeVersion(), v || currentVersion(), v ? `게시 ${v}` : '노트에 아직 없음 — package.json 번호');
});

test('읽기 규칙 — 표지 제목의 가장 낮은 번호 · 노트에 없으면 fallback · 한 번 읽어 메모', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmminv-'));
  try {
    const f = path.join(dir, 'notes.json');
    fs.writeFileSync(f, JSON.stringify({ notes: [{ version: '2.941.0', title: '베어메탈 — 리눅스 통합 성능 모니터링 5단계 보강' }, { version: '2.934.0', title: '베어메탈 사용률 — 리눅스 통합 성능 모니터링 5단계: 집중 모니터링' }, { version: '2.933.0', title: '다른 기능' }] }));
    _resetPerfOpsMinEdgeVersionForTest();
    assert.equal(perfOpsMinEdgeVersion({ notesFile: f, fallback: () => '9.9.9' }), '2.934.0');
    assert.equal(perfOpsMinEdgeVersion({ notesFile: f, fallback: () => '9.9.9' }), '2.934.0', '메모');
    fs.writeFileSync(f, JSON.stringify({ notes: [{ version: '2.933.0', title: '다른 기능' }] }));
    _resetPerfOpsMinEdgeVersionForTest();
    assert.equal(perfOpsMinEdgeVersion({ notesFile: f, fallback: () => '2.950.0' }), '2.950.0', '노트에 없으면 지금 번호');
    assert.ok(PERF_OPS_RELEASE_TITLE_RE.test('리눅스 통합 성능 모니터링 5단계'));
  } finally { _resetPerfOpsMinEdgeVersionForTest(); fs.rmSync(dir, { recursive: true, force: true }); }
});
