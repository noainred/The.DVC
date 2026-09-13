/**
 * compareMatrixText.js — 비교 매트릭스의 **표시·색·정렬 판정**(순수, v2.499).
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더 테스트가 불가 — 판정은 여기서 회귀로 고정한다.
 *
 * 사용자 요구: 가로축 vCenter · 세로축 클러스터(또는 스토리지)인 매트릭스로 '같은 역할의 자원이
 * 사이트마다 어떤 상태인가' 를 비교한다. 색은 **비교 대상 안에서의 상대 위치**로 칠한다 —
 * 절대 임계(예 80%)만 쓰면 전 사이트가 한가한 날에는 아무 것도 눈에 띄지 않고, 반대로 전부
 * 바쁜 날에는 전부 빨개져 비교가 안 된다.
 */

/** 셀 값 표기 — 없는 조합은 '—'(0 으로 채우지 않는다). */
export function cellText(value, metric) {
  if (value == null) return '—';
  const unit = metric?.unit || '';
  if (typeof value !== 'number') return `${value}${unit}`;
  const abs = Math.abs(value);
  const s = abs >= 1000 ? value.toLocaleString() : String(Math.round(value * 10) / 10);
  return `${s}${unit}`;
}

/** 정렬용 수치(없으면 null — 방향과 무관하게 뒤로 보낸다는 공용 표 규약과 맞춘다). */
export const cellSort = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 색 판정. higher='bad' 면 큰 값이 위험(빨강), 'good' 이면 큰 값이 양호(초록), 'neutral' 은 색 없음.
 * 상대 위치는 그 행이 아니라 **표 전체(보이는 셀)** 기준이다 — 행마다 기준이 다르면 사이트 간
 * 비교가 아니라 행 내부 순위가 되어 사용자가 원한 '어느 사이트가 문제인가' 를 알 수 없다.
 * 퍼센트 지표는 절대 기준도 함께 본다(90% 이상은 표 안에서 최저여도 빨강).
 */
export function cellColor(value, metric, stats) {
  if (value == null || typeof value !== 'number') return null;
  const dir = metric?.higher;
  if (dir === 'neutral') return null;
  const isPct = metric?.unit === '%';
  if (isPct && dir === 'bad') {
    if (value >= 90) return 'red';
    if (value >= 75) return 'amber';
  }
  const { min, max } = stats || {};
  if (min == null || max == null || max === min) return null;
  const pos = (value - min) / (max - min);                 // 0(최저) ~ 1(최고)
  const risk = dir === 'bad' ? pos : 1 - pos;
  if (risk >= 0.8) return 'red';
  if (risk >= 0.55) return 'amber';
  if (risk <= 0.2) return 'green';
  return null;
}

/** 보이는 셀들의 min/max — cellColor 의 상대 기준. rows 는 서버 응답 형태. */
export function metricStats(rows, metricKey) {
  let min = null; let max = null; let n = 0;
  for (const r of rows || []) {
    for (const vcId of Object.keys(r.cells || {})) {
      const v = r.cells[vcId]?.[metricKey];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      n += 1;
      if (min == null || v < min) min = v;
      if (max == null || v > max) max = v;
    }
  }
  return { min, max, n };
}

/** 행 정렬 — 지표 값 기준(없는 셀은 뒤로). by='total' 이면 행 합계, vCenter id 면 그 열 기준. */
export function sortRows(rows, metricKey, { by = 'total', dir = 'desc' } = {}) {
  const val = (r) => {
    const v = by === 'total' ? r.total?.[metricKey] : r.cells?.[by]?.[metricKey];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = val(a); const bv = val(b);
    if (av == null && bv == null) return a.name.localeCompare(b.name, undefined, { numeric: true });
    if (av == null) return 1;          // null 은 방향과 무관하게 뒤로
    if (bv == null) return -1;
    return (av - bv) * sign || a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

/** vCenter 축(지표 × vCenter) — `/vcenters` 응답을 전치해 같은 표 모양으로 만든다. */
export function vcenterRows(vcenters, metrics) {
  const cols = (vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id }));
  const rows = (metrics || []).map((m) => {
    const cells = {};
    for (const v of vcenters || []) {
      const raw = v.metrics?.[m.key];
      if (raw == null) continue;                      // 없는 값은 셀을 만들지 않는다
      cells[v.id] = { [m.key]: typeof raw === 'number' ? raw : Number(raw) };
    }
    return { name: m.label, metric: m, cells, total: {}, vcenters: Object.keys(cells).length };
  });
  return { vcenters: cols, rows };
}

/** 절단·모집단 안내 문구(없으면 빈 문자열). */
export function truncatedNote(d, axisLabel) {
  if (!d?.truncated) return '';
  return `${axisLabel} ${d.rowCount}개 중 규모 상위 ${d.rows?.length ?? 0}개만 표시합니다(나머지 ${d.truncatedRows}개 생략 — 상한 ${d.maxRows}).`;
}

/**
 * 희소도 안내 — 대부분의 행이 한 vCenter 에만 있으면 매트릭스가 대각선이 되어 '사이트 간 비교' 가
 * 성립하지 않는다. 그것은 결함이 아니라 **이름 규약이 사이트별로 다르다**는 사실이므로, 화면이
 * 그 사실을 밝히고 무엇을 대신 보면 되는지 알려준다(값이 비는 이유를 단정하지 않는다는 규칙).
 * 반환 null 이면 안내할 것이 없다(여러 사이트에 걸친 행이 충분히 있다).
 */
export function sparsityNote(rows, axisLabel) {
  const list = (rows || []).filter((r) => r && typeof r.vcenters === 'number');
  if (list.length < 3) return null;
  const shared = list.filter((r) => r.vcenters >= 2).length;
  if (shared / list.length >= 0.2) return null;
  return `이 환경에서는 ${axisLabel} 이름이 사이트마다 달라 대부분의 행이 한 vCenter 에만 있습니다`
    + `(여러 vCenter 에 걸친 행 ${shared}/${list.length}개). 같은 역할의 자원을 나란히 비교하려면 이름 규약을 맞춰야 하고,`
    + ` 그 전에는 열 머리글을 눌러 사이트별 순위로, '합계' 열로 규모를 비교하세요.`;
}

/** 셀 툴팁 — 그 셀이 무엇의 합인지 밝힌다. */
export function cellTitle({ rowName, vcName, metric, value, cell }) {
  const parts = [`${rowName} · ${vcName}`, `${metric?.label || ''} ${cellText(value, metric)}`];
  if (cell?.hosts != null) parts.push(`호스트 ${cell.hosts} · VM ${cell.vms ?? '—'}(On ${cell.vmsOn ?? '—'})`);
  if (cell?.count != null) parts.push(`데이터스토어 ${cell.count}개 합산 · 용량 ${cellText(cell.capacityTB, { unit: ' TB' })} · 여유 ${cellText(cell.freeTB, { unit: ' TB' })}`);
  if (metric?.help) parts.push(metric.help);
  return parts.filter(Boolean).join('\n');
}
