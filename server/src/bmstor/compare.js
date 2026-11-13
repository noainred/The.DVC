/**
 * bmstor/compare.js — 베어메탈 ↔ SAN 어레이 비교 조립(순수, v2.915 — 설계 docs/design/bm-san-compare §4.2 · §4.4).
 *
 * 들어오는 것: 등록 스토리지 장비 · 최신 스냅샷(중앙 · 엣지) · SAN 포트 사용량 합산(storageSeriesMulti 결과) · 베어메탈 합산.
 * 나가는 것: 어레이 행(용량 + 전송 속도 또는 사유 코드) · 요약(차이 · 배율) · 법인 칩(필터 전 전체).
 * 규칙: 못 읽은 값은 null 이고 사유는 **코드**다(문장은 웹 — bmSanCompareText.js). 억지 매칭 금지 — 시리얼이 확실히 같을 때만 붙인다.
 */
import { numOrNull } from '../util/numOrNull.js';
import { arraySerialOf } from '../sanswitch/perfDb.js';

export const DEFAULT_SAN_TYPES = Object.freeze(['vmax', 'powermax']);
/** 비교 대상이 될 수 있는 블록 어레이 종류(파일 · 가상화 계층은 뺀다 — 전송 속도 뜻이 다르다). */
export const BLOCK_ARRAY_TYPES = Object.freeze(['vmax', 'powermax', 'unity480', 'powerstore', 'xtremio']);

export const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');

/** 쿼리 `types=vmax,powermax|all` → 종류 배열(아는 것만 · 기본 VMAX · PowerMax). */
export function parseTypes(q) {
  const s = String(q || '').trim();
  if (!s) return [...DEFAULT_SAN_TYPES];
  if (s === 'all') return [...BLOCK_ARRAY_TYPES];
  const out = s.split(',').map((x) => x.trim().toLowerCase()).filter((x) => BLOCK_ARRAY_TYPES.includes(x));
  return out.length ? [...new Set(out)] : [...DEFAULT_SAN_TYPES];
}

/** 장비별 최신 스냅샷 — 중앙 · 엣지 둘 다 있으면 collectedAt 이 늦은 것. */
export function latestSnapshotMap(lists = []) {
  const m = new Map();
  for (const list of lists) {
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object' || !s.deviceId) continue;
      const prev = m.get(s.deviceId);
      if (!prev || (Number(s.collectedAt) || 0) >= (Number(prev.collectedAt) || 0)) m.set(s.deviceId, s);
    }
  }
  return m;
}

/**
 * 어레이 행(용량) — 등록 장비 × 최신 스냅샷. 종류 · 법인 필터는 호출부가 한다.
 * @returns {Array<{ id, name, type, datacenterId, serial, serialKeys:string[], capacity:{totalBytes,usedBytes,pct,basis,at}|null, snapshotOk:boolean, capacityReason:string|null }>}
 */
export function sanArrayRows(devices, snapMap) {
  const out = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || !d.id) continue;
    const snap = snapMap.get(d.id) || null;
    const cap = snap?.ok ? snap.capacity : null;
    const total = numOrNull(cap?.totalBytes); const used = numOrNull(cap?.usedBytes);
    const pct = numOrNull(cap?.pct) ?? (total != null && used != null && total > 0 ? Math.round((used / total) * 1000) / 10 : null);
    // 시리얼 후보 — 본체 시리얼 + 어플라이언스 서비스 태그(PowerStore). 글자 · 숫자만 받는다(CEN2606-04 규약).
    const apps = Array.isArray(snap?.extra?.appliances) ? snap.extra.appliances : [];
    const keys = [snap?.serial, ...apps.map((a) => (a && typeof a === 'object' ? a.serviceTag : null))]
      .filter((k) => k && (typeof k === 'string' || typeof k === 'number')).map((k) => norm(k)).filter(Boolean);
    out.push({
      id: d.id, name: d.name || d.id, type: String(d.type || ''), datacenterId: String(d.datacenterId || ''),
      serial: snap?.serial ? String(snap.serial) : '', serialKeys: [...new Set(keys)],
      capacity: total != null ? { totalBytes: total, usedBytes: used, pct, basis: String(snap?.extra?.capacityBasis || ''), at: numOrNull(snap?.collectedAt) } : null,
      snapshotOk: !!snap?.ok,
      capacityReason: !snap ? 'no-snapshot' : !snap.ok ? 'collect-failed' : total == null ? 'no-capacity' : null,
    });
  }
  return out;
}

/**
 * 어레이 행에 전송 속도를 붙인다(SAN 포트 사용량 합산 — storageSeriesMulti 의 series). 대조 키 = arraySerialOf(key) ↔ 행의 serialKeys.
 * 법인별로 나눠 집계했으면(series.group) **같은 법인의 계열만** 붙인다(다른 법인 어레이의 트래픽을 붙이지 않는다).
 * 못 붙이면 throughput null + reason: 'perf-disabled' | 'perf-unavailable' | 'no-switches' | 'serial-unmatched' | 'no-samples'
 */
export function attachThroughput(rows, agg, { perfEnabled = true, perfAvailable = true, switches = 0, split = false } = {}) {
  const bySerial = new Map();   // `${group}\u0000${serial}` 또는 serial
  const keyOf = (g, serial) => (split ? `${g ?? ''}\u0000${serial}` : serial);
  for (const s of Array.isArray(agg?.series) ? agg.series : []) {
    const serial = norm(arraySerialOf(s.key));
    if (!serial) continue;
    const k = keyOf(s.group ?? '', serial);
    const prev = bySerial.get(k);
    if (!prev || (Number(s.avgTotal) || 0) > (Number(prev.avgTotal) || 0)) bySerial.set(k, s);
  }
  return (rows || []).map((r) => {
    let reason = null;
    if (!perfEnabled) reason = 'perf-disabled';
    else if (!perfAvailable) reason = 'perf-unavailable';
    else if (!switches) reason = 'no-switches';
    if (reason) return { ...r, throughput: null, throughputReason: reason };
    let hit = null;
    for (const k of r.serialKeys) { hit = bySerial.get(keyOf(r.datacenterId, k)) || null; if (hit) break; }
    if (!hit) return { ...r, throughput: null, throughputReason: 'serial-unmatched' };
    const avg = numOrNull(hit.avgTotal);
    if (avg == null) return { ...r, throughput: null, throughputReason: 'no-samples', ports: Array.isArray(hit.ports) ? hit.ports.length : 0 };
    return {
      ...r,
      throughput: {
        avgBps: Math.round(avg), maxBps: numOrNull(hit.maxTotal), peakAvgBps: numOrNull(hit.peakAvg), peakBps: numOrNull(hit.peakTotal),
        ports: Array.isArray(hit.ports) ? hit.ports.length : 0,
        switches: Array.isArray(hit.deviceIds) ? hit.deviceIds.length : 0,
        partialBuckets: Array.isArray(hit.partial) ? hit.partial.length : 0,
        seriesKey: String(hit.key || ''),
      },
      throughputReason: null,
    };
  });
}

const pctOf = (used, total) => (used != null && total > 0 ? Math.round((used / total) * 1000) / 10 : null);

/** 요약 — 용량(차이 %p) · 전송 속도(배율). 분모가 없으면 null. */
export function compareSummary({ bmTotal, sanRows }) {
  const bmUsed = numOrNull(bmTotal?.usedBytes); const bmCap = numOrNull(bmTotal?.totalBytes);
  const bmPct = numOrNull(bmTotal?.usedPct);
  let sanUsed = null; let sanCap = null; let sanCapMeasured = 0;
  let sanBps = null; let sanPeakSum = null; let sanMeasured = 0;
  const rows = Array.isArray(sanRows) ? sanRows : [];
  for (const r of rows) {
    if (r.capacity && r.capacity.usedBytes != null) { sanUsed = (sanUsed ?? 0) + r.capacity.usedBytes; sanCap = (sanCap ?? 0) + r.capacity.totalBytes; sanCapMeasured += 1; }
    if (r.throughput && r.throughput.avgBps != null) {
      sanBps = (sanBps ?? 0) + r.throughput.avgBps; sanMeasured += 1;
      if (r.throughput.peakBps != null) sanPeakSum = (sanPeakSum ?? 0) + r.throughput.peakBps;
    }
  }
  const sanPct = pctOf(sanUsed, sanCap);
  const bmIo = bmTotal?.io || null;
  const bmBps = numOrNull(bmIo?.totalBps);
  return {
    capacity: {
      bmPct, bmUsedBytes: bmUsed, bmTotalBytes: bmCap, bmServers: numOrNull(bmTotal?.ok) ?? 0,
      sanPct, sanUsedBytes: sanUsed, sanTotalBytes: sanCap, sanMeasured: sanCapMeasured, sanTotal: rows.length,
      deltaPp: bmPct != null && sanPct != null ? Math.round((bmPct - sanPct) * 10) / 10 : null,
    },
    throughput: {
      bmBps, bmReadBps: numOrNull(bmIo?.readBps), bmWriteBps: numOrNull(bmIo?.writeBps),
      bmMeasured: numOrNull(bmIo?.measured) ?? 0, bmTotal: numOrNull(bmIo?.total) ?? 0,
      sanBps, sanPeakSumBps: sanPeakSum, sanMeasured, sanTotal: rows.length,
      ratio: bmBps != null && bmBps > 0 && sanBps != null ? Math.round((sanBps / bmBps) * 10) / 10 : null,
    },
  };
}

/**
 * 법인 칩(필터 전 전체) — [{ id, name, servers, arrays, maxPct }]. id '' 는 미지정(화면이 센티널로 바꾼다).
 * 점 = 그 법인에서 가장 높은 사용률(서버 · 어레이) — 화면이 색으로 바꾼다.
 */
export function datacenterChips({ servers = [], sanRows = [], dcNameOf = (id) => id } = {}) {
  const m = new Map();
  const touch = (id) => { const k = String(id || ''); if (!m.has(k)) m.set(k, { id: k, name: k ? dcNameOf(k) : '(법인 미지정)', servers: 0, arrays: 0, maxPct: null }); return m.get(k); };
  const bump = (c, pct) => { const p = numOrNull(pct); if (p != null && (c.maxPct == null || p > c.maxPct)) c.maxPct = p; };
  for (const s of servers) { if (!s || s.enabled === false) continue; const c = touch(s.datacenterId); c.servers += 1; if (s.ok) bump(c, s.usedPct); }
  for (const r of sanRows) { if (!r) continue; const c = touch(r.datacenterId); c.arrays += 1; bump(c, r.capacity?.pct); }
  return [...m.values()].sort((a, b) => (a.id === '' ? 1 : b.id === '' ? -1 : String(a.name).localeCompare(String(b.name), 'ko')));
}

/** 응답에서 관리 주소를 지운다(이 화면은 주소를 싣지 않는다 — 가림 분기 자체가 없다). */
export function stripHost(row) {
  if (!row || typeof row !== 'object') return row;
  const { host, ...rest } = row;
  return rest;
}
