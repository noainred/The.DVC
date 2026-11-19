/**
 * v2.929(리눅스 성능 5단계) — 집중 모니터링 세션 요약(순수). focus/run.js 에서 나눴다: 데모 시드(mock/demo/baremetal.js)가
 * 요약 함수만 쓰는데 run.js 를 import 하면 run.js ↔ mock 순환이 생긴다(arch2579 SCC 상한). run.js 는 그대로 재수출한다.
 */
import { numOrNull } from '../../util/numOrNull.js';

const n = numOrNull;

/** 세션 요약(순수 — 테스트 대상). 판정 변화 · 지표 최고값 · 원인 후보(분마다 1위 횟수) · 결측 · 조치 제안 code. */
export function summarizeFocus(samples = [], { before = null, hasOs = true, hasIdrac = false } = {}) {
  const verdicts = samples.map((s) => s.verdict || null);
  const judged = verdicts.filter(Boolean);
  const RANK = { bottleneck: 6, saturated: 5, errors: 4, warn: 3, partial: 2, stale: 1, unknown: 1, ok: 0 };
  const worst = judged.reduce((a, v) => ((RANK[v] ?? 0) > (RANK[a] ?? -1) ? v : a), null);
  const maxBy = {};
  for (const s of samples) {
    for (const [c, v] of Object.entries(s.vals || {})) {
      if (c.startsWith('_')) continue;
      const x = n(v?.peak) ?? n(v?.avg);
      if (x == null) continue;
      if (!maxBy[c] || x > maxBy[c].value) maxBy[c] = { value: x, at: s.minuteTs };
    }
  }
  const cand = new Map();
  for (const s of samples) {
    const io1 = s.snap?.ioTop?.[0]?.name; const cpu1 = s.snap?.cpuTop?.[0]?.name;
    for (const [nm, k] of [[io1, 'io'], [cpu1, 'cpu']]) {
      if (!nm) continue;
      const c = cand.get(nm) || { name: String(nm).slice(0, 32), io: 0, cpu: 0 };
      c[k] += 1; cand.set(nm, c);
    }
  }
  const withSnap = samples.filter((s) => s.snap && !s.snap.error).length;
  const focusRes = (() => {
    const cnt = {};
    for (const s of samples) for (const [r, v] of Object.entries(s.vals?._res || {})) if (['bottleneck', 'saturated', 'errors'].includes(v)) cnt[r] = (cnt[r] || 0) + 1;
    return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  })();
  // 순위는 문제가 된 자원에 맞춘다 — 디스크 · 네트워크면 I/O 1위 횟수 먼저, CPU 면 CPU 1위 먼저(그 밖은 합). 여전히 상관이다(Chromium 판독: 디스크 포화 세션에서
  //   CPU 1위를 늘 차지한 DB 프로세스가 I/O 1위 0회인데도 후보 첫째로 나왔다).
  const key = (c) => (focusRes === 'disk' || focusRes === 'net' ? [c.io, c.cpu] : focusRes === 'cpu' ? [c.cpu, c.io] : [c.io + c.cpu, 0]);
  const candidates = [...cand.values()].sort((a, b) => { const ka = key(a); const kb = key(b); return (kb[0] - ka[0]) || (kb[1] - ka[1]); }).slice(0, 3).map((c) => ({ ...c, of: withSnap }));
  const actions = [];
  if (focusRes === 'disk') actions.push('check-batch', 'tuning-dirty');
  if (focusRes === 'cpu') actions.push('check-batch', 'check-runq');
  if (focusRes === 'mem') actions.push('check-memory');
  if (focusRes === 'net') actions.push('check-network');
  if (worst && worst !== 'ok') actions.push('enable-auto-focus');
  return {
    verdicts, verdictFrom: judged[0] || null, verdictTo: judged.at(-1) || null, worst, focusRes,
    maxBy, candidates, withSnap,
    missOs: hasOs ? samples.filter((s) => s.missOs).length : null, missIdrac: hasIdrac ? samples.filter((s) => s.missIdrac).length : null,
    before: before || null, actions: [...new Set(actions)],
  };
}
