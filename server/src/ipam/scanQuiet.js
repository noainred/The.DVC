/**
 * ipam/scanQuiet.js — 주기 스캔의 '쉬는 시간'(순수 · v3.7.0 IP 관리 재설계 묶음 라 — 설계 docs/design/ipam-redesign ⑭ ScanSchedule).
 *
 * 사용자 결정(2026-11-13): 주기 스캔에 쉬는 시간 · 스캔 속도 · 동시에 스캔하는 IP 수를 둔다. 쉬는 시간은 **법인 현지 시각**이다 —
 * 스캔을 실제로 도는 쪽(엣지 · 이 포탈)이 **자기 시계**로 판정한다(중앙이 엣지의 시간대를 모르므로 중앙이 대신 판정하지 않는다).
 * 쉬는 시간에 걸린 주기 회차는 건너뛴다(끝난 뒤 몰아서 돌리지 않는다 — 놓친 회차 규칙과 같다). 수동 스캔(지금 스캔)은 막지 않는다.
 *
 * 저장 모양: quiet = [{ from:'HH:MM', to:'HH:MM', days?: number[] }] — days 는 0(일)~6(토), 없으면 매일. from > to 면 자정을 넘는 창
 * (예 22:00 ~ 06:00 — 시작한 날의 요일로 본다). from == to 는 창이 아니다(하루 종일을 뜻하지 않는다 — 스캔을 끄려면 '주기 스캔' 을 끈다).
 */
export const QUIET_MAX = 8;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minOf = (s) => { const m = TIME_RE.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** 저장 · 배정 값 정제(엣지가 받은 값도 이것으로 다시 자른다). 잘못된 줄은 버린다. */
export function cleanQuiet(v) {
  const out = [];
  for (const q of Array.isArray(v) ? v.slice(0, QUIET_MAX * 4) : []) {
    if (!q || typeof q !== 'object') continue;
    const a = minOf(q.from); const b = minOf(q.to);
    if (a == null || b == null || a === b) continue;
    const days = Array.isArray(q.days) ? [...new Set(q.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    out.push({ from: String(q.from).trim(), to: String(q.to).trim(), ...(days.length && days.length < 7 ? { days } : {}) });
    if (out.length >= QUIET_MAX) break;
  }
  return out;
}

/**
 * 저장 경로 검사 — 잘못된 줄이 있으면 { error } (조용히 버리지 않는다 — 사용자가 넣은 창이 사라지면 그 시간에 스캔이 돈다).
 * @returns {{ quiet: object[] } | { error: string }}
 */
export function parseQuietInput(v) {
  if (v == null) return { quiet: [] };
  if (!Array.isArray(v)) return { error: '쉬는 시간 형식이 잘못됐습니다.' };
  if (v.length > QUIET_MAX) return { error: `쉬는 시간은 ${QUIET_MAX}개까지입니다.` };
  for (const q of v) {
    const a = minOf(q?.from); const b = minOf(q?.to);
    if (a == null || b == null) return { error: '쉬는 시간은 00:00~23:59 형식이어야 합니다.' };
    if (a === b) return { error: '쉬는 시간의 시작과 끝이 같습니다 — 스캔을 멈추려면 주기 스캔을 끄세요.' };
    if (q.days != null && (!Array.isArray(q.days) || !q.days.length || q.days.some((d) => !Number.isInteger(Number(d)) || Number(d) < 0 || Number(d) > 6))) return { error: '쉬는 시간의 요일은 0(일)~6(토) 중 하나 이상이어야 합니다.' };
  }
  return { quiet: cleanQuiet(v) };
}

/**
 * 지금이 쉬는 시간인가(그 프로세스의 현지 시각). 걸린 창을 돌려준다(없으면 null).
 * @param {object[]} quiet cleanQuiet 결과
 * @param {Date|number} at
 */
export function quietWindowAt(quiet, at = Date.now()) {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return null;
  const now = d.getHours() * 60 + d.getMinutes();
  const today = d.getDay(); const yesterday = (today + 6) % 7;
  for (const q of cleanQuiet(quiet)) {
    const a = minOf(q.from); const b = minOf(q.to);
    const on = (day) => !q.days || q.days.includes(day);
    if (a < b) { if (now >= a && now < b && on(today)) return q; }
    else if ((now >= a && on(today)) || (now < b && on(yesterday))) return q;   // 자정을 넘는 창 — 시작한 날의 요일
  }
  return null;
}

/** 화면 · 로그 글자 — '01:00~05:00(일·토)'. */
const DAY = ['일', '월', '화', '수', '목', '금', '토'];
export function quietText(q) {
  if (!q) return '';
  return `${q.from}~${q.to}${q.days?.length ? `(${q.days.map((d) => DAY[d]).join('·')})` : ''}`;
}

/** 오늘(그 시계의 0시 기준) 쉬는 시간 구간 — 시간표 그리기용 [{ fromMin, toMin, label }](자정을 넘는 창은 두 조각). */
export function quietSpansOfDay(quiet, at = Date.now()) {
  const d = at instanceof Date ? at : new Date(at);
  const today = d.getDay(); const yesterday = (today + 6) % 7;
  const out = [];
  for (const q of cleanQuiet(quiet)) {
    const a = minOf(q.from); const b = minOf(q.to);
    const on = (day) => !q.days || q.days.includes(day);
    if (a < b) { if (on(today)) out.push({ fromMin: a, toMin: b, label: quietText(q) }); continue; }
    if (on(yesterday)) out.push({ fromMin: 0, toMin: b, label: quietText(q) });
    if (on(today)) out.push({ fromMin: a, toMin: 1440, label: quietText(q) });
  }
  return out;
}

/**
 * v3.8.1: 쉬는 시간의 가장 긴 연속 길이(ms) — 요일과 상관없이 매일로 보고(넉넉한 쪽) 이틀 치 분 단위로 이어 붙여 잰다(22:00~02:00 + 02:00~06:00 = 8시간).
 * 중앙은 엣지의 시계를 모르므로 '지금 쉬는 중인가' 대신 이 길이만큼 '끊김 · 늦음' 판정을 늦춘다(쉬는 시간마다 거짓 경보가 울리지 않게). 없으면 0 · 최대 24시간.
 */
export function quietLongestMs(quiet) {
  const rows = cleanQuiet(quiet);
  if (!rows.length) return 0;
  const on = new Uint8Array(2880);
  for (const q of rows) {
    const a = minOf(q.from); const b = minOf(q.to);
    for (const day of [0, 1440]) {
      const end = a < b ? b : b + 1440;
      for (let m = a; m < end; m += 1) on[(day + m) % 2880] = 1;
    }
  }
  let best = 0; let run = 0;
  for (let i = 0; i < 2880 * 2; i += 1) { if (on[i % 2880]) { run += 1; if (run > best) best = run; } else run = 0; }
  return Math.min(best, 1440) * 60_000;
}

