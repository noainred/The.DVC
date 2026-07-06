/**
 * Ping 모니터링 조회 서비스 — 대상별 현재 상태(최신 RTT + baseline 대비 분류)와
 * 시계열(다운샘플 + 버킷별 색상 상태)을 제공한다.
 *
 * 상태 분류(파이썬 원본의 baseline 편차 규칙 이식):
 *   down : 무응답(최신 샘플 ok=false)
 *   crit : rtt ≥ baseline × 1.5 (기준 대비 +50% 이상)
 *   warn : rtt ≥ baseline × 1.2 (기준 대비 +20% 이상)
 *   ok   : 그 외 정상
 *   unknown: 샘플/기준 없음
 * baseline은 대상의 수동 baselineMs가 있으면 그 값, 없으면 최근 OK 샘플의 중앙값(자동).
 */

import { getPingDb } from './db.js';
import { listTargets, getTarget } from './store.js';

const WARN = 1.2;
const CRIT = 1.5;
const BASELINE_SAMPLES = 200; // 자동 baseline 산출에 쓰는 최근 OK 샘플 수(인덱스로 저렴)

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function baselineOf(db, target) {
  if (target.baselineMs) return { baseline: target.baselineMs, auto: false };
  const recent = db.recentOkRtt(target.id, BASELINE_SAMPLES);
  const med = median(recent);
  return { baseline: med == null ? null : Number(med.toFixed(2)), auto: true };
}

function classify(rtt, ok, baseline) {
  if (!ok || rtt == null) return 'down';
  if (baseline == null) return 'ok';
  if (rtt >= baseline * CRIT) return 'crit';
  if (rtt >= baseline * WARN) return 'warn';
  return 'ok';
}

/** 전체 대상의 현재 상태 요약(대시보드 상단 카드/목록용). */
export async function statusAll() {
  const db = await getPingDb();
  const targets = listTargets();
  const rows = [];
  for (const t of targets) {
    const latest = db.latest(t.id);
    const { baseline, auto } = await baselineOf(db, t);
    const status = latest ? classify(latest.rtt, latest.ok, baseline) : 'unknown';
    rows.push({
      id: t.id, name: t.name, host: t.host, port: t.port, kind: t.kind, enabled: t.enabled, note: t.note,
      rtt: latest ? latest.rtt : null, ok: latest ? latest.ok : null, lastTs: latest ? latest.ts : null,
      baseline, baselineAuto: auto, status,
    });
  }
  const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  return { targets: rows, counts, total: rows.length };
}

/** 단일 대상의 시계열(다운샘플). rangeMs 범위를 최대 points개 버킷으로 나눠 avg/min/max/loss + 상태. */
export async function seriesOf(id, { rangeMs = 6 * 3_600_000, points = 240 } = {}) {
  const t = getTarget(id);
  if (!t) return { ok: false, reason: '없는 대상' };
  const db = await getPingDb();
  const now = Date.now();
  const since = now - rangeMs;
  // 버킷 크기: 범위/포인트, 최소 1초. 최근 points개 버킷만.
  const bucketMs = Math.max(1000, Math.round(rangeMs / points));
  const raw = db.history(t.id, since, bucketMs, points);
  const { baseline, auto } = await baselineOf(db, t);
  const series = raw.map((b) => ({
    ts: b.ts, avg: b.avg, min: b.min, max: b.max, loss: b.loss, n: b.n,
    status: b.loss >= 1 ? 'down' : classify(b.avg, b.avg != null, baseline),
  }));
  const meta = db.meta(t.id);
  return { ok: true, target: { id: t.id, name: t.name, host: t.host, port: t.port, kind: t.kind }, baseline, baselineAuto: auto, bucketMs, series, meta };
}
