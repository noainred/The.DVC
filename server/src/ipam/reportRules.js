/**
 * ipam/reportRules.js — IP 관리 정기 보고(IPMS 알람)의 설정 · 회차 · 법인 시간대(순수 · v3.7.0 재설계 묶음 라 — 설계 docs/design/ipam-redesign ⑫ ⑬ · §3.4).
 *
 * 사용자 결정(2026-11-13): 기본 **매주 일요일 09:00 · 전체 종합 + 법인별**. 옵션 — 메인 서버 시각으로 실행 / 법인 현지 시각으로 실행
 * (현지 시각이면 법인마다 그곳의 그 요일 · 시각에 보내고 전체 종합은 메인 서버 시각).
 * ⚠ 중앙은 엣지의 시간대를 모른다(엣지가 보내지 않는다 — 법인 설정에도 칸이 없다). 그래서 '법인 현지 시각' 은 이 설정의 법인별 시간대(IANA 이름,
 *   예 Europe/Warsaw)로 계산한다 — 비어 있으면 메인 서버 시각. 화면이 그 사실을 말한다.
 * 회차 · 놓침 규칙은 아이실론 종합 메일과 같다(isidu/digestRules.planDigestTick — 놓친 회차는 몰아서 보내지 않는다 · 저장 직후 지난 회차를 소급하지 않는다(since)).
 */
import { planDigestTick, nextDigestSlots } from '../isidu/digestRules.js';
import { normalizeMailList, isEmail, MAIL_LIST_MAX } from '../isidu/mailRules.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const REPORT_FREQS = Object.freeze(['weekly', 'daily']);
/** 넣을 내용(시안 ⑫ — 켜고 끈다). 키 순서가 메일 절 순서다. */
export const REPORT_SECTIONS = Object.freeze([
  ['summary', '한 줄 요약 · 수치'], ['subnets', '대역 사용률(지난 보고 대비)'], ['full', '가득 찬 대역'], ['newIp', '새로 응답한 미등록 IP'],
  ['changes', 'MAC 변경 · 호스트명 변경 · 예약 IP 사용'], ['conflict', '충돌 의심'], ['issues', '조치 필요(중복 · DNS 불일치)'], ['scan', '수집 상태(스캔 에이전트)'],
]);
export const REPORT_DEFAULTS = Object.freeze({ enabled: false, freq: 'weekly', days: [0], time: '09:00', clock: 'main', includeAdmin: true, to: [], fullPct: 90, corps: {} });
const CORP_MAX = 200;

/** IANA 시간대 이름이 이 서버(ICU)에서 쓸 수 있는가. */
export function validTimeZone(tz) {
  const s = String(tz || '').trim();
  if (!s || s.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(s)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: s }); return true; } catch { return false; }
}
/** 그 시간대의 UTC 와의 차이(분, 동쪽 +) — at 시점. 못 쓰는 이름이면 null. */
export function tzOffsetMin(tz, at = Date.now()) {
  if (!validTimeZone(tz)) return null;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(at)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - Math.floor(at / 60000) * 60000) / 60000);
  } catch { return null; }
}

/** 저장 값 → 쓰는 값(옛 · 손상 값도 안전하게). */
export function reportOf(raw) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const freq = REPORT_FREQS.includes(d.freq) ? d.freq : REPORT_DEFAULTS.freq;
  const days = freq === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : (Array.isArray(d.days) ? [...new Set(d.days.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : [...REPORT_DEFAULTS.days]);
  const sections = {};
  for (const [k] of REPORT_SECTIONS) sections[k] = d.sections?.[k] !== false;
  const corps = {};
  for (const [id, c] of Object.entries(d.corps && typeof d.corps === 'object' ? d.corps : {}).slice(0, CORP_MAX)) {
    if (!id || !c || typeof c !== 'object') continue;
    corps[id] = { to: (Array.isArray(c.to) ? c.to : []).filter(isEmail).slice(0, MAIL_LIST_MAX), tz: validTimeZone(c.tz) ? String(c.tz).trim() : '' };
  }
  const fp = numOrNull(d.fullPct);
  const since = numOrNull(d.since);
  return {
    enabled: d.enabled === true, freq, days, time: TIME_RE.test(String(d.time || '')) ? String(d.time) : REPORT_DEFAULTS.time,
    clock: d.clock === 'corp' ? 'corp' : 'main', includeAdmin: d.includeAdmin !== false,
    to: (Array.isArray(d.to) ? d.to : []).filter(isEmail).slice(0, MAIL_LIST_MAX), fullPct: fp != null && fp >= 50 && fp <= 100 ? fp : REPORT_DEFAULTS.fullPct,
    sections, corps, since: since != null && since > 0 ? since : null,
  };
}

/**
 * 저장 경로 정규화. 잘못된 값은 자르지 않고 { error, field }(주소 형식 · 요일 없음 · 시간대 이름).
 * @returns {{ report: object } | { error: string, field: string }}
 */
export function normalizeReport(input, prev, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '정기 보고 설정 형식이 잘못됐습니다.', field: 'report' };
  const p = reportOf(prev);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : p.enabled;
  const freq = input.freq == null ? p.freq : String(input.freq);
  if (!REPORT_FREQS.includes(freq)) return { error: '주기는 매일 또는 매주입니다.', field: 'freq' };
  const days = freq === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : p.days;
  if (enabled && !days.length) return { error: '보고를 보낼 요일을 하나 이상 고르세요.', field: 'days' };
  const time = input.time == null ? p.time : String(input.time).trim();
  if (!TIME_RE.test(time)) return { error: '보내는 시각은 00:00~23:59 형식이어야 합니다.', field: 'time' };
  const clock = input.clock == null ? p.clock : input.clock === 'corp' ? 'corp' : input.clock === 'main' ? 'main' : null;
  if (!clock) return { error: '기준 시각은 메인 서버 또는 법인 현지입니다.', field: 'clock' };
  const to = input.to == null ? { list: p.to, invalid: [], over: 0 } : normalizeMailList(input.to);
  if (to.invalid.length) return { error: `전체 종합 받는 사람 주소 형식이 잘못됐습니다: ${to.invalid.slice(0, 3).join(', ')}`, field: 'to' };
  if (to.over) return { error: `받는 사람은 ${MAIL_LIST_MAX}명까지입니다.`, field: 'to' };
  let fullPct = p.fullPct;
  if (input.fullPct != null && input.fullPct !== '') {
    const n = Number(input.fullPct);
    if (!Number.isFinite(n) || n < 50 || n > 100) return { error: '가득 찬 대역 기준은 50~100% 입니다.', field: 'fullPct' };
    fullPct = n;
  }
  let corps = p.corps;
  if (input.corps != null) {
    if (typeof input.corps !== 'object' || Array.isArray(input.corps)) return { error: '법인별 설정 형식이 잘못됐습니다.', field: 'corps' };
    corps = {};
    for (const [id, c] of Object.entries(input.corps).slice(0, CORP_MAX)) {
      if (!c || typeof c !== 'object') continue;
      const t = c.to == null ? { list: [], invalid: [], over: 0 } : normalizeMailList(c.to);
      if (t.invalid.length) return { error: `법인 ${String(id).slice(0, 40)} 받는 사람 주소 형식이 잘못됐습니다: ${t.invalid.slice(0, 3).join(', ')}`, field: `corps.${id}.to` };
      if (t.over) return { error: `법인 ${String(id).slice(0, 40)} 받는 사람은 ${MAIL_LIST_MAX}명까지입니다.`, field: `corps.${id}.to` };
      const tz = String(c.tz || '').trim();
      if (tz && !validTimeZone(tz)) return { error: `법인 ${String(id).slice(0, 40)} 시간대 이름을 이 서버가 모릅니다: ${tz.slice(0, 40)} (예: Asia/Seoul · Europe/Warsaw · America/New_York)`, field: `corps.${id}.tz` };
      if (t.list.length || tz) corps[String(id).slice(0, 64)] = { to: t.list, tz };
    }
  }
  const sections = { ...p.sections };
  if (input.sections && typeof input.sections === 'object') for (const [k] of REPORT_SECTIONS) if (typeof input.sections[k] === 'boolean') sections[k] = input.sections[k];
  const out = { enabled, freq, days, time, clock, includeAdmin: typeof input.includeAdmin === 'boolean' ? input.includeAdmin : p.includeAdmin, to: to.list, fullPct, sections, corps, since: p.since };
  // 켜거나 회차 정의(주기 · 요일 · 시각 · 기준 시각)를 바꾸면 기준을 지금으로 — 이미 지난 회차를 소급해 보내지 않는다.
  const sameDef = p.enabled && p.freq === out.freq && JSON.stringify(p.days) === JSON.stringify(out.days) && p.time === out.time && p.clock === out.clock;
  if (enabled && !(sameDef && p.since)) out.since = now;
  if (!enabled) out.since = null;
  return { report: out };
}

/** 회차 판정용 digest 모양(isidu planDigestTick 이 받는 모양). */
const asDigest = (r) => ({ enabled: r.enabled, days: r.days, time: r.time, since: r.since });
/** 그 법인의 회차 시계(분 오프셋) — clock 'corp' 이고 시간대가 있으면 그 시간대, 아니면 메인 서버(포탈) 시각. */
export function corpOffsetMin(r, corpId, now = Date.now()) {
  if (r.clock !== 'corp') return DAY_OFFSET_MIN;
  const tz = r.corps?.[corpId]?.tz;
  const o = tz ? tzOffsetMin(tz, now) : null;
  return o == null ? DAY_OFFSET_MIN : o;
}
/** 이번 틱 계획 — 전체 종합(메인 시각)과, 현지 시각이면 법인마다. */
export function planReportTick({ report, state = {}, corpIds = [], now = Date.now(), bootAt = 0 } = {}) {
  const r = reportOf(report);
  const overall = planDigestTick({ digest: asDigest(r), state: state.overall || {}, now, bootAt, offsetMin: DAY_OFFSET_MIN });
  const corps = {};
  if (r.clock === 'corp') for (const id of corpIds) corps[id] = planDigestTick({ digest: asDigest(r), state: state.corps?.[id] || {}, now, bootAt, offsetMin: corpOffsetMin(r, id, now) });
  return { overall, corps };
}
/** 다음 회차(메인 시각) n 개. */
export function nextReportSlots(report, now = Date.now(), n = 3) { return nextDigestSlots(asDigest(reportOf(report)), now, n, DAY_OFFSET_MIN); }
/** 보고 구간 길이 — 매일 1일 · 매주 7일. */
export const periodMsOf = (r) => (reportOf(r).freq === 'daily' ? 86_400_000 : 7 * 86_400_000);
