/**
 * v2.574 — **새 엣지 워커·폴러가 조용히 빠지는 것을 막는 스윕** (감사 IMP-06·07).
 *
 * ⚠⚠ CLAUDE.md 가 v2.554·v2.560·v2.561 에 **세 번** "새 엣지 워커는 `edgelog/spec.js` 표에
 * 함께 넣을 것" 을 적었는데도 v2.573 시점에 **7개가 빠져 있었다**. 기존 테스트가
 * `length >= 20` 만 봤기 때문이다 — 그런 검사는 '추가를 잊은 것' 을 절대 잡지 못한다.
 * 그리고 그중 셋(`pingWorker`·`captureWorker`·`bmstorWorker`)은 상태 export 자체가 없어
 * `catch { return null; }` 로 **무음 실패**하고 있었다(v2.561 이 이름까지 적어 뒀다).
 *
 * ⚠ v2.566 교훈도 여기서 함께 고정한다 — push/pull 진입 함수는 **실제로 호출하는 테스트**가
 * 있어야 TDZ 급 결함이 잡힌다(순수 헬퍼만 고정하면 통과하면서 놓친다).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';
import { STATUS_SPEC } from '../src/edgelog/spec.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

describe('IMP-07 — edgelog/spec.js 표가 실재하고 빠짐이 없다', () => {
  test('★ 표의 모든 항목이 실제로 존재하는 함수를 가리킨다', async () => {
    const missing = [];
    for (const sp of STATUS_SPEC) {
      const abs = path.resolve(SRC, 'edgelog', sp.mod);
      if (!fs.existsSync(abs)) { missing.push(`${sp.key}: 파일 없음 ${sp.mod}`); continue; }
      const m = await import(abs);
      if (typeof m[sp.fn] !== 'function') missing.push(`${sp.key}: ${sp.fn} 없음`);
    }
    assert.deepEqual(missing, [], missing.join(' · '));
  });

  test('★ 상태 export 를 가진 엣지 워커·폴러가 전부 표에 있다', () => {
    /*
     * 대상: agent 의 *Worker.js 와 각 모듈의 poller.js·scheduler.js 중 *Status() 를 export 하는 것.
     * (여기에 별표+슬래시 조합을 쓰면 이 주석이 그 자리에서 끝난다 — 이번 세션에서 세 번째다.)
     * ⚠ 표에서 **의도적으로 뺀 것**은 spec.js 머리말이 사유를 적고 있다(relaycheck·중앙 전용) —
     *   여기서도 같은 목록을 명시적으로 제외한다. 사유 없이 빠지는 것만 잡는다.
     */
    const EXCLUDED = new Set([
      'relaycheck/poller.js',   // 역할별 축약(relayCheckView)을 거쳐야 한다 — spec.js 머리말
      'mail/service.js', 'collector/state.js', 'partfault/poller.js', // 중앙 전용
    ]);
    const inSpec = new Set(STATUS_SPEC.map((s) => path.normalize(s.mod).replace(/^\.\.\//, '')));
    const missed = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f);
      if (EXCLUDED.has(rel) || inSpec.has(rel)) continue;
      if (!/(Worker|poller|scheduler)\.js$/i.test(rel)) continue;
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const st = /export function (\w*[Ss]tatus\w*)\s*\(/.exec(src);
      if (st) missed.push(`${rel} :: ${st[1]}`);
    }
    assert.deepEqual(missed, [], `edgelog/spec.js 에 빠진 워커·폴러: ${missed.join(', ')}`);
  });

  test('키가 중복되지 않는다 — 중앙 수신이 덮어쓴다', () => {
    const keys = STATUS_SPEC.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('IMP-07 — 위임 워커가 무음 실패하지 않는다', () => {
  const WORKERS = ['agent/pingWorker.js', 'agent/captureWorker.js', 'agent/bmstorWorker.js'];
  for (const rel of WORKERS) {
    test(`${rel} — catch 에서 사유를 남기고 콘솔에도 적는다`, () => {
      const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
      assert.ok(!/\}\s*catch\s*\{\s*return null;\s*\}/.test(src),
        '`catch { return null; }` 무음 실패가 남아 있다(v2.549·2.561 규약)');
      assert.match(src, /_last\s*=\s*\{[^}]*error/, '실패 사유를 상태에 남기지 않는다');
      assert.match(src, /console\.warn/, '실패를 콘솔에도 적지 않는다');
    });
  }
  test('★ 세 워커의 상태 함수가 실제로 동작한다(정의만 있고 안 불리는 것을 막는다)', async () => {
    for (const [rel, fn] of [['agent/pingWorker.js', 'pingWorkerStatus'],
      ['agent/captureWorker.js', 'captureWorkerStatus'], ['agent/bmstorWorker.js', 'bmstorWorkerStatus']]) {
      const m = await import(path.join(SRC, rel));
      const st = m[fn]();
      assert.equal(typeof st, 'object');
      assert.ok(Number.isFinite(st.pollMs), `${fn} 이 주기를 밝히지 않는다`);
    }
  });
});

describe('IMP-06 — push/pull 진입 함수를 실제로 호출한다(v2.566 TDZ 교훈)', () => {
  test('★ 중앙 미설정 상태에서 전부 즉시 반환한다 — 던지지 않는다', async () => {
    /*
     * v2.566 의 결함(`perfPush.js` 의 TDZ)은 **함수 첫 줄에서** 터졌다. 순수 헬퍼만 고정하는
     * 테스트는 그것을 통과시켰다. 여기서는 진입 함수를 **실제로 부른다** — `CENTRAL_URL` 이
     * 없으므로 전부 조기 반환해야 하고, 그 과정에서 TDZ·오타는 즉시 드러난다.
     */
    const files = fs.readdirSync(path.join(SRC, 'agent')).filter((f) => f.endsWith('.js'));
    const errors = [];
    let called = 0;
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(SRC, 'agent', f), 'utf8'));
      for (const m of src.matchAll(/export async function (push\w*Now|run\w*Once)\s*\(\s*\)/g)) {
        const mod = await import(path.join(SRC, 'agent', f));
        const fn = mod[m[1]];
        if (typeof fn !== 'function') continue;
        called += 1;
        try { await fn(); } catch (e) { errors.push(`${f}::${m[1]} → ${e?.message}`); }
      }
    }
    assert.ok(called >= 10, `호출한 진입 함수가 ${called}개뿐이다 — 스윕이 좁아졌는지 확인할 것`);
    assert.deepEqual(errors, [], `진입 함수가 던졌다: ${errors.join(' · ')}`);
  });
});
