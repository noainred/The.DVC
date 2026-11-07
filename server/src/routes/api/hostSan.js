// 호스트 ↔ SAN 조닝·트래픽 귀속 + CVP 업링크 매칭(v2.920 — 설계 docs/design/san-cvp-traffic/README.md, 시안 D-①~③).
//
//   · GET /hosts/:id/san-attribution   호스트 한 대의 HBA ↔ 스위치 포트 ↔ zone ↔ 스토리지 귀속 + 기간 바이트(확정분/추정분) + 24h 추이.
//                                      게이트: inv.hosts + tools 권한 + 도구 키 san-switch(issueFor) + 범위 밖 호스트 404(v2.207 규칙).
//                                      범위 계정(scope.vcenters)은 **그 호스트 법인(datacenterOfVcenter)의 스위치·스토리지만** 본다 — 법인 미지정 장비는 범위 계정에
//                                      노출하지 않는다('vCenter 귀속 없는 데이터 미노출'). 전체 범위 계정은 전 스위치.
//   · GET /hosts/:id/net-uplinks       CVP 포트 설명에서 호스트(이름·NIC MAC·vmnic)를 찾은 업링크 포트 + 지금 처리량·에러 + 그 장비의 24h 이벤트.
//                                      게이트: inv.hosts + tools 권한 + 도구 키 cvp + 범위 404. 범위 계정은 그 법인 CVP 서버만.
//   · GET /tools/sanswitch/attribution 함대(법인 선택) 호스트 × 스토리지 귀속 — SAN 도구 '호스트 귀속' 보기. tools 권한 + fullScopeOnly(형제 라우트와 같다).
//   판정 코어는 sanswitch/attribution.js · cvp/hostMatch.js(순수) 하나다 — 여기서는 읽어서 넘기고 응답 모양만 만든다.
//   기간 바이트는 perfDb.portBytesMulti(heavyQuery — 기억·합류·감시). 응답에 스위치·스토리지 관리 주소는 싣지 않는다(이름·id 뿐 — 비-admin 은 이름=주소 가림).
import { requirePerm, toolActorOf } from '../../auth/auth.js';
import { inUserScope, scopedVcenterIds } from '../../auth/scope.js';
import { issueFor } from '../../auth/toolAccess.js';
import { userHasPermission } from '../../auth/permissions.js';
import { isAdminReq, maskDeviceAddress } from '../../auth/addressMask.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { rangeParams, NONE_DC } from './sanSwitch.js';
import { listDevices as listSanDevices } from '../../sanswitch/registry.js';
import { localSnapshots as sanLocalSnaps } from '../../sanswitch/store.js';
import { edgeSanSwitchSnapshots } from '../../central/sanSwitchEdge.js';
import { portBytesMulti, perfQueryTtlMs } from '../../sanswitch/perfDb.js';
import { buildFabrics, attributeHost, attributeFleet } from '../../sanswitch/attribution.js';
import { normSerial } from '../../sanswitch/endpointKey.js';
import { listDevices as listStorageDevices } from '../../storage/registry.js';
import { localSnapshots as storageLocalSnaps } from '../../storage/store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { datacenterOfVcenter, listDatacenters } from '../../datacenter/store.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { ensureSanSwitchDemo } from '../../sanswitch/poller.js';
import * as cdb from '../../cvp/db.js';
import { listServers as listCvpServers } from '../../cvp/registry.js';
import { rowOwnerOf } from '../../cvp/overview.js';
import { matchUplinks, hostMatchTerms, matchL2, mergeUplinks, BASIS_LABEL } from '../../cvp/hostMatch.js';

const invHosts = requirePerm('inv.hosts');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('호스트 귀속(함대)은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const EVENT_SINCE_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;   // v2.925(B-③): 업링크 최근 1시간 오류·드롭 합(ESXi 실시간 창과 맞춘다)
const EVENTS_MAX = 20;
const NOT_FOUND = { ok: false, error: '호스트를 찾을 수 없습니다.', reason: '호스트를 찾을 수 없습니다.' };

/** 도구 키 게이트 — hostExport.accessOf 와 같은 판정(관리자는 항상, 그 밖은 tools 권한 + 거부 목록). */
function toolIssue(req, key) {
  const actor = toolActorOf(req);
  const who = !config.auth.enabled ? { role: actor.role } : req.user;
  if (!userHasPermission(who, 'tools')) return { tool: key, reason: '기능(tools) 권한이 없습니다.' };
  return issueFor(actor, key);
}
function perfAbortSignal(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  return ac.signal;
}
const abandoned = (e) => e?.code === 'abandoned';

/** 범위 계정의 법인 제한 — 전체 범위면 null(제한 없음), 범위 계정이면 그 호스트 vCenter 의 법인 id('' 이면 '법인 미지정' = 아무것도 못 본다). */
function corpLimitOf(req, snap, host) {
  if (!scopedVcenterIds(req.user, snap)) return null;
  return String(datacenterOfVcenter(host.vcenterId) || '');
}

/** 등록 스토리지 시리얼 색인(storage-summary 와 같은 규칙) — 시리얼 정규화 → 장비. corp 가 있으면 그 법인만. */
function storageIndex({ corp = null, admin = true } = {}) {
  const devById = new Map(listStorageDevices().map((d) => [d.id, admin ? d : maskDeviceAddress(d)]));
  const bySerial = new Map();
  const put = (key, info) => { if (key && (typeof key === 'string' || typeof key === 'number') && !bySerial.has(normSerial(key))) bySerial.set(normSerial(key), info); };
  for (const snap of [...storageLocalSnaps(), ...edgeStorageSnapshots()]) {
    if (!snap?.ok) continue;
    const d = devById.get(snap.deviceId);
    if (!d) continue;
    if (corp != null && String(d.datacenterId || '') !== corp) continue;
    const info = { id: d.id, name: d.name || snap.name || '', type: d.type || '', datacenterId: String(d.datacenterId || '') };
    const apps = Array.isArray(snap.extra?.appliances) ? snap.extra.appliances : [];
    for (const k of [snap.serial, ...apps.map((a) => (a && typeof a === 'object' ? a.serviceTag : null))]) put(k, info);
  }
  // 스냅샷이 아직 없는 등록 장비도 시리얼이 등록돼 있으면 대조한다.
  for (const d of devById.values()) {
    if (corp != null && String(d.datacenterId || '') !== corp) continue;
    if (d.serial) put(d.serial, { id: d.id, name: d.name || '', type: d.type || '', datacenterId: String(d.datacenterId || '') });
  }
  return (serialNorm) => bySerial.get(serialNorm) || null;
}

/** 중앙 직접 + 엣지 push 스냅샷을 장비별 최신으로 합치고 등록부 이름·법인을 붙인다(목록 라우트와 같은 규칙). */
async function fabricSnapshots({ corp = null, dcSet = null, admin = true } = {}) {
  if (isMockMode()) { try { await ensureSanSwitchDemo(); } catch (e) { console.warn(`[hostsan] 데모 시드 실패: ${e.message}`); } }
  const reg = new Map(listSanDevices().filter((d) => d.enabled !== false).map((d) => [d.id, admin ? d : maskDeviceAddress(d)]));
  const byId = new Map();
  for (const s of [...sanLocalSnaps(), ...edgeSanSwitchSnapshots()]) {
    if (!s?.deviceId || !reg.has(s.deviceId)) continue;   // 등록부에 없는 고아 스냅샷은 귀속에 쓰지 않는다
    const cur = byId.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) byId.set(s.deviceId, s);
  }
  const out = [];
  for (const [id, s] of byId) {
    const d = reg.get(id);
    const dc = String(d.datacenterId || '');
    if (corp != null && dc !== corp) continue;
    if (dcSet && !dcSet.has(dc)) continue;
    out.push({ ...s, name: d.name || s.name || id, datacenterId: dc, agent: d.agent || s.agent || '' });
  }
  return out;
}

export function registerHostSan(api) {
  api.get('/hosts/:id/san-attribution', invHosts, async (req, res) => {
    const snap = store.get();
    const id = String(req.params.id || '');
    const h = id ? (snap.hosts || []).find((x) => x.id === id) : null;
    if (!h || !inUserScope(req.user, snap, h.vcenterId)) return res.status(404).json(NOT_FOUND);
    const issue = toolIssue(req, 'san-switch');
    if (issue) return res.status(403).json({ ok: false, error: 'forbidden', reason: issue.reason, tool: issue.tool });
    const { hours, from, to, issue: rangeIssue } = rangeParams(req.query);
    const admin = isAdminReq(req);
    const corp = corpLimitOf(req, snap, h);
    const snaps = corp === '' ? [] : await fabricSnapshots({ corp, admin });
    const fabrics = buildFabrics(snaps);
    const storageOf = storageIndex({ corp, admin });
    let bytes = null;
    const ids = fabrics.map((f) => f.deviceId);
    if (ids.length) {
      try { bytes = await portBytesMulti(ids, { hours, from, to, series: true, signal: perfAbortSignal(res) }); }
      catch (e) { if (abandoned(e)) return; throw e; }
    }
    const r = attributeHost(h, fabrics, { storageOf, portBytes: bytes?.ports || null });
    // 24h 추이 — 로그인한 HBA 포트의 버킷 평균 합(한 포트라도 표본이 있는 버킷만 · 일부 포트만 있는 버킷은 부분 합이라 null + partial 로 센다).
    let series = null;
    if (bytes?.buckets?.length) {
      const ports = r.hbas.filter((x) => x.status === 'logged-in' && x.port).map((x) => bytes.ports.get(`${x.switch.deviceId}|${x.port.index}`)?.avg || null);
      const n = bytes.buckets.length;
      const sum = new Array(n).fill(null); let partial = 0;
      for (let i = 0; i < n; i++) {
        const vals = ports.map((a) => (a ? a[i] : null));
        const have = vals.filter((v) => v != null).length;
        if (!have) continue;
        if (have < vals.length) { partial += 1; continue; }
        sum[i] = vals.reduce((a, b) => a + b, 0);
      }
      series = { buckets: bytes.buckets, sum, bucketMs: bytes.bucketMs, partialBuckets: partial, ports: ports.length };
    }
    res.set('Cache-Control', 'no-store').json({
      ok: true, hours, from, to, rangeIssue: rangeIssue || null, since: bytes?.since ?? null, until: bytes?.until ?? null, bucketMs: bytes?.bucketMs ?? null,
      host: r.host, status: r.status, hbas: r.hbas, storages: r.storages, totals: r.totals, mpTargets: r.mpTargets, series,
      fabrics: fabrics.map((f) => ({ deviceId: f.deviceId, name: f.name, datacenterId: f.datacenterId, agent: f.agent, collectedAt: f.collectedAt, zoneCount: f.zoneCount, nsKnown: f.nsKnown, portsComplete: f.portsComplete })),
      switches: snaps.length, perfUnavailable: !!bytes?.unavailable, corpLimited: corp != null, corpMissing: corp === '',
      computedAt: bytes?.computedAt ?? Date.now(), cacheTtlMs: perfQueryTtlMs(), source: bytes?.source ?? null, ...(admin ? {} : { addressHidden: true }),
    });
  });

  api.get('/hosts/:id/net-uplinks', invHosts, async (req, res) => {
    const snap = store.get();
    const id = String(req.params.id || '');
    const h = id ? (snap.hosts || []).find((x) => x.id === id) : null;
    if (!h || !inUserScope(req.user, snap, h.vcenterId)) return res.status(404).json(NOT_FOUND);
    const issue = toolIssue(req, 'cvp');
    if (issue) return res.status(403).json({ ok: false, error: 'forbidden', reason: issue.reason, tool: issue.tool });
    const corp = corpLimitOf(req, snap, h);
    // v2.931(점검 A1-03): 범위 계정 + 법인 미지정 vCenter(corp === '')는 CVP 를 하나도 보지 않는다(corpLimitOf 머리말 · 형제 san-attribution 과 같은 판정).
    //   예전에는 '법인 미지정 CVP' 와 같다고 봐 다른 법인 호스트(같은 짧은 이름)의 포트가 나갔다. 전체 범위(corp == null)는 그대로.
    const servers = corp === '' ? [] : listCvpServers().filter((s) => corp == null || String(s.datacenterId || '') === corp);
    /*
     * v2.924(반증 M-1): 매칭은 **그 호스트 법인의 CVP**(법인 · vCenter 1:1 — 루트 CLAUDE.md)와 법인 미지정 CVP 만 본다. 전체 범위 계정도 같다 —
     *   예전에는 전체 범위 계정이 모든 법인 CVP 를 봐서 다른 법인의 같은 짧은 이름 스위치 포트가 '확정' 으로 붙었다(재현). 호스트 법인을 모르면 예전처럼 볼 수 있는 전부.
     */
    const hostCorp = String(datacenterOfVcenter(h.vcenterId) || '');
    const matchServers = hostCorp ? servers.filter((s) => !String(s.datacenterId || '') || String(s.datacenterId) === hostCorp) : servers;
    const own = rowOwnerOf(matchServers);
    const terms = hostMatchTerms(h);
    // v2.931(점검 A1-07): MAC 은 표기 4가지를 단서 4개로 늘리지 않고 portsByDesc 가 구분자를 뺀 한 표기로 묻는다(앞 8개만 묻던 상한 때문에 vmnic2 부터 빠졌다).
    const q = matchServers.length ? await cdb.portsByDesc(terms.names, { macs: terms.macs }) : { rows: [] };
    const rows = (q.rows || []).filter(own);
    const md = matchUplinks(rows, h);
    /*
     * v2.924(SAN·CVP 설계 B-②): LLDP 이웃 · MAC 테이블 근거. 이 호스트 물리 NIC MAC + 지금 이 호스트에 있는 VM 의 vNIC MAC 을 학습한 포트,
     *   이웃 시스템 이름이 이 호스트인 포트를 찾는다(담당 행 · 범위 법인만 — own). 설명 매칭과 포트 단위로 합치고 가장 강한 근거 하나를 쓴다.
     *   L2 로만 찾은 포트는 port_latest 에서 지금 값(처리량·오류·드롭)을 붙인다.
     */
    const vmMacList = [];
    for (const v of snap.vms || []) {
      if (v.vcenterId !== h.vcenterId || v.host !== h.name) continue;
      for (const n of v.dev?.nics || []) { const x = String(n?.mac || '').toLowerCase().replace(/[^0-9a-f]/g, ''); if (x.length === 12) vmMacList.push(x); }
      if (vmMacList.length >= 1024) break;
    }
    let l2 = { uplinks: [], conflicts: [] }; let l2Info = null; let fdbTruncated = false;
    try {
      // 반증 L-3: NIC MAC 과 VM MAC 을 따로 묻는다 — 한 번에 물으면 VM MAC 행이 상한을 채워 NIC MAC 행이 빠졌다.
      const fdbNic = await cdb.fdbByMacs(terms.macs);
      const fdbVm = await cdb.fdbByMacs(vmMacList);
      fdbTruncated = !!(fdbNic.truncated || fdbVm.truncated);
      const lldp = await cdb.lldpByNames([terms.full, terms.short]);
      const fdbRows = [...(fdbNic.rows || []), ...(fdbVm.rows || [])].filter(own); const lldpRows = (lldp.rows || []).filter(own);
      const devs = [...new Map(fdbRows.map((r) => [`${r.agent}\u0000${r.cvpId}\u0000${r.key}`, { agent: r.agent, cvpId: r.cvpId, key: r.key }])).values()];
      const portTotals = devs.length ? await cdb.fdbPortTotals(devs) : new Map();
      // 반증 H-1: MAC 근거 후보 포트의 LLDP 이웃 — 이웃이 다른 장비(peer-link · spine)면 그 포트는 버린다.
      const cand = [...new Map(fdbRows.map((r) => [`${r.agent}\u0000${r.cvpId}\u0000${r.key}\u0000${r.port}`, r])).values()];
      const portLldp = cand.length ? ((await cdb.lldpByPorts(cand)).rows || []).filter(own) : [];
      l2 = matchL2({ host: h, lldpRows, fdbRows, vmMacs: vmMacList, portTotals, portLldp });
      const ownerKeys = matchServers.map((sv) => ({ agent: String(sv.agent ?? '').trim() ? sv.agent : '', cvpId: sv.id }));
      l2Info = { ...(await cdb.l2Status(ownerKeys)), ...(fdbTruncated ? { fdbTruncated: true } : {}) };
    } catch (e) { console.warn(`[hostsan] CVP LLDP·MAC 테이블 조회 실패: ${e.message}`); l2Info = { error: true }; }
    const descKeys = new Set(md.uplinks.map((u) => `${u.agent ?? ''}\u0000${u.cvpId}\u0000${u.key}\u0000${u.port}`));
    const need = l2.uplinks.filter((u) => !descKeys.has(`${u.agent ?? ''}\u0000${u.cvpId}\u0000${u.key}\u0000${u.port}`));
    const extra = need.length ? await cdb.portsByKeys(need) : { rows: [] };
    const rowsByKey = new Map((extra.rows || []).filter(own).map((r) => [`${r.agent ?? ''}\u0000${r.cvpId}\u0000${r.key}\u0000${r.port}`, r]));
    const m = { uplinks: mergeUplinks(md.uplinks, l2.uplinks, rowsByKey), conflicts: [...md.conflicts, ...l2.conflicts], terms: md.terms };
    // 매칭된 장비의 최근 이벤트(장비 호스트명·시리얼·키가 devices 에 있는 것만) — 장비 수가 작아 cvp 단위로 읽고 거른다.
    const devKeys = new Set(); const cvpIds = new Set();
    for (const u of m.uplinks) { cvpIds.add(u.cvpId); for (const k of [u.key, u.hostname, u.serial]) if (k) devKeys.add(String(k).toLowerCase()); }
    let events = []; let eventsUnavailable = false;
    if (cvpIds.size) {
      try {
        const ev = await cdb.listEvents({ cvpIds: [...cvpIds], sinceMs: EVENT_SINCE_MS, limit: 500 });
        eventsUnavailable = !!ev.unavailable;
        events = (ev.events || []).filter(own).filter((e) => (Array.isArray(e.devices) ? e.devices : []).some((d) => devKeys.has(String(d).toLowerCase()))).slice(0, EVENTS_MAX)
          .map((e) => ({ ts: e.ts, severity: e.severity, title: e.title, desc: e.desc, type: e.type, cvpId: e.cvpId, devices: (e.devices || []).slice(0, 4) }));
      } catch (e) { console.warn(`[hostsan] CVP 이벤트 조회 실패: ${e.message}`); eventsUnavailable = true; }
    }
    // v2.923(B-①): 매칭 포트의 최근 24시간 오류·드롭 합(원시 표본 — 값이 없는 표본은 세지 않는다). 포트 16개 상한.
    let sums = new Map();
    try { sums = await cdb.portWindowSums(m.uplinks.map((u) => ({ agent: u.agent, cvpId: u.cvpId, key: u.key, port: u.port })), { sinceMs: EVENT_SINCE_MS, recentMs: HOUR_MS }); }
    catch (e) { console.warn(`[hostsan] CVP 포트 24시간 합 조회 실패: ${e.message}`); }
    const sumOf = (u) => sums.get(`${u.agent ?? ''}\u0000${u.cvpId}\u0000${u.key}\u0000${u.port}`) || null;
    // v2.925(B-③): 최근 1시간 합은 hour 로 따로(ESXi vmnic 실시간 1시간과 같은 창 — 화면의 '어느 쪽 드롭' 판정). day 에는 싣지 않는다.
    const dayOf = (u) => { const x = sumOf(u); if (!x) return null; const { recent, ...rest } = x; return rest; };
    const hourOf = (u) => sumOf(u)?.recent || null;
    const vmMacs = (snap.vms || []).filter((v) => v.vcenterId === h.vcenterId && v.host === h.name).reduce((a, v) => a + ((v.dev?.nics || []).filter((n) => n?.mac).length), 0);
    /*
     * v2.931(점검 A1-02): 포트 설명 · CVP 이벤트 제목/설명 · LLDP 근거 문구에는 피어 주소 · URL 이 흔하다 — CVP 화면(/tools/cvp/device · events ·
     *   port-usage)과 bmPortsView 처럼 관리자가 아니면 가린다(같은 함수 cvp.maskErrText · 등록 CVP 주소 포함). 매칭은 위에서 원문으로 끝났다(응답 직전에만 가린다).
     */
    const admin = isAdminReq(req);
    const { maskErrText } = admin ? { maskErrText: null } : await import('./cvp.js');
    const cvpHosts = admin ? [] : listCvpServers().map((x) => x.host).filter(Boolean);
    const mk = (v) => (admin || v == null ? v : maskErrText(String(v), cvpHosts));
    const mkEv = (v) => {   // 근거는 문구(LLDP 이웃 이름 · MAC 테이블 요약)이거나 객체 — 글자 칸만 가린다
      if (admin || v == null) return v;
      if (typeof v === 'string') return mk(v);
      return typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? mk(x) : x])) : v;
    };
    if (!admin) events = events.map((e) => ({ ...e, title: mk(e.title), desc: mk(e.desc) }));
    res.set('Cache-Control', 'no-store').json({
      ok: true, host: { id: h.id, name: h.name, vcenterId: h.vcenterId },
      uplinks: m.uplinks.map((u) => ({ cvpId: u.cvpId, agent: u.agent, key: u.key, hostname: u.hostname, port: u.port, desc: mk(u.desc ?? ''), nic: u.nic, basis: u.basis, basisLabel: BASIS_LABEL[u.basis] || null,
        evidence: mkEv(u.evidence || null), l2At: u.l2At ?? null, also: (u.also || []).slice(0, 4).map((x) => ({ basis: x.basis, label: BASIS_LABEL[x.basis]?.label || '', evidence: mkEv(x.evidence || null) })),
        oper: u.oper, admin: u.admin, speedBps: u.speedBps, vlan: u.vlan, lag: u.lag, inBps: u.inBps, outBps: u.outBps, inUtil: u.inUtil, outUtil: u.outUtil, inErr: u.inErr, outErr: u.outErr,
        inDrop: u.inDrop ?? null, outDrop: u.outDrop ?? null, day: dayOf(u), hour: hourOf(u), rateTs: u.rateTs, ts: u.ts })),
      conflicts: m.conflicts, terms: m.terms, events, eventsUnavailable, cvpUnavailable: !!q.unavailable, truncated: !!q.truncated, ...(q.termsTruncated ? { termsTruncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
      servers: matchServers.length, hostCorpMatched: !!hostCorp, vmNicMacs: vmMacs, corpLimited: corp != null, corpMissing: corp === '', direction: { in: '서버 송신', out: '서버 수신' },
      l2: l2Info,   // v2.924(B-②): { fdbDevices, lldpDevices, lastAt } — 0 이면 'LLDP·MAC 테이블 수집 전'(엣지 업그레이드 · 30분 주기) · error 면 조회 실패
    });
  });

  api.get('/tools/sanswitch/attribution', toolsPerm, fullScopeOnly, async (req, res) => {
    const { hours, from, to, issue: rangeIssue } = rangeParams(req.query);
    const dcs = String(req.query.datacenterId || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === NONE_DC ? '' : x));
    const dcSet = dcs.length ? new Set(dcs) : null;
    const admin = isAdminReq(req);
    const snaps = await fabricSnapshots({ dcSet, admin });
    const fabrics = buildFabrics(snaps);
    const storageOf = storageIndex({ admin });
    const ids = fabrics.map((f) => f.deviceId);
    let bytes = null;
    if (ids.length) {
      try { bytes = await portBytesMulti(ids, { hours, from, to, signal: perfAbortSignal(res) }); }
      catch (e) { if (abandoned(e)) return; throw e; }
    }
    const snap = store.get();
    // 법인을 골랐으면 그 법인 vCenter 의 호스트만(법인 : vCenter 1:1 — 루트 CLAUDE.md). 전체면 전 호스트.
    const vcDc = new Map((snap.vcenters || []).map((v) => [v.id, String(datacenterOfVcenter(v.id) || '')]));
    const hosts = (snap.hosts || []).filter((x) => Array.isArray(x.hbas) && x.hbas.length && (!dcSet || dcSet.has(vcDc.get(x.vcenterId) ?? '')));
    const r = attributeFleet(hosts, fabrics, { storageOf, portBytes: bytes?.ports || null });
    const dcNameOf = (() => { try { const mm = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (k) => mm.get(k) || k || '(법인 미지정)'; } catch { return (k) => k || '(법인 미지정)'; } })();
    const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const corpOf = (vcId) => { const d = vcDc.get(vcId) ?? ''; return { datacenterId: d || NONE_DC, datacenterName: dcNameOf(d) }; };
    res.json({
      ok: true, hours, from, to, rangeIssue: rangeIssue || null, since: bytes?.since ?? null, until: bytes?.until ?? null, bucketMs: bytes?.bucketMs ?? null, datacenterIds: dcs.map((x) => x || NONE_DC),
      rows: r.rows.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })),
      storages: r.storages, hosts: r.hosts.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })),
      zonedOnly: r.zonedOnly.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })), counts: r.counts,
      fabrics: fabrics.map((f) => ({ deviceId: f.deviceId, name: f.name, datacenterId: f.datacenterId || NONE_DC, datacenterName: dcNameOf(f.datacenterId), collectedAt: f.collectedAt, zoneCount: f.zoneCount, nsKnown: f.nsKnown, portsComplete: f.portsComplete })),
      hostsTotal: (snap.hosts || []).length, hostsWithHba: hosts.length, perfUnavailable: !!bytes?.unavailable,
      computedAt: bytes?.computedAt ?? Date.now(), cacheTtlMs: perfQueryTtlMs(), source: bytes?.source ?? null, ...(admin ? {} : { addressHidden: true }),
    });
  });
}
