/**
 * central/sanSwitchPerfEdge.js — 엣지가 보고한 **포트 사용량 수집 상태**의 중앙 보관(v2.517,
 * 사용자 신고 "데이터 수집이 안되, edge 의 사용량도 분석하게 해줘").
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────────
 * v2.423 이 엣지→중앙 **시계열 중계**를 만들었지만, 중계할 표본이 0건이면 중앙은 아무것도 받지
 * 못한다 — 그리고 '표본 0건' 이 바로 사용자가 신고한 상태다. 중앙 설정 화면의 `status` 는
 * `sanSwitchPerfStatus()`(그 노드의 폴러)라서 **중앙 직접 수집분만** 비추는데 화면은 그것을
 * 전체 상태처럼 보여줬다. 결과: 엣지가 켜졌는지, 돌았는지, 무슨 이유로 실패하는지 중앙에서
 * 알 방법이 전혀 없었다.
 *
 * 그래서 엣지가 push 할 때(표본이 0건이어도 — `perfPush.js` 의 상태 전용 하트비트) 자기 폴러
 * 상태와 **장비별 최근 1건**을 함께 올리고, 중앙은 여기에 보관한다.
 *
 * ── 규약 ──────────────────────────────────────────────────────────────────────
 * · 저장 키는 **인증된 agent**(`req.centralAuth.agent`)다 — body.agent 를 믿지 않는다(위조 차단).
 * · 파일 `central-agent-sanswitch-perf.json`(0600). `central-agent-*` 는 .gitignore 와일드카드.
 * · 캐시 성격이라 손상 시 preserveCorrupt 를 쓰지 않는다(다음 push 가 재구축 — v2.516 규약).
 * · 장비별 결과는 중앙 **작업 로그**에도 남긴다(중앙 화면이 위임 장비 실패 사유를 보여주려면
 *   필요하다 — 엣지의 로컬 로그는 중앙에서 볼 수 없다). 엣지는 주기마다 같은 것을 다시 보내므로
 *   `_lastRec` 가 이벤트 시각(`at`)으로 중복을 거른다(`central/sanSwitchEdge.js` 와 같은 규약).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { recordActivity } from '../sanswitch/perfActivityLog.js';
import { numOrNull } from '../util/numOrNull.js';
import { ackPerfCollect, setPerfBaseResolver } from '../sanswitch/collectRequests.js';
import { admitAgent } from './edgeRecord.js';

const FILE = path.join(config.configDir, 'central-agent-sanswitch-perf.json');
const MAX_DEVICES_PER_AGENT = 300;
const MAX_AGENTS = 200;
let _map = null;
const _lastRec = new Map(); // deviceId → 마지막으로 기록한 이벤트 시각(at)

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))); }
  catch { _map = new Map(); }   // 없거나 손상 — 다음 push 가 재구축
  return _map;
}

// v2.591: 사용량 '지금 수집' 요청의 기준선 — 보관 중인 그 엣지 상태의 at(엣지 시계 값). 큐는 소문자 키다.
setPerfBaseResolver((a) => {
  for (const [k, v] of load()) if (String(k).toLowerCase() === String(a)) return Number(v?.status?.at) || null;
  return null;
});


/** 엣지가 보고한 상태를 정규화(신뢰 경계 — 형식·상한을 여기서 강제한다). */
export function normalizeEdgePerfStatus(input = {}) {
  const devices = (Array.isArray(input.devices) ? input.devices : []).slice(0, MAX_DEVICES_PER_AGENT)
    .map((d) => ({
      id: String(d?.id || ''),
      ok: d?.ok === true,
      at: numOrNull(d?.at),
      // 오류 문구는 300자로 자른다(SSH 추적·스택이 통째로 온다 — 작업 로그와 같은 상한).
      error: d?.error ? String(d.error).slice(0, 300) : null,
      ports: numOrNull(d?.ports),
    }))
    .filter((d) => d.id);
  return {
    enabled: input.enabled === true,
    intervalMs: numOrNull(input.intervalMs),
    sampleSeconds: numOrNull(input.sampleSeconds),
    at: numOrNull(input.at),
    collected: numOrNull(input.collected),
    failed: numOrNull(input.failed),
    total: numOrNull(input.total),
    pushAt: numOrNull(input.pushAt),
    // 엣지의 마지막 중계 실패 사유(v2.566). 300자 상한은 작업 로그와 같다.
    pushError: input.pushError ? String(input.pushError).slice(0, 300) : null,
    version: input.version ? String(input.version).slice(0, 40) : null,
    devices,
  };
}

/** 저장 + 장비별 결과를 중앙 작업 로그에 반영. `owned` 는 그 엣지에 위임된 deviceId 집합. */
export function saveEdgePerfStatus(agent, status, { owned = null, names = null } = {}) {
  const a = String(agent || '').trim();
  if (!a) return { saved: 0 };
  const st = normalizeEdgePerfStatus(status);
  // 미위임 deviceId 는 버린다 — 남의 스위치 상태 위조 차단(시계열 수신과 같은 규약).
  if (owned) st.devices = st.devices.filter((d) => owned.has(String(d.id)));
  const m = load();
  // v2.605(CEN2605-04): 새 이름은 admitAgent 로 받는다(형제 storageEdge 상태 보고와 같은 규약) — 예전에는 무조건 넣고
  //   삽입순 앞부분을 퇴출해, 공유 토큰으로 임의 이름 200개를 보내면 **최근 보고한 실제 엣지 행이 밀려나** perfDiag 가
  //   '보고 없음' 으로 오판했다. 이제 오래 조용한 행만 내보내고, 모두 최근이면 새 이름을 거절한다.
  if (!m.has(a)) {
    const adm = admitAgent(m, a, { maxAgents: MAX_AGENTS });
    if (!adm.ok) { console.warn(`[central] sanswitch-perf: 엣지 수 상한 — 새 이름 '${a.slice(0, 64)}' 의 상태를 받지 않았다(최근 보고한 엣지를 밀어내지 않는다)`); return { saved: 0, refused: true }; }
    if (adm.evicted) console.warn(`[central] sanswitch-perf: 엣지 수 상한 — 오래 조용한 '${adm.evicted}' 상태를 내렸다`);
  }
  // v2.594(감사 EDGE2-02): Map.set 은 기존 키의 삽입 위치를 유지한다 — 지우고 다시 넣어야 '최근 보고' 가 뒤로 가서
  //   상한 퇴출 때 방금 보고한 엣지가 밀려나지 않는다.
  m.delete(a);
  m.set(a, { at: Date.now(), status: st });
  // v2.591: 상태의 at(엣지의 마지막 사용량 수집 시각)이 인출 때 기준선보다 새면 완료 — 하트비트 도착만으로 완료하지 않는다.
  // at 이 없으면(아직 한 번도 수집 안 함) 완료로 보지 않는다(요청은 시한 뒤 폐기 목록으로 밝혀진다).
  if (st.at != null) ackPerfCollect(a, st.at);
  if (m.size > MAX_AGENTS) for (const k of [...m.keys()].slice(0, m.size - MAX_AGENTS)) m.delete(k);
  try { atomicWriteFileSync(FILE, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 }); }
  catch { /* 영속 실패는 무시 — 인메모리는 유지 */ }

  for (const d of st.devices) {
    if (d.at == null) continue;                        // 시각을 모르면 로그에 넣지 않는다(중복 판정 불가)
    if (_lastRec.get(d.id) === d.at) continue;         // 같은 이벤트 재push — 로그를 부풀리지 않는다
    _lastRec.set(d.id, d.at);
    try {
      recordActivity({
        deviceId: d.id, name: (names && names.get(String(d.id))) || d.id, source: a,
        ok: d.ok, at: d.at,
        // ⚠ 실패면 수치는 null 이다 — 0 을 실으면 화면에 '포트 0개' 라는 거짓이 찍힌다(v2.516 규약).
        ports: d.ok ? d.ports : null, totalBps: null,
        error: d.ok ? null : (d.error || null),
      });
    } catch { /* 로그 실패가 수신을 막지 않게 */ }
  }
  // v2.606(감사 TIM2606-05): 중복 제거 Map 은 **보관 중인 장비 id 만** 남긴다 — 예전에는 set 만 하고 지우지 않아 매 push 새
  //   deviceId 를 보내는 엣지(재등록 반복·오동작·공유 토큰)가 프로세스 수명 내내 키를 쌓았다. 빠진 장비의 키만 지우므로
  //   dedup 계약(같은 collectedAt 재push 는 기록하지 않는다)은 그대로다.
  const live = new Set();
  for (const v of m.values()) for (const d of v?.status?.devices || []) if (d?.id != null) live.add(d.id);
  for (const k of _lastRec.keys()) if (!live.has(k)) _lastRec.delete(k);
  return { saved: st.devices.length };
}
/** 테스트·진단용 — 중복 제거 Map 크기. */
export function _lastRecSize() { return _lastRec.size; }

/** 전체 엣지 상태 — 설정 화면의 '엣지별 수집 상태' 표. */
export function listEdgePerfStatus() {
  return [...load().entries()].map(([agent, v]) => ({ agent, receivedAt: v.at, ...(v.status || {}) }));
}

/**
 * 한 장비의 엣지 보고 상태 — `perfDiag` 입력. 그 엣지가 보고한 적이 없으면 **null**(추정 금지:
 * '꺼져 있다' 가 아니라 '모른다' 다. 화면은 이 둘을 다르게 안내한다).
 */
export function edgePerfStatusFor(deviceId, agent) {
  const a = String(agent || '').trim();
  if (!a) return null;
  const rec = load().get(a) || [...load().entries()].find(([k]) => k.toLowerCase() === a.toLowerCase())?.[1];
  if (!rec?.status) return null;
  const st = rec.status;
  return {
    agent: a, receivedAt: rec.at, enabled: st.enabled, at: st.at, pushAt: st.pushAt, pushError: st.pushError || null,
    intervalMs: st.intervalMs, version: st.version,
    device: st.devices.find((d) => String(d.id) === String(deviceId)) || null,
  };
}

export function _resetForTest() { _map = null; _lastRec.clear(); }
