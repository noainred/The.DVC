/**
 * bmSanCompareText.js — 베어메탈 ↔ SAN 비교 화면의 판정 · 문구(순수 · v2.915, 설계 docs/design/bm-san-compare).
 *
 * 규칙: 못 읽은 값은 '—'(단위 없이) · 사유는 서버가 **코드**로 주고 문장은 여기서만 만든다 · 부분 합은 따로 표시 ·
 * 용량 문자열은 bmStorHistoryText.bytesText(현황 탭과 같은 표기 — 복제 금지).
 */
import { numOrNull } from '../../numOrNull.js';
import { bytesText, pctText, WARN_PCT } from './bmStorHistoryText.js';

export const NONE_DC = '__none__';

/** 바이트/초 → 사람이 읽는 전송 속도(10진 — 어레이 · 디스크 업계 표기). null · 빈 값은 '—'. */
export function fmtBps(v) {
  const n = numOrNull(v);
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB/s`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB/s`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB/s`;
  return `${Math.round(n)} B/s`;
}

/** 사용률 색조 — 현황 탭과 같은 경계(90 빨강 · 75 호박). null 은 null. */
export function pctTone(p) {
  const n = numOrNull(p);
  if (n == null) return null;
  return n >= 90 ? 'red' : n >= WARN_PCT ? 'amber' : 'green';
}

/** 용량 사용률 차이(%p) 문장 — 양수면 베어메탈이 더 찼다. */
export function deltaText(deltaPp) {
  const d = numOrNull(deltaPp);
  if (d == null) return '—';
  if (Math.abs(d) < 0.05) return '차이 없음';
  const s = `${Math.abs(d).toFixed(1)}%p`;
  return d > 0 ? `+${s} 베어메탈이 더 찼습니다` : `−${s} SAN 이 더 찼습니다`;
}

/** 전송 속도 배율 문장 — ratio = SAN ÷ 베어메탈. */
export function ratioText(ratio) {
  const r = numOrNull(ratio);
  if (r == null || r <= 0) return '—';
  if (r >= 1) return `${r.toFixed(1)}배 SAN 쪽이 많습니다`;
  return `${(1 / r).toFixed(1)}배 베어메탈 쪽이 많습니다`;
}

/** 사유 코드 → 문장(코드가 아니면 원문 그대로). */
const REASONS = {
  'perf-disabled': 'SAN 스위치 포트 사용량 수집이 꺼져 있어 전송 속도 표본이 없습니다(설정 › 수집 › SAN 스위치 포트 사용량).',
  'perf-unavailable': '포트 사용량 DB 를 열 수 없어 전송 속도를 읽지 못했습니다.',
  'no-switches': '이 범위에 등록된 SAN 스위치가 없어 전송 속도 표본이 없습니다.',
  'serial-unmatched': '스위치 포트 이름에서 이 어레이의 시리얼을 찾지 못했습니다 — 전송 속도를 붙이지 않습니다.',
  'no-samples': '이 구간에 포트 표본이 없습니다(측정 없음 — 트래픽 0 아님).',
  'edge-legacy': '엣지 회신에 I/O 값이 없습니다 — 엣지가 이 기능 이전 버전입니다(용량은 수집됨).',
  unmeasured: '이 구간에 I/O 표본이 없습니다.',
  'db-unavailable': 'I/O 시계열 DB 를 열 수 없습니다.',
  'unknown-server': '등록되지 않은 서버입니다.',
  'no-snapshot': '아직 수집된 스냅샷이 없습니다.',
  'collect-failed': '최근 수집이 실패해 용량을 읽지 못했습니다.',
  'no-capacity': '스냅샷에 용량 값이 없습니다.',
};
export function reasonText(code) {
  if (!code) return '';
  return REASONS[String(code)] || String(code);
}
/** 짧은 배지 문구(표 상태 열). */
export function reasonBadge(code) {
  const c = String(code || '');
  if (!c) return '';
  if (c === 'serial-unmatched') return '시리얼 미대조';
  if (c === 'perf-disabled' || c === 'perf-unavailable' || c === 'no-switches' || c === 'no-samples') return '전송 측정 없음';
  if (c === 'edge-legacy') return '엣지 구버전';
  if (c === 'no-snapshot' || c === 'collect-failed' || c === 'no-capacity') return '용량 측정 없음';
  if (c === 'unmeasured' || c === 'db-unavailable') return '측정 없음';
  return '측정 불가';
}

/** 구분 배지 — 종류별 라벨 · 색 클래스(.badge 톤). */
export function kindTag(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'bm') return { label: '베어메탈', cls: 'teal' };
  if (t === 'powermax') return { label: 'PowerMax', cls: 'blue' };
  if (t === 'vmax') return { label: 'VMAX', cls: 'purple' };
  if (t === 'unity480') return { label: 'Unity', cls: 'gray' };
  if (t === 'powerstore') return { label: 'PowerStore', cls: 'gray' };
  if (t === 'xtremio') return { label: 'XtremIO', cls: 'gray' };
  if (t === 'san') return { label: 'SAN', cls: 'blue' };
  return { label: t || '—', cls: 'gray' };
}

/** 고를 수 있는 SAN 종류 칩(기본 VMAX · PowerMax 켜짐). */
export const SAN_TYPE_CHIPS = Object.freeze([
  { key: 'vmax,powermax', label: 'VMAX · PowerMax', types: ['vmax', 'powermax'] },
  { key: 'unity480', label: 'Unity', types: ['unity480'] },
  { key: 'powerstore', label: 'PowerStore', types: ['powerstore'] },
  { key: 'xtremio', label: 'XtremIO', types: ['xtremio'] },
]);
/** 선택된 칩 집합 → types 쿼리 문자열(비면 기본). */
export function typesQuery(selectedKeys) {
  const set = new Set();
  for (const c of SAN_TYPE_CHIPS) if (selectedKeys?.has?.(c.key)) for (const t of c.types) set.add(t);
  return set.size ? [...set].join(',') : 'vmax,powermax';
}

/** 측정 대수 문구 — '9/10대 측정 합' · 부분 합이면 partial true. */
export function measuredText(io) {
  if (!io || numOrNull(io.measured) == null) return '';
  const m = Number(io.measured); const t = Number(io.total) || 0;
  if (!m) return t ? `${t}대 측정 없음` : '';
  return m < t ? `${m}/${t}대 — 부분 합` : `${m}/${t}대`;
}

/** 그룹 행의 '법인 · 그룹' 문구 — 법인을 골랐으면 '서울 2/3대'(그룹 전체 중 이 법인 대수). */
export function groupMemberText(g, { dcNames = [], totals = null } = {}) {
  const n = Number(g?.servers) || 0;
  if (dcNames.length && totals && numOrNull(totals[g?.name]) != null && Number(totals[g.name]) !== n) {
    return `${dcNames.join(', ')} ${n}/${Number(totals[g.name])}대`;
  }
  return `그룹 · ${n}대`;
}

/** 베어메탈 측정 기준 열 — 'df · I/O 2초 표본 · 3분 전' (ago 는 호출부가 fmtAgo 로 만든다). */
export function bmBasisText({ ago = '', sampleSec = 2, ioMeasured = true } = {}) {
  const parts = ['df'];
  if (ioMeasured) parts.push(`I/O ${Number(sampleSec) || 2}초 표본`);
  if (ago) parts.push(ago);
  return parts.join(' · ');
}
/** SAN 측정 기준 열 — 'Unisphere 41분 전 · 포트 8 · 스위치 2 · 1시간 평균'. */
export function sanBasisText({ capAgo = '', ports = null, switches = null, hours = 1 } = {}) {
  const parts = [];
  parts.push(capAgo ? `Unisphere ${capAgo}` : 'Unisphere —');
  if (numOrNull(ports) != null) parts.push(`포트 ${ports}`);
  if (numOrNull(switches) != null) parts.push(`스위치 ${switches}`);
  parts.push(hours >= 24 && hours % 24 === 0 ? `${hours / 24}일 평균` : `${hours}시간 평균`);
  return parts.join(' · ');
}

/**
 * 비교 표 행 — 베어메탈 그룹 + SAN 어레이를 한 모양으로. 사용률 높은 순(null 은 뒤). 합계 행은 따로(STable 이 맨 아래에 고정한다).
 * @returns {{ rows: object[], totals: object[] }}
 */
export function compareRows({ bm, san, hours = 1, peak = false, dcNames = [], groupTotals = null } = {}) {
  const rows = [];
  for (const g of bm?.groups || []) {
    rows.push({
      key: `g:${g.name}`, kind: 'bm', type: 'bm', name: g.name, sub: Array.isArray(g.members) ? `${g.members.length}대` : '',
      where: groupMemberText(g, { dcNames, totals: groupTotals }),
      totalBytes: numOrNull(g.totalBytes), usedBytes: numOrNull(g.usedBytes), pct: numOrNull(g.usedPct),
      bps: numOrNull(g.io?.totalBps), peakBps: null, partial: !!g.io?.partial, measured: measuredText(g.io),
      okCount: Number(g.ok) || 0, errors: Number(g.errors) || 0, pending: Number(g.pending) || 0,
      reason: g.io && !g.io.measured ? 'unmeasured' : null,
    });
  }
  for (const a of san?.arrays || []) {
    const t = a.throughput;
    rows.push({
      key: `a:${a.id}`, kind: 'san', type: a.type, name: a.name, sub: a.serial ? `시리얼 ${a.serial}` : '',
      where: a.datacenterName || (a.datacenterId || '(법인 미지정)'),
      totalBytes: numOrNull(a.capacity?.totalBytes), usedBytes: numOrNull(a.capacity?.usedBytes), pct: numOrNull(a.capacity?.pct),
      bps: t ? numOrNull(peak ? t.peakAvgBps : t.avgBps) : null, peakBps: t ? numOrNull(t.peakBps) : null, partial: false,
      measured: '', ports: t?.ports ?? null, switches: t?.switches ?? null, capAt: numOrNull(a.capacity?.at),
      reason: a.throughputReason || a.capacityReason || null,
    });
  }
  rows.sort((x, y) => (y.pct ?? -1) - (x.pct ?? -1) || String(x.name).localeCompare(String(y.name), 'ko'));
  const totals = [];
  if (bm?.total && (Number(bm.total.servers) || 0) > 0) {
    totals.push({
      key: 't:bm', kind: 'bm', type: 'bm', name: dcNames.length ? `베어메탈 합계 · ${dcNames.join(', ')}` : '베어메탈 전체 합계', sub: `서버 ${bm.total.servers}대 · 그룹 겹침 없이`,
      where: dcNames.length ? dcNames.join(', ') : '—', totalBytes: numOrNull(bm.total.totalBytes), usedBytes: numOrNull(bm.total.usedBytes), pct: numOrNull(bm.total.usedPct),
      bps: numOrNull(bm.total.io?.totalBps), peakBps: null, partial: !!bm.total.io?.partial, measured: measuredText(bm.total.io), pin: true,
    });
  }
  const arrays = san?.arrays || [];
  if (arrays.length) {
    let used = null; let total = null; let bps = null; let peakSum = null; let m = 0;
    for (const a of arrays) {
      if (numOrNull(a.capacity?.usedBytes) != null) { used = (used ?? 0) + a.capacity.usedBytes; total = (total ?? 0) + a.capacity.totalBytes; }
      const v = a.throughput ? numOrNull(peak ? a.throughput.peakAvgBps : a.throughput.avgBps) : null;
      if (v != null) { bps = (bps ?? 0) + v; m += 1; if (numOrNull(a.throughput.peakBps) != null) peakSum = (peakSum ?? 0) + a.throughput.peakBps; }
    }
    totals.push({
      key: 't:san', kind: 'san', type: 'san', name: 'SAN 전체 합계', sub: `어레이 ${arrays.length}대`, where: `법인 ${new Set(arrays.map((a) => a.datacenterId || '')).size}곳`,
      totalBytes: total, usedBytes: used, pct: used != null && total > 0 ? Math.round((used / total) * 1000) / 10 : null,
      bps, peakBps: peakSum, partial: m > 0 && m < arrays.length, measured: m ? (m < arrays.length ? `${m}/${arrays.length}대 측정 합` : `${m}/${arrays.length}대`) : `${arrays.length}대 측정 없음`, pin: true,
      peakNote: '피크 합 = 상한',
    });
  }
  return { rows, totals };
}

/** 법인 칩 보조 — 점 색(그 법인의 최고 사용률) · 개수 · 제목. */
export function chipMeta(c) {
  const tone = pctTone(c?.maxPct);
  const dot = tone === 'red' ? 'var(--red)' : tone === 'amber' ? 'var(--amber)' : tone === 'green' ? 'var(--green)' : 'var(--text-faint)';
  const count = (Number(c?.servers) || 0) + (Number(c?.arrays) || 0);
  const title = `${c?.name || ''} — 베어메탈 ${Number(c?.servers) || 0}대 · 어레이 ${Number(c?.arrays) || 0}대${numOrNull(c?.maxPct) != null ? ` · 최고 사용률 ${pctText(c.maxPct)}` : ''}`;
  return { dot, count, title, bad: tone === 'red' };
}

/** 상태 줄 — '베어메탈 10대 수집 정상 · 디스크 I/O 측정 9대 · 측정 불가 1대 …' (ago 문자열은 호출부가 만든다). */
export function statusLine({ bm, san, bmAgo = '', sanPerfAgo = '', sanCapAgo = '' } = {}) {
  const parts = [];
  const t = bm?.total;
  if (t) {
    parts.push(`베어메탈 ${t.servers ?? 0}대 수집 정상 ${t.ok ?? 0}${t.errors ? ` · 오류 ${t.errors}` : ''}${t.pending ? ` · 미수집 ${t.pending}` : ''}`);
    if (t.io && numOrNull(t.io.total) != null) parts.push(`디스크 I/O 측정 ${t.io.measured}대${t.io.total > t.io.measured ? ` · 측정 불가 ${t.io.total - t.io.measured}대` : ''}`);
    if (bmAgo) parts.push(`최근 수집 ${bmAgo}`);
  }
  if (san) {
    parts.push(`SAN 어레이 ${(san.arrays || []).length}대`);
    if (sanPerfAgo) parts.push(`포트 표본 ${sanPerfAgo}`);
    if (sanCapAgo) parts.push(`용량 스냅샷 ${sanCapAgo}`);
  }
  return parts.join(' · ');
}

/** 어레이 용량 스냅샷 중 가장 최근 시각(없으면 null). */
export function latestCapAt(arrays) {
  let at = null;
  for (const a of arrays || []) { const v = numOrNull(a?.capacity?.at); if (v != null && (at == null || v > at)) at = v; }
  return at;
}

export { bytesText, pctText };
