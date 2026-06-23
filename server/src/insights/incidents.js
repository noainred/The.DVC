/**
 * 통합 인시던트 타임라인 — 알림 엔진의 발생/해소 기록 + 현재 진행중 경보 + vCenter 수집 실패를
 * 하나의 시간순 타임라인으로 묶어 "언제 무엇이 터지고 언제 해소됐는지"를 추적한다.
 * 별도 저장 없이 기존 alertStatus()/스냅샷을 조합한다(상태 전이는 알림 엔진이 이미 기록).
 */

import { alertStatus } from '../alerts.js';
import { store } from '../store.js';

const sevRank = (s) => (s === 'critical' ? 3 : s === 'warning' ? 2 : s === 'resolved' ? 1 : 0);

export function getIncidents({ limit = 200 } = {}) {
  const st = alertStatus();
  const snap = store.get();
  const now = Date.now();

  // 1) 현재 진행중(firing) — 시작시각 기준 미해소 인시던트.
  const open = (st.firing || []).map((f) => ({
    key: f.key, severity: f.severity, title: f.title, detail: f.detail || '',
    since: f.since, startTs: Date.parse(f.since) || now,
    ageMin: Math.round((now - (Date.parse(f.since) || now)) / 60_000),
    status: 'open',
  })).sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.startTs - b.startTs);

  // 2) 최근 이벤트(발생/해소/알림) — 알림 엔진 in-memory 기록.
  const events = (st.recent || []).map((r) => ({
    at: r.at, ts: Date.parse(r.at) || 0, key: r.key, severity: r.severity,
    title: r.title, detail: r.detail || '', channels: r.channels || null,
    kind: r.severity === 'resolved' ? 'resolved' : 'fired',
  }));

  // 3) vCenter 수집 실패도 인시던트로 표면화(알림 채널 미설정이어도 보이게).
  for (const v of snap.vcenters || []) {
    if (v.status === 'unreachable') {
      events.push({ at: new Date(v.receivedAt || now).toISOString(), ts: v.receivedAt || now, key: `vc:${v.id}`, severity: 'critical', title: `vCenter 수집 실패: ${v.name || v.id}`, detail: v.error || '연결 불가', kind: 'fired' });
    }
  }

  const timeline = events.sort((a, b) => b.ts - a.ts).slice(0, limit);

  // 일자별 집계(최근 14일) — 추세 차트용.
  const byDay = new Map();
  for (const e of events) {
    if (e.kind !== 'fired') continue;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const g = byDay.get(day) || { day, critical: 0, warning: 0 };
    if (e.severity === 'critical') g.critical++; else if (e.severity === 'warning') g.warning++;
    byDay.set(day, g);
  }

  return {
    summary: {
      open: open.length,
      openCritical: open.filter((o) => o.severity === 'critical').length,
      recent24h: events.filter((e) => e.kind === 'fired' && e.ts >= now - 86_400_000).length,
      channelsOn: !!(st.config?.channels?.slack?.enabled || st.config?.channels?.webhook?.enabled),
    },
    open,
    timeline,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    generatedAt: now,
  };
}
