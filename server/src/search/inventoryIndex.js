/**
 * search/inventoryIndex.js — 헤더 ⌘K '통합 장비 검색' 의 색인(v2.908).
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
import { analysisServersWithRemote, invForServer } from '../insights/analysisServers.js';
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
  return row;
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

/** vCenter 스냅샷 4종(템플릿 VM 제외). */
function fromSnapshot(snap, vcName, out, mark) {
  try {
    let n = 0;
    for (const v of snap.vms || []) {
      if (!v || v.template) continue;
      const [status, statusText] = vmStatus(v.powerState);
      const ips = Array.isArray(v.ipAddresses) && v.ipAddresses.length ? v.ipAddresses : (v.ipAddress ? [v.ipAddress] : []);
      out.push(mkRow('vm', { id: v.id, name: v.name, ips, sub: v.guestOS, model: '', status, statusText,
        vcenterId: v.vcenterId, corp: vcName(v.vcenterId), host: v.host }));
      n++;
    }
    mark('vm', n);
  } catch (e) { mark('vm', 0, e); }
  try {
    let n = 0;
    for (const h of snap.hosts || []) {
      if (!h) continue;
      const [status, statusText] = hostStatus(h);
      const hip = (() => { try { return hostLedgerIp(h); } catch { return null; } })();
      out.push(mkRow('host', { id: h.id, name: h.name, ips: hip ? [hip.ip] : [], serials: [h.serviceTag],
        model: [h.vendor, h.model].filter(Boolean).join(' '), sub: [h.version ? `ESXi ${h.version}` : '', h.cluster].filter(Boolean).join(' · '),
        status, statusText, vcenterId: h.vcenterId, corp: vcName(h.vcenterId) }));
      n++;
    }
    mark('host', n);
  } catch (e) { mark('host', 0, e); }
  try {
    let n = 0;
    for (const d of snap.datastores || []) {
      if (!d) continue;
      const pct = numOrNull(d.usagePct);
      const down = d.accessible === false;
      out.push(mkRow('datastore', { id: d.id, name: d.name, sub: [d.type, d.storageType].filter(Boolean).join(' · '),
        status: down ? 'down' : '', statusText: down ? '접근 불가' : (pct != null ? `사용 ${Math.round(pct)}%` : ''),
        vcenterId: d.vcenterId, corp: vcName(d.vcenterId), alt: d.remoteHost || '' }));
      n++;
    }
    mark('datastore', n);
  } catch (e) { mark('datastore', 0, e); }
  try {
    let n = 0;
    for (const vc of snap.vcenters || []) {
      if (!vc) continue;
      const st = low(vc.status);
      const loc = vc.location && typeof vc.location === 'object' ? [vc.location.city, vc.location.country].filter(Boolean).join(', ') : '';
      out.push(mkRow('vcenter', { id: vc.id, name: vc.name || vc.id, alt: loc, sub: vc.version ? `vCenter ${vc.version}` : '',
        status: st === 'connected' ? 'ok' : st ? 'down' : '', statusText: st === 'connected' ? '연결됨' : st === 'unreachable' ? '연결 불가' : '',
        vcenterId: vc.id, corp: vc.name || vc.id }));
      n++;
    }
    mark('vcenter', n);
  } catch (e) { mark('vcenter', 0, e); }
}

/** 물리 서버 — iDRAC(중앙 + 위임 엣지 원격 인벤토리) · OME · 엣지 베어메탈. 서비스 태그가 같은 것은 한 행(iDRAC 우선). */
function fromServers(dcName, vcName, out, mark) {
  let n = 0; let err = null;
  const seenTag = new Set();
  try {
    const regErr = idracRegistryError();
    if (regErr) err = 'registryUnreadable';
    for (const s of analysisServersWithRemote(undefined)) {
      if (!s) continue;
      const inv = (() => { try { return invForServer(s); } catch { return null; } })();
      const sys = inv?.system || {};
      const tag = s.serviceTag || sys.serviceTag || '';
      if (tag) seenTag.add(normSerial(tag));
      const vc = str(s.vcenterId || s.mappedVcenterId);
      const vendor = s.type === 'ilo' || /hpe/i.test(String(s.vendor || '')) ? 'iLO' : 'iDRAC';
      out.push(mkRow('server', { id: s.id, name: s.name || sys.hostName || s.host || s.id, alt: sys.hostName || '',
        addr: s.host, serials: [tag, sys.serialNumber, sys.assetTag], model: sys.model || s.model || '',
        sub: [sys.manufacturer, vendor, s.remote ? '엣지 수집' : ''].filter(Boolean).join(' · '),
        statusText: vc ? 'ESXi 호스트' : '베어메탈', vcenterId: vc, corp: dcName(s.datacenterId) || vcName(vc),
        agent: s.remote ? (s.collectorId || '') : '' }));
      n++;
    }
  } catch (e) { err = e; }
  try {
    for (const { entryId, device } of allOmeDevices()) {
      const tag = device?.serviceTag || '';
      if (tag && seenTag.has(normSerial(tag))) continue;
      if (tag) seenTag.add(normSerial(tag));
      out.push(mkRow('server', { id: `ome:${omeDbKey(entryId, device)}`, name: device?.name || tag, serials: [tag],
        model: device?.model || '', sub: 'OME 발견', statusText: '베어메탈' }));
      n++;
    }
  } catch (e) { err = err || e; }
  try {
    for (const e of getEdgeFleetServers() || []) {
      const tag = e?.serviceTag || '';
      if (tag && seenTag.has(normSerial(tag))) continue;
      if (tag) seenTag.add(normSerial(tag));
      out.push(mkRow('server', { id: `edge:${e.remoteAgent || ''}:${e.serverId || tag}`, name: e.serverName || tag, serials: [tag],
        model: e.model || '', sub: '엣지 베어메탈', statusText: e.vcenterId ? 'ESXi 호스트' : '베어메탈',
        vcenterId: e.vcenterId || '', corp: vcName(e.vcenterId), agent: e.remoteAgent || '' }));
      n++;
    }
  } catch (e) { err = err || e; }
  mark('server', n, err);
}

function fromGpu(vcName, out, mark) {
  try {
    let n = 0;
    for (const s of listPhysical()) {
      out.push(mkRow('gpu', { id: s.id, name: s.name || s.host, addr: s.host, model: (s.gpuModels || []).join(', '),
        sub: [s.os === 'windows' ? 'Windows' : 'Linux', s.enabled === false ? '수집 꺼짐' : ''].filter(Boolean).join(' · '),
        vcenterId: s.vcenterId, corp: vcName(s.vcenterId) }));
      n++;
    }
    mark('gpu', n);
  } catch (e) { mark('gpu', 0, e); }
}

function fromStorage(dcName, out, mark) {
  try {
    const bad = storageRegistryError();
    const byId = latestMapByDevice([storageLocal(), edgeStorageSnapshots()]);
    let n = 0;
    for (const d of listStorage()) {
      const s = byId.get(d.id) || null;
      const pct = numOrNull(s?.capacity?.pct);
      const status = !s ? '' : s.ok === false ? 'down' : 'ok';
      const statusText = !s ? '수집 전' : s.ok === false ? '수집 실패' : (pct != null ? `사용 ${Math.round(pct)}%` : '수집됨');
      out.push(mkRow('storage', { id: d.id, name: d.name || s?.name || d.id, addr: d.host,
        serials: [s?.serial, ...((s?.extra?.appliances || []).map((a) => a?.serviceTag))],
        model: s?.extra?.model || '', sub: [d.type, s?.version].filter(Boolean).join(' '), status, statusText,
        corp: dcName(d.datacenterId), agent: d.agent || s?.agent || '' }));
      n++;
    }
    mark('storage', n, bad ? 'registryUnreadable' : null);
  } catch (e) { mark('storage', 0, e); }
}

function fromSanSwitch(dcName, out, mark) {
  try {
    const bad = switchRegistryError();
    const byId = latestMapByDevice([switchLocal(), edgeSanSwitchSnapshots()]);
    let n = 0;
    for (const d of listSwitches()) {
      const s = byId.get(d.id) || null;
      const state = str(s?.switchState || s?.extra?.switchState);
      const status = !s ? '' : s.ok === false ? 'down' : (state && !/online/i.test(state) ? 'warn' : 'ok');
      const statusText = !s ? '수집 전' : s.ok === false ? '수집 실패' : (state || '수집됨');
      out.push(mkRow('sanswitch', { id: d.id, name: d.name || s?.name || d.id, alt: s?.name && s.name !== d.name ? s.name : '',
        addr: d.host || s?.host, serials: [s?.serial, s?.wwn], model: s?.model || '',
        sub: s?.fabricOs ? `FOS ${s.fabricOs}` : '', status, statusText,
        corp: dcName(d.datacenterId || s?.datacenterId), agent: d.agent || s?.agent || '' }));
      n++;
    }
    mark('sanswitch', n, bad ? 'registryUnreadable' : null);
  } catch (e) { mark('sanswitch', 0, e); }
}

async function fromCvp(dcList, out, mark) {
  try {
    const bad = cvpRegistryError();
    const servers = listCvpServers();
    const { rows, unavailable } = await listCvpDeviceRows();
    const own = rowOwnerOf(servers);
    const corpOf = corpResolver(servers, dcList);
    let n = 0;
    for (const d of rows) {
      if (!own(d)) continue;
      out.push(mkRow('netswitch', { id: `${d.cvpId}|${d.key}`, name: d.hostname || d.key, addr: d.mgmtIp, serials: [d.serial],
        model: d.model, sub: d.eosVersion ? `EOS ${d.eosVersion}` : '', corp: corpOf(d.cvpId).corpName || '', agent: d.agent || '' }));
      n++;
    }
    mark('netswitch', n, bad ? 'registryUnreadable' : unavailable ? 'dbUnavailable' : null);
  } catch (e) { mark('netswitch', 0, e); }
}

function fromPdu(dcName, out, mark) {
  try {
    const bad = pduRegistryError();
    const byId = new Map();
    for (const s of [...pduLocal(), ...edgePduSnapshots()]) {
      if (!s || s.id == null) continue;
      const prev = byId.get(s.id);
      if (!prev || (Number(s.collectedAt) || 0) > (Number(prev.collectedAt) || 0)) byId.set(s.id, s);
    }
    let n = 0;
    for (const d of listPdus()) {
      const s = byId.get(d.id) || null;
      out.push(mkRow('pdu', { id: d.id, name: d.name || d.id, addr: d.host, serials: [s?.serial], model: s?.model || '',
        sub: 'APC Rack PDU', status: !s ? '' : s.ok === false ? 'down' : 'ok', statusText: !s ? '수집 전' : s.ok === false ? '수집 실패' : '수집됨',
        corp: dcName(d.datacenterId), agent: d.agent || s?.agent || '' }));
      n++;
    }
    mark('pdu', n, bad ? 'registryUnreadable' : null);
  } catch (e) { mark('pdu', 0, e); }
}

const OWNER_LABEL = { vm: 'VM', host: 'VM호스트', scanned: '스캔 발견', manual: '수동 등록' };
async function fromIpam(snap, out, mark) {
  try {
    const data = await buildIpamRowsShared(snap, '', null, { shouldCache: () => store.get() === snap });
    let n = 0;
    for (const r of data?.rows || []) {
      if (!r || !r.ip) continue;
      out.push(mkRow('ip', { id: r.ip, name: r.ip, ips: [r.ip], alt: [r.ownerName !== r.ip ? r.ownerName : '', r.hostName && r.hostName !== r.ownerName ? r.hostName : ''].filter(Boolean).join(' · '),
        sub: OWNER_LABEL[r.ownerType] || str(r.ownerType), vcenterId: r.vcenterId || '', corp: r.vcenterName || '', ownerType: r.ownerType }));
      n++;
    }
    mark('ip', n);
  } catch (e) { mark('ip', 0, e); }
}

/** 전 출처 → 행. 던지지 않는다(출처별로 실패를 기록한다). */
export async function buildInventoryIndex() {
  const t0 = Date.now();
  const snap = store.get() || {};
  const rows = [];
  const sources = {};
  const mark = (k, n, err) => {
    const e = err ? (typeof err === 'string' ? err : String(err?.message || err).slice(0, 200)) : null;
    sources[k] = { rows: n, ...(e ? { error: e } : {}) };
  };
  const vcNames = new Map((snap.vcenters || []).map((v) => [String(v?.id), String(v?.name || v?.id || '')]));
  const vcName = (id) => (id ? vcNames.get(String(id)) || '' : '');
  let dcList = [];
  try { dcList = listDatacenters(); } catch { dcList = []; }
  const dcNames = new Map(dcList.map((d) => [String(d.id), String(d.name || d.id)]));
  const dcName = (id) => (id ? dcNames.get(String(id)) || '' : '');

  fromSnapshot(snap, vcName, rows, mark);
  fromServers(dcName, vcName, rows, mark);
  fromGpu(vcName, rows, mark);
  fromStorage(dcName, rows, mark);
  fromSanSwitch(dcName, rows, mark);
  fromPdu(dcName, rows, mark);
  await fromCvp(dcList, rows, mark);
  await fromIpam(snap, rows, mark);
  for (const k of KIND_KEYS) if (!sources[k]) sources[k] = { rows: 0 };
  return { rows, sources, builtAt: Date.now(), buildMs: Date.now() - t0, snapAt: snap.generatedAt || null };
}

let _cache = null;     // { at, rows, sources, builtAt, buildMs }
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
