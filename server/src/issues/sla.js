/**
 * issues/sla.js — 이슈 SLA 시계(v2.888 · 시안 ⑩ 'SLA 시계' · C-3). 순수 — 저장하지 않고 **이력에서 계산**한다.
 *
 * 목표(설정 › 이슈 `sla`): 우선순위마다 '응답'(분) · '해결'(분). 적용 유형(기본 장애 · 요청 — 작업 · 개선 · 에픽은 끔). 기본은 **꺼짐**
 * (켜기 전에는 배지 · 알림이 없다 — 28개 법인 포탈이 업그레이드 직후 갑자기 초과 알림을 보내지 않게).
 *
 * 시각은 이슈의 이력 · 댓글에서 읽는다(필드를 새로 쌓지 않는다 — 예전 이슈에도 같은 규칙):
 *  · 응답 = 처음으로 진행 중 · 검토 · 완료로 옮긴 때, 또는 보고자가 아닌 사람이 처음 댓글을 단 때 중 이른 쪽.
 *  · 해결 = 완료(closedAt). 완료에서 다시 열면 시계가 이어진다(지난 완료 시각은 쓰지 않는다).
 *  · **보류(blocked) 중에는 멈춘다** — 이력의 'blocked' 줄(켬 · 해제)로 구간을 만들고, 지금 보류 중이면 그 시각부터.
 *  · 기본은 달력 시간(24×7). v2.908(기능 8): 설정 `calendar.mode = 'business'` 면 **업무 시간만** 센다 — 요일 · 시작/끝 시각 · 휴일(포탈 공통) ·
 *    시간대(기본 Asia/Seoul) · **법인별 시간대 · 휴일**(byVcenter — 폴란드 · 미국 동부 법인의 P2 가 한국 밤에 초과로 찍히지 않게).
 *    시간대 오프셋은 Intl 로 그 날 정오에 한 번 읽어 캐시한다(서머타임 전환은 새벽이라 업무 시간 창에 영향이 없다). 하루씩 세므로 10년(3,660일)을 넘는
 *    구간은 앞을 자른다(그 길이면 어느 목표든 이미 넘었다).
 *  · 이력은 이슈마다 300줄까지라 넘쳐 지워진 줄이 있으면(historyDropped) 결과에 `partial` 을 붙인다(조용히 정확한 척하지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

export const SLA_TYPES = Object.freeze(['incident', 'task', 'request', 'improve']); // 에픽은 SLA 대상이 아니다
export const SLA_PRIOS = Object.freeze(['p0', 'p1', 'p2', 'p3']);
export const SLA_MAX_MIN = 60 * 24 * 90; // 목표 상한 90일
export const CAL_LIMITS = Object.freeze({ holidays: 200, byVcenter: 100, tz: 64 });
export const DEFAULT_TZ = 'Asia/Seoul';
export function defaultCalendar() { return { mode: '24x7', startMin: 540, endMin: 1080, days: [1, 2, 3, 4, 5], holidays: [], tz: DEFAULT_TZ, byVcenter: {} }; }
export function defaultSla() {
  return {
    enabled: false, types: ['incident', 'request'], warnPct: 80,
    targets: { p0: { respondMin: 15, resolveMin: 240 }, p1: { respondMin: 60, resolveMin: 1440 }, p2: { respondMin: 240, resolveMin: 4320 }, p3: { respondMin: 1440, resolveMin: 10080 } },
    calendar: defaultCalendar(),
  };
}
/** IANA 시간대 이름인가(Intl 이 아는 것만). */
export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > CAL_LIMITS.tz || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const validDate = (s) => { const m = DATE_RE.exec(String(s || '')); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
// eslint-disable-next-line no-control-regex
const VC_KEY_RE = /^[^\s\u0000-\u001f\u007f]{1,128}$/;
/** 업무 시간 달력 좁히기 — strict 면 400. 휴일은 'YYYY-MM-DD'(정렬 · 중복 제거). */
export function normalizeCalendar(raw, { strict = true } = {}) {
  const d = defaultCalendar();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bad = (field, msg) => { if (strict) throw fieldError(field, msg); };
  const mode = r.mode == null ? d.mode : (['24x7', 'business'].includes(r.mode) ? r.mode : (bad('sla.calendar.mode', '24x7 · business 중 하나여야 합니다'), d.mode));
  const minOf = (v, def, field) => {
    if (v == null || v === '') return def;
    const n = typeof v === 'number' || typeof v === 'string' ? numOrNull(v) : null;
    if (Number.isInteger(n) && n >= 0 && n <= 1440) return n;
    bad(field, '0~1440 분 정수여야 합니다'); return def;
  };
  let startMin = minOf(r.startMin, d.startMin, 'sla.calendar.startMin');
  let endMin = minOf(r.endMin, d.endMin, 'sla.calendar.endMin');
  if (endMin <= startMin) { bad('sla.calendar.endMin', '끝 시각이 시작 시각보다 뒤여야 합니다(밤을 넘는 업무 시간은 지원하지 않습니다)'); startMin = d.startMin; endMin = d.endMin; }
  let days = d.days;
  if (r.days != null) {
    const list = Array.isArray(r.days) ? r.days : null;
    if (!list || list.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) bad('sla.calendar.days', '요일은 0(일)~6(토) 정수 배열이어야 합니다');
    const ok = [...new Set((list || []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort();
    if (ok.length) days = ok; else bad('sla.calendar.days', '업무 요일이 하루 이상 있어야 합니다');
  }
  const hol = (v, field) => {
    if (v == null) return [];
    const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[\s,]+/) : null);
    if (!list) { bad(field, '날짜 배열이어야 합니다'); return []; }
    const out = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))];
    const good = out.filter(validDate);
    if (good.length < out.length) bad(field, `‘${capStr(out.find((x) => !validDate(x)), 20)}’ 는 YYYY-MM-DD 날짜가 아닙니다`);
    if (good.length > CAL_LIMITS.holidays) bad(field, `휴일은 ${CAL_LIMITS.holidays}개까지입니다`);
    return good.sort().slice(-CAL_LIMITS.holidays);
  };
  const holidays = hol(r.holidays, 'sla.calendar.holidays');
  let tz = d.tz;
  if (r.tz != null && r.tz !== '') { if (validTz(r.tz)) tz = r.tz; else bad('sla.calendar.tz', `‘${capStr(String(r.tz), 40)}’ 는 알 수 없는 시간대입니다(예: Asia/Seoul · Europe/Warsaw · America/New_York)`); }
  const byVcenter = {};
  const bv = r.byVcenter && typeof r.byVcenter === 'object' && !Array.isArray(r.byVcenter) ? Object.entries(r.byVcenter) : [];
  if (bv.length > CAL_LIMITS.byVcenter) bad('sla.calendar.byVcenter', `법인별 설정은 ${CAL_LIMITS.byVcenter}개까지입니다`);
  for (const [vc, v] of bv.slice(0, CAL_LIMITS.byVcenter)) {
    if (!VC_KEY_RE.test(vc) || !v || typeof v !== 'object') { bad('sla.calendar.byVcenter', '법인 id 형식이 아닙니다'); continue; }
    const one = {};
    if (v.tz != null && v.tz !== '') { if (validTz(v.tz)) one.tz = v.tz; else bad(`sla.calendar.byVcenter.${capStr(vc, 40)}.tz`, `‘${capStr(String(v.tz), 40)}’ 는 알 수 없는 시간대입니다`); }
    if (v.holidays != null) one.holidays = hol(v.holidays, `sla.calendar.byVcenter.${capStr(vc, 40)}.holidays`); // 있으면 공통 휴일 대신 이것
    if (one.tz || one.holidays) byVcenter[vc] = one;
  }
  return { mode, startMin, endMin, days, holidays, tz, byVcenter };
}
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }

/** 설정 좁히기 — strict 면 400, 아니면 기본값으로(파일 읽기). 목표 0 은 '그 단계는 보지 않음'. */
export function normalizeSla(raw, { strict = true } = {}) {
  const d = defaultSla();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bad = (field, msg) => { if (strict) throw fieldError(field, msg); };
  const types = Array.isArray(r.types) ? [...new Set(r.types.filter((t) => { const ok = SLA_TYPES.includes(t); if (!ok) bad('sla.types', `알 수 없는 유형 ‘${String(t).slice(0, 20)}’`); return ok; }))] : d.types;
  let warnPct = d.warnPct;
  if (r.warnPct != null) { const n = Number(r.warnPct); if (Number.isInteger(n) && n >= 50 && n <= 99) warnPct = n; else bad('sla.warnPct', '임박 기준은 50~99(%) 정수여야 합니다'); }
  const targets = {};
  for (const p of SLA_PRIOS) {
    const t = r.targets && typeof r.targets === 'object' ? r.targets[p] : null;
    const one = (k) => {
      if (t == null || t[k] == null || (typeof t[k] === 'string' && !t[k].trim())) return d.targets[p][k];
      // v2.904 점검 S-10: Number(' ')·Number([]) 는 0(= 그 단계 보지 않음) — 수 · 숫자 글자만 받는다(numOrNull 규칙)
      const n = typeof t[k] === 'number' || typeof t[k] === 'string' ? numOrNull(t[k]) : null;
      if (!Number.isInteger(n) || n < 0 || n > SLA_MAX_MIN) { bad(`sla.targets.${p}.${k}`, `0~${SLA_MAX_MIN} 분 정수여야 합니다(0 = 보지 않음)`); return d.targets[p][k]; }
      return n;
    };
    targets[p] = { respondMin: one('respondMin'), resolveMin: one('resolveMin') };
  }
  let calendar;
  try { calendar = normalizeCalendar(r.calendar, { strict }); } catch (e) { if (strict) throw e; calendar = normalizeCalendar(r.calendar, { strict: false }); }
  return { enabled: r.enabled === true, types, warnPct, targets, calendar };
}

/* ───── 업무 시간(v2.908 기능 8) ───── */
const DAY = 86_400_000;
export const CAL_MAX_DAYS = 3660;
const fmtCache = new Map();
const offCache = new Map(); // tz → Map<지역 날짜, 오프셋 분>
/** 그 순간 시간대의 UTC 오프셋(분 — 동쪽이 +). */
export function tzOffsetMin(tz, utcMs) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); fmtCache.set(tz, f); }
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}
/** 지역 날짜(1970-01-01 부터 일 수)의 정오 기준 오프셋 — 캐시. */
function dayOffset(tz, day) {
  let m = offCache.get(tz);
  if (!m) { if (offCache.size > 200) offCache.clear(); m = new Map(); offCache.set(tz, m); }
  let o = m.get(day);
  if (o == null) {
    const noon = day * DAY + 12 * 3_600_000;
    const o0 = tzOffsetMin(tz, noon);
    o = tzOffsetMin(tz, noon - o0 * 60_000);
    if (m.size > 20_000) m.clear();
    m.set(day, o);
  }
  return o;
}
const dayNumOf = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
/** 이슈의 법인에 맞춘 달력(업무 시간이 아니면 null). 설정 객체마다 캐시. */
const calCache = new WeakMap();
export function calendarFor(sla, vcenterId = '') {
  const c = sla?.calendar;
  if (!c || c.mode !== 'business') return null;
  let m = calCache.get(c);
  if (!m) { m = new Map(); calCache.set(c, m); }
  const k = String(vcenterId || '');
  let r = m.get(k);
  if (!r) {
    const o = (k && c.byVcenter?.[k]) || {};
    r = { tz: o.tz || c.tz || DEFAULT_TZ, startMin: c.startMin, endMin: c.endMin, days: new Set(c.days || []), holidays: new Set((o.holidays || c.holidays || []).map(dayNumOf)) };
    m.set(k, r);
  }
  return r;
}
const workDay = (day, cal) => cal.days.has((((day + 4) % 7) + 7) % 7) && !cal.holidays.has(day); // 1970-01-01 은 목요일(4) · 휴일은 날짜 번호로
/** a → b 사이 업무 시간(ms). */
export function businessMs(a, b, cal) {
  if (!(b > a)) return 0;
  const from = Math.max(a, b - CAL_MAX_DAYS * DAY);
  let total = 0;
  const first = Math.floor((from + dayOffset(cal.tz, Math.floor(from / DAY)) * 60_000) / DAY) - 1;
  const last = Math.floor((b + dayOffset(cal.tz, Math.floor(b / DAY)) * 60_000) / DAY) + 1;
  for (let day = first; day <= last; day += 1) {
    if (!workDay(day, cal)) continue;
    const o = dayOffset(cal.tz, day) * 60_000;
    const s = Math.max(day * DAY + cal.startMin * 60_000 - o, from);
    const e = Math.min(day * DAY + cal.endMin * 60_000 - o, b);
    if (e > s) total += e - s;
  }
  return total;
}
/** t 에서 업무 시간 min 분 뒤의 시각(못 찾으면 null — 업무일이 3,660일 안에 없다). */
export function addBusinessMin(t, min, cal) {
  let left = Math.max(0, min) * 60_000;
  const start = Math.floor((t + dayOffset(cal.tz, Math.floor(t / DAY)) * 60_000) / DAY) - 1;
  for (let day = start; day <= start + CAL_MAX_DAYS; day += 1) {
    if (!workDay(day, cal)) continue;
    const o = dayOffset(cal.tz, day) * 60_000;
    const ws = day * DAY + cal.startMin * 60_000 - o;
    const we = day * DAY + cal.endMin * 60_000 - o;
    const s = Math.max(ws, t);
    if (we <= s) continue;
    if (left <= we - s) return s + left;
    left -= we - s;
  }
  return null;
}

const RESPONSE_STATUS = new Set(['progress', 'review', 'done']);
/** 이력 · 댓글에서 응답 시각 · 보류 구간을 읽는다. */
export function slaTimes(x, now = Date.now()) {
  const created = Number(x.createdAt) || 0;
  let respondedAt = null;
  const hist = Array.isArray(x.history) ? x.history : [];
  const pauses = [];
  let open = null;
  for (const h of hist) {
    const at = Number(h?.at);
    if (!Number.isFinite(at)) continue;
    if (h.field === 'status' && RESPONSE_STATUS.has(h.to) && (respondedAt == null || at < respondedAt)) respondedAt = at;
    if (h.field === 'blocked') {
      if (h.to) { if (open == null) open = at; } else if (open != null) { pauses.push([open, at]); open = null; }
    }
  }
  if (x.blocked) { const b = Number(x.blocked.at); pauses.push([open ?? (Number.isFinite(b) ? b : now), null]); }
  else if (open != null) pauses.push([open, null]); // 이력과 지금 상태가 어긋나면(해제 줄이 지워짐) 열린 채로 둔다 — partial 이 함께 붙는다
  // 만들 때부터 진행 중 · 검토 · 완료로 만든 이슈 — 상태를 바꾼 줄이 하나도 없으면 만든 시각을 응답으로 본다(상태는 setStatus 만 바꾸고 그때 줄을 남긴다)
  if (respondedAt == null && RESPONSE_STATUS.has(x.status) && !hist.some((h) => h?.field === 'status')) respondedAt = created;
  for (const c of Array.isArray(x.comments) ? x.comments : []) {
    const at = Number(c?.createdAt);
    if (Number.isFinite(at) && c.author && c.author !== x.reporter && (respondedAt == null || at < respondedAt)) respondedAt = at;
  }
  return { created, respondedAt, resolvedAt: x.status === 'done' && Number.isFinite(Number(x.closedAt)) ? Number(x.closedAt) : null, pauses, paused: !!x.blocked };
}
/** created → t 사이에서 멈춘 시간을 뺀 '흐른 분'. cal 이 있으면 업무 시간만(v2.908). */
export function usedMin(created, t, pauses, cal = null) {
  const span = (a, b) => (cal ? businessMs(a, b, cal) : Math.max(0, b - a));
  let ms = span(created, t);
  for (const [s, e0] of pauses) {
    const e = e0 == null ? t : e0;
    const a = Math.max(s, created); const b = Math.min(e, t);
    if (b > a) ms -= span(a, b);
  }
  return Math.max(0, ms) / 60_000;
}

/**
 * 이슈 하나의 SLA. 꺼져 있거나 대상이 아니면 null.
 * 단계(응답 · 해결)마다 { targetMin, usedMin, at, state: 'met'|'late'|'breached'|'warning'|'running'|'paused'|'off', dueAt }
 *  · met: 목표 안에 했다 · late: 했지만 늦었다 · breached: 아직 안 했고 넘었다 · warning: warnPct 이상 · running · paused(보류 중 — 넘지 않았을 때)
 *  · dueAt: 지금 흐르는 중일 때만(보류 중이면 null — 언제 끝날지 모른다).
 * 전체 state: breached > late(해결이 늦게 끝남) > warning > paused > running > met.
 */
export function slaOf(x, sla, now = Date.now()) {
  if (!sla?.enabled || !x || x.type === 'epic' || !(sla.types || []).includes(x.type)) return null;
  const tg = sla.targets?.[x.priority];
  if (!tg) return null;
  const t = slaTimes(x, now);
  const cal = calendarFor(sla, x.vcenterId);
  const warn = (Number(sla.warnPct) || 80) / 100;
  const stage = (targetMin, at) => {
    if (!targetMin) return { targetMin: 0, usedMin: null, at, state: 'off', dueAt: null };
    if (at != null) { const u = usedMin(t.created, at, t.pauses, cal); return { targetMin, usedMin: Math.round(u), at, state: u <= targetMin ? 'met' : 'late', dueAt: null }; }
    const u = usedMin(t.created, now, t.pauses, cal);
    const state = u > targetMin ? 'breached' : t.paused ? 'paused' : u >= targetMin * warn ? 'warning' : 'running';
    // 업무 시간이면 남은 분을 업무 시간으로 더한다(밤 · 주말 · 휴일을 건너뛴다)
    const due = state === 'breached' || t.paused ? null : (cal ? addBusinessMin(now, targetMin - u, cal) : now + (targetMin - u) * 60_000);
    return { targetMin, usedMin: Math.round(u), at: null, state, dueAt: due == null ? null : Math.round(due) };
  };
  const respond = stage(tg.respondMin, t.respondedAt);
  const resolve = stage(tg.resolveMin, t.resolvedAt);
  const order = ['breached', 'late', 'warning', 'paused', 'running', 'met', 'off'];
  const states = [respond.state, resolve.state];
  // 응답이 늦었더라도(late) 해결이 아직이면 지금 볼 것은 해결 쪽 — 전체 state 에는 응답 late 를 넣지 않는다(상세에 따로 보인다)
  const pick = [resolve.state, respond.state === 'late' ? 'met' : respond.state];
  const state = order.find((s) => pick.includes(s)) || 'off';
  return { respond, resolve, state, paused: t.paused, partial: (Number(x.historyDropped) || 0) > 0, anyLate: states.includes('late'), calendar: cal ? { mode: 'business', tz: cal.tz } : null };
}
/** 검색식 'sla = …' 값 — breached(지금 넘음) · warning · paused · ok(지켜지는 중 · 지킴) · late(늦게 끝남) · none(대상 아님). */
export function slaQueryState(s) {
  if (!s) return 'none';
  if (s.state === 'breached') return 'breached';
  if (s.state === 'warning') return 'warning';
  if (s.state === 'paused') return 'paused';
  if (s.anyLate) return 'late';
  return 'ok';
}
