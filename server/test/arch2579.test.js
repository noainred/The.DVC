/**
 * v2.579 — 아키텍처 계층 규칙(회귀 고정).
 *
 * 왜 이 테스트가 있나: v2.566 의 TDZ 사고(순환 안에서 이름이 가려져 push 함수가 통째로 죽고
 * 10일간 조용했다)와 같은 유형이 **방향이 뒤집힌 의존**에서 나온다. v2.579 감사에서 확정한 것 —
 *  · `util/ssrfLookup.js`(leaf util) → `collector/registry.js`(도메인) → `util/resilientFetch.js` 순환.
 *  · `collector/agent.js`(도메인) → `routes/collector.js`(라우트) → `collector/agent.js` 순환.
 *  · 도메인 모듈 4곳이 `routes/admin/shared.js` 의 도메인 헬퍼를 import.
 *  · 동시성 풀 사본이 v2.575 '23벌 → 1' 이후에도 **16벌** 남아 있었다(이름이 달라 스윕에서 빠졌다).
 * 규칙은 셋이고 각각 한 방향이다: ① routes/ 는 index.js 만 import 한다 ② util/ 은 util/·config·
 * node 내장(+명시 allowlist)만 import 한다 ③ 동시성 풀은 util/pool.js 하나다.
 *
 * ⚠ 주석을 먼저 제거하고 검사한다(v2.535 규약) — 규칙을 설명하는 주석이 통과 근거가 되면 안 된다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (p.endsWith('.js')) files.push(p);
  }
})(ROOT);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const code = (p) => stripComments(fs.readFileSync(p, 'utf8'));
const importsOf = (p) => {
  const out = [];
  for (const m of code(p).matchAll(/(?:^|\n)\s*import[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    let t = path.resolve(path.dirname(p), m[1] || m[2]);
    if (!t.endsWith('.js')) t = fs.existsSync(`${t}.js`) ? `${t}.js` : path.join(t, 'index.js');
    if (fs.existsSync(t)) out.push(rel(t));
  }
  return out;
};

test('① 라우트 파일은 index.js 만 import 한다 — 도메인·util 이 routes/ 를 향하지 않는다', () => {
  const bad = [];
  for (const f of files) {
    const r = rel(f);
    if (r.startsWith('routes/') || r === 'index.js' || r.startsWith('intro/')) continue;
    for (const t of importsOf(f)) if (t.startsWith('routes/')) bad.push(`${r} -> ${t}`);
  }
  assert.deepEqual(bad, [], `도메인/유틸이 라우트를 import 한다(방향 위반):\n${bad.join('\n')}`);
});

// util/ 이 바깥을 향해도 되는 예외 — 이유와 함께 명시한다(암묵 허용 금지).
const UTIL_ALLOW = new Map([
  ['perf/monitor.js', '루프 지연·스톨 계측은 횡단 관심사(instrumentation) — util 이 기록만 남긴다'],
  ['vcenter/soapParse.js', '순수 SOAP 파서인데 vcenter/ 아래에 산다 — 워커 풀이 그것을 돌린다(옮기는 것은 별건)'],
]);
test('② util/ 은 util/·config.js·node 내장(+명시 allowlist)만 import 한다', () => {
  const bad = [];
  for (const f of files) {
    const r = rel(f);
    if (!r.startsWith('util/')) continue;
    for (const t of importsOf(f)) {
      if (t.startsWith('util/') || t === 'config.js' || UTIL_ALLOW.has(t)) continue;
      bad.push(`${r} -> ${t}`);
    }
  }
  assert.deepEqual(bad, [], `util 이 도메인을 import 한다(v2.579 ARCH-02 유형):\n${bad.join('\n')}`);
});

test('②-b util/ 이 속한 순환(SCC)이 없다', () => {
  const edges = new Map(files.map((f) => [rel(f), importsOf(f)]));
  let idx = 0; const st = []; const on = new Set(); const index = new Map(); const low = new Map(); const sccs = [];
  const sc = (v) => {
    index.set(v, idx); low.set(v, idx); idx += 1; st.push(v); on.add(v);
    for (const w of edges.get(v) || []) {
      if (!index.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c); }
  };
  for (const f of edges.keys()) if (!index.has(f)) sc(f);
  const withUtil = sccs.filter((c) => c.some((x) => x.startsWith('util/')));
  assert.deepEqual(withUtil, [], `util 모듈이 순환에 들어 있다:\n${withUtil.map((c) => c.join(' <-> ')).join('\n')}`);
  // 남은 순환은 전부 '같은 도메인 안' 2-cycle 이고 각 파일이 단독 진입점으로도 로드된다(v2.579 실측).
  // 새 순환이 늘면 여기서 드러난다 — 늘리지 말 것.
  assert.ok(sccs.length <= 5, `순환 SCC 가 늘었다(${sccs.length}):\n${sccs.map((c) => c.join(' <-> ')).join('\n')}`);
});

// 의도적으로 남긴 전용 실행기 — 두 갈래 큐·건너뛰기 분기가 있어 범용 풀로 환원되지 않는다.
const POOL_EXCLUDED = new Map([
  ['svcmon/pool.js', '인라인 폴백 — 프로세스/소켓 두 레인을 따로 배수(PROC_LIMIT·SOCK_LIMIT)'],
  ['routes/admin/gpuGuest.js', '항목별 사전 판정(continue)·결과 슬롯이 한 루프 안에 있다'],
]);
test('③ 동시성 풀 스캐폴드는 util/pool.js 하나다 — 손으로 쓴 사본 0', () => {
  const bad = [];
  for (const f of files) {
    const r = rel(f);
    if (r === 'util/pool.js' || POOL_EXCLUDED.has(r)) continue;
    const s = code(f);
    if (/function (eachLimited|pool)\s*\(/.test(s) && !/poolSettled|poolRun/.test(s)) bad.push(`${r}: 자체 풀 함수`);
    if (/Array\.from\(\{\s*length:\s*Math\.min\(limit/.test(s)) bad.push(`${r}: 풀 스캐폴드 인라인`);
  }
  assert.deepEqual(bad, [], `동시성 풀 사본이 남아 있다(v2.575 IMP-08 규약):\n${bad.join('\n')}`);
});

test('③-b limit<=0 이어도 항목을 조용히 건너뛰지 않는다(예전 사본들의 잠재 결함)', async () => {
  const { poolRun, poolSettled } = await import('../src/util/pool.js');
  let n = 0; await poolRun([1, 2, 3], 0, async () => { n += 1; }); assert.equal(n, 3);
  const r = await poolSettled([1, 2], -1, async (x) => x * 2);
  assert.deepEqual(r.map((x) => x.value), [2, 4]);
});

test('④ 호환 재수출이 남아 있다 — 호출부·테스트 하니스가 옛 경로로 가져간다', async () => {
  const reg = await import('../src/collector/registry.js');
  for (const k of ['ipBlockReason', 'ssrfBlockReason', 'ssrfBlockReasonResolved']) assert.equal(typeof reg[k], 'function', k);
  const blk = await import('../src/util/ssrfBlock.js');
  assert.equal(reg.ssrfBlockReason, blk.ssrfBlockReason, '같은 함수여야 한다(사본 금지)');
  const rc = await import('../src/routes/collector.js');
  const dl = await import('../src/collector/denyLog.js');
  assert.equal(rc.getCollectorDenyStats, dl.getCollectorDenyStats);
  const sh = await import('../src/routes/admin/shared.js');
  const an = await import('../src/insights/analysisServers.js');
  assert.equal(sh.analysisServersWithRemote, an.analysisServersWithRemote);
});
