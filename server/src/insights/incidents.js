/**
 * 통합 인시던트 타임라인 — 알림 엔진의 발생/해소 기록 + 현재 진행중 경보 + vCenter 수집 실패를
 * 하나의 시간순 타임라인으로 묶어 "언제 무엇이 터지고 언제 해소됐는지"를 추적한다.
 * 별도 저장 없이 기존 alertStatus()/스냅샷을 조합한다(상태 전이는 알림 엔진이 이미 기록).
 */

import { alertStatus } from '../alerts.js';
import { store } from '../store.js';
import { dayKey } from '../util/dayKey.js';

/** ms → 포탈 오프셋(기본 KST) 기준 'YYYY-MM-DD'. v2.583 #25: 프로세스 TZ(패키지 유닛은 지정하지 않는다)를 믿지 않는다. */
const localDay = (ts) => dayKey(ts);

/*
 * v2.632(감사 AX2-2632-05): vCenter 수집 실패의 **발생 시각**. 예전엔 `receivedAt || now` 라, receivedAt 이 없는 직접 수집
 *   vCenter 는 10일째 실패 중이어도 조회할 때마다 '지금' 발생한 사건이 되어 recent24h 에 매번 들고 일자별 집계는 오늘 칸만
 *   늘었다(지어낸 시각). 근거가 있는 시각만 쓴다 — ① staleSince(마지막 정상 수집 시각 — 실패는 그 뒤에 시작됐다)
 *   ② authStopped.since(인증 정지 시작) ③ receivedAt(엣지가 그 상태를 보고한 시각). 모르면 null(화면 '시각 미상').
 */
export function vcFailureStartTs(v) {
  const num = (x) => { if (x == null || x === '') return null; const n = typeof x === 'number' ? x : /^\d+$/.test(String(x)) ? Number(x) : Date.parse(String(x)); /* 숫자 문자열을 Date.parse 에 넘기지 않는다(v2.562) */ return Number.isFinite(n) && n > 0 ? n : null; };
  return num(v?.staleSince) ?? num(v?.authStopped?.since) ?? num(v?.receivedAt) ?? null;
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
      const t = vcFailureStartTs(v);
      events.push({ at: t == null ? null : new Date(t).toISOString(), ts: t, ...(t == null ? { timeUnknown: true } : {}), key: `vc:${v.id}`, severity: 'critical', title: `vCenter 수집 실패: ${v.name || v.id}`, detail: v.error || '연결 불가', kind: 'fired' });
    }
  }

  // 시각 미상(ts=null)은 방향과 무관하게 뒤로 — 지어낸 '지금' 으로 맨 위에 올리지 않는다.
  const timeline = events.sort((a, b) => (a.ts == null) - (b.ts == null) || (b.ts ?? 0) - (a.ts ?? 0)).slice(0, limit);

  // 일자별 집계(최근 14일) — 추세 차트용.
  const byDay = new Map();
  for (const e of events) {
    if (e.kind !== 'fired') continue;
    if (e.ts == null) continue; // v2.632 AX2-2632-05: 시각 미상은 어느 날짜 칸에도 넣지 않는다(오늘 칸만 부풀린다)
    // ⚠ 포탈 오프셋(KST) 기준 일자 — toISOString()(UTC)로 자르면 KST 00:00~08:59 에 발생한 인시던트가
    // '전날' 칸에 들어간다. v2.583: 서버 로컬 getter 도 쓰지 않는다(UTC 서버에서 같은 오독이 재발했다).
    const day = localDay(e.ts);
    const g = byDay.get(day) || { day, critical: 0, warning: 0 };
    if (e.severity === 'critical') g.critical++; else if (e.severity === 'warning') g.warning++;
    byDay.set(day, g);
  }

  return {
    summary: {
      open: open.length,
      openCritical: open.filter((o) => o.severity === 'critical').length,
      recent24h: events.filter((e) => e.kind === 'fired' && e.ts != null && e.ts >= now - 86_400_000).length,
      // v2.632 AX2-2632-05: 발생 시각을 모르는 인시던트 수(최근 24시간·일자별 집계에서 뺐다 — 빼면 개수를 밝힌다).
      timeUnknown: events.filter((e) => e.ts == null).length,
      channelsOn: !!(st.config?.channels?.slack?.enabled || st.config?.channels?.webhook?.enabled),
    },
    open,
    timeline,
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    generatedAt: now,
  };
}
