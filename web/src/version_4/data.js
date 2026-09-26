/**
 * version_4/data.js — 신규 포탈(V4)의 순수 계산 모듈(v2.490).
 *
 * 판정·집계 규칙은 기존 콘솔의 consoleData.js(회귀 테스트로 고정됨)를 그대로 재사용하고, V3 전용(아트보드의 그리드 지도
 * 마커 배치, 임계 눈금)만 여기에 둔다. 값이 없으면 null 을 돌려주고 화면은 '—' 로 그린다(추정 금지).
 */
export {
  WARN_PCT, CRIT_PCT, LEVEL_LABEL, REGION_COLORS, DOMAIN_LABEL,
  levelOf, fmtInt, fmtPct, fmtTB, fmtBytesTB, ageText, tsMs, domainOf, sevRank, severityCounts, alarmCountsByDomain, sortAlarms,
  attentionList, correlateAlarms, siteRows, regionCounts, clusterRows, clusterCountByVc, capacityAdvice, datastoreTypeCounts,
  datastoresOver, ipamTop, ipamStats, svcmonLevel, hostFacilityRows, storageRows, sanCells, sanTotals, pduSummary,
  nsxManagerRows, networkTypeCounts, portgroupsByVc, buildDomainTiles, rowMatches,
} from '../console/consoleData.js';

/** 아트보드 색(라이트 테마 텍스트/막대). 0 정상 · 1 주의 · 2 위험 · null 판정 불가. */
export const LEVEL_BAR = ['#16a34a', '#d97706', '#dc2626'];
export const LEVEL_TEXT = ['#15803d', '#b45309', '#dc2626'];
export const SEV_COLOR = { critical: '#dc2626', warning: '#d97706', info: '#2563eb' };
export const SEV_TEXT = { critical: '#dc2626', warning: '#b45309', info: '#2563eb' };

import { numOrNull as num } from '../numOrNull.js'; // v2.618(ARCH-6): 사본 대신 웹 코어

/** 사용률 → 막대색(아트보드 col()). 판정 불가는 회색. 임계는 consoleData 와 같은 75/90. */
export function barColor(pct) {
  const p = num(pct);
  if (p == null) return '#9aa5b8';
  return p >= 90 ? LEVEL_BAR[2] : p >= 75 ? LEVEL_BAR[1] : LEVEL_BAR[0];
}
export function textColor(pct) {
  const p = num(pct);
  if (p == null) return '#68738a';
  return p >= 90 ? LEVEL_TEXT[2] : p >= 75 ? LEVEL_TEXT[1] : LEVEL_TEXT[0];
}
export const levelBar = (level) => (level == null ? '#9aa5b8' : LEVEL_BAR[level]);
export const levelText = (level) => (level == null ? '#68738a' : LEVEL_TEXT[level]);

/** 온도(°C) 셀 색 — 아트보드 눈금(파랑 <22 · 회색 22–24 · 노랑 24–26 · 빨강 ≥26). 미측정 null. */
export function tempCellColor(t) {
  const v = num(t);
  if (v == null) return null;
  return v >= 26 ? '#dc2626' : v >= 24 ? '#d97706' : v >= 22 ? '#cdd5e0' : '#2563eb';
}
export function tempTextColor(t) {
  const v = num(t);
  if (v == null) return '#68738a';
  return v >= 26 ? '#dc2626' : v >= 24 ? '#b45309' : '#526075';
}

/**
 * 그리드 지도 마커 — 아트보드의 배치 알고리즘을 실 사이트(siteRows 결과: lat/lon/hosts/worst)에 적용한다.
 * 경도 → x%(-180..180), 위도 → y%(75..-60 범위를 0..100% 로), 마커 크기 14~30px(호스트 수 비례),
 * x 가 8% 안에 몰린 사이트는 한 클러스터로 묶어 22px 씩 벌리고 라벨을 3슬롯(아래/위/아래+14)에 배치한다.
 * 좌표 없는 사이트는 제외하고 개수만 돌려준다(추정 좌표 금지).
 */
export function siteMarkers(rows) {
  const ok = (rows || []).filter((s) => num(s.lat) != null && num(s.lon) != null);
  const skipped = (rows || []).length - ok.length;
  const maxH = Math.max(1, ...ok.map((s) => num(s.hosts) || 0));
  const sorted = [...ok].sort((a, b) => a.lon - b.lon);
  const xs = sorted.map((s) => ((s.lon + 180) / 360) * 100);
  const cluster = [];
  let k = -1;
  sorted.forEach((s, i) => { if (i === 0 || xs[i] - xs[i - 1] >= 8) k += 1; cluster.push(k); });
  const sizeOf = {};
  cluster.forEach((c) => { sizeOf[c] = (sizeOf[c] || 0) + 1; });
  const seen = {};
  const markers = sorted.map((s, i) => {
    const hosts = num(s.hosts) || 0;
    const size = 14 + Math.round((hosts / maxH) * 16);
    const idx = seen[cluster[i]] || 0;
    seen[cluster[i]] = idx + 1;
    const n = sizeOf[cluster[i]];
    const dx = n > 1 ? Math.round((idx - (n - 1) / 2) * 22) : 0;
    const x = xs[i];
    const y = ((75 - s.lat) / 135) * 100;
    const slot = idx % 3;
    const labelTop = slot === 0 ? `calc(${y.toFixed(2)}% + ${size / 2 + 4}px)` : slot === 1 ? `calc(${y.toFixed(2)}% - ${size / 2 + 18}px)` : `calc(${y.toFixed(2)}% + ${size / 2 + 18}px)`;
    const worst = num(s.worst);
    const c = s.status && s.status !== 'connected' ? '#dc2626' : barColor(worst);
    // 라벨은 아트보드처럼 짧게 — 'vcenter-'/'vc-' 접두를 떼고(예: vcenter-us-west-01 → us-west-01) 겹침을 줄인다. 전체 이름은 title 에.
    const code = String(s.name || s.id).replace(/^(vcenter|vc)[-_.]/i, '');
    return {
      id: s.id, code, hosts, worst, status: s.status || '',
      left: `calc(${x.toFixed(2)}% + ${dx}px)`, top: `${y.toFixed(2)}%`, labelTop,
      size, fill: `${c}cc`, glow: `${c}66`, labelColor: (worst != null && worst >= 90) || (s.status && s.status !== 'connected') ? '#dc2626' : '#526075',
      title: `${s.name || s.id} · ${s.city || ''} · 호스트 ${hosts} · VM ${num(s.vms) ?? '—'} · 최대 ${worst != null ? `${Math.round(worst)}%` : '—'}${s.status && s.status !== 'connected' ? ` · ${s.status}` : ''}`,
    };
  });
  return { markers, skipped };
}

/** 사이트 표의 알람 수 색(아트보드: ≥15 빨강 · ≥8 주황). */
export const alarmCountColor = (n) => (n >= 15 ? '#dc2626' : n >= 8 ? '#b45309' : '#526075');
