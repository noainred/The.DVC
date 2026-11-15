/**
 * focusmon/tune.js — 수집 부하 자동 조절(v3.16.0 ⑯ C3 — 시안 Alerts · 컨펌 ⑥ '기본 꺼짐 · 문턱은 수집 부하 탭의 판정 문턱(1% · 3%) 그대로').
 *
 *  · 켜면(설정 autoTune 1) 계속 수집 서버마다 수집 비용(수집 부하 창의 cpuPct — 코어 1개 기준 %)이 **주의 문턱 이상**으로 두 창(30초씩) 이어지면
 *    프로세스 표본 주기를 한 단계 늘린다(5 → 15 → 30초 · 늘린 뒤 10분은 다시 늘리지 않는다).
 *  · 주의 문턱의 절반 아래가 1시간 이어지면 한 단계 되돌린다(설정의 기본 주기까지).
 *  · 원격 명령은 미리 만든 상수 12개(`script.SCRIPT_TABLE`) 가운데 고르기만 한다 — 바꾸면 수집기가 접속을 한 번 다시 연다(몇 초 공백). 사건('수집 조절')에 남긴다.
 *  · 잠깐 보기 서버는 조절하지 않는다(15분짜리). 끄면 모든 조절을 지우고 설정 주기로 돌아간다. 재시작하면 조절은 처음부터(설정 주기).
 *  · 판정 코어는 `decide` 하나(순수 — 시험이 고정).
 */
import { PROC_EVERY_CHOICES } from './script.js';

export const STEP_UP_WINDOWS = 2;
export const STEP_UP_HOLD_MS = 10 * 60_000;
export const STEP_DOWN_AFTER_MS = 60 * 60_000;
const T = new Map(); // targetId → { pe, over, lowSince, changedAt, lastAt }
const HIST = []; // 최근 바꾼 것(화면 — 20개)

/**
 * 판정(순수). prev = { pe, over, lowSince, changedAt, lastAt } | null · load = { cpuPct, at } | null · base = 설정 주기.
 * @returns {{ next, change: null|{from,to,why} }}
 */
export function decide(prev, load, { base = 5, warnPct = 1 } = {}, now = Date.now()) {
  const steps = PROC_EVERY_CHOICES; // [5, 15, 30]
  const cur = prev?.pe ?? base;
  const st = { pe: cur, over: prev?.over ?? 0, lowSince: prev?.lowSince ?? null, changedAt: prev?.changedAt ?? 0, lastAt: prev?.lastAt ?? 0 };
  const pct = load && Number.isFinite(load.cpuPct) ? load.cpuPct : null;
  if (pct == null || !(load.at > st.lastAt)) return { next: st, change: null }; // 새 창이 아니면(같은 창을 두 번 세지 않는다) · 못 읽음은 판정하지 않는다
  st.lastAt = load.at;
  if (pct >= warnPct) { st.over += 1; st.lowSince = null; } else { st.over = 0; if (pct < warnPct / 2) st.lowSince = st.lowSince ?? now; else st.lowSince = null; }
  const i = steps.indexOf(cur);
  if (st.over >= STEP_UP_WINDOWS && i >= 0 && i < steps.length - 1 && now - st.changedAt >= STEP_UP_HOLD_MS) {
    const to = steps[i + 1];
    return { next: { ...st, pe: to, over: 0, changedAt: now }, change: { from: cur, to, why: `수집 비용 ${pct}% ≥ 주의 문턱 ${warnPct}% 가 ${STEP_UP_WINDOWS}창 이어짐` } };
  }
  const bi = steps.indexOf(base);
  if (st.lowSince != null && now - st.lowSince >= STEP_DOWN_AFTER_MS && i > Math.max(0, bi)) {
    const to = steps[i - 1];
    return { next: { ...st, pe: to, lowSince: now, changedAt: now }, change: { from: cur, to, why: `수집 비용이 ${warnPct / 2}% 아래로 1시간 이어짐` } };
  }
  return { next: st, change: null };
}

/**
 * 한 번(서비스 1분 틱 — 중앙과 엣지 모두 자기가 수집하는 서버만). 바꾼 것 목록을 돌려준다(사건은 부르는 쪽이 store.queueEvent 로).
 * @param {{targets: Array<{id, name}>, loadOf: (id)=>object|null, settings: object, now: number}} o
 */
export function tuneTick({ targets = [], loadOf, settings = {}, now = Date.now() } = {}) {
  if (!settings.autoTune) { if (T.size) { T.clear(); } return []; }
  const base = settings.procEvery || 5; const warnPct = settings.loadWarnPct || 1;
  const live = new Set(targets.map((t) => t.id));
  for (const id of [...T.keys()]) if (!live.has(id)) T.delete(id);
  const out = [];
  for (const t of targets) {
    const r = decide(T.get(t.id) || null, loadOf(t.id), { base, warnPct }, now);
    T.set(t.id, r.next);
    if (r.change) { const c = { at: now, id: t.id, name: t.name || t.id, ...r.change }; out.push(c); HIST.unshift(c); if (HIST.length > 20) HIST.length = 20; }
  }
  return out;
}
/** 이 서버의 프로세스 표본 주기 — 조절이 있으면 그것, 없으면 설정. */
export function procEveryFor(id, base) { const v = T.get(String(id)); return v?.pe ?? base; }
export function recentTunes() { return HIST.slice(); }
export function tuneStateOf(id) { const v = T.get(String(id)); return v ? { ...v } : null; }
export function _resetForTest() { T.clear(); HIST.length = 0; }
