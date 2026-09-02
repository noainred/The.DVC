/**
 * 통합 인시던트 타임라인 — 알림 엔진의 발생/해소 기록 + 현재 진행중 경보 + vCenter 수집 실패를
 * 하나의 시간순 타임라인으로 묶어 "언제 무엇이 터지고 언제 해소됐는지"를 추적한다.
 * 별도 저장 없이 기존 alertStatus()/스냅샷을 조합한다(상태 전이는 알림 엔진이 이미 기록).
 */

import { alertStatus } from '../alerts.js';
import { store } from '../store.js';

const pad2 = (n) => String(n).padStart(2, '0');
/** ms → 서버 로컬 시간 기준 'YYYY-MM-DD'(vmtrack/diff.js slotKey 와 같은 규칙). */
function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const sevRank = (s) => (s === 'critical' ? 3 : s === 'warning' ? 2 : s === 'resolved' ? 1 : 0);

/**
 * @param allowed 범위 제한 계정의 허용 vCenter id Set(전체 범위 계정은 null).
 *   ⚠ 보안 경계(확정 버그, 2026-08-30): insights 라우터의 다른 조회 라우트는 모두 scope 를
 *   적용하는데 이 라우트만 빠져 있어, 범위 제한 계정이 전 사이트의 알람 제목·상세(데이터스토어명·
 *   호스트명 포함)와 vCenter 수집 실패(이름·오류 메시지)를 전부 조회할 수 있었다.
 *   알림 엔진 항목에는 vcenterId 필드가 없어 정밀한 범위 판정이 불가능하므로 chatops.js 와
 *   **같은 보수적 규칙**을 적용한다: 귀속을 알 수 없는 항목은 범위 계정에 노출하지 않는다.
 *   (범위 계정의 타임라인은 자기 vCenter 수집 실패 중심으로 축소된다. 알림 항목에 vcenterId 를
 *   실어 정밀 필터링하는 것은 후속 개선 과제 — 지금은 '덜 보여주는' 쪽이 안전하다.)
 */
export function getIncidents({ limit = 200, allowed = null } = {}) {
  const st = alertStatus();
  const snap = store.get();
  const now = Date.now();
  const alertInScope = (a) => !allowed || (a.vcenterId ? allowed.has(a.vcenterId) : false);

  // 1) 현재 진행중(firing) — 시작시각 기준 미해소 인시던트.
  const open = (st.firing || []).filter(alertInScope).map((f) => ({
    key: f.key, severity: f.severity, title: f.title, detail: f.detail || '',
    since: f.since, startTs: Date.parse(f.since) || now,
    ageMin: Math.round((now - (Date.parse(f.since) || now)) / 60_000),
    status: 'open',
  })).sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.startTs - b.startTs);

  // 2) 최근 이벤트(발생/해소/알림) — 알림 엔진 in-memory 기록.
  const events = (st.recent || []).filter(alertInScope).map((r) => ({
    at: r.at, ts: Date.parse(r.at) || 0, key: r.key, severity: r.severity,
    title: r.title, detail: r.detail || '', channels: r.channels || null,
    kind: r.severity === 'resolved' ? 'resolved' : 'fired',
  }));

  // 3) vCenter 수집 실패도 인시던트로 표면화(알림 채널 미설정이어도 보이게).
  // snap 은 store 전체이므로 여기서 직접 scope 를 적용한다(허용 vCenter 만).
  for (const v of snap.vcenters || []) {
    if (allowed && !allowed.has(v.id)) continue;
    if (v.status === 'unreachable') {
      events.push({ at: new Date(v.receivedAt || now).toISOString(), ts: v.receivedAt || now, key: `vc:${v.id}`, severity: 'critical', title: `vCenter 수집 실패: ${v.name || v.id}`, detail: v.error || '연결 불가', kind: 'fired' });
    }
  }

  const timeline = events.sort((a, b) => b.ts - a.ts).slice(0, limit);

  // 일자별 집계(최근 14일) — 추세 차트용.
  const byDay = new Map();
  for (const e of events) {
    if (e.kind !== 'fired') continue;
    // ⚠ 서버 로컬 시간 기준 일자 — toISOString()(UTC)로 자르면 KST(UTC+9)에서 00:00~08:59 에
    // 발생한 인시던트가 '전날' 칸에 들어간다. 아침 장애가 어제 그래프에 찍히는 오독을 만들고,
    // 같은 화면의 다른 추이(vmtrack slotKey 는 getFullYear/getMonth/getDate = 로컬)와도 어긋난다.
    const day = localDay(e.ts);
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
