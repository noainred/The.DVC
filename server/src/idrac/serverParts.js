/**
 * idrac/serverParts.js — 서버 한 대의 부품 상태 **요약**(표시 전용, v2.728).
 *
 * 사용자 요청: "스토리지 디스크 장애는 확인이 되는데, 서버 장애 파트(CPU, Memory, disk 등)에 장애가 발생해도 확인되게" —
 * 선택 '표시 + 기존 기록 연결'. 화면(서버 목록 '부품 이상' 열 · 상세 '부품 상태')이 쓰고, 장애 **기록·알림**은 기존 파트 장애
 * 기능(partfault/ — 기본 꺼짐)이 맡는다.
 *
 * ⚠⚠ 판정을 복제하지 않는다 — `partfault/extract/idrac.js extractIdracParts` + `classify.js redfishPartState` 를 그대로 쓴다.
 * ⚠⚠ 이 요약은 **표시 전용**이다. partfault DB·전이·알림에 넣지 말 것 — 중앙이 위임(엣지) 장비를 다시 판정하면 같은 부품이
 *    두 번 열린다(CLAUDE.md v2.548). 그래서 여기서 쓰는 것은 '지금 인벤토리가 말하는 상태' 이고, 전이 기록과 다를 수 있다.
 *
 * 상태 규칙(extract/idrac.js 와 같다): absent(빈 슬롯)는 장애가 아니고, unknown(못 읽음)은 정상도 장애도 아니다.
 * 인벤토리가 없거나·장비에 닿지 못했거나·시스템 정보 조회가 실패했거나·구버전 엣지라 상태 필드가 없으면 **판정 불가**다
 * (judged:false + reason — 0 건이라 말하지 않는다).
 */
import { extractIdracParts } from '../partfault/extract/idrac.js';
import { summarize, PART_STATE, PART_KIND_LABEL, HOLD_REASON } from '../partfault/types.js';
import { statusFieldsMissing } from './invView.js';
import { clampIntervalMs } from '../config.js'; // 시한 env 는 헬퍼로(빈 값·비숫자 = 기본값, 상·하한 — v2.599 T2599-02)

/** 장애·경고 부품 목록 상한(상세 화면용). 넘친 개수는 faultsOmitted 로 밝힌다. */
export const PART_SUMMARY_FAULT_MAX = 50;
/**
 * 인벤토리를 '오래됐다' 고 말하는 경계 — 파트 장애 스캔의 신선도 기본값(partfault/scan.js PARTFAULT_INV_MAX_AGE_MS 기본 90분,
 * 인벤토리 30분 주기의 3배)과 같은 값이다. 오래된 인벤토리의 장애를 **숨기지 않고** stale 로 표시한다.
 */
export const INV_STALE_MS = clampIntervalMs(process.env.PARTFAULT_INV_MAX_AGE_MS, 90 * 60_000, 60_000);

/** 판정 불가 사유 — 웹 hwStatusText.PARTS_REASON_TEXT 와 키가 1:1 이어야 한다(테스트 대조). */
export const PARTS_REASON = Object.freeze({
  noInventory: 'no-inventory',   // 인벤토리를 아직 받지 못했다
  unreachable: 'unreachable',    // 마지막 인벤토리 수집이 장비에 닿지 못했다
  systemFailed: 'system-failed', // Systems 조회가 실패해 이번 인벤토리로는 부품 키를 정할 수 없다(extract keyUnstable)
  edgeOld: 'edge-old',           // 엣지가 2.728 이전 — 축약 인벤토리에 상태 필드가 없다
});

const ORDER = { fault: 0, warn: 1 };

/**
 * @param {{id:string, name?:string, host?:string, serviceTag?:string}} server
 * @param {object|null} inv  인벤토리(로컬 캐시 또는 원격 축약)
 * @param {{now?:number, remote?:boolean, withFaults?:boolean}} [o]
 * @returns {{judged:boolean, reason:string|null, ok:number, warn:number, fault:number, unknown:number, absent:number,
 *   total:number, failedKinds:string[], collectedAt:number|null, stale:boolean, faults?:Array, faultsOmitted?:number}}
 */
export function summarizeServerParts(server = {}, inv = null, { now = Date.now(), remote = false, withFaults = true } = {}) {
  const collectedAt = Number.isFinite(Number(inv?.collectedAt)) && inv?.collectedAt != null ? Number(inv.collectedAt) : null;
  const empty = { ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0, total: 0, failedKinds: [] };
  const base = { collectedAt, stale: collectedAt != null && now - collectedAt > INV_STALE_MS };
  if (!inv || typeof inv !== 'object' || collectedAt == null) return { judged: false, reason: PARTS_REASON.noInventory, ...empty, ...base };
  if (remote && statusFieldsMissing(inv)) return { judged: false, reason: PARTS_REASON.edgeOld, ...empty, ...base };
  const ex = extractIdracParts({ id: server.id, name: server.name, host: server.host, serviceTag: server.serviceTag }, inv);
  if (!ex.reachable) return { judged: false, reason: PARTS_REASON.unreachable, ...empty, failedKinds: ex.failedKinds || [], ...base };
  if (ex.keyUnstable) return { judged: false, reason: PARTS_REASON.systemFailed, ...empty, failedKinds: ex.failedKinds || [], ...base };
  const c = summarize(ex.parts);
  const out = { judged: true, reason: null, ...c, failedKinds: ex.failedKinds || [], ...base };
  if (withFaults) {
    const bad = ex.parts.filter((p) => p.state === PART_STATE.fault || p.state === PART_STATE.warn)
      .sort((a, b) => ORDER[a.state] - ORDER[b.state]);
    out.faults = bad.slice(0, PART_SUMMARY_FAULT_MAX).map((p) => ({
      kind: p.kind, kindLabel: PART_KIND_LABEL[p.kind] || p.kind, partId: p.partId, label: p.label, detail: p.detail,
      state: p.state, raw: p.rawState, keyKind: p.keyKind,
    }));
    out.faultsOmitted = Math.max(0, bad.length - PART_SUMMARY_FAULT_MAX);
  }
  return out;
}

/* ── 목록용 기억(서버 목록이 요청마다 전 서버를 다시 추출하지 않게) ─────────────────────────────── */
const CACHE_MAX = 8000;
const _cache = new Map();
/**
 * 목록 열에 쓰는 요약(장애 목록 없음). 인벤토리 수집 시각이 같으면 다시 계산하지 않는다 — 인벤토리는 30분 주기라
 * 목록을 여러 번 열어도 대부분 기억에서 나온다. stale 은 기억과 무관하게 지금 시각으로 다시 계산한다.
 */
export function serverPartsCell(server = {}, inv = null, { now = Date.now(), remote = false, scopeKey = '' } = {}) {
  const at = inv?.collectedAt ?? '';
  const key = `${scopeKey}|${remote ? 'r' : 'l'}|${server.id}|${at}|${server.serviceTag || ''}`;
  let v = _cache.get(key);
  if (!v) {
    v = summarizeServerParts(server, inv, { now, remote, withFaults: false });
    if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(key, v);
  } else { _cache.delete(key); _cache.set(key, v); }
  const stale = v.collectedAt != null && now - v.collectedAt > INV_STALE_MS;
  return {
    judged: v.judged, reason: v.reason, ok: v.ok, warn: v.warn, fault: v.fault, unknown: v.unknown, absent: v.absent,
    total: v.total, failedKinds: v.failedKinds, collectedAt: v.collectedAt, stale,
  };
}
export function _resetServerPartsCacheForTest() { _cache.clear(); }

/* ── 파트 장애 기능(기록·알림)과의 연결 ────────────────────────────────────────────────────── */
const t = (v) => String(v ?? '').trim();
export const OPEN_FAULT_MAX = 50;

/**
 * 파트 장애 DB 의 열린 장애 중 **이 서버의 것**만 고른다(순수). 서비스태그가 있으면 장비 키(deviceKey)로 — 법인과 무관하게
 * 같은 물리 서버다. 없으면 장비 id + 수집 주체(agent)로만(같은 IP id 가 다른 법인에 있을 수 있다 — v2.548 F2).
 * @param {Array} rows  partfault/db.js openFaults() 결과
 * @param {{id:string, serviceTag?:string}} server
 * @param {{agents?:string[]}} o  이 서버 기록의 수집 주체 후보(로컬 = [''], 원격 = [수집 서버 id·이름])
 */
export function pickServerOpenFaults(rows, server = {}, { agents = [''] } = {}) {
  const tag = t(server.serviceTag).toUpperCase();
  const id = t(server.id);
  const ags = new Set(agents.map((a) => t(a).toLowerCase()));
  const hit = (r) => {
    if (t(r?.scope) !== 'idrac') return false;
    if (tag && t(r.deviceKey).toUpperCase() === tag) return true;
    return !!id && t(r.deviceId) === id && ags.has(t(r.agent).toLowerCase());
  };
  const list = (Array.isArray(rows) ? rows : []).filter(hit);
  return {
    open: list.slice(0, OPEN_FAULT_MAX).map((r) => ({
      kind: r.kind, kindLabel: PART_KIND_LABEL[r.kind] || r.kind, label: r.label, partId: r.partId, state: r.state,
      rawState: r.rawState, firstSeenAt: r.firstSeenAt ?? null, lastSeenAt: r.lastSeenAt ?? null,
      holdReason: Object.values(HOLD_REASON).includes(r.holdReason) ? r.holdReason : (r.holdReason ? 'other' : null),
      agent: r.agent || '',
    })),
    omitted: Math.max(0, list.length - OPEN_FAULT_MAX),
  };
}

/**
 * 상세 화면의 '파트 장애 기능' 칸 — 켜짐 여부(+ 이유) · 이 서버의 열린 장애(DB). 기능을 한 번도 켜지 않은 노드에서는 DB 를
 * 만들지 않는다(dbAvailable:false). 의존을 주입받아 테스트가 DB 없이 고정할 수 있다.
 * @param {{id:string, serviceTag?:string}} server
 * @param {{remote?:boolean, agents?:string[], scoped?:boolean}} ctx
 */
export async function serverPartFaultInfo(server, ctx = {}, deps = null) {
  const d = deps || await (async () => {
    const [settings, db] = await Promise.all([import('../partfault/settings.js'), import('../partfault/db.js')]);
    return { enabled: settings.partFaultEnabled, forAgent: settings.settingsForAgent, exists: db.partFaultDbExists, open: db.openFaults };
  })();
  const en = (() => { try { return d.enabled(); } catch { return { enabled: false, source: 'default' }; } })();
  const out = { enabled: !!en.enabled, source: en.source || 'default', scoped: !!ctx.scoped };
  if (ctx.remote) {
    // 위임(엣지) 서버의 기록은 그 엣지가 판정해 올린다 — 중앙이 그 엣지에 내려준 값(엣지 portal.env 가 덮을 수 있다).
    const ag = (ctx.agents || []).find((a) => t(a));
    try { out.edgeEnabled = ag ? !!d.forAgent(ag).enabled : null; } catch { out.edgeEnabled = null; }
  }
  let exists = false;
  try { exists = !!d.exists(); } catch { exists = false; }
  if (!exists) return { ...out, dbAvailable: false, open: [], omitted: 0 };
  try {
    const rows = await d.open({ scope: 'idrac' });
    return { ...out, dbAvailable: true, ...pickServerOpenFaults(rows, server, { agents: ctx.agents || [''] }) };
  } catch (e) {
    return { ...out, dbAvailable: false, open: [], omitted: 0, error: String(e?.message || e).slice(0, 200) };
  }
}
