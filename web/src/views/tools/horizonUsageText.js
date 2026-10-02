/**
 * views/tools/horizonUsageText.js — Horizon 앱·데스크톱별 사용 현황의 **판정·문구**(v2.684, 순수 모듈).
 *
 * 서버 `horizon/appUsage.js`(해석)·`appUsageReport.js`(보고서)가 판정하고, 여기는 문장만 만든다.
 *
 * ── 정직성 규칙 ────────────────────────────────────────────────────────────────
 * 1. **누적은 하한이다** — 주기 폴링이라 주기보다 짧은 세션은 잡히지 않는다. 주기 숫자는 서버 값만 쓴다.
 * 2. **수집이 없던 날은 0명이 아니다**(`users === null` → '수집 없음').
 * 3. **어느 앱인지 모르는 팜 세션은 '팜 단위(앱 미구분)'** 로 말한다 — 해석 근거를 숨기지 않는다.
 * 4. 문구에 백틱 금지(BoldText 는 별표 두 개 강조만 해석한다 — 화면 문구 백틱 스윕이 고정한다).
 */
import { intervalText } from './horizonSessionText.js';

/** 해석 근거 → 문구. 키 집합은 서버 `appUsage.BASES` 와 1:1(테스트가 대조). */
export const BASIS_TEXT = Object.freeze({
  'session-field': '세션이 보고한 앱 이름',
  'app-pool': '앱 풀 이름(카탈로그)',
  'app-pool-id': '앱 풀 ID(카탈로그에 없음)',
  'farm-single-app': '팜에 앱이 하나뿐이라 그 앱',
  farm: '팜까지만 앎(앱 미구분)',
  'farm-id': '팜 ID(카탈로그에 없음 · 앱 미구분)',
  'desktop-pool': '데스크톱 풀 이름(카탈로그)',
  'desktop-pool-id': '데스크톱 풀 ID(카탈로그에 없음)',
  unknown: '풀 정보 없음',
});
export const basisText = (b) => BASIS_TEXT[b] || (b ? String(b) : '—');

export const KIND_TEXT = Object.freeze({ app: '앱', desktop: '데스크톱', farm: '팜(앱 미구분)', unknown: '미확인' });
export const kindText = (k) => KIND_TEXT[k] || (k ? String(k) : '—');

/** 화면 기간 선택지. 1 = 오늘(포탈 시각). 서버 상한(maxDays)을 넘는 것은 감춘다. */
export const USAGE_DAYS = Object.freeze([1, 7, 30, 90]);
export const daysLabel = (d) => (Number(d) === 1 ? '오늘' : `${d}일`);

/** 누적이 하한이라는 문장 — 주기는 서버 값. */
export function lowerBoundNote(intervalMs) {
  const iv = intervalText(intervalMs);
  return `누적 수치는 **${iv}마다 세션 목록을 읽어 본 결과**입니다. 그 사이에 열고 닫은 짧은 실행은 잡히지 않으므로 실제보다 **작거나 같은 값(하한)** 입니다.`;
}

/** 서버별 해석 근거 합계 → 한 줄 요약(어느 근거로 서비스 이름을 알았나). */
export function basisSummary(serverMeta) {
  const sum = {};
  for (const s of serverMeta || []) {
    const b = s?.usageMeta?.basisCounts || {};
    for (const [k, v] of Object.entries(b)) sum[k] = (sum[k] || 0) + (Number(v) || 0);
  }
  const total = Object.values(sum).reduce((a, v) => a + v, 0);
  if (!total) return null;
  const parts = Object.entries(sum).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${basisText(k)} ${v}건`);
  const farmOnly = (sum.farm || 0) + (sum['farm-id'] || 0);
  return {
    text: `최근 수집의 세션 ${total}건을 이렇게 해석했습니다 — ${parts.join(' · ')}.`,
    farmOnly,
    farmNote: farmOnly > 0
      ? `**${farmOnly}건은 어느 앱인지 알 수 없어 팜 단위로 셌습니다.** 이 커넥션 서버의 세션 응답에 실행한 앱 이름이 없고 그 팜에 앱이 여럿이기 때문입니다(이름을 지어내지 않습니다).`
      : null,
  };
}

/** 카탈로그(앱·데스크톱 풀·팜 목록) 상태 → 안내 줄 목록. 비면 []. */
export function catalogNotes(serverMeta) {
  const out = [];
  for (const s of serverMeta || []) {
    const c = s?.usageMeta?.catalog;
    const who = s?.name || s?.serverId || '서버';
    if (!c) continue;
    const errs = Object.entries(c.errors || {}).filter(([, v]) => v);
    if (errs.length) out.push(`${who}: 목록 일부를 읽지 못했습니다(${errs.map(([k, v]) => `${k} ${v}`).join(' · ')}) — 그 종류는 ID 로 표시될 수 있습니다.`);
    const tr = Object.keys(c.truncated || {}).filter((k) => c.truncated[k]);
    if (tr.length) out.push(`${who}: 목록이 상한에서 잘렸습니다(${tr.join(', ')}) — 일부 이름이 ID 로 보일 수 있습니다.`);
  }
  return out;
}

/**
 * 서비스 표 '지금 접속 중' 칸.
 *  · 최신 수집에 성공한 서버가 0대면 '—'(지금을 모른다 — 0 이 아니다).
 *  · 최신 수집에 그 서비스 세션이 없으면 0.
 *  · 세션은 있는데 상태를 못 읽었으면 '—'.
 */
export function nowText(s, nowServers) {
  if (!Number(nowServers)) return '—';
  if (!s || (s.connectedUsersNow == null && !s.sessionsNow)) return '0';
  if (s.connectedUsersNow == null) return '—';
  return `${s.connectedUsersNow}${s.nowBySum ? '+' : ''}`;
}
/** '+' 표지의 뜻(여러 서버에서 같은 서비스 — 서버별 고유의 합이라 같은 사람이 두 번 셀 수 있다). */
export const NOW_SUM_NOTE = '+ 는 같은 서비스가 여러 커넥션 서버에 있어 서버별 접속 사용자를 더한 값이라는 뜻입니다(같은 사람이 두 팟에 동시에 있으면 두 번 셉니다).';

/** 날짜 행 → 차트·표 문구. */
export function dayCell(d) {
  if (!d) return '—';
  if (d.users == null) return '수집 없음';
  return `${d.users}명${d.partial ? ' (일부 수집)' : ''}${d.today ? ' (진행 중)' : ''}`;
}

/** 기간 요약 문장(KPI 아래). */
export function coverageNote(rep) {
  const t = rep?.totals || {};
  const parts = [];
  if (t.daysNoData) parts.push(`수집이 없던 날 **${t.daysNoData}일**은 0명이 아니라 '수집 없음' 입니다`);
  if (t.daysPartial) parts.push(`일부만 수집된 날 ${t.daysPartial}일은 그날 값이 실제보다 작을 수 있습니다`);
  if (rep?.firstDay && rep?.fromDay && rep.firstDay > rep.fromDay) parts.push(`누적 기록은 ${rep.firstDay}부터 있습니다(그 전은 기록 없음)`);
  return parts.length ? `${parts.join(' · ')}.` : '';
}

/** 상한으로 자른 목록 안내. */
export function omittedNote(rep) {
  const p = [];
  if (rep?.usersOmitted) p.push(`사용자 ${rep.usersOmitted}명`);
  if (rep?.servicesOmitted) p.push(`서비스 ${rep.servicesOmitted}개`);
  return p.length ? `표 상한으로 ${p.join(' · ')}을(를) 표시하지 않았습니다(CSV 에는 모두 들어갑니다).` : '';
}

/** 빈 상태 — 왜 비었는지를 나눠 말한다(v2.517 규약). */
export function emptyNote(rep) {
  if (!rep) return '';
  if (rep.available === false) return 'Horizon 세션 DB 를 쓸 수 없어 누적을 보여 드릴 수 없습니다.';
  if (rep.settings && rep.settings.enabled === false && !(rep.services || []).length) return 'Horizon 실시간 사용자 수집이 꺼져 있습니다 — 설정에서 켜면 이 날부터 누적이 쌓입니다.';
  if (!(rep.services || []).length) {
    // v2.686 HZ-08: 세션을 읽은 서버가 하나도 없으면 '기다리면 쌓인다' 가 아니다 — 실장비 7.13.1 은 세션 경로가 404 라
    //   영원히 쌓이지 않는다. 기다리라는 말은 최근 수집 성공이 있을 때만 한다.
    const meta = Array.isArray(rep.serverMeta) ? rep.serverMeta : [];
    if (meta.length && !meta.some((m) => m?.ok)) {
      // 모든 서버가 404 일 때만 '기다려도 안 된다' 의 원인을 404 로 말한다 — 섞여 있으면 고칠 수 있는 실패를 가린다(WEB2686-04).
      if (meta.every((m) => m?.kind === 'no-endpoint')) return '세션을 읽은 Horizon 서버가 없어 누적이 쌓이지 않습니다 — 커넥션 서버가 세션 목록 API 를 제공하지 않습니다(404). 기다려도 채워지지 않습니다. 설정 › Horizon 연결 서버의 연결 테스트로 기능별 지원 여부를 확인하세요.';
      const nEp = meta.filter((m) => m?.kind === 'no-endpoint').length;
      return `세션을 읽은 Horizon 서버가 없어 누적이 쌓이지 않습니다 — 실시간 사용자 표의 서버별 사유를 확인하세요${nEp ? `(그중 ${nEp}대는 세션 API 가 없는 버전 — 404)` : ''}.`;
    }
    return '이 기간에 기록된 사용이 없습니다 — 수집이 막 시작됐다면 다음 주기부터 쌓입니다.';
  }
  return '';
}

/** 다운로드 파일 경로(서버 CSV). */
export const usageCsvPath = (days, serverId) => `/tools/horizon-sessions/usage.csv?days=${encodeURIComponent(days)}${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ''}`;
