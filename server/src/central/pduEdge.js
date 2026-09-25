/**
 * central/pduEdge.js — 엣지가 push 한 PDU 스냅샷의 중앙 보관소(v2.424).
 *
 * 사용자 요구 '스토리지처럼 원격지의 센서를 수집' — 중앙은 원격 법인의 PDU 관리망에 직접 닿지
 * 못하므로, 그 사이트의 엣지 포탈이 수집해 중앙으로 올린다(아웃바운드 push 축 재사용).
 *
 * central/storageEdge.js 와 같은 구조. 메모리 + 디스크(CONFIG_DIR/central-pdu.json) 보관이며,
 * 자격증명은 담기지 않는다(스냅샷은 측정값만 — 엣지가 이미 로그인해서 읽은 결과).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { preserveCorrupt } from '../util/atomicWrite.js';
import { ackCollect, setCollectBaseResolver } from '../pdu/collectRequests.js';
import { sanitizeEdgeDevices, admitAgent, createDebouncedWriter, isPlainObj } from './edgeRecord.js'; // v2.599 CEN-2599-03·04·05
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

/**
 * v2.606(감사 CEN2606-02 — 재현): PDU 전용 중첩 배열(units·sensors·banks·phases)을 좁힌다.
 *   sanitizeEdgeDevices 의 NUMERIC_PATHS 는 capacity·ports·nodes 만 본다 — 그래서 `units:[{powerW:'1200'},{powerW:'800'}]`
 *   이 그대로 저장돼 summarize() 합계가 **'01200800'**(글자 이어붙이기)이 됐고, `units:'x'`·`units:[null]` 하나가
 *   /tools/pdu(전 장비를 한 map 에서 처리) 전체를 500 으로 죽였다.
 *   규칙: 배열이 아니면 빈 배열, 원소는 평범한 객체만(뺀 개수를 센다), 수치는 numOrNull(못 읽은 값은 null — 0 이 아니다),
 *   아는 키만 담는다(v2.598 CENTRAL 규약 — 엣지가 임의 필드로 중앙 메모리를 부풀리지 못하게).
 */
export const PDU_UNITS_MAX = 16;
export const PDU_SENSORS_MAX = 32;
export const PDU_BANKS_MAX = 48;
export const PDU_PHASES_MAX = 12;
export const PDU_NOTES_MAX = 50;
function objList(v, max, map, cnt) {
  if (v == null) return [];
  if (!Array.isArray(v)) { cnt.n += 1; return []; }
  const out = [];
  for (const x of v) {
    if (!isPlainObj(x)) { cnt.n += 1; continue; }
    if (out.length >= max) { cnt.n += 1; continue; }
    out.push(map(x));
  }
  return out;
}
const flag = (o, k) => (o[k] === true ? { [k]: true } : {});
export function sanitizePduSnapshot(snap) {
  const cnt = { n: 0 };
  const o = { ...snap };
  o.units = objList(snap.units, PDU_UNITS_MAX, (u) => ({
    index: numOrNull(u.index), powerW: numOrNull(u.powerW), energyKwh: numOrNull(u.energyKwh),
    appPowerW: numOrNull(u.appPowerW), pf: numOrNull(u.pf),
    banks: objList(u.banks, PDU_BANKS_MAX, (b) => ({ index: numOrNull(b.index), currentA: numOrNull(b.currentA) }), cnt),
    phases: objList(u.phases, PDU_PHASES_MAX, (p) => ({ index: numOrNull(p.index), currentA: numOrNull(p.currentA), voltageV: numOrNull(p.voltageV) }), cnt),
    ...flag(u, 'banksNotCollected'), ...flag(u, 'banksIncomplete'), ...flag(u, 'phasesIncomplete'),
  }), cnt);
  o.sensors = objList(snap.sensors, PDU_SENSORS_MAX, (x) => ({
    index: numOrNull(x.index), name: capStr(x.name, 128), tempC: numOrNull(x.tempC), humidityPct: numOrNull(x.humidityPct),
  }), cnt);
  // 화면이 그대로 글자로 그린다 — 객체면 React #31 이다.
  if (snap.notes != null) o.notes = (Array.isArray(snap.notes) ? snap.notes : []).filter((x) => typeof x === 'string').slice(0, PDU_NOTES_MAX).map((x) => capStr(x, 500));
  if (snap.totals != null) o.totals = isPlainObj(snap.totals)
    ? { powerW: numOrNull(snap.totals.powerW), energyKwh: numOrNull(snap.totals.energyKwh), units: numOrNull(snap.totals.units), sensors: numOrNull(snap.totals.sensors) }
    : null;
  for (const k of ['unitsIncomplete', 'sensorsIncomplete']) if (Object.hasOwn(o, k)) o[k] = o[k] === true;
  return { snap: o, narrowed: cnt.n };
}

const FILE = path.join(config.configDir, 'central-pdu.json');
// 엣지가 오래 조용하면 낡은 값을 '현재'처럼 보여주지 않도록 만료시킨다(정직 표기).
const TTL_MS = Number(process.env.CENTRAL_PDU_TTL_MS) || 6 * 60 * 60_000; // 6시간

let _map = null; // agentLower → { agent, at, snapshots: [] }

function load() {
  if (_map) return _map;
  _map = new Map();
  if (!fs.existsSync(FILE)) return _map;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // v2.606(CEN2606-02): 이미 저장된 옛 파일의 원소도 같은 정제를 거친다(수정 전 저장분이 화면을 계속 죽이지 않게).
    for (const e of (parsed?.edges || [])) {
      if (!e?.agent) continue;
      const snaps = (Array.isArray(e.snapshots) ? e.snapshots : []).filter(isPlainObj).map((x) => sanitizePduSnapshot(x).snap);
      _map.set(String(e.agent).toLowerCase(), { ...e, snapshots: snaps });
    }
  } catch (e) { preserveCorrupt(FILE, e.message); _map = new Map(); }
  return _map;
}

// v2.591: '지금 수집' 요청 큐의 기준선 — 보관 중인 엣지 스냅샷의 수집 시각(엣지 시계 값).
setCollectBaseResolver((id) => {
  for (const e of load().values()) for (const s of e?.snapshots || []) if (String(s?.id) === String(id)) return Number(s.collectedAt) || null;
  return null;
});

// v2.599(CEN-2599-04): push 마다 전체를 동기로 쓰던 것 → 디바운스 비동기 + 종료 시 동기 flush.
//   ⚠ 로드의 preserveCorrupt 는 그대로다(손상 원본 보존). 들여쓰기(null,2)는 뺐다 — 크기만 늘린다.
const writer = createDebouncedWriter(FILE, () => JSON.stringify({ edges: [...load().values()] }), { name: 'pduEdge' });
function persist() { writer.save(); }

/**
 * 엣지 push 수신. agent 는 **개별 토큰에 바인딩된 이름**을 호출부가 넘겨야 한다
 * (body.agent 를 그대로 믿으면 다른 엣지 데이터를 덮어쓸 수 있다 — central 라우터 규약).
 */
export function saveEdgePdu(agent, snapshots) {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return { ok: false, reason: 'agent 가 필요합니다.' };
  // v2.599(CEN-2599-03·05): 객체가 아니거나 id 가 식별자가 아닌 원소는 빼고, 표시 필드의 객체 값은 null 로.
  const { devices: clean, dropped, coerced } = sanitizeEdgeDevices(snapshots, { idKey: 'id', max: 500 });
  const adm = admitAgent(load(), key);
  if (!adm.ok) {
    console.warn(`[central-pdu] 엣지 수 상한 — 새 이름 '${String(agent).slice(0, 64)}' 거절(최근 보고한 엣지를 밀어내지 않는다)`);
    return { ok: false, refused: true, reason: '중앙이 보관하는 엣지 수 상한에 닿았습니다(최근 보고한 엣지는 밀어내지 않습니다).', dropped };
  }
  if (adm.evicted) console.warn(`[central-pdu] 엣지 수 상한 — 오래 조용한 '${adm.evicted}' 보관분을 내렸다`);
  let narrowed = 0;
  const list = clean.map((s0) => {
    const { snap: s, narrowed: n } = sanitizePduSnapshot(s0);   // v2.606 CEN2606-02
    narrowed += n;
    return { ...s, agent: String(agent) };   // 표시용으로 실제 인증된 이름을 박아 둔다
  });
  const prevRec = load().get(key);
  load().set(key, { agent: String(agent), at: Date.now(), snapshots: list, ...(prevRec?.status ? { status: prevRec.status } : {}) }); // v2.613 EDGE2613-04: 마지막 상태 보고는 보존
  persist();
  for (const sn of list) if (sn?.id) ackCollect(sn.id, Number(sn.collectedAt) || null); // v2.590 P16: '지금 수집' 완료 확인
  return { ok: true, count: list.length, dropped, coerced, ...(narrowed ? { narrowed } : {}), ...(adm.evicted ? { evicted: adm.evicted } : {}) };
}

/** 만료되지 않은 엣지 스냅샷 전체(중앙 화면이 자기 수집분과 합쳐 보여준다). */
export function edgePduSnapshots() {
  const cut = Date.now() - TTL_MS;
  const out = [];
  for (const e of load().values()) {
    if (!e || (e.at || 0) < cut) continue;
    for (const s of e.snapshots || []) out.push(s);
  }
  return out;
}

/**
 * v2.613(감사 EDGE2613-04): 엣지의 상태 전용 보고(`statusOnly:true`) — 스냅샷 목록(`snapshots`·`at`)은 그대로 두고 `status` 만 기록한다
 * (storageEdge.saveEdgeStorageStatus 와 같은 규약). 아는 키만(reason·registered·missing·at) 담고 문자열을 자른다. 반환: 기록했는지.
 */
export function saveEdgePduStatus(agent, status) {
  const key = String(agent || '').trim().toLowerCase();
  if (!key) return false;
  const src = isPlainObj(status) ? status : {};
  const rec = load().get(key) || { agent: String(agent), at: 0, snapshots: [] };
  const registered = Number(src.registered); const missing = Number(src.missing);
  rec.status = { reason: capStr(src.reason, 64) || 'unknown', registered: Number.isFinite(registered) ? registered : null,
    missing: Number.isFinite(missing) && missing > 0 ? missing : 0, at: Date.now() };
  if (!load().has(key) && !admitAgent(load(), key).ok) return false; // 상태 보고도 엣지 수 상한을 따른다(v2.599)
  load().set(key, rec);
  persist();
  return true;
}

/** 엣지별 보고 상태(진단 화면 — '언제 마지막으로 올라왔나'). v2.613 EDGE2613-04: 마지막 상태 전용 보고(`status`)도 싣는다. */
export function edgePduStatus() {
  const cut = Date.now() - TTL_MS;
  return [...load().values()].map((e) => ({
    agent: e.agent, at: e.at, devices: (e.snapshots || []).length, stale: (e.at || 0) < cut, status: e.status || null,
  }));
}

export function _resetForTest() { _map = null; }
