/**
 * vmSeriesText.js — 실시간(20초) 스파이크 수집 화면의 판정·문구(순수, v2.510).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 문구·판정은 여기서 회귀로 고정한다(accessDeniedText·loadState 관례).
 * 정직 규약: 수집 주기·버퍼·임계 숫자는 **서버가 준 값**으로만 문장을 만든다(하드코딩 금지).
 * '스파이크 0' 과 '미측정' 을 같은 말로 덮지 않는다.
 */

export const TEMPLATES = [
  { k: 'vcenter', label: 'vCenter Only', desc: '기존 리포트 — vCenter 롤업 통계만(각 점 = 롤업 간격 평균)' },
  { k: 'both', label: 'Local + vCenter', desc: 'vCenter 롤업(평균·p95·곡선) + 포탈 로컬 20초 수집(임계 이상 순간·최대·스파이크 빈도·지속·커버리지)을 각각 표시' },
];

export const ESXI_REALTIME_BUFFER_MIN = 60; // ESXi 실시간 구간 보관(20초 × 180). 화면 경고 문구의 근거.

export function fmtBytes(b) {
  const n = Number(b) || 0;
  const GB = 1024 ** 3; const MB = 1024 ** 2;
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function fmtSec(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 60) return `${n}초`;
  if (n < 3600) return `${Math.floor(n / 60)}분${n % 60 ? ` ${n % 60}초` : ''}`;
  return `${Math.floor(n / 3600)}시간${Math.floor((n % 3600) / 60) ? ` ${Math.floor((n % 3600) / 60)}분` : ''}`;
}

/** 주기 경고 — 버퍼 60분 대비 겹침과 1회 실패 시 소실. intervalMin 이 없으면 빈 문자열. */
export function intervalWarning(intervalMin, bufferMin = ESXI_REALTIME_BUFFER_MIN) {
  const m = Number(intervalMin);
  if (!Number.isFinite(m) || m <= 0) return '';
  const overlap = bufferMin - m;
  if (overlap <= 0) return `주기 ${m}분 ≥ ESXi 실시간 버퍼 ${bufferMin}분 — 겹침이 없어 한 주기 실패는 그 구간 전체를 잃습니다.`;
  const lost = Math.max(0, m - overlap);
  return `ESXi 실시간 버퍼는 ${bufferMin}분 — 주기 ${m}분이면 겹침 ${overlap}분, 한 주기를 놓치면 그 vCenter 의 ${lost}분 구간은 복구되지 않습니다.${m > bufferMin / 2 ? ` ${Math.floor(bufferMin / 2)}분 이하로 두면 1회 실패는 무손실입니다.` : ''}`;
}

/** 임계 요약 — 설정값으로만. */
export function thresholdText(thr = {}) {
  const parts = [];
  if (thr.cpuPct > 0) parts.push(`CPU ≥ ${thr.cpuPct}%`);
  if (thr.memPct > 0) parts.push(`메모리(active) ≥ ${thr.memPct}%`);
  if (thr.readyPct > 0) parts.push(`Ready ≥ ${thr.readyPct}%/vCPU`);
  parts.push('벌룬·스왑 > 0');
  return parts.join(' · ');
}

/**
 * 로컬 섹션 상태 판정.
 *  'no-db'     : 이 vCenter 의 수집 DB 없음(대상 아님/수집 꺼짐/미수집)
 *  'empty'     : DB 는 있는데 이 VM 의 창에 표본이 0(수집 대상 아님 또는 수집 시작 전)
 *  'ok'        : 표본 있음(스파이크 0 일 수도 있다 — 그건 ok 이고 문구가 구분한다)
 */
export function localPhase(local) {
  if (!local) return 'loading';
  if (local.available === false) return 'no-db';
  if (local.empty) return 'empty';
  return 'ok';
}

export function localPhaseText(local, { settings } = {}) {
  const p = localPhase(local);
  if (p === 'loading') return { short: '불러오는 중…', long: '' };
  if (p === 'no-db') return { short: '로컬 수집 없음', long: local?.text || '이 vCenter 의 포탈 수집 DB 가 없습니다 — 설정 › VM 실시간 스파이크 수집에서 대상·수집 상태를 확인하세요.' };
  if (p === 'empty') {
    const on = settings?.enabled ?? local?.settings?.enabled;
    return { short: '표본 없음', long: on === false
      ? '수집이 꺼져 있습니다 — 설정 › VM 실시간 스파이크 수집에서 켜세요.'
      : '이 창에 이 VM 의 관측 표본이 없습니다 — 수집 대상이 아니거나 수집 시작 전입니다(스파이크가 0 이라는 뜻이 아닙니다).' };
  }
  const c = local.coverage || {};
  const spikes = local.runs?.count || 0;
  const short = spikes ? `스파이크 ${spikes}회` : '스파이크 없음(관측 구간)';
  const long = spikes
    ? `관측 ${c.measuredHours ?? 0}시간 중 임계 이상 구간 ${spikes}회 · 최장 ${fmtSec(local.runs.maxSec)} · 하루 평균 ${local.runs.perDay ?? 0}회`
    : `관측 ${c.measuredHours ?? 0}시간 동안 임계 이상 순간이 없었습니다. 미측정 ${c.unmeasuredHours ?? 0}시간은 알 수 없습니다.`;
  return { short, long };
}

/** 커버리지 문구 — 미측정을 0 으로 말하지 않는다. */
export function coverageText(c) {
  if (!c) return '';
  const pct = c.pct ?? 0;
  const gaps = c.unmeasuredHours ?? 0;
  const base = `커버리지 ${pct}% (관측 ${c.measuredHours ?? 0} / ${c.expectedHours ?? 0}시간)`;
  if (gaps > 0) return `${base} — 미측정 ${gaps}시간은 스파이크 0 이 아니라 관측 없음입니다${c.firstTs ? ` · 수집 시작 ${new Date(c.firstTs).toLocaleDateString('ko-KR')}` : ''}`;
  return `${base}${c.firstTs ? ` · 수집 시작 ${new Date(c.firstTs).toLocaleDateString('ko-KR')}` : ''}`;
}

/** 커버리지 띠 셀 — 7일까지는 시간 단위, 그 이상은 일 단위 평균(DOM 셀 수 상한). */
export function coverageCells(hours = [], days = 30) {
  if (!hours.length) return [];
  if (days <= 7) return hours.map((h) => ({ t: h.h, pct: h.pct ?? 0 }));
  const DAY = 86_400_000;
  const by = new Map();
  for (const h of hours) { const d = Math.floor(h.h / DAY) * DAY; const e = by.get(d) || { t: d, sum: 0, n: 0 }; e.sum += h.pct ?? 0; e.n++; by.set(d, e); }
  return [...by.values()].sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, pct: Math.round(e.sum / e.n) }));
}

/** vCenter 실측 통계 구간 → 사람이 읽는 한 줄. 없으면 '미확인'(기본값을 지어내지 않는다). */
export function historicalIntervalText(hi) {
  const list = hi?.intervals;
  if (!Array.isArray(list) || !list.length) return 'vCenter 통계 구간 설정: 미확인(수집 시 조회)';
  const fmtP = (s) => (s >= 86400 ? `${Math.round(s / 86400)}일` : s >= 3600 ? `${Math.round(s / 3600)}시간` : `${Math.round(s / 60)}분`);
  const fmtL = (s) => (s >= 86400 * 300 ? `${Math.round(s / 86400 / 365)}년` : s >= 86400 * 25 ? `${Math.round(s / 86400 / 30)}달` : s >= 86400 * 6 ? `${Math.round(s / 86400 / 7)}주` : `${Math.round(s / 86400)}일`);
  return `vCenter 통계 구간(실측): ${list.map((i) => `${fmtP(i.samplingPeriod || 0)}·보관 ${fmtL(i.length || 0)}·레벨 ${i.level ?? '?'}${i.enabled === false ? '(꺼짐)' : ''}`).join(' / ')}`;
}

/** 20초 최대 vs 롤업 최대 — 문구는 비교 사실만(산정에 안 쓴다는 것을 명시). */
export function peakNote(localPeakMhz, rollupMaxMhz, intervalSec) {
  if (localPeakMhz == null || rollupMaxMhz == null) return '';
  const ratio = rollupMaxMhz > 0 ? Math.round((localPeakMhz / rollupMaxMhz) * 100) / 100 : null;
  return `20초 최대 ${(localPeakMhz / 1000).toFixed(2)} GHz 는 롤업(${intervalSec}초 평균) 최대 ${(rollupMaxMhz / 1000).toFixed(2)} GHz 의 ${ratio ?? '—'}배 — 권고 vCPU 산정은 롤업 기준이며 이 값은 표시·경고용입니다.`;
}

/** 설정 화면 — 범위 요약 문구. */
export function scopeSummaryText(settings, resolved = []) {
  const vms = resolved.reduce((a, r) => a + (r.vms || 0), 0);
  const hosts = resolved.reduce((a, r) => a + (r.hosts || 0), 0);
  const vcs = resolved.filter((r) => r.mode !== 'none').length;
  if (settings?.scope === 'selected') return `선택 범위 — vCenter ${vcs}개 · VM ${vms}대 · 호스트 ${hosts}대`;
  return `전체 — vCenter ${vcs}개 · 전원 ON VM ${vms}대 · 호스트 ${hosts}대`;
}

/** 마지막 수집 요약. */
export function lastRunText(last) {
  if (!last) return '아직 수집하지 않았습니다.';
  if (last.mock) return '데모(mock) 모드 — 실시간 표본이 없어 수집하지 않습니다.';
  if (last.paused === 'disk') return `디스크 여유 부족(${fmtBytes(last.freeBytes)} < ${fmtBytes(last.minFreeBytes)}) — 저장을 건너뛰었습니다(그 구간은 소실).`;
  const err = (last.errors || []).length;
  return `${new Date(last.at).toLocaleString('ko-KR')} · vCenter ${last.vcenters ?? 0} · VM ${last.vms ?? 0} · 호스트 ${last.hosts ?? 0} · 표본 ${(last.samples ?? 0).toLocaleString()} · 스파이크 순간 ${(last.moments ?? 0).toLocaleString()} · ${Math.round((last.ms || 0) / 1000)}초${err ? ` · 실패 ${err}` : ''}`;
}
