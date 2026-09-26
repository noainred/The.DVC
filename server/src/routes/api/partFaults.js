/**
 * 파트 장애(물리 부품 장애) 라우트 — 특수기능 '파트 장애' 화면용(v2.548).
 *
 * 사용자 요청(2026-09-17): "서버 스토리지 등의 모든 장비에 있는 물리 파트 장애가 발생하면
 * 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면을 만들고 싶어" +
 * "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로 보내게 해줘" → v2.548 재설계
 * ("전체 재설계 · 전부 엣지 판정 · 장애 + 전체 요약").
 *
 * 조회 권한: 스토리지 모니터링과 **같은 기준**이다 — 파트 장애는 vCenter 귀속이 없는 인프라
 * 장비의 상태라 범위 제한 계정에 부분집합을 줄 축이 없다. 빈 값을 주면 '장애 없음' 이라는 거짓이
 * 되므로 **403 으로 거절**한다(`fullScopeOnly` — v2.525 Horizon 규약).
 *
 * ── 화면이 '왜 비었는지' 를 판정할 재료를 응답이 싣는다 ─────────────────────────────
 * 열린 장애 0건은 '정상' 일 수도, '점검이 안 돌았다' 일 수도, '엣지가 구버전이라 보고를 못 한다'
 * 일 수도 있다 — 조치가 정반대다. 그래서 `edges` 는 엣지를 **버전 단위로** 분류한다(v2.548):
 *   fresh(보고 정상) / stale(보고 오래됨) / legacy(v2.547 프로토콜 1 — 닫지 못한다) /
 *   old-version(v2.548 미만 — 보고 자체를 못 한다) / silent(버전은 되는데 보고 없음 — 꺼져 있거나
 *   첫 push 대기) / unknown-version(수집 서버 상태를 모른다).
 *   판정은 `classifyEdges()`(순수)가 하고 테스트가 고정한다.
 *
 * ⚠ 이 라우트는 **장비에 접속하지 않는다**. '지금 점검' 도 스냅샷만 읽는다(재진입 가드는 폴러와 공유).
 */
import { fullScopeOnlyWith } from '../admin/shared.js';
import { requireRole, requirePerm } from '../../auth/auth.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { PART_STATE_LABEL, PART_STATE_TONE, PART_KIND_LABEL, SCOPE_LABEL, SCOPES_OUT_OF_RANGE,
  KEY_KIND_LABEL, KEY_KIND_NOTE, DEVICE_KEY_KIND_LABEL, DEVICE_KEY_KIND_NOTE, HOLD_REASON, PUSH_PROTOCOL } from '../../partfault/types.js';
import { openFaults, recentEvents, partFaultDbStatus, resetInfo } from '../../partfault/db.js';
import { runPartFaultsNow, partFaultStatus } from '../../partfault/poller.js';
import { partFaultPushStatus, pushPartFaultsNow } from '../../partfault/push.js';
import { loadPartFaultSettings, savePartFaultSettings, partFaultEnabled, settingsForAgent } from '../../partfault/settings.js';
import { hookStatus } from '../../partfault/hooks.js';
import { mergeEdgeReports } from '../../central/partFaultEdge.js';
import { listCollectors } from '../../collector/registry.js';
import { allCollectorStatus } from '../../collector/state.js';
import { config, currentVersion } from '../../config.js';
import { isAdminReq, addressMatcher, maskedIdToken, maskedAddressName, scrubberFor } from '../../auth/addressMask.js';

const toolsPerm = requirePerm('tools');
const writeRole = requireRole('admin', 'operator');
const adminOnly = requireRole('admin');
// v2.583: 같은 6줄이 라우트 파일 8곳에 복사돼 있었다 — 공용 팩토리 하나로(사유 문구는 그대로).
const fullScopeOnly = fullScopeOnlyWith('파트 장애 화면은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');

/** 화면이 문구를 복사하지 않도록 라벨은 서버가 단일 소스로 내려준다(CLAUDE.md '코어는 하나다'). */
const LABELS = {
  state: PART_STATE_LABEL, tone: PART_STATE_TONE, kind: PART_KIND_LABEL,
  scope: SCOPE_LABEL, scopeOutOfRange: SCOPES_OUT_OF_RANGE,
  keyKind: KEY_KIND_LABEL, keyKindNote: KEY_KIND_NOTE,
  deviceKeyKind: DEVICE_KEY_KIND_LABEL, deviceKeyKindNote: DEVICE_KEY_KIND_NOTE,
  holdReason: HOLD_REASON, protocol: PUSH_PROTOCOL,
};

/** 프로토콜 2 를 처음 보내는 엣지 버전 — 이 아래는 보고 자체를 못 한다('구버전'). */
export const MIN_EDGE_VERSION = '2.548.0';
const STATE_RANK = { fault: 0, warn: 1 };
const t = (v) => String(v ?? '').trim();

// v2.575 IMP-04: 구현은 `util/cmpVersion.js` 하나다. 예전 이 사본은 **3세그먼트를 강제**해
// `2.5` 를 '버전 미상' 으로 만들었다(tokenScan 사본은 숫자를 돌려줬다 — 같은 입력, 다른 결론).
// ⚠ 재수출(`export … from`)은 이 스코프에 이름을 만들지 않는다 — import 후 export 한다.
import { cmpVersion } from '../../util/cmpVersion.js';
import { pageArgs } from '../../util/pageArgs.js';   // v2.607 DB2607-04

export { cmpVersion };

/**
 * 엣지 분류(순수, v2.548). **보고가 없는 것을 '정상' 이라 하지 않는다** — 왜 없는지를 나눈다.
 * @param {object} p
 * @param {Array} p.collectors  중앙 수집 서버 등록부 `[{id,name,enabled}]`
 * @param {Object} p.status     `allCollectorStatus()` — `{[collectorId]: {version,...}}`
 * @param {Array} p.reports     `mergeEdgeReports().agents`
 */
export function classifyEdges({ collectors = [], status = {}, reports = [], minVersion = MIN_EDGE_VERSION, edgeSwitch = null } = {}) {
  const byAgent = new Map(reports.map((r) => [t(r.agent).toLowerCase(), r]));
  const rows = [];
  const seen = new Set();
  for (const c of collectors) {
    const name = t(c.name); if (!name) continue;
    const key = name.toLowerCase(); seen.add(key);
    const st = status[c.id] || null;
    const version = t(st?.version);
    const r = byAgent.get(key) || null;
    let kind;
    /*
     * v2.603(감사 EDGE2603-05): 중앙이 이 엣지에 **꺼짐을 내려보내고 있으면** 보고가 없는(또는 오래된) 것은 원인을 안다 —
     *   'off'. 예전에는 엣지별 off·전역 off 모두 'silent'(주의색, '꺼져 있거나 첫 push 대기')로 분류해, 중앙이 스스로 정한
     *   사실을 추측으로 말했다(v2.554 '근거가 있으면 말해야 한다'). 신선한 보고가 있으면 그대로 fresh 다(엣지 env 강제 켜짐 —
     *   `PARTFAULT_ENABLED=true` 는 중앙 설정을 이긴다). ⚠ 반대 방향(중앙은 켜짐, 엣지 env 가 강제 끔)은 중앙이 알 수 없어 silent 로 남는다.
     */
    const sw = typeof edgeSwitch === 'function' ? edgeSwitch(name) : null;
    const off = sw && sw.enabled === false;
    if (r && !r.legacy && !r.stale) kind = 'fresh';
    else if (off) kind = 'off';
    else if (r) kind = r.legacy ? 'legacy' : 'stale';
    else if (!version) kind = 'unknown-version';
    else if (cmpVersion(version, minVersion) != null && cmpVersion(version, minVersion) < 0) kind = 'old-version';
    else kind = 'silent';
    rows.push({
      agent: name, enabled: c.enabled !== false, version: version || null, kind,
      ...(kind === 'off' ? { offSource: sw.source || null } : {}),
      at: r?.at || null, ageMs: r?.ageMs ?? null, protocol: r?.protocol || null,
      devices: r?.devices ?? null, devicesFailed: r?.devicesFailed ?? null, open: r?.open ?? null,
      rejected: r?.rejected || 0, omitted: r?.omitted || 0, partsOmitted: r?.partsOmitted || 0, scannedDropped: !!r?.scannedDropped,
    });
  }
  // 등록부에 없는데 보고한 엣지(이름 불일치·삭제된 수집 서버) — 숨기지 않는다.
  for (const r of reports) {
    const key = t(r.agent).toLowerCase();
    if (seen.has(key)) continue;
    rows.push({ agent: r.agent, enabled: null, version: r.version || null, kind: r.legacy ? 'legacy' : (r.stale ? 'stale' : 'fresh'), unregistered: true,
      at: r.at, ageMs: r.ageMs, protocol: r.protocol, devices: r.devices, devicesFailed: r.devicesFailed, open: r.open, rejected: r.rejected || 0, omitted: r.omitted || 0, partsOmitted: r.partsOmitted || 0, scannedDropped: !!r.scannedDropped });
  }
  const counts = {};
  for (const x of rows) counts[x.kind] = (counts[x.kind] || 0) + 1;
  return { rows, counts, minVersion };
}

export function edgesNow() {
  const collectors = (() => { try { return listCollectors(); } catch { return []; } })();
  const status = (() => { try { return allCollectorStatus(); } catch { return {}; } })();
  const merged = mergeEdgeReports();
  // v2.603 EDGE2603-05: 중앙이 각 엣지에 내려보내는 스위치(엣지별 off > 전역) — 'off' 분류의 근거.
  const edgeSwitch = (name) => {
    try {
      const s = loadPartFaultSettings();
      const k = String(name || '').trim().toLowerCase();
      const own = Object.hasOwn(s.edges || {}, k) && typeof s.edges[k]?.enabled === 'boolean';
      return { enabled: settingsForAgent(name).enabled, source: own ? 'edge' : 'global' };
    } catch { return null; }
  };
  return classifyEdges({ collectors, status, reports: merged.agents, edgeSwitch });
}

/** DB 상태 — **파일 경로는 admin 에게만**(operator 는 tools 기본 보유 — v2.500 D/M1 '거부 기본값'). */
/**
 * v2.620(SEC2620-02): poller 의 마지막 실행 기록은 알림 결과마다 파트 키(원문 — IP 로 등록된 iDRAC 이면 주소)를 싣는다.
 * open[] 은 maskPartRow 로 가리면서 같은 응답의 last.notify.results 로 원문이 나가던 형제 경로다(v2.601 AUTHZ-2601-02).
 * 비-admin 에는 결과 목록 대신 개수만 준다.
 */
export function lastView(last, isAdmin) {
  if (isAdmin || !last || typeof last !== 'object') return last ?? null;
  const out = { ...last };
  if (out.notify && typeof out.notify === 'object') {
    const { results, ...rest } = out.notify;
    out.notify = { ...rest, resultsCount: Array.isArray(results) ? results.length : 0, resultsHidden: true };
  }
  return out;
}

function dbView(db, isAdmin) {
  if (!db) return null;
  if (isAdmin) return db;
  const { path: _p, ...rest } = db;
  return { ...rest, redacted: ['path'] };
}

/**
 * 비-admin 가림용 주소 목록(v2.601 AUTHZ-2601-02) — iDRAC·스토리지·SAN 스위치 등록부의 주소.
 * 파트 장애 행은 iDRAC 을 IP 로 등록하면 deviceId·deviceKey·deviceName·partKey 가 전부 그 IP 다
 * (`extract/idrac.js` deviceId = server.id = IP). 등록부를 못 읽어도 IPv4 는 판정기가 늘 잡는다.
 */
export async function partFaultHosts() {
  const hosts = [];
  const pull = async (mod, fn) => {
    try { const m = await import(mod); for (const d of (m[fn]?.() || [])) if (d?.host) hosts.push(d.host); } catch { /* 한 등록부 실패가 나머지를 막지 않게 */ }
  };
  await pull('../../idrac/registry.js', 'loadRegistry');
  await pull('../../storage/registry.js', 'listDevicesWithSecrets');
  await pull('../../sanswitch/registry.js', 'listDevices');
  return [...new Set(hosts.filter((h) => typeof h === 'string' && h))];
}

/**
 * 파트 장애 행(열린 장애·이벤트 공용) 하나를 가린다(순수, 원본 불변). 식별자는 **불투명 토큰**으로 바꿔
 * 행끼리 구분·React key 가 유지되게 하고, `partKey` 안의 장비 키 조각도 같은 토큰으로 바꾼다
 * (같은 장비의 파트끼리 같은 접두를 유지한다). 닫기(POST /close)는 adminOnly 라 원문 partKey 가 필요 없다.
 */
export function maskPartRow(r, match, hosts = []) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  const raws = [];
  for (const f of ['deviceId', 'deviceKey']) {
    if (match(out[f])) { raws.push(out[f]); out[f] = maskedIdToken(out[f]); }
  }
  if (match(out.deviceName)) { raws.push(out.deviceName); out.deviceName = maskedAddressName(out.deviceName); }
  if (typeof out.partKey === 'string') {
    // 긴 것부터(10.0.0.50 이 10.0.0.5 에 먹히지 않게). partKey 는 scope:deviceKey:kind:partId.
    let pk = out.partKey;
    for (const raw of [...new Set(raws)].sort((a, b) => b.length - a.length)) pk = pk.split(raw).join(maskedIdToken(raw));
    pk = pk.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (ip) => maskedIdToken(ip));
    out.partKey = pk;
  }
  const scrub = scrubberFor(hosts || []);
  for (const f of ['detail', 'label', 'rawState']) {
    // v2.602 RECENT2602-01: 주소 목록의 치환기는 목록당 한 번(scrubberFor 캐시) — 행의 원문(raws)만 더한다.
    if (typeof out[f] === 'string') out[f] = scrub(out[f], raws);
  }
  return out;
}

export function registerPartFaults(api) {

/** 열린 장애 + 판정 재료. 화면의 주 조회. */
api.get('/tools/part-faults', toolsPerm, fullScopeOnly, async (req, res) => {
  const scope = t(req.query.scope);
  const isAdmin = req.user?.role === 'admin';
  const [open, st] = await Promise.all([openFaults({ scope }).catch(() => []), partFaultStatus().catch(() => null)]);
  open.sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || (b.firstSeenAt || 0) - (a.firstSeenAt || 0));
  const summary = { fault: 0, warn: 0 };
  const devices = new Set();
  for (const p of open) { if (summary[p.state] != null) summary[p.state] += 1; devices.add(`${p.agent}|${p.scope}|${p.deviceId}`); }
  const role = config.agent.centralUrl ? 'edge' : 'central';
  // v2.601 AUTHZ-2601-02: 비-admin 에는 IP 로 등록한 iDRAC 의 식별자(deviceId·deviceKey·partKey·이름)를 가린다.
  let shown = open;
  if (!isAdmin) {
    const hosts = await partFaultHosts();
    const match = addressMatcher(hosts);
    shown = open.map((p) => maskPartRow(p, match, hosts));
  }
  res.json({
    ok: true, role, version: currentVersion(),
    open: shown, summary: { ...summary, devices: devices.size },
    ...(isAdmin ? {} : { addressHidden: true }),
    labels: LABELS,
    poller: st ? { enabled: st.enabled, source: st.source, intervalMs: st.intervalMs, busy: st.busy, last: lastView(st.last, isAdmin) } : null,
    db: dbView(st ? st.db : await partFaultDbStatus().catch(() => null), isAdmin),
    reset: st?.reset || null,
    edges: role === 'central' ? edgesNow() : null,
    push: role === 'edge' ? partFaultPushStatus() : null,
    hook: hookStatus(),
    settings: isAdmin ? loadPartFaultSettings() : null,
  });
});

/** 전이 이력(열림/변화/해소). **전이만** 기록되므로 그대로 시간순 목록이다. */
api.get('/tools/part-faults/events', toolsPerm, fullScopeOnly, async (req, res) => {
  const days = Math.min(730, Math.max(1, Number(req.query.days) || 30));
  // v2.607 DB2607-04: 정수화·하한 — limit=1.5 가 REAL 로 바인딩돼 'datatype mismatch' 가 났고 아래 .catch 가 빈 이력으로 삼켰다.
  const { limit } = pageArgs(req.query, { def: 500, max: 2_000 });
  let partKey = t(req.query.partKey);
  const agent = t(req.query.agent);
  const isAdmin = isAdminReq(req);
  const hosts = isAdmin ? [] : await partFaultHosts();
  const match = addressMatcher(hosts);
  /*
   * v2.601 AUTHZ-2601-02: 비-admin 은 가린 partKey 를 들고 온다 — 열린 장애에서 같은 가림 결과를 찾아
   * 원문으로 되돌린다(못 찾으면 그대로 두어 빈 결과가 된다 — 지어내지 않는다).
   */
  if (!isAdmin && partKey && partKey.includes('masked-')) {
    const hit = (await openFaults().catch(() => [])).find((r) => t(r.agent).toLowerCase() === agent.toLowerCase()
      && maskPartRow(r, match, hosts).partKey === partKey);
    if (hit) partKey = hit.partKey;
  }
  // v2.607 DB2607-04: 조회 실패를 빈 배열로 삼키면 화면이 '전이 이력 없음' 이라 말한다 — 사유를 응답에 싣는다.
  let eventsError = null;
  const events0 = await recentEvents({ sinceMs: days * 86_400_000, limit, partKey: partKey ? { agent, partKey } : '' })
    .catch((e) => { eventsError = String(e?.message || e).slice(0, 200); return []; });
  const events = isAdmin ? events0 : events0.map((e) => maskPartRow(e, match, hosts));
  res.json({ ok: true, events, days, limit, labels: LABELS, truncated: events.length >= limit,
    ...(eventsError ? { eventsError } : {}),
    ...(isAdmin ? {} : { addressHidden: true }),
    db: dbView(await partFaultDbStatus().catch(() => null), req.user?.role === 'admin') });
});

/**
 * 지금 점검(수동). 중앙이면 전이·알림까지, 엣지면 즉시 push. 폴러와 **같은 재진입 가드**를 공유한다.
 * ⚠ 장비 왕복이 없으므로 '자동 재시도 금지'(계정 잠금) 규칙의 대상이 아니다.
 */
api.post('/tools/part-faults/scan', writeRole, toolsPerm, fullScopeOnly, async (req, res) => {
  const r = config.agent.centralUrl ? await pushPartFaultsNow({ reason: 'manual' }) : await runPartFaultsNow({ notify: true, reason: 'manual' });
  logAudit({ user: req.user?.username, action: config.agent.centralUrl ? '파트 장애 지금 push' : '파트 장애 지금 점검',
    detail: r.ok ? (r.stats ? `신규 ${r.stats.opened} · 해소 ${r.stats.closed} · 변화 ${r.stats.changed}` : `장비 ${r.devices ?? 0}대 · 열린 장애 ${r.open ?? 0}건`) : String(r.reason || '실패') });
  res.status(r.ok ? 200 : 409).json(r);
});

/** 상태 — 폴러·DB·push·엣지 분류를 한 번에(진단 화면용). */
api.get('/tools/part-faults/status', toolsPerm, fullScopeOnly, async (req, res) => {
  const st = await partFaultStatus().catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
  res.json({ ok: true, ...st, last: lastView(st.last, req.user?.role === 'admin'), db: dbView(st.db, req.user?.role === 'admin'), version: currentVersion(),
    push: config.agent.centralUrl ? partFaultPushStatus() : null, edges: config.agent.centralUrl ? null : edgesNow(), hook: hookStatus() });
});

/**
 * 스위치 저장(중앙 admin). `{enabled, edges:{[agent]:{enabled}}}`. 엣지는 다음 설정 pull(기본 10분)에 받는다 —
 * **주기 숫자를 문구에 박지 말 것**(엣지 pull 주기는 env 로 바뀐다). 응답이 `appliesTo` 로 '엣지는 pull 뒤' 를 말한다.
 */
api.put('/tools/part-faults/settings', adminOnly, fullScopeOnly, (req, res) => {
  if (config.agent.centralUrl) return res.status(409).json({ ok: false, reason: '엣지에서는 스위치를 저장할 수 없습니다 — 중앙 설정이 내려옵니다.' });
  const before = loadPartFaultSettings();
  const s = savePartFaultSettings(req.body || {});
  logAudit({ user: req.user?.username, action: '파트 장애 스위치 저장', detail: `enabled ${before.enabled}→${s.enabled} · 엣지별 ${Object.keys(s.edges).length}곳` });
  res.json({ ok: true, settings: s, effective: partFaultEnabled(), appliesTo: { central: 'immediate', edges: 'next-config-pull' } });
});

/**
 * 관리자 닫기(v2.548 리뷰 C5) — 재배정·등록 삭제로 **어떤 수집도 다시 보지 않을** 장애를 사람이 사유를 적어 닫는다.
 * 자동으로 닫지 않는 이유: '보고에 없음' 은 '고쳐짐' 이 아니다(규칙 ④). 이벤트는 closeReason `manual` 로 남고
 * 감사 로그에 사유를 적는다. 열려 있지 않은 키는 404(이미 닫힘·키 불일치).
 */
api.post('/tools/part-faults/close', adminOnly, fullScopeOnly, async (req, res) => {
  const agent = String(req.body?.agent ?? '').trim().toLowerCase();
  const partKey = String(req.body?.partKey || '').trim();
  const note = String(req.body?.reason || '').trim().slice(0, 200);
  if (!partKey) return res.status(400).json({ ok: false, reason: 'partKey 가 필요합니다.' });
  const row = (await openFaults()).find((r) => String(r.agent || '').toLowerCase() === agent && r.partKey === partKey);
  if (!row) return res.status(404).json({ ok: false, reason: '열린 장애가 아닙니다(이미 닫혔거나 키가 다릅니다).' });
  const { applyTransition } = await import('../../partfault/db.js');
  const now = Date.now();
  const r = await applyTransition({ opened: [], updated: [], closed: [{ ...row, rawState: note || row.rawState, closedAt: now, closeReason: 'manual' }], held: [] }, { now });
  logAudit({ user: req.user?.username, action: '파트 장애 수동 닫기', detail: `${agent || '중앙'}|${partKey} · ${row.deviceName || row.deviceId} · ${note || '(사유 없음)'}` });
  res.json({ ok: r.saved !== false, saved: r.saved, closeReason: 'manual', reason: r.saved === false ? r.reason : undefined });
});

/** 키 체계 변경으로 이력을 새로 시작했는지(v2.548 스키마 v2) — 화면 배지 근거. */
api.get('/tools/part-faults/reset', toolsPerm, fullScopeOnly, async (_req, res) => {
  res.json({ ok: true, reset: await resetInfo().catch(() => null) });
});

}
