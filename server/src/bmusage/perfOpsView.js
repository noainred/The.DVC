/**
 * bmusage/perfOpsView.js — 이 노드가 수집한 서버 1대의 **변경 이벤트 · 베이스라인 띠 · 구간 비교** 응답(v2.929 예정 · 5단계).
 *   라우트(이 노드 서버)와 엣지 대행 응답(routes/collector.js)이 같은 함수를 쓴다 — 중앙은 엣지 응답을 다시 계산하지 않는다(trendQuery 와 같은 규칙).
 *   데이터: 변경 이벤트(change_event) · 집중 1분 점(focus_sample — 추이 겹침) · 1시간 롤업(베이스라인) · 원시/롤업(비교).
 */
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;
export const CHANGES_MAX_SPAN_MS = 400 * 86_400_000;

/** 창 정규화(없으면 최근 7일 · 미래는 지금 · 뒤집혔으면 null). */
export function changeWindow(q = {}, now = Date.now(), defSpan = 7 * 86_400_000) {
  let b = n(q.to); let a = n(q.from);
  if (b == null || b > now) b = now;
  if (a == null) a = b - defSpan;
  if (!(a < b)) return null;
  if (b - a > CHANGES_MAX_SPAN_MS) a = b - CHANGES_MAX_SPAN_MS;
  return { from: Math.floor(a), to: Math.floor(b) };
}

export async function localPerfOps(mode, { key, q = {}, now = Date.now(), deps = {} } = {}) {
  const agent = config.agent?.name || '';
  const D = {
    settings: async () => (await import('./settings.js')).loadBmUsageSettings(),
    rules: async () => (await import('./perfRules.js')).loadPerfRules(),
    changes: async (o) => (await import('./opsDb.js')).changeEventsRange(o),
    focusRange: async (o) => (await import('./opsDb.js')).focusSamplesInRange(o),
    band: async (o) => (await import('./baseline.js')).readBandSeries(o),
    trend: async (o) => (await import('./trendQuery.js')).trendFor(o),
    outside: async (pts, series) => (await import('./baseline.js')).outsideOf(pts, series),
    compare: async (o) => (await import('./compare.js')).compareFor(o),
    ...deps,
  };
  if (mode === 'changes') {
    const w = changeWindow(q, now);
    if (!w) return { __status: 400, ok: false, reason: 'from 이 to 보다 앞이어야 합니다.' };
    const rules = await D.rules();
    const r = await D.changes({ key, agent, from: w.from, to: w.to, limit: 2_000 });
    if (r == null) return { __status: 503, ok: false, reason: '보관 DB 를 열 수 없습니다.' };
    let focus = null;
    if (String(q.focus || '') === '1') {
      const f = await D.focusRange({ key, agent, from: w.from, to: w.to, limit: 2_000 }).catch(() => null);
      focus = (f || []).map((x) => ({ t: x.minuteTs, sessionId: x.sessionId, verdict: x.verdict, vals: Object.fromEntries(Object.entries(x.vals || {}).filter(([k]) => !k.startsWith('_'))) }));
    }
    return { ok: true, key, ...w, events: r.rows, ...(r.truncated ? { truncated: true } : {}), keepDays: rules.changes?.keepDays ?? 30, ...(focus ? { focus } : {}) };
  }
  if (mode === 'baseline') {
    const [settings, rules] = [await D.settings(), await D.rules()];
    const metric = String(q.metric || 'cpu_pct');
    const band = await D.band({ agent, key, metric, from: q.from, to: q.to, cfg: rules.baseline, intervalMs: settings.intervalMs, now });
    if (!band?.ok) return band;
    // 띠 밖 점은 서버가 판정한다(반증 L3) — 같은 창의 추이 점(trendFor — 화면 선과 같은 응답)을 같은 deviationOf 로 띠에 대 본다.
    let outside = null;
    try {
      const tr = await D.trend({ agent, key, q: { metric, from: band.from, to: band.to }, settings, now });
      outside = tr?.ok ? await D.outside(tr.points || [], band.series || []) : null;
    } catch { outside = null; }
    return { ...band, outside };
  }
  if (mode === 'compare') {
    const [settings, rules] = [await D.settings(), await D.rules()];
    return D.compare({ agent, key, q, settings, rules, now });
  }
  return { __status: 400, ok: false, reason: 'mode' };
}
