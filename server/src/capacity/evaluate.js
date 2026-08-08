/**
 * Capacity Advisor 평가/권고 엔진 — 창(1일/1주/1달)별 실측 통계로 증설/적정/감축을 판정한다.
 *
 * 정직 원칙(사용자 최우선 요구): **권고에는 반드시 실측 근거(p50/p95/max·표본 수)를 붙인다.**
 * 표본이 부족하면 판정하지 않고 '측정 중'이라고 말한다 — 데이터 없는 단정은 하지 않는다.
 *
 * 판정 규칙(지표별, collectors.js 의 warn/bad 임계 기준):
 *  - scale_up   : 창의 p95 ≥ bad  — 지속적으로 위험 구간. 증설(또는 부하 분산)이 필요.
 *  - watch      : 창의 p95 ≥ warn — 경계 구간. 추세를 지켜보고 확장 계획을 준비.
 *  - ok         : warn 미만이되 여유가 크지 않음.
 *  - scale_down : 창의 max 조차 warn 의 절반 미만 — 한 달 내 피크도 임계 근처에 못 갔다면
 *                 리소스가 과다하다는 실측 근거가 된다(감축 후보). '1달' 창에서만 낸다 —
 *                 하루 이틀 한가한 것으로 감축을 권하면 월말 배치 피크에서 사고가 난다.
 *  - info       : 임계가 없는 정보 지표(net_rx 등)는 판정하지 않고 통계만 낸다.
 *
 * 리소스 축(cpu/memory/disk/runtime) 종합 판정 = 그 축 지표들의 최악값.
 * mem_rss 는 임계 대신 **추세(1주 창 선형회귀)** 로 누수 의심을 경고한다.
 */

import { config } from '../config.js';
import { collectorMeta } from './collectors.js';
import { getCapacityDb } from './db.js';

export const WINDOWS = [
  { key: 'day', label: '1일', ms: 24 * 3600_000 },
  { key: 'week', label: '1주', ms: 7 * 24 * 3600_000 },
  { key: 'month', label: '1달', ms: 30 * 24 * 3600_000 },
];

/** 판정에 필요한 최소 표본 — 이보다 적으면 '측정 중'으로 보고 판정을 보류한다. */
const MIN_SAMPLES = { day: 20, week: 60, month: 200 };

const VERDICT_RANK = { scale_up: 4, watch: 3, ok: 2, scale_down: 1, measuring: 0, info: 0 };

/** 단위 표기(권고 문장용). */
function fmtVal(v, unit) {
  if (v == null) return '—';
  if (unit === 'pct') return `${v.toFixed(1)}%`;
  if (unit === 'ms') return `${v.toFixed(0)}ms`;
  if (unit === 'mb') return v >= 1024 ? `${(v / 1024).toFixed(1)}GB` : `${v.toFixed(0)}MB`;
  if (unit === 'ratio') return v.toFixed(2);
  if (unit === 'bps') {
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}Gbps`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}Mbps`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}Kbps`;
    return `${v.toFixed(0)}bps`;
  }
  return String(v);
}

/** 지표 1개 × 창 1개 판정. */
function judgeMetric(meta, winKey, stats) {
  if (!stats || stats.n < (MIN_SAMPLES[winKey] || 20)) {
    return { verdict: 'measuring', reason: stats ? `표본 ${stats.n}개 — 판정에 부족(최소 ${MIN_SAMPLES[winKey]}개)` : '데이터 없음 — 측정 중' };
  }
  if (meta.warn == null || meta.bad == null) {
    return { verdict: 'info', reason: `p50 ${fmtVal(stats.p50, meta.unit)} · p95 ${fmtVal(stats.p95, meta.unit)} · 최대 ${fmtVal(stats.max, meta.unit)} (임계 없는 정보 지표)` };
  }
  const base = `p95 ${fmtVal(stats.p95, meta.unit)} · 최대 ${fmtVal(stats.max, meta.unit)} · 평균 ${fmtVal(stats.avg, meta.unit)} (표본 ${stats.n.toLocaleString()}개${stats.approx ? ' · 시간당 롤업 근사' : ''})`;
  if (stats.p95 >= meta.bad) {
    return { verdict: 'scale_up', reason: `${base} — p95 가 위험 임계(${fmtVal(meta.bad, meta.unit)}) 이상. ${meta.scaleHint}` };
  }
  if (stats.p95 >= meta.warn) {
    return { verdict: 'watch', reason: `${base} — p95 가 경고 임계(${fmtVal(meta.warn, meta.unit)}) 이상. 추세를 지켜보고 확장을 준비하세요.` };
  }
  // 감축 판단은 1달 창 + '피크(max)조차 warn 절반 미만'일 때만 — 짧은 창의 한가함으로 줄이라고 하지 않는다.
  if (winKey === 'month' && stats.max != null && stats.max < meta.warn * 0.5) {
    return { verdict: 'scale_down', reason: `${base} — 한 달 피크(${fmtVal(stats.max, meta.unit)})가 경고 임계(${fmtVal(meta.warn, meta.unit)})의 절반 미만. 이 축은 여유가 커 감축을 검토할 수 있습니다.` };
  }
  return { verdict: 'ok', reason: `${base} — 임계(경고 ${fmtVal(meta.warn, meta.unit)}) 이내.` };
}

/** RSS 추세(1주 창 시간당 avg 선형회귀) — 지속 증가하면 누수/부하 증가 의심 경고. */
function rssTrend(db, k) {
  const since = Date.now() - 7 * 24 * 3600_000;
  const pts = db.history('mem_rss', k, since, 3600_000, 24 * 7);
  if (pts.length < 24) return null;             // 하루치 미만이면 추세를 말하지 않는다
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  const n = pts.length;
  for (const p of pts) { const x = p.ts / 3600_000; sx += x; sy += p.avg; sxx += x * x; sxy += x * p.avg; }
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slopePerHour = (n * sxy - sx * sy) / denom;   // MB/시간
  const perDay = slopePerHour * 24;
  if (perDay > 20) {                                   // 하루 20MB+ 지속 증가만 경고(노이즈 컷)
    return `포탈 RSS 가 최근 1주 동안 하루 약 ${perDay.toFixed(0)}MB 씩 증가 추세입니다(시간당 평균 기준 선형회귀, 표본 ${n}시간). 지속되면 메모리 압박·누수 가능성을 점검하세요.`;
  }
  return null;
}

/**
 * 호스트 1대 평가 — 창(1일/1주/1달) × 지표 전체 + 리소스 축 종합.
 * @returns {{k, meta, fresh, windows:{[win]:{metrics:{[key]:{stats,verdict,reason}}, groups:{[group]:verdict}}}, advice:[]}}
 */
export async function evaluateHost(k) {
  const db = await getCapacityDb();
  const host = db.hosts().find((h) => h.k === k);
  if (!host) return null;
  const now = Date.now();
  const metas = collectorMeta();
  const out = { k, meta: host.meta, lastTs: host.lastTs, fresh: now - host.lastTs < 5 * 60_000, windows: {}, advice: [] };

  for (const w of WINDOWS) {
    const since = now - w.ms;
    const metrics = {};
    const groups = {};
    for (const m of metas) {
      const stats = db.windowStats(m.key, k, since, now);
      const j = judgeMetric(m, w.key, stats);
      metrics[m.key] = { stats, ...j, label: m.label, unit: m.unit, group: m.group, warn: m.warn, bad: m.bad };
      if (m.warn != null) {
        const cur = groups[m.group];
        if (!cur || VERDICT_RANK[j.verdict] > VERDICT_RANK[cur]) groups[m.group] = j.verdict;
      }
    }
    out.windows[w.key] = { metrics, groups };
  }

  // 조언 문장(축별 최종) — '1달' 창을 기본 판단 창으로 삼되, 1일 창의 급성 악화는 우선 알린다.
  const month = out.windows.month;
  const day = out.windows.day;
  const groupLabel = { cpu: 'CPU', memory: '메모리', network: '네트워크', disk: '디스크', runtime: '런타임(이벤트 루프)' };
  for (const [g, label] of Object.entries(groupLabel)) {
    const mv = month.groups[g];
    const dv = day.groups[g];
    // 급성: 1달은 괜찮은데 1일이 scale_up 이면 최근 악화 — 먼저 알린다.
    if (dv === 'scale_up' && mv !== 'scale_up') {
      const worst = Object.values(day.metrics).filter((m) => m.group === g && m.verdict === 'scale_up')[0];
      out.advice.push({ group: g, level: 'scale_up', text: `${label}: 최근 1일 급성 악화 — ${worst?.reason || ''}` });
      continue;
    }
    if (!mv || mv === 'measuring') { out.advice.push({ group: g, level: 'measuring', text: `${label}: 측정 축적 중 — 1달 창 판정에 필요한 표본이 아직 부족합니다.` }); continue; }
    const worst = Object.values(month.metrics).filter((m) => m.group === g && m.verdict === mv)
      .sort((a, b) => (b.stats?.p95 || 0) - (a.stats?.p95 || 0))[0];
    if (mv === 'scale_up') out.advice.push({ group: g, level: 'scale_up', text: `${label} 증설 필요: ${worst?.reason || ''}` });
    else if (mv === 'watch') out.advice.push({ group: g, level: 'watch', text: `${label} 경계: ${worst?.reason || ''}` });
    else if (mv === 'scale_down') out.advice.push({ group: g, level: 'scale_down', text: `${label} 감축 검토 가능: ${worst?.reason || ''}` });
    else out.advice.push({ group: g, level: 'ok', text: `${label} 적정: ${worst?.reason || ''}` });
  }

  const rssNote = rssTrend(db, k);
  if (rssNote) out.advice.push({ group: 'memory', level: 'watch', text: rssNote });

  return out;
}

/** 전 호스트 요약(목록 화면) — 호스트별 1달 창 축 종합만 가볍게. */
export async function summarizeHosts() {
  const db = await getCapacityDb();
  const now = Date.now();
  const metas = collectorMeta().filter((m) => m.warn != null);
  return db.hosts().map((h) => {
    const groups = {};
    for (const m of metas) {
      const stats = db.windowStats(m.key, h.k, now - 30 * 24 * 3600_000, now);
      const j = judgeMetric(m, 'month', stats);
      const cur = groups[m.group];
      if (!cur || VERDICT_RANK[j.verdict] > VERDICT_RANK[cur]) groups[m.group] = j.verdict;
    }
    return { k: h.k, meta: h.meta, lastTs: h.lastTs, fresh: now - h.lastTs < 5 * 60_000, groups };
  });
}

export { fmtVal };
