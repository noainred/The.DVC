/**
 * bmfolders/usageSrc.js — 사용률 **지표별 출처**(v2.991 · 설계 docs/design/bm-folders §13 ①). 순수.
 *
 * 수집 순서는 이미 지표마다 'OS 먼저 → 비면 iDRAC 텔레메트리 → 그래도 비면 iDRAC 대체 수집' 이다(bmusage/usage.js buildUsage).
 * 이 함수는 그 결과를 화면이 칠할 수 있게 { cpu, mem } 으로 줄인다 — 값: 'os' · 'idrac' · 'vcenter' · null(그 지표 값 없음 · 출처 모름).
 *
 * 근거의 우선순위:
 *  ① 판정의 `srcBy`(최신값 `src_cm` 칸 — 지표별) → 그대로(값이 없는 지표는 null).
 *  ② 칸이 없는 행(구버전 엣지 · 칸 추가 전 마지막 행)은 행 출처(`src` — os · idrac · vcenter)를 값이 있는 지표에 같이 쓴다.
 *  ③ 행 출처가 'mixed' 인데 지표별 칸이 없으면 **지표마다 어디서 왔는지 모른다** — 둘 다 null 이고 `mixed: true`(화면은 '지표마다 다름 · 구분 모름').
 *     예전 판정을 지표에 나눠 붙이지 않는다(I/O 만 iDRAC 인 행도 'mixed' 였다 — 칠하면 틀린 색이 된다).
 */
const OK = new Set(['os', 'idrac', 'vcenter']);
const pick = (v) => (OK.has(v) ? v : null);

export function usageSrcOf(usage) {
  if (!usage || usage.state !== 'ok') return null;
  const hasCpu = usage.cpuPct != null; const hasMem = usage.memPct != null;
  const by = usage.srcBy && typeof usage.srcBy === 'object' ? usage.srcBy : null;
  if (by) return { cpu: hasCpu ? pick(by.cpu) : null, mem: hasMem ? pick(by.mem) : null };
  const s = typeof usage.src === 'string' ? usage.src : '';
  if (OK.has(s)) return { cpu: hasCpu ? s : null, mem: hasMem ? s : null };
  if (s === 'mixed') return { cpu: null, mem: null, mixed: true };
  return null;
}
