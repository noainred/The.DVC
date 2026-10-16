/**
 * isidu/digestRules.js — 아이실론 디렉터리 사용량 **종합 메일**의 순수 규칙(v2.742). 파일·타이머·메일 발송 없음.
 *
 * 사용자 요청: 전 법인 결과를 모아 정한 요일·시각에 한 통으로 보낸다(Claude Design 시안 ① 승인 · ② 설정 · 같은 릴리스에 ③④ 대상별 메일 재디자인).
 * 선택: v2.742 에 함께 · 전체 검증 · 시안 그대로.
 *
 * ── 설정 한 벌(`mail.digest`) ────────────────────────────────────────────────
 *   { enabled, days:[0..6](0 = 일요일), time:'HH:MM'(포탈 시각 — 기본 한국 시각), includeAdmin, to:[주소], topN:5|10|20,
 *     includeWatch, includeTargets, skipIfNoNew, since }
 *  · 받는 사람 = 통합 관리자(메일 설정의 '기본 받는 사람' — 고르면) ∪ 추가 주소. 같은 주소(대소문자 무시)는 한 번만.
 *  · 형식이 틀린 주소·켰는데 요일이 하나도 없음·시각 형식 오류는 **저장하지 않고 400** 이다(조용히 고치면 사용자가 정한 값이 사라진다).
 *  · `since` 는 서버가 정한다 — 켜거나 요일·시각을 바꾼 시각. 그 이전 회차는 보내지 않는다(저장하자마자 오늘 지난 회차를 소급 발송하지 않게).
 *
 * ── 지난 회차의 처리(planDigestTick) ─────────────────────────────────────────
 *  · '지금 이전의 가장 최근 회차' 하나만 본다. 처리 기록(lastSlot)·since 보다 뒤이고 지금과의 차이가 30분(GRACE_MS) 안이면 **보낸다**,
 *    그보다 늦었으면 **놓침**으로 남긴다 — 몰아서 여러 번 보내지 않는다(xferspeed 일정과 같은 규칙 — 일정 계산도 그 모듈을 그대로 쓴다).
 *  · 놓침 사유는 아는 것만 쓴다: 포탈이 꺼져 있었음(회차가 기동 전) · 늦음(그 밖) · 시계가 뒤로 감(기록이 지금보다 뒤).
 *
 * ── 본문 모델(buildDigestModel) ──────────────────────────────────────────────
 *  · 대상 상태는 웹 `isiduText.targetStatus` 와 **같은 판정**이다(`statusOfRow` — 웹 테스트가 같은 입력으로 대조한다).
 *  · 합계는 **성공한 수집이 있는 대상만** 더하고 뺀 개수를 함께 말한다 — 부분 합을 전체라 말하지 않는다.
 *  · 7일 변화는 7일 이전 기준이 있는 대상만 더하고, du -h 반올림 범위 안의 차이는 0 으로 센다(웹 서머리와 같은 규칙).
 *  · 실패·오래된 대상의 값은 '직전 성공 값' 이다 — 표가 그 사실을 칸마다 말한다.
 *  · 데모(mock-) 대상은 실제 메일에 넣지 않는다(미리보기만 넣고 그 사실을 밝힌다).
 */
import { nextOccurrence, prevOccurrence, localParts, GRACE_MS } from '../xferspeed/schedule.js';
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';
import { normalizeMailList, isEmail, MAIL_LIST_MAX } from './mailRules.js';

export const DIGEST_TOPN_CHOICES = Object.freeze([5, 10, 20]);
export const DIGEST_GRACE_MS = GRACE_MS;
export const DIGEST_HISTORY_MAX = 20;
/** 놓침 사유 — 웹 `isiduDigestText.MISSED_TEXT` 와 1:1(웹 테스트가 이 소스에서 뽑아 대조한다). */
export const DIGEST_MISSED_REASONS = Object.freeze(['down', 'late', 'clock']);
/** 보내지 않은 사유 — 웹 `isiduDigestText.SKIP_TEXT` 와 1:1. */
export const DIGEST_SKIP_CODES = Object.freeze(['no-targets', 'no-recipients', 'no-new', 'mail-off', 'auth-stopped', 'demo-only', 'unreadable']);
/** 7일 '급증' — 폴더의 7일 증가가 이 크기 이상이고 7일 전 크기의 이 비율 이상(둘 다). 본문 '숫자를 읽는 법' 이 같은 값을 말한다. */
export const SURGE_MIN_BYTES = 100 * 1024 ** 3;
export const SURGE_MIN_RATIO = 0.2;
export const SURGE_MAX = 5;
export const DAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR = 3_600_000;
const MIN = 60_000;
const CLOCK_TOL_MS = 2 * MIN;

export const DIGEST_DEFAULTS = Object.freeze({
  enabled: false, days: Object.freeze([1]), time: '08:00', includeAdmin: true, to: Object.freeze([]),
  topN: 10, includeWatch: true, includeTargets: true, skipIfNoNew: false, since: null,
});

const intDays = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);

/** 저장된 종합 메일 설정(빈 값 보정 — 옛 파일은 필드가 없다). 순수. */
export function digestOf(raw) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const time = TIME_RE.test(String(d.time || '')) ? String(d.time) : DIGEST_DEFAULTS.time;
  const topN = DIGEST_TOPN_CHOICES.includes(Number(d.topN)) ? Number(d.topN) : DIGEST_DEFAULTS.topN;
  const since = numOrNull(d.since);
  return {
    enabled: d.enabled === true,
    days: Array.isArray(d.days) ? intDays(d.days) : [...DIGEST_DEFAULTS.days],
    time,
    includeAdmin: d.includeAdmin !== false,
    to: (Array.isArray(d.to) ? d.to : []).filter(isEmail).slice(0, MAIL_LIST_MAX),
    topN,
    includeWatch: d.includeWatch !== false,
    includeTargets: d.includeTargets !== false,
    skipIfNoNew: d.skipIfNoNew === true,
    since: since != null && since > 0 ? since : null,
  };
}

/**
 * 종합 메일 설정 정규화(저장 경로). 문제가 있으면 { error, field }.
 * @param {unknown} input 요청 값
 * @param {object|null} prev 저장돼 있던 값
 * @param {number} now
 */
export function normalizeDigest(input, prev, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '종합 메일 설정 형식이 잘못됐습니다.', field: 'digest' };
  const p = digestOf(prev);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : p.enabled;   // 빠진 칸은 이전 값(부분 요청이 끄지 않게)
  const days = Array.isArray(input.days) ? intDays(input.days) : p.days;
  if (enabled && !days.length) return { error: '종합 메일을 보낼 요일을 하나 이상 고르세요.', field: 'digest.days' };
  const time = input.time == null ? p.time : String(input.time).trim();
  if (!TIME_RE.test(time)) return { error: '보내는 시각은 00:00~23:59 형식이어야 합니다.', field: 'digest.time' };
  let topN = p.topN;
  if (input.topN != null && String(input.topN).trim() !== '') {
    const n = Number(input.topN);
    if (!DIGEST_TOPN_CHOICES.includes(n)) return { error: `전 법인 순위는 ${DIGEST_TOPN_CHOICES.join('·')}개 중에서 고르세요.`, field: 'digest.topN' };
    topN = n;
  }
  const to = input.to == null ? { list: p.to, invalid: [], over: 0 } : normalizeMailList(input.to);
  if (to.invalid.length) return { error: `추가 받는 사람 주소 형식이 잘못됐습니다: ${to.invalid.slice(0, 3).join(', ')}${to.invalid.length > 3 ? ` 외 ${to.invalid.length - 3}개` : ''}`, field: 'digest.to' };
  if (to.over) return { error: `추가 받는 사람은 ${MAIL_LIST_MAX}명까지입니다(${to.over}명 초과).`, field: 'digest.to' };
  const flag = (k) => (typeof input[k] === 'boolean' ? input[k] : p[k]);
  const out = {
    enabled, days, time, includeAdmin: flag('includeAdmin'), to: to.list, topN,
    includeWatch: flag('includeWatch'), includeTargets: flag('includeTargets'), skipIfNoNew: flag('skipIfNoNew'), since: p.since,
  };
  // 켜거나, 요일·시각을 바꾸면 기준 시각을 지금으로 — 그 이전 회차(오늘 이미 지난 시각)를 소급 발송하지 않는다.
  const sameDef = p.enabled && JSON.stringify(p.days) === JSON.stringify(out.days) && p.time === out.time;
  if (enabled && !(sameDef && p.since)) out.since = now;
  if (!enabled) out.since = null;
  return { digest: out };
}

/** 일정 계산용 모양(xferspeed/schedule.js 의 매주 일정). */
export function digestSchedule(d) {
  const g = digestOf(d);
  return { kind: 'weekly', time: g.time, days: g.days, since: g.since || undefined };
}

/** 다음 회차 n 개(순수). 꺼져 있거나 요일이 없으면 []. */
export function nextDigestSlots(d, now = Date.now(), n = 3, offsetMin = DAY_OFFSET_MIN) {
  const g = digestOf(d);
  if (!g.enabled || !g.days.length) return [];
  const s = digestSchedule(g);
  const out = []; let at = now;
  for (let i = 0; i < n; i++) {
    const nx = nextOccurrence(s, at, offsetMin);
    if (nx == null) break;
    out.push(nx); at = nx;
  }
  return out;
}

/**
 * 이번 틱에 할 일(순수).
 * @param {{digest:object, state:{lastSlot?:number}, now:number, bootAt?:number, offsetMin?:number}} a
 * @returns {{action:'none'}|{action:'send', slot:number}|{action:'missed', slot:number, reason:string, count:number}|{action:'rebase', lastSlot:number}}
 */
export function planDigestTick({ digest, state = {}, now = Date.now(), bootAt = 0, offsetMin = DAY_OFFSET_MIN } = {}) {
  const g = digestOf(digest);
  if (!g.enabled || !g.days.length) return { action: 'none' };
  const last = numOrNull(state?.lastSlot);
  // 기록이 지금보다 한참 뒤면 시계가 뒤로 간 것이다 — 기록을 지금으로 다시 잡는다(그대로 두면 그 시각까지 영원히 보내지 않는다).
  if (last != null && last > now + CLOCK_TOL_MS) return { action: 'rebase', lastSlot: now, reason: 'clock' };
  const s = digestSchedule(g);
  const slot = prevOccurrence(s, now, offsetMin);
  if (slot == null) return { action: 'none' };
  const floor = Math.max(last ?? -Infinity, g.since ?? -Infinity);
  if (!(slot > floor)) return { action: 'none' };
  if (now - slot <= DIGEST_GRACE_MS) return { action: 'send', slot };
  // 몰아서 보내지 않는다 — 놓친 회차를 세기만 한다(상한 60).
  let count = 0; let at = Number.isFinite(floor) ? floor : slot - 1;
  while (count < 60) { const nx = nextOccurrence(s, at, offsetMin); if (nx == null || nx > slot) break; count++; at = nx; }
  return { action: 'missed', slot, count: Math.max(1, count), reason: bootAt && slot < bootAt ? 'down' : 'late' };
}

/**
 * 받는 사람(순수) — 통합 관리자(고르면) ∪ 추가 주소, 같은 주소는 한 번(먼저 나온 표기).
 * @param {object} d 종합 메일 설정
 * @param {string[]} adminTo 메일 설정의 기본 받는 사람
 */
export function digestRecipients(d, adminTo = []) {
  const g = digestOf(d);
  const out = []; const seen = new Set(); let fromAdmin = 0; let fromExtra = 0; let dupes = 0;
  for (const [src, list] of [['a', g.includeAdmin ? (Array.isArray(adminTo) ? adminTo : []) : []], ['e', g.to]]) {
    for (const a of list) {
      const v = String(a ?? '').trim();
      if (!isEmail(v)) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) { dupes++; continue; }
      seen.add(k); out.push(v);
      if (src === 'a') fromAdmin++; else fromExtra++;
    }
  }
  return { to: out, fromAdmin, fromExtra, dupes };
}

/** 요일 목록 → '월·수·금' / '매일' / '평일'. */
export function daysLabel(days) {
  const d = intDays(days);
  if (d.length === 7) return '매일';
  if (d.join(',') === '1,2,3,4,5') return '평일';
  if (!d.length) return '요일 없음';
  return d.map((x) => DAY_LABELS[x]).join('·');
}

/** epoch ms → '2026-10-19 (월) 08:00'(포탈 시각). 못 읽으면 '—'. */
export function slotLabel(ms, offsetMin = DAY_OFFSET_MIN) {
  const t = numOrNull(ms);
  if (t == null) return '—';
  const d = new Date(t + offsetMin * MIN);
  if (!Number.isFinite(d.getTime())) return '—';
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} (${DAY_LABELS[localParts(t, offsetMin).wd]}) ${iso.slice(11, 16)}`;
}

/* ─────────────── 대상 상태(웹 targetStatus 와 같은 판정) ─────────────── */

/** 실패 종류 제목 — 웹 `isiduText.FAIL_TEXT[kind].title` 과 같은 글자(웹 테스트가 대조한다). */
export const FAIL_TITLE = Object.freeze({
  'no-key': 'SSH 키 없음', 'device-missing': '등록부에 장비 없음', 'device-not-isilon': '아이실론이 아님', auth: '인증 거부', hostkey: '호스트키 미확인',
  timeout: '시한 초과', unreachable: '연결 실패', exec: '명령 실패', parse: '출력 해석 실패', 'output-cap': '출력 상한 초과', db: 'DB 저장 실패',
});
export const failTitleOf = (kind) => FAIL_TITLE[kind] || (kind ? String(kind) : '실패');

/**
 * 대상 하나의 상태(순수) — 웹 `isiduText.targetStatus` 와 **같은 순서·같은 key·같은 tone**(글자는 메일용으로 짧다).
 * 순서: 장비 문제 → 꺼짐 → 진행 중 → 재시작 중단 → 요청 대기 → 인증 정지 → 최근 실패 → 기록 없음 → 오래됨 → 정상(권한 오류 일부) → 정상.
 * @returns {{key:string, tone:'ok'|'warn'|'bad'|'muted'|'run', text:string}}
 */
export function statusOfRow(t, now = Date.now()) {
  if (!t) return { key: 'none', tone: 'muted', text: '—' };
  if (t.issue) return { key: 'issue', tone: 'bad', text: failTitleOf(t.issue) };
  if (t.enabled === false) return { key: 'off', tone: 'muted', text: '꺼짐' };
  if (t.deviceDisabled) return { key: 'off', tone: 'muted', text: '장비 비활성' };
  if (t.running) return { key: 'running', tone: 'run', text: '조사 중' };
  if (t.interrupted) return { key: 'interrupted', tone: 'run', text: '재시작으로 중단 · 자동 재개 대기' };
  if (t.request) return { key: 'requested', tone: 'run', text: t.request.state === 'taken' ? '엣지가 실행 중' : '요청 대기' };
  if (t.authStopped) return { key: 'auth-stopped', tone: 'bad', text: '인증 정지' };
  const ok = t.okScan; const lt = t.lastTry;
  if (lt && lt.ok === false && (!ok || lt.ts > ok.ts)) return { key: 'failed', tone: 'bad', text: failTitleOf(lt.kind) };
  if (!ok) return { key: 'never', tone: 'muted', text: '수집 전' };
  const every = (numOrNull(t.intervalHours) || 24) * HOUR;
  const staleMs = every * 2 + (numOrNull(t.timeoutMin) || 120) * MIN + HOUR;
  if (now - ok.ts > staleMs) return { key: 'stale', tone: 'warn', text: '보고 늦음' };
  if (ok.errLines > 0) return { key: 'ok-partial', tone: 'warn', text: '정상(권한 오류 일부)' };
  return { key: 'ok', tone: 'ok', text: '정상' };
}

/** 대상의 디렉터리 크기 — 웹 `targetBytesOf` 와 같은 규칙(du 합계 줄 → 폴더 합). 못 읽으면 null. */
export function rowBytesOf(t) {
  const s = t?.okScan;
  const tb = numOrNull(s?.total?.bytes);
  if (tb != null && tb > 0) return tb;
  const sb = numOrNull(s?.sumBytes);
  return sb != null && sb > 0 ? sb : null;
}

const TONE_RANK = { bad: 0, warn: 1, run: 2, muted: 3, ok: 4 };
const _coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const corpOf = (t) => String(t?.corp || t?.datacenterId || '').trim();

/**
 * 본문 모델(순수).
 * @param {object[]} rows 메인 목록 응답의 대상 행(isidu/rows.js targetRows)
 * @param {Map<string, object>} ovById buildOverview 결과(id → 개요)
 * @param {{now?:number, topN?:number, excludeDemo?:boolean}} opts
 */
export function buildDigestModel(rows, ovById = new Map(), { now = Date.now(), topN = 10, excludeDemo = true } = {}) {
  const all = (Array.isArray(rows) ? rows : []).filter((t) => t && typeof t === 'object' && t.id);
  const demoCount = all.filter((t) => String(t.id).startsWith('mock-')).length;
  const list = excludeDemo ? all.filter((t) => !String(t.id).startsWith('mock-')) : all;
  const items = list.map((t) => {
    const st = statusOfRow(t, now);
    const ov = ovById.get(t.id) || null;
    const bytes = rowBytesOf(t);
    const d = ov?.state === 'ok' && ov.totalDelta7 && numOrNull(ov.totalDelta7.bytes) != null ? ov.totalDelta7 : null;
    return {
      t, st, ov, bytes,
      d7: d ? { bytes: d.withinRes ? 0 : d.bytes, within: d.withinRes === true } : null,
      corp: corpOf(t), corpLabel: corpOf(t) || '법인 미지정',
      device: t.deviceName || t.host || '—', path: t.path || '', label: t.label || '',
      okTs: numOrNull(t.okScan?.ts), failStreak: numOrNull(t.failStreak) || 0,
      lastValue: st.key === 'failed' || st.key === 'stale' || st.key === 'auth-stopped' || st.key === 'issue',
    };
  });
  const measured = items.filter((x) => x.bytes != null);
  const totalBytes = measured.length ? measured.reduce((s, x) => s + x.bytes, 0) : null;
  const withBase = measured.filter((x) => x.d7);
  const d7Sum = withBase.length ? withBase.reduce((s, x) => s + x.d7.bytes, 0) : null;
  const d7BaseBytes = withBase.length ? withBase.reduce((s, x) => s + x.bytes, 0) - d7Sum : null;
  const counts = { total: items.length, ok: 0, stale: 0, failed: 0, running: 0, never: 0, off: 0 };
  for (const x of items) {
    const k = x.st.key;
    if (k === 'ok' || k === 'ok-partial') counts.ok++;
    else if (k === 'stale') counts.stale++;
    else if (k === 'failed' || k === 'auth-stopped' || k === 'issue') counts.failed++;
    else if (k === 'running' || k === 'interrupted' || k === 'requested') counts.running++;
    else if (k === 'never') counts.never++;
    else if (k === 'off') counts.off++;
  }

  // 법인별 — 사용량 많은 순(모르는 것은 뒤), 같으면 이름 순.
  const byCorp = new Map();
  for (const x of items) {
    if (!byCorp.has(x.corp)) byCorp.set(x.corp, { corp: x.corp, label: x.corpLabel, items: [], bytes: 0, measured: 0, d7: 0, d7n: 0, d7within: 0, worst: 'ok', worstKey: 'ok' });
    const g = byCorp.get(x.corp);
    g.items.push(x);
    if (x.bytes != null) { g.bytes += x.bytes; g.measured++; }
    if (x.bytes != null && x.d7) { g.d7 += x.d7.bytes; g.d7n++; if (x.d7.within) g.d7within++; }
    if ((TONE_RANK[x.st.tone] ?? 3) < (TONE_RANK[g.worst] ?? 3)) { g.worst = x.st.tone; g.worstKey = x.st.key; }
  }
  const corps = [...byCorp.values()].map((g) => ({
    corp: g.corp, label: g.label, targets: g.items.length, measured: g.measured, unmeasured: g.items.length - g.measured,
    bytes: g.measured ? g.bytes : null, share: totalBytes && g.measured ? g.bytes / totalBytes : null,
    d7: g.d7n ? g.d7 : null, d7Within: g.d7n > 0 && g.d7within === g.d7n, d7Partial: g.d7n > 0 && g.d7n < g.measured,
    worst: g.worst, worstKey: g.worstKey,
    items: g.items.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || _coll.compare(a.label || a.path, b.label || b.path)),
  })).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || (a.corp ? 0 : 1) - (b.corp ? 0 : 1) || _coll.compare(a.label, b.label));

  // 전 법인 폴더 순위 — 대상별 상위 폴더(개요의 상위 묶음)를 모아 크기 순.
  const folders = [];
  for (const x of items) {
    if (x.ov?.state !== 'ok') continue;
    for (const u of x.ov.top || []) {
      const b = numOrNull(u?.bytes);
      if (b == null) continue;
      folders.push({
        name: String(u.name || ''), bytes: b, res: numOrNull(u.res), share: numOrNull(u.share),
        d7: u.d7 && numOrNull(u.d7.bytes) != null ? { bytes: u.d7.bytes, within: u.d7.withinRes === true } : null,
        new7: u.new7 === true, hasBase: !!x.ov.base7, corpLabel: x.corpLabel, device: x.device, path: x.ov.scan?.path || x.path,
        targetId: x.t.id, lastValue: x.lastValue, statusKey: x.st.key, scanTs: numOrNull(x.ov.scan?.ts), sizeMode: x.ov.scan?.sizeMode || 'h',
      });
    }
  }
  folders.sort((a, b) => (b.bytes - a.bytes) || String(a.name).localeCompare(String(b.name)) || String(a.targetId).localeCompare(String(b.targetId)));
  const n = DIGEST_TOPN_CHOICES.includes(Number(topN)) ? Number(topN) : 10;
  const top = folders.slice(0, n).map((r, i) => ({ ...r, rank: i + 1 }));

  // 먼저 볼 것 — 실패(나쁨) → 오래됨·권한 오류(주의) → 7일 급증(폴더).
  const watch = [];
  for (const x of items) {
    if (x.st.tone === 'bad') watch.push({ kind: 'bad', item: x });
  }
  for (const x of items) {
    if (x.st.key === 'stale' || x.st.key === 'ok-partial') watch.push({ kind: 'warn', item: x });
  }
  const surges = folders.filter((f) => {
    if (!f.d7 || f.d7.within || f.d7.bytes < SURGE_MIN_BYTES) return false;
    const before = f.bytes - f.d7.bytes;
    return before > 0 && f.d7.bytes / before >= SURGE_MIN_RATIO;
  }).sort((a, b) => b.d7.bytes - a.d7.bytes).slice(0, SURGE_MAX);
  for (const f of surges) watch.push({ kind: 'surge', folder: f });

  const okTsList = items.map((x) => x.okTs).filter((v) => v != null);
  return {
    now, topN: n, demoExcluded: excludeDemo ? demoCount : 0, demoIncluded: excludeDemo ? 0 : demoCount,
    totals: {
      corps: corps.filter((c) => c.corp).length, corpGroups: corps.length, targets: items.length,
      measured: measured.length, unmeasured: items.length - measured.length, bytes: totalBytes,
      d7: d7Sum, d7Targets: withBase.length, d7Pct: d7Sum != null && d7BaseBytes > 0 ? d7Sum / d7BaseBytes : null,
      d7Within: withBase.length > 0 && withBase.every((x) => x.d7.within),
    },
    counts, corps, top, watch, biggest: top[0] || null,
    newestOk: okTsList.length ? Math.max(...okTsList) : null, oldestOk: okTsList.length ? Math.min(...okTsList) : null,
    approx: top.some((r) => r.sizeMode !== 'k'),
  };
}

/** '직전 발송 뒤 새 성공 조사가 있는가' 판정용 표지 — 포함된 대상의 마지막 성공 조사 시각 중 가장 늦은 것. */
export function scanMarkOf(model) {
  return numOrNull(model?.newestOk);
}
