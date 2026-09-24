/**
 * central/storageEdge.js — 엣지들이 push 한 스토리지 스냅샷의 중앙 보관(v2.302).
 * agent → { at, devices:[NormalizedSnapshot] }. 파일 영속: central-agent-storage.json
 * (central-agent-* 는 .gitignore 와일드카드로 이미 커밋 차단 — 계정 목록 포함 데이터).
 * 저장 키는 라우트가 req.centralAuth.agent 로 강제한다(agent 바인딩 — server/CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeEdgeDevices, admitAgent, createDebouncedWriter, isPlainObj, scalarizeFields } from './edgeRecord.js'; // v2.599 CEN-2599-03·04·05
import { capStr } from '../util/capStr.js';

/**
 * v2.606(감사 CEN2606-04 — 재현): `extra.appliances` 를 객체 배열(상한 8 — 수집기와 같은 값)로 좁히고 원소 필드를 글자로.
 *   예전에는 그대로 저장돼 `appliances:'x'`·`[null]` 하나가 SAN '스토리지 용량 요약' 전체를 500 으로 만들었다.
 *   제자리에서 고치지 않고 새 객체를 돌려준다. 좁힌 개수를 돌려준다.
 */
export const APPLIANCES_MAX = 8;
/** v2.607(CEN2607-02): 스토리지 extra 의 표시 글자 필드. */
export const STORAGE_EXTRA_DISPLAY_KEYS = Object.freeze([
  'healthState', 'clusterHealth', 'alertsNote', 'capacityBasisNote', 'versionRaw', 'versionSource', 'modelSource',
  'collectMethod', 'dataReduction', 'storageEfficiency',
]);
export function narrowStorageSnapshot(d) {
  if (!isPlainObj(d) || !Object.hasOwn(d, 'extra') || d.extra == null) return { snap: d, narrowed: 0 };
  if (!isPlainObj(d.extra)) return { snap: { ...d, extra: null }, narrowed: 1 };
  // v2.607(감사 CEN2607-02 — 재현): 화면이 글자로 그리는 extra 필드(헬스 배지·경보 문구·용량 기준 설명·버전 원문)가
  //   객체면 null 로. 예전에는 `extra.alertsNote:{a:1}` 가 그대로 저장돼 상세 모달이 React #31 로 죽었다.
  const ex0 = { ...d.extra };
  const sc = scalarizeFields(ex0, STORAGE_EXTRA_DISPLAY_KEYS, 4096); // 긴 설명문은 자르지 않게 상한을 넓힌다
  if (sc) d = { ...d, extra: ex0 };
  if (!Object.hasOwn(d.extra, 'appliances') || d.extra.appliances == null) return { snap: d, narrowed: sc };
  const raw = Array.isArray(d.extra.appliances) ? d.extra.appliances : null;
  let narrowed = (raw ? 0 : 1) + sc;
  const apps = [];
  for (const a of raw || []) {
    if (!isPlainObj(a) || apps.length >= APPLIANCES_MAX) { narrowed += 1; continue; }
    apps.push({ name: capStr(a.name, 128), model: capStr(a.model, 128), serviceTag: capStr(a.serviceTag, 64) });
  }
  return { snap: { ...d, extra: { ...d.extra, appliances: apps } }, narrowed };
}
import { recordActivity } from '../storage/activityLog.js';
import { saveCapacityPoint } from '../storage/db.js';
import { ackCollect, setCollectBaseResolver } from '../storage/collectRequests.js';

const FILE = path.join(config.configDir, 'central-agent-storage.json');
const MAX_DEVICES_PER_AGENT = 500;
let _map = null;
// 엣지 push 로그 중복 제거 — 엣지는 5분마다 전 장비를 다시 보내므로, 같은 collectedAt 을
// 매번 로그에 남기면 같은 수집이 중복 기록된다. deviceId → 마지막 기록한 collectedAt.
const _lastRec = new Map();

// v2.599(CEN-2599-04): push 마다 전체 맵을 동기로 쓰던 것 → 디바운스 비동기 + 종료 시 동기 flush.
const writer = createDebouncedWriter(FILE, () => JSON.stringify(Object.fromEntries(load())), { name: 'storageEdge' });

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); } // 캐시 성격 — 다음 push 가 재구축
  // v2.606(CEN2606-04): 수정 전에 저장된 원소도 같은 정제를 거친다.
  for (const [k, v] of _map) if (isPlainObj(v) && Array.isArray(v.devices)) _map.set(k, { ...v, devices: v.devices.map((x) => narrowStorageSnapshot(x).snap) });
  return _map;
}

// v2.591: '지금 수집' 요청 큐의 기준선 — 중앙 재시작 직후에도 보관 중인 엣지 스냅샷의 수집 시각(엣지 시계 값)을 쓴다.
setCollectBaseResolver((id) => {
  for (const rec of load().values()) for (const d of rec?.devices || []) if (String(d?.deviceId || d?.id) === String(id)) return Number(d.collectedAt) || null;
  return null;
});

/**
 * @param info (선택) 수신 정리 결과를 받을 객체 — `dropped`(사유별 뺀 개수)·`coerced`·`refused`·`evicted`.
 *   ⚠ v2.599(CEN-2599-03·05): 원소를 그대로 저장하지 않는다 — 객체가 아니거나 deviceId 가 식별자가 아니면 빼고,
 *   표시 필드의 객체 값은 null 로 바꾼다(화면 React #31 방지). 뺀 개수는 호출부가 응답에 싣는다.
 */
export function saveEdgeStorage(agent, devices, info = {}) {
  const { devices: clean, dropped, coerced } = sanitizeEdgeDevices(devices, { idKey: 'deviceId', altIdKey: 'id', max: MAX_DEVICES_PER_AGENT });
  info.dropped = dropped; info.coerced = coerced;
  const adm = admitAgent(load(), agent);
  if (!adm.ok) { info.refused = true; console.warn(`[central] storage-data: 엣지 수 상한 — 새 이름 '${String(agent).slice(0, 64)}' 거절(최근 보고한 엣지를 밀어내지 않는다)`); return 0; }
  if (adm.evicted) { info.evicted = adm.evicted; console.warn(`[central] storage-data: 엣지 수 상한 — 오래 조용한 '${adm.evicted}' 보관분을 내렸다`); }
  let narrowed = 0;
  const list = clean.map((d0) => { const { snap: d, narrowed: n } = narrowStorageSnapshot(d0); narrowed += n; return { ...d, agent }; }); // 표시용 출처 각인(엣지가 뭐라 보냈든 인증된 agent 로 덮음)
  if (narrowed) info.narrowed = narrowed;
  const prev = load().get(agent);
  load().set(agent, { at: Date.now(), devices: list, ...(prev?.status ? { status: prev.status } : {}) });
  writer.save();
  // 작업 로그(v2.315) — 엣지가 보낸 각 장비의 '완료' 이벤트를 중앙 로그에 남긴다(화면 '완료' 구획).
  // 같은 collectedAt 재push 는 건너뛴다(엣지 5분 push × 10분 수집 = 같은 스냅샷이 두 번 옴).
  for (const dv of list) {
    const key = dv.deviceId || dv.id;
    if (!key) continue;
    const ca = Number(dv.collectedAt) || 0;
    ackCollect(key, ca || null); // v2.590 P16: 위임 '지금 수집' 요청의 완료 확인(인출 이후 수집분일 때만)
    if (_lastRec.get(key) === ca) continue;
    _lastRec.set(key, ca);
    // 용량 시계열 적재(v2.318, 사용자 요구 '용량 추이 그래프') — 엣지 수집 장비의 추이를
    // **중앙에서도** 보려면 push 수신 시 중앙 DB(capacity_history)에 1점을 적재해야 한다
    // (수집 노드 로컬 DB 원칙의 예외 — 용량 4~8필드뿐이라 WAN/저장 부담 없음. 원문 API 응답은
    // 여전히 엣지 DB). 같은 collectedAt 재push 는 위 dedup 이 걸러 중복 점이 쌓이지 않는다.
    // 실패 스냅샷은 saveCapacityPoint 가 자체 스킵(ok 만 적재 — 그래프 0값 오염 방지).
    saveCapacityPoint(dv).catch(() => { /* DB 비활성 — 스냅샷 보관·로그는 계속 */ });
    try {
      recordActivity({
        deviceId: key, name: dv.name || key, host: dv.host || '', source: agent,
        ok: !!dv.ok, nodes: dv.nodes?.count ?? null,
        usedBytes: dv.capacity?.usedBytes ?? null, totalBytes: dv.capacity?.totalBytes ?? null,
        error: dv.ok ? null : (dv.error || null), at: ca || Date.now(),
      });
    } catch { /* 로그 실패가 push 수신을 막지 않게 */ }
  }
  // v2.606(감사 TIM2606-05): 중복 제거 Map 은 **보관 중인 장비 id 만** 남긴다 — 예전에는 set 만 하고 지우지 않아 매 push 새
  //   deviceId 를 보내는 엣지(재등록 반복·오동작·공유 토큰)가 프로세스 수명 내내 키를 쌓았다. 빠진 장비의 키만 지우므로
  //   dedup 계약(같은 collectedAt 재push 는 기록하지 않는다)은 그대로다.
  pruneLastRec();
  return list.length;
}
function pruneLastRec() {
  const live = new Set();
  for (const v of load().values()) for (const d of v?.devices || []) { const k = d?.deviceId || d?.id; if (k) live.add(k); }
  for (const k of _lastRec.keys()) if (!live.has(k)) _lastRec.delete(k);
}
/** 테스트·진단용 — 중복 제거 Map 크기. */
export function _lastRecSize() { return _lastRec.size; }

/**
 * v2.581(BUG-D): 엣지의 상태 전용 보고 — 장비 목록(`devices`·`at`)은 그대로 두고 `status` 만 기록한다.
 * 아는 키만 담고(reason·registered·at) 문자열 길이를 자른다(변조 본문이 파일을 부풀리지 않게).
 */
export function saveEdgeStorageStatus(agent, status) {
  const src = status && typeof status === 'object' ? status : {};
  const rec = load().get(agent) || { at: 0, devices: [] };
  const registered = Number(src.registered);
  rec.status = {
    reason: capStr(src.reason, 64) || 'unknown', // v2.607(TIM2607-01)
    registered: Number.isFinite(registered) ? registered : null,
    at: Date.now(),
  };
  if (!load().has(agent) && !admitAgent(load(), agent).ok) return false; // v2.599: 상태 보고도 엣지 수 상한을 따른다
  load().set(agent, rec);
  writer.save();
  return true;
}

/** 엣지별 보고 요약(화면용): 장비 보고 시각·대수 + 마지막 상태 전용 보고. */
export function edgeStorageReports() {
  const out = [];
  for (const [agent, rec] of load()) {
    out.push({ agent, at: rec.at || null, deviceCount: (rec.devices || []).length, status: rec.status || null });
  }
  return out;
}

/** 전 엣지 스냅샷 평탄화(+ 보고 시각). 오래된 보고도 노출하되 staleMs 로 표시(숨기지 않음 — 정직). */
export function edgeStorageSnapshots() {
  const out = [];
  for (const [agent, rec] of load()) {
    for (const d of rec.devices || []) out.push({ ...d, agent, reportedAt: rec.at, staleMs: Date.now() - rec.at });
  }
  return out;
}
export function _resetForTest() { _map = null; }
