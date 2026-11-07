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
import { inUserScope, inUserWriteScope, scopedVcenterIds } from '../../auth/scope.js';
import { maskErrText } from './cvp.js';
import { listFlows } from '../../sanswitch/flowJobs.js';
import { hostFlowOut, FLOW_SHOWN_STATES } from '../../sanswitch/flowView.js';
import { loadSettings as loadCvpSettings } from '../../cvp/settings.js';
import { cvpDemoActive } from '../../mock/demo/cvp.js';
import { PARTS_EVERY_MS } from '../../cvp/faults.js';   // v2.935 반증 M-4: 비-admin 오류 사유의 주소 가림(CVP 상태 오류와 같은 규칙)
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
import { ipfForFabrics } from '../../sanswitch/ipf.js';   // v2.935(C-①) IPF 보정
import { recordHosts, weightsFor, startStorPathHistory, historyStatus } from '../../storpath/history.js';   // v2.935(C-①) ESXi 경로 카운터 표본 이력
import { demoSpath, demoWeights } from '../../mock/demo/storpath.js';
import { normSerial } from '../../sanswitch/endpointKey.js';
import { listDevices as listStorageDevices } from '../../storage/registry.js';
import { localSnapshots as storageLocalSnaps } from '../../storage/store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { datacenterOfVcenter, listDatacenters } from '../../datacenter/store.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { ensureSanSwitchDemo } from '../../sanswitch/poller.js';
import * as cdb from '../../cvp/db.js';
import { listServers as listCvpServers, serversForThisNode } from '../../cvp/registry.js';
import { rowOwnerOf } from '../../cvp/overview.js';
import { requestEndpointLookup, pendingEndpointRequest } from '../../cvp/epRequests.js';   // v2.935(C-③)
import { lookupEndpointsNow } from '../../cvp/endpointNow.js';
import { normMac } from '../../cvp/parse.js';
import { matchUplinks, hostMatchTerms, matchL2, mergeUplinks, matchEndpoint, likelyRank, BASIS_LABEL } from '../../cvp/hostMatch.js';

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

/**
 * v2.935(C-③): EndpointLocation '지금 조회' 를 누를 수 있나 — CVP '지금 수집' 과 같은 축(admin · operator).
 *   반증 L-1: 인증이 꺼진 설치는 익명 역할(AUTH_DISABLED_ROLE)을 따른다(toolActorOf — requireRole 과 같은 판정). 예전에는 무조건 참이었다.
 */
const canLocate = (req) => ['admin', 'operator'].includes(toolActorOf(req).role);
// 주기 수집이 실제로 도는가 — 설정 켜짐 또는 데모 CVP(목 모드는 설정이 꺼져 있어도 돈다 — poller.js 와 같은 판정) · 위치 조회 켜짐.
const cvpEndpointScanOn = () => { try { const st = loadCvpSettings(); return (st.enabled === true || cvpDemoActive(serversForThisNode())) && st.endpointScan !== false; } catch { return null; } };
/** 비-admin 응답의 오류 사유 — 주소를 가린다(반증 M-4). */
const reasonFor = (req, servers) => (v) => (v == null || isAdminReq(req) ? v : maskErrText(String(v), servers.map((sv) => sv.host).filter(Boolean)));
const macsOfNics = (list, max = 64) => [...new Set((Array.isArray(list) ? list : []).map((n) => normMac(n?.mac)).filter((m) => m && m.length === 12))].slice(0, max);
/** 그 vCenter(법인)의 CVP — net-uplinks 와 같은 규칙(범위 계정은 자기 법인 · 호스트 법인 + 법인 미지정 CVP). */
function cvpServersFor(req, snap, vcenterId) {
  const corp = corpLimitOf(req, snap, { vcenterId });
  if (corp === '') return [];   // 반증 L-3: 범위 계정 + 법인 미지정 vCenter = 아무 CVP 도 못 본다(귀속 없는 데이터 미노출 — SAN 묶음과 같다)
  const servers = listCvpServers().filter((s) => corp == null || String(s.datacenterId || '') === corp);
  const hostCorp = String(datacenterOfVcenter(vcenterId) || '');
  return hostCorp ? servers.filter((s) => !String(s.datacenterId || '') || String(s.datacenterId) === hostCorp) : servers;
}
/**
 * v2.935(C-③): '지금 조회' — 위임 CVP(다른 엣지 담당)는 요청 큐(엣지가 다음 cvp-config pull 에 가져가 묻고 push 로 올린다), 이 노드가 직접 수집하는 CVP 는 지금 묻는다.
 * @returns {Promise<{ direct: object[], queued: object[] }>}
 */
async function locateNow(servers, macs) {
  const direct = []; const queued = [];
  for (const s of servers.filter((x) => x.enabled !== false).slice(0, 8)) {
    const agent = String(s.agent ?? '').trim();
    // 반증 M-5: 엣지 이름은 대소문자를 가리지 않는다(형제 큐 collectRequestQueue 와 같다).
    if (agent && agent.toLowerCase() !== String(config.agent?.name || '').toLowerCase()) { const q = requestEndpointLookup(agent, s.id, macs); queued.push({ cvpId: s.id, name: s.name || s.id, agent, macs: q.queued }); continue; }
    const r = await lookupEndpointsNow(s.id, macs);
    direct.push({ cvpId: s.id, name: s.name || s.id, ...r });
  }
  return { direct, queued };
}

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
 * v2.935(C-①): 분배 문맥 — ESXi 경로 표본 가중치(호스트별) · IPF(스위치별) · 분배 방식. 두 라우트가 같은 규칙으로 쓴다.
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
  // v2.935(C-①): ESXi 경로 카운터 표본 이력 — 이 노드 스냅샷을 5분마다 훑는다(새 엣지 계약 없음 · 인메모리).
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
      // v2.935(C-①): 분배 방식 · IPF 요약(스위치별) · ESXi 경로 최근 표본(타깃별) · 표본 이력 상태
      split: sc.split, ipf: sc.ipf?.fabrics || [],
      spath: spath ? { at: spath.at, samples: spath.samples, sampleSec: spath.sampleSec, instances: spath.instances, unparsed: spath.unparsed, truncated: !!spath.truncated, mock: !!spath.mock,
        unparsedSamples: Array.isArray(spath.unparsedSamples) ? spath.unparsedSamples.slice(0, 5) : [],   // v2.939: 못 푼 경로 이름 원문(형식 확인 근거)
        targets: pathTargetsOf(h, spath, fabrics, storageOf) } : null,
      pathWeights: (() => { const w = sc.pathWeightsOf(h); return w ? { samples: w.samples, firstAt: w.firstAt, lastAt: w.lastAt } : null; })(),
      storPathScan: !!config.storPathScan,
      // v2.939(C-② 시안): 이 호스트의 Flow Vision 플로우 — ESXi 경로 실측과 나란히(같은 HBA · 타깃 WWN). 범위 법인의 스위치 것만(fabrics).
      flows: (() => { const sw = new Map(fabrics.map((f) => [f.deviceId, f.name])); return listFlows().filter((f) => f.hostId === h.id && FLOW_SHOWN_STATES.has(f.state) && sw.has(f.deviceId)).slice(0, 64).map((f) => hostFlowOut(f, sw.get(f.deviceId))); })(),
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
    // v2.932(점검 A1-03): 범위 계정 + 법인 미지정 vCenter(corp === '')는 CVP 를 하나도 보지 않는다(corpLimitOf 머리말 · 형제 san-attribution 과 같은 판정).
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
    // v2.932(점검 A1-07): MAC 은 표기 4가지를 단서 4개로 늘리지 않고 portsByDesc 가 구분자를 뺀 한 표기로 묻는다(앞 8개만 묻던 상한 때문에 vmnic2 부터 빠졌다).
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
    // v2.935(SAN·CVP 설계 C-③): CVP EndpointLocation — 이 호스트 NIC MAC 을 CVP 가 지금 배운 포트(담당 행만). LLDP 와 다르면 disagree.
    let ep = { uplinks: [], disagree: [] }; let epInfo = null;
    try {
      const ownerKeys = matchServers.map((sv) => ({ agent: String(sv.agent ?? '').trim() ? sv.agent : '', cvpId: sv.id }));
      const er = await cdb.endpointsByMacs(terms.macs, { owners: ownerKeys });
      const epRows = (er.rows || []).filter(own);
      // 반증 M-2: CVP 위치 후보 포트의 LLDP 이웃 — 다른 장비(스위치 사이 포트)면 matchEndpoint 가 버린다.
      const epCand = [...new Map(epRows.map((r) => [`${r.agent}\u0000${r.cvpId}\u0000${r.key}\u0000${r.port}`, r])).values()];
      const epLldp = epCand.length ? ((await cdb.lldpByPorts(epCand)).rows || []).filter(own) : [];
      ep = matchEndpoint({ host: h, epRows, l2Uplinks: l2.uplinks, portLldp: epLldp });
      epInfo = { ...(await cdb.epStatus(ownerKeys)), ...(er.unavailable ? { unavailable: true } : {}), pending: matchServers.some((sv) => pendingEndpointRequest(sv.id)), canLocate: canLocate(req),
        scan: cvpEndpointScanOn(), partsEveryMs: PARTS_EVERY_MS };   // 반증 L-9: 화면이 주기 숫자 · 켜짐을 API 값으로 말한다
    } catch (e) { console.warn(`[hostsan] CVP EndpointLocation 조회 실패: ${e.message}`); epInfo = { error: true }; }
    const descKeys = new Set(md.uplinks.map((u) => `${u.agent ?? ''}\u0000${u.cvpId}\u0000${u.key}\u0000${u.port}`));
    const l2All = [...l2.uplinks, ...ep.uplinks];   // v2.935(C-③)
    const need = l2All.filter((u) => !descKeys.has(`${u.agent ?? ''}\u0000${u.cvpId}\u0000${u.key}\u0000${u.port}`));
    const extra = need.length ? await cdb.portsByKeys(need) : { rows: [] };
    const rowsByKey = new Map((extra.rows || []).filter(own).map((r) => [`${r.agent ?? ''}\u0000${r.cvpId}\u0000${r.key}\u0000${r.port}`, r]));
    const m = { uplinks: mergeUplinks(md.uplinks, l2All, rowsByKey), conflicts: [...md.conflicts, ...l2.conflicts], terms: md.terms };
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
     * v2.932(점검 A1-02): 포트 설명 · CVP 이벤트 제목/설명 · LLDP 근거 문구에는 피어 주소 · URL 이 흔하다 — CVP 화면(/tools/cvp/device · events ·
     *   port-usage)과 bmPortsView 처럼 관리자가 아니면 가린다(같은 함수 cvp.maskErrText · 등록 CVP 주소 포함). 매칭은 위에서 원문으로 끝났다(응답 직전에만 가린다).
     */
    const admin = isAdminReq(req);
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
      ep: epInfo, epDisagree: ep.disagree.slice(0, 16),   // v2.935(C-③): EndpointLocation 현황 · LLDP 와 다른 NIC
      l2: l2Info,   // v2.924(B-②): { fdbDevices, lldpDevices, lastAt } — 0 이면 'LLDP·MAC 테이블 수집 전'(엣지 업그레이드 · 30분 주기) · error 면 조회 실패
    });
  });

  const WRITE_DENIED = { ok: false, error: 'forbidden', reason: '이 vCenter 는 조회만 할 수 있는 범위입니다(쓰기 범위 밖) — CVP 위치 조회는 운영 CVP 에 요청을 만듭니다.' };
  const maskLocate = (r, mask) => ({ ...r, direct: (r.direct || []).map((d) => (d.reason ? { ...d, reason: mask(d.reason) } : d)) });
  // v2.935(SAN·CVP 설계 C-③): CVP EndpointLocation '지금 조회' — 호스트 NIC MAC(64) · VM vNIC MAC(16). 범위 밖 404 → 도구 키 403(cvp) → 역할(admin · operator).
  //   상태를 바꾸지 않지만 운영 CVP 에 요청을 만들므로 '지금 수집' 과 같은 역할로 묶는다. 결과는 net-uplinks · /vms/:id/endpoint-locations 가 읽는다.
  api.post('/hosts/:id/endpoint-locate', invHosts, async (req, res) => {
    const snap = store.get();
    const h = (snap.hosts || []).find((x) => x.id === String(req.params.id || ''));
    if (!h || !inUserScope(req.user, snap, h.vcenterId)) return res.status(404).json(NOT_FOUND);
    const issue = toolIssue(req, 'cvp');
    if (issue) return res.status(403).json({ ok: false, error: 'forbidden', reason: issue.reason, tool: issue.tool });
    if (!canLocate(req)) return res.status(403).json({ ok: false, error: 'forbidden', requiredRole: ['admin', 'operator'], reason: 'CVP 위치 조회는 관리자 · 운영자만 할 수 있습니다.' });
    if (!inUserWriteScope(req.user, snap, h.vcenterId)) return res.status(403).json(WRITE_DENIED);   // 반증 L-2: 조회 밖 404 → 쓰기 밖 403
    const macs = macsOfNics(h.nics, 64);
    if (!macs.length) return res.json({ ok: true, macs: 0, direct: [], queued: [], note: '인벤토리에 이 호스트의 물리 NIC MAC 이 없습니다.' });
    const servers = cvpServersFor(req, snap, h.vcenterId);
    const r = await locateNow(servers, macs);
    res.set('Cache-Control', 'no-store').json({ ok: true, macs: macs.length, ...maskLocate(r, reasonFor(req, servers)) });
  });
  const VM_NOT_FOUND = { ok: false, error: 'VM을 찾을 수 없습니다.', reason: 'VM을 찾을 수 없습니다.' };
  const invVms = requirePerm('inv.vms');
  api.post('/vms/:id/endpoint-locate', invVms, async (req, res) => {
    const snap = store.get();
    const v = (snap.vms || []).find((x) => x.id === String(req.params.id || ''));
    if (!v || !inUserScope(req.user, snap, v.vcenterId)) return res.status(404).json(VM_NOT_FOUND);
    const issue = toolIssue(req, 'cvp');
    if (issue) return res.status(403).json({ ok: false, error: 'forbidden', reason: issue.reason, tool: issue.tool });
    if (!canLocate(req)) return res.status(403).json({ ok: false, error: 'forbidden', requiredRole: ['admin', 'operator'], reason: 'CVP 위치 조회는 관리자 · 운영자만 할 수 있습니다.' });
    if (!inUserWriteScope(req.user, snap, v.vcenterId)) return res.status(403).json(WRITE_DENIED);   // 반증 L-2
    const macs = macsOfNics(v.dev?.nics, 16);
    if (!macs.length) return res.json({ ok: true, macs: 0, direct: [], queued: [], note: '이 VM 의 vNIC MAC 을 아직 읽지 않았습니다(VM 장치 정보).' });
    const servers = cvpServersFor(req, snap, v.vcenterId);
    const r = await locateNow(servers, macs);
    res.set('Cache-Control', 'no-store').json({ ok: true, macs: macs.length, ...maskLocate(r, reasonFor(req, servers)) });
  });
  /**
   * VM 상세 '네트워크 위치(CVP)' — vNIC 마다 CVP 가 답한 위치 · 지금 호스트 업링크와 일치 여부.
   *   호스트 업링크 포트 = 그 호스트 NIC MAC 의 CVP 위치 ∪ 이웃 이름이 그 호스트인 LLDP 포트. 그 집합이 비면 판정 보류(단정하지 않는다).
   */
  api.get('/vms/:id/endpoint-locations', invVms, async (req, res) => {
    const snap = store.get();
    const v = (snap.vms || []).find((x) => x.id === String(req.params.id || ''));
    if (!v || !inUserScope(req.user, snap, v.vcenterId)) return res.status(404).json(VM_NOT_FOUND);
    const issue = toolIssue(req, 'cvp');
    if (issue) return res.status(403).json({ ok: false, error: 'forbidden', reason: issue.reason, tool: issue.tool });
    const servers = cvpServersFor(req, snap, v.vcenterId);
    const owners = servers.map((sv) => ({ agent: String(sv.agent ?? '').trim() ? sv.agent : '', cvpId: sv.id }));
    const own = rowOwnerOf(servers);
    const mask = reasonFor(req, servers);
    const host = (snap.hosts || []).find((x) => x.vcenterId === v.vcenterId && x.name === v.host) || null;
    const nics = (Array.isArray(v.dev?.nics) ? v.dev.nics : []).slice(0, 16).map((n) => ({ label: String(n?.label || n?.name || n?.key || '').slice(0, 64), mac: normMac(n?.mac) })).filter((n) => n.mac && n.mac.length === 12);
    const er = await cdb.endpointsByMacs(nics.map((n) => n.mac), { owners });
    /*
     * 호스트 업링크 = net-uplinks 와 같은 판정(반증 M-3): LLDP 는 matchL2 의 이름 규칙(도메인 — 다른 법인의 같은 짧은 이름을 붙이지 않는다),
     *   CVP 위치는 matchEndpoint(likelihood · 스위치 사이 포트 제외). 위치를 아는 업링크 NIC 이 링크 업 NIC 보다 적으면 '다른 NIC 으로 나갈 수 있다' —
     *   불일치로 단정하지 않고 판정 보류(표준 vSwitch 기본 티밍에서 vmnic1 MAC 은 스위치가 배우지 않는다). LAG(Port-Channel)도 보류(멤버를 모른다).
     */
    let hostUp = []; let upNics = 0;
    if (host) {
      const terms = hostMatchTerms(host);
      const lr = await cdb.lldpByNames([terms.full, terms.short]);
      const l2 = matchL2({ host, lldpRows: (lr.rows || []).filter(own), fdbRows: [], vmMacs: [], portTotals: new Map(), portLldp: [] });
      const hr = await cdb.endpointsByMacs(macsOfNics(host.nics, 64), { owners });
      const hrRows = (hr.rows || []).filter(own);
      const cand = [...new Map(hrRows.map((r) => [`${r.agent}\u0000${r.cvpId}\u0000${r.key}\u0000${r.port}`, r])).values()];
      const pl = cand.length ? ((await cdb.lldpByPorts(cand)).rows || []).filter(own) : [];
      hostUp = [...l2.uplinks, ...matchEndpoint({ host, epRows: hrRows, l2Uplinks: l2.uplinks, portLldp: pl }).uplinks];
      upNics = (Array.isArray(host.nics) ? host.nics : []).filter((n) => n?.device && n.link !== false).length;
    }
    const pk = (r) => `${r.cvpId}\u0000${r.key}\u0000${r.port}`;
    const hostPorts = new Set(hostUp.map(pk));
    const hostSwitches = new Set(hostUp.map((u) => `${u.cvpId}\u0000${u.key}`));
    const knownNics = new Set(hostUp.map((u) => u.nic).filter(Boolean));
    const nicsAllKnown = upNics > 0 && knownNics.size >= upNics;
    const isLag = (p) => /^(port-?channel|po\d)/i.test(String(p || ''));
    const rows = nics.map((n) => {
      const all = (er.rows || []).filter((r) => r.mac === n.mac).filter(own);
      const best = all.reduce((a, r) => Math.max(a, likelyRank(r.likelihood)), -1);
      const locs = all.filter((r) => likelyRank(r.likelihood) === best && best >= 2);   // matchEndpoint 와 같은 규칙(가장 그럴듯한 위치만)
      // 메타는 담당 CVP 것만 · 가장 최근 것(반증 M-3 — 예전에는 아무 CVP 의 첫 행으로 '위치 없음' 을 냈다)
      const metas = (er.meta.get(n.mac) || []).filter(own).sort((a, b) => b.at - a.at);
      const meta = metas[0] || null;
      let verdict; let note = null;
      if (er.unavailable) { verdict = 'unknown'; note = 'CVP 위치 DB 를 읽지 못했습니다'; }
      else if (!locs.length) verdict = !meta ? 'not-asked' : metas.some((m) => m.status === 'none') ? 'none' : meta.status;
      else if (locs.some((r) => hostPorts.has(pk(r)))) verdict = 'match';
      else if (!hostUp.length) { verdict = 'unknown'; note = '이 호스트의 업링크 포트를 아직 모릅니다(LLDP · CVP 위치)'; }
      else if (locs.some((r) => isLag(r.port) && hostSwitches.has(`${r.cvpId}\u0000${r.key}`))) { verdict = 'unknown'; note = 'LAG(Port-Channel) — 멤버 포트를 몰라 판정을 보류합니다'; }
      else if (!nicsAllKnown) { verdict = 'unknown'; note = `호스트 업링크 NIC ${upNics}개 중 ${knownNics.size}개만 위치를 압니다 — 다른 NIC 으로 나갈 수 있어 판정을 보류합니다`; }
      else verdict = 'mismatch';
      // v2.939(L-10): 엣지 시계가 빨라 물어본 시각이 수신 시각으로 잘렸으면 그 차이를 싣는다(화면 '엣지 시계 +n분').
      const edgeAheadMs = meta?.edgeAt != null && meta.edgeAt > meta.at ? meta.edgeAt - meta.at : null;
      return { label: n.label, mac: n.mac, verdict, ...(note ? { note } : {}), askedAt: meta?.at ?? null, ...(edgeAheadMs ? { edgeClockAheadMs: edgeAheadMs } : {}), reason: mask(meta?.reason || null),
        locations: locs.slice(0, 4).map((r) => ({ cvpId: r.cvpId, hostname: r.hostname || r.key, port: r.port, vlan: r.vlan, learnedAt: r.learnedAt, macType: r.macType })) };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, vm: { id: v.id, name: v.name, host: v.host }, hostKnown: !!host, hostPortsKnown: hostUp.length > 0, hostNicsKnown: knownNics.size, hostNicsUp: upNics, rows,
      ...(er.unavailable ? { unavailable: true } : {}), servers: servers.length, pending: servers.some((sv) => pendingEndpointRequest(sv.id)), canLocate: canLocate(req),
      scan: cvpEndpointScanOn(), partsEveryMs: PARTS_EVERY_MS });
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
    // v2.939(C-② 시안): 호스트마다 그 호스트의 Flow Vision 플로우(보이는 스위치 것만) — 엔진이 타깃 → 스토리지로 묶어 행에 '스위치 플로우' 로 싣는다.
    const swIds = new Set(fabrics.map((f) => f.deviceId));
    const flowsByHost = new Map();
    for (const f of listFlows()) { if (!FLOW_SHOWN_STATES.has(f.state) || !swIds.has(f.deviceId) || !f.hostId) continue; if (!flowsByHost.has(f.hostId)) flowsByHost.set(f.hostId, []); flowsByHost.get(f.hostId).push(hostFlowOut(f)); }
    const r = attributeFleet(hosts, fabrics, { storageOf, portBytes: bytes?.ports || null, pathWeightsOf: sc.pathWeightsOf, ipf: sc.ipf, split: sc.split, flowsOf: (h) => flowsByHost.get(h.id) || [] });
    const dcNameOf = (() => { try { const mm = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (k) => mm.get(k) || k || '(법인 미지정)'; } catch { return (k) => k || '(법인 미지정)'; } })();
    const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const corpOf = (vcId) => { const d = vcDc.get(vcId) ?? ''; return { datacenterId: d || NONE_DC, datacenterName: dcNameOf(d) }; };
    res.json({
      ok: true, hours, from, to, rangeIssue: rangeIssue || null, since: bytes?.since ?? null, until: bytes?.until ?? null, bucketMs: bytes?.bucketMs ?? null, datacenterIds: dcs.map((x) => x || NONE_DC),
      rows: r.rows.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })),
      storages: r.storages, hosts: r.hosts.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })),
      zonedOnly: r.zonedOnly.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId, ...corpOf(x.vcenterId) })), counts: r.counts,
      fabrics: fabrics.map((f) => fabricOut(f, { datacenterId: f.datacenterId || NONE_DC, datacenterName: dcNameOf(f.datacenterId) })),
      split: sc.split, ipf: sc.ipf?.fabrics || [], pathHistory: sc.mock ? { mock: true } : historyStatus(), storPathScan: !!config.storPathScan,   // v2.935(C-①)
      hostsTotal: (snap.hosts || []).length, hostsWithHba: hosts.length, perfUnavailable: !!bytes?.unavailable,
      computedAt: bytes?.computedAt ?? Date.now(), cacheTtlMs: perfQueryTtlMs(), source: bytes?.source ?? null, ...(admin ? {} : { addressHidden: true }),
    });
  });
}
