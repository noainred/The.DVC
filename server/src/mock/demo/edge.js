/**
 * mock/demo/edge.js — 데모(DATA_SOURCE=mock) 엣지(수집 서버) 그룹(v2.708).
 *
 * mock 에서는 엣지가 0곳이라 통신 지도·데이터 흐름·3단 지도·포탈 점검·엣지 로그·통신 점검이 '등록된 엣지가 없습니다' 로 빈다.
 * 여기서 **중앙 등록부에 mock- 엣지 5곳을 시드**(비어 있을 때만)하고, 각 화면이 읽는 **인메모리 상태**를 데모 값으로 채운다.
 *
 * 규칙(mock/demo/flags.js · DEMO-RULES)
 *  · mock 모드에서만 동작한다 — 모든 진입 함수가 `isMockMode()` 를 먼저 본다.
 *  · 엣지 URL 은 `https://<slug>.demo.invalid:4000` 이고 **실제로 접속하지 않는다** — live 폴러(puller·linkcheck·edgePull)는
 *    `isDemoEdgeId()` 로 mock- 항목을 건너뛴다. `.invalid` 는 RFC 6761 예약 TLD 라 만에 하나 나가도 해석되지 않는다.
 *  · 합성 값은 메인 스냅샷(vCenter·호스트 수)에서 결정적으로(demoHash) 만들고 시간에 따라 조금 흔들린다.
 *  · 판정 모듈(commmap·dataflow·devflow·portalcheck)은 바꾸지 않는다 — 입력만 채운다.
 *  · 상태에 `demo:true` 를 싣는다(화면이 데모임을 말할 수 있게).
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';
import { tokenFingerprintParts } from '../../util/tokenFingerprint.js';

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * 데모 엣지 — vcPrefixes 는 그 엣지가 위임 수집하는 mock vCenter id 접두(MOCK_SCALE 사본 `vc-xx-2` 도 잡힌다).
 * Edge-Shanghai 는 고RTT(약 800ms) 회선을 흉내 내 pull 이 가끔 '저하' 로 보인다 — 화면의 warn 상태를 보여 주려는 것.
 */
export const DEMO_EDGES = Object.freeze([
  { id: 'mock-Edge-Seoul', name: 'mock-Edge-Seoul', slug: 'edge-seoul', datacenter: 'Seoul', vcPrefixes: ['vc-ap-northeast'], rttMs: 18 },
  { id: 'mock-Edge-Singapore', name: 'mock-Edge-Singapore', slug: 'edge-singapore', datacenter: 'Singapore', vcPrefixes: ['vc-ap-southeast'], rttMs: 72 },
  { id: 'mock-Edge-Frankfurt', name: 'mock-Edge-Frankfurt', slug: 'edge-frankfurt', datacenter: 'Frankfurt', vcPrefixes: ['vc-eu-central', 'vc-eu-west'], rttMs: 255 },
  { id: 'mock-Edge-Virginia', name: 'mock-Edge-Virginia', slug: 'edge-virginia', datacenter: 'Ashburn', vcPrefixes: ['vc-us-east'], rttMs: 180 },
  { id: 'mock-Edge-Shanghai', name: 'mock-Edge-Shanghai', slug: 'edge-shanghai', datacenter: 'Shanghai', vcPrefixes: ['vc-cn-east', 'vc-cn-north'], rttMs: 820, degraded: true },
]);

/** 데모 엣지 수집 토큰 — 엣지마다 다르게(같은 값이면 토큰 점검이 '중복' 결함으로 센다). 실제 엣지에 보내지 않는다. */
export function demoEdgeToken(e) { return `demo-${e.slug}-${demoHash(`tok|${e.id}`).toString(16).padStart(8, '0')}${demoHash(`tok2|${e.id}`).toString(16).padStart(8, '0')}`; }
export const DEMO_EDGE_VERSION_FALLBACK = '2.708.0';

/** mock- 접두 수집 서버(데모) — live 폴러는 이 항목에 접속하지 않는다. */
export function isDemoEdgeId(id) { return /^mock-/i.test(String(id ?? '').trim()); }

/** 수집 서버 항목이 데모 엣지인가(id 또는 URL 이 .demo.invalid). */
export function isDemoCollector(c) {
  if (!c) return false;
  if (isDemoEdgeId(c.id)) return true;
  try { return /\.demo\.invalid$/i.test(new URL(String(c.url || '')).hostname); } catch { return false; }
}

export function demoEdgeUrl(e) { return `https://${e.slug}.demo.invalid:4000`; }

// 엣지의 id 와 이름은 같다(실제 엣지는 AGENT_NAME 이 곧 수집 서버 id 다 — 다르면 '아는 엣지' 목록에 두 줄로 보인다).
const byKey = new Map();
for (const e of DEMO_EDGES) { byKey.set(e.id.toLowerCase(), e); byKey.set(e.name.toLowerCase(), e); byKey.set(e.slug, e); byKey.set(e.datacenter.toLowerCase(), e); }
export function demoEdgeOf(idOrName) {
  return byKey.get(String(idOrName ?? '').trim().toLowerCase()) || null;
}

/** 이 vCenter 를 맡는 데모 엣지(없으면 null = 중앙 직접 수집). */
export function demoEdgeOfVcenter(vcId) {
  const id = String(vcId ?? '');
  for (const e of DEMO_EDGES) for (const p of e.vcPrefixes) if (id === p || id.startsWith(`${p}-`)) return e;
  return null;
}

/* ───────────────────────── 등록부 시드 ───────────────────────── */


/* ───────────────────────── 스냅샷 보강(입력) ───────────────────────── */

/**
 * 통신 지도 입력용 스냅샷 vCenter 사본 — mock 이면 데모 엣지가 맡는 vCenter 에 `collectSource:'site'`·`collectedBy` 를 단다.
 * mock 이 아니면 **원본 그대로** 돌려준다(live 동작 불변).
 */
export function demoDecorateVcenters(list) {
  if (!isMockMode() || !Array.isArray(list)) return list;
  return list.map((v) => {
    const e = demoEdgeOfVcenter(v?.id);
    if (!e || v?.collectSource === 'site') return v;
    return { ...v, collectSource: 'site', collectedBy: e.name, demo: true };
  });
}

/** 데모 위임 vCenter 를 등록부 행 모양으로(인벤토리 점검 입력). */
export function demoSiteVcenters(snapVcenters = []) {
  if (!isMockMode()) return [];
  const out = [];
  for (const v of snapVcenters || []) {
    const e = demoEdgeOfVcenter(v?.id);
    if (!e) continue;
    out.push({ id: v.id, name: v.name || v.id, host: v.host || '', collectMode: 'site', remoteAgent: e.name, enabled: true, demo: true });
  }
  return out;
}

/** 데모 위임 vCenter 의 중앙 인벤토리 캐시 행(인벤토리 점검 입력 — central/inventory.js listInventory 모양). */
export function demoInventoryRows(snap, now = Date.now()) {
  if (!isMockMode()) return [];
  const counts = countByVc(snap);
  const out = [];
  for (const v of snap?.vcenters || []) {
    const e = demoEdgeOfVcenter(v?.id);
    if (!e) continue;
    const c = counts.get(v.id) || { hosts: 0, vms: 0, datastores: 0 };
    const at = now - Math.round((5 + demoRand(`inv|${v.id}|${Math.floor(now / MIN)}`) * 50) * 1000);
    out.push({ vcenterId: v.id, agent: e.name, at, generatedAt: at - 2000, pushAt: at, hosts: c.hosts, vms: c.vms, datastores: c.datastores, demo: true });
  }
  return out;
}



/* ───────────────────────── 엣지 로그·토큰 점검(누를 때 당기는 것) ───────────────────────── */

/**
 * 데모 엣지의 엣지 로그 응답 본문(실제 엣지 GET /api/collector/edge-log 모양 — edgelog/collect.js 와 같은 키, 접속 없이 합성).
 * @param {object} c 수집 서버 항목  @param {Array} statusSpec edgelog/spec.js STATUS_SPEC(상태 항목 키·라벨)
 */
export function demoEdgeLogBody(c, { now = Date.now(), version = DEMO_EDGE_VERSION_FALLBACK, limit = 200, statusSpec = [], withStatus = true } = {}) {
  const e = demoEdgeOf(c?.id) || demoEdgeOf(c?.name) || DEMO_EDGES[0];
  const uptimeMs = 2 * 24 * HOUR + (demoHash(e.id) % (6 * HOUR));
  const msgs = [
    '[collector] export 응답 생성 — 호스트 {h}대 · 직렬화 {ms}ms',
    '[central-push] 인벤토리 push 완료 — vCenter {vc}곳 · gzip {kb}KB',
    '[svcmon] 성능 점검 보고 push 완료 — 대상 {n}개',
    '[linkcheck-worker] 링크 {n}개 측정 완료 — 실패 0',
    '[config-pull] 중앙 설정 pull — 변경 없음',
    '[guest-disk] 게스트 디스크 push 완료 — VM {n}대',
  ];
  const n = Math.min(Math.max(10, Number(limit) || 200), 400);
  const items = [];
  const baseId = 50_000 + (demoHash(e.id) % 10_000) + Math.floor(now / 37_000) % 100_000;
  for (let i = n - 1; i >= 0; i--) {
    const at = now - i * 37_000;
    const warn = !!e.degraded && i % 23 === 0;
    const m = msgs[(i + (demoHash(e.id) % msgs.length)) % msgs.length]
      .replace('{h}', String(10 + (demoHash(`${e.id}|${i}`) % 30))).replace('{ms}', String(20 + (demoHash(`${i}|ms`) % 80)))
      .replace('{vc}', String(e.vcPrefixes.length)).replace('{kb}', String(40 + (demoHash(`${i}|kb`) % 160))).replace('{n}', String(3 + (i % 9)));
    items.push({ id: baseId - i, time: new Date(at).toISOString(), level: warn ? 'warn' : 'info', msg: warn ? `[central-push] 중앙 응답 지연 ${e.rttMs * 3}ms — 재시도 1회(데모)` : m });
  }
  const status = withStatus ? (statusSpec || []).slice(0, 60).map((sp) => {
    const failing = !!e.degraded && sp.key === 'push.inventory' && demoRand(`st|${e.id}|${Math.floor(now / (10 * MIN))}`) < 0.3;
    return { key: sp.key, label: sp.label, group: sp.group, ok: !failing, error: failing ? '중앙 응답 시한 초과(데모)' : null, value: { at: now - Math.round(demoRand(`sv|${e.id}|${sp.key}`) * 5 * MIN), ok: !failing, demo: true } };
  }) : null;
  return {
    ok: true, demo: true, at: now,
    node: { agent: c?.id || e.id, hostname: `${e.slug}.corp.example`, version, role: 'edge', datacenter: e.datacenter, pid: 1000 + (demoHash(e.id) % 30000), uptimeMs, startedAt: now - uptimeMs },
    logs: { lastId: baseId, oldestId: items[0]?.id ?? null, matched: items.length, truncated: false, omitted: 0, bufferMax: 1000, items },
    status,
    statusFailed: status ? status.filter((x) => !x.ok).length : null,
    maskedFields: 0,
  };
}

/** 데모 엣지의 토큰 점검 자기보고(central/tokenCheckPull sanitizeEnvelope 입력 모양). 수집 토큰 지문은 중앙 등록값과 같다. */
export function demoTokenReport(c, { now = Date.now(), version = DEMO_EDGE_VERSION_FALLBACK } = {}) {
  const e = demoEdgeOf(c?.id) || demoEdgeOf(c?.name) || DEMO_EDGES[0];
  const name = c?.name || e.name;
  const fp = (tok) => { const p = tokenFingerprintParts(tok); return { set: true, short: p.short || '', len: String(tok).length, space: false, hygiene: [] }; };
  return {
    at: now,
    node: { agent: c?.id || e.id, hostname: `${e.slug}.corp.example`, version, datacenter: e.datacenter, centralUrl: 'https://portal.corp.example' },
    tokens: {
      collector: fp(c?.token || demoEdgeToken(e)),
      centralSend: fp(`demo-central-${e.id}-${demoHash(e.id).toString(16)}`),
      centralGate: { set: false, short: '', len: 0, space: false, hygiene: [] },
      collectorEqualsCentralSend: false, centralGateEqualsCentralSend: null,
    },
    centralRole: { enabled: false, byEnv: false, byIssuedTokens: false },
    selfProbe: { ran: true, ok: true, status: 200, ms: e.rttMs * 2, kind: 'ok', reason: '', yourAgent: c?.id || e.id, tokenMode: 'agent', centralVersion: version, centralInstance: 'central-demo' },
  };
}

/** 토큰 점검 '중앙→엣지 프로브' 데모 결과(portalcheck/tokenProbe putProbeResults 입력 모양 — probeCollectorPing 반환과 같은 필드). */
export function demoProbeResult(row, { now = Date.now(), version = DEMO_EDGE_VERSION_FALLBACK } = {}) {
  const e = demoEdgeOf(row?.agent) || DEMO_EDGES[0];
  return {
    agent: row?.agent || e.id,
    probe: { at: now, ms: e.rttMs * 2, state: 'ok', httpStatus: 200, reason: '', identity: null, version, datacenter: e.datacenter, agentSaid: e.id, hostname: `${e.slug}.corp.example`, evidence: 'proven-same', demo: true },
    centralRole: { probed: true, kind: 'not-central', httpStatus: 404, reason: '', demo: true },
  };
}

/**
 * 중앙 → 데모 엣지 pull(central/edgePull.js)의 합성 응답. 모르는 경로는 null(호출부가 '데모 데이터 없음' 으로 말한다).
 * @returns {Promise<{ms:number, body:object}|null>}
 */
export function demoEdgePullBody(col, path, { now = Date.now(), version = DEMO_EDGE_VERSION_FALLBACK, statusSpec = [], record = null } = {}) {
  if (!isMockMode()) return null;
  const e = demoEdgeOf(col?.id) || demoEdgeOf(col?.name) || DEMO_EDGES[0];
  const [pathOnly, query = ''] = String(path || '').split('?');
  const qs = new URLSearchParams(query);
  const ms = e.rttMs * 2 + Math.round(demoRand(`pull|${e.id}|${Math.floor(now / MIN)}`) * e.rttMs);
  const rec = (bytes) => { try { if (typeof record === 'function') record(`${col?.url || demoEdgeUrl(e)}${pathOnly}`, { status: 200, bytes, ms, now, tag: col?.id || e.id }); } catch { /* 계측 실패는 무시 */ } };
  if (pathOnly === '/api/collector/edge-log') {
    rec(48_000);
    return { ms, body: demoEdgeLogBody(col, { now, version, limit: Number(qs.get('limit')) || 200, statusSpec, withStatus: qs.get('status') !== '0' }) };
  }
  if (pathOnly === '/api/collector/token-check') { rec(1_800); return { ms, body: { ok: true, demo: true, ...demoTokenReport(col, { now, version }) } }; }
  return null;
}

/** vCenter 별 호스트·VM·데이터스토어 수(데모 시드 모듈도 쓴다). */
export function countByVc(snap) {
  const m = new Map();
  const get = (id) => { let c = m.get(id); if (!c) { c = { hosts: 0, vms: 0, datastores: 0 }; m.set(id, c); } return c; };
  for (const h of snap?.hosts || []) get(h.vcenterId).hosts++;
  for (const v of snap?.vms || []) get(v.vcenterId).vms++;
  for (const d of snap?.datastores || []) get(d.vcenterId).datastores++;
  return m;
}

let _lastNsxManagers = [];
/** 마지막 틱의 NSX 매니저(인증서 데모 입력 — certMonitor 가 store 를 불러오지 않게). */
export function _setDemoNsxManagers(list) { _lastNsxManagers = Array.isArray(list) ? list : []; }
/** 인증서 데모 입력(마지막 데모 틱이 남긴 스냅샷 vCenter·NSX 매니저). */
export function demoCertInputs() { return { vcenters: _lastSnapVcs, nsxManagers: _lastNsxManagers }; }

/* ───────────────────────── 통신 점검(linkcheck) ───────────────────────── */

let _lastSnapVcs = [];
/** 마지막 틱의 스냅샷 vCenter(동기 호출부 — links 계산 — 가 쓴다). */
export function _setDemoSnapVcenters(list) { _lastSnapVcs = Array.isArray(list) ? list : []; }

/**
 * 통신 점검 링크 계산 입력 보강 — mock 이고 vCenter 등록부가 비어 있으면 스냅샷 vCenter 를 등록부 행 모양으로 넣고
 * (데모 엣지가 맡는 것은 site + remoteAgent), 엣지↔엣지 짝이 없으면 데모 짝 2개를 넣는다. mock 이 아니면 입력 그대로.
 */
export function demoLinkInputs({ vcenters = [], pairs = [], collectors = [] } = {}) {
  if (!isMockMode()) return { vcenters, pairs };
  const names = new Set((collectors || []).filter(isDemoCollector).map((c) => c.name || c.id));
  if (!names.size) return { vcenters, pairs };
  const outVc = (Array.isArray(vcenters) && vcenters.length) ? vcenters : _lastSnapVcs.map((v) => {
    const e = demoEdgeOfVcenter(v.id);
    const slug = String(v.name || v.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    return { id: v.id, name: v.name || v.id, host: `https://${slug}.demo.invalid`, enabled: true, collectMode: e && names.has(e.name) ? 'site' : 'direct', remoteAgent: e && names.has(e.name) ? e.name : '', demo: true };
  });
  const N = (slug) => demoEdgeOf(slug)?.name || slug;
  const demoPairs = [[N('edge-seoul'), N('edge-singapore')], [N('edge-frankfurt'), N('edge-virginia')], [N('edge-shanghai'), N('edge-seoul')]]
    .filter(([a, b]) => names.has(a) && names.has(b)).map(([from, to]) => ({ from, to }));
  return { vcenters: outVc, pairs: (Array.isArray(pairs) && pairs.length) ? pairs : demoPairs };
}

const RTT_OF = (name) => (demoEdgeOf(name)?.rttMs ?? 40);

/**
 * 링크 하나의 데모 측정 결과(linkcheck/run.js runLink 반환 모양). `judge` 는 linkcheck/phases.js 의 것을 넘긴다(판정 복제 금지).
 * Edge-Shanghai 의 중앙 설정 pull 은 가끔 HTTP 시한 초과로 실패한다(실패 화면을 보여 주려는 것 — 결정적).
 */
export function demoLinkResult(link, { ts = Date.now(), byNode = 'central', judge, summaryText } = {}) {
  const from = String(link?.from || ''); const to = String(link?.to || '');
  const rtt = Math.max(RTT_OF(from === 'central' ? to : from), link?.kind === 'central->vcenter' ? 30 : 0);
  const r = (k) => demoRand(`${link?.id}|${k}|${Math.floor(ts / (15 * MIN))}`);
  const failing = demoEdgeOf(from)?.slug === 'edge-shanghai' && link?.kind === 'edge->central-pull' && r('f') < 0.25;
  const https = link?.scheme !== 'http';
  const steps = {
    dns: { ok: true, ms: 1 + Math.round(r('d') * 6), addrs: [demoIp(`${link?.id}|ip`)] },
    tcp: { ok: true, ms: Math.round(rtt * (0.9 + r('t') * 0.3)) },
  };
  if (https) steps.tls = { ok: true, ms: Math.round(rtt * (1.8 + r('s') * 0.4)), certDaysLeft: 40 + (demoHash(`${link?.to}|cert`) % 300), certStatus: 'ok', protocol: 'TLSv1.3' };
  steps.http = failing
    ? { ok: false, ms: 8000, failKind: 'timeout', error: '응답 시한(8초) 초과 — 고지연 회선(데모)' }
    : { ok: true, ms: Math.round(rtt * (1.1 + r('h') * 0.8)) + 5, status: 200 };
  if (!failing && link?.auth && link.auth !== 'none' && link.auth !== 'vcenter-cred') steps.auth = { ok: true, ms: 0 };
  const verdict = typeof judge === 'function' ? judge(steps) : { ok: !failing, phase: failing ? 'http' : 'ok', failKind: failing ? 'timeout' : null, totalMs: 0, reached: 'http' };
  return { link, ts, verdict, steps, byNode, summary: typeof summaryText === 'function' ? summaryText(link, verdict, steps) : '', detail: { url: '', steps, link: { id: link?.id, kind: link?.kind, from, to, demo: true } }, demo: true };
}

/** 설정 전수 점검 대상 하나의 데모 결과(linkcheck/settingsRun.js runSettingsTarget 반환 모양). */
export function demoSettingsResult(target, { ts = Date.now(), judge, summaryText } = {}) {
  const r = (k) => demoRand(`${target?.id}|${k}|${Math.floor(ts / (15 * MIN))}`);
  const steps = { dns: { ok: true, ms: 1 + Math.round(r('d') * 4), addrs: [demoIp(`${target?.id}|ip`)] }, tcp: { ok: true, ms: 2 + Math.round(r('t') * 25) } };
  const sch = String(target?.scheme || 'https');
  if (sch !== 'http') steps.tls = { ok: true, ms: 8 + Math.round(r('s') * 30), certDaysLeft: 20 + (demoHash(`${target?.id}|cert`) % 400), certStatus: 'ok', protocol: 'TLSv1.2' };
  steps.http = { ok: true, ms: 10 + Math.round(r('h') * 60), status: (demoHash(String(target?.kind)) % 3) === 0 ? 401 : 200 };
  const verdict = typeof judge === 'function' ? judge(steps) : { ok: true, phase: 'ok', failKind: null, totalMs: 0, reached: 'http' };
  const link = { id: target?.id, kind: target?.kind, from: 'portal', to: String(target?.name || target?.ref || ''), host: String(target?.host || ''), port: Number(target?.port) || null };
  return { target, ts, verdict, steps, summary: typeof summaryText === 'function' ? summaryText({ from: '포탈', to: link.to }, verdict, steps) : '', detail: { url: '', steps, target: { id: target?.id, kind: target?.kind, demo: true } }, link, demo: true };
}

/* ───────────────────────── 중계 토폴로지(relaytopo) · HAProxy 경로 점검(relaycheck) ───────────────────────── */

/** 데모 엣지 호스트명인가(.demo.invalid). */
export function isDemoHost(host) { return /\.demo\.invalid$/i.test(String(host || '').trim()); }

/**
 * 데모 중계 토폴로지(relaytopo/store.js saveTopology 입력). 중계 엣지 공인 주소는 그 데모 엣지 수집 서버 호스트명이라
 * 수집 서버 대조가 맞는다. IRS 는 Seoul·Frankfurt 두 사이트만 둔다(나머지는 단독 사이트 — 점검이 그 사실을 말한다).
 */
export function demoRelayTopology() {
  const sites = DEMO_EDGES.map((e) => {
    const withIrs = true;
    return {
      dc: e.datacenter,   // 수집 서버의 datacenter 와 같아야 등록부 대조가 맞는다(relaytopo/validate.js collector-dc-mismatch)
      edge: { privateIp: demoIp(`relay|edge|${e.id}`), publicIp: `${e.slug}.demo.invalid`, vcenterIp: demoIp(`relay|evc|${e.id}`), ssh: { port: 22, username: 'portal' } },
      irs: withIrs ? { privateIp: demoIp(`relay|irs|${e.id}`), publicIp: '', vcenterIp: demoIp(`relay|ivc|${e.id}`), ssh: { port: 22, username: 'portal' } } : {},
      note: '데모 사이트(실제 노드에 접속하지 않습니다)',
    };
  });
  return { main: { name: 'Main', privateIp: '10.10.0.10', publicIp: 'portal.demo.invalid', portalPort: 4000, ssh: { port: 22, username: 'portal' } }, sites };
}

/** relaytopo/ops.js inspectNode 의 데모 결과(SSH 없이). renderManagedBlock 은 호출부가 넘긴다(관리 블록 생성 복제 금지). */
export function demoInspectNode(topo, site, role, { renderManagedBlock } = {}) {
  const e = demoEdgeOf(site?.dc);
  if (!isMockMode() || !e) return null;
  const node = role === 'irs' ? site.irs : site.edge;
  const pp = topo?.main?.portalPort || 4000;
  const services = (topo?.services || []).filter((x) => x.enabled !== false);
  const base = { role, dc: site.dc, host: node?.privateIp || node?.publicIp || '', port: node?.ssh?.port || 22, via: role === 'irs' ? `${site.edge?.privateIp || ''}` : 'direct', source: 'topology', at: Date.now(), ms: e.rttMs * 4, demo: true };
  if (role === 'edge') {
    const block = typeof renderManagedBlock === 'function' ? renderManagedBlock(site, services, topo.main).text : '';
    const listeners = [22, pp, ...services.map((x) => x.listenPort)];
    const hq = services.find((x) => x.target === 'main');
    return { ...base, ok: true,
      node: { hostname: `${e.slug}.corp.example`, ips: [node?.privateIp].filter(Boolean), kernel: '5.14.0-427.el9.x86_64', user: 'portal' },
      haproxy: { installed: true, version: 'HAProxy version 2.4.22-f8e3218 2023/02/14', active: true, activeText: 'active', enabled: true, hasCfg: true, cfg: `global\n    log /dev/log local0\n\ndefaults\n    mode tcp\n\n${block}\n` },
      listeners: [...new Set(listeners)].sort((a, b) => a - b),
      portal: { units: [{ unit: 'vmware-portal.service', active: 'active', sub: 'running' }], env: [`AGENT_NAME=${e.id}`, `CENTRAL_URL=https://portal.demo.invalid:${hq?.targetPort || pp}`, 'EDGE_MODE=all'] },
    };
  }
  const hq = services.find((x) => x.target === 'main');
  const irsSvc = services.find((x) => x.target === 'irs' && x.targetPort === pp);
  return { ...base, ok: true,
    node: { hostname: `irs-${e.slug}.corp.example`, ips: [node?.privateIp].filter(Boolean), kernel: '5.14.0-427.el9.x86_64', user: 'portal' },
    haproxy: { installed: false, version: '', active: false, activeText: 'inactive', enabled: false, hasCfg: false, cfg: '' },
    listeners: [22, pp],
    portal: { units: [{ unit: 'vmware-portal.service', active: 'active', sub: 'running' }], env: [`AGENT_NAME=irs-${e.slug}`, `CENTRAL_URL=http://${site.edge?.privateIp}:${hq?.listenPort || 4001}`, `EDGE_ADVERTISE_URL=http://${site.edge?.publicIp || site.edge?.privateIp}:${irsSvc?.listenPort || 4068}`] },
  };
}

/**
 * relaycheck/checks.js runCheck 의 데모 결과(접속 없음). 데모 호스트가 아니면 null(호출부가 실제 점검).
 * Edge-Shanghai 의 IRS vCenter 포트(4066)는 '연결 거부' 로 실패해 점검 실패·조치 안내 화면을 보여 준다(데모 장애 1건).
 */
export function demoRelayCheck(t, { now = Date.now() } = {}) {
  if (!isMockMode() || !isDemoHost(t?.host)) return null;
  const e = DEMO_EDGES.find((x) => `${x.slug}.demo.invalid` === String(t.host).toLowerCase()) || DEMO_EDGES[0];
  const ms = e.rttMs * 2 + Math.round(demoRand(`rc|${t.key}|${Math.floor(now / (5 * MIN))}`) * e.rttMs);
  const kind = String(t.kind || '');
  if (kind === 'irs-vcenter' && e.slug === 'edge-shanghai') {
    return { ok: false, phase: 'refused', error: 'ECONNREFUSED — IRS vCenter 가 응답하지 않습니다(데모 장애)', ms };
  }
  if (kind === 'edge-portal') return { ok: true, detail: `응답 ${e.id}(${e.slug}.corp.example) v(데모)`, got: { agent: e.id, hostname: `${e.slug}.corp.example` }, ms };
  if (kind === 'irs-portal') return { ok: true, detail: `응답 irs-${e.slug}(데모)`, got: { agent: t.expectAgent || `irs-${e.slug}` }, ms };
  if (kind === 'hq-portal') return { ok: true, detail: 'health 200 v(데모)', got: { instance: 'central-demo', agent: '' }, ms };
  if (kind === 'irs-ssh') return { ok: true, detail: 'SSH-2.0-OpenSSH_8.7(데모)', ms };
  return { ok: true, detail: `TCP ${Math.round(ms / 3)}ms · TLS ${Math.round(ms / 2)}ms · HTTP ${Math.round(ms / 3)}ms(데모)`, ms };
}


/* ───────────────────────── 원격 명령(RMA) · 통합 계정 ───────────────────────── */

/** 데모 RMA 명령 출력(실행하지 않는다 — 출력 모양만 흉내). */
export function demoRmaOutput(cmd, args = {}, e = DEMO_EDGES[0], now = Date.now()) {
  const host = `${e.slug}.corp.example`;
  const h = (k) => demoHash(`${e.id}|${cmd}|${k}`);
  switch (cmd) {
    case 'uptime': return ` ${new Date(now).toISOString().slice(11, 19)} up ${2 + (h('d') % 40)} days,  ${h('u') % 4} users,  load average: 0.${h('a') % 90}, 0.${h('b') % 80}, 0.${h('c') % 70}`;
    case 'hostname': return `   Static hostname: ${host}\n  Operating System: Rocky Linux 9.4 (Blue Onyx)\n            Kernel: Linux 5.14.0-427.el9.x86_64`;
    case 'free': return `               total        used        free      shared  buff/cache   available\nMem:           15731        ${4000 + (h('m') % 6000)}        ${1000 + (h('f') % 3000)}         210        5120        9800\nSwap:           8191           0        8191`;
    case 'df': return `Filesystem      Size  Used Avail Use% Mounted on\n/dev/mapper/rl-root  70G  ${10 + (h('r') % 40)}G  ${20 + (h('v') % 20)}G  ${20 + (h('p') % 50)}% /\n/dev/sda1      1014M  312M  703M  31% /boot\n/dev/mapper/rl-home  200G  ${30 + (h('h') % 100)}G  120G  ${15 + (h('q') % 40)}% /home`;
    case 'sysctl-status': return `● ${args.unit || 'vmware-portal.service'} - VMware Portal\n     Loaded: loaded\n     Active: active (running) since ${new Date(now - 3 * 86400000).toUTCString()}`;
    case 'sysctl-failed': return '  UNIT LOAD ACTIVE SUB DESCRIPTION\n0 loaded units listed.';
    case 'ip-addr': return `lo               UNKNOWN        127.0.0.1/8\nens192           UP             ${demoIp(`rma|ip|${e.id}`)}/24`;
    case 'ss-listen': return 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\nLISTEN 0      511          *:4000             *:*\nLISTEN 0      128          *:22               *:*';
    case 'ping': return `PING ${args.host || 'target'}: 56 data bytes\n64 bytes: icmp_seq=1 ttl=63 time=${(e.rttMs / 10).toFixed(1)} ms\n--- statistics ---\n4 packets transmitted, 4 received, 0% packet loss`;
    default: return `(데모 출력) ${cmd}${Object.keys(args || {}).length ? ` ${JSON.stringify(args)}` : ''} — 데모 모드에서는 엣지에서 실제로 실행하지 않습니다.`;
  }
}


/* ───────────────────────── 글로벌 네트워크 점검 · 3D 구성도 · 네트워크 체크(엣지 핑) ───────────────────────── */

const REGION_RTT = { '아시아': 28, '중국': 70, '북미': 175, '유럽': 255 };

/**
 * health/network.js getNetworkCheck 의 프로브 결과 대용(접속 없음). vCenter 설정이 비어 있는 mock 에서 스냅샷 vCenter·NSX 매니저를
 * 대상으로 만든다. 데모 엣지가 맡는 vCenter 는 '중앙 직접 도달 불가 · 수집 정상'(에이전트 경유)으로 보인다.
 * @returns {Array<{kind,id,name,host,port,region,alive,rttMs,collected}>|null} mock 이 아니면 null
 */
export function demoNetworkProbes(snap, nsxManagers = [], allowed = null, { now = Date.now() } = {}) {
  if (!isMockMode()) return null;
  const out = [];
  for (const v of snap?.vcenters || []) {
    if (allowed && !allowed.has(v.id)) continue;
    const region = v.location?.region || v.region || '';
    const viaEdge = !!demoEdgeOfVcenter(v.id);
    const base = REGION_RTT[region] || 120;
    const rtt = Math.round(base * (0.85 + demoRand(`nc|${v.id}|${Math.floor(now / (5 * MIN))}`) * 0.3));
    out.push({ kind: 'vcenter', id: v.id, name: v.id, host: `${String(v.name || v.id).toLowerCase()}.demo.invalid`, port: 443, region,
      collected: v.status || 'unknown', alive: !viaEdge, rttMs: viaEdge ? null : rtt });
  }
  for (const m of nsxManagers || []) {   // 호출부가 범위로 이미 거른 매니저(nsx/scope.js visibleNsxManagers)
    const base = REGION_RTT[m.region] || 120;
    out.push({ kind: 'nsx', id: m.id, name: m.name || m.id, host: String(m.host || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, ''), port: 443, region: m.region || '',
      alive: true, rttMs: Math.round(base * (0.9 + demoRand(`nc|${m.id}|${Math.floor(now / (5 * MIN))}`) * 0.25)) });
  }
  return out;
}

/** 3D 구성도의 vCenter → 담당 엣지 쌍(인벤토리 push 기록이 없는 mock 에서). mock 이 아니면 빈 배열. */
export function demoVcAgentPairs(vcenters = []) {
  if (!isMockMode()) return [];
  const out = [];
  for (const v of vcenters || []) { const e = demoEdgeOfVcenter(v?.id); if (e) out.push([v.id, e.name]); }
  return out;
}


/* ───────────────────────── 인증서 만료 감시 ───────────────────────── */

/**
 * security/certMonitor.js 의 데모 결과(TLS 접속 없음) — mock 에서 vCenter·NSX 등록부가 비었을 때 스냅샷 vCenter·NSX 매니저로 만든다.
 * 만료 분포가 보이도록 일부는 임박·위험·만료로 둔다(결정적). `statusOf` 는 certExpiryStatus(판정 복제 금지).
 */
export function demoCertItems(statusOf, { now = Date.now(), vcenters = [], nsxManagers = [] } = {}) {
  if (!isMockMode() || typeof statusOf !== 'function') return null;
  const DAY = 86_400_000;
  const mk = (kind, id, name, host, k) => {
    const pick = demoHash(`cert|${id}`) % 20;
    const days = pick === 0 ? -3 : pick <= 2 ? 12 + (pick * 7) : pick <= 5 ? 45 + pick * 6 : 120 + (demoHash(`cd|${id}`) % 600);
    const validTo = now + days * DAY + (demoHash(`ch|${id}`) % DAY);
    const selfSigned = kind === 'vcenter' && (demoHash(`ss|${id}`) % 3 === 0);
    return { kind, id, name, host, port: 443, ...statusOf(validTo, { now }), cn: host, issuer: selfSigned ? host : (kind === 'nsx' ? 'NSX Root CA(데모)' : 'VMCA(데모)'),
      validTo, validFrom: validTo - 2 * 365 * DAY, selfSigned, error: null, demo: true, k };
  };
  const items = [];
  for (const v of vcenters || []) items.push(mk('vcenter', v.id, v.name || v.id, `${String(v.name || v.id).toLowerCase()}.demo.invalid`, items.length));
  for (const m of nsxManagers || []) items.push(mk('nsx', m.id, m.name || m.id, String(m.host || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '') || `${m.id}.demo.invalid`, items.length));
  return items.map(({ k, ...x }) => x);
}

/* ───────────────────────── 폴더 사용량 · 에이전트 작업 · 트래픽 분석 ───────────────────────── */

/** 데모 폴더 사용량 대상(설정 파일에는 쓰지 않는다 — 화면 응답에만 싣는다). mock 이 아니면 빈 배열. */
export function demoDirUsageTargets() {
  if (!isMockMode()) return [];
  const pick = [['edge-seoul', '/mnt/share/home'], ['edge-frankfurt', '/mnt/nas/projects'], ['edge-virginia', '/data/users']];
  return pick.map(([slug, path]) => { const e = demoEdgeOf(slug); return { id: `mock-dir-${slug}`, label: `${e.datacenter} 공유 폴더(데모)`, agent: e.name, instance: 'rma-1', path, topN: 20, intervalHours: 24, enabled: true, demo: true }; });
}



export function demoCaptureResult({ hostA, peer, seconds = 10, rttMs = 40, seed = '' }) {
  const pk = 200 + (demoHash(`cap|${seed}`) % 2000);
  const retrans = demoHash(`rt|${seed}`) % 9 === 0 ? Math.round(pk * 0.07) : demoHash(`rt2|${seed}`) % 5;
  const rst = demoHash(`rs|${seed}`) % 11 === 0 ? 4 : 0;
  const retransPct = Math.round((retrans / pk) * 1000) / 10;
  const issues = [];
  if (rst >= 3) issues.push({ sev: 'warning', title: `연결 리셋(RST) ${rst}건`, detail: '대상이 연결을 거부(포트 닫힘/서비스 비정상)하거나 중간 장비가 끊는 중일 수 있습니다.(데모)' });
  if (retransPct >= 5) issues.push({ sev: 'warning', title: `재전송 ${retransPct}% (${retrans}건)`, detail: '패킷 손실/혼잡/높은 지연 의심 — 경로 품질 점검 필요.(데모)' });
  const half = Math.round(pk / 2);
  return { ok: true, hostA, peer, captured: pk, iface: 'any', seconds,
    analysis: { stat: { packets: pk, syn: 3, synAck: 3, rst, fin: 2, retrans, rttMs, retransPct, durSec: seconds, firstTs: null, lastTs: null,
      toPeer: { packets: half, bytes: half * 820 }, fromPeer: { packets: pk - half, bytes: (pk - half) * 1240 }, topPorts: [{ port: '443', packets: Math.round(pk * 0.7) }, { port: '22', packets: Math.round(pk * 0.1) }] }, issues },
    sample: ['(데모) 실제 tcpdump 를 실행하지 않았습니다.'] };
}


/** 데모 엣지 이름(트래픽 분석 위임 대상 목록용). mock 이 아니면 빈 배열. */
export function demoAgentNames() {
  if (!isMockMode()) return [];
  return DEMO_EDGES.map((e) => e.name);
}


export { demoIp };
