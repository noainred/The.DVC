/**
 * insights/serialLookup.js — 전 장비 시리얼 통합 조회(v2.412, 사용자 요구
 * '특수기능에 시리얼 조회 — 서버·스토리지·네트워크·SAN switch 등 등록·수집된 모든 장비').
 *
 * 왜 필요한가: 시리얼(서비스 태그)은 이 포탈의 8개 서로 다른 저장소에 흩어져 있다 —
 * iDRAC 인벤토리, OME, vCenter 호스트 하드웨어, 스토리지 스냅샷, SAN 스위치 스냅샷,
 * 엣지 베어메탈 등. 벤더 RMA·자산 대조·"이 시리얼이 어느 장비인가"를 확인하려면 지금은
 * 화면 6곳을 따로 뒤져야 한다. 여기서 한 번에 찾는다.
 *
 * 설계 원칙
 *  - **읽기 전용 집계**다. 어떤 수집도 새로 하지 않고 이미 수집된 값만 모은다.
 *  - 부품 시리얼(PSU·디스크·DIMM·NIC·SFP)까지 포함한다 — RMA 는 대개 부품 단위다.
 *  - 없는 값은 만들지 않는다. 시리얼이 없는 장비(VPLEX·베어메탈 스토리지·GPU)는
 *    조용히 빠지는 대신 '수집 현황'에 0 으로 보여 왜 안 나오는지 알 수 있게 한다.
 *  - 인덱스는 짧게 캐시한다(기본 30초). 658 서버 × 부품이면 수만 행이라 매 타이핑마다
 *    다시 만들 수 없다.
 */

import { analysisServersWithRemote, invForServer } from './analysisServers.js'; // v2.579: ARCH-04
import { allOmeDevices, dbKey as omeDbKey } from '../idrac/omeCache.js';
import { store } from '../store.js';
import { listDevices as listStorageDevices } from '../storage/registry.js';
import { localSnapshots as storageLocal } from '../storage/store.js';
import { edgeStorageSnapshots } from '../central/storageEdge.js';
import { listDevices as listSwitchDevices } from '../sanswitch/registry.js';
import { localSnapshots as switchLocal, getSnapshot as switchSnapshot } from '../sanswitch/store.js';
import { edgeSanSwitchSnapshots } from '../central/sanSwitchEdge.js';
import { getEdgeFleetServers } from '../central/fleet.js';

/** 장비 종류(화면 필터 칩과 1:1). */
export const KINDS = [
  { key: 'server', label: '서버(iDRAC)', icon: '🖥' },
  { key: 'server-part', label: '서버 부품', icon: '🔩' },
  { key: 'ome', label: 'OME 장비', icon: '🗂' },
  { key: 'esxi', label: 'ESXi 호스트', icon: '💠' },
  { key: 'storage', label: '스토리지', icon: '🗄' },
  { key: 'sanswitch', label: 'SAN 스위치', icon: '🔗' },
  { key: 'sanswitch-part', label: 'SAN 스위치 부품', icon: '🔌' },
  { key: 'bm-edge', label: '엣지 베어메탈', icon: '💽' },
];

const CACHE_MS = Math.max(5_000, Number(process.env.SERIAL_INDEX_CACHE_MS) || 30_000);
const REFRESH_MIN_MS = 10_000; // ?refresh=1 최소 간격
let _cache = null; // { at, rows }

/**
 * 검색용 정규화(순수). 대소문자와 구분자(`:`, `-`, 공백, `.`)를 지운다.
 * WWN 을 `10:00:00:05` 로 적힌 대로만 찾게 하면, 사람이 자산대장에서 복사한
 * `1000000517` 이나 대시 표기가 안 걸린다. 표시용 원문은 그대로 두고 **검색 키만** 정규화한다.
 */
export const normKey = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');

/** 한 행 만들기. serial 이 비면 null 을 돌려 호출부가 건너뛴다(빈 시리얼 행을 만들지 않는다). */
function row(kind, serial, fields) {
  const s = String(serial ?? '').trim();
  if (!s || s === '-' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'unknown') return null;
  return { kind, serial: s, key: normKey(s), ...fields };
}

/** iDRAC 인벤토리의 부품 배열 → 부품 시리얼 행들. */
function partRows(server, inv, dcOf) {
  const out = [];
  const base = {
    deviceName: server.name || server.host || server.id,
    host: server.host || '',
    // model 은 **부품이 꽂힌 장비**의 모델이다(부품 자신의 모델은 partModel).
    // 처음에 parentModel 이라는 별도 키로 넣었더니 표/CSV 의 '모델' 칸이 비어 있었다.
    model: inv?.system?.model || server.model || '',
    vendor: inv?.system?.manufacturer || '',
    hostname: inv?.system?.hostName || '',
    vcenterId: server.vcenterId || '',
    datacenterId: dcOf(server),
    agent: server.remote ? (server.collectorId || '엣지') : '',
    deviceId: server.id,
  };
  const push = (list, partLabel, modelKey) => {
    for (const p of list || []) {
      const model = [p[modelKey], p.manufacturer].filter(Boolean).join(' ') || p.model || '';
      const where = p.locator || p.name || p.id || '';
      for (const [field, sType] of [['serial', '시리얼'], ['partNumber', '부품번호']]) {
        const r = row('server-part', p[field], {
          ...base, serialType: sType, part: partLabel, partModel: model, partLocation: where,
        });
        if (r) out.push(r);
      }
    }
  };
  push(inv?.psus, '전원공급장치', 'model');
  push(inv?.disks, '디스크', 'model');
  push(inv?.memoryDimms, '메모리', 'partNumber');
  push(inv?.nics, 'NIC', 'model');
  push(inv?.fans, '팬', 'model');
  return out;
}

/**
 * 전 출처에서 시리얼 인덱스를 만든다. req 는 서버 목록의 범위 필터에 쓰인다.
 * ⚠ 실패한 출처가 전체를 막지 않게 각 구획을 try 로 감싼다 — 한 모듈이 죽어도 나머지는 보인다.
 */
export function buildSerialIndex(req, { includeSfp = true } = {}) {
  const rows = [];
  const sources = {};
  const dcNameOf = () => (id) => id || '';
  const dcOf = (o) => o?.datacenterId || '';
  const mark = (k, n, err) => { sources[k] = { rows: n, ...(err ? { error: err } : {}) }; };

  // 1) 서버(iDRAC) 섀시 + 부품
  try {
    const servers = analysisServersWithRemote(req);
    let chassis = 0; let parts = 0;
    for (const s of servers) {
      const inv = (() => { try { return invForServer(s); } catch { return null; } })();
      const base = {
        deviceName: s.name || s.host || s.id, host: s.host || '',
        model: inv?.system?.model || s.model || '',
        vendor: inv?.system?.manufacturer || '',
        hostname: inv?.system?.hostName || '',
        vcenterId: s.vcenterId || '', datacenterId: dcOf(s),
        agent: s.remote ? (s.collectorId || '엣지') : '', deviceId: s.id,
      };
      for (const [field, label] of [['serviceTag', '서비스 태그'], ['serialNumber', '시리얼'], ['assetTag', '자산 태그'], ['uuid', 'UUID']]) {
        const v = field === 'serviceTag' ? (s.serviceTag || inv?.system?.serviceTag) : inv?.system?.[field];
        const r = row('server', v, { ...base, serialType: label });
        if (r) { rows.push(r); chassis++; }
      }
      if (inv) { const pr = partRows(s, inv, dcOf); rows.push(...pr); parts += pr.length; }
    }
    mark('server', chassis); mark('server-part', parts);
  } catch (e) { mark('server', 0, e.message); mark('server-part', 0, e.message); }

  // 2) OME 가 발견한 장비
  try {
    let n = 0;
    for (const { entryId, device } of allOmeDevices()) {
      const r = row('ome', device?.serviceTag, {
        deviceName: device?.name || '', host: '', model: device?.model || '',
        serialType: '서비스 태그', deviceId: omeDbKey(entryId, device), agent: '',
        vcenterId: '', datacenterId: '', extra: device?.powerState || '',
      });
      if (r) { rows.push(r); n++; }
    }
    mark('ome', n);
  } catch (e) { mark('ome', 0, e.message); }

  // 3) ESXi 호스트(vCenter 가 보고한 하드웨어 서비스 태그)
  try {
    const snap = store.get() || {};
    let n = 0;
    for (const h of snap.hosts || []) {
      const r = row('esxi', h.serviceTag, {
        deviceName: h.name || '', host: h.name || '', model: h.model || '', vendor: h.vendor || '',
        serialType: '서비스 태그', vcenterId: h.vcenterId || '', datacenterId: '',
        deviceId: h.id || h.name, extra: h.cluster || '',
      });
      if (r) { rows.push(r); n++; }
    }
    mark('esxi', n);
  } catch (e) { mark('esxi', 0, e.message); }

  // 4) 스토리지 어레이 — 스냅샷에는 장비 식별이 없어 등록부와 조인한다(storageMon 과 동일 규약).
  try {
    const devById = new Map(listStorageDevices().map((d) => [d.id, d]));
    let n = 0;
    for (const s of [...storageLocal(), ...edgeStorageSnapshots()]) {
      const d = devById.get(s.deviceId) || {};
      const base = {
        deviceName: d.name || s.name || s.deviceId, host: d.host || '', model: s.extra?.model || d.type || '',
        vendor: d.type || '', vcenterId: '', datacenterId: d.datacenterId || '',
        agent: s.agent || d.agent || '', deviceId: s.deviceId, extra: s.version || '',
      };
      const r = row('storage', s.serial, { ...base, serialType: '어레이 시리얼' });
      if (r) { rows.push(r); n++; }
      // PowerStore 는 어플라이언스마다 Dell 서비스 태그가 따로 있다(RMA 단위).
      for (const a of s.extra?.appliances || []) {
        const ar = row('storage', a.serviceTag, {
          ...base, serialType: '어플라이언스 서비스 태그', part: a.name || '', partModel: a.model || '',
        });
        if (ar) { rows.push(ar); n++; }
      }
    }
    mark('storage', n);
  } catch (e) { mark('storage', 0, e.message); }

  // 5) SAN 스위치 — 스냅샷이 식별을 들고 있지만 등록부로 보강(법인·표시명).
  try {
    const swById = new Map(listSwitchDevices().map((d) => [d.id, d]));
    let n = 0; let parts = 0; let bad = 0; let badMsg = '';
    // v2.607(감사 CEN2607-01): **장비 단위** try — 예전에는 구획 전체를 한 try 로 감싸 엣지 한 곳의 원소 하나
    //   (health.psuDetail:[null])가 전 엣지·중앙 스위치의 시리얼을 rows 0 으로 지웠다. 실패한 장비만 건너뛰고 개수를 밝힌다.
    for (const s of [...switchLocal(), ...edgeSanSwitchSnapshots()]) {
      const nBefore = n; const pBefore = parts; const rBefore = rows.length;
      try {
      const d = swById.get(s?.deviceId) || {};
      const base = {
        deviceName: d.name || s.name || s.deviceId, hostname: s.name || '',
        host: s.host || d.host || '', model: s.model || (s.extra?.switchType ? `switchType ${s.extra.switchType}` : ''),
        vendor: 'Brocade', vcenterId: '', datacenterId: s.datacenterId || d.datacenterId || '',
        agent: s.agent || d.agent || '', deviceId: s.deviceId, extra: s.fabricOs || '',
      };
      for (const [v, label] of [[s.serial, '섀시 시리얼'], [s.wwn, 'Switch WWN'],
        [s.extra?.chassisPartNumber, '섀시 부품번호'], [s.extra?.chassisId, '섀시 ID']]) {
        const r = row('sanswitch', v, { ...base, serialType: label });
        if (r) { rows.push(r); n++; }
      }
      // PSU 시리얼(chassisshow 에서 수집)
      for (const p of s.health?.psuDetail || []) {
        const r = row('sanswitch-part', p.serial, {
          ...base, serialType: '시리얼', part: '전원공급장치', partLocation: `#${p.unit}`,
          partModel: [p.source, p.voltageV ? `${p.voltageV}V` : '', p.powerW ? `${p.powerW}W` : ''].filter(Boolean).join(' '),
        });
        if (r) { rows.push(r); parts++; }
      }
      // SFP 시리얼 — 목록 응답에는 포트가 없어 로컬 스냅샷에서 직접 읽는다.
      // ⚠ 엣지 위임 스위치는 중앙에 '문제 포트만' 올라오므로 SFP 수집 범위가 부분적이다(정직 표기).
      if (includeSfp) {
        const full = switchSnapshot(s.deviceId) || s;
        for (const p of full.ports?.list || []) {
          for (const [v, label] of [[p.sfpSerial, 'SFP 시리얼'], [p.sfpPartNumber, 'SFP 부품번호']]) {
            const r = row('sanswitch-part', v, {
              ...base, serialType: label, part: 'SFP', partLocation: `포트 ${p.slotPort}`,
              partModel: p.sfpVendor || '',
            });
            if (r) { rows.push(r); parts++; }
          }
        }
      }
      } catch (e) {
        rows.length = rBefore; n = nBefore; parts = pBefore; bad += 1;
        if (!badMsg) badMsg = String(e?.message || e).slice(0, 200);
      }
    }
    const badNote = bad ? `장비 ${bad}대의 스냅샷 형식 오류로 건너뜀(${badMsg})` : undefined;
    mark('sanswitch', n, badNote); mark('sanswitch-part', parts, badNote);
  } catch (e) { mark('sanswitch', 0, e.message); mark('sanswitch-part', 0, e.message); }

  // 6) 엣지가 올린 베어메탈 서버(중앙 iDRAC 등록엔 없다)
  try {
    let n = 0;
    for (const e of getEdgeFleetServers() || []) {
      const r = row('bm-edge', e.serviceTag, {
        deviceName: e.name || e.fleetId || '', host: '', model: e.model || '',
        serialType: '서비스 태그', vcenterId: e.vcenterId || '', datacenterId: '',
        agent: e.source || '엣지', deviceId: e.fleetId || '',
      });
      if (r) { rows.push(r); n++; }
    }
    mark('bm-edge', n);
  } catch (e) { mark('bm-edge', 0, e.message); }

  void dcNameOf;
  return { rows, sources, builtAt: Date.now() };
}

/** 캐시된 인덱스(짧은 TTL — 매 타이핑마다 수만 행을 다시 만들지 않기 위해). */
export function serialIndex(req, { force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.at < CACHE_MS) return _cache;
  // 강제 재구축은 최소 간격(REFRESH_MIN_MS)으로 스로틀 — 누구나 ?refresh=1 로 매 요청 전량 재구축을
  // 강제해 이벤트 루프를 잡는 것 방지(v2.416 감사 L-2).
  if (force && _cache && Date.now() - _cache.at < REFRESH_MIN_MS) return _cache;
  // ⚠ 요청 필터(vcenterId/datacenterId/baremetal)를 인덱스에 반영하지 않는다 — 전역 캐시 1개를 여러 사용자가
  //   공유하므로, 한 요청의 필터로 축소된 인덱스가 30초 동안 다른 사용자에게 결손으로 보인다(L-2).
  void req;
  const built = buildSerialIndex({ query: {}, user: req?.user });
  _cache = { at: Date.now(), ...built };
  return _cache;
}

/**
 * 검색(순수) — 정규화 키의 부분 일치. 완전 일치를 먼저 보여준다(RMA 조회는 대개 완전 일치).
 * @returns { total, truncated, rows }
 */
export function searchSerials(rows, q, { kinds = null, limit = 500 } = {}) {
  const needle = normKey(q);
  if (!needle) return { total: 0, truncated: false, rows: [] };
  const kindSet = kinds?.length ? new Set(kinds) : null;
  const hit = rows.filter((r) => (!kindSet || kindSet.has(r.kind)) && r.key.includes(needle));
  hit.sort((a, b) => {
    const ea = a.key === needle ? 0 : 1;
    const eb = b.key === needle ? 0 : 1;
    if (ea !== eb) return ea - eb;                 // 완전 일치 우선
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return String(a.deviceName).localeCompare(String(b.deviceName));
  });
  return { total: hit.length, truncated: hit.length > limit, rows: hit.slice(0, limit) };
}

export function _resetForTest() { _cache = null; }
