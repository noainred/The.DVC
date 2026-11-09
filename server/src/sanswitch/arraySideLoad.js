/**
 * sanswitch/arraySideLoad.js — 어레이 측 성능을 DB 에서 읽어 화면 · 점검 모양으로(v2.951 · 설계 ⓑ). 순수 조립은 arraySide.js, 여기는 DB · 주기만 안다.
 *
 *  · 어레이(SAN 키)와 스토리지 장비의 짝은 **시리얼**(capacityIndexFor — 등록 스토리지 스냅샷의 serial · PowerStore appliance serviceTag)이다. 짝이 없거나
 *    SSH 수집 장비(성능 경로 없음) · 표본 토글 꺼짐이면 `eligible:false` 와 사유를 돌려주고 값을 지어내지 않는다.
 *  · 표본 주기는 그 장비를 수집하는 쪽(중앙 자신 또는 위임 엣지)의 nodeLoadMs — 엣지 현장 값은 중앙이 모르므로 배포값 · 없으면 env 기본(storageMon 과 같은 한계).
 *  · 창 종류: 26시간 이하 원시 · 8일 이하 1시간 칸 · 그 위 일 롤업(원시 보존 밖이면 nodeLoadQuery 가 시간 요약으로 내려간다 — 원시 폴백 없음).
 *  · 장비 호출 0 — DB 만 읽는다.
 */
import { nodeLoadQuery, nodeUnitsOf } from '../storage/db.js';
import { intervalsForAgent, envIntervals, runtimeIntervals } from '../storage/intervals.js';
import { isFePerfType } from '../storage/collectors/arrayPerf.js';
import { numOrNull } from '../util/numOrNull.js';
import { unitsForArray, matchUnits, latestByUnit, feSeries, summarizeLatest, toCheckInput, staleMsOf, FE_METRICS, FE_KEYS } from './arraySide.js';

const HOUR = 3_600_000; const DAY = 24 * HOUR;
export const DOC_BASIS = '벤더 문서 경로로 읽습니다(Unisphere FEDirector · PowerStore metrics/generate · Unity metricValue) — 실장비 확인 전';

/** 표본 주기(ms) — 위임 엣지면 중앙 배포값, 중앙 직접이면 실행값, 못 읽으면 env 기본(5분). */
export function sampleMsOf(agent = '') {
  let ms = null;
  try { ms = agent ? numOrNull(intervalsForAgent(agent)?.nodeLoadMs) : numOrNull(runtimeIntervals()?.nodeLoadMs); } catch { ms = null; }
  if (!(ms > 0)) { try { ms = numOrNull(envIntervals()?.nodeLoadMs); } catch { ms = null; } }
  return ms > 0 ? ms : 300_000;
}

/** 표시 순서 — 부모 단위(fa · node · sp) 먼저, 포트는 뒤에 · 같은 종류는 이름순. */
const KIND_ORDER = { fa: 0, node: 0, sp: 0, '': 1, port: 2 };
export function sortUnits(units = []) {
  return [...units].sort((a, b) => (KIND_ORDER[a.kind] ?? 1) - (KIND_ORDER[b.kind] ?? 1) || String(a.display ?? a.name).localeCompare(String(b.display ?? b.name)));
}

/** 짝 지은 스토리지 장비가 어레이 측 표본을 낼 수 있는가(순수). */
export function feEligibility(cap) {
  if (!cap || !cap.deviceId) return { eligible: false, reason: 'no-device', text: '등록 스토리지와 시리얼이 일치하지 않아 어레이 측 값을 붙이지 못했습니다' };
  if (!isFePerfType(cap.type)) return { eligible: false, reason: 'type', text: `이 장비 종류(${cap.type || '?'})는 어레이 측 성능 경로가 없습니다` };
  if ((cap.collectMethod || 'api') !== 'api') return { eligible: false, reason: 'ssh', text: 'SSH 로 수집하는 장비는 어레이 측 성능 경로가 없습니다(REST 로 바꾸면 표본이 쌓입니다)' };
  if (cap.nodeLoadEnabled === false) return { eligible: false, reason: 'disabled', text: '이 장비의 5분 표본(노드 부하 · 디렉터 성능)이 꺼져 있습니다' };
  return { eligible: true, reason: null, text: '' };
}

/** 창 → 조회 종류(순수). */
export function feWindowKind(from, to, { now = Date.now(), rawKeepDays = 7 } = {}) {
  const span = to - from;
  if (span <= 26 * HOUR && from >= now - rawKeepDays * DAY) return { kind: 'raw', bucketMs: 0 };
  if (span <= 8 * DAY) return { kind: 'bucket', bucketMs: HOUR };
  return { kind: 'daily', bucketMs: DAY };
}

/**
 * 최신 표본만(점검용) — 단위 카탈로그 + 최근 창(오래됨 기준의 2배 · 최소 30분) 원시 행.
 * @returns {Promise<{eligible:boolean, reason:string|null, text:string, units:Array, latest:object, summary:object, sampleMs:number, staleMs:number, lastSampleTs:number|null}>}
 */
export async function loadLatestFe(cap, { serial = '', now = Date.now() } = {}) {
  const el = feEligibility(cap);
  const base = { ...el, units: [], latest: {}, summary: {}, sampleMs: null, staleMs: null, lastSampleTs: null };
  if (!el.eligible) return base;
  const sampleMs = sampleMsOf(cap.agent);
  const staleMs = staleMsOf(sampleMs);
  const units = unitsForArray(await nodeUnitsOf(cap.deviceId), { serial });
  const q = await nodeLoadQuery(cap.deviceId, { group: 'fe', kind: 'raw', from: now - Math.max(30 * 60_000, staleMs * 2), to: now + 60_000 });
  const latest = latestByUnit(q.rows, { now, staleMs });
  const summary = summarizeLatest(units, latest);
  let lastSampleTs = null;
  for (const l of Object.values(latest)) if (l.ts != null && (lastSampleTs == null || l.ts > lastSampleTs)) lastSampleTs = l.ts;
  if (!units.length) return { ...base, sampleMs, staleMs, reason: 'no-units', text: '아직 어레이 측 표본이 없습니다(첫 5분 표본 뒤에 채워집니다)' };
  if (lastSampleTs == null) return { ...base, units, sampleMs, staleMs, reason: 'no-sample', text: '최근 창에 어레이 측 표본이 없습니다' };
  return { ...base, units, latest, summary, sampleMs, staleMs, lastSampleTs };
}

/** 점검 입력(storagePerfCheck.checkArray 의 arraySide) + 사유 — 값이 없으면 {} 과 사유. */
export async function checkInputFor(cap, { serial = '', now = Date.now(), switchBps = null } = {}) {
  const l = await loadLatestFe(cap, { serial, now });
  const input = l.eligible && l.lastSampleTs != null ? toCheckInput(l.summary, { switchBps }) : {};
  const stale = l.eligible && l.lastSampleTs != null && l.lastSampleTs < now - l.staleMs;
  return { input, reason: l.reason, text: stale ? `어레이 측 표본이 오래됐습니다(마지막 ${Math.round((now - l.lastSampleTs) / 60_000)}분 전)` : l.text, lastSampleTs: l.lastSampleTs, eligible: l.eligible };
}

/**
 * 상세 ② 패널용 — 창 시계열 + 최신 + 대조.
 * @param {object} cap capacityIndexFor().lookup 결과
 * @param {{serial:string, from:number, to:number, now?:number, groups?:Array, ports?:Array, switchBps?:number|null}} opt
 */
export async function loadArraySide(cap, { serial = '', from, to, now = Date.now(), groups = [], ports = [], switchBps = null } = {}) {
  const el = feEligibility(cap);
  const head = { eligible: el.eligible, reason: el.reason, text: el.text, deviceId: cap?.deviceId || null, name: cap?.name || '', type: cap?.type || '',
    agent: cap?.agent || '', alerts: cap?.alerts ?? null, collectedAt: cap?.collectedAt ?? null, nodeLoadEnabled: cap?.nodeLoadEnabled ?? null,
    metrics: FE_METRICS, keys: FE_KEYS, docBasis: DOC_BASIS };
  if (!el.eligible) return head;
  const sampleMs = sampleMsOf(cap.agent);
  const staleMs = staleMsOf(sampleMs);
  const units = sortUnits(unitsForArray(await nodeUnitsOf(cap.deviceId), { serial }));
  const wk = feWindowKind(from, to, { now });
  const [q, lq] = await Promise.all([
    nodeLoadQuery(cap.deviceId, { group: 'fe', kind: wk.kind, from, to, bucketMs: wk.bucketMs }),
    nodeLoadQuery(cap.deviceId, { group: 'fe', kind: 'raw', from: now - Math.max(30 * 60_000, staleMs * 2), to: now + 60_000 }),
  ]);
  const latest = latestByUnit(lq.rows, { now, staleMs });
  const series = feSeries(q.rows);
  const m = matchUnits(units, groups, ports);
  const summary = summarizeLatest(units, latest);
  let lastSampleTs = null;
  for (const l of Object.values(latest)) if (l.ts != null && (lastSampleTs == null || l.ts > lastSampleTs)) lastSampleTs = l.ts;
  const arrayBps = summary.hbps?.value ?? null;
  const diff = toCheckInput(summary, { switchBps }).compare?.value ?? null;
  return {
    ...head,
    reason: units.length ? (lastSampleTs == null ? 'no-sample' : null) : 'no-units',
    text: units.length ? (lastSampleTs == null ? '최근 창에 어레이 측 표본이 없습니다' : '') : '아직 어레이 측 표본이 없습니다(첫 5분 표본 뒤에 채워집니다)',
    sampleMs, staleMs, lastSampleTs, seriesKind: wk.kind, bucketMs: wk.bucketMs, truncated: !!q.truncated, source: q.source || wk.kind,
    units: units.map((u) => ({ id: u.id, name: u.display ?? u.name, kind: u.kind, parent: u.parent ?? null, group: m.byUnit[u.id]?.group ?? null, port: m.byUnit[u.id]?.port ?? null,
      ts: latest[u.id]?.ts ?? null, stale: latest[u.id]?.stale ?? true, latest: latest[u.id]?.v || Object.fromEntries(FE_KEYS.map((k) => [k, null])) })),
    unmatchedGroups: m.unmatchedGroups, matched: m.matched,
    series, summary, compare: { arrayBps, switchBps, diffPct: diff, partial: !!summary.hbps?.partial },
  };
}
