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
  m.set(a, { at: Date.now(), status: st });
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
  return { saved: st.devices.length };
}

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
    agent: a, receivedAt: rec.at, enabled: st.enabled, at: st.at, pushAt: st.pushAt,
    intervalMs: st.intervalMs, version: st.version,
    device: st.devices.find((d) => String(d.id) === String(deviceId)) || null,
  };
}

export function _resetForTest() { _map = null; _lastRec.clear(); }
