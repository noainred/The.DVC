import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.312 회귀 방지 — 스토리지 등록 폼 '수집 주체' 드롭다운이 per-agent 토큰뿐 아니라
// 중앙과 통신 중인 모든 알려진 엣지를 병합해 보여주는지(토큰 미발급 환경에서도 위임 가능).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'known-agents-test-'));
process.env.CONFIG_DIR = TMP;

const { knownAgentNames } = await import('../src/central/knownAgents.js');
const { issueAgentToken, revokeAgentToken } = await import('../src/central/agentTokens.js');

test('knownAgentNames — 소스 미초기화에도 throw 없이 배열 반환', () => {
  const list = knownAgentNames();
  assert.ok(Array.isArray(list), '항상 배열(각 소스 try/catch 로 방어)');
});

test('knownAgentNames — 발급된 per-agent 토큰의 agent 가 목록에 포함(정렬·중복 제거)', () => {
  const before = knownAgentNames();
  assert.ok(!before.includes('WA-Edge'), '발급 전에는 없음');
  const r = issueAgentToken('WA-Edge', { note: 'test' });
  assert.equal(r.ok, true);
  try {
    const after = knownAgentNames();
    assert.ok(after.includes('WA-Edge'), '토큰 발급 엣지가 드롭다운 목록에 노출');
    // 정렬 계약(localeCompare) — 사람이 고르기 쉽게.
    assert.deepEqual(after, [...after].sort((a, b) => a.localeCompare(b)));
    // 대소문자 무시 중복 제거: 같은 이름 재발급이 중복 항목을 만들지 않는다.
    issueAgentToken('wa-edge');
    const dup = knownAgentNames().filter((n) => n.toLowerCase() === 'wa-edge');
    assert.equal(dup.length, 1, '대소문자 다른 동일 엣지는 1건으로 합쳐짐');
  } finally { revokeAgentToken('WA-Edge'); revokeAgentToken('wa-edge'); }
});
