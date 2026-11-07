/**
 * search/inventoryIndex.js — 헤더 ⌘K '통합 장비 검색' 의 색인(v2.909).
 *
 * 설계: docs/design/inventory-search/README.md §4.1. 이미 모은 값만 읽는다 — 수집 · 장비 왕복 0.
 *
 *  - **행 하나 = 장비 하나**. 종류 11: vm · host · server(iDRAC · OME · 엣지 베어메탈) · gpu(물리 GPU 서버) · storage · sanswitch ·
 *    netswitch(Arista CVP) · pdu · datastore · vcenter · ip(IP 대장).
 *  - 색인은 **관리자 판본 하나**를 공유한다(사용자마다 만들지 않는다 — 시리얼 색인 L-2 와 같은 이유). 범위 · 권한 · 주소 가림은
 *    응답 때 search/inventoryAccess.js 가 건다. 그래서 행에는 범위 판정에 필요한 `vcenterId` 와 종류만 있으면 된다.
 *  - **출처별 try** — 한 출처가 죽어도 나머지는 찾는다(insights/serialLookup.js 와 같은 규칙). 실패는 `sources[kind].error` 로 밝힌다
 *    (못 읽은 것을 빈 결과로 위장하지 않는다). 등록부를 못 읽었으면 'registryUnreadable'.
 *  - 캐시 1개 · TTL 30초 · 같은 시각의 요청은 진행 중인 생성 하나를 공유 · 강제 재생성은 10초 스로틀. **요청이 있을 때만** 만든다(폴링 없음).
 *  - 행의 상태는 **색인 시점의 스냅샷 값**이다(응답의 builtAt 이 그 시각) — '실시간' 이 아니다.
 *
 * 행 모양(내부): { kind, id, name, alt, ips[], addr, serials[], model, sub, status, statusText, vcenterId, corp, agent,
 *   _n, _a, _ip[], _addr, _sn[], _m }  — `_` 로 시작하는 칸은 검색 키(소문자 · 정규화)이고 응답에 싣지 않는다.
 */
import { store } from '../store.js';
import { numOrNull } from '../util/numOrNull.js';
import { hostLedgerIp, buildIpamRowsShared } from '../ipam/ledger.js';
import { analysisServersWithRemote, invForServer, hostVcByTag } from '../insights/analysisServers.js';
import { idracServerVcOf, idracCorpIndex } from '../idrac/corpAttribution.js'; // 서버 분석 범위 절단과 같은 귀속 판정 한 벌(반증 L-1)
import { allOmeDevices, dbKey as omeDbKey } from '../idrac/omeCache.js';
import { registryLoadError as idracRegistryError } from '../idrac/registry.js';
import { getEdgeFleetServers } from '../central/fleet.js';
import { listPhysical } from '../gpu/physicalRegistry.js';
import { listDevices as listStorage, registryLoadError as storageRegistryError } from '../storage/registry.js';
import { localSnapshots as storageLocal } from '../storage/store.js';
import { edgeStorageSnapshots } from '../central/storageEdge.js';
import { latestMapByDevice } from '../storage/latestSnapshots.js';
import { listDevices as listSwitches, registryLoadError as switchRegistryError } from '../sanswitch/registry.js';
import { localSnapshots as switchLocal } from '../sanswitch/store.js';
import { edgeSanSwitchSnapshots } from '../central/sanSwitchEdge.js';
import { listServers as listCvpServers, registryLoadError as cvpRegistryError } from '../cvp/registry.js';
import { listDeviceRows as listCvpDeviceRows } from '../cvp/db.js';
import { rowOwnerOf, corpResolver } from '../cvp/overview.js';
import { listDevices as listPdus, registryLoadError as pduRegistryError } from '../pdu/registry.js';
import { localSnapshots as pduLocal } from '../pdu/poller.js';
import { edgePduSnapshots } from '../central/pduEdge.js';
import { listDatacenters } from '../datacenter/store.js';
import { KIND_KEYS, normSerial } from './inventoryQuery.js';
import { vmRefOf, vmTagsOf } from '../tags/analyze.js'; // v2.927 B3: VM 태그 · 사용자 지정 속성(스냅샷 vc.tagInv — vCenter 왕복 0)
import { createYielder } from '../util/timeSlice.js';

export const INDEX_TTL_MS = 30_000;    // 시리얼 색인과 같은 수명(env 로 열지 않는다 — TIM2605-04)
export const REFRESH_MIN_MS = 10_000;
const IPS_MAX = 8;          // 행당 IP 상한(멀티홈 VM)
const STR_MAX = 200;        // 표시 문자열 상한(엣지가 보낸 값 포함 — 응답 크기 방어)

const str = (v) => (v == null ? '' : String(v)).slice(0, STR_MAX);
const low = (v) => str(v).toLowerCase();
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const BAD_SERIAL = new Set(['', '-', 'n/a', 'na', 'unknown', 'none', 'null']);
const serialOk = (s) => !BAD_SERIAL.has(String(s ?? '').trim().toLowerCase());

/**
 * 관리 주소 → 호스트 부분만('https://10.0.0.5:443/redfish' → '10.0.0.5'). iDRAC · Horizon 류 등록부는 URL 로 저장한다 —
 * 그대로 두면 `ip:10.0` 이 걸리지 않는다. 정규식 없이 선형으로 자른다(외부 입력 — 앵커 없는 반복 금지 규약).
 */
export function bareAddr(v) {
  let h = str(v).trim();
  const sch = h.indexOf('://');
  if (sch > 0 && sch < 16) h = h.slice(sch + 3);
  const slash = h.indexOf('/');
  if (slash >= 0) h = h.slice(0, slash);
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(1, end) : h; } // [IPv6]:port
  const c = h.indexOf(':');
  if (c >= 0 && c === h.lastIndexOf(':')) h = h.slice(0, c); // host:port (콜론 하나) — IPv6 원문은 그대로
  return h;
}

/** 행 하나 — 검색 키를 여기서 한 번 만든다(요청마다 소문자화하지 않는다). */
export function mkRow(kind, f) {
  const ips = uniq((f.ips || []).map((x) => str(x).trim())).slice(0, IPS_MAX);
  const serials = uniq((f.serials || []).filter(serialOk).map((x) => str(x).trim()));
  const row = {
    kind, id: str(f.id), name: str(f.name) || str(f.id), alt: str(f.alt), ips, addr: bareAddr(f.addr),
    serials, model: str(f.model), sub: str(f.sub), status: f.status || '', statusText: str(f.statusText),
    vcenterId: str(f.vcenterId), corp: str(f.corp), agent: str(f.agent),
    ...(f.host ? { host: str(f.host) } : {}), ...(f.ownerType ? { ownerType: str(f.ownerType) } : {}),
  };
  row._n = row.name.toLowerCase();
  row._a = row.alt.toLowerCase();
  row._ip = ips.map((x) => x.toLowerCase());
  row._addr = row.addr.toLowerCase();
  row._sn = uniq(serials.map(normSerial));
  row._m = `${row.model} ${row.sub}`.trim().toLowerCase();
  // 반증 M-1: 이름 · 보조 이름 · 모델 칸에 이 행의 주소가 들어 있는가 — 주소를 가리는 판본에서는 그 칸으로 찾지 않는다
  //   (SAN 등록 이름이 비면 스냅샷 이름이 관리 IP 로 떨어진다 — sanswitch/types.js). 판정은 inventoryQuery.matchTier.
  const addrs = [row._addr, ...row._ip].filter(Boolean);
  row._nAddr = addrs.some((a) => row._n.includes(a));
  row._aAddr = addrs.some((a) => row._a.includes(a));
  row._mAddr = addrs.some((a) => row._m.includes(a));
  // v2.927(B3): VM 메모 · 태그 — 응답에는 싣지 않고 찾는 칸으로만 쓴다(메모는 길 수 있다). 태그는 그 도구 권한이 있는 계정만 찾는다(inventoryAccess.tagsSearchable).
  if (f.notes) row._notes = String(f.notes).slice(0, NOTES_MAX).toLowerCase();
  if (Array.isArray(f.tags) && f.tags.length) { row.tags = f.tags.slice(0, TAGS_MAX).map((t) => str(t)); row._tags = row.tags.join('\n').toLowerCase(); }
  return row;
}

const NOTES_MAX = 300;  // 메모는 앞 300자만 찾는다(vCenter annotation 은 2000자까지 — 색인 메모리 · 요청당 비용 상한)
const TAGS_MAX = 24;    // VM 하나의 태그 · 속성 문자열 상한

/** VM 하나의 태그 · 속성 → 찾는 문자열('범주:태그' · '태그' · '속성=값'). 스냅샷 vm.tags(문자열 배열)도 함께. 못 읽었으면 빈 배열. */
export function vmTagStrings(vm, inv) {
  const out = [];
  for (const t of Array.isArray(vm?.tags) ? vm.tags : []) if (typeof t === 'string' && t) out.push(t);
  try {
    const ref = vmRefOf(vm?.vcenterId, vm?.id);
    if (inv && ref) {
      const { tags, custom } = vmTagsOf(inv, ref);
      for (const t of tags || []) out.push(t.category ? `${t.category}:${t.tag}` : t.tag);
      for (const c of custom || []) if (c && c.value != null && c.value !== '') out.push(`${c.name}=${c.value}`);
    }
  } catch { /* 태그를 못 읽으면 태그 없이 */ }
  return uniq(out.map((x) => String(x).slice(0, 120)));
}

function vmStatus(ps) {
  const p = low(ps).replace(/[_\s-]/g, '');
  if (p === 'poweredon') return ['ok', '켜짐'];
  if (p === 'poweredoff') return ['off', '꺼짐'];
  if (p === 'suspended') return ['warn', '일시 중지'];
  return ['', ''];
}
function hostStatus(h) {
  const c = low(h.connectionState);
  if (c === 'maintenance' || h.inMaintenance === true || h.inMaintenanceMode === true) return ['warn', '유지보수'];
  if (c === 'connected') return ['ok', '연결됨'];
  if (c === 'disconnected' || c === 'notresponding') return ['down', c === 'disconnected' ? '연결 끊김' : '응답 없음'];
  return ['', ''];
}

/*
 * 출처 함수는 모두 async 이고 행 128개마다 `ctx.tick()` 으로 **시간 기준 양보**(util/timeSlice.js — 15ms)를 한다(반증 L-3 —
 * 목 14k 행 재생성이 32~107ms 동안 이벤트 루프를 잡았다 · perf-db '요청 경로 큰 집계는 조각 + 시간 기준 양보').
 * 실패하면 그때까지 넣은 행 수와 사유를 함께 적는다(부분 결과를 '0행' 으로 적지 않는다 — 반증 L-5).
 */
const errText = (e) => (typeof e === 'string' ? e : String(e?.message || e).slice(0, 200));

/** vCenter 스냅샷 4종(템플릿 VM 제외). */
async function fromSnapshot(snap, vcName, ctx) {
  const run = async (kind, list, make) => {
    let n = 0;
    try {
      for (const x of list || []) {
        if (!x) continue;
        const row = make(x);
        if (row) { ctx.out.push(row); n++; }
        await ctx.tick();
      }
      ctx.mark(kind, n);
    } catch (e) { ctx.mark(kind, n, e); }
  };
  const tagInvOf = new Map((snap.vcenters || []).map((vc) => [String(vc?.id), vc?.tagInv || null]));
  await run('vm', snap.vms, (v) => {
    if (v.template) return null;
    const [status, statusText] = vmStatus(v.powerState);
    const ips = Array.isArray(v.ipAddresses) && v.ipAddresses.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []);
    return mkRow('vm', { id: v.id, name: v.name, ips, sub: v.guestOS, status, statusText, vcenterId: v.vcenterId, corp: vcName(v.vcenterId), host: v.host,
      notes: v.notes, tags: vmTagStrings(v, tagInvOf.get(String(v.vcenterId))) });
  });
  await run('host', snap.hosts, (h) => {
    const [status, statusText] = hostStatus(h);
    const hip = (() => { try { return hostLedgerIp(h); } catch { return null; } })();
    return mkRow('host', { id: h.id, name: h.name, ips: hip ? [hip.ip] : [], serials: [h.serviceTag],
      model: [h.vendor, h.model].filter(Boolean).join(' '), sub: [h.version ? `ESXi ${h.version}` : '', h.cluster].filter(Boolean).join(' · '),
      status, statusText, vcenterId: h.vcenterId, corp: vcName(h.vcenterId) });
  });
  await run('datastore', snap.datastores, (d) => {
    const pct = numOrNull(d.usagePct);
    const down = d.accessible === false;
    return mkRow('datastore', { id: d.id, name: d.name, sub: [d.type, d.storageType].filter(Boolean).join(' · '),
      status: down ? 'down' : '', statusText: down ? '접근 불가' : (pct != null ? `사용 ${Math.round(pct)}%` : ''),
      vcenterId: d.vcenterId, corp: vcName(d.vcenterId), alt: d.remoteHost || '' });
  });
  await run('vcenter', snap.vcenters, (vc) => {
    const st = low(vc.status);
    const loc = vc.location && typeof vc.location === 'object' ? [vc.location.city, vc.location.country].filter(Boolean).join(', ') : '';
    return mkRow('vcenter', { id: vc.id, name: vc.name || vc.id, alt: loc, sub: vc.version ? `vCenter ${vc.version}` : '',
      status: st === 'connected' ? 'ok' : st ? 'down' : '', statusText: st === 'connected' ? '연결됨' : st === 'unreachable' ? '연결 불가' : '',
      vcenterId: vc.id, corp: vc.name || vc.id });
  });
}

/**
 * 물리 서버 — iDRAC(중앙 + 위임 엣지 원격 인벤토리) · OME · 엣지 베어메탈. 서비스 태그가 같은 것은 한 행(iDRAC 우선).
 * 귀속 vCenter 는 서버 분석 범위 절단과 **같은 판정**(idrac/corpAttribution.js idracServerVcOf — 명시 · 서비스태그 매핑 · 법인 귀속 색인).
 * 예전(초판)은 앞 두 단계만 본 '줄인 사본' 이라 범위 관리자가 서버 분석에서 보는 서버를 ⌘K 에서 못 찾았다(반증 L-1 · v2.630 R2630-01 과 같은 계열).
 */
async function fromServers(snap, dcName, vcName, ctx) {
  let n = 0; let err = null;
  const seenTag = new Set();
  try {
    if (idracRegistryError()) err = 'registryUnreadable';
    const tagMap = hostVcByTag();
    const index = (() => { try { return idracCorpIndex(snap); } catch { return null; } })(); // 못 만들면 앞 두 단계만(= 더 좁게)
    for (const s of analysisServersWithRemote(undefined)) {
      if (!s) continue;
      const inv = (() => { try { return invForServer(s); } catch { return null; } })();
      const sys = inv?.system || {};
      const tag = s.serviceTag || sys.serviceTag || '';
      if (tag) seenTag.add(normSerial(tag));
      const vc = str(idracServerVcOf(s, tagMap, index));
      const vendor = s.type === 'ilo' || /hpe/i.test(String(s.vendor || '')) ? 'iLO' : 'iDRAC';
      ctx.out.push(mkRow('server', { id: s.id, name: s.name || sys.hostName || s.host || s.id, alt: sys.hostName || '',
        addr: s.host, serials: [tag, sys.serialNumber, sys.assetTag], model: sys.model || s.model || '',
        sub: [sys.manufacturer, vendor, s.remote ? '엣지 수집' : ''].filter(Boolean).join(' · '),
        statusText: s.vcenterId || s.mappedVcenterId ? 'ESXi 호스트' : '베어메탈', vcenterId: vc, corp: dcName(s.datacenterId) || vcName(vc),
        agent: s.remote ? (s.collectorId || '') : '' }));
      n++;
      await ctx.tick();
    }
  } catch (e) { err = e; }
  try {
    for (const { entryId, device } of allOmeDevices()) {
      const tag = device?.serviceTag || '';
      if (tag && seenTag.has(normSerial(tag))) continue;
      if (tag) seenTag.add(normSerial(tag));
      ctx.out.push(mkRow('server', { id: `ome:${omeDbKey(entryId, device)}`, name: device?.name || tag, serials: [tag],
        model: device?.model || '', sub: 'OME 발견', statusText: '베어메탈' }));
      n++;
      await ctx.tick();
    }
  } catch (e) { err = err || e; }
  try {
    for (const e of getEdgeFleetServers() || []) {
      const tag = e?.serviceTag || '';
      if (tag && seenTag.has(normSerial(tag))) continue;
      if (tag) seenTag.add(normSerial(tag));
      // serverId 는 이미 'edge:<agent>:<…>' 이다(central/fleet.js) — 접두를 다시 붙이지 않는다(반증 L-5).
      ctx.out.push(mkRow('server', { id: e.serverId || `edge:${e.remoteAgent || ''}:${tag}`, name: e.serverName || tag, serials: [tag],
        model: e.model || '', sub: '엣지 베어메탈', statusText: e.vcenterId ? 'ESXi 호스트' : '베어메탈',
        vcenterId: e.vcenterId || '', corp: vcName(e.vcenterId), agent: e.remoteAgent || '' }));
      n++;
      await ctx.tick();
    }
  } catch (e) { err = err || e; }
  ctx.mark('server', n, err);
}

async function fromList(kind, ctx, load) {
  let n = 0;
  try {
    const { items, bad } = load();
    for (const make of items) { const row = make(); if (row) { ctx.out.push(row); n++; } await ctx.tick(); }
    ctx.mark(kind, n, bad || null);
  } catch (e) { ctx.mark(kind, n, e); }
}

const gpuSource = (vcName) => () => ({
  bad: null,
  items: listPhysical().map((s) => () => mkRow('gpu', { id: s.id, name: s.name || s.host, addr: s.host, model: (s.gpuModels || []).join(', '),
    sub: [s.os === 'windows' ? 'Windows' : 'Linux', s.enabled === false ? '수집 꺼짐' : ''].filter(Boolean).join(' · '),
    vcenterId: s.vcenterId, corp: vcName(s.vcenterId) })),
});

const storageSource = (dcName) => () => {
  const bad = storageRegistryError() ? 'registryUnreadable' : null;
  const byId = latestMapByDevice([storageLocal(), edgeStorageSnapshots()]);
  return {
    bad,
    items: listStorage().map((d) => () => {
      const s = byId.get(d.id) || null;
      const pct = numOrNull(s?.capacity?.pct);
      const status = !s ? '' : s.ok === false ? 'down' : 'ok';
      const statusText = !s ? '수집 전' : s.ok === false ? '수집 실패' : (pct != null ? `사용 ${Math.round(pct)}%` : '수집됨');
      return mkRow('storage', { id: d.id, name: d.name || s?.name || d.id, addr: d.host,
        serials: [s?.serial, ...((s?.extra?.appliances || []).map((a) => a?.serviceTag))],
        model: s?.extra?.model || '', sub: [d.type, s?.version].filter(Boolean).join(' '), status, statusText,
        corp: dcName(d.datacenterId), agent: d.agent || s?.agent || '' });
    }),
  };
};

const sanSource = (dcName) => () => {
  const bad = switchRegistryError() ? 'registryUnreadable' : null;
  const byId = latestMapByDevice([switchLocal(), edgeSanSwitchSnapshots()]);
  return {
    bad,
    items: listSwitches().map((d) => () => {
      const s = byId.get(d.id) || null;
      const state = str(s?.switchState || s?.extra?.switchState);
      const status = !s ? '' : s.ok === false ? 'down' : (state && !/online/i.test(state) ? 'warn' : 'ok');
      const statusText = !s ? '수집 전' : s.ok === false ? '수집 실패' : (state || '수집됨');
      return mkRow('sanswitch', { id: d.id, name: d.name || s?.name || d.id, alt: s?.name && s.name !== d.name ? s.name : '',
        addr: d.host || s?.host, serials: [s?.serial, s?.wwn], model: s?.model || '',
        sub: s?.fabricOs ? `FOS ${s.fabricOs}` : '', status, statusText,
        corp: dcName(d.datacenterId || s?.datacenterId), agent: d.agent || s?.agent || '' });
    }),
  };
};

const pduSource = (dcName) => () => {
  const bad = pduRegistryError() ? 'registryUnreadable' : null;
  const byId = new Map();
  for (const s of [...pduLocal(), ...edgePduSnapshots()]) {
    if (!s || s.id == null) continue;
    const prev = byId.get(s.id);
    if (!prev || (Number(s.collectedAt) || 0) > (Number(prev.collectedAt) || 0)) byId.set(s.id, s);
  }
  return {
    bad,
    items: listPdus().map((d) => () => {
      const s = byId.get(d.id) || null;
      return mkRow('pdu', { id: d.id, name: d.name || d.id, addr: d.host, serials: [s?.serial], model: s?.model || '',
        sub: 'APC Rack PDU', status: !s ? '' : s.ok === false ? 'down' : 'ok', statusText: !s ? '수집 전' : s.ok === false ? '수집 실패' : '수집됨',
        corp: dcName(d.datacenterId), agent: d.agent || s?.agent || '' });
    }),
  };
};

async function fromCvp(dcList, ctx) {
  let n = 0;
  try {
    const bad = cvpRegistryError();
    const servers = listCvpServers();
    const { rows, unavailable } = await listCvpDeviceRows();
    const own = rowOwnerOf(servers);
    const corpOf = corpResolver(servers, dcList);
    for (const d of rows) {
      if (!own(d)) continue;
      ctx.out.push(mkRow('netswitch', { id: `${d.cvpId}|${d.key}`, name: d.hostname || d.key, addr: d.mgmtIp, serials: [d.serial],
        model: d.model, sub: d.eosVersion ? `EOS ${d.eosVersion}` : '', corp: corpOf(d.cvpId).corpName || '', agent: d.agent || '' }));
      n++;
      await ctx.tick();
    }
    ctx.mark('netswitch', n, bad ? 'registryUnreadable' : unavailable ? 'dbUnavailable' : null);
  } catch (e) { ctx.mark('netswitch', n, e); }
}

const OWNER_LABEL = { vm: 'VM', host: 'VM호스트', scanned: '스캔 발견', manual: '수동 등록' };

/** IP 대장 원장(ipam/ledger.js) → 검색 행. 관리자 판본 색인과 범위 계정용(라우트 — 반증 L-2) 둘 다 이것 하나로 만든다. */
export async function ipRowsFromLedger(data, tick = async () => {}) {
  const out = [];
  for (const r of data?.rows || []) {
    if (!r || !r.ip) continue;
    out.push(mkRow('ip', { id: r.ip, name: r.ip, ips: [r.ip], alt: [r.ownerName !== r.ip ? r.ownerName : '', r.hostName && r.hostName !== r.ownerName ? r.hostName : ''].filter(Boolean).join(' · '),
      sub: OWNER_LABEL[r.ownerType] || str(r.ownerType), vcenterId: r.vcenterId || '', corp: r.vcenterName || '', ownerType: r.ownerType }));
    await tick();
  }
  return out;
}

/**
 * 범위 계정의 IP 행 — **IP관리 화면과 같은 범위 원장**(`buildIpamRowsShared(snap, '', allowed)` — 같은 세대 캐시 · 양보판)에서 만든다(반증 L-2:
 * 관리자 판본 원장은 범위 밖 VM · 스캔이 쓰는 IP 에 대해 자기 vCenter 로 예약한 수동 행을 만들지 않아, 범위 계정에게 IP관리에는 있는 행이 ⌘K 에서 빠졌다).
 * 같은 원장 객체(세대)는 한 번만 행으로 바꾼다(WeakMap — 키 입력마다 다시 만들지 않는다).
 */
const _scopedIpRows = new WeakMap();
export async function scopedIpRows(snap, allowed) {
  const data = await buildIpamRowsShared(snap, '', allowed, { shouldCache: () => store.get() === snap });
  if (!data || typeof data !== 'object') return [];
  const hit = _scopedIpRows.get(data);
  if (hit) return hit;
  const y = createYielder(15);
  let i = 0;
  const rows = await ipRowsFromLedger(data, async () => { if ((++i & 127) === 0) await y(); });
  _scopedIpRows.set(data, rows);
  return rows;
}

async function fromIpam(snap, ctx) {
  try {
    const data = await buildIpamRowsShared(snap, '', null, { shouldCache: () => store.get() === snap });
    const rows = await ipRowsFromLedger(data, ctx.tick);
    for (const r of rows) ctx.out.push(r);
    ctx.mark('ip', rows.length);
  } catch (e) { ctx.mark('ip', 0, e); }
}

/** 전 출처 → 행. 던지지 않는다(출처별로 실패를 기록한다). 행 128개마다 시간 기준 양보. */
export async function buildInventoryIndex() {
  const t0 = Date.now();
  const snap = store.get() || {};
  const sources = {};
  const y = createYielder(15);
  let i = 0;
  const ctx = {
    out: [],
    mark: (k, n, err) => { sources[k] = { rows: n, ...(err ? { error: errText(err) } : {}) }; },
    tick: async () => { if ((++i & 127) === 0) await y(); },
  };
  const vcNames = new Map((snap.vcenters || []).map((v) => [String(v?.id), String(v?.name || v?.id || '')]));
  const vcName = (id) => (id ? vcNames.get(String(id)) || '' : '');
  let dcList = [];
  try { dcList = listDatacenters(); } catch { dcList = []; }
  const dcNames = new Map(dcList.map((d) => [String(d.id), String(d.name || d.id)]));
  const dcName = (id) => (id ? dcNames.get(String(id)) || '' : '');

  // v2.927(D1): 출처별 소요(ms)를 함께 적는다 — 운영 규모(VM 5,850 · IP 1만+)에서 어느 출처가 무거운지 실측하려고(관리자 응답 · 느린 생성 로그).
  const steps = [
    ['snapshot', () => fromSnapshot(snap, vcName, ctx)],
    ['server', () => fromServers(snap, dcName, vcName, ctx)],
    ['gpu', () => fromList('gpu', ctx, gpuSource(vcName))],
    ['storage', () => fromList('storage', ctx, storageSource(dcName))],
    ['sanswitch', () => fromList('sanswitch', ctx, sanSource(dcName))],
    ['pdu', () => fromList('pdu', ctx, pduSource(dcName))],
    ['netswitch', () => fromCvp(dcList, ctx)],
    ['ip', () => fromIpam(snap, ctx)],
  ];
  const stepMs = {};
  for (const [name, run] of steps) { const s0 = Date.now(); await run(); stepMs[name] = Date.now() - s0; }
  for (const k of KIND_KEYS) if (!sources[k]) sources[k] = { rows: 0 };
  const built = { rows: ctx.out, sources, builtAt: Date.now(), buildMs: Date.now() - t0, yields: y.count(), stepMs, snapAt: snap.generatedAt || null };
  noteSlowBuild(built);
  return built;
}

/**
 * v2.927(D1): 느린 색인 생성은 콘솔에 남긴다(10분에 한 번 — 30초마다 다시 만들어도 로그를 덮지 않게). 기준 SLOW_BUILD_MS.
 * 벽시계 시간이고 양보(createYielder) 사이 다른 일이 끼어든 시간도 들어간다 — 그래서 양보 횟수를 함께 적는다.
 */
export const SLOW_BUILD_MS = 1500;
const SLOW_LOG_EVERY_MS = 10 * 60_000;
let _lastSlowLog = 0;
export function noteSlowBuild(b, now = Date.now(), log = console.warn) {
  if (!b || !(b.buildMs >= SLOW_BUILD_MS) || now - _lastSlowLog < SLOW_LOG_EVERY_MS) return false;
  _lastSlowLog = now;
  const steps = Object.entries(b.stepMs || {}).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v}ms`).join(' · ');
  try { log(`[inv-search] 장비 색인 생성 ${b.buildMs}ms · 행 ${b.rows?.length ?? 0} · 양보 ${b.yields ?? 0}회 — 출처: ${steps}`); } catch { /* 로그 실패 무시 */ }
  return true;
}
export function _resetSlowLogForTest() { _lastSlowLog = 0; }

let _cache = null;     // { at, rows, sources, builtAt, buildMs, yields, stepMs }
let _inflight = null;

/** 캐시된 색인. force 는 REFRESH_MIN_MS 로 스로틀(누구나 매 요청 재생성을 강제하지 못하게). */
export async function inventoryIndex({ force = false, now = Date.now() } = {}) {
  if (_cache && now - _cache.at < (force ? REFRESH_MIN_MS : INDEX_TTL_MS)) return _cache;
  if (!_inflight) {
    _inflight = buildInventoryIndex()
      .then((built) => { _cache = { at: Date.now(), ...built }; return _cache; })
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

export function _resetForTest() { _cache = null; _inflight = null; }
export function _setIndexForTest(rows, sources = {}) { _cache = { at: Date.now(), rows, sources, builtAt: Date.now(), buildMs: 0 }; }
