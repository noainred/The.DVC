/**
 * sanswitch/storagePerfCheck.js — SAN 스토리지 성능 점검 판정(순수 · v2.948 · 설계 ⑥).
 *
 * 월간 점검(healthCheck.js)과 같은 틀: 상태는 네 가지 — `ok` · `warn` · `bad` · `unknown`(**확인하지 못함** — 사유를 함께) — 에
 * `na`(그 벤더 · 그 어레이에 없는 항목)를 더한다. **unknown 을 ok 로 흡수하지 않는다**: 종합이 ok 여도 uncheckedCount 를 따로 세어
 * 화면이 '정상(일부 미확인)' 으로 쓴다. 임계값은 storageCheckSettings(벤더 문서 값만 · 못 찾은 것은 null = 판정 안 함).
 *
 * 항목 9(설계 ⑥): 스위치 측 — 디렉터 편중 · 팹 비대칭 · 회선 포화 · 수집 상태 / 어레이 측 — 디렉터 busy · 응답 시간 · 큐 깊이 · 노드/SP CPU · 보고 대조.
 * 어레이 측 값(arraySide)은 v2.951 부터 storage/collectors/arrayPerf.js 가 5분 표본으로 읽고 sanswitch/arraySideLoad.js 가 넣는다 — 값이 없으면(짝 없음 · SSH 수집 ·
 * 표본 없음 · 오래됨) **unknown** 에 그 사유(arraySideText)를 적는다. 거짓 정상을 만들지 않는다.
 */
import { IMBALANCE_MIN_BPS, IMBALANCE_RATIO } from './portUsage.js';

export const CHECK_ITEMS = Object.freeze([
  { k: 'imbalance', label: '디렉터 편중', side: 'switch' },
  { k: 'fabric', label: '팹 비대칭', side: 'switch' },
  { k: 'portSat', label: '회선 포화', side: 'switch' },
  { k: 'dirBusy', label: '디렉터 busy', side: 'array', vendors: ['powermax'] },
  { k: 'resp', label: '응답 시간', side: 'array', vendors: ['powermax', 'powerstore', 'unity'] },
  { k: 'queue', label: '큐 깊이', side: 'array', vendors: ['powermax'] },
  { k: 'cpu', label: '노드 · SP CPU', side: 'array', vendors: ['powerstore', 'unity'] },
  { k: 'compare', label: '보고 대조', side: 'array', vendors: ['powermax', 'powerstore', 'unity'] },
  { k: 'collect', label: '수집 상태', side: 'switch' },
]);
export const STATUS_ORDER = Object.freeze(['bad', 'warn', 'unknown', 'ok', 'na']);
/** 편중 '이상' 배수 — 24시간 평균으로 이미 지속성을 봤으므로 2배를 이상으로(설계 ⑥ 규칙 표). */
export const IMBALANCE_BAD_RATIO = 2;
/** 팹 비대칭 판정의 하한 — 두 팹 합이 이보다 작으면 판정하지 않는다(한가한 어레이의 쏠림은 의미 없다). 편중 하한과 같은 값. */
export const FABRIC_MIN_BPS = IMBALANCE_MIN_BPS;

const item = (status, text = '', extra = {}) => ({ status, text, ...extra });

/** 비교 구간(ms) 단위 숫자 판정 — 임계값이 null 이면 unknown('기준 없음'). */
export function thresholdJudge(value, warn, bad, { unit = '%', higherIsWorse = true } = {}) {
  if (value == null) return item('unknown', '값 없음');
  if (warn == null && bad == null) return item('unknown', `기준 없음 — 값 ${value}${unit}`, { value });
  const worse = (v, t) => (higherIsWorse ? v >= t : v <= t);
  if (bad != null && worse(value, bad)) return item('bad', `${value}${unit} ≥ ${bad}${unit}`, { value });
  if (warn != null && worse(value, warn)) return item('warn', `${value}${unit} ≥ ${warn}${unit}`, { value });
  return item('ok', `${value}${unit}`, { value });
}

/**
 * 어레이 한 행 판정.
 * @param {object} row storageList.buildStorageRows 의 행
 * @param {{values:object}} settings storageCheckSettings.loadCheckSettings()
 * @param {object|null} arraySide 어레이 측 지표(다음 판 — 지금은 null)
 */
export function checkArray(row, settings, { arraySide = null, arraySideText = '', imbalance = { minBps: IMBALANCE_MIN_BPS, ratio: IMBALANCE_RATIO } } = {}) {
  const v = settings?.values || {};
  const items = {};
  const measuredDirs = (row.directors || []).filter((d) => d.avg24 != null);
  // ① 디렉터 편중(24시간 평균)
  if (row.state !== 'ok' && row.state !== 'stale') items.imbalance = item('unknown', row.stateText || '표본 없음');
  else if (measuredDirs.length < 2) items.imbalance = item('na', measuredDirs.length === 1 && !measuredDirs[0].parsed ? '디렉터를 구분하지 못함' : '디렉터 1개 — 비교 대상 없음');
  else if (row.imbalance && row.imbalance.ratio >= IMBALANCE_BAD_RATIO) items.imbalance = item('bad', `${row.imbalance.group} ${row.imbalance.ratio}× (24시간 평균)`, { ratio: row.imbalance.ratio });
  else if (row.imbalance) items.imbalance = item('warn', `${row.imbalance.group} ${row.imbalance.ratio}×`, { ratio: row.imbalance.ratio });
  else {
    const groupMean = measuredDirs.reduce((a, d) => a + d.avg24, 0) / measuredDirs.length;
    const top = measuredDirs.reduce((a, d) => (a == null || (d.ratio ?? 0) > (a.ratio ?? 0) ? d : a), null);
    items.imbalance = groupMean < imbalance.minBps
      ? item('ok', '한가함 — 편중 판정 하한 미만')
      : item('ok', top?.ratio != null ? `최대 ${top.group} ${top.ratio}×` : '균형', { ratio: top?.ratio ?? null });
  }
  // ② 팹 비대칭
  const fabs = (row.fabrics || []).filter((f) => f.avg24 != null);
  if (row.state !== 'ok' && row.state !== 'stale') items.fabric = item('unknown', row.stateText || '표본 없음');
  else if ((row.fabrics || []).length < 2) items.fabric = item('na', '스위치 1대 — 팹 비교 없음');
  else if (fabs.length < 2) items.fabric = item('unknown', '한쪽 팹 측정 없음');
  else {
    const total = fabs.reduce((a, f) => a + f.avg24, 0);
    const minF = fabs.reduce((a, f) => (a == null || f.avg24 < a.avg24 ? f : a), null);
    const share = total > 0 ? Math.round((minF.avg24 / total) * 100) : null;
    const minShare = v.asymMinSharePct;
    if (total < FABRIC_MIN_BPS) items.fabric = item('ok', '한가함 — 비대칭 판정 하한 미만');
    else if (minF.avg24 === 0) items.fabric = item('bad', `${minF.name} 0 — 한쪽 팹만 흐름`, { share });
    else if (minShare != null && share < minShare) items.fabric = item('warn', `${minF.name} ${share}% (하한 ${minShare}%)`, { share });
    else items.fabric = item('ok', `최소 ${share}%`, { share });
  }
  // ③ 회선 포화(포트 피크 포화도 최대)
  const sat = (row.ports || []).map((p) => p.peakSatPct).filter((x) => x != null);
  if (row.state !== 'ok' && row.state !== 'stale') items.portSat = item('unknown', row.stateText || '표본 없음');
  else if (!sat.length) items.portSat = item('unknown', (row.unknownSpeedPorts || 0) > 0 ? '포트 속도를 모름' : '피크 없음');
  else {
    const mx = Math.max(...sat);
    const j = thresholdJudge(Math.round(mx), v.portSatWarnPct, v.portSatBadPct);
    const worst = (row.ports || []).find((p) => p.peakSatPct === mx);
    items.portSat = { ...j, text: `${j.text}${worst ? ` — ${worst.deviceName}:${worst.port}` : ''}` };
  }
  // ④~⑧ 어레이 측 — 벤더에 없는 항목은 na, 있는데 값이 없으면 unknown(미수집)
  const vendor = row.vendor || 'other';
  for (const it of CHECK_ITEMS.filter((x) => x.side === 'array')) {
    if (!it.vendors.includes(vendor)) { items[it.k] = item('na', '이 벤더에 없는 항목'); continue; }
    const a = arraySide?.[it.k];
    if (a == null) { items[it.k] = item('unknown', arraySide ? '값 없음 — 어레이 측 표본에 이 지표가 없음' : (arraySideText || '어레이 측 성능 미수집')); continue; }
    items[it.k] = judgeArraySide(it.k, a, v, vendor);
  }
  // ⑨ 수집 상태
  items.collect = row.state === 'ok' ? item('ok', '최근 표본 있음', { ts: row.now?.ts ?? null })
    : row.state === 'stale' ? item('warn', row.stateText, { ts: row.now?.ts ?? null }) : item('unknown', row.stateText);
  const counts = { ok: 0, warn: 0, bad: 0, unknown: 0, na: 0 };
  for (const x of Object.values(items)) counts[x.status] = (counts[x.status] || 0) + 1;
  const overall = counts.bad ? 'bad' : counts.warn ? 'warn' : counts.ok ? 'ok' : counts.unknown ? 'unknown' : 'na';
  return { key: row.key, datacenterId: row.datacenterId, items, counts, overall, uncheckedCount: counts.unknown };
}

/** 어레이 측 값 판정 — 다음 판(수집기)이 채운다. 모양만 고정: { value, unit?, max?, group? }. */
export function judgeArraySide(k, a, v, vendor) {
  const val = a?.value ?? a?.max ?? null;
  switch (k) {
    case 'dirBusy': return thresholdJudge(val, v.dirBusyWarnPct, v.dirBusyBadPct);
    case 'queue': return thresholdJudge(val, v.queueWarnPct, v.queueBadPct);
    case 'resp': return thresholdJudge(val, v.respWarnMs, v.respBadMs, { unit: 'ms' });
    case 'cpu': return vendor === 'unity' ? thresholdJudge(val, v.unityCpuWarnPct, v.unityCpuBadPct) : thresholdJudge(val, v.pstoreCpuWarnPct, v.pstoreCpuBadPct);
    case 'compare': {
      if (val == null) return item('unknown', '값 없음');
      const lim = v.compareDiffPct;
      if (lim == null) return item('unknown', `기준 없음 — 차이 ${val}%`, { value: val });
      return Math.abs(val) >= lim ? item('warn', `차이 ${val}% ≥ ${lim}%`, { value: val }) : item('ok', `차이 ${val}%`, { value: val });
    }
    default: return item('unknown', '모르는 항목');
  }
}

/** 전체 요약 — 종합별 개수(화면 알약). */
export function summarizeChecks(results = []) {
  const out = { arrays: results.length, ok: 0, warn: 0, bad: 0, unknown: 0, na: 0, partiallyUnchecked: 0 };
  for (const r of results) {
    out[r.overall] = (out[r.overall] || 0) + 1;
    if (r.overall === 'ok' && r.uncheckedCount > 0) out.partiallyUnchecked++;
  }
  return out;
}
