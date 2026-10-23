// ESXi 호스트 화면 '이상 우선(트리아지)' 배치의 판정·집계(v2.764, 사용자 요청 "B 안으로 해줘" — 디자인 캔버스 'ESXi 호스트 화면 시안' 시안 B).
// 화면(Hosts.jsx)은 그리기만 하고 확인 대상·CPU 구간·클러스터 타일은 전부 여기서 만든다 — 카드 숫자와 표 필터가 같은 판정을 쓰게.
//
// · CPU 확인 기준은 서버 경보와 같은 '> 90'(server/src/vcenter/soapClient.js high-cpu: `h.cpuUsagePct > 90`)이다 — 사용자 선택.
// · 사용률은 hostUsagePct 하나로 읽는다: 끊김·무응답 호스트의 0 은 '못 읽음'(null)이고, 어느 구간에도 넣지 않고 '미수집' 으로 따로 센다.
// · CPU % 는 사용 MHz ÷ (코어 × 정격 MHz)라 100 을 넘을 수 있다 — '100% 초과' 를 별도 구간으로 둔다.
import { hostUsagePct } from './vcdOverview.js';

export const CPU_ATTENTION_PCT = 90;

const DOWN_STATES = { DISCONNECTED: '끊김', NOT_RESPONDING: '무응답' };

/** CPU 구간(표시 순서 = 낮은 값 → 높은 값, 미수집은 맨 끝). */
export const CPU_BUCKETS = [
  { key: 'lt50', label: '50% 미만' },
  { key: 'b50', label: '50–75%' },
  { key: 'b75', label: '75–90%' },
  { key: 'b90', label: '90–100%' },
  { key: 'over', label: '100% 초과' },
  { key: 'na', label: '미수집' },
];

/** 호스트 CPU 구간 키. 경계: <50 · 50–<75 · 75–90 · >90–100 · >100 · 못 읽음. */
export function cpuBucket(h) {
  const v = hostUsagePct(h, 'cpuUsagePct');
  if (v == null) return 'na';
  if (v > 100) return 'over';
  if (v > CPU_ATTENTION_PCT) return 'b90';
  if (v >= 75) return 'b75';
  if (v >= 50) return 'b50';
  return 'lt50';
}

/**
 * 확인 사유 목록 — 비면 확인 대상이 아니다.
 * kind: 'maint'(점검) · 'down'(끊김·무응답) · 'cpu'(CPU 90% 초과).
 */
export function hostReasons(h) {
  const out = [];
  if (!h) return out;
  if (h.connectionState === 'MAINTENANCE') out.push({ kind: 'maint', label: '점검' });
  if (DOWN_STATES[h.connectionState]) out.push({ kind: 'down', label: DOWN_STATES[h.connectionState] });
  const v = hostUsagePct(h, 'cpuUsagePct');
  if (v != null && v > CPU_ATTENTION_PCT) out.push({ kind: 'cpu', label: `CPU ${v}%` });
  return out;
}

/** 상단 카드 숫자 — 표 필터와 같은 hostReasons 를 센다. */
export function triageCounts(hosts) {
  const c = { maint: 0, down: 0, cpu: 0, attention: 0, total: 0 };
  for (const h of hosts || []) {
    c.total += 1;
    const rs = hostReasons(h);
    if (rs.length) c.attention += 1;
    for (const r of rs) c[r.kind] += 1;
  }
  return c;
}

/** CPU 구간별 호스트 수(CPU_BUCKETS 순서). share 는 가장 큰 구간 대비 비율(0~1, 막대 길이). */
export function cpuDistribution(hosts) {
  const n = Object.fromEntries(CPU_BUCKETS.map((b) => [b.key, 0]));
  for (const h of hosts || []) n[cpuBucket(h)] += 1;
  const max = Math.max(0, ...Object.values(n));
  return CPU_BUCKETS.map((b) => ({ ...b, count: n[b.key], share: max > 0 ? n[b.key] / max : 0 }));
}

/** 클러스터 키 — 여러 vCenter 의 같은 이름 클러스터가 섞이지 않게 vCenter 와 묶는다. 미소속은 'standalone'(트리와 같은 규칙). */
export const clusterKey = (h) => `${h?.vcenterId ?? ''}\t${h?.cluster || 'standalone'}`;

/**
 * 클러스터 타일: 호스트 칸(이름순) + 평균·최대 CPU(읽은 호스트만 — 하나도 없으면 null) + 확인 대상 수.
 * 정렬은 '먼저 볼 것' 순서 — 최대 CPU 내림차순(못 읽은 클러스터는 뒤), 같으면 이름순.
 */
export function clusterTiles(hosts) {
  const map = new Map();
  for (const h of hosts || []) {
    const k = clusterKey(h);
    if (!map.has(k)) map.set(k, { key: k, vcenterId: h.vcenterId ?? '', cluster: h.cluster || 'standalone', hosts: [] });
    map.get(k).hosts.push(h);
  }
  const tiles = [...map.values()].map((t) => {
    const vals = t.hosts.map((h) => hostUsagePct(h, 'cpuUsagePct')).filter((v) => v != null);
    const cells = [...t.hosts]
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map((h) => ({ name: h.name || '', pct: hostUsagePct(h, 'cpuUsagePct'), bucket: cpuBucket(h), state: h.connectionState }));
    return {
      key: t.key,
      vcenterId: t.vcenterId,
      cluster: t.cluster,
      count: t.hosts.length,
      avg: vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : null,
      max: vals.length ? Math.max(...vals) : null,
      attention: t.hosts.filter((h) => hostReasons(h).length > 0).length,
      cells,
    };
  });
  return tiles.sort((a, b) => {
    if (a.max == null && b.max != null) return 1;
    if (b.max == null && a.max != null) return -1;
    if (a.max !== b.max) return b.max - a.max;
    return `${a.vcenterId} ${a.cluster}`.localeCompare(`${b.vcenterId} ${b.cluster}`);
  });
}

/**
 * 표에 보일 호스트.
 *  tab   'attention' → 확인 대상만 · 그 밖 → 전체
 *  focus null | { kind: 'maint'|'down'|'cpu', } | { kind: 'bucket', value: 구간 키 } | { kind: 'cluster', value: clusterKey }
 * focus 는 tab 위에 겹쳐 건다(카드·구간·타일을 누른 결과).
 */
export function filterHosts(hosts, { tab = 'all', focus = null } = {}) {
  let list = hosts || [];
  if (tab === 'attention') list = list.filter((h) => hostReasons(h).length > 0);
  if (!focus) return list;
  if (focus.kind === 'bucket') return list.filter((h) => cpuBucket(h) === focus.value);
  if (focus.kind === 'cluster') return list.filter((h) => clusterKey(h) === focus.value);
  return list.filter((h) => hostReasons(h).some((r) => r.kind === focus.kind));
}

/** 필터 칩 문구. */
export function focusLabel(focus) {
  if (!focus) return '';
  if (focus.kind === 'maint') return '점검 호스트';
  if (focus.kind === 'down') return '끊김·무응답 호스트';
  if (focus.kind === 'cpu') return `CPU ${CPU_ATTENTION_PCT}% 초과`;
  if (focus.kind === 'bucket') return `CPU ${(CPU_BUCKETS.find((b) => b.key === focus.value) || {}).label || focus.value}`;
  if (focus.kind === 'cluster') return `클러스터 ${String(focus.value).replace('\t', ' · ')}`;
  return '';
}
