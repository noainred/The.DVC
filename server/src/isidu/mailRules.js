/**
 * isidu/mailRules.js — 아이실론 디렉터리 사용량 결과 메일의 순수 규칙(v2.738). settings.js·notify.js·테스트가 같이 쓴다.
 *   import 는 순수 잎 모듈 둘뿐이다(xferspeed/schedule.js · util/numOrNull.js) — digestRules.js 가 이 파일을 import 하므로 반대 방향은 순환이다(arch2579).
 *
 * 사용자 요청: "결과가 나오면 결과를 이메일로 보내고 싶어, 1개의 결과에 다수개의 이메일을 등록할 수도 있고, 전체 공통으로 보낼 수도 있고".
 * 선택: 공통 수신자 + 대상별 수신자 여러 명 · 조사가 끝날 때마다(대상별 '변화 없으면 생략') · 수신자는 합집합(대상별 '공통 수신자 빼기')
 *       · 같은 주소는 한 번만 · 실패 알림은 대상별 선택(기본 꺼짐 · 6시간에 한 번까지).
 *
 * ── 규칙 ────────────────────────────────────────────────────────────────────
 *  · 주소 목록은 줄바꿈·쉼표·세미콜론·공백으로 나눠 받는다. 형식이 틀린 주소는 **저장하지 않고 거부**한다(조용히 빼면 그 사람이 영영 못 받는다).
 *  · 같은 주소(대소문자 무시)는 처음 적은 표기 하나만 남긴다. 목록 하나에 50개까지.
 *  · 수신자 = 공통(대상이 '공통 빼기' 를 고르지 않았으면) ∪ 대상별. 둘 다 비면 그 대상은 메일을 보내지 않는다(오류가 아니다).
 *  · '변화 없음' 은 메일이 보여 주는 것(상위 N개 · 전체 합계) 기준이다 — 상위 N 의 구성이 같고, 상위 N 각 폴더와 전체 합계의 차이가
 *    모두 du -h 반올림 해상도 안이면 변화 없음. 직전 성공 조사가 없으면 첫 결과라 보낸다.
 *
 * ── v2.745 보내는 때(대상별) ────────────────────────────────────────────────
 *  사용자 결정: 대상마다 '조사가 끝날 때마다'(when 'scan' — 예전 동작, 옛 저장값의 기본) 또는 '정한 요일·시각'(when 'schedule').
 *  · 저장 모양: { …기존, when, days:[0..6](0 = 일요일), time:'HH:MM'(포탈 시각), skipIfNoNew(기본 켬), since }. since 는 서버가 정한다 —
 *    schedule 로 처음 바꾸거나 요일·시각을 바꾼 시각(그 이전 회차를 소급 발송하지 않게). scan 이면 null. 클라이언트가 보낸 since 는 무시한다.
 *  · 요일·시각 검사와 since 규칙은 종합 메일(digestRules.normalizeDigest)과 **같은 결과**다 — 요일·시각 판정은 두 쪽이 일정 계산에 쓰는
 *    xferspeed/schedule.js(checkSchedule·sameDefinition)를 그대로 쓰고, 같은 입력의 결과가 같음을 isiduSchedMail2745 테스트가 대조한다
 *    (digestRules 를 import 하면 순환이라 그 모듈의 TIME_RE 를 가져오지 못한다 — 사본 정규식을 만들지 않았다).
 *  · 빠진 필드는 이전 값이다(부분 요청이 지우지 않게) — 형식이 틀리면 400(field: mail.when · mail.days · mail.time).
 */
import { checkSchedule, sameDefinition } from '../xferspeed/schedule.js';
import { numOrNull } from '../util/numOrNull.js';

export const MAIL_LIST_MAX = 50;
export const FAIL_ALERT_MIN_MS = 6 * 3_600_000;
// 로컬부 64자 · 도메인은 점이 하나 이상 · 따옴표·꺾쇠·괄호·역슬래시·제어 문자 없음(메일 헤더에 그대로 들어간다).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

export function isEmail(s) { return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s); }

/**
 * 주소 목록 정규화(순수). 배열이나 문자열(줄바꿈·쉼표·세미콜론·공백 구분)을 받는다.
 * @returns {{list:string[], invalid:string[], dupes:number, over:number}}
 */
export function normalizeMailList(v) {
  const raw = Array.isArray(v) ? v.flatMap((x) => String(x ?? '').split(/[\s,;]+/)) : String(v ?? '').split(/[\s,;]+/);
  const list = []; const invalid = []; const seen = new Set(); let dupes = 0; let over = 0;
  for (const p0 of raw) {
    const p = p0.trim();
    if (!p) continue;
    if (!isEmail(p)) { if (invalid.length < 20) invalid.push(p.slice(0, 80)); continue; }
    const k = p.toLowerCase();
    if (seen.has(k)) { dupes++; continue; }
    if (list.length >= MAIL_LIST_MAX) { over++; continue; }
    seen.add(k); list.push(p);
  }
  return { list, invalid, dupes, over };
}

/** v2.745 보내는 때 — 'scan'(조사가 끝날 때마다 · 예전 동작) | 'schedule'(정한 요일·시각). 웹 문구 표와 1:1. */
export const TARGET_MAIL_WHEN = Object.freeze(['scan', 'schedule']);
/** 대상 메일 기본값 — 옛 저장값(필드 없음)이 이 값이다. 이 값과 같으면 settings.js 가 mail 을 저장하지 않는다. */
export const TARGET_MAIL_DEFAULTS = Object.freeze({
  to: Object.freeze([]), excludeCommon: false, onlyOnChange: false, onFailure: false,
  when: 'scan', days: Object.freeze([1]), time: '08:00', skipIfNoNew: true, since: null,
});
/**
 * 대상별 결과 메일 기록(last)의 code — 웹 문구 표와 1:1(웹 테스트가 이 소스에서 뽑아 대조한다).
 * no-new(새 조사 없으면 생략) · unchanged(변화 없으면 생략) · no-report(보낼 성공 결과 없음) · demo(데모 대상) ·
 * missed-down(포탈이 꺼져 있던 회차) · missed-late(늦게 확인한 회차) · no-recipients(보낼 때 받는 사람이 없어짐) ·
 * missed-clock(서버 시계가 뒤로 가 미래가 된 '보내는 때 저장 시각' 때문에 막힌 회차 — 지금으로 잡고 소급해 보내지 않음, v2.745 검토 SCHED-03).
 */
export const TARGET_MAIL_CODES = Object.freeze(['no-new', 'unchanged', 'no-report', 'demo', 'missed-down', 'missed-late', 'no-recipients', 'missed-clock']);

/** 요일 목록 정리(0~6 정수 · 중복 제거 · 정렬) — 일정 계산 모듈(checkSchedule)의 규칙을 그대로 쓴다. 쓸 수 있는 요일이 없으면 []. */
export function mailDaysOf(v) {
  const c = checkSchedule({ kind: 'weekly', time: '00:00', days: Array.isArray(v) ? v : [] });
  return c.ok ? c.sched.days : [];
}
/** 보내는 시각 'HH:MM'(00:00~23:59, 앞뒤 공백 허용) 판정 — 일정 계산 모듈(checkSchedule)의 규칙. */
export function isMailTime(v) {
  return (typeof v === 'string' || typeof v === 'number') && checkSchedule({ kind: 'daily', time: String(v) }).ok;
}
const sinceOf = (v) => { const n = numOrNull(v); return n != null && n > 0 ? n : null; };

/** 저장된 대상의 메일 설정(빈 값 보정 — 옛 저장값은 필드가 없다). */
export function targetMailOf(t) {
  const m = t?.mail && typeof t.mail === 'object' ? t.mail : {};
  const D = TARGET_MAIL_DEFAULTS;
  return {
    to: Array.isArray(m.to) ? m.to.filter(isEmail) : [],
    excludeCommon: m.excludeCommon === true,
    onlyOnChange: m.onlyOnChange === true,
    onFailure: m.onFailure === true,
    when: TARGET_MAIL_WHEN.includes(m.when) ? m.when : D.when,
    days: Array.isArray(m.days) ? mailDaysOf(m.days) : [...D.days],
    time: isMailTime(m.time) ? String(m.time).trim() : D.time,
    skipIfNoNew: m.skipIfNoNew !== false,
    since: sinceOf(m.since),
  };
}

/** 기본값과 같은가(since 제외) — 같으면 저장하지 않는다(파일을 작게 — 없는 것과 같은 뜻). */
export function targetMailIsDefault(m) {
  const g = targetMailOf({ mail: m });
  const D = TARGET_MAIL_DEFAULTS;
  return !g.to.length && g.excludeCommon === D.excludeCommon && g.onlyOnChange === D.onlyOnChange && g.onFailure === D.onFailure
    && g.when === D.when && g.days.join(',') === D.days.join(',') && g.time === D.time && g.skipIfNoNew === D.skipIfNoNew;
}

/**
 * 대상 하나의 메일 설정 정규화(저장 경로). 형식이 틀리면 { error, field }.
 * 빠진 필드는 이전 값이다(부분 요청이 지우지 않게). since 는 서버가 정한다 — 규칙은 종합 메일(normalizeDigest)과 같다:
 * schedule 이 아니면 null, schedule 로 처음 바꾸거나 요일·시각이 바뀌면 now, 같으면 유지.
 * @param {unknown} input 요청 값(없으면 이전 값 유지)
 * @param {object|null} prev 저장돼 있던 대상 메일 설정
 * @param {number} now since 기준 시각
 */
export function normalizeTargetMail(input, prev, now = Date.now()) {
  const p = targetMailOf({ mail: prev });
  if (input == null) return { mail: p };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: '메일 설정 형식이 잘못됐습니다.', field: 'mail' };
  const n = input.to == null ? { list: p.to, invalid: [], over: 0 } : normalizeMailList(input.to);
  if (n.invalid.length) return { error: `메일 주소 형식이 잘못됐습니다: ${n.invalid.slice(0, 3).join(', ')}${n.invalid.length > 3 ? ` 외 ${n.invalid.length - 3}개` : ''}`, field: 'mail.to' };
  if (n.over) return { error: `대상별 수신자는 ${MAIL_LIST_MAX}명까지입니다(${n.over}명 초과).`, field: 'mail.to' };
  const when = input.when == null ? p.when : input.when;
  if (!TARGET_MAIL_WHEN.includes(when)) return { error: "보내는 때는 '조사가 끝날 때마다' 또는 '정한 요일·시각' 중 하나여야 합니다.", field: 'mail.when' };
  const sched = when === 'schedule';
  const days = Array.isArray(input.days) ? mailDaysOf(input.days) : p.days;
  if (sched && !days.length) return { error: '결과 메일을 보낼 요일을 하나 이상 고르세요.', field: 'mail.days' };
  const time = input.time == null ? p.time : String(input.time).trim();
  if (!isMailTime(time)) return { error: '보내는 시각은 00:00~23:59 형식이어야 합니다.', field: 'mail.time' };
  const flag = (k) => (typeof input[k] === 'boolean' ? input[k] : p[k]);
  const sameDef = p.when === 'schedule' && sameDefinition({ kind: 'weekly', time: p.time, days: p.days }, { kind: 'weekly', time, days });
  const since = !sched ? null : (sameDef && p.since ? p.since : now);
  return {
    mail: {
      to: n.list, excludeCommon: flag('excludeCommon'), onlyOnChange: flag('onlyOnChange'), onFailure: flag('onFailure'),
      when, days, time, skipIfNoNew: flag('skipIfNoNew'), since,
    },
  };
}

/** 공통 메일 설정 정규화(저장 경로). */
export function normalizeCommonMail(input, prev) {
  if (input == null) return { mail: { commonTo: Array.isArray(prev?.commonTo) ? prev.commonTo.filter(isEmail) : [] } };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: '공통 메일 설정 형식이 잘못됐습니다.', field: 'mail' };
  const n = normalizeMailList(input.commonTo);
  if (n.invalid.length) return { error: `공통 수신자 주소 형식이 잘못됐습니다: ${n.invalid.slice(0, 3).join(', ')}${n.invalid.length > 3 ? ` 외 ${n.invalid.length - 3}개` : ''}`, field: 'mail.commonTo' };
  if (n.over) return { error: `공통 수신자는 ${MAIL_LIST_MAX}명까지입니다(${n.over}명 초과).`, field: 'mail.commonTo' };
  return { mail: { commonTo: n.list } };
}

/**
 * 받는 사람(순수) — 공통(빼지 않았으면) ∪ 대상별, 같은 주소는 한 번만(대소문자 무시, 대상별 표기가 아니라 먼저 나온 표기).
 * @returns {{to:string[], fromCommon:number, fromTarget:number, dupes:number}}
 */
export function mailRecipients(commonTo, targetMail) {
  const tm = targetMail || {};
  const common = tm.excludeCommon ? [] : (Array.isArray(commonTo) ? commonTo : []);
  const own = Array.isArray(tm.to) ? tm.to : [];
  const out = []; const seen = new Set(); let dupes = 0; let fromCommon = 0; let fromTarget = 0;
  for (const [src, list] of [['c', common], ['t', own]]) {
    for (const a of list) {
      if (!isEmail(a)) continue;
      const k = a.toLowerCase();
      if (seen.has(k)) { dupes++; continue; }
      seen.add(k); out.push(a);
      if (src === 'c') fromCommon++; else fromTarget++;
    }
  }
  return { to: out, fromCommon, fromTarget, dupes };
}

const DELTA_OK = (cur, prev) => {
  if (!cur || !prev || !Number.isFinite(cur.bytes) || !Number.isFinite(prev.bytes)) return false;
  const unc = ((Number(cur.res) || 1) + (Number(prev.res) || 1)) / 2;
  return Math.abs(cur.bytes - prev.bytes) <= unc;
};

/**
 * 직전 성공 조사와 비교한 '메일에 보이는 것' 의 변화(순수).
 * @param {{rows:{name,bytes,res}[], total:{bytes,res}|null}} cur 이번 조사(rows 는 크기 내림차순)
 * @param {{entries:Map<string,{bytes,res}>, total:{bytes,res}|null}|null} prev 직전 성공 조사(없으면 첫 결과)
 * @param {number} topN
 * @returns {{changed:boolean, first:boolean, reasons:string[]}}
 */
export function changeSummary(cur, prev, topN) {
  if (!prev) return { changed: true, first: true, reasons: ['첫 결과'] };
  const n = Math.max(1, Math.round(Number(topN) || 10));
  const reasons = [];
  const curTop = (cur?.rows || []).slice(0, n);
  const prevTop = [...(prev.entries || new Map()).entries()].map(([name, v]) => ({ name, bytes: v.bytes, res: v.res }))
    .sort((a, b) => (b.bytes - a.bytes) || String(a.name).localeCompare(String(b.name))).slice(0, n);
  const prevNames = new Set(prevTop.map((r) => r.name));
  const entered = curTop.filter((r) => !prevNames.has(r.name)).length;
  if (entered) reasons.push(`상위 ${n}개 구성 변경(${entered}개 바뀜)`);
  let moved = 0;
  for (const r of curTop) {
    const p = prev.entries?.get(r.name);
    if (p && !DELTA_OK(r, p)) moved++;
  }
  if (moved) reasons.push(`상위 폴더 ${moved}개 크기 변화`);
  if (cur?.total && prev.total && !DELTA_OK(cur.total, prev.total)) reasons.push('전체 합계 변화');
  if ((cur?.total == null) !== (prev.total == null)) reasons.push('전체 합계 표시 변경');
  return { changed: reasons.length > 0, first: false, reasons };
}

/** 실패 알림을 지금 보내도 되는가(순수) — 대상별 6시간에 한 번까지. */
export function failAlertDue(lastFailAlertAt, now = Date.now()) {
  const t = Number(lastFailAlertAt);
  return !Number.isFinite(t) || t <= 0 || now - t >= FAIL_ALERT_MIN_MS;
}
