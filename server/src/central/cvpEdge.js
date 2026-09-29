/**
 * central/cvpEdge.js — 엣지가 push 한 CloudVision(CVP) 수집 **상태** 보관 + 수신 정제(v2.608).
 *
 * 장비·포트·표본은 중앙 `cvp.db` 에 적재한다(routes/central.js `/cvp-data`). 여기는 엣지별 'CVP 를 마지막으로 읽은 결과'
 * (ok·collectedAt·usedPaths·missing·authStopped …)만 둔다. 파일: central-agent-cvp.json(central-agent-* 는 .gitignore 와일드카드).
 *
 * 수신 규약(v2.598~2.607 CENTRAL 규약 — 되돌리지 말 것):
 *  - 저장 키는 **인증된 agent**(라우트가 정한다 — 본문 agent 를 믿지 않는다).
 *  - **소유 검사**: 그 엣지에 위임된 CVP(serversForAgent) 의 id 만 받는다 — 남의 cvp_id·중앙 직접 등록 CVP 는 거절하고 개수를 밝힌다.
 *  - 원소는 **객체만 · 아는 필드만**(capStr·numOrNull 로 좁힌다). 상한을 넘으면 자르고 개수를 밝힌다(조용한 상한 금지).
 *  - 시각은 수신 시각으로 clamp(미래 시각이 '최신' 판정을 항상 이기지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { admitAgent, createDebouncedWriter, isPlainObj } from './edgeRecord.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { setCvpCollectBaseResolver, ackCvpCollect } from '../cvp/collectRequests.js';
import { CANDIDATES } from '../cvp/client.js';
import { DEVICE_MAX, PORT_MAX, PEER_MAX, PART_MAX, PART_STATES } from '../cvp/parse.js';
import { cmpVersion } from '../util/cmpVersion.js'; // v2.613 CONTRACT2613-04: 엣지 버전 게이트

const FILE = path.join(config.configDir, 'central-agent-cvp.json');

/**
 * v2.613(CONTRACT2613-04): CVP 위임 계약(`GET /cvp-config` pull + `POST /cvp-data` push)을 처음 갖는 엣지 버전 — 그 아래는
 * `agent/cvpConfigPull.js` 자체가 없어 **영원히** 보고하지 않는다. 형제 5종(partFaults 2.548 · edgeLog 2.549 · bmUsage 2.554 ·
 * tokenCheck 2.560 · iLO 2.610)이 전부 갖는 게이트인데 v2.608 이 빠뜨려, 구버전 엣지의 위임 CVP 가 '보고가 아직 없습니다(=기다리면
 * 된다)' 로 남았다(v2.554 규약 — 구버전/버전 미상/첫 보고 대기는 조치가 다르므로 각각 다르게 말한다).
 */
/** v2.646: 트랜시버 DOM·광신호 판정 — 아는 필드만(수치는 numOrNull, 문자열은 짧게). 없으면 빈 객체(구버전 엣지). */
const DOM_KEYS = ['rxPower', 'txPower', 'temperature', 'voltage', 'txBias'];
const OPTIC_STATES = new Set(['ok', 'warn', 'fault']);
function opticOf(p) {
  const out = {};
  if (p && p.dom && typeof p.dom === 'object') {
    const d = {};
    for (const k of DOM_KEYS) { const v = numOrNull(p.dom[k]); if (v != null) d[k] = v; }
    if (Object.keys(d).length) out.dom = d;
  }
  if (p && p.power && typeof p.power === 'object') {
    const pw = {};
    for (const k of ['inW', 'outW', 'capW']) { const v = numOrNull(p.power[k]); pw[k] = v != null && v >= 0 && v < 100_000 ? v : null; }
    if (pw.inW != null || pw.outW != null) out.power = pw;
  }
  if (p && p.media != null) { const m = sOrNull(p.media, 48); if (m) out.media = m; } // v2.649: 트랜시버 종류
  if (p && p.role === 'slot-power') out.role = 'slot-power';
  const sc = p && p.slotCheck && typeof p.slotCheck === 'object' ? p.slotCheck : null;
  if (sc) {
    const V = new Set(['card-running', 'card-present', 'slot-empty', 'unknown']);
    out.slotCheck = { slot: numOrNull(sc.slot), verdict: V.has(sc.verdict) ? sc.verdict : 'unknown', intfs: numOrNull(sc.intfs), up: numOrNull(sc.up), sampled: numOrNull(sc.sampled),
      sensors: numOrNull(sc.sensors), xcvrs: numOrNull(sc.xcvrs), slicesRead: sc.slicesRead === true, rawState: PART_STATES.includes(sc.rawState) ? sc.rawState : null };
  }
  const o = p && p.optic && typeof p.optic === 'object' ? p.optic : null;
  if (o) {
    out.optic = {
      intf: typeof o.intf === 'string' ? o.intf.slice(0, 64) : null, rx: numOrNull(o.rx), tx: numOrNull(o.tx),
      linked: o.linked === true, portKnown: o.portKnown === true, judged: o.judged === true,
      rxState: OPTIC_STATES.has(o.rxState) ? o.rxState : null, basis: o.basis === 'device' || o.basis === 'portal' ? o.basis : null,
      ...(numOrNull(o.warnDbm) != null ? { warnDbm: numOrNull(o.warnDbm) } : {}), ...(numOrNull(o.faultDbm) != null ? { faultDbm: numOrNull(o.faultDbm) } : {}),
    };
  }
  return out;
}

export const MIN_CVP_EDGE_VERSION = '2.608.0';
/** 보고가 없는 위임 CVP 의 분류 — 화면(`cvpText.serverState`)이 kind 별 문구를 갖는다(테스트가 1:1 대조). */
export const CVP_EDGE_KINDS = Object.freeze(['old-version', 'unknown-version', 'silent', 'waiting']);
/** 중앙이 이만큼(수집 주기 × N) 돌았는데도 보고가 없으면 '기다리면 된다' 가 아니다(v2.554 `edge-silent` 와 같은 배수). */
export const SILENT_AFTER_INTERVALS = 3;

/**
 * 엣지 버전 — `allCollectorStatus()` 는 수집 서버 **id** 로 키가 잡히고 값에 엣지가 스스로 보고한 `agent` 가 있다.
 * 등록부의 담당은 이름일 수도 id 일 수도 있어 **둘 다** 대조한다(routes/api/linkCheck.js 와 같은 판단 — 한쪽만 보면
 * 이름과 id 가 다른 법인에서 '구버전' 대신 '버전 미상' 이 된다). 못 찾으면 ''.
 */
export function edgeVersionOf(agent, status = {}) {
  const key = String(agent ?? '').trim().toLowerCase();
  if (!key) return '';
  for (const [id, st] of Object.entries(isPlainObj(status) ? status : {})) {
    const ver = String(st?.version ?? '').trim();
    if (!ver) continue;
    if (String(id).trim().toLowerCase() === key || String(st?.agent ?? '').trim().toLowerCase() === key) return ver;
  }
  return '';
}

/**
 * 보고가 없는 위임 CVP 의 분류(순수 — 테스트 고정). 보고가 있으면 부르지 않는다.
 *  · `unknown-version` — 엣지 버전을 모른다(export 를 한 번도 받지 못함 → 수집 서버 연결부터)
 *  · `old-version`     — `MIN_CVP_EDGE_VERSION` 미만(업그레이드해야 한다 — 기다려도 안 된다)
 *  · `silent`          — 버전은 충분한데 중앙이 주기 × SILENT_AFTER_INTERVALS 를 넘게 돌았는데도 보고가 없다(엣지 로그를 볼 것)
 *  · `waiting`         — 첫 보고 대기(기다리면 된다). ⚠ `sinceMs` 가 없으면(첫 주기 전) escalate 하지 않는다 — 없는 문제를 만들지 않는다.
 */
export function classifyCvpEdge({ edgeVersion = '', minVersion = MIN_CVP_EDGE_VERSION, sinceMs = null, intervalMs = 0, now = Date.now() } = {}) {
  const ver = String(edgeVersion ?? '').trim();
  if (!ver) return 'unknown-version';
  const c = cmpVersion(ver, minVersion);
  if (c != null && c < 0) return 'old-version';
  const since = numOrNull(sinceMs);
  const iv = numOrNull(intervalMs);
  if (since != null && iv != null && iv > 0 && now - since > iv * SILENT_AFTER_INTERVALS) return 'silent';
  return 'waiting';
}
export const ROWS_MAX = 100_000;
const KINDS = new Set([...Object.keys(CANDIDATES), 'budget', 'deadline', 'eventsCapped']);
const PART_KIND_SET = new Set(['psu', 'fan', 'temp', 'xcvr']);
const LINK = new Set(['up', 'down', 'nolink', 'unknown']); // v2.630 A2-02: 링크 없음(notconnect·notPresent) — down 이 아니다

let _map = null;
const writer = createDebouncedWriter(FILE, () => JSON.stringify(Object.fromEntries(load())), { name: 'cvpEdge' });

function load() {
  if (_map) return _map;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    _map = new Map(Object.entries(isPlainObj(raw) ? raw : {}).filter(([, v]) => isPlainObj(v)));
  } catch { _map = new Map(); } // 캐시 성격 — 다음 push 가 재구축
  return _map;
}

setCvpCollectBaseResolver((id) => {
  // v2.631 A6-2631-01: 기준선은 **엣지 시계 원본**(edgeCollectedAt) — ack 와 같은 시계여야 한다(v2.630 A4-02 의 CVP 판).
  for (const rec of load().values()) for (const s of rec?.servers || []) if (s?.cvpId === String(id)) return numOrNull(s.edgeCollectedAt ?? s.collectedAt);
  return null;
});

const s = (v, n) => capStr(v, n);
const sOrNull = (v, n) => (v == null || (typeof v !== 'string' && typeof v !== 'number') ? null : (capStr(String(v), n) || null));
const tsClamp = (v, now) => { const n = numOrNull(v); return n == null || n <= 0 ? null : Math.min(n, now); };
const tsOrig = (v) => { const n = numOrNull(v); return n == null || n <= 0 ? null : n; };
/** v2.631 A6-2631-01: routes/central.js EDGE_CLOCK_AHEAD_TOLERANCE_MS 와 같은 값(엣지 시계가 이보다 앞서면 차이를 밝힌다). */
const EDGE_CLOCK_AHEAD_TOLERANCE_MS = 5_000;
const strMap = (o, max, keyOk = () => true) => {
  if (!isPlainObj(o)) return {};
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 32)) if (keyOk(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = s(v, max);
  return out;
};
const numObj = (o, keys) => {
  if (!isPlainObj(o)) return null;
  const out = {};
  for (const k of keys) out[k] = numOrNull(o[k]);
  return out;
};

/** v2.640: 원문 표본 종류 상한 · head 상한(client.js SAMPLE_HEAD_CHARS 와 같은 값 — 변조 엣지가 큰 본문을 실어도 여기서 잘린다). */
export const SAMPLE_KINDS_MAX = 16;
export const SAMPLE_HEAD_MAX = 4096;
const BAD_KEY = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * 원문 표본(`samples`) 정제 — 종류 ≤ SAMPLE_KINDS_MAX · 아는 필드만(path·head·status·bytes·ok·at·reason·device).
 * 필드가 없거나 객체가 아니면 null(호출부가 필드 자체를 생략한다 — 구버전 엣지는 이 필드를 보내지 않는다).
 */
export function cleanSamples(v, now = Date.now()) {
  if (!isPlainObj(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (Object.keys(out).length >= SAMPLE_KINDS_MAX) break;
    const key = s(k, 32);
    if (!key || BAD_KEY.has(key) || !isPlainObj(x)) continue;
    out[key] = {
      path: s(x.path, 256), head: s(x.head, SAMPLE_HEAD_MAX), status: numOrNull(x.status), bytes: numOrNull(x.bytes), ok: x.ok === true, at: tsClamp(x.at, now),
      ...(x.reason == null ? {} : { reason: s(x.reason, 300) }), ...(x.device == null ? {} : { device: s(x.device, 128) }),
    };
  }
  return out;
}

/** CVP 상태 1건 정제(아는 필드만). */
export function cleanStatus(x, now = Date.now()) {
  const auth = isPlainObj(x.authStopped) ? { since: numOrNull(x.authStopped.since), at: numOrNull(x.authStopped.at), attempts: numOrNull(x.authStopped.attempts), reason: s(x.authStopped.reason, 300) } : null;
  const seen = {};
  if (isPlainObj(x.seenFields)) for (const [k, v] of Object.entries(x.seenFields).slice(0, 32)) if (KINDS.has(k) && Array.isArray(v)) seen[k] = v.filter((y) => typeof y === 'string').slice(0, 40).map((y) => s(y, 64));
  const samples = cleanSamples(x.samples, now);
  return {
    cvpId: s(x.cvpId, 128), name: s(x.name, 128), ok: x.ok === true, pending: x.pending === true,
    collectedAt: tsClamp(x.collectedAt, now),
    /*
     * v2.631 A6-2631-01: 엣지가 보낸 **원래 수집 시각**(엣지 시계). '지금 수집' 큐의 기준선·완료 판정은 이 값을 쓴다 — clamp 값은
     *   엣지 시계가 빠르면 매 push 가 '그 push 의 수신 시각' 이 되어 단조 증가하므로, 재수집 전 상태 push 가 요청을 완료로 만들었다.
     */
    edgeCollectedAt: tsOrig(x.collectedAt),
    ...(() => { const o = tsOrig(x.collectedAt); return o != null && o - now > EDGE_CLOCK_AHEAD_TOLERANCE_MS ? { edgeClockAheadMs: o - now } : {}; })(),
    lastAttemptAt: tsClamp(x.lastAttemptAt, now), durationMs: numOrNull(x.durationMs),
    deviceCount: numOrNull(x.deviceCount), error: x.error == null ? null : s(x.error, 1000), authStopped: auth,
    usedPaths: strMap(x.usedPaths, 256, (k) => KINDS.has(k)), missing: strMap(x.missing, 500, (k) => KINDS.has(k)), seenFields: seen,
    truncated: numObj(x.truncated, ['devices', 'ports', 'peers', 'notTried', 'aborted']), cvpVersion: s(x.cvpVersion, 64),
    partsRead: x.partsRead === true, dbUnavailable: x.dbUnavailable === true,
    ...(x.partsDueUnread === true ? { partsDueUnread: true, partsNotTried: numOrNull(x.partsNotTried) } : {}), // v2.612 RECENT2612-01: 시도 못 한 대수
    ...(isPlainObj(x.pruneHeld) ? { pruneHeld: { since: tsClamp(x.pruneHeld.since, now), untilMs: numOrNull(x.pruneHeld.untilMs), had: numOrNull(x.pruneHeld.had), reason: s(x.pruneHeld.reason, 300) } } : {}),
    ...(samples ? { samples } : {}), // v2.640: 원문 표본(구버전 엣지는 없다 — 필드 자체를 생략)
    ...(Array.isArray(x.probes) ? { probes: cleanProbes(x.probes, now) } : {}), // v2.641: 경로 탐색 표본
    ...(isPlainObj(x.events) ? { events: {
      bySeverity: Object.fromEntries([...SEVS].map((k) => [k, numOrNull(x.events.bySeverity?.[k])])), total: numOrNull(x.events.total),
      truncated: numOrNull(x.events.truncated), capped: x.events.capped === true, at: tsClamp(x.events.at, now) } } : x.events === null ? { events: null } : {}),
  };
}

/** v2.641: 경로 탐색 표본 정제 — PROBE_MAX(28)개 · head 1536자. */
export function cleanProbes(list, now = Date.now()) {
  return list.filter(isPlainObj).slice(0, 28).map((x) => ({
    path: s(x.path, 256), device: s(x.device, 128), status: numOrNull(x.status), at: tsClamp(x.at, now), ok: x.ok === true,
    bytes: numOrNull(x.bytes), head: s(x.head, 1536), empty: x.empty === true ? true : x.empty === false ? false : null,
    updates: numOrNull(x.updates), ptrs: numOrNull(x.ptrs), ptrKeys: Array.isArray(x.ptrKeys) ? x.ptrKeys.filter((k) => typeof k === 'string').slice(0, 12).map((k) => s(k, 128)) : [],
  }));
}

/** 장비 레코드 1건 정제 — 부품·BGP·포트 배열까지 아는 필드만. 반환 null = 버림. */
export function cleanDevice(x, now = Date.now(), cnt = { ports: 0 }) {
  const key = s(x.key, 128);
  if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
  const ts = tsClamp(x.ts, now);
  if (ts == null) return null;
  const listOf = (v, max, fn) => (Array.isArray(v) ? v.filter(isPlainObj).slice(0, max).map(fn) : null);
  const d = {
    key, ts, hostname: s(x.hostname, 256), model: s(x.model, 256), serial: s(x.serial, 256), mgmtIp: s(x.mgmtIp, 64), eosVersion: s(x.eosVersion, 64),
    streaming: x.streaming === true ? true : x.streaming === false ? false : null, telemetry: s(x.telemetry, 32),
    bgp: listOf(x.bgp, PEER_MAX, (p) => ({ peer: s(p.peer, 64), asn: s(p.asn, 16), vrf: s(p.vrf, 64), state: s(p.state, 32), prefixes: numOrNull(p.prefixes) })),
    ports: listOf(x.ports, PORT_MAX, (p) => ({
      // v2.649: 설명 null = '못 읽음'(중앙 DB 가 직전 값을 유지) — '' 로 바꾸면 설명을 지운 것이 된다. 세부 필드도 아는 것만·길이 상한.
      name: s(p.name, 64), desc: p.desc == null ? null : s(p.desc, 200), speedBps: numOrNull(p.speedBps),
      duplex: sOrNull(p.duplex, 48), fwdModel: sOrNull(p.fwdModel, 48), mac: sOrNull(p.mac, 32), mtu: numOrNull(p.mtu), operRaw: sOrNull(p.operRaw, 48),
      oper: LINK.has(p.oper) ? p.oper : 'unknown', admin: LINK.has(p.admin) ? p.admin : 'unknown', vlan: s(p.vlan, 32), lag: s(p.lag, 64),
      inBps: numOrNull(p.inBps), outBps: numOrNull(p.outBps), inUtil: numOrNull(p.inUtil), outUtil: numOrNull(p.outUtil), inErr: numOrNull(p.inErr), outErr: numOrNull(p.outErr),
    })),
  };
  if (Array.isArray(x.ports) && x.ports.length > PORT_MAX) cnt.ports += x.ports.length - PORT_MAX;
  // parts: 없음(undefined)=이번에 읽지 않음 · null=못 읽음 · 배열 — 셋을 구분해 옮긴다.
  if (Object.hasOwn(x, 'parts')) {
    d.parts = x.parts === null ? null : listOf(x.parts, PART_MAX, (p) => ({
      kind: PART_KIND_SET.has(p.kind) ? p.kind : 'psu', name: s(p.name, 128), state: PART_STATES.includes(p.state) ? p.state : 'unknown', detail: s(p.detail, 200),
      ...opticOf(p),
    }));
    d.partsAt = tsClamp(x.partsAt, now) ?? ts;
  }
  if (Array.isArray(x.partsMissingKinds)) d.partsMissingKinds = x.partsMissingKinds.filter((k) => typeof k === 'string').slice(0, 8).map((k) => s(k, 32));
  // v2.641: 장비 개요(아는 필드만)·CPU·메모리 최신값.
  const info = cleanInfo(x.info, now);
  if (info) d.info = info;
  const pct = (v) => { const n = numOrNull(v); return n == null || n < 0 || n > 100 ? null : n; };
  d.sysAt = tsClamp(x.sysAt, now); d.cpuPct = pct(x.cpuPct); d.memPct = pct(x.memPct); d.memTotal = numOrNull(x.memTotal);
  return d;
}

/** v2.641: 장비 개요 정제(cvp/db.js INFO_KEYS 와 같은 필드 — 문자열·불리언·시각·수명주기·버그 요약만). */
const EXPO = new Set(['none', 'low', 'high']);
export function cleanInfo(v, now = Date.now()) {
  if (!isPlainObj(v)) return null;
  const bool = (b) => (b === true ? true : b === false ? false : undefined);
  const out = {
    mac: s(v.mac, 32) || undefined, fqdn: s(v.fqdn, 256) || undefined, hwRevision: s(v.hwRevision, 64) || undefined,
    bootAt: numOrNull(v.bootAt) ?? undefined, status: s(v.status, 32) || undefined,
    complianceCode: s(v.complianceCode, 32) || undefined, complianceIndication: s(v.complianceIndication, 32) || undefined,
    container: s(v.container, 128) || undefined, ztpMode: bool(v.ztpMode), mlag: bool(v.mlag), internalVersion: s(v.internalVersion, 64) || undefined,
    portsEmpty: v.portsEmpty === true || undefined, bgpEmpty: v.bgpEmpty === true || undefined,
    readKinds: Array.isArray(v.readKinds) ? v.readKinds.filter((k) => ['enrich', 'lifecycle', 'bugs'].includes(k)) : undefined,
  };
  if (isPlainObj(v.lifecycle)) {
    const l = v.lifecycle;
    out.lifecycle = { swEolVersion: s(l.swEolVersion, 64), swEndOfSupport: numOrNull(l.swEndOfSupport), hwEndOfLife: numOrNull(l.hwEndOfLife),
      hwEndOfSale: numOrNull(l.hwEndOfSale), hwEndOfTacSupport: numOrNull(l.hwEndOfTacSupport), hwEndOfRma: numOrNull(l.hwEndOfRma) };
  }
  if (isPlainObj(v.bugs)) {
    const b = v.bugs;
    out.bugs = { bugCount: numOrNull(b.bugCount), cveCount: numOrNull(b.cveCount), highestBug: EXPO.has(b.highestBug) ? b.highestBug : null,
      highestCve: EXPO.has(b.highestCve) ? b.highestCve : null, acknowledged: b.acknowledged === true };
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}

const SEVS = new Set(['critical', 'error', 'warning', 'info', 'debug', 'unknown']);
export const EDGE_EVENTS_MAX = 2000;
/** v2.641 ④: 엣지 이벤트 1건 정제. 반환 null = 버림. */
export function cleanEvent(e, now = Date.now()) {
  if (!isPlainObj(e)) return null;
  const key = s(e.key, 256); const ts = numOrNull(e.ts);
  if (!key || ts == null || ts > now + 86_400_000) return null;
  return { key, ts, severity: SEVS.has(e.severity) ? e.severity : 'unknown', title: s(e.title, 256), desc: s(e.desc, 1000), type: s(e.type, 128),
    devices: Array.isArray(e.devices) ? e.devices.filter((d) => typeof d === 'string').slice(0, 32).map((d) => s(d, 128)) : [],
    ack: e.ack === true, updatedAt: numOrNull(e.updatedAt), deleted: e.deleted === true };
}

/**
 * push 본문 정제. owned = 그 엣지에 위임된 CVP id 집합.
 * @returns {{ servers:object[], devicesByCvp:Map<string,object[]>, rows:any[][], touch:any[][], deviceKeys:object|null, devicesUnavailable:boolean, dropped:object }}
 */
export function sanitizeCvpBody(body, owned, now = Date.now()) {
  const b = isPlainObj(body) ? body : {};
  const dropped = { notObject: 0, notOwned: 0, badId: 0, badRow: 0, overCount: 0, portsCapped: 0 };
  const own = (id) => typeof id === 'string' && owned.has(id);
  const servers = [];
  for (const x of Array.isArray(b.servers) ? b.servers.slice(0, 256) : []) {
    if (!isPlainObj(x)) { dropped.notObject++; continue; }
    if (!own(x.cvpId)) { dropped.notOwned++; continue; }
    servers.push(cleanStatus(x, now));
  }
  const devicesByCvp = new Map();
  let nDev = 0;
  const cnt = { ports: 0 };
  for (const x of Array.isArray(b.devices) ? b.devices : []) {
    if (!isPlainObj(x)) { dropped.notObject++; continue; }
    if (!own(x.cvpId)) { dropped.notOwned++; continue; }
    if (nDev >= DEVICE_MAX) { dropped.overCount++; continue; }
    const d = cleanDevice(x, now, cnt);
    if (!d) { dropped.badId++; continue; }
    if (!devicesByCvp.has(x.cvpId)) devicesByCvp.set(x.cvpId, []);
    devicesByCvp.get(x.cvpId).push(d);
    nDev++;
  }
  dropped.portsCapped = cnt.ports;
  const rows = [];
  const rin = Array.isArray(b.rows) ? b.rows : [];
  if (rin.length > ROWS_MAX) dropped.overCount += rin.length - ROWS_MAX;
  for (const r of rin.slice(0, ROWS_MAX)) {
    if (!Array.isArray(r) || r.length < 10) { dropped.badRow++; continue; }
    if (!own(r[0])) { dropped.notOwned++; continue; }
    const key = s(r[1], 128); const port = s(r[2], 64); const ts = tsClamp(r[3], now);
    if (!key || !port || ts == null) { dropped.badRow++; continue; }
    rows.push([r[0], key, port, ts, numOrNull(r[4]), numOrNull(r[5]), numOrNull(r[6]), numOrNull(r[7]), numOrNull(r[8]), numOrNull(r[9])]);
  }
  const touch = [];
  for (const t of Array.isArray(b.touch) ? b.touch.slice(0, 20_000) : []) {
    if (!Array.isArray(t) || t.length < 3) { dropped.badRow++; continue; }
    if (!own(t[0])) { dropped.notOwned++; continue; }
    const key = s(t[1], 128); const ts = tsClamp(t[2], now);
    if (!key || ts == null) { dropped.badRow++; continue; }
    touch.push([t[0], key, ts]);
  }
  let deviceKeys = null;
  if (isPlainObj(b.deviceKeys)) {
    deviceKeys = {};
    for (const [cvpId, keys] of Object.entries(b.deviceKeys).slice(0, 256)) {
      if (!owned.has(cvpId)) { dropped.notOwned++; continue; }
      if (!Array.isArray(keys)) continue;
      deviceKeys[cvpId] = keys.filter((k) => typeof k === 'string' && k).slice(0, DEVICE_MAX).map((k) => s(k, 128));
    }
  }
  // v2.641 ③: CPU·메모리 최신 표본 [cvpId, key, ts, cpu, mem, memTotal]
  const devSamples = [];
  for (const r of Array.isArray(b.devSamples) ? b.devSamples.slice(0, DEVICE_MAX * 4) : []) {
    if (!Array.isArray(r) || r.length < 5) { dropped.badRow++; continue; }
    if (!own(r[0])) { dropped.notOwned++; continue; }
    const key = s(r[1], 128); const ts = tsClamp(r[2], now);
    if (!key || ts == null) { dropped.badRow++; continue; }
    devSamples.push([r[0], key, ts, numOrNull(r[3]), numOrNull(r[4]), numOrNull(r[5])]);
  }
  // v2.641 ④: 이벤트 { cvpId: [event…] } — CVP 당 EDGE_EVENTS_MAX 건.
  const eventsByCvp = new Map();
  if (isPlainObj(b.events)) {
    for (const [cvpId, list] of Object.entries(b.events).slice(0, 256)) {
      if (!owned.has(cvpId)) { dropped.notOwned++; continue; }
      if (!Array.isArray(list)) continue;
      const out = [];
      for (const e of list.slice(0, EDGE_EVENTS_MAX)) { const c = cleanEvent(e, now); if (c) out.push(c); else dropped.badRow++; }
      if (list.length > EDGE_EVENTS_MAX) dropped.overCount += list.length - EDGE_EVENTS_MAX;
      eventsByCvp.set(cvpId, out);
    }
  }
  return { servers, devicesByCvp, rows, touch, deviceKeys, devicesUnavailable: b.devicesUnavailable === true, dropped, devSamples, eventsByCvp };
}

/**
 * 청크 0 — 그 엣지의 상태를 통째로 교체. 반환 { ok, refused?, evicted? }.
 * agent 는 저장 키(라우트가 util/agentKey canonicalAgent 로 정한 것). v2.611(CEN2611-02): 대소문자만 다른 옛 키의 보관분은 지운다 —
 *   남겨 두면 같은 엣지가 두 행이 되고 조회(대소문자 무시)가 옛 정상 행을 골라 현재 오류를 가렸다(재현).
 */
export function saveEdgeCvpStatus(agent, servers, { devicesUnavailable = false, now = Date.now() } = {}) {
  const m = load();
  const lo = String(agent ?? '').trim().toLowerCase();
  let variants = 0;
  for (const k of [...m.keys()]) if (k !== agent && String(k).trim().toLowerCase() === lo) { m.delete(k); variants++; }
  const adm = admitAgent(m, agent);
  if (!adm.ok) { console.warn(`[central] cvp-data: 엣지 수 상한 — 새 이름 '${String(agent).slice(0, 64)}' 거절`); return { ok: false, refused: true }; }
  if (adm.evicted) console.warn(`[central] cvp-data: 엣지 수 상한 — 오래 조용한 '${adm.evicted}' 보관분을 내렸다`);
  m.set(agent, { at: now, servers, devicesUnavailable });
  writer.save();
  for (const st of servers) { const at = st.edgeCollectedAt ?? st.collectedAt; if (at != null) ackCvpCollect(st.cvpId, at); } // v2.631 A6-2631-01: 엣지 시계 원본
  return { ok: true, ...(adm.evicted ? { evicted: adm.evicted } : {}), ...(variants ? { variantsRemoved: variants } : {}) };
}

/**
 * v2.612 CEN2612-01: 위임된 CVP 가 하나도 없는 엣지의 보관분을 지운다(대소문자 변형 포함). 반환 = 지운 키 수.
 *   예전에는 위임 0건인 엣지도 상태를 저장해 EDGE_MAX_AGENTS 칸을 채웠고(CVP 를 쓰지 않는 엣지 28곳이 전부 들어온다),
 *   위임에서 빠진 엣지의 옛 상태가 화면에 남았다.
 */
export function dropEdgeCvpStatus(agent) {
  const m = load();
  const lo = String(agent ?? '').trim().toLowerCase();
  let n = 0;
  for (const k of [...m.keys()]) if (String(k).trim().toLowerCase() === lo) { m.delete(k); n++; }
  if (n) writer.save();
  return n;
}

/** 전 엣지 상태(평탄) — { agent, pushedAt, ...status }. */
export function edgeCvpStatuses() {
  const out = [];
  for (const [agent, v] of load()) for (const st of v?.servers || []) out.push({ ...st, agent, pushedAt: v.at });
  return out;
}
/** 엣지별 요약 — { agent, lastPushAt, ok, error, servers }. */
export function edgeCvpSummary() {
  return [...load()].map(([agent, v]) => {
    const list = Array.isArray(v?.servers) ? v.servers : [];
    const bad = list.filter((x) => !x.ok && !x.pending);
    return { agent, lastPushAt: v?.at || null, ok: bad.length === 0, error: bad.length ? `${bad.length}대 수집 실패: ${bad[0].error || '사유 미상'}` : null, servers: list.length, devicesUnavailable: !!v?.devicesUnavailable };
  });
}
export function _resetForTest() { _map = null; }
