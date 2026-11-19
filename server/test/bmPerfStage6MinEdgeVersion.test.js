/**
 * 리눅스 성능 6단계 — 엣지 최소 버전 공용 함수(featureMinEdgeVersion — 5단계 perfOpsMinEdgeVersion 일반화).
 *   · 6단계 표지(‘리눅스 통합 성능 모니터링 6단계’)의 첫 게시 번호 · 노트에 없으면 지금 package.json 번호(5단계와 같은 폴백) · 표지별 메모.
 *   · 5단계 함수 · 이름 · 동작은 그대로(bmPerfMinEdgeVersion2929 · bmUsageMinEdgeVersion2933 이 계속 통과해야 한다).
 *   · 6단계 엣지 경로를 쓰는 모듈은 최소 버전을 숫자로 박지 않는다(소스 스윕).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureMinEdgeVersion, stage6MinEdgeVersion, firstReleaseOf, STAGE6_TITLE_RE, STAGE5_TITLE_RE, _resetFeatureMinEdgeVersionForTest } from '../src/central/featureMinEdgeVersion.js';
import { perfOpsMinEdgeVersion, _resetPerfOpsMinEdgeVersionForTest } from '../src/central/bmPerfOpsPull.js';
import { currentVersion } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const notes = JSON.parse(fs.readFileSync(path.join(here, '../src/release-notes.json'), 'utf8')).notes;

test('6단계 최소 버전 = 노트의 6단계 첫 게시 번호(없으면 지금 package.json 번호)', () => {
  _resetFeatureMinEdgeVersionForTest();
  const v = firstReleaseOf(notes, STAGE6_TITLE_RE);
  assert.equal(stage6MinEdgeVersion(), v || currentVersion());
});

test('표지별 메모 · 폴백 · 5단계 함수와 같은 동작', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bms6mv-'));
  try {
    const f = path.join(dir, 'notes.json');
    fs.writeFileSync(f, JSON.stringify({ notes: [
      { version: '2.950.0', title: '베어메탈 — 리눅스 통합 성능 모니터링 6단계: 서버 비교' }, { version: '2.951.0', title: '리눅스 통합 성능 모니터링 6단계 보강' },
      { version: '2.940.0', title: '리눅스 통합 성능 모니터링 5단계' }, { version: 'x.y', title: '리눅스 통합 성능 모니터링 6단계' },
    ] }));
    _resetFeatureMinEdgeVersionForTest();
    assert.equal(featureMinEdgeVersion(STAGE6_TITLE_RE, { notesFile: f, fallback: () => '9.9.9' }), '2.950.0', '가장 낮은 게시 번호(형식 밖 번호 무시)');
    assert.equal(featureMinEdgeVersion(STAGE5_TITLE_RE, { notesFile: f, fallback: () => '9.9.9' }), '2.940.0', '표지마다 따로');
    fs.writeFileSync(f, JSON.stringify({ notes: [] }));
    assert.equal(featureMinEdgeVersion(STAGE6_TITLE_RE, { notesFile: f, fallback: () => '9.9.9' }), '2.950.0', '메모(노트는 재시작 전 바뀌지 않는다)');
    _resetFeatureMinEdgeVersionForTest(STAGE6_TITLE_RE);
    assert.equal(featureMinEdgeVersion(STAGE6_TITLE_RE, { notesFile: f, fallback: () => '2.960.0' }), '2.960.0', '노트에 없으면 지금 번호');
    // 5단계 이름은 같은 본체 — 5단계 리셋이 6단계 메모를 지우지 않는다
    _resetPerfOpsMinEdgeVersionForTest();
    assert.equal(perfOpsMinEdgeVersion({ notesFile: f, fallback: () => '3.0.0' }), '3.0.0');
    assert.equal(featureMinEdgeVersion(STAGE6_TITLE_RE, { notesFile: f, fallback: () => '0.0.1' }), '2.960.0');
    fs.writeFileSync(f, '{ broken');
    _resetFeatureMinEdgeVersionForTest();
    assert.equal(featureMinEdgeVersion(STAGE6_TITLE_RE, { notesFile: f, fallback: () => '2.970.0' }), '2.970.0', '노트를 못 읽으면 지금 번호');
  } finally { _resetFeatureMinEdgeVersionForTest(); _resetPerfOpsMinEdgeVersionForTest(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('6단계 엣지 경로 모듈은 최소 버전을 숫자로 박지 않는다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  for (const f of ['central/bmComparePull.js', 'central/featureMinEdgeVersion.js', 'central/bmPerfOpsPull.js']) {
    const src = stripComments(fs.readFileSync(path.join(here, '../src', f), 'utf8'));
    assert.doesNotMatch(src, /MIN_EDGE_VERSION\s*=\s*'\d|minVersion:\s*'\d/, f);
  }
});
