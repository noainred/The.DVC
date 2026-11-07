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
import { buildFabrics, attributeHost, attributeFleet, measuredSharesOf, identityOf, SPLIT_MODES } from '../../sanswitch/attribution.js';
import { ipfForFabrics } from '../../sanswitch/ipf.js';   // v2.929(C-①) IPF 보정
import { recordHosts, weightsFor, startStorPathHistory, historyStatus } from '../../storpath/history.js';   // v2.929(C-①) ESXi 경로 카운터 표본 이력
import { demoSpath, demoWeights } from '../../mock/demo/storpath.js';
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

/**
 * v2.929(C-①): 분배 문맥 — ESXi 경로 표본 가중치(호스트별) · IPF(스위치별) · 분배 방식. 두 라우트가 같은 규칙으로 쓴다.
 *   실측 가중치는 기간 [since, until] 안의 표본만(없으면 null → IPF · 타깃 포트 비율). 데모는 조닝에서 만든 가상 표본(mock/demo/storpath.js).
 *   IPF 의 고정 행 = 실측 몫이 있는 초기자(인벤토리 HBA WWN → 호스트 · 어댑터) — 같은 스위치의 다른 호스트 추정이 실측을 존중한다.
 */
function splitContext({ req, snap, fabrics, bytes }) {
  const q = String(req.query.split || 'auto');
  const split = SPLIT_MODES.includes(q) ? q : 'auto';
  const mock = isMockMode();
  if (!mock) recordHosts(snap.hosts || []);
  const since = Number(bytes?.since) > 0 ? Number(bytes.since) : null;   // 빈 결과(since 0)는 기간 제한 없음이 아니라 '기간 모름' — 표본도 기간 없이 본다
  const until = Number(bytes?.until) > 0 ? Number(bytes.until) : null;
  const memo = new Map();
  const spathOf = (h) => (mock ? demoSpath(h, fabrics) : (h?.spath || null));
  const pathWeightsOf = (h) => {
    if (!h || split !== 'auto') return null;
    if (memo.has(h.id)) return memo.get(h.id);
    const w = mock ? demoWeights(spathOf(h)) : weightsFor(h.id, { since, until });
    memo.set(h.id, w);
    return w;
  };
  let fixedOf = null;
  if (split === 'auto') {
    const byWwn = new Map();
    for (const h of snap.hosts || []) for (const a of Array.isArray(h?.hbas) ? h.hbas : []) { const w = String(a?.wwn || '').toLowerCase(); if (w && !byWwn.has(w)) byWwn.set(w, { h, adapter: a.name }); }
    fixedOf = (w) => { const x = byWwn.get(w); return x ? measuredSharesOf(pathWeightsOf(x.h), x.adapter) : null; };
  }
  const ipf = split === 'ratio' ? null : ipfForFabrics(fabrics, bytes?.ports || null, { fixedOf });
  return { split, ipf, pathWeightsOf, spathOf, mock };
}

/** 호스트 상세 '경로별 실측' 표 — 최근 표본(host.spath)의 타깃마다 스토리지 이름 · 로그인한 스위치 포트 · 경로 상태(hcfg.mp.targets). */
function pathTargetsOf(h, spath, fabrics, storageOf) {
  if (!spath || !Array.isArray(spath.targets)) return null;
  const mp = new Map((Array.isArray(h?.hcfg?.mp?.targets) ? h.hcfg.mp.targets : []).map((t) => [`${t.adapter}|${t.wwn}`, t]));
  return spath.targets.slice(0, 64).map((t) => {
    const f = fabrics.find((x) => x.portByWwn.has(t.wwn)) || null;
    const idn = f ? identityOf(t.wwn, f, fabrics, storageOf) : null;
    const port = f ? f.portByWwn.get(t.wwn) : null;
    const m = mp.get(`${t.adapter}|${t.wwn}`) || null;
    return { ...t, storage: idn ? { id: idn.id, name: idn.name, kind: idn.kind, registered: !!idn.registered } : null,
      switch: f ? { deviceId: f.deviceId, name: f.name } : null, port: port ? { index: port.index, slotPort: port.slotPort ?? null } : null,
      mp: m ? { live: m.live, dead: m.dead, luns: m.luns } : null };
  });
}
const fabricOut = (f, extra = {}) => ({ deviceId: f.deviceId, name: f.name, datacenterId: f.datacenterId, agent: f.agent, collectedAt: f.collectedAt, zoneCount: f.zoneCount, nsKnown: f.nsKnown, portsComplete: f.portsComplete, fv: f.fv, ...extra });

export function registerHostSan(api) {
  // v2.929(C-①): ESXi 경로 카운터 표본 이력 — 이 노드 스냅샷을 5분마다 훑는다(새 엣지 계약 없음 · 인메모리).
  startStorPathHistory(() => store.get()?.hosts || []);
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
    const sc = splitContext({ req, snap, fabrics, bytes });
    const r = attributeHost(h, fabrics, { storageOf, portBytes: bytes?.ports || null, pathWeights: sc.pathWeightsOf(h), ipf: sc.ipf, split: sc.split });
    const spath = sc.spathOf(h);
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
      fabrics: fabrics.map((f) => fabricOut(f)),
      // v2.929(C-①): 분배 방식 · IPF 요약(스위치별) · ESXi 경로 최근 표본(타깃별) · 표본 이력 상태
      split: sc.split, ipf: sc.ipf?.fabrics || [],
      spath: spath ? { at: spath.at, samples: spath.samples, sampleSec: spath.sampleSec, instances: spath.instances, unparsed: spath.unparsed, truncated: !!spath.truncated, mock: !!spath.mock,
        targets: pathTargetsOf(h, spath, fabrics, storageOf) } : null,
      pathWeights: (() => { const w = sc.pathWeightsOf(h); return w ? { samples: w.samples, firstAt: w.firstAt, lastAt: w.lastAt } : null; })(),
      storPathScan: !!config.storPathScan,
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
    const servers = listCvpServers().filter((s) => corp == null || String(s.datacenterId || '') === corp);
    /*
     * v2.924(반증 M-1): 매칭은 **그 호스트 법인의 CVP**(법인 · vCenter 1:1 — 루트 CLAUDE.md)와 법인 미지정 CVP 만 본다. 전체 범위 계정도 같다 —
     *   예전에는 전체 범위 계정이 모든 법인 CVP 를 봐서 다른 법인의 같은 짧은 이름 스위치 포트가 '확정' 으로 붙었다(재현). 호스트 법인을 모르면 예전처럼 볼 수 있는 전부.
     */
    const hostCorp = String(datacenterOfVcenter(h.vcenterId) || '');
    const matchServers = hostCorp ? servers.filter((s) => !String(s.datacenterId || '') || String(s.datacenterId) === hostCorp) : servers;
    const own = rowOwnerOf(matchServers);
    const terms = hostMatchTerms(h);
    const macForms = terms.macs.flatMap((m) => { const p = m.match(/../g); return [p.join(':'), p.join('-'), `${m.slice(0, 4)}.${m.slice(4, 8)}.${m.slice(8)}`, m]; });
    const q = await cdb.portsByDesc([...terms.names, ...macForms]);
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
    res.set('Cache-Control', 'no-store').json({
      ok: true, host: { id: h.id, name: h.name, vcenterId: h.vcenterId },
      uplinks: m.uplinks.map((u) => ({ cvpId: u.cvpId, agent: u.agent, key: u.key, hostname: u.hostname, port: u.port, desc: u.desc ?? '', nic: u.nic, basis: u.basis, basisLabel: BASIS_LABEL[u.basis] || null,
        evidence: u.evidence || null, l2At: u.l2At ?? null, also: (u.also || []).slice(0, 4).map((x) => ({ basis: x.basis, label: BASIS_LABEL[x.basis]?.label || '', evidence: x.evidence || null })),
        oper: u.oper, admin: u.admin, speedBps: u.speedBps, vlan: u.vlan, lag: u.lag, inBps: u.inBps, outBps: u.outBps, inUtil: u.inUtil, outUtil: u.outUtil, inErr: u.inErr, outErr: u.outErr,
        inDrop: u.inDrop ?? null, outDrop: u.outDrop ?? null, day: dayOf(u), hour: hourOf(u), rateTs: u.rateTs, ts: u.ts })),
      conflicts: m.conflicts, terms: m.terms, events, eventsUnavailable, cvpUnavailable: !!q.unavailable, truncated: !!q.truncated,
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
    const sc = splitContext({ req, snap, fabrics, bytes });
    const r = attributeFleet(hosts, fabrics, { storageOf, portBytes: bytes?.ports || null, pathWeightsOf: sc.pathWeightsOf, ipf: sc.ipf, split: sc.split });
    const dcNameOf = (() => { try { const mm = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (k) => mm.get(k) || k || '(법인 미지정)'; } catch { return (k) => k || '(법인 미지정)'; } })();
    const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const corpOf = (vcId) => { const d = vcDc.get(vcId) ?? ''; return { datacenterId: d || NONE_DC, datacenterName: dcNameOf(d) }; };
    res.json({
      ok: true, hours, from, to, rangeIssue: rangeIssue || null, since: bytes?.since ?? null, until: bytes?.until ?? null, bucketMs: bytes?.bucketMs ?? null, datacenterIds: dcs.map((x) => x || NONE_DC),
      rows: r.rows.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })),
      storages: r.storages, hosts: r.hosts.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })),
      zonedOnly: r.zonedOnly.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })), counts: r.counts,
      fabrics: fabrics.map((f) => fabricOut(f, { datacenterId: f.datacenterId || NONE_DC, datacenterName: dcNameOf(f.datacenterId) })),
      split: sc.split, ipf: sc.ipf?.fabrics || [], pathHistory: sc.mock ? { mock: true } : historyStatus(), storPathScan: !!config.storPathScan,   // v2.929(C-①)
      hostsTotal: (snap.hosts || []).length, hostsWithHba: hosts.length, perfUnavailable: !!bytes?.unavailable,
      computedAt: bytes?.computedAt ?? Date.now(), cacheTtlMs: perfQueryTtlMs(), source: bytes?.source ?? null, ...(admin ? {} : { addressHidden: true }),
    });
  });
}
