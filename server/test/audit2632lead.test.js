// v2.632 리드 통합분 회귀 — 그룹 보고의 '리드가 할 것'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_stripComments.js';

const src = (p) => stripComments(fs.readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8'));

test('엣지 번들 push 는 시한에 맞는 디스패처를 쓴다(300초 초과 → 긴 디스패처)', async () => {
  const s = src('collector/upgradePush.js');
  assert.match(s, /dispatcher: dispatcherFor\(undefined, pushTimeoutMs\)/);
  assert.match(s, /AbortSignal\.timeout\(pushTimeoutMs\)/);
  const { dispatcherFor, _internals } = await import('../src/util/resilientFetch.js');
  assert.equal(dispatcherFor(undefined, 600_000), _internals.wanLongAgent);
  assert.equal(dispatcherFor(undefined, 60_000), _internals.wanAgent);
});

test('패키지 저장소 versions.json 은 상한까지만 읽는다', () => {
  const s = src('upgrade/fetchPackage.js');
  const body = s.slice(s.indexOf('export async function fetchRemoteVersions'), s.indexOf('export function listLocalPackages'));
  assert.match(body, /readJsonCapped\(res,/);
  assert.doesNotMatch(body, /res\.json\(\)/);
});

test('Horizon 합집합 카드는 실패 서버가 있으면 하한(최소 N)이다', () => {
  const s = src('routes/api/horizonSessions.js');
  assert.match(s, /lowerBound: !!total\.usersLowerBound \|\| Number\(total\.serversFailed\) > 0/);
});
