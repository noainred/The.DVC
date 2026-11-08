/**
 * bmusage/idle.js — 리눅스 성능 8b단계 **저활용 서버 찾기**(설계 PROFILES §20 ㉑ · 아트보드 Idle). 판정이 아니라 **후보 표시**다(‘저활용 ≠ 불필요’ — 사람이 확인하고 남긴다).
 *
 * 입력(새 수집 없음 — 이 노드가 이미 가진 값):
 *   · usage_daily(1d 연 파일) 창(기본 30일 · 90일 옵션) — CPU 평균(합 ÷ 개수) · 일 최대의 평균 · 메모리 평균 · 디스크 일 최대 busy 평균 · 네트 일 최대(링크 대비 %) 평균.
 *   · iDRAC 전력 시간 롤업(power_hourly — 이 노드 iDRAC 폴러 · 대상의 등록부 id) — 창 평균 W 와 창 안 최소 시간 평균 W(그 서버의 ‘유휴 근처’ — 상대값 ○).
 *     0 W 이하 시간(Redfish 가 0 을 주는 모델)은 전력 값에서 뺀다(미측정 — 0 을 유휴로 세지 않는다).
 *   · 활동 흔적 — SSH 로그인 성공(7a 로그 분석 log_sec ‘ok’ · 그 서버 로그를 읽는 노드일 때만) + 사람이 연 집중 모니터링(focus_session trigger manual) + 진단 스냅샷(bm_snapshots — 보관 7일).
 *     SSH 신호를 모르면(로그를 읽지 않는 서버) 활동 칸 전체를 ‘—’(분모에서 뺀다) — 집중 · 스냅샷만으로 ‘흔적 없음’ 이라 하지 않는다.
 *     ⚠ 설계의 ‘프로세스 Top 에 사용자 프로세스 없음’ 은 넣지 않았다 — 7일 날 파일 전체를 서버마다 훑어야 해서(요청 경로 · 하루 계산 모두 동기 SQLite 블로킹) 하루 계산 비용이 너무 크다(정직 기록).
 * 점수(0~100 · 가중치 · 기준은 설정값 — perfRules idle): 지표마다 기준 안이면 가중치 전부 · 기준의 2배 안이면 절반 · 넘으면 0.
 *   CPU = 평균 < cpuAvgPct **그리고** 일 최대 평균 < cpuMaxPct(2배 판정도 둘 다) · 메모리 = 평균 < memAvgPct · 디스크 = 일 최대 busy 평균 < diskBusyMaxPct ·
 *   네트 = 일 최대(링크 %) 평균 < netMaxPct · 전력 = 평균 ≤ 최소 × powerIdlePct%(2배 판정 = 초과분 2배) · 활동 = 흔적 0 이면 전부 · 하나라도 있으면 0.
 *   **지표가 없으면(‘—’) 그 가중은 분모에서 빼고 100 으로 환산**(뺀 지표를 행에 적는다 — 전력 없는 서버가 불리하지 않게) · 남은 가중이 0 이면 점수 없음.
 * 상태: 제외(데이터 부족 < minDays 일 · 지금 정비 창 안) → 주기 사용(일 최대가 periodicHighPct 이상인 날이 2일 ~ 주 수+1 일 · 나머지 날은 그 절반 아래) →
 *   후보(≥ candidate) → 관찰(≥ watch) → 사용 중. ‘대기 · DR’ 은 용도 태그가 없어(역할 5 · 기능 2) 화면의 검토 상태 ‘대기 · DR’(중앙 주석 저장소)로 정한다 — 라우트가 뺀다.
 * 계산 위치(용량 예측 8a 와 같은 결정): **수집 노드가 하루 1회**(포탈 날 경계 + 01:20 뒤 첫 틱 · 진행 중이면 공유 · 시간 기준 양보) → `bm-idle.json`(원자 쓰기 · 손상 보존) ·
 *   함대 표 · 보드 KPI 는 이 결과를 쓴다(요청 경로에서 30일 × 1,000대를 읽지 않는다). 후보 진입 · 이탈은 그 계산에서 변경 이벤트(kind ‘idle’)로 적는다.
 * 서버 식별은 (법인, 키) 쌍(maint/judge.js targetIdOf — 8a 반증 F1) · 정비 창 판정은 8a 코어(maintJudge · capacity.dayExclusion)를 그대로 쓴다(복제 금지).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';
import { dayKey, DAY_MS, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { createYielder } from '../util/timeSlice.js';
import { maintJudge, localTargets } from './maint/runtime.js';
import { targetIdOf } from './maint/judge.js';
import { dayExclusion } from './capacity.js';
import { loadPerfRules, DEFAULTS as RULE_DEFAULTS } from './perfRules.js';

import { IDLE_STATUS, IDLE_EXCLUDE, IDLE_METRICS } from './idleConst.js';

export { IDLE_STATUS, IDLE_EXCLUDE, IDLE_METRICS };
const n = numOrNull;
const FILE = () => path.join(config.configDir, 'bm-idle.json');
export const IDLE_DEFAULTS = Object.freeze({ ...RULE_DEFAULTS.idle });
const W_KEY = Object.freeze({ cpu: 'wCpu', mem: 'wMem', disk: 'wDisk', net: 'wNet', power: 'wPower', act: 'wAct' });
/** 재계산 시각(포탈 날 기준 분) — 01:20 뒤 첫 틱(아트보드 ‘매일 01:20 재계산(엣지)’). */
export const RECOMPUTE_AFTER_MIN = 80;
/** 전력 값을 쓰는 최소 시간 수(창 안 측정 시간 평균) — 3일치 미만이면 ‘—’. */
export const POWER_MIN_HOURS = 72;
export const IDLE_ROWS_MAX = 20_000;
export const HISTORY_DAYS = 62;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** 기준 판정(순수) — 값 < th → 1 · < 2th → 0.5 · 그 밖 0 · 값 없음 null. */
export const gradeBelow = (v, th) => (v == null ? null : v < th ? 1 : v < 2 * th ? 0.5 : 0);

/**
 * 일 행 → 창 지표(순수). days: usage_daily 행(같은 서버 · 창 안 · 정비 창 날은 호출부가 뺀다).
 * @returns {{days:number, cpuAvg, cpuMax, memAvg, diskMax, netMax, highDays:number, lowRest:boolean, sameWeekday:boolean, dayMax:Array}}
 */
export function windowMetrics(days = [], { periodicHighPct = 50 } = {}) {
  let cs = 0; let cn = 0; let ms = 0; let mn = 0; const cmax = []; const dmax = []; const nmax = []; let have = 0;
  const dayMax = [];
  for (const d of days) {
    const cpuN = n(d.cpu_n) ?? 0; const memN = n(d.mem_n) ?? 0;
    if (cpuN > 0 || memN > 0 || n(d.disk_busy_max) != null || n(d.net_max) != null) have += 1;
    if (cpuN > 0 && n(d.cpu_sum) != null) { cs += Number(d.cpu_sum); cn += cpuN; }
    if (memN > 0 && n(d.mem_sum) != null) { ms += Number(d.mem_sum); mn += memN; }
    if (n(d.cpu_max) != null) cmax.push(Number(d.cpu_max));
    if (n(d.disk_busy_max) != null) dmax.push(Number(d.disk_busy_max));
    if (n(d.net_max) != null) nmax.push(Number(d.net_max));
    const hi = Math.max(n(d.cpu_max) ?? -1, n(d.disk_busy_max) ?? -1);
    dayMax.push({ day: String(d.day || ''), v: hi < 0 ? null : hi });
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const known = dayMax.filter((x) => x.v != null);
  const high = known.filter((x) => x.v >= periodicHighPct);
  const rest = known.filter((x) => x.v < periodicHighPct);
  const wd = high.map((x) => new Date(`${x.day}T00:00:00Z`).getUTCDay()).filter(Number.isFinite);
  const top = wd.length ? Math.max(...[0, 1, 2, 3, 4, 5, 6].map((k) => wd.filter((x) => x === k).length)) : 0;
  return {
    days: have, cpuAvg: cn ? r1(cs / cn) : null, cpuMax: r1(mean(cmax)), memAvg: mn ? r1(ms / mn) : null, diskMax: r1(mean(dmax)), netMax: r1(mean(nmax)),
    highDays: high.length, lowRest: rest.length > 0 && rest.every((x) => x.v < periodicHighPct / 2), sameWeekday: high.length >= 2 && top / high.length >= 0.7,
  };
}

/** 시간 전력 → 평균 · 최소(순수 — 0 이하 시간은 미측정). */
export function powerStats(hours = []) {
  const v = (Array.isArray(hours) ? hours : []).map((h) => n(h?.avg)).filter((x) => x != null && x > 0);
  if (v.length < POWER_MIN_HOURS) return { avgW: null, minW: null, hours: v.length };
  return { avgW: Math.round(v.reduce((a, b) => a + b, 0) / v.length), minW: Math.round(Math.min(...v)), hours: v.length };
}

/**
 * 한 서버 점수(순수).
 * @param {{metrics:object, power:{avgW,minW}|null, activity:{ssh:number|null, focus:number|null, snap:number|null}|null, cfg?:object, maintActive?:boolean}} p
 */
export function scoreIdle({ metrics, power = null, activity = null, cfg = {}, maintActive = false } = {}) {
  const c = { ...IDLE_DEFAULTS, ...Object.fromEntries(Object.entries(cfg || {}).filter(([, v]) => v != null)) };
  const m = metrics || {};
  const g = {};
  // CPU — 평균과 일 최대 평균 둘 다(하나라도 없으면 있는 쪽으로만 · 둘 다 없으면 —)
  const gc = [gradeBelow(m.cpuAvg, c.cpuAvgPct), gradeBelow(m.cpuMax, c.cpuMaxPct)].filter((x) => x != null);
  g.cpu = gc.length ? Math.min(...gc) : null;
  g.mem = gradeBelow(m.memAvg, c.memAvgPct);
  g.disk = gradeBelow(m.diskMax, c.diskBusyMaxPct);
  g.net = gradeBelow(m.netMax, c.netMaxPct);
  if (power && power.avgW != null && power.minW != null && power.minW > 0) {
    const ratio = power.avgW / power.minW; const th = c.powerIdlePct / 100;
    g.power = ratio <= th ? 1 : ratio <= 1 + 2 * (th - 1) ? 0.5 : 0;
  } else g.power = null;
  if (activity && activity.ssh != null) { const ev = (activity.ssh || 0) + (activity.focus || 0) + (activity.snap || 0); g.act = ev === 0 ? 1 : 0; } else g.act = null;
  let num = 0; let den = 0; const dropped = [];
  for (const k of IDLE_METRICS) {
    const w = Number(c[W_KEY[k]]) || 0;
    if (!w) continue;
    if (g[k] == null) { dropped.push(k); continue; }
    num += w * g[k]; den += w;
  }
  const score = den > 0 ? Math.round((100 * num) / den) : null;
  const weeks = Math.max(1, Math.ceil((m.days || 0) / 7));
  const periodic = (m.highDays || 0) >= 2 && (m.highDays || 0) <= weeks + 1 && !!m.lowRest;
  let status; let reason = null;
  if ((m.days || 0) < c.minDays) { status = 'excluded'; reason = 'insufficient'; }
  else if (maintActive) { status = 'excluded'; reason = 'maint'; }
  else if (score == null) { status = 'excluded'; reason = 'no-score'; }
  else if (periodic) status = 'periodic';
  else if (score >= c.candidate) status = 'candidate';
  else if (score >= c.watch) status = 'watch';
  else status = 'active';
  return { score: status === 'excluded' && reason === 'insufficient' ? null : score, status, ...(reason ? { reason } : {}), grades: g, dropped,
    ...(periodic ? { periodic: { highDays: m.highDays, sameWeekday: !!m.sameWeekday } } : {}) };
}

/** 함대 요약(순수) — 서버 = (법인, 키) 쌍(targetIdOf). 제외는 사유별로 센다(숨기지 않는다). 후보 전력 합은 측정한 후보만(미측정 수를 적는다 — 절감 추정이 아니다). */
export function summarizeIdle(rows = []) {
  const seen = new Set();
  const s = { servers: 0, candidate: 0, watch: 0, active: 0, periodic: 0, excluded: 0, excludedBy: Object.fromEntries(IDLE_EXCLUDE.map((k) => [k, 0])), candPowerW: 0, candPowerMeasured: 0, candPowerUnmeasured: 0 };
  for (const r of rows) {
    const id = targetIdOf(r);
    if (seen.has(id)) continue;
    seen.add(id); s.servers += 1;
    if (!IDLE_STATUS.includes(r.status)) continue;
    s[r.status] += 1;
    if (r.status === 'excluded') s.excludedBy[IDLE_EXCLUDE.includes(r.reason) ? r.reason : 'no-score'] += 1;
    if (r.status === 'candidate') {
      const w = n(r.metrics?.powerAvgW);
      if (w != null && w > 0) { s.candPowerW += w; s.candPowerMeasured += 1; } else s.candPowerUnmeasured += 1;
    }
  }
  return s;
}

/* ── 포탈 자신의 수집 로그인(8b 반증 F5) ───────────────────────────────
 * 포탈의 OS 수집은 서버마다 5분(집중이면 1분)마다 SSH 로 들어가고 sshd 는 매 접속을 ‘Accepted … for <계정> from <주소>’ 로 남긴다 → 그 줄을 활동으로 세면
 *   로그를 읽는 모든 서버의 ‘활동 흔적’ 이 늘 ‘있음’ 이었다(재현: 수집 계정 줄만 3일 → ssh 864 · act 0). 그래서 SSH 활동은 **수집 계정(+ 대상이 본 출발 주소)을 뺀 것**만 센다.
 *   · 계정: 이 노드 대상의 OS 접속 계정(키 · 공통 계정 참조를 해석한 이름 — withResolvedAuth 결과). 해석 실패 · OS 경로 없음이면 가를 수 없다 → ssh = null(모름 · 분모에서 뺀다).
 *   · 주소: 주 명령이 대상에서 읽은 자기 세션 SSH_CONNECTION 의 첫 칸(parse/linuxHealth ‘sc’ — 다른 프로세스의 환경은 읽지 않는다). 폴러가 주기마다 여기 적는다(인메모리 ·
 *     재시작 뒤 첫 주기 전에는 없다). 주소를 알면 (계정, 주소) 가 같은 줄만 빼고(같은 계정으로 다른 곳에서 들어온 사람은 센다), 모르면 그 계정 줄을 모두 뺀다
 *     — ⚠ 정직 기록: 그때 같은 계정을 쓰는 사람의 접속은 활동에 들지 않는다(적게 보일 수 있다 — 후보가 더 나오는 쪽).
 *   · 상한을 넘겨 ‘(기타)’ 로 접힌 항목이 있고 그 밖에 사람 접속이 0 이면 가를 수 없다 → null.
 */
const OTHER_ITEM = '(기타)';   // logs/classify.js 의 접힘 항목(상한 초과)
const _selfLogin = new Map();   // key → { user, ip, at }
const SELF_LOGIN_MAX = 20_000;
const SELF_LOGIN_TTL_MS = 3 * DAY_MS;
const LOGIN_USER_RE = /^[A-Za-z0-9._@-][A-Za-z0-9._@$-]{0,63}$/;
const LOGIN_IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
export function _resetSelfLoginForTest() { _selfLogin.clear(); }
/** 폴러가 주기마다 — 대상 키 · 접속 계정 · 대상이 본 출발 주소(없으면 null). */
export function noteSelfLogin(key, user, ip, at = Date.now()) {
  const k = String(key || '').slice(0, 256); const u = String(user || '').trim();
  if (!k || !LOGIN_USER_RE.test(u)) return;
  const a = typeof ip === 'string' && LOGIN_IP_RE.test(ip) ? ip : null;
  if (!_selfLogin.has(k) && _selfLogin.size >= SELF_LOGIN_MAX) _selfLogin.delete(_selfLogin.keys().next().value);
  _selfLogin.set(k, { user: u, ip: a, at });
}
/** 대상의 수집 계정 · 주소(순수에 가까움 — 인메모리 기록이 오래됐거나 없으면 대상 등록의 계정 · 주소 없음). 가를 수 없으면 null. */
export function selfLoginOf(key, target, { now = Date.now() } = {}) {
  const rec = _selfLogin.get(String(key));
  const fresh = rec && now - rec.at <= SELF_LOGIN_TTL_MS ? rec : null;
  const oh = target && typeof target === 'object' ? target.osHost : null;
  const regUser = oh && !oh.authError ? String(oh.username || 'root').trim() : '';
  const user = (fresh && (!regUser || fresh.user === regUser)) ? fresh.user : regUser;
  if (!user || !LOGIN_USER_RE.test(user)) return null;
  return { user, ip: fresh && fresh.user === user ? fresh.ip : null };
}
/** log_sec ‘ok’ 항목(`<계정> <주소>` · 횟수) → 사람 접속 수(순수). 가를 수 없으면 null. */
export function humanLogins(items = [], self = null) {
  if (!self || !self.user) return null;
  let human = 0; let folded = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const c = Number(it?.c) || 0; if (c <= 0) continue;
    const item = String(it?.item ?? '');
    if (item === OTHER_ITEM) { folded += c; continue; }
    const sp = item.indexOf(' ');
    const u = sp < 0 ? item : item.slice(0, sp); const ip = sp < 0 ? '' : item.slice(sp + 1);
    if (u === self.user && (!self.ip || ip === self.ip)) continue;
    human += c;
  }
  if (human > 0) return human;
  return folded > 0 ? null : 0;
}

/* ── 이 노드 데이터 읽기 ───────────────────────────────────────── */
/** 활동 흔적(이 노드 메인 DB) — SSH 성공(로그를 읽는 서버만 · 포탈 자신의 수집 로그인 제외 — 위) · 사람이 연 집중 · 스냅샷. 키마다 PK · (key, 시각) 인덱스 범위. */
async function activityReader(agent, since) {
  let db = null;
  try { db = await (await import('./db.js')).mainDb(); } catch { db = null; }
  if (!db) return () => null;
  let cursors = new Set(); let sshQ = null; let focQ = null; let snapQ = null;
  try { cursors = new Set(db.prepare('SELECT key FROM log_cursor WHERE agent=?').all(String(agent)).map((r) => String(r.key))); } catch { cursors = new Set(); }
  // 항목별 합(집계 함수 하나) — 수집 계정 줄을 JS 에서 뺀다.
  try { sshQ = db.prepare("SELECT item, SUM(count) c FROM log_sec WHERE agent=? AND key=? AND hour>=? AND kind='ok' GROUP BY item LIMIT 2000"); } catch { sshQ = null; }
  try { focQ = db.prepare("SELECT COUNT(*) c FROM focus_session WHERE key=? AND created>=? AND agent=? AND trigger_kind='manual'"); } catch { focQ = null; }
  try { snapQ = db.prepare('SELECT COUNT(*) c FROM bm_snapshots WHERE key=? AND at>=? AND agent=?'); } catch { snapQ = null; }
  return (key, target = null) => {
    const k = String(key);
    const one = (q, args) => { try { return q ? Number(q.get(...args)?.c ?? 0) || 0 : null; } catch { return null; } };
    let ssh = null;
    if (cursors.has(k) && sshQ) {
      try { ssh = humanLogins(sshQ.all(String(agent), k, since), selfLoginOf(k, target)); } catch { ssh = null; }
    }
    return { ssh, focus: one(focQ, [k, since, String(agent)]), snap: one(snapQ, [k, since, String(agent)]) };
  };
}
/** 전력 시간 롤업 읽기(이 노드 iDRAC DB — 대상의 등록부 id). */
async function powerReader() {
  let idb = null;
  try { idb = await (await import('../idrac/db.js')).getDb(); } catch { idb = null; }
  return (target, from, to) => {
    const id = String(target?.idrac?.regId || '').trim();
    if (!id || !idb?.hourlyStats) return null;
    try { return powerStats(idb.hourlyStats(id, from, to)); } catch { return null; }
  };
}

/**
 * 서버 하나 계산(하루 계산 · 시험이 같은 함수).
 * @returns {Promise<object>} 행
 */
export async function computeIdleServer({ agent = '', target, now = Date.now(), cfg = {}, judge = null, deps = {} } = {}) {
  const c = { ...IDLE_DEFAULTS, ...cfg };
  const M = deps.monthStore || await import('./monthStore.js');
  const from = now - c.windowDays * DAY_MS;
  const dr = await M.readDailyRange({ agent, key: target.key, from, to: now }).catch(() => ({ live: [], mig: [] }));
  const daily = new Map();
  for (const r of dr.live || []) daily.set(r.day, r);
  for (const r of dr.mig || []) daily.set(r.day, M.mergeDailyRows ? M.mergeDailyRows(daily.get(r.day), r) : (daily.get(r.day) || r));
  const { excludedDays } = dayExclusion(judge ? judge.cover(target, from, now, 'exclude') : [], from, now);
  const today = dayKey(now);
  const kept = [...daily.values()].filter((r) => r.day !== today && !excludedDays.has(r.day)).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const metrics = windowMetrics(kept, { periodicHighPct: c.periodicHighPct });
  const power = deps.powerOf ? deps.powerOf(target, from, now) : null;
  const activity = deps.activityOf ? deps.activityOf(target.key, target) : null;
  const ms = judge ? judge.stateFor(target, now) : null;
  const sc = scoreIdle({ metrics, power, activity, cfg: c, maintActive: !!ms?.active });
  return {
    key: target.key, name: String(target.name || target.key).slice(0, 256), vcenterId: String(target.vcenterId || ''), ...sc,
    days: metrics.days, excludedDays: excludedDays.size,
    metrics: { cpuAvg: metrics.cpuAvg, cpuMax: metrics.cpuMax, memAvg: metrics.memAvg, diskMax: metrics.diskMax, netMax: metrics.netMax,
      powerAvgW: power?.avgW ?? null, powerMinW: power?.minW ?? null, powerHours: power?.hours ?? null,
      ssh: activity?.ssh ?? null, focus: activity?.focus ?? null, snap: activity?.snap ?? null },
  };
}

/** 저장(원자 쓰기) · 읽기(손상 보존). */
export function saveIdle(obj) { atomicWriteFileSync(FILE(), JSON.stringify(obj), { mode: 0o600 }); _cache = null; }
let _cache = null;
export function loadIdle() {
  let st = null;
  try { st = fs.statSync(FILE()); } catch { return null; }
  if (_cache && _cache.m === st.mtimeMs && _cache.s === st.size) return _cache.data;
  try {
    const o = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) throw new Error('형식이 다릅니다');
    _cache = { m: st.mtimeMs, s: st.size, data: o };
    return o;
  } catch (e) { preserveCorrupt(FILE(), String(e?.message || e)); _cache = null; return { unreadable: true, rows: [], at: 0 }; }
}
/** 다시 계산할 때인가(순수 — 용량 예측과 같은 규칙 · 01:20). */
export function dueForIdle(cur, now = Date.now()) {
  if (!cur || cur.unreadable || !cur.day) return true;
  const minOfDay = Math.floor((((now + DAY_OFFSET_MIN * 60_000) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
  if (cur.day !== dayKey(now) && minOfDay >= RECOMPUTE_AFTER_MIN) return true;
  return now - (Number(cur.at) || 0) > 25 * 3_600_000;
}
/** 후보 진입 · 이탈 → 변경 이벤트(순수 — 직전 결과가 없으면 이벤트 없음 · 기준만). */
export function idleTransitions(prevRows = [], rows = [], { now = Date.now() } = {}) {
  if (!Array.isArray(prevRows) || !prevRows.length) return [];
  const prev = new Map(prevRows.map((r) => [targetIdOf(r), r]));
  const out = [];
  for (const r of rows) {
    const p = prev.get(targetIdOf(r));
    if (!p) continue;
    const was = p.status === 'candidate'; const is = r.status === 'candidate';
    if (was === is) continue;
    out.push({ key: r.key, at: now, events: [{ ts: now, kind: 'idle', item: '저활용 후보', before: was ? `후보 ${p.score ?? '—'}점` : `${p.status} ${p.score ?? '—'}점`, after: is ? `후보 ${r.score ?? '—'}점` : `${r.status} ${r.score ?? '—'}점` }] });
  }
  return out;
}

/**
 * 후보 시작일 · 이탈일 이어 쓰기(순수 · 제자리) — 후보가 계속이면 직전 candSince, 새로 후보면 오늘 · 후보에서 나가면 candLeft = 오늘(30일 동안 이어 쓴다).
 *   함대 ‘지난 30일 진입 · 이탈’ 은 이 두 날로 센다(행 단위 — 범위 계정도 자기 법인 행만으로 셀 수 있다).
 */
export function carryCandidacy(prevRows = [], rows = [], day) {
  const prev = new Map((Array.isArray(prevRows) ? prevRows : []).map((r) => [targetIdOf(r), r]));
  const cut = new Date(Date.parse(`${day}T00:00:00Z`) - 30 * DAY_MS).toISOString().slice(0, 10);
  for (const r of rows) {
    const p = prev.get(targetIdOf(r)) || null;
    if (r.status === 'candidate') r.candSince = p?.status === 'candidate' ? (p.candSince || day) : day;
    else if (p?.status === 'candidate') r.candLeft = day;
    else if (typeof p?.candLeft === 'string' && p.candLeft >= cut) r.candLeft = p.candLeft;
  }
  return rows;
}

let _running = null;
/**
 * 이 노드의 대상 전부를 계산해 저장(하루 1회 — 폴러 틱이 부른다 · 진행 중이면 공유) · 대상 사이 시간 기준 양보 · 후보 진입/이탈은 변경 이벤트.
 * @returns {Promise<{ok:boolean, rows?:number, ms?:number, skipped?:string, events?:number}>}
 */
export async function recomputeIdle({ targets = null, now = Date.now(), force = false, deps = {} } = {}) {
  if (_running) return _running;
  _running = (async () => {
    const t0 = Date.now();
    try {
      const cur = loadIdle();
      if (!force && !dueForIdle(cur, now)) return { ok: true, skipped: 'not-due' };
      const rules = deps.rules || loadPerfRules();
      const cfg = { ...IDLE_DEFAULTS, ...(rules.idle || {}) };
      if (cfg.on === false) return { ok: true, skipped: 'off' };
      const agent = config.agent?.name || '';
      const tg = (targets || await localTargets()).filter((x) => x?.key);
      const judge = deps.judge || await maintJudge({ now }).catch(() => null);
      const powerOf = deps.powerOf || await powerReader();
      const actOf = deps.activityOf || await activityReader(agent, now - cfg.windowDays * DAY_MS);
      const y = deps.yielder || createYielder(15);
      const rows = [];
      for (const target of tg.slice(0, IDLE_ROWS_MAX)) {
        rows.push(await computeIdleServer({ agent, target, now, cfg, judge, deps: { ...deps, powerOf, activityOf: actOf } }));
        await y();
      }
      const day = dayKey(now);
      carryCandidacy(cur && !cur.unreadable ? cur.rows : [], rows, day);
      const sum = summarizeIdle(rows);
      const history = [...(Array.isArray(cur?.history) ? cur.history.filter((h) => h && h.day !== day) : []), { day, candidate: sum.candidate, watch: sum.watch, active: sum.active, periodic: sum.periodic, excluded: sum.excluded }].slice(-HISTORY_DAYS);
      const firstDay = cur && !cur.unreadable && typeof cur.firstDay === 'string' && cur.firstDay < day ? cur.firstDay : day;
      const out = { v: 1, at: Date.now(), day, firstDay, cfg, rows, history, servers: tg.length, truncated: tg.length > IDLE_ROWS_MAX ? tg.length - IDLE_ROWS_MAX : 0, ms: Date.now() - t0 };
      const trans = idleTransitions(cur && !cur.unreadable ? cur.rows : [], rows, { now });
      saveIdle(out);
      let events = 0;
      if (trans.length) {
        try { const O = deps.opsDb || await import('./opsDb.js'); const w = await O.changeWriteBatch({ agent, items: trans, latest: false }); events = w?.events ?? 0; } catch { events = 0; }
      }
      console.log(`[bmusage] 저활용 다시 계산 — 서버 ${tg.length}대 · 후보 ${sum.candidate} · 관찰 ${sum.watch} · 제외 ${sum.excluded} · ${out.ms}ms${events ? ` · 후보 진입/이탈 ${events}건` : ''}`);
      return { ok: true, rows: rows.length, ms: out.ms, events };
    } catch (e) {
      console.warn(`[bmusage] 저활용 계산 실패(지난 결과 유지): ${String(e?.message || e).slice(0, 200)}`);
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    } finally { _running = null; }
  })();
  return _running;
}
export function idleRunning() { return !!_running; }
export function _resetIdleForTest() { _cache = null; _running = null; try { fs.unlinkSync(FILE()); } catch { /* */ } }
