/**
 * CVP Overview 집계(순수 — 입력만 보고 계산한다. DB·파일·시계 접근 없음). v2.645.
 *
 * 사용자 요청(2026-09-29): "CVP 메뉴에 들어갔을 때 300대가 넘는 장비가 잘 관리되고 있다는 개념의 overview" ·
 * "등록된 모델별 대수" · "법인별로 볼 수 있게" · "포트 사용량이 수집되면 법인이 처리하는 트래픽의 합" ·
 * "이벤트를 법인별 에러/워닝으로". 시안(클로드 디자인 캔버스)을 사용자가 승인했다.
 *
 * ── 지켜야 하는 규칙 ────────────────────────────────────────────────────────
 *  ① **'정상' 은 지금 값을 읽었고 읽은 항목에 이상이 없을 때만**이다. 오래된 수집·스트리밍 끊김·아무것도 못 읽음은
 *     `unknown`(확인 불가)이고 정상에도 이상에도 넣지 않는다(v2.519·v2.523·v2.548 규약 — 못 본 것을 초록으로 칠하는 것이
 *     이 화면이 만들 수 있는 가장 위험한 거짓이다). 일부 항목만 읽은 장비는 정상이되 `partial` 로 센다.
 *  ② **법인 = 그 장비를 수집하는 CVP 서버에 지정한 DataCenter**다. 한 CVP 가 여러 법인의 장비를 관리하면 전부 한 법인으로
 *     보인다 — 장비 단위 법인 정보는 CVP 응답에 없다(정직 기록 — 화면이 말한다). 지정이 없으면 `''`(미지정)로 따로 센다.
 *  ③ **트래픽 합은 마지막 수집의 순간값(bps) 합**이다. 평균이 아니고, 스위치끼리 연결된 링크의 트래픽은 **양쪽 스위치에서
 *     모두 세어진다**(법인이 '처리한' 총량이지 법인 밖으로 나간 양이 아니다). 처리량이 오래됐거나 없는 포트는 합에서 빼고
 *     그 개수·장비 수를 밝힌다(부분 합을 전체라 말하지 않는다 — v2.606 규약).
 *  ④ 모델·버전은 **장비가 보고한 문자열 그대로** 묶는다. 벤더 지원 상태(권장·지원 종료)는 지어내지 않는다 — 수명주기 조회
 *     결과(info.lifecycle)가 있는 장비만 '지원 종료 지남' 을 센다.
 */
import { partsSummary, bgpSummary } from './parse.js';
import { TELEMETRY_OK, partsFresh } from './faults.js';

export const UNASSIGNED_CORP = '';
export const TOP_DEVICES_PER_CORP = 5;
export const RECENT_EVENTS_MAX = 10;

/** 신선도 경계(ms). fresh = 주기 ×2(최소 10분), stale = 주기 ×3(최소 30분) — 포트 사용량 화면의 낡음 기준과 같은 계열. */
export function freshnessBounds(intervalMs) {
  const iv = Number(intervalMs) > 0 ? Number(intervalMs) : 300_000;
  return { freshMs: Math.max(10 * 60_000, iv * 2), staleMs: Math.max(30 * 60_000, iv * 3) };
}

/**
 * 장비 한 대의 판정.
 * @returns {{state:'ok'|'warn'|'bad'|'unknown', reasons:string[], partial:boolean}}
 */
export function deviceHealth(d, { now = Date.now(), staleMs = 30 * 60_000, highPct = 80, intervalMs, partsEveryMs } = {}) {
  const dev = d && typeof d === 'object' ? d : {};
  const at = Number(dev.collectedAt);
  if (!(at > 0)) return { state: 'unknown', reasons: ['never'], partial: false };
  if (now - at > staleMs) return { state: 'unknown', reasons: ['stale'], partial: false };
  if (dev.streaming === false) return { state: 'unknown', reasons: ['not-streaming'], partial: false };
  // v2.680(감사 B-03): 장애 판정(faults.observeDevice)과 같은 기준 — 텔레메트리를 못 읽은 장비는 정상이 아니다.
  const tel = String(dev.telemetry ?? '').trim().toLowerCase();
  if (tel !== 'not-streaming' && !TELEMETRY_OK.has(tel)) return { state: 'unknown', reasons: ['telemetry-failed'], partial: false };
  // v2.680(감사 B-02): 오래된 부품 목록(조회 실패로 남은 직전 값)은 지금 상태로 쓰지 않는다.
  const parts = partsFresh(dev, { intervalMs, partsEveryMs, now }) ? partsSummary(dev.partsList) : null;
  const bgp = dev.bgpPeers ? bgpSummary(dev.bgpPeers) : null;
  const ports = dev.ports && typeof dev.ports === 'object' ? dev.ports : null;
  const cpu = dev.cpuPct == null ? null : Number(dev.cpuPct);
  const mem = dev.memPct == null ? null : Number(dev.memPct);
  const anyRead = !!(parts || bgp || ports || cpu != null || mem != null);
  if (!anyRead) return { state: 'unknown', reasons: ['unread'], partial: false };
  const bad = []; const warn = [];
  if (parts && parts.fault > 0) bad.push('part-fault');
  if (bgp && bgp.down > 0) bad.push('bgp-down');
  if (parts && parts.warn > 0) warn.push('part-warn');
  if (ports && Number(ports.down) > 0) warn.push('port-down');
  if (cpu != null && Number.isFinite(cpu) && cpu >= highPct) warn.push('cpu-high');
  if (mem != null && Number.isFinite(mem) && mem >= highPct) warn.push('mem-high');
  const partial = !parts || !ports;
  if (bad.length) return { state: 'bad', reasons: [...bad, ...warn], partial };
  if (warn.length) return { state: 'warn', reasons: warn, partial };
  return { state: 'ok', reasons: [], partial };
}

/** CVP 서버 id → { corpId, corpName }. 삭제된 DataCenter 를 가리키면 id 를 이름으로 쓰되 `missing` 으로 밝힌다. */
export function corpResolver(servers = [], datacenters = []) {
  const dcName = new Map((Array.isArray(datacenters) ? datacenters : []).map((d) => [String(d.id), String(d.name || d.id)]));
  const byCvp = new Map();
  for (const s of Array.isArray(servers) ? servers : []) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.datacenterId || '').trim();
    byCvp.set(String(s.id), id ? { corpId: id, corpName: dcName.get(id) || id, ...(dcName.has(id) ? {} : { missing: true }) }
      : { corpId: UNASSIGNED_CORP, corpName: '' });
  }
  return (cvpId) => byCvp.get(String(cvpId)) || { corpId: UNASSIGNED_CORP, corpName: '' };
}

function emptyCorp(corpId, corpName, missing) {
  return {
    corpId, corpName, ...(missing ? { missing: true } : {}),
    devices: 0, health: { ok: 0, warn: 0, bad: 0, unknown: 0 }, partial: 0, streaming: 0,
    openFaults: 0, portsDown: 0, bgpDown: 0,
    traffic: { inBps: 0, outBps: 0, portsMeasured: 0, portsUnmeasured: 0, devicesMeasured: 0, devicesUnmeasured: 0, top: [] },
    events: { critical: 0, error: 0, warning: 0 },
    cvps: [],
  };
}

const SEV_KEYS = new Set(['critical', 'error', 'warning']);

/**
 * @param {object} i
 * @param {object[]} i.devices   rowToDevice 모양(등록부 담당과 맞는 행만 — 라우트가 거른다)
 * @param {object[]} i.servers   CVP 등록부(id·name·datacenterId)
 * @param {object[]} i.datacenters  [{id,name}]
 * @param {object[]} [i.openFaults]  cvp_fault_state 열린 행(state fault/warn)
 * @param {object[]} [i.traffic]  trafficByDevice 결과 [{agent,cvpId,key,inBps,outBps,measured,unmeasured}]
 * @param {object[]} [i.events]  기간 안 CVP 이벤트(심각도·cvpId)
 * @param {boolean} [i.eventsTruncated]
 * @param {number} i.intervalMs  수집 주기
 * @param {number} [i.now]
 * @param {number} [i.highPct]
 */
export function buildCvpOverview(i = {}) {
  const now = Number(i.now) || Date.now();
  const { freshMs, staleMs } = freshnessBounds(i.intervalMs);
  const highPct = Number(i.highPct) > 0 ? Number(i.highPct) : 80;
  const corpOf = corpResolver(i.servers, i.datacenters);
  const cvpName = new Map((Array.isArray(i.servers) ? i.servers : []).filter((s) => s && typeof s === 'object').map((s) => [String(s.id), s.name || s.id]));
  const corps = new Map();
  const corpFor = (cvpId) => {
    const c = corpOf(cvpId);
    if (!corps.has(c.corpId)) corps.set(c.corpId, emptyCorp(c.corpId, c.corpName, c.missing));
    const row = corps.get(c.corpId);
    const nm = cvpName.get(String(cvpId));
    if (nm && !row.cvps.includes(nm)) row.cvps.push(nm);
    return row;
  };
  const devKey = (agent, cvpId, key) => `${agent ?? ''}\u0000${cvpId}\u0000${key}`;
  const nameOf = new Map();

  const totals = {
    devices: 0, health: { ok: 0, warn: 0, bad: 0, unknown: 0 }, unknownBy: { never: 0, stale: 0, 'not-streaming': 0, 'telemetry-failed': 0, unread: 0 }, partial: 0,
    streaming: 0, notStreaming: 0, streamingUnknown: 0,
    portsDown: 0, portsUnreadDevices: 0,
    bgpPeers: 0, bgpEstablished: 0, bgpDown: 0, bgpStateUnknown: 0, bgpUnreadDevices: 0,
    openFaults: 0, openFaultsFault: 0, openFaultsWarn: 0,
    swEolPassed: 0, lifecycleRead: 0,
  };
  const freshness = { fresh: 0, late: 0, stale: 0, never: 0, freshMs, staleMs };
  const models = new Map();
  const versions = new Map();

  for (const d of Array.isArray(i.devices) ? i.devices : []) {
    if (!d || typeof d !== 'object') continue;
    const corp = corpFor(d.cvpId);
    nameOf.set(devKey(d.agent, d.cvpId, d.key), d.hostname || d.key || '');
    const h = deviceHealth(d, { now, staleMs, highPct, intervalMs: i.intervalMs, partsEveryMs: i.partsEveryMs });
    const known = h.state !== 'unknown';
    totals.devices++; corp.devices++;
    totals.health[h.state]++; corp.health[h.state]++;
    if (h.state === 'unknown') totals.unknownBy[h.reasons[0]] = (totals.unknownBy[h.reasons[0]] || 0) + 1;
    if (h.partial && h.state !== 'unknown') { totals.partial++; corp.partial++; }
    if (d.streaming === true) { totals.streaming++; corp.streaming++; } else if (d.streaming === false) totals.notStreaming++; else totals.streamingUnknown++;
    // v2.680(감사 B-01): 확인 불가 장비의 남은 포트·BGP 값은 지금 값이 아니다 — 합산하지 않고 못 읽은 장비로 센다.
    if (known && d.ports && typeof d.ports === 'object') { const dn = Number(d.ports.down) || 0; totals.portsDown += dn; corp.portsDown += dn; } else totals.portsUnreadDevices++;
    if (known && Array.isArray(d.bgpPeers)) {
      const b = bgpSummary(d.bgpPeers);
      totals.bgpPeers += b.peers; totals.bgpEstablished += b.established; totals.bgpDown += b.down; totals.bgpStateUnknown += b.stateUnknown || 0;
      corp.bgpDown += b.down;
    } else totals.bgpUnreadDevices++;
    // 신선도
    const at = Number(d.collectedAt);
    if (!(at > 0)) freshness.never++;
    else if (now - at <= freshMs) freshness.fresh++;
    else if (now - at <= staleMs) freshness.late++;
    else freshness.stale++;
    // 모델·버전(장비가 보고한 문자열 그대로)
    const model = String(d.model || '').trim();
    const ver = String(d.eosVersion || '').trim();
    if (!models.has(model)) models.set(model, { model, count: 0, versions: new Map(), corps: new Set(), health: { ok: 0, warn: 0, bad: 0, unknown: 0 } });
    const m = models.get(model);
    m.count++; m.corps.add(corp.corpId); m.health[h.state]++;
    m.versions.set(ver, (m.versions.get(ver) || 0) + 1);
    if (!versions.has(ver)) versions.set(ver, { version: ver, count: 0, models: new Set() });
    const v = versions.get(ver); v.count++; v.models.add(model);
    // 수명주기(읽은 장비만)
    const lc = d.info && typeof d.info === 'object' ? d.info.lifecycle : null;
    if (lc && typeof lc === 'object') {
      totals.lifecycleRead++;
      const eos = Date.parse(lc.swEndOfSupport || '');
      if (Number.isFinite(eos) && eos < now) totals.swEolPassed++;
    }
  }

  // 열린 장애(중앙 판정 — 장비별 판정과 축이 다르다: 전이 기록이 열려 있는 것)
  for (const f of Array.isArray(i.openFaults) ? i.openFaults : []) {
    if (!f || typeof f !== 'object') continue;
    if (f.state !== 'fault' && f.state !== 'warn') continue;
    const corp = corpFor(f.cvpId);
    corp.openFaults++; totals.openFaults++;
    if (f.state === 'fault') totals.openFaultsFault++; else totals.openFaultsWarn++;
  }

  // 트래픽(마지막 수집의 순간값 합)
  const tTotals = { inBps: 0, outBps: 0, portsMeasured: 0, portsUnmeasured: 0, devicesMeasured: 0, devicesUnmeasured: 0 };
  const topBy = new Map();
  for (const t of Array.isArray(i.traffic) ? i.traffic : []) {
    if (!t || typeof t !== 'object') continue;
    const corp = corpFor(t.cvpId);
    const measured = Number(t.measured) || 0; const unmeasured = Number(t.unmeasured) || 0;
    const inB = Number(t.inBps) || 0; const outB = Number(t.outBps) || 0;
    corp.traffic.portsMeasured += measured; corp.traffic.portsUnmeasured += unmeasured;
    tTotals.portsMeasured += measured; tTotals.portsUnmeasured += unmeasured;
    if (measured > 0) {
      corp.traffic.inBps += inB; corp.traffic.outBps += outB; corp.traffic.devicesMeasured++;
      tTotals.inBps += inB; tTotals.outBps += outB; tTotals.devicesMeasured++;
      if (!topBy.has(corp.corpId)) topBy.set(corp.corpId, []);
      topBy.get(corp.corpId).push({ cvpId: t.cvpId, key: t.key, hostname: nameOf.get(devKey(t.agent, t.cvpId, t.key)) || t.key, inBps: inB, outBps: outB, ports: measured });
    } else if (unmeasured > 0) { corp.traffic.devicesUnmeasured++; tTotals.devicesUnmeasured++; }
  }
  for (const [cid, list] of topBy) {
    list.sort((a, b) => (b.inBps + b.outBps) - (a.inBps + a.outBps));
    corps.get(cid).traffic.top = list.slice(0, TOP_DEVICES_PER_CORP);
  }

  // 이벤트(기간 안 심각도별)
  const evTotals = { critical: 0, error: 0, warning: 0 };
  for (const e of Array.isArray(i.events) ? i.events : []) {
    if (!e || typeof e !== 'object' || !SEV_KEYS.has(e.severity)) continue;
    const corp = corpFor(e.cvpId);
    corp.events[e.severity]++; evTotals[e.severity]++;
  }

  const corpList = [...corps.values()].sort((a, b) => {
    if (a.corpId === UNASSIGNED_CORP) return 1;
    if (b.corpId === UNASSIGNED_CORP) return -1;
    return String(a.corpName).localeCompare(String(b.corpName), 'ko', { numeric: true, sensitivity: 'base' });
  });
  const modelList = [...models.values()].map((m) => ({
    model: m.model, count: m.count, corps: m.corps.size, health: m.health,
    versions: [...m.versions.entries()].map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
  })).sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  const versionList = [...versions.values()].map((v) => ({ version: v.version, count: v.count, models: [...v.models].sort() }))
    .sort((a, b) => b.count - a.count || a.version.localeCompare(b.version));

  return {
    generatedAt: now, intervalMs: Number(i.intervalMs) || null,
    totals, freshness, corps: corpList,
    models: modelList, versions: versionList,
    modelsSplit: modelList.filter((m) => m.versions.length > 1).length,
    traffic: tTotals, events: { ...evTotals, truncated: i.eventsTruncated === true },
  };
}
