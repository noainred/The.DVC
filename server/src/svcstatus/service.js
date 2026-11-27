/**
 * svcstatus/service.js — 대상 계획(등록부 읽기) · 화면 행 · 엣지 설정/보고를 묶는 입출력 층(v3.54 — 중앙 전용).
 *
 * ⚠ 계획은 **디스크 원천**(등록부 파일)으로 계산한다 — 인메모리 상태(스냅샷)는 보조(담당 엣지 관측 · 데모)일 뿐이라
 *   중앙 재기동 직후에도 대상이 비지 않는다(edge.md '인출 때 다시 계산해 없음으로 답하지 말 것').
 * ⚠ 엣지 보고는 인증된 agent 의 **자기 몫**만 받는다 — 대상 id · 주소 · 포트가 중앙이 그 엣지에 준 것과 같을 때만(위조 · 오배정 거부, 센다).
 *   엣지 시각은 받지 않는다 — 행마다 '측정 뒤 지난 ms'(a)를 받아 수신 시각에서 뺀다(svcmon v2.x 와 같은 꼴 · 미래 시각이 생기지 않는다).
 */
import { currentVersion } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { loadSvcStatusSettings, svcStatusSettingsLoadError, svcStatusUsingLastGood } from './settings.js';
import { planTargets, SOURCES, KIND_LABEL } from './targets.js';
import { buildRows, unitKey, countsOf, publicRow, RANGES, stepFor, seriesFromSamples, seriesFromBuckets, addressOf } from './view.js';
import { staleLimitMs, timeoutFor } from './judge.js';
import * as db from './db.js';
import { svcStatusMinEdgeVersion } from '../central/featureMinEdgeVersion.js';
import { edgeVersionOf } from '../central/cvpEdge.js';
import { FAIL_KINDS } from '../linkcheck/phases.js';
import { isMockMode } from '../mock/demo/flags.js';

const t = (v) => String(v ?? '').trim();
const n = numOrNull;
export const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
/** 엣지 보고 한 번의 상한(넘는 것은 버리고 센다 — 조용한 상한 금지). */
export const REPORT_MAX = 5_000;
const PLAN_TTL_MS = 15_000;

let _previous = new Map();    // 종류 → 직전 카탈로그 원본(못 읽은 종류의 보류용)
let _plan = null;             // { at, rows, heldKinds, heldEmpty, sourceErrors, registered }
let _planning = null;
const _reports = new Map();   // agent 소문자 → { agent, at, version, note, disabled, n, stored, rejected, omitted, notAssigned }

/** 등록부를 읽어 대상을 계산한다(15초 안 재사용 · 진행 중 계산 공유). `force` 는 폴러 주기. */
export async function getPlan({ force = false, deps = {} } = {}) {
  if (!force && _plan && Date.now() - _plan.at < PLAN_TTL_MS) return _plan;
  if (_planning) return _planning;
  _planning = computePlan(deps).finally(() => { _planning = null; });
  return _planning;
}

async function computePlan(deps = {}) {
  const settings = deps.settings || loadSvcStatusSettings();
  const mock = deps.mock ?? isMockMode();
  const catDeps = {};
  // 데모: vCenter 등록부가 비어 있으면 스냅샷 vCenter 를 등록부 행 모양으로(통신 점검과 같은 대체 입력 — mock 이 아니면 입력 그대로).
  let snapVcs = [];
  try { snapVcs = (await import('../store.js')).store.get()?.vcenters || []; } catch { snapVcs = []; }
  if (mock && !deps.build) {
    try {
      const vr = (await import('../vcenter/registry.js')).listRegistry();
      if (!vr.length) {
        const { demoLinkInputs, demoDecorateVcenters } = await import('../mock/demo/edge.js');
        const cols = (await import('../collector/registry.js')).listCollectors();
        catDeps.vcenters = demoLinkInputs({ vcenters: [], collectors: cols }).vcenters;
        snapVcs = demoDecorateVcenters(snapVcs) || snapVcs;
      }
    } catch { /* 데모 보강 없이 */ }
  }
  const build = deps.build || (async () => (await import('../linkcheck/settingsLinks.js')).buildSettingsTargets(catDeps));
  const built = await build();
  // 현지 수집 vCenter 의 담당 엣지 — 표준 판정 하나(등록 → 위임 인벤토리 소유 → 스냅샷 관측).
  let siteOwner = deps.siteOwner || new Map();
  if (!deps.siteOwner) {
    try {
      const { siteOwnerByVcenter } = await import('../bmusage/targets.js');
      let inventory = [];
      try { inventory = (await import('../central/inventory.js')).listInventory() || []; } catch { inventory = []; }
      // vCenter 등록부에는 담당 엣지 칸이 없다(normalize 가 버린다 — settingsLinks v2.915 정정) — 등록 칸은 비우고 위임 인벤토리 소유 → 스냅샷 관측 순서를 그대로 쓴다.
      const registry = (built.targets || []).filter((x) => x.kind === 'set:vcenter').map((x) => ({ id: x.ref, collectMode: x.facts?.collectMode, remoteAgent: '' }));
      siteOwner = siteOwnerByVcenter({ registry, inventory, vcenters: snapVcs });
    } catch { siteOwner = new Map(); }
  }
  let corpOf = deps.corpOf || null;
  if (!corpOf) {
    try {
      const m = await import('../svcmon/settingsSync.js');
      const ctx = await m.loadCorpContext();
      corpOf = (x) => m.corpOf(x, ctx);
    } catch { corpOf = () => ({ key: '', label: '' }); }
  }
  let typeLabel = {};
  try { typeLabel = (await import('../storage/types.js')).TYPE_LABEL || {}; } catch { typeLabel = {}; }
  const plan = planTargets(built, { settings, siteOwner, corpOf, mock, previous: _previous, typeLabel });
  const heldEmpty = plan.heldKinds.filter((k) => !(_previous.get(k) || []).length);
  _previous = plan.raw;
  const registered = {};
  for (const r of plan.rows) registered[r.kind] = (registered[r.kind] || 0) + 1;
  _plan = { at: Date.now(), rows: plan.rows, heldKinds: plan.heldKinds, heldEmpty, sourceErrors: plan.sourceErrors, registered, settings, mock };
  return _plan;
}
/** 설정이 바뀌면 다음 조회가 다시 계산하게(제외 · 종류 켜기는 곧바로 보여야 한다). */
export function invalidatePlan() { _plan = null; }

/** 엣지 버전 맵 — 수집 서버 상태(id · 보고한 agent 둘 다 키). */
async function edgeVersions(agents) {
  const out = new Map();
  try {
    const st = (await import('../collector/state.js')).allCollectorStatus();
    for (const a of agents) { const v = edgeVersionOf(a, st); if (v) out.set(a.toLowerCase(), v); }
  } catch { /* 버전 모름 */ }
  for (const [k, r] of _reports) if (r.version && !out.has(k)) out.set(k, r.version);
  return out;
}

/** 화면 행(서버 전용 칸 포함) — 메인 · 알림 · 상세 공용. */
export async function currentRows({ plan, maskAddress = false, now = Date.now() } = {}) {
  const p = plan || await getPlan();
  const settings = p.settings || loadSvcStatusSettings();
  const staleMs = staleLimitMs(settings.intervalMs);
  const latest = await db.latestRows();
  const latestByKey = new Map();
  for (const r of latest || []) latestByKey.set(unitKey(r.id, r.host, r.port), r);
  const buckets = await db.bucketsSince(now - 25 * 3_600_000);
  const byTid = new Map();
  for (const b of buckets || []) { if (!byTid.has(b.tid)) byTid.set(b.tid, []); byTid.get(b.tid).push(b); }
  const agents = [...new Set(p.rows.filter((r) => r.plan === 'edge').map((r) => r.by))];
  const versions = await edgeVersions(agents);
  const rows = buildRows(p.rows, latestByKey, byTid, {
    now, settings, staleMs, maskAddress,
    edge: { reports: new Map(_reports), versions, minEdgeVersion: svcStatusMinEdgeVersion(), startedAt: STARTED_AT, intervalMs: settings.intervalMs },
  });
  return { rows, dbOk: latest != null, settings, staleMs, agents, versions };
}

/** 메인 응답 본문(관리자 판본 — 가림은 라우트가 캐시 밖에서). */
export async function mainPayload({ maskAddress = false, now = Date.now(), pollerStatus = null } = {}) {
  const plan = await getPlan();
  const { rows, dbOk, settings, staleMs, agents, versions } = await currentRows({ plan, maskAddress, now });
  const kinds = Object.keys(KIND_LABEL).filter((k) => settings.kinds?.[k] !== false)
    .map((k) => ({ key: k, label: KIND_LABEL[k], n: rows.filter((r) => r.kind === k).length }));
  const edges = agents.map((a) => {
    const rep = _reports.get(a.toLowerCase()) || null;
    return {
      agent: a, version: versions.get(a.toLowerCase()) || '', lastReportAt: rep?.at ?? null,
      stale: rep ? now - rep.at > staleMs : null, targets: rows.filter((r) => r.byEdge && r.by.toLowerCase() === a.toLowerCase()).length,
      note: rep?.note || '', rejected: rep?.rejected ?? 0, disabled: !!rep?.disabled,
    };
  });
  return {
    ok: true, generatedAt: now, demo: !!plan.mock, demoMasked: 0, addressHidden: !!maskAddress,
    enabled: settings.enabled !== false,
    intervalMs: settings.intervalMs, staleMs, rawDays: db.RAW_DAYS, bucketMs: db.BUCKET_MS,
    rules: { failThreshold: settings.failThreshold, slowFactor: settings.slowFactor, slowMinDeltaMs: settings.slowMinDeltaMs, timeoutMs: settings.timeoutMs, baselineDays: 7 },
    counts: countsOf(rows), kinds, rows: rows.map(publicRow), edges,
    minEdgeVersion: svcStatusMinEdgeVersion(),
    sourceErrors: plan.sourceErrors, heldKinds: plan.heldKinds,
    settingsLoadError: svcStatusSettingsLoadError(), usingLastGood: svcStatusUsingLastGood(),
    poller: pollerStatus, dbOk,
  };
}

/** 상세 본문. 없는 id 면 null. */
export async function detailPayload(id, { range = '24h', maskAddress = false, now = Date.now() } = {}) {
  const plan = await getPlan();
  const { rows, settings } = await currentRows({ plan, maskAddress, now });
  const row = rows.find((r) => r.id === t(id));
  if (!row) return null;
  const rangeKey = Object.hasOwn(RANGES, range) ? range : '24h';
  const span = RANGES[rangeKey];
  const stepMs = stepFor(rangeKey, settings.intervalMs);
  const end = Math.ceil(now / stepMs) * stepMs;
  const start = end - Math.ceil(span / stepMs) * stepMs;
  let series = []; let truncated = false;
  const tid = row._tid ?? (row._host ? await db.tidFor(row.id, row._host, row._port) : null);
  if (tid != null) {
    if (rangeKey === '24h') {
      const s = await db.samplesRange(tid, start, end);
      truncated = !!s?.truncated;
      series = seriesFromSamples(s?.rows || [], { start, end, stepMs });
    } else series = seriesFromBuckets(await db.bucketsRange(tid, start, end) || [], { start, end, stepMs });
  } else series = seriesFromSamples([], { start, end, stepMs });
  const evRows = await db.eventsForId(row.id, 50) || [];
  const units = await db.unitsForId(row.id) || [];
  const events = [
    ...evRows.map((e) => ({ ts: e.ts, from: e.from_state || null, to: e.to_state, ms: n(e.ms), failKind: e.fk || null, by: e.by_node || '', note: '', address: maskAddress ? '' : addressOf(e.host, e.port) })),
    ...units.map((u) => ({ ts: u.first_ts, from: null, to: 'registered', ms: null, failKind: null, by: '', note: '', address: maskAddress ? '' : addressOf(u.host, u.port) })),
  ].sort((a, b) => b.ts - a.ts).slice(0, 50);
  const hostKey = t(row._host).toLowerCase();
  const sameHost = hostKey ? rows.filter((r) => r.id !== row.id && t(r._host).toLowerCase() === hostKey)
    .map((r) => ({ id: r.id, kind: r.kind, kindLabel: r.kindLabel, name: r.name, port: maskAddress ? null : r._port, state: r.state, reason: r.reason, ms: r.ms, baseMs: r.baseMs })) : [];
  return { ok: true, row: publicRow(row), range: rangeKey, start, end, stepMs, series, truncated, events, sameHost, addressHidden: !!maskAddress, intervalMs: settings.intervalMs };
}

/** 설정 화면 '대상을 가져오는 등록부' 표. */
export async function sourcesPayload() {
  const plan = await getPlan();
  return SOURCES.map((s) => {
    const rows = plan.rows.filter((r) => r.kind === s.kind);
    return { ...s, registered: rows.length, targets: rows.filter((r) => r.plan === 'central' || r.plan === 'edge').length, held: plan.heldKinds.includes(s.kind) };
  });
}

/* ───────────────────────── 엣지 ───────────────────────── */

const sameAgent = (a, b) => t(a).toLowerCase() === t(b).toLowerCase();

/**
 * 그 엣지가 잴 대상(자기 몫만 · 토큰 없음). 등록부를 처음부터 못 읽은 종류가 있으면 503 — 빈 목록이 엣지 측정을 멈추게 하지 않는다.
 * @returns {{status:number, body:object}}
 */
export async function edgeConfigFor(agent) {
  const err = svcStatusSettingsLoadError();
  if (err && !svcStatusUsingLastGood()) return { status: 503, body: { ok: false, reason: 'settingsUnreadable', detail: String(err.reason || '').slice(0, 300) } };
  const plan = await getPlan();
  if (plan.heldEmpty.length) return { status: 503, body: { ok: false, reason: 'registryUnreadable', detail: `등록부를 읽지 못했습니다(${plan.heldEmpty.map((k) => KIND_LABEL[k]).join(' · ')}).` } };
  const settings = plan.settings;
  const latest = await db.latestRows();
  const baseOf = new Map((latest || []).map((r) => [unitKey(r.id, r.host, r.port), n(r.base_ms)]));
  const targets = plan.rows.filter((r) => r.plan === 'edge' && sameAgent(r.by, agent)).map((r) => ({
    id: r.id, kind: r.kind, host: r.host, port: r.port,
    timeoutMs: timeoutFor(baseOf.get(unitKey(r.id, r.host, r.port)), settings),
    ...(r.kind === 'storage' ? { type: r.type, method: r.sub } : {}),
  }));
  return {
    status: 200,
    body: { ok: true, enabled: settings.enabled !== false, intervalMs: settings.intervalMs, concurrency: settings.concurrency, dnsTimeoutMs: 3_000, targets, count: targets.length, centralVersion: currentVersion() },
  };
}

/**
 * 엣지 보고 수신 — 정제 · 배정 대조 · 적재.
 * 본문 `{ at, version, note, disabled, results:[{ id, host, port, ok, ms, fk, a, lp }] }`.
 */
export async function putEdgeReport(agent, body, { now = Date.now() } = {}) {
  const ag = t(agent);
  if (!ag) throw new Error('agent 가 비어 있습니다.');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const plan = await getPlan();
  if (plan.heldEmpty.length) return { ok: false, registryUnreadable: true, stored: 0 };
  const assigned = new Map(plan.rows.filter((r) => r.plan === 'edge' && sameAgent(r.by, ag)).map((r) => [r.id, r]));
  const list = Array.isArray(b.results) ? b.results : [];
  const omitted = Math.max(0, list.length - REPORT_MAX);
  let rejected = 0; let notAssigned = 0; let badTime = 0;
  const seen = new Set();
  const rows = [];
  for (const r of list.slice(0, REPORT_MAX)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { rejected += 1; continue; }
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 300) : '';
    const a = assigned.get(id);
    if (!a) { rejected += 1; notAssigned += 1; continue; }
    const host = typeof r.host === 'string' ? r.host.trim() : '';
    const port = Number(r.port);
    if (host.toLowerCase() !== t(a.host).toLowerCase() || port !== a.port) { rejected += 1; continue; }   // 중앙이 준 접속처가 아니다
    let age = n(r.a);
    if (age == null || age < 0 || age > 86_400_000) { badTime += 1; age = 0; }
    const ts = Math.round(now - age);
    const k = `${id}\u0001${ts}`;
    if (seen.has(k)) { rejected += 1; continue; }
    seen.add(k);
    const ok = r.ok === true;
    const ms = ok ? n(r.ms) : null;
    const fk = ok ? null : (typeof r.fk === 'string' && Object.hasOwn(FAIL_KINDS, r.fk) ? r.fk : 'unknown');
    const lp = Number(r.lp);
    rows.push({ id, host: a.host, port: a.port, kind: a.kind, ts, ok, ms: ms != null && ms >= 0 && ms <= 120_000 ? ms : null, fk, by: ag, localPort: Number.isInteger(lp) && lp >= 1 && lp <= 65535 ? lp : undefined });
  }
  rows.sort((x, y) => x.ts - y.ts);
  const out = rows.length ? await db.recordResults(rows, { settings: plan.settings }) : { ok: true, stored: 0, dup: 0, events: 0 };
  _reports.set(ag.toLowerCase(), {
    agent: ag, at: now, version: typeof b.version === 'string' ? b.version.trim().slice(0, 40) : '',
    note: typeof b.note === 'string' ? b.note.trim().slice(0, 200) : '', disabled: b.disabled === true,
    n: list.length, stored: out.stored || 0, rejected, omitted, notAssigned, badTime,
  });
  if (out.dbUnavailable) return { ok: false, dbUnavailable: true, stored: 0 };
  return { ok: true, stored: out.stored || 0, dup: out.dup || 0, rejected, omitted, notAssigned, badTime };
}
export function edgeReports() { return [..._reports.values()].map((r) => ({ ...r })); }

export function _resetSvcStatusServiceForTest() { _previous = new Map(); _plan = null; _planning = null; _reports.clear(); }
