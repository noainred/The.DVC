/**
 * central/storageInspectEdge.js — 엣지가 storage push 본문에 실어 보낸 PowerScale 점검 결과(`inspectRuns: [{ deviceId, runs:[…] }]`)를 중앙 이력에 적는다(v2.965).
 *  · 소유권(중앙 직접 장비 거절 · 개별 토큰은 위임분만)은 라우트가 장비 목록 · 노드 부하 표본과 **같은 함수로 먼저** 거른다 — 여기서는 모양 · 상한 · 정제만.
 *  · 실행마다 store.sanitizeRun(아는 필드만 · facts 화이트리스트 · 문자열 상한 · at 은 수신 시각 이하) — 엣지 이름은 인증된 agent 로 덮는다.
 *  · 같은 (장비, at) 은 한 번만(duplicate — 실패 아님). 뺀 것은 dropped 로 밝힌다(조용한 상한 금지). 받은 결과는 요청 큐를 ack 한다.
 */
import { recordRun } from '../storage/inspect/store.js';
import { ackInspect } from '../storage/inspect/requests.js';
import { capStr, capTrim } from '../util/capStr.js';

export const INSPECT_MAX_DEVICES = 500;
export const INSPECT_RUNS_PER_DEVICE = 4;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function saveEdgeInspectRuns(agent, list, { now = Date.now() } = {}) {
  const out = { devices: 0, received: 0, saved: 0, duplicate: 0, dropped: 0 };
  if (!Array.isArray(list)) return out;
  const who = capStr(String(agent || ''), 64);
  const perDevice = new Map(); // 반증 F8: 같은 deviceId 원소를 반복해도 장비당 상한은 push 하나에 INSPECT_RUNS_PER_DEVICE
  for (const ent of list.slice(0, INSPECT_MAX_DEVICES)) {
    if (!isObj(ent) || !Array.isArray(ent.runs)) { out.dropped += 1; continue; }
    const id = typeof ent.deviceId === 'string' || typeof ent.deviceId === 'number' ? capTrim(ent.deviceId, 128) : '';
    if (!id) { out.dropped += 1; continue; }
    out.devices += 1;
    for (const raw of ent.runs.slice(0, INSPECT_RUNS_PER_DEVICE)) {
      out.received += 1;
      const n = perDevice.get(id) || 0;
      if (n >= INSPECT_RUNS_PER_DEVICE) { out.dropped += 1; continue; }
      perDevice.set(id, n + 1);
      if (!isObj(raw)) { out.dropped += 1; continue; }
      const r = recordRun(id, { ...raw, agent: who, edgeAt: raw.at }, { maxTs: now });
      if (r.saved) { out.saved += 1; ackInspect(id, r.run.at); }
      else if (r.duplicate) out.duplicate += 1;
      else out.dropped += 1;
    }
    if (ent.runs.length > INSPECT_RUNS_PER_DEVICE) out.dropped += ent.runs.length - INSPECT_RUNS_PER_DEVICE;
  }
  if (list.length > INSPECT_MAX_DEVICES) out.dropped += list.length - INSPECT_MAX_DEVICES;
  if (out.saved) console.log(`[central] storage-data: 엣지 '${who}' 점검 결과 ${out.saved}건 기록(장비 ${out.devices} · 중복 ${out.duplicate} · 뺀 것 ${out.dropped})`);
  return out;
}
