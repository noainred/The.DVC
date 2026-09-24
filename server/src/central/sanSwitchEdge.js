/**
 * central/sanSwitchEdge.js — 엣지들이 push 한 SAN 스위치 스냅샷의 중앙 보관(v2.410).
 * agent → { at, devices:[스냅샷] }. 파일: central-agent-sanswitch.json
 * (central-agent-* 는 .gitignore 와일드카드로 이미 커밋 차단).
 * 저장 키는 라우트가 req.centralAuth.agent 로 강제한다(agent 바인딩 — server/CLAUDE.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { sanitizeEdgeDevices, admitAgent, createDebouncedWriter } from './edgeRecord.js'; // v2.599 CEN-2599-03·04·05
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
  let list = clean.map((d) => ({ ...d, agent })); // 엣지가 뭐라 보냈든 인증된 agent 로 덮는다(출처 위조 차단)
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
  return list.length;
}

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
