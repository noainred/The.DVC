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
const KINDS = new Set([...Object.keys(CANDIDATES), 'budget', 'deadline']);
const PART_KIND_SET = new Set(['psu', 'fan', 'temp', 'xcvr']);
const LINK = new Set(['up', 'down', 'unknown']);

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
  for (const rec of load().values()) for (const s of rec?.servers || []) if (s?.cvpId === String(id)) return numOrNull(s.collectedAt);
  return null;
});

const s = (v, n) => capStr(v, n);
const tsClamp = (v, now) => { const n = numOrNull(v); return n == null || n <= 0 ? null : Math.min(n, now); };
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

/** CVP 상태 1건 정제(아는 필드만). */
export function cleanStatus(x, now = Date.now()) {
  const auth = isPlainObj(x.authStopped) ? { since: numOrNull(x.authStopped.since), at: numOrNull(x.authStopped.at), attempts: numOrNull(x.authStopped.attempts), reason: s(x.authStopped.reason, 300) } : null;
  const seen = {};
  if (isPlainObj(x.seenFields)) for (const [k, v] of Object.entries(x.seenFields).slice(0, 32)) if (KINDS.has(k) && Array.isArray(v)) seen[k] = v.filter((y) => typeof y === 'string').slice(0, 40).map((y) => s(y, 64));
  return {
    cvpId: s(x.cvpId, 128), name: s(x.name, 128), ok: x.ok === true, pending: x.pending === true,
    collectedAt: tsClamp(x.collectedAt, now), lastAttemptAt: tsClamp(x.lastAttemptAt, now), durationMs: numOrNull(x.durationMs),
    deviceCount: numOrNull(x.deviceCount), error: x.error == null ? null : s(x.error, 1000), authStopped: auth,
    usedPaths: strMap(x.usedPaths, 256, (k) => KINDS.has(k)), missing: strMap(x.missing, 500, (k) => KINDS.has(k)), seenFields: seen,
    truncated: numObj(x.truncated, ['devices', 'ports', 'peers', 'notTried', 'aborted']), cvpVersion: s(x.cvpVersion, 64),
    partsRead: x.partsRead === true, dbUnavailable: x.dbUnavailable === true,
    ...(x.partsDueUnread === true ? { partsDueUnread: true, partsNotTried: numOrNull(x.partsNotTried) } : {}), // v2.612 RECENT2612-01: 시도 못 한 대수
    ...(isPlainObj(x.pruneHeld) ? { pruneHeld: { since: tsClamp(x.pruneHeld.since, now), untilMs: numOrNull(x.pruneHeld.untilMs), had: numOrNull(x.pruneHeld.had), reason: s(x.pruneHeld.reason, 300) } } : {}),
  };
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
      name: s(p.name, 64), desc: s(p.desc, 200), speedBps: numOrNull(p.speedBps),
      oper: LINK.has(p.oper) ? p.oper : 'unknown', admin: LINK.has(p.admin) ? p.admin : 'unknown', vlan: s(p.vlan, 32), lag: s(p.lag, 64),
      inBps: numOrNull(p.inBps), outBps: numOrNull(p.outBps), inUtil: numOrNull(p.inUtil), outUtil: numOrNull(p.outUtil), inErr: numOrNull(p.inErr), outErr: numOrNull(p.outErr),
    })),
  };
  if (Array.isArray(x.ports) && x.ports.length > PORT_MAX) cnt.ports += x.ports.length - PORT_MAX;
  // parts: 없음(undefined)=이번에 읽지 않음 · null=못 읽음 · 배열 — 셋을 구분해 옮긴다.
  if (Object.hasOwn(x, 'parts')) {
    d.parts = x.parts === null ? null : listOf(x.parts, PART_MAX, (p) => ({
      kind: PART_KIND_SET.has(p.kind) ? p.kind : 'psu', name: s(p.name, 128), state: PART_STATES.includes(p.state) ? p.state : 'unknown', detail: s(p.detail, 200),
    }));
    d.partsAt = tsClamp(x.partsAt, now) ?? ts;
  }
  if (Array.isArray(x.partsMissingKinds)) d.partsMissingKinds = x.partsMissingKinds.filter((k) => typeof k === 'string').slice(0, 8).map((k) => s(k, 32));
  return d;
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
  return { servers, devicesByCvp, rows, touch, deviceKeys, devicesUnavailable: b.devicesUnavailable === true, dropped };
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
  for (const st of servers) if (st.collectedAt != null) ackCvpCollect(st.cvpId, st.collectedAt);
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
