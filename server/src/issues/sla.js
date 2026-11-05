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
 *  · 달력 시간(24×7)이다 — 업무 시간 · 휴일 달력은 이번 범위 밖(화면이 그 사실을 적는다).
 *  · 이력은 이슈마다 300줄까지라 넘쳐 지워진 줄이 있으면(historyDropped) 결과에 `partial` 을 붙인다(조용히 정확한 척하지 않는다).
 */
import { numOrNull } from '../util/numOrNull.js';

export const SLA_TYPES = Object.freeze(['incident', 'task', 'request', 'improve']); // 에픽은 SLA 대상이 아니다
export const SLA_PRIOS = Object.freeze(['p0', 'p1', 'p2', 'p3']);
export const SLA_MAX_MIN = 60 * 24 * 90; // 목표 상한 90일
export function defaultSla() {
  return {
    enabled: false, types: ['incident', 'request'], warnPct: 80,
    targets: { p0: { respondMin: 15, resolveMin: 240 }, p1: { respondMin: 60, resolveMin: 1440 }, p2: { respondMin: 240, resolveMin: 4320 }, p3: { respondMin: 1440, resolveMin: 10080 } },
  };
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
      // v2.902 점검 S-10: Number(' ')·Number([]) 는 0(= 그 단계 보지 않음) — 수 · 숫자 글자만 받는다(numOrNull 규칙)
      const n = typeof t[k] === 'number' || typeof t[k] === 'string' ? numOrNull(t[k]) : null;
      if (!Number.isInteger(n) || n < 0 || n > SLA_MAX_MIN) { bad(`sla.targets.${p}.${k}`, `0~${SLA_MAX_MIN} 분 정수여야 합니다(0 = 보지 않음)`); return d.targets[p][k]; }
      return n;
    };
    targets[p] = { respondMin: one('respondMin'), resolveMin: one('resolveMin') };
  }
  return { enabled: r.enabled === true, types, warnPct, targets };
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
/** created → t 사이에서 멈춘 시간을 뺀 '흐른 분'. */
export function usedMin(created, t, pauses) {
  let ms = Math.max(0, t - created);
  for (const [s, e0] of pauses) {
    const e = e0 == null ? t : e0;
    const a = Math.max(s, created); const b = Math.min(e, t);
    if (b > a) ms -= b - a;
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
  const warn = (Number(sla.warnPct) || 80) / 100;
  const stage = (targetMin, at) => {
    if (!targetMin) return { targetMin: 0, usedMin: null, at, state: 'off', dueAt: null };
    if (at != null) { const u = usedMin(t.created, at, t.pauses); return { targetMin, usedMin: Math.round(u), at, state: u <= targetMin ? 'met' : 'late', dueAt: null }; }
    const u = usedMin(t.created, now, t.pauses);
    const state = u > targetMin ? 'breached' : t.paused ? 'paused' : u >= targetMin * warn ? 'warning' : 'running';
    return { targetMin, usedMin: Math.round(u), at: null, state, dueAt: state === 'breached' || t.paused ? null : Math.round(now + (targetMin - u) * 60_000) };
  };
  const respond = stage(tg.respondMin, t.respondedAt);
  const resolve = stage(tg.resolveMin, t.resolvedAt);
  const order = ['breached', 'late', 'warning', 'paused', 'running', 'met', 'off'];
  const states = [respond.state, resolve.state];
  // 응답이 늦었더라도(late) 해결이 아직이면 지금 볼 것은 해결 쪽 — 전체 state 에는 응답 late 를 넣지 않는다(상세에 따로 보인다)
  const pick = [resolve.state, respond.state === 'late' ? 'met' : respond.state];
  const state = order.find((s) => pick.includes(s)) || 'off';
  return { respond, resolve, state, paused: t.paused, partial: (Number(x.historyDropped) || 0) > 0, anyLate: states.includes('late') };
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
