/**
 * v2.583 아키텍처 — '전체 범위 계정만' 게이트는 공용 팩토리 하나다(routes/admin/shared.js fullScopeOnlyWith).
 * 예전에는 routes/api 8곳에 같은 6줄이 복사돼 있었다. v2.583 에 옮길 때 **import 가 빠진 파일 2곳**이
 * `node --check` 를 통과하고 모듈 로드에서야 ReferenceError 로 죽었다 — 그래서 이 테스트는 소스를
 * 훑는 것에 더해 **실제로 import** 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

test('라우트 파일이 fullScopeOnly 를 손으로 다시 만들지 않는다(공용 팩토리 사용)', () => {
  const copies = [];
  for (const f of walk(path.join(SRC, 'routes'))) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    if (/const\s+fullScopeOnly\s*=\s*\(\s*req/.test(s)) copies.push(path.relative(SRC, f));
    if (/fullScopeOnlyWith\(/.test(s) && !/import\s*\{[^}]*\bfullScopeOnlyWith\b[^}]*\}\s*from/.test(s) && !f.endsWith(path.join('admin', 'shared.js'))) copies.push(`${path.relative(SRC, f)} (import 없음)`);
  }
  assert.deepEqual(copies, [], `routes/admin/shared.js fullScopeOnlyWith(사유) 를 쓸 것: ${copies.join(', ')}`);
});

test('팩토리를 쓰는 라우트 모듈이 실제로 로드된다(import 누락은 로드에서만 드러난다)', async () => {
  const users = [];
  for (const f of walk(path.join(SRC, 'routes'))) {
    const s = fs.readFileSync(f, 'utf8');
    if (/fullScopeOnlyWith\(/.test(s) && !f.endsWith(path.join('admin', 'shared.js'))) users.push(f);
  }
  assert.ok(users.length >= 9, `사용처가 줄었다: ${users.length}`);
  for (const f of users) await import(f);
});

test('fullScopeOnlyWith — 범위 계정은 403(사유 포함), 전체 범위는 통과', async () => {
  const { fullScopeOnlyWith } = await import('../src/routes/admin/shared.js');
  const mw = fullScopeOnlyWith('테스트 사유');
  const run = (user) => new Promise((resolve) => {
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    mw({ user }, res, () => resolve({ next: true }));
  });
  assert.deepEqual(await run({ username: 'a', role: 'admin' }), { next: true });
  const r = await run({ username: 'b', role: 'operator', scope: { vcenters: ['vc-1'] } });
  assert.equal(r.code, 403);
  assert.equal(r.body.reason, '테스트 사유');
  assert.equal(r.body.error, 'forbidden');
});

test('prune 스로틀은 기동 첫 틱에 참이 되지 않는다 — `% N === 1` · `t++ % N === 0` 금지(v2.453 규약, v2.583 재발 수정)', () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    s.split('\n').forEach((line, i) => {
      if (/%\s*[0-9_]+\s*\)?\s*===\s*1(?![0-9])/.test(line) && /tick|prune|Tick|Prune/.test(line)) bad.push(`${path.relative(SRC, f)}:${i + 1}`);
      if (/[A-Za-z_]\+\+\s*%\s*[0-9_]+\s*\)?\s*===\s*0/.test(line)) bad.push(`${path.relative(SRC, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `(++t % N) === 0 으로 쓸 것: ${bad.join(', ')}`);
});

test('GPU SSH 수집 — IP 당 예산이 세션을 실제로 끊고(withDeadline + signal) 명령은 남은 예산으로만 돈다(v2.417 규약, v2.583 수정)', async () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'gpu/sshCollect.js'), 'utf8'));
  assert.match(s, /withDeadline\(perIpBudget, \(signal\) => withSsh\(/);
  assert.match(s, /readyTimeout: Math\.max\(5_000, timeoutMs\), signal \}/);
  assert.match(s, /sh\.exec\(cmd, left\)/, '명령마다 기본 60초가 아니라 남은 예산');
  // 물리 GPU 탐지도 같은 규약(검증 에이전트 권고)
  const det = s.slice(s.indexOf('export async function detectPhysicalGpu'), s.indexOf('export async function testVmGuestSsh'));
  assert.match(det, /withDeadline\(budget, \(signal\) => withSsh\(/, 'detectPhysicalGpu 도 세션을 끊는 시한');
  assert.match(det, /runNvsmi\(sh, '[^']+', left\)/, '남은 예산으로만 nvidia-smi 후보를 돈다');
  assert.doesNotMatch(det, /sh\.exec\('(?:hostname|uname -s|cmd \/c ver)'\)/, '보조 명령도 시한을 준다');
  // vmperf 파일별 DB 정리도 청크 삭제(v2.453 규약 — 검증 에이전트 권고)
  const vp = stripComments(fs.readFileSync(path.join(SRC, 'metrics/vmperfDb.js'), 'utf8'));
  assert.match(vp, /await chunkedDelete\(x\.st\.prune,/);
  assert.doesNotMatch(vp, /x\.st\.prune\.run\(/);
  const m = await import('../src/gpu/sshCollect.js');
  // 게스트 IP 가 없으면 접속 없이 바로 사유를 준다(시한과 무관한 빠른 경로 — 회귀 방지)
  await assert.rejects(m.collectVmGpuSsh({ ipAddresses: [] }, { username: 'u' }, { timeoutMs: 1000 }), /게스트 IP 없음/);
});
