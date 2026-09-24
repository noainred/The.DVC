/**
 * central/sanSwitchEdge.js — 엣지들이 push 한 SAN 스위치 스냅샷의 중앙 보관(v2.410).
 * agent → { at, devices:[스냅샷] }. 파일: central-agent-sanswitch.json
 * (central-agent-* 는 .gitignore 와일드카드로 이미 커밋 차단).
 * 저장 키는 라우트가 req.centralAuth.agent 로 강제한다(agent 바인딩 — server/CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeEdgeDevices, admitAgent, createDebouncedWriter, isPlainObj, scalarizeFields } from './edgeRecord.js'; // v2.599 CEN-2599-03·04·05
import { numOrNull } from '../util/numOrNull.js';

/** v2.607(CEN2607-02): SAN 스냅샷 최상위의 추가 표시 필드(목록 표가 그대로 그린다). */
export const SAN_DISPLAY_KEYS = Object.freeze(['fabricOs', 'domainId', 'switchState', 'switchName']);
/** v2.607(CEN2607-02): SAN extra 의 표시 글자 필드. */
export const SAN_EXTRA_DISPLAY_KEYS = Object.freeze(['switchType', 'chassisPartNumber', 'chassisId', 'healthState', 'versionRaw', 'note']);

/**
 * v2.606(감사 CEN2606-03 — 재현): 점검·조닝이 순회하는 중첩 배열 — `ports.list` · `extra.sensors.list` · `zoning.zones` — 을
 *   **객체 원소 배열**로 좁힌다. 예전에는 `ports.list:[null]`·`'abc'`·`extra.sensors.list:'x'` 가 그대로 저장돼
 *   checkDevice·checkPorts 가 던졌고 전체 점검(healthcheck-all)이 500 이었다. 새 객체를 돌려주고 좁힌 개수를 센다.
 *   ⚠ 배열 길이는 줄이지 않는다(엣지 slim·중앙 trimZoningToFit 의 상한이 이미 있다) — 모양만 본다.
 */
export function narrowSanSnapshot(d) {
  if (!isPlainObj(d)) return { snap: d, narrowed: 0 };
  let narrowed = 0;
  const objs = (v) => {
    if (!Array.isArray(v)) { narrowed += 1; return []; }
    const out = v.filter(isPlainObj);
    narrowed += v.length - out.length;
    return out;
  };
  const o = { ...d };
  narrowed += scalarizeFields(o, SAN_DISPLAY_KEYS); // v2.607 CEN2607-02
  if (isPlainObj(o.ports) && Object.hasOwn(o.ports, 'list') && o.ports.list != null) o.ports = { ...o.ports, list: objs(o.ports.list) };
  if (o.extra != null && !isPlainObj(o.extra)) { o.extra = null; narrowed += 1; }
  if (isPlainObj(o.extra) && o.extra.sensors != null) {
    if (!isPlainObj(o.extra.sensors)) { o.extra = { ...o.extra, sensors: null }; narrowed += 1; }
    else if (Object.hasOwn(o.extra.sensors, 'list') && o.extra.sensors.list != null) o.extra = { ...o.extra, sensors: { ...o.extra.sensors, list: objs(o.extra.sensors.list) } };
    // parsed 인데 목록이 없으면 판정이 s.list 를 순회한다 — 빈 배열로 둔다(개수는 counts 가 말한다).
    else if (o.extra.sensors.parsed) o.extra = { ...o.extra, sensors: { ...o.extra.sensors, list: [] } };
  }
  if (o.zoning != null && !isPlainObj(o.zoning)) { o.zoning = null; narrowed += 1; }
  // zones 는 v2.510 까지 숫자(0)였다 — 구버전 엣지의 숫자는 '결함' 으로 세지 않고 빈 배열로만 바꾼다.
  if (isPlainObj(o.zoning) && o.zoning.zones != null) {
    if (typeof o.zoning.zones === 'number') o.zoning = { ...o.zoning, zones: [] };
    else o.zoning = { ...o.zoning, zones: objs(o.zoning.zones) };
  }
  // v2.607(감사 CEN2607-05): 점검·조닝이 순회하는 **나머지** 중첩 배열 — 조닝 멤버·포트 attached(글자 배열),
  //   extra.{raslog.list, isl.list, lsan.zones, fabricMembers.switches, bottleneck.ports, trunk.groups}(객체 배열).
  //   예전에는 `isl.list:'x'`·`zones:[{members:{a:1}}]` 가 그대로 저장돼 그 장비의 점검·조닝 라우트가 500 이었다.
  const strs = (v) => {
    if (!Array.isArray(v)) { narrowed += 1; return []; }
    const out = v.filter((x) => typeof x === 'string');
    narrowed += v.length - out.length;
    return out;
  };
  if (isPlainObj(o.zoning) && Array.isArray(o.zoning.zones)) {
    o.zoning = { ...o.zoning, zones: o.zoning.zones.map((z) => (Object.hasOwn(z, 'members') && z.members != null && !(Array.isArray(z.members) && z.members.every((m) => typeof m === 'string')) ? { ...z, members: strs(z.members) } : z)) };
  }
  if (isPlainObj(o.ports) && Array.isArray(o.ports.list)) {
    o.ports = { ...o.ports, list: o.ports.list.map((p) => (Object.hasOwn(p, 'attached') && p.attached != null && !(Array.isArray(p.attached) && p.attached.every((w) => typeof w === 'string')) ? { ...p, attached: strs(p.attached) } : p)) };
  }
  if (isPlainObj(o.extra)) {
    const ex = { ...o.extra };
    let touched = false;
    const sub = (key, listKey, inner) => {
      if (ex[key] == null) return;
      if (!isPlainObj(ex[key])) { ex[key] = null; narrowed += 1; touched = true; return; }
      const cur = ex[key][listKey];
      // parsed 인데 목록이 없으면 판정이 목록을 순회한다 — 빈 배열로 둔다.
      if (cur == null && !ex[key].parsed) return;
      let list = cur == null ? [] : objs(cur);
      if (inner) list = list.map(inner);
      ex[key] = { ...ex[key], [listKey]: list }; touched = true;
    };
    const withMembers = (x) => (Array.isArray(x.members) ? { ...x, members: x.members.filter((m) => m != null) } : { ...x, members: [] });
    sub('raslog', 'list');
    sub('isl', 'list');
    sub('lsan', 'zones', withMembers);
    sub('fabricMembers', 'switches');
    sub('bottleneck', 'ports');
    sub('trunk', 'groups', (g) => (Array.isArray(g.members) ? { ...g, members: g.members.filter(isPlainObj) } : { ...g, members: [] }));
    if (touched) o.extra = ex;
  }
  // v2.607(감사 CEN2607-01): health — 시리얼 조회가 psuDetail 을 순회하고 점검이 psus/fans 의 ok·total 을 숫자로 읽는다.
  //   예전에는 `health.psuDetail:[null]` 하나로 시리얼 조회의 SAN 구획 전체(전 엣지)가 rows 0 이 됐다.
  if (o.health != null && !isPlainObj(o.health)) { o.health = null; narrowed += 1; }
  if (isPlainObj(o.health)) {
    const h = { ...o.health };
    if (h.psuDetail != null) h.psuDetail = objs(h.psuDetail);
    for (const k of ['psus', 'fans']) {
      if (h[k] == null) continue;
      if (!isPlainObj(h[k])) { h[k] = null; narrowed += 1; continue; }
      const f = { ...h[k] };
      for (const n of ['ok', 'total']) if (Object.hasOwn(f, n) && f[n] != null) f[n] = numOrNull(f[n]);
      h[k] = f;
    }
    narrowed += scalarizeFields(h, ['status']);
    o.health = h;
  }
  // v2.607(감사 CEN2607-02): 화면이 글자로 그리는 extra 필드.
  if (isPlainObj(o.extra)) { const ex = { ...o.extra }; narrowed += scalarizeFields(ex, SAN_EXTRA_DISPLAY_KEYS, 4096); o.extra = ex; }
  return { snap: o, narrowed };
}
import { recordActivity } from '../sanswitch/activityLog.js';
import { ackCollect, setCollectBaseResolver } from '../sanswitch/collectRequests.js';

const FILE = path.join(config.configDir, 'central-agent-sanswitch.json');
const MAX_DEVICES_PER_AGENT = 300;
let _map = null;
// v2.516 엣지 push 로그 중복 제거 — 엣지는 주기마다 전 장비를 다시 보내므로, 같은 collectedAt 을
// 매번 남기면 한 번의 수집이 여러 건으로 기록돼 로그가 거짓으로 부풀고 상한을 빨리 소진한다
// (central/storageEdge.js 의 _lastRec 와 같은 규약). deviceId → 마지막 기록한 collectedAt.
const _lastRec = new Map();

// v2.599(CEN-2599-04): push 마다 전체 맵을 동기로 쓰던 것 → 디바운스 비동기 + 종료 시 동기 flush.
const writer = createDebouncedWriter(FILE, () => JSON.stringify(Object.fromEntries(load())), { name: 'sanSwitchEdge' });

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 다음 push 가 재구축
  // v2.606(CEN2606-03): 수정 전에 저장된 원소도 같은 정제를 거친다.
  for (const [k, v] of _map) if (isPlainObj(v) && Array.isArray(v.devices)) _map.set(k, { ...v, devices: v.devices.map((x) => narrowSanSnapshot(x).snap) });
  return _map;
}

// v2.591: '지금 수집' 요청 큐의 기준선 — 보관 중인 엣지 스냅샷의 수집 시각(엣지 시계 값).
setCollectBaseResolver((id) => {
  for (const rec of load().values()) for (const d of rec?.devices || []) if (String(d?.deviceId) === String(id)) return Number(d.collectedAt) || null;
  return null;
});

/**
 * @param info (선택) 수신 정리 결과 — `dropped`(사유별 뺀 개수)·`coerced`·`refused`·`evicted`.
 *   ⚠ v2.599(CEN-2599-03·05): 객체가 아니거나 deviceId 가 식별자가 아닌 원소는 빼고, 표시 필드의 객체 값은 null 로.
 */
export function saveEdgeSanSwitch(agent, devices, { chunk = 0, chunks = 1, info = {} } = {}) {
  const { devices: clean, dropped, coerced, trimmed } = sanitizeEdgeDevices(devices, { idKey: 'deviceId', max: MAX_DEVICES_PER_AGENT });
  info.dropped = dropped; info.coerced = coerced;
  // v2.600(RECENT2600-02): 장비 크기 상한을 넘어 **조닝을 잘라 받은** 장비 수 — 버린 것(dropped)과 구분해 밝힌다.
  if (trimmed) { info.trimmed = trimmed; console.warn(`[central] sanswitch-data: agent=${String(agent).slice(0, 64)} 장비 ${trimmed}대의 조닝이 중앙 수신 상한을 넘어 일부만 저장했습니다`); }
  const adm = admitAgent(load(), agent);
  if (!adm.ok) { info.refused = true; console.warn(`[central] sanswitch-data: 엣지 수 상한 — 새 이름 '${String(agent).slice(0, 64)}' 거절(최근 보고한 엣지를 밀어내지 않는다)`); return 0; }
  if (adm.evicted) { info.evicted = adm.evicted; console.warn(`[central] sanswitch-data: 엣지 수 상한 — 오래 조용한 '${adm.evicted}' 보관분을 내렸다`); }
  let narrowed = 0;
  let list = clean.map((d0) => { const { snap: d, narrowed: n } = narrowSanSnapshot(d0); narrowed += n; return { ...d, agent }; }); // 엣지가 뭐라 보냈든 인증된 agent 로 덮는다(출처 위조 차단)
  if (narrowed) info.narrowed = narrowed;
  // 청크 병합(v2.417): 첫 청크(0)는 교체, 이후 청크는 deviceId 로 upsert — 한 주기의 push 가 여러
  // 요청으로 나뉘어도(1MB 한도) 중앙 목록이 '마지막 청크만' 으로 줄어들지 않게.
  if (chunk > 0 && chunks > 1) {
    const prev = load().get(agent)?.devices || [];
    const ids = new Set(list.map((d) => d.deviceId));
    // ⚠ v2.599(CEN-2599-04): 청크 병합은 엣지 하나의 보관분을 요청 한도 너머로 키울 수 있다 — 합친 뒤에도 합계 크기 상한을 다시 건다.
    const merged = sanitizeEdgeDevices([...prev.filter((d) => !ids.has(d.deviceId)), ...list], { idKey: 'deviceId', max: MAX_DEVICES_PER_AGENT });
    for (const [k, n] of Object.entries(merged.dropped)) dropped[k] += n;
    list = merged.devices;
  }
  load().set(agent, { at: Date.now(), devices: list });
  writer.save();
  // 작업 로그(v2.516) — 중앙 화면의 '수집 작업' 구획이 위임 장비도 보여주려면 push 수신 시
  // 남겨야 한다(엣지의 로컬 로그는 중앙에서 볼 수 없다). 같은 collectedAt 재push 는 건너뛴다.
  // ⚠ 엣지는 문제 포트만 올리므로(push.js slimSnapshot) 포트 요약 수치는 전체 기준을 쓴다.
  for (const dv of list) {
    const ca = Number(dv.collectedAt) || 0;
    ackCollect(dv.deviceId, ca || null); // v2.590 P16: 위임 '지금 수집' 요청의 완료 확인
    if (ca && _lastRec.get(dv.deviceId) === ca) continue;
    if (ca) _lastRec.set(dv.deviceId, ca);
    try {
      // ⚠ **실패 스냅샷의 포트 수치는 null 이다** — `emptySnapshot` 이 ports 를 0 으로 초기화하므로
      //   그대로 실으면 화면에 '0/0 · 0%' 가 찍혀 **'포트 0개' 라는 사실과 다른 표시**가 된다
      //   (v2.516 실측으로 발견: 도달 불가 장비의 로그가 portsOnline:0 이었다).
      //   '수집 못 함' 과 '진짜 0' 은 구분해야 한다(types.js 정직 표기 규칙).
      const pt = dv.ok ? (dv.ports || {}) : {};
      recordActivity({
        deviceId: dv.deviceId, name: dv.name || dv.deviceId, host: dv.host || '', source: agent,
        ok: !!dv.ok,
        portsOnline: pt.online ?? null, portsLicensed: pt.licensed ?? null,
        portsFree: pt.free ?? null, usedPct: pt.usedPct ?? null,
        durationMs: Number.isFinite(dv.durationMs) ? dv.durationMs : null,
        error: dv.ok ? null : (dv.error || null), at: ca || Date.now(),
      });
    } catch { /* 로그 실패가 push 수신을 막지 않게 */ }
  }
  // v2.606(감사 TIM2606-05): 중복 제거 Map 은 **보관 중인 장비 id 만** 남긴다 — 예전에는 set 만 하고 지우지 않아 매 push 새
  //   deviceId 를 보내는 엣지(재등록 반복·오동작·공유 토큰)가 프로세스 수명 내내 키를 쌓았다. 빠진 장비의 키만 지우므로
  //   dedup 계약(같은 collectedAt 재push 는 기록하지 않는다)은 그대로다.
  // ⚠ v2.607(감사 RECENT2607-01 — 재현): 정리는 **마지막 청크(또는 단일 청크)에서만** 한다. 청크 0 은 목록을 교체하므로
  //   그 시점에는 아직 도착하지 않은 청크 1+ 장비가 '보관 중이 아니다' 로 보여 키가 지워졌고, 같은 collectedAt 인데도
  //   매 주기 작업 로그가 다시 기록됐다(v2.516 이 막으려던 현상).
  const lastChunk = !(Number(chunks) > 1) || Number(chunk) >= Number(chunks) - 1;
  if (lastChunk) {
    const live = new Set();
    for (const v of load().values()) for (const d of v?.devices || []) if (d?.deviceId) live.add(d.deviceId);
    for (const k of _lastRec.keys()) if (!live.has(k)) _lastRec.delete(k);
  }
  return list.length;
}
/** 테스트·진단용 — 중복 제거 Map 크기. */
export function _lastRecSize() { return _lastRec.size; }

/** 전 엣지 스냅샷 평탄 목록(중앙 화면이 로컬 수집분과 합쳐 쓴다). */
export function edgeSanSwitchSnapshots() {
  const out = [];
  const now = Date.now();
  // v2.583(검증 에이전트 권고): 보고 나이(staleMs)를 싣는다 — storageEdge 와 같은 규약(숨기지 않고 표시).
  for (const [agent, v] of load()) for (const d of v.devices || []) out.push({ ...d, agent, pushedAt: v.at, staleMs: v.at ? now - v.at : null });
  return out;
}
/** 등록부에서 빠진 장비(orphan)의 엣지 보관분을 목록에서 내리는 기준 — 기본 7일(보고가 끊긴 엣지의 유령 스위치). */
export const ORPHAN_TTL_MS = Math.max(3_600_000, Number(process.env.CENTRAL_SANSW_ORPHAN_TTL_MS) || 7 * 86_400_000);
export function _resetForTest() { _map = null; _lastRec.clear(); }
