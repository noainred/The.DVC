/**
 * central/storageEdge.js — 엣지들이 push 한 스토리지 스냅샷의 중앙 보관(v2.302).
 * agent → { at, devices:[NormalizedSnapshot] }. 파일 영속: central-agent-storage.json
 * (central-agent-* 는 .gitignore 와일드카드로 이미 커밋 차단 — 계정 목록 포함 데이터).
 * 저장 키는 라우트가 req.centralAuth.agent 로 강제한다(agent 바인딩 — server/CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeEdgeDevices, admitAgent, createDebouncedWriter } from './edgeRecord.js'; // v2.599 CEN-2599-03·04·05
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
  const list = clean.map((d) => ({ ...d, agent })); // 표시용 출처 각인(엣지가 뭐라 보냈든 인증된 agent 로 덮음)
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
  return list.length;
}

/**
 * v2.581(BUG-D): 엣지의 상태 전용 보고 — 장비 목록(`devices`·`at`)은 그대로 두고 `status` 만 기록한다.
 * 아는 키만 담고(reason·registered·at) 문자열 길이를 자른다(변조 본문이 파일을 부풀리지 않게).
 */
export function saveEdgeStorageStatus(agent, status) {
  const src = status && typeof status === 'object' ? status : {};
  const rec = load().get(agent) || { at: 0, devices: [] };
  const registered = Number(src.registered);
  rec.status = {
    reason: String(src.reason || 'unknown').slice(0, 64),
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
