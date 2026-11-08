/**
 * central/bmPowerCapSanitize.js — 다음 점검 ③: 엣지 봉투 **서버별 PowerCap(powerCaps)** 중앙 정제(순수).
 *
 * 규약(edge.md ‘엣지가 보낸 것은 정제한다’): 아는 필드만(key · limitWatts · enabled · at) · 객체만 · 상한(SNAP 대상 상한 2,000) ·
 *   서버 키는 **같은 봉투의 대상 목록 안**만(남의 서버 상한을 끼워 넣지 못한다) · 같은 키 두 번은 첫 것만 ·
 *   limitWatts 는 수(문자열 수치 '400' → 400 · 못 읽으면 null — 0 으로 두지 않는다) · 범위(1 ~ POWER_CAP_MAX_W) 밖은 null ·
 *   enabled 는 불리언만(그 밖은 null) · limitWatts 가 없는데 enabled=true 는 모순이라 null · 엣지 시각(at)은 **수신 시각으로 자르고** 원본은 atRaw 로 따로.
 * 표지(powerCapVer)는 central/bmPerfSanitize.js 가 작은 양의 정수만 싣는다 — 표지가 없으면 그 엣지는 이 기능 이전 판(중앙 화면 ‘엣지 버전 낮음’ · 그때만).
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { clampEdgeTs } from '../util/clampEdgeTs.js';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
export const POWER_CAPS_MAX = 2_000;
/** 서버 한 대 상한의 바깥 한계(W) — 실제 서버 전원 정격보다 넉넉히. 밖이면 못 읽음(null). */
export const POWER_CAP_MAX_W = 100_000;

/** 봉투 powerCaps → [{ key, limitWatts, enabled, at, atRaw? }] + 버린 수(순수). */
export function sanitizePowerCaps(list, { targetKeys = new Set(), now = Date.now() } = {}) {
  if (!Array.isArray(list)) return { list: null, dropped: 0 };
  const out = []; const seen = new Set(); let dropped = 0;
  for (const x of list.slice(0, POWER_CAPS_MAX)) {
    if (!isObj(x) || typeof x.key !== 'string' || !targetKeys.has(x.key) || seen.has(x.key)) { dropped += 1; continue; }
    seen.add(x.key);
    const w = numOrNull(x.limitWatts);
    const limitWatts = w != null && w >= 1 && w <= POWER_CAP_MAX_W ? Math.round(w) : null;
    let enabled = typeof x.enabled === 'boolean' ? x.enabled : null;
    if (enabled === true && limitWatts == null) enabled = null;   // 켜짐인데 값을 못 읽음 — 모순은 모름으로
    const a = numOrNull(x.at);
    const at = clampEdgeTs(a, now);
    out.push({ key: capStr(x.key, 256), limitWatts, enabled, at, ...(a != null && at !== a ? { atRaw: a } : {}) });
  }
  dropped += Math.max(0, list.length - POWER_CAPS_MAX);
  return { list: out, dropped };
}

/**
 * 정제본(봉투) → 키별 edgeCap 조회 함수(powerAgg.gatherPower 가 읽는 모양 — 순수 · 봉투마다 한 번 색인).
 *   봉투에 표지가 없으면 old-version · 표지는 있는데 그 서버 항목이 없으면 unread(엣지 인벤토리 없음 · PowerLimit 미보고) ·
 *   enabled=true → set · enabled=false → unset · enabled=null → unread.
 */
export function edgeCapIndex(snap) {
  if (!isObj(snap) || !Number.isInteger(snap.powerCapVer)) return () => ({ state: 'old-version' });
  const m = new Map();
  for (const e of Array.isArray(snap.powerCaps) ? snap.powerCaps : []) if (isObj(e) && typeof e.key === 'string' && !m.has(e.key)) m.set(e.key, e);
  return (key) => {
    const e = m.get(String(key ?? ''));
    if (!e) return { state: 'unread' };
    return { state: e.enabled === true ? 'set' : e.enabled === false ? 'unset' : 'unread', limitWatts: e.limitWatts ?? null, at: e.at ?? null };
  };
}
