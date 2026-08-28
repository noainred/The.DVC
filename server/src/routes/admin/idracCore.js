// iDRAC 등록/전력/하드웨어 분석(NIC·온도·펌웨어·GPU 인벤토리) — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { listPhysical } from '../../gpu/physicalRegistry.js';
import { listRegistry as listServers, addServer, testServer, loadRegistry as loadIdracRegistry } from '../../idrac/registry.js';
import { getPollerStatus, pollNow } from '../../idrac/poller.js';
import { purgeStalePower, measuredPowerBreakdown } from '../../idrac/service.js';
import { loadPowerSettings, savePowerSettings } from '../../idrac/powerSettings.js';
import { getInventory as getIdracInventory } from '../../idrac/invCache.js';
import { getSensorSeries } from '../../idrac/sensorStore.js';
import { roomTempReport } from '../../idrac/roomTemp.js';
import { roomTempHistory } from '../../idrac/roomTempSeries.js';
import { getMetricsDb } from '../../metrics/db.js';
import { hardwareDimMatch } from '../../idrac/hwMatch.js';
import { partBuckets, serversWithPart, isPartCat } from '../../idrac/partsInventory.js';
import { snapMemo } from '../../util/snapCache.js';
import { listDatacenters, getDatacenterAssign } from '../../datacenter/store.js';
import { adminOnly, hostVcByTag, hostNameByTag, hostNicsByTag, withMappedVc, remoteServersResolved, analysisServersWithRemote, invForServer } from './shared.js';

export function registerIdracCore(adminRouter) {

// ---- iDRAC power collection (Dell Redfish) --------------------------------

// List registered Dell servers (credentials redacted) + poller status.
// 중앙 로컬 레지스트리 + 위임 법인의 원격 서버(엣지 수집분)를 병합해 반환한다(id 중복은 중앙 우선).
// 원격 서버는 remote:true로 표시(프론트가 구분/상세 처리). 서버 자격증명은 애초에 실려오지 않는다.

/**
 * 법인 전산실 운영 온도(v2.381) — 모든 법인의 흡기·배기·CPU 온도 범위를 한 번에 반환.
 * iDRAC 폴러가 이미 수집한 sensorStore 값을 재집계하므로 추가 Redfish 호출이 없다.
 * scope: 범위 제한 계정은 허용 vCenter 에 귀속된 서버만 집계한다(범위 밖 시설 온도 유출 차단).
 */
/**
 * 법인 전산실 온도 추이(v2.384) — 흡기/배기/CPU 를 1일~1년 기간으로 조회.
 * ?kind=inlet|exhaust|cpu · ?group=<법인id|빈값=전체> · ?range=1d|7d|30d|90d|180d|365d
 * 데이터는 샘플러가 적재한 roomtemp_* 계열(법인 단위 집계)이며, 60분+ 버킷은 시간당 롤업을
 * 자동 사용해 365일도 원본 풀스캔 없이 조회한다.
 * ⚠ 적재는 v2.384 부터 시작되므로 그 이전 구간은 데이터가 없다(collectedSince 로 알린다).
 */
adminRouter.get('/room-temp/history', adminOnly, async (req, res) => {
  try {
    const db = await getMetricsDb();
    res.json(await roomTempHistory(db, {
      kind: String(req.query.kind || 'inlet'),
      group: String(req.query.group || ''),
      range: String(req.query.range || '7d'),
    }));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

adminRouter.get('/room-temp', adminOnly, (req, res) => {
  try {
    // v2.383: 소스를 **서버 분석 › 법인별 온도(/admin/idrac/temps)와 동일**하게 맞춤.
    // analysisServersWithRemote = 중앙 로컬 + 위임 엣지 병합(datacenterId 해석 포함) —
    // 위임 환경에서 온도 데이터가 실제로 있는 곳이다(그 화면이 서버 864/965·센서 3,747개 표시).
    // ⚠ scope 주의(v2.387 주석 교정): analysisFilter(req) 는 **클라이언트가 보낸 query 필터**
    //   (?vcenterId/?datacenterId)일 뿐 사용자 데이터 범위(scopedVcenterIds)가 아니다.
    //   즉 이 라우트는 범위 제한을 걸지 않는다 — 기존 /admin/idrac/temps 등 '서버 분석' 계열과
    //   동일한 정책(adminOnly)이다. 범위 제한을 도입하려면 그 계열 전체를 함께 바꿔야 한다.
    res.json(roomTempReport(analysisServersWithRemote(req)));
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

adminRouter.get('/idrac', adminOnly, (_req, res) => {
  const tagMap = hostVcByTag();
  const mapTag = (s) => (tagMap.get(String(s.serviceTag || s.inv?.system?.serviceTag || '').trim().toLowerCase()) || '');
  const local = listServers().map((s) => ({ ...s, mappedVcenterId: s.vcenterId || mapTag(s), model: s.model || getIdracInventory(s.id)?.system?.model || '' }));
  const seen = new Set(local.map((s) => String(s.id)));
  const remote = remoteServersResolved()
    .filter((s) => !seen.has(String(s.id)))
    .map((s) => ({ id: s.id, name: s.name, host: s.host, serviceTag: s.serviceTag || '', model: s.model || s.inv?.system?.model || '', vcenterId: s.vcenterId || '', mappedVcenterId: s.vcenterId || mapTag(s), datacenterId: s.datacenterId || '', type: s.type || 'idrac', remote: true, collectorId: s.collectorId, hasInventory: !!s.inv }));
  res.json({ servers: local.concat(remote), poller: getPollerStatus() });
});

// Register a server, then poll immediately so power shows up right away.
adminRouter.post('/idrac', adminOnly, async (req, res) => {
  const result = addServer(req.body || {});
  if (result.ok) pollNow().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

// NOTE: 파라미터 라우트 PUT/DELETE '/idrac/:id'는 '/idrac/scan-ranges'·'/idrac/power-settings'
// 같은 리터럴 라우트를 가리지 않도록 이 섹션의 '맨 끝'(모든 리터럴 라우트 뒤)에 정의한다.

// Test connectivity + read current power for a server (new or saved by id).
adminRouter.post('/idrac/test', adminOnly, async (req, res) => {
  res.json(await testServer(req.body || {}));
});

// Trigger an immediate poll of all servers.
adminRouter.post('/idrac/poll', adminOnly, async (_req, res) => {
  res.json({ ok: true, lastRun: await pollNow() });
});

// 전력 집계 표시 설정 — excludeUnmapped: vCenter 미매핑 측정 전력을 총합/보고/목록에서 제외.
adminRouter.get('/idrac/power-settings', adminOnly, (_req, res) => res.json({ ok: true, settings: loadPowerSettings() }));
adminRouter.put('/idrac/power-settings', adminOnly, async (req, res) => {
  const settings = savePowerSettings(req.body || {});
  await store.refresh().catch(() => {}); // Overview 총합/보고 즉시 반영
  logAudit({ user: req.user?.username, action: '전력 집계 설정 변경', target: `미매핑 제외=${settings.excludeUnmapped}` });
  res.json({ ok: true, settings });
});

// 오류/고아 전력 데이터 정리 — '전력 보고' 수가 등록 수보다 비정상적으로 많을 때 정리한다.
// body.mode='stale'(기본): 등록 해제된 OME/수집서버 잔여 + 고아 DB 행만 삭제(활성 소스 보존).
// body.mode='all'(강제): 등록 여부 무관하게 OME 캐시·원격 호스트 전체를 비우고 등록 iDRAC 외 DB 행 삭제.
//   (등록된 OME/수집기가 있으면 다음 폴링에 다시 채워질 수 있음 = 출처가 실데이터.) 정리 후 분해 결과 반환.
adminRouter.post('/idrac/power-purge', adminOnly, async (req, res) => {
  try {
    const mode = (req.body || {}).mode === 'all' ? 'all' : 'stale';
    const before = await measuredPowerBreakdown().catch(() => null);
    const r = await purgeStalePower({ mode });
    const after = await measuredPowerBreakdown().catch(() => null);
    logAudit({ user: req.user?.username, action: `전력 데이터 정리(${mode === 'all' ? '강제 전체' : '고아 삭제'})`, target: `DB ${r.dbRemoved} · OME ${r.omeCleared} · 원격 ${r.remoteCleared} · ${before?.total ?? '?'}→${after?.total ?? '?'}대` });
    res.json({ ok: true, ...r, beforeTotal: before?.total ?? null, afterTotal: after?.total ?? null, breakdown: after });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 하드웨어 집계 — 모든 데이터센터(법인)의 iDRAC 수집 인벤토리를 모델/CPU/메모리/GPU 종류별로
// 집계한다. ?datacenterId= 로 특정 법인만. 서버의 법인은 datacenterId(스캔 등록) 또는
// vCenter→DataCenter 할당으로 해석. 응답: { totalServers, collected, missing, byModel/byCpu/byMemory/byGpu }.
adminRouter.get('/idrac/hardware-summary', adminOnly, (req, res) => {
  const dcFilter = String(req.query.datacenterId || '').trim();
  const assign = getDatacenterAssign();
  const dcOf = (s) => String(s.datacenterId || assign[String(s.vcenterId || '')] || '');
  // 중앙 로컬 + 위임 법인 원격 서버 병합(id 중복은 중앙 우선).
  const localAll = loadIdracRegistry().filter((s) => s.type !== 'ome');
  const seen = new Set(localAll.map((s) => String(s.id)));
  const merged = localAll.concat(remoteServersResolved().filter((s) => !seen.has(String(s.id))));
  const servers = merged.filter((s) => (!dcFilter || dcOf(s) === (dcFilter === '__unmapped__' ? '' : dcFilter)) && (dcFilter !== '__unmapped__' || !dcOf(s)));
  const byModel = new Map(), byCpu = new Map(), byMem = new Map(), byGpu = new Map();
  let collected = 0, missing = 0, totalGpuCards = 0;
  const bump = (map, key, by = 1) => { const k = String(key || '').trim(); if (!k) return; map.set(k, (map.get(k) || 0) + by); };
  for (const s of servers) {
    const inv = invForServer(s);
    if (!inv || !inv.collectedAt) { missing++; continue; }
    collected++;
    bump(byModel, inv.system?.model || '미상');
    const cpu = inv.cpu || {};
    const cpuLabel = (cpu.model || '미상') + (cpu.count ? ` ×${cpu.count}` : '');
    bump(byCpu, cpuLabel);
    const gib = inv.memory?.totalGiB;
    if (gib != null && Number.isFinite(Number(gib))) bump(byMem, `${Math.round(Number(gib))} GiB`);
    for (const g of (inv.gpus || [])) { const m = (g.model || g.name || '').trim(); if (m) { bump(byGpu, m); totalGpuCards++; } }
  }
  const toArr = (map, numericKey = false) => [...map.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => (numericKey ? (parseInt(b.key) - parseInt(a.key)) : 0) || b.count - a.count || String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
  res.json({
    ok: true, datacenterId: dcFilter, totalServers: servers.length, collected, missing, totalGpuCards,
    byModel: toArr(byModel), byCpu: toArr(byCpu), byMemory: toArr(byMem, true), byGpu: toArr(byGpu),
  });
});

// 서버 NIC(물리 네트워크 어댑터) 속도별 구분 — iDRAC Redfish 인벤토리(inv.nics[].ports[].speedMbps,
// 미링크여도 지원속도 fallback)로 10G/25G/100G 등 최고 속도별 서버를 분류한다. DataCenter(법인)·
// 가상화(ESXi 호스트)/베어메탈로 필터. 추가 수집 없이 이미 수집된 인벤토리만 집계.
adminRouter.get('/idrac/nic-speed', adminOnly, (req, res) => {
  const dcFilter = String(req.query.datacenterId || '').trim();
  const typeFilter = String(req.query.type || '').trim(); // '' | 'virtual' | 'baremetal'
  const assign = getDatacenterAssign();
  const tagMap = hostVcByTag();
  const dcNameById = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id]));
  const dcOf = (s) => String(s.datacenterId || assign[String(s.vcenterId || s.mappedVcenterId || '')] || '');
  const speedLabel = (mbps) => {
    if (!mbps) return '';
    if (mbps % 1000 === 0) return `${mbps / 1000}G`;
    if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)}G`;
    return `${mbps}M`;
  };
  const localAll = loadIdracRegistry().filter((s) => s.type !== 'ome').map((s) => withMappedVc(s, tagMap));
  const seen = new Set(localAll.map((s) => String(s.id)));
  const merged = localAll.concat(remoteServersResolved().map((s) => withMappedVc(s, tagMap)).filter((s) => !seen.has(String(s.id))));
  const vcNicMap = hostNicsByTag(); // vCenter 수집 물리 NIC(별도 컬럼) — iDRAC과 독립 소스

  const rows = []; let collected = 0; let missing = 0; let vcCollected = 0;
  for (const s of merged) {
    // 가상화(ESXi 호스트)=서비스태그가 vCenter 호스트와 일치(mappedVcenterId) 또는 명시 vcenterId. 아니면 베어메탈.
    const type = (s.mappedVcenterId || s.vcenterId) ? 'virtual' : 'baremetal';
    const dcId = dcOf(s);
    if (dcFilter) { if (dcFilter === '__unmapped__') { if (dcId) continue; } else if (dcId !== dcFilter) continue; }
    if (typeFilter && type !== typeFilter) continue;
    const inv = invForServer(s);
    if (!inv || !inv.collectedAt) { missing++; continue; }
    collected++;
    const speeds = new Set(); const models = new Set(); let ports = 0;
    for (const n of (inv.nics || [])) {
      if (n.model) models.add(String(n.model).trim());
      for (const p of (n.ports || [])) { const mb = Number(p.speedMbps); if (Number.isFinite(mb) && mb > 0) { speeds.add(mb); ports++; } }
    }
    const maxMbps = speeds.size ? Math.max(...speeds) : 0;
    // vCenter 관점 NIC 속도(별도 컬럼) — 서비스태그로 ESXi 호스트 pnic과 매칭.
    const tag = String(inv.system?.serviceTag || s.serviceTag || '').trim().toLowerCase();
    const vcNics = (tag && vcNicMap.get(tag)) || [];
    const vcSpeeds = new Set(); let vcPorts = 0;
    for (const n of vcNics) { vcPorts++; const mb = Number(n.maxSpeedMb || n.speedMb); if (Number.isFinite(mb) && mb > 0) vcSpeeds.add(mb); }
    const vcMaxMbps = vcSpeeds.size ? Math.max(...vcSpeeds) : 0;
    if (vcNics.length) vcCollected++;
    rows.push({
      id: s.id, name: s.name || inv.system?.hostName || s.id,
      serviceTag: inv.system?.serviceTag || s.serviceTag || '',
      model: inv.system?.model || '',
      datacenterId: dcId, datacenter: dcNameById.get(dcId) || dcId || '(미매핑)',
      type, // 'virtual' | 'baremetal'
      nicPorts: ports, nicModels: [...models],
      speeds: [...speeds].sort((a, b) => b - a).map(speedLabel),
      maxSpeedMbps: maxMbps, maxSpeed: speedLabel(maxMbps) || '정보없음',
      vcPorts, vcSpeeds: [...vcSpeeds].sort((a, b) => b - a).map(speedLabel),
      vcMaxSpeedMbps: vcMaxMbps, vcMaxSpeed: speedLabel(vcMaxMbps) || '',
    });
  }
  // 서버는 '최고 속도'로 1회 분류(가장 빠른 NIC 기준).
  const bySpeed = new Map();
  for (const r of rows) { const e = bySpeed.get(r.maxSpeed) || { count: 0, mbps: r.maxSpeedMbps }; e.count++; bySpeed.set(r.maxSpeed, e); }
  const speedBuckets = [...bySpeed.entries()].map(([speed, e]) => ({ speed, count: e.count, mbps: e.mbps }))
    .sort((a, b) => b.mbps - a.mbps || b.count - a.count);
  const virtualN = rows.filter((r) => r.type === 'virtual').length;
  res.json({
    ok: true, datacenterId: dcFilter, type: typeFilter,
    totalServers: rows.length, collected, missing, vcCollected, virtual: virtualN, baremetal: rows.length - virtualN,
    bySpeed: speedBuckets, servers: rows,
    datacenters: listDatacenters().map((d) => ({ id: d.id, name: d.name || d.id })),
  });
});

// 서버 NIC 종류·모델 확인 — iDRAC 인벤토리(inv.nics[].model)로 설치된 NIC 어댑터 모델별 분류.
// DataCenter(법인)·가상화(ESXi)/베어메탈 필터. 모델별 서버/포트 수 + 서버별 어댑터 상세.
adminRouter.get('/idrac/nic-models', adminOnly, (req, res) => {
  const dcFilter = String(req.query.datacenterId || '').trim();
  const typeFilter = String(req.query.type || '').trim();
  const assign = getDatacenterAssign();
  const tagMap = hostVcByTag();
  const dcNameById = new Map(listDatacenters().map((d) => [String(d.id), d.name || d.id]));
  const dcOf = (s) => String(s.datacenterId || assign[String(s.vcenterId || s.mappedVcenterId || '')] || '');
  const speedLabel = (mbps) => { if (!mbps) return ''; if (mbps % 1000 === 0) return `${mbps / 1000}G`; if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)}G`; return `${mbps}M`; };
  const localAll = loadIdracRegistry().filter((s) => s.type !== 'ome').map((s) => withMappedVc(s, tagMap));
  const seen = new Set(localAll.map((s) => String(s.id)));
  const merged = localAll.concat(remoteServersResolved().map((s) => withMappedVc(s, tagMap)).filter((s) => !seen.has(String(s.id))));

  const vcNicMap = hostNicsByTag(); // vCenter 수집 물리 NIC(별도 컬럼) — iDRAC과 독립 소스
  const byModel = new Map(); // model -> { servers:Set, ports }
  const vcByModel = new Map(); // vCenter 기준 model -> { servers:Set, ports }
  const rows = []; let collected = 0; let missing = 0; let vcCollected = 0;
  for (const s of merged) {
    const type = (s.mappedVcenterId || s.vcenterId) ? 'virtual' : 'baremetal';
    const dcId = dcOf(s);
    if (dcFilter) { if (dcFilter === '__unmapped__') { if (dcId) continue; } else if (dcId !== dcFilter) continue; }
    if (typeFilter && type !== typeFilter) continue;
    const inv = invForServer(s);
    if (!inv || !inv.collectedAt) { missing++; continue; }
    collected++;
    const adapters = [];
    for (const n of (inv.nics || [])) {
      const model = String(n.model || n.name || '').trim() || '(모델 미상)';
      if (String(n.model || '').trim() === '(EthernetInterfaces)') continue; // 폴백 합성 어댑터는 모델 집계서 제외
      const speeds = new Set(); let ports = 0;
      for (const p of (n.ports || [])) { const mb = Number(p.speedMbps); if (Number.isFinite(mb) && mb > 0) { speeds.add(mb); } ports++; }
      const maxMbps = speeds.size ? Math.max(...speeds) : 0;
      adapters.push({ model, name: n.name || '', ports, speeds: [...speeds].sort((a, b) => b - a).map(speedLabel), maxSpeed: speedLabel(maxMbps) || '—' });
      const e = byModel.get(model) || { servers: new Set(), ports: 0 };
      e.servers.add(s.id); e.ports += ports; byModel.set(model, e);
    }
    // vCenter 관점 NIC(별도 컬럼) — pnic(장치/드라이버/속도) + pciDevice(모델명) 매칭 결과를
    // 모델별로 묶어 iDRAC 어댑터와 나란히 보여준다(교차 검증·iDRAC 인벤토리 공백 보완).
    const tag = String(inv.system?.serviceTag || s.serviceTag || '').trim().toLowerCase();
    const vcNics = (tag && vcNicMap.get(tag)) || [];
    const vcGroup = new Map();
    for (const n of vcNics) {
      const model = String(n.model || '').trim() || (n.driver ? `(드라이버 ${n.driver})` : '(모델 미상)');
      const e = vcGroup.get(model) || { ports: 0, speeds: new Set() };
      e.ports++; const mb = Number(n.maxSpeedMb || n.speedMb); if (Number.isFinite(mb) && mb > 0) e.speeds.add(mb);
      vcGroup.set(model, e);
    }
    const vcAdapters = [...vcGroup.entries()].map(([model, e]) => {
      const arr = [...e.speeds].sort((a, b) => b - a);
      const g = vcByModel.get(model) || { servers: new Set(), ports: 0 };
      g.servers.add(s.id); g.ports += e.ports; vcByModel.set(model, g);
      return { model, ports: e.ports, speeds: arr.map(speedLabel), maxSpeed: speedLabel(arr[0] || 0) || '—' };
    });
    if (vcAdapters.length) vcCollected++;
    rows.push({
      id: s.id, name: s.name || inv.system?.hostName || s.id,
      serviceTag: inv.system?.serviceTag || s.serviceTag || '',
      model: inv.system?.model || '',
      datacenterId: dcId, datacenter: dcNameById.get(dcId) || dcId || '(미매핑)',
      type, adapters, nicModels: [...new Set(adapters.map((a) => a.model))],
      vcAdapters, vcModels: vcAdapters.map((a) => a.model),
    });
  }
  const toBuckets = (map) => [...map.entries()].map(([model, e]) => ({ model, servers: e.servers.size, ports: e.ports }))
    .sort((a, b) => b.servers - a.servers || String(a.model).localeCompare(b.model));
  const virtualN = rows.filter((r) => r.type === 'virtual').length;
  res.json({
    ok: true, datacenterId: dcFilter, type: typeFilter,
    totalServers: rows.length, collected, missing, vcCollected, virtual: virtualN, baremetal: rows.length - virtualN,
    byModel: toBuckets(byModel), vcByModel: toBuckets(vcByModel), servers: rows,
    datacenters: listDatacenters().map((d) => ({ id: d.id, name: d.name || d.id })),
  });
});

// 하드웨어 집계 드릴다운 — 특정 dim(model|cpu|memory|gpu) + key에 해당하는 서버 목록.
// 하드웨어 집계 화면에서 항목(예: PowerEdge R750)을 클릭하면 그 서버만 보여주는 데 쓴다.
adminRouter.get('/idrac/hardware-servers', adminOnly, (req, res) => {
  const dcFilter = String(req.query.datacenterId || '').trim();
  const dim = String(req.query.dim || '').trim();
  const key = String(req.query.key || '').trim();
  if (!['model', 'cpu', 'memory', 'gpu'].includes(dim) || !key) return res.status(400).json({ ok: false, reason: 'dim(model|cpu|memory|gpu)·key가 필요합니다.' });
  const assign = getDatacenterAssign();
  const dcOf = (s) => String(s.datacenterId || assign[String(s.vcenterId || '')] || '');
  const localAll = loadIdracRegistry().filter((s) => s.type !== 'ome');
  const seen = new Set(localAll.map((s) => String(s.id)));
  const merged = localAll.concat(remoteServersResolved().filter((s) => !seen.has(String(s.id))));
  const inDc = merged.filter((s) => (!dcFilter || dcOf(s) === (dcFilter === '__unmapped__' ? '' : dcFilter)) && (dcFilter !== '__unmapped__' || !dcOf(s)));
  const out = [];
  for (const s of inDc) {
    const inv = invForServer(s);
    if (!inv || !inv.collectedAt) continue;
    const { match, gpuCount } = hardwareDimMatch(inv, dim, key);
    if (!match) continue;
    out.push({
      id: s.id, name: s.name, host: String(s.host || '').replace(/^https?:\/\//, ''),
      serviceTag: s.serviceTag || inv.system?.serviceTag || '',
      model: inv.system?.model || '', vcenterId: s.vcenterId || '', datacenterId: dcOf(s), remote: !!s.remote,
      ...(dim === 'gpu' ? { gpuCount } : {}),
    });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  res.json({ ok: true, dim, key, datacenterId: dcFilter, count: out.length, servers: out });
});

// 서버 분석 — 전체 iDRAC 서버의 최신 온도센서(CPU/GPU/Inlet/Exhaust 등) 평탄화(정렬용).
adminRouter.get('/idrac/temps', adminOnly, (req, res) => {
  // 원격(위임 법인 엣지 등록) 서버 포함 — 엣지가 export에 실어 보낸 최신 센서(s.sensors)를 쓴다.
  // 이전엔 중앙 로컬 등록 서버만 집계해, 전부 위임인 환경에서 '법인별 온도'가 0/0으로 비었다.
  const servers = analysisServersWithRemote(req);
  const rows = [];
  const serverList = [];
  let missing = 0;
  for (const s of servers) {
    const latest = s.remote ? s.sensors : getSensorSeries(s.id).latest;
    const temps = latest?.temps || {};
    if (!Object.keys(temps).length) { missing++; continue; }
    const list = Object.entries(temps).map(([name, celsius]) => ({ name, celsius }));
    const serviceTag = s.serviceTag || getIdracInventory(s.id)?.system?.serviceTag || '';
    serverList.push({ id: s.id, name: s.name, serviceTag, vcenterId: s.vcenterId || '', at: latest.t, maxC: Math.max(...list.map((x) => x.celsius)), temps: list });
    for (const { name, celsius } of list) {
      rows.push({ server: s.name, serverId: s.id, serviceTag, vcenterId: s.vcenterId || '', sensor: name, celsius, at: latest.t });
    }
  }
  rows.sort((a, b) => b.celsius - a.celsius);
  res.json({ rows, servers: serverList, sampledServers: serverList.length, totalServers: servers.length, missing, maxCelsius: rows.length ? rows[0].celsius : null });
});

// 서버 분석 — 서버 모델(R760/R770 등)별로 펌웨어/드라이버 버전 분포(버전별 설치 서버 수).
adminRouter.get('/idrac/firmware-inventory', adminOnly, (req, res) => {
  const CAT_ORDER = ['iDRAC', 'BIOS', 'NIC', 'HBA', 'Storage', 'GPU', 'PSU', 'CPLD', 'Disk', 'Driver', '기타'];
  const servers = analysisServersWithRemote(req);
  const models = new Map(); // model -> { servers:Set, cats: Map<cat, Map<version, Set<serverName>>> }
  const missing = [];
  for (const s of servers) {
    const inv = invForServer(s);
    if (!inv) { missing.push({ id: s.id, name: s.name }); continue; }
    const model = (inv.system?.model || '미상').trim() || '미상';
    let m = models.get(model);
    if (!m) { m = { model, servers: new Set(), cats: new Map() }; models.set(model, m); }
    const sname = s.name || s.id;
    m.servers.add(sname);
    const add = (cat, version) => {
      if (!version) return;
      let c = m.cats.get(cat); if (!c) { c = new Map(); m.cats.set(cat, c); }
      let v = c.get(version); if (!v) { v = new Set(); c.set(version, v); }
      v.add(sname);
    };
    add('iDRAC', inv.idrac?.firmwareVersion);
    add('BIOS', inv.bios?.version || inv.system?.biosVersion);
    for (const f of (inv.firmware || [])) add(f.type || '기타', f.version);
  }
  const out = [...models.values()].map((m) => ({
    model: m.model,
    serverCount: m.servers.size,
    categories: [...m.cats.entries()].map(([category, vmap]) => ({
      category,
      versions: [...vmap.entries()].map(([version, set]) => ({ version, count: set.size, servers: [...set].sort() })).sort((a, b) => b.count - a.count),
    })).sort((a, b) => (CAT_ORDER.indexOf(a.category) + 1 || 99) - (CAT_ORDER.indexOf(b.category) + 1 || 99)),
  })).sort((a, b) => b.serverCount - a.serverCount);
  res.json({ models: out, missing, totalServers: servers.length, collectedServers: servers.length - missing.length });
});

// 서버 분석 — 모든 iDRAC가 수집한 GPU를 모델별로 집계(어떤 모델 몇 장, 어느 서버).
adminRouter.get('/idrac/gpu-inventory', adminOnly, (req, res) => {
  const servers = analysisServersWithRemote(req);
  const byModel = new Map();
  const serverList = [];
  const missing = [];
  let collected = 0;
  for (const s of servers) {
    const inv = invForServer(s);
    if (!inv) { missing.push({ id: s.id, name: s.name }); continue; }
    collected++;
    const gpus = inv.gpus || [];
    const serviceTag = s.serviceTag || inv.system?.serviceTag || '';
    serverList.push({ id: s.id, name: s.name, serviceTag, vcenterId: s.vcenterId || '', host: (s.host || '').replace(/^https?:\/\//, ''), gpuCount: gpus.length, gpus });
    for (const g of gpus) {
      const model = (g.model || '미상').trim() || '미상';
      const e = byModel.get(model) || { model, count: 0, servers: new Map() };
      e.count++;
      const sv = e.servers.get(s.id) || { id: s.id, name: s.name, serviceTag, vcenterId: s.vcenterId || '', count: 0 };
      sv.count++; e.servers.set(s.id, sv);
      byModel.set(model, e);
    }
  }
  // 추천: 물리(베어메탈) GPU 서버도 같은 모델 집계에 합친다(source='physical').
  const vcFilter = String(req.query.vcenterId || '').trim();
  let physServers = listPhysical();
  if (vcFilter) physServers = physServers.filter((s) => (vcFilter === '__unmapped__' ? !s.vcenterId : s.vcenterId === vcFilter));
  let physCount = 0;
  for (const s of physServers) {
    const gms = s.gpuModels || [];
    if (!gms.length) continue;
    physCount++;
    serverList.push({ id: s.id, name: s.name, serviceTag: '', vcenterId: s.vcenterId || '', host: s.host, gpuCount: gms.length, source: 'physical', gpus: gms.map((m) => ({ model: m })) });
    for (const gm of gms) {
      const model = (gm || '미상').trim() || '미상';
      const e = byModel.get(model) || { model, count: 0, servers: new Map() };
      e.count++;
      const key = `phys:${s.id}`;
      const sv = e.servers.get(key) || { id: s.id, name: s.name, serviceTag: '', vcenterId: s.vcenterId || '', source: 'physical', count: 0 };
      sv.count++; e.servers.set(key, sv);
      byModel.set(model, e);
    }
  }
  const models = [...byModel.values()]
    .map((e) => ({ model: e.model, count: e.count, serverCount: e.servers.size, servers: [...e.servers.values()].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
  res.json({
    totalGpus: models.reduce((a, b) => a + b.count, 0),
    models,
    servers: serverList.sort((a, b) => b.gpuCount - a.gpuCount),
    collectedServers: collected, totalServers: servers.length,
    physicalServers: physCount,
    missing,
  });
});

// 서버 분석 — 하드웨어 파트 인벤토리 집계: 어떤 장비(모델)가 몇 개, 몇 대의 서버에 있는지.
// 카테고리: cpu/gpu/dimm/disk/controller/nic/psu/pcie/fan (idrac/partsInventory.js).
// 1,069대 × 서버당 수십~수백 유닛 순회라 admin 폴링 하에서도 재계산이 겹치지 않게
// single-flight + 15s TTL(snapMemo)로 묶는다(admin 전용이라 scope 캐시 누수 없음).
adminRouter.get('/idrac/parts-inventory', adminOnly, async (req, res) => {
  try {
    const cat = String(req.query.cat || '').trim();
    if (cat && !isPartCat(cat)) return res.status(400).json({ ok: false, reason: `알 수 없는 카테고리: ${cat}` });
    const key = `parts|${req.originalUrl}`;
    const payload = await snapMemo('idrac-parts', key, 15_000, () => {
      const servers = analysisServersWithRemote(req);
      return partBuckets(servers, invForServer, { cat, q: String(req.query.q || '') });
    });
    // ETag/304 는 전역 res.json 래퍼(util/compress.js, 본문 SHA-1)가 처리 — 여기서 키 기반
    // ETag 를 따로 만들면 재계산 후 내용이 바뀌어도 304 가 나가는 오탐이 생긴다.
    res.json(payload);
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 파트 드릴다운 — key(`cat|라벨`)의 파트를 가진 서버 목록(서버당 수량). 집계와 분리해
// 버킷×서버 목록이 응답을 MB 단위로 키우는 것을 막는다(gpu-inventory 와 달리 버킷 수가 많음).
adminRouter.get('/idrac/parts-servers', adminOnly, (req, res) => {
  try {
    const servers = analysisServersWithRemote(req);
    const list = serversWithPart(servers, invForServer, String(req.query.key || ''));
    if (list == null) return res.status(400).json({ ok: false, reason: 'key 형식은 <카테고리>|<라벨> 입니다.' });
    // 호스트네임 폴백 — iDRAC 인벤토리에 아직 없으면(30분 주기·구버전 엣지) vCenter 스냅샷의
    // ESXi 호스트명을 서비스태그로 매칭해 즉시 표시.
    const tagName = hostNameByTag();
    for (const r of list) {
      if (!r.hostname) r.hostname = tagName.get(String(r.serviceTag || '').trim().toLowerCase()) || '';
    }
    res.json({ servers: list, total: list.length });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
}
