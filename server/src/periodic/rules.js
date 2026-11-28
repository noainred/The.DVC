/**
 * periodic/rules.js — 정기 점검 보고의 **순수 규칙**(설정 정규화 · 회차 일정 · 보고 기간 · 판정 합치기 · 범위 절단). 파일 · 타이머 · DB 없음.
 * 설계 docs/design/periodic-report(§4.1 판정 · §4.2 주기 · §4.6 범위) — 컨펌 2026-11-20 '진행해'(§5 기본값).
 *
 *  · 주기 4종: 일일(매일 · 주말 건너뛰기 선택) · 주간(요일) · 월간(날짜 — 그 달에 없는 날은 말일) · 분기(1 · 4 · 7 · 10월의 날짜). 시각은 **포탈 시각**(util/dayKey.js 오프셋 — 기본 KST).
 *  · 회차 규칙은 아이실론 종합 메일 · IP 관리 정기 보고와 같다(isidu/digestRules.planDigestTick): 지금 이전의 가장 최근 회차 하나만 보고, 30분 안이면 만들고
 *    넘었으면 '놓침' 으로 기록만 한다(몰아서 만들지 않는다). 켜거나 시각을 바꾼 시각(since) 이전 회차는 만들지 않는다(소급 없음).
 *  · 판정 4종 + 정보: ok · warn · crit · unknown(확인 불가) · info(판정 없음 — 수치만). 합치는 순서는 computeHealthReport 와 같다 — crit > warn > unknown > ok.
 *    **확인 불가는 정상에 넣지 않는다**(따로 센다) · info 는 종합 수에 넣지 않는다.
 *  · 범위 절단(scopeCutDoc): 법인(vCenter) 행이 있는 항목은 보이는 행만 남기고 판정을 다시 합친다. 법인 행이 없는 항목(포탈 자체 · 전 법인 합계)은
 *    범위 계정에 싣지 않는다('귀속 없는 데이터 미노출' 불변조건).
 */
import { DAY_OFFSET_MIN } from '../util/dayKey.js';
import { localParts, localMs, GRACE_MS, CLOCK_TOL_MS } from '../xferspeed/schedule.js';
import { normalizeMailList, MAIL_LIST_MAX, isEmail } from '../isidu/mailRules.js';
import { numOrNull } from '../util/numOrNull.js';
import { LEDGER_KEEP, scopeCutBackup, backupMatrixOf } from './backupLedger.js';

export const KINDS = Object.freeze(['daily', 'weekly', 'monthly', 'quarterly']);
export const KIND_LABEL = Object.freeze({ daily: '일일', weekly: '주간', monthly: '월간', quarterly: '분기' });
export const KIND_PREFIX = Object.freeze({ daily: 'D', weekly: 'W', monthly: 'M', quarterly: 'Q' });
export const QUARTER_MONTHS = Object.freeze([1, 4, 7, 10]);
export const STATUSES = Object.freeze(['ok', 'warn', 'crit', 'unknown', 'info']);
export const STATUS_LABEL = Object.freeze({ ok: '정상', warn: '주의', crit: '이상', unknown: '확인 불가', info: '정보' });
/** 합치는 순위 — 높을수록 나쁘다(info 는 순위 없음). */
const RANK = Object.freeze({ ok: 0, unknown: 1, warn: 2, crit: 3 });
/** 행렬 부호(한 글자) — 회차 목록을 범위 계정 기준으로 다시 셀 때 쓴다. '-' = 그 법인 행 없음. */
const CODE = Object.freeze({ ok: 'o', warn: 'w', crit: 'c', unknown: 'u', info: 'i' });
const DECODE = Object.freeze({ o: 'ok', w: 'warn', c: 'crit', u: 'unknown', i: 'info' });
export const MISSED_REASONS = Object.freeze(['down', 'late', 'clock']);

const DAY = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SEARCH_DAYS = 400;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m = 1..12

export const KIND_DEFAULTS = Object.freeze({
  daily: Object.freeze({ enabled: true, time: '08:00', skipWeekend: false }),
  weekly: Object.freeze({ enabled: true, time: '08:30', weekday: 1 }),
  monthly: Object.freeze({ enabled: true, time: '09:00', monthDay: 1 }),
  quarterly: Object.freeze({ enabled: true, time: '09:30', monthDay: 1 }),
});
/** 보관 일수 기본 · 범위(설계 §5 ②). */
export const RETAIN = Object.freeze({
  daily: Object.freeze({ def: 90, min: 7, max: 730 }),
  weekly: Object.freeze({ def: 365, min: 30, max: 1825 }),
  monthly: Object.freeze({ def: 1095, min: 90, max: 3650 }),
  quarterly: Object.freeze({ def: 1825, min: 365, max: 3650 }),
});
/**
 * 전달 기본값. 메일은 켜짐(통합 관리자 = 메일 설정의 기본 받는 사람) — 메일 설정 자체가 꺼져 있으면 공용 경로가 보내지 않는다.
 * 알림 채널(Slack · Teams · 웹훅)은 꺼짐 — 기존 일일 리포트와 겹쳐 두 번 받지 않게(설계 §5 ③ '나란히'). 공지는 주간 · 월간 · 분기 켜짐(§5 ⑦).
 * 이슈 자동 등록은 꺼짐(§5 ⑦).
 */
export const DELIVERY_DEFAULTS = Object.freeze({
  mail: Object.freeze({ enabled: true, includeAdmin: true, to: Object.freeze([]), kinds: Object.freeze([...KINDS]), corpTo: Object.freeze({}), attach: true }),
  chat: Object.freeze({ enabled: false, kinds: Object.freeze(['daily', 'weekly', 'monthly']) }),
  notice: Object.freeze({ enabled: true, kinds: Object.freeze(['weekly', 'monthly', 'quarterly']) }),
  issues: Object.freeze({ enabled: false, dailyMax: 10 }),
});
/**
 * v3.59 보고서 3절 '백업 성공 · 실패 현황'(설계 §9) — 실을 주기 · 백업 · 하루 치 적재 · 적재 보관(컨펌 ③ — 400일).
 *   적재는 보고서를 꺼도 쌓는다(주간 · 월간이 쓰는 날 수가 끊기지 않게) — ledger:false 일 때만 멈춘다.
 */
export const BACKUP_DEFAULTS = Object.freeze({ kinds: Object.freeze([...KINDS]), products: Object.freeze({ veeam: true, bareos: true, clone: true }), ledger: true, keepDays: LEDGER_KEEP.def });
const BK_PRODUCTS = Object.freeze(['veeam', 'bareos', 'clone']);
const CORP_MAX = 200;
const ITEM_OVERRIDE_MAX = 200;
const ITEM_KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/* ───────────────────────── 설정 ───────────────────────── */

const intIn = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };
const kindList = (v, def) => (Array.isArray(v) ? [...new Set(v.map(String).filter((k) => KINDS.includes(k)))] : [...def]);

function kindOf(kind, raw) {
  const d = KIND_DEFAULTS[kind];
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled, time: TIME_RE.test(String(r.time || '')) ? String(r.time) : d.time };
  if (kind === 'daily') out.skipWeekend = r.skipWeekend === true;
  if (kind === 'weekly') out.weekday = intIn(r.weekday, 0, 6) ?? d.weekday;
  if (kind === 'monthly' || kind === 'quarterly') out.monthDay = intIn(r.monthDay, 1, 31) ?? d.monthDay;
  const since = numOrNull(r.since);
  out.since = since != null && since > 0 ? since : null;
  return out;
}

/** 저장 값 → 쓰는 값(옛 · 손상 값도 안전하게 — 모르는 키는 버린다). */
export function settingsOf(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const kinds = {};
  for (const k of KINDS) kinds[k] = kindOf(k, s.kinds?.[k]);
  const items = {};
  for (const [key, v] of Object.entries(s.items && typeof s.items === 'object' && !Array.isArray(s.items) ? s.items : {}).slice(0, ITEM_OVERRIDE_MAX)) {
    if (!ITEM_KEY_RE.test(key) || !v || typeof v !== 'object') continue;
    const o = {};
    if (typeof v.enabled === 'boolean') o.enabled = v.enabled;
    if (Array.isArray(v.kinds)) o.kinds = kindList(v.kinds, []);
    if (Object.keys(o).length) items[key] = o;
  }
  const m = s.mail && typeof s.mail === 'object' ? s.mail : {};
  const corpTo = {};
  for (const [id, list] of Object.entries(m.corpTo && typeof m.corpTo === 'object' && !Array.isArray(m.corpTo) ? m.corpTo : {}).slice(0, CORP_MAX)) {
    const l = (Array.isArray(list) ? list : []).filter(isEmail).slice(0, MAIL_LIST_MAX);
    if (id && l.length) corpTo[String(id).slice(0, 128)] = l;
  }
  const c = s.chat && typeof s.chat === 'object' ? s.chat : {};
  const n = s.notice && typeof s.notice === 'object' ? s.notice : {};
  const is = s.issues && typeof s.issues === 'object' ? s.issues : {};
  const D = DELIVERY_DEFAULTS;
  const retainDays = {};
  for (const k of KINDS) retainDays[k] = intIn(s.retainDays?.[k], RETAIN[k].min, RETAIN[k].max) ?? RETAIN[k].def;
  const bk = s.backup && typeof s.backup === 'object' && !Array.isArray(s.backup) ? s.backup : {};
  const bkp = bk.products && typeof bk.products === 'object' && !Array.isArray(bk.products) ? bk.products : {};
  const backup = { kinds: kindList(bk.kinds, BACKUP_DEFAULTS.kinds), products: Object.fromEntries(BK_PRODUCTS.map((p) => [p, bkp[p] !== false])), ledger: bk.ledger !== false,
    keepDays: intIn(bk.keepDays, LEDGER_KEEP.min, LEDGER_KEEP.max) ?? LEDGER_KEEP.def };
  return {
    kinds, items,
    mail: { enabled: typeof m.enabled === 'boolean' ? m.enabled : D.mail.enabled, includeAdmin: m.includeAdmin !== false, to: (Array.isArray(m.to) ? m.to : []).filter(isEmail).slice(0, MAIL_LIST_MAX),
      kinds: kindList(m.kinds, D.mail.kinds), corpTo, attach: m.attach !== false },
    chat: { enabled: typeof c.enabled === 'boolean' ? c.enabled : D.chat.enabled, kinds: kindList(c.kinds, D.chat.kinds) },
    notice: { enabled: typeof n.enabled === 'boolean' ? n.enabled : D.notice.enabled, kinds: kindList(n.kinds, D.notice.kinds) },
    issues: { enabled: is.enabled === true, dailyMax: intIn(is.dailyMax, 1, 50) ?? D.issues.dailyMax },
    retainDays, backup,
    updatedAt: numOrNull(s.updatedAt), updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy.slice(0, 64) : null,
  };
}

/** 회차를 정하는 필드가 같은가(켜기 · 시각 · 요일 · 날짜). */
const sameDef = (a, b) => JSON.stringify([a.enabled, a.time, a.skipWeekend ?? null, a.weekday ?? null, a.monthDay ?? null])
  === JSON.stringify([b.enabled, b.time, b.skipWeekend ?? null, b.weekday ?? null, b.monthDay ?? null]);

/**
 * 저장 경로 정규화. 잘못된 값은 고치지 않고 { error, field } — 라우트가 400(조용히 고치면 정한 값이 사라진다 — usageMailRules 규칙).
 * `knownItems` 를 주면 모르는 항목 키를 거절한다. `knownVcIds` 를 주면 모르는 법인 받는 사람을 거절한다.
 * @returns {{settings:object}|{error:string, field:string}}
 */
export function normalizeSettings(input, prev, { now = Date.now(), by = null, knownItems = null, knownVcIds = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '설정 형식이 잘못됐습니다.', field: 'settings' };
  const p = settingsOf(prev);
  const out = settingsOf(prev);
  if (input.kinds != null) {
    if (typeof input.kinds !== 'object' || Array.isArray(input.kinds)) return { error: '주기 설정 형식이 잘못됐습니다.', field: 'kinds' };
    for (const k of KINDS) {
      const v = input.kinds[k];
      if (v == null) continue;
      if (typeof v !== 'object' || Array.isArray(v)) return { error: `${KIND_LABEL[k]} 설정 형식이 잘못됐습니다.`, field: `kinds.${k}` };
      const cur = { ...p.kinds[k] };
      if (v.enabled != null) { if (typeof v.enabled !== 'boolean') return { error: `${KIND_LABEL[k]} 켜기 값이 잘못됐습니다.`, field: `kinds.${k}.enabled` }; cur.enabled = v.enabled; }
      if (v.time != null) { if (!TIME_RE.test(String(v.time).trim())) return { error: `${KIND_LABEL[k]} 시각은 00:00~23:59 형식이어야 합니다.`, field: `kinds.${k}.time` }; cur.time = String(v.time).trim(); }
      if (k === 'daily' && v.skipWeekend != null) cur.skipWeekend = v.skipWeekend === true;
      if (k === 'weekly' && v.weekday != null) { const w = intIn(v.weekday, 0, 6); if (w == null) return { error: '주간 보고 요일이 잘못됐습니다.', field: 'kinds.weekly.weekday' }; cur.weekday = w; }
      if ((k === 'monthly' || k === 'quarterly') && v.monthDay != null) {
        const d = intIn(v.monthDay, 1, 31);
        if (d == null) return { error: `${KIND_LABEL[k]} 보고 날짜는 1~31 입니다.`, field: `kinds.${k}.monthDay` };
        cur.monthDay = d;
      }
      // 켜거나 회차 정의를 바꾸면 기준을 지금으로 — 이미 지난 회차를 소급해 만들지 않는다.
      if (cur.enabled && !(sameDef(p.kinds[k], cur) && p.kinds[k].since)) cur.since = now;
      if (!cur.enabled) cur.since = null;
      out.kinds[k] = cur;
    }
  }
  if (input.items != null) {
    if (typeof input.items !== 'object' || Array.isArray(input.items)) return { error: '점검 항목 설정 형식이 잘못됐습니다.', field: 'items' };
    const items = {};
    for (const [key, v] of Object.entries(input.items).slice(0, ITEM_OVERRIDE_MAX)) {
      if (!ITEM_KEY_RE.test(key) || (knownItems && !knownItems.has(key))) return { error: `모르는 점검 항목입니다: ${String(key).slice(0, 48)}`, field: `items.${String(key).slice(0, 48)}` };
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `점검 항목 ${key} 형식이 잘못됐습니다.`, field: `items.${key}` };
      const o = {};
      if (v.enabled != null) o.enabled = v.enabled === true;
      if (v.kinds != null) {
        if (!Array.isArray(v.kinds) || v.kinds.some((x) => typeof x !== 'string' || !KINDS.includes(x))) return { error: `점검 항목 ${key} 의 주기는 일일 · 주간 · 월간 · 분기 중에서 고릅니다.`, field: `items.${key}.kinds` };
        o.kinds = kindList(v.kinds, []);
      }
      if (Object.keys(o).length) items[key] = o;
    }
    out.items = items;
  }
  const mailErr = (field, label, lst) => (lst.invalid.length ? { error: `${label} 주소 형식이 잘못됐습니다: ${lst.invalid.slice(0, 3).join(', ')}`, field }
    : lst.over ? { error: `${label}은 ${MAIL_LIST_MAX}명까지입니다.`, field } : null);
  if (input.mail != null) {
    const m = input.mail;
    if (typeof m !== 'object' || Array.isArray(m)) return { error: '메일 설정 형식이 잘못됐습니다.', field: 'mail' };
    if (m.enabled != null) out.mail.enabled = m.enabled === true;
    if (m.includeAdmin != null) out.mail.includeAdmin = m.includeAdmin === true;
    if (m.attach != null) out.mail.attach = m.attach === true;
    if (m.kinds != null) { if (!Array.isArray(m.kinds)) return { error: '메일 주기 형식이 잘못됐습니다.', field: 'mail.kinds' }; out.mail.kinds = kindList(m.kinds, []); }
    if (m.to != null) { const l = normalizeMailList(m.to); const e = mailErr('mail.to', '받는 사람', l); if (e) return e; out.mail.to = l.list; }
    if (m.corpTo != null) {
      if (typeof m.corpTo !== 'object' || Array.isArray(m.corpTo)) return { error: '법인 담당자 설정 형식이 잘못됐습니다.', field: 'mail.corpTo' };
      const corpTo = {};
      for (const [id, v] of Object.entries(m.corpTo).slice(0, CORP_MAX)) {
        const sid = String(id).slice(0, 128);
        const l = normalizeMailList(v);
        if (!l.list.length && !l.invalid.length) continue;
        if (knownVcIds && !knownVcIds.has(sid)) return { error: `모르는 법인(vCenter)입니다: ${sid.slice(0, 40)}`, field: `mail.corpTo.${sid}` };
        const e = mailErr(`mail.corpTo.${sid}`, `법인 ${sid.slice(0, 40)} 담당자`, l);
        if (e) return e;
        corpTo[sid] = l.list;
      }
      out.mail.corpTo = corpTo;
    }
  }
  for (const ch of ['chat', 'notice']) {
    const v = input[ch];
    if (v == null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) return { error: `${ch === 'chat' ? '알림 채널' : '공지'} 설정 형식이 잘못됐습니다.`, field: ch };
    if (v.enabled != null) out[ch].enabled = v.enabled === true;
    if (v.kinds != null) { if (!Array.isArray(v.kinds)) return { error: '주기 형식이 잘못됐습니다.', field: `${ch}.kinds` }; out[ch].kinds = kindList(v.kinds, []); }
  }
  if (input.issues != null) {
    const v = input.issues;
    if (typeof v !== 'object' || Array.isArray(v)) return { error: '이슈 자동 등록 설정 형식이 잘못됐습니다.', field: 'issues' };
    if (v.enabled != null) out.issues.enabled = v.enabled === true;
    if (v.dailyMax != null) { const n = intIn(v.dailyMax, 1, 50); if (n == null) return { error: '이슈 하루 상한은 1~50 입니다.', field: 'issues.dailyMax' }; out.issues.dailyMax = n; }
  }
  if (input.retainDays != null) {
    if (typeof input.retainDays !== 'object' || Array.isArray(input.retainDays)) return { error: '보관 기간 형식이 잘못됐습니다.', field: 'retainDays' };
    for (const k of KINDS) {
      const v = input.retainDays[k];
      if (v == null) continue;
      const n = intIn(v, RETAIN[k].min, RETAIN[k].max);
      if (n == null) return { error: `${KIND_LABEL[k]} 보관 기간은 ${RETAIN[k].min}~${RETAIN[k].max}일입니다.`, field: `retainDays.${k}` };
      out.retainDays[k] = n;
    }
  }
  if (input.backup != null) {
    const v = input.backup;
    if (typeof v !== 'object' || Array.isArray(v)) return { error: '백업 성공 · 실패 현황 설정 형식이 잘못됐습니다.', field: 'backup' };
    if (v.kinds != null) {
      if (!Array.isArray(v.kinds) || v.kinds.some((x) => typeof x !== 'string' || !KINDS.includes(x))) return { error: '백업 현황을 실을 주기는 일일 · 주간 · 월간 · 분기 중에서 고릅니다.', field: 'backup.kinds' };
      out.backup.kinds = kindList(v.kinds, []);
    }
    if (v.products != null) {
      if (typeof v.products !== 'object' || Array.isArray(v.products)) return { error: '백업 대상 형식이 잘못됐습니다.', field: 'backup.products' };
      for (const p of BK_PRODUCTS) {
        if (v.products[p] == null) continue;
        if (typeof v.products[p] !== 'boolean') return { error: `백업 대상(${p}) 값은 켬 · 끔입니다.`, field: `backup.products.${p}` };
        out.backup.products[p] = v.products[p];
      }
    }
    if (v.ledger != null) { if (typeof v.ledger !== 'boolean') return { error: '하루 치 적재 값은 켬 · 끔입니다.', field: 'backup.ledger' }; out.backup.ledger = v.ledger; }
    if (v.keepDays != null) {
      const n = intIn(v.keepDays, LEDGER_KEEP.min, LEDGER_KEEP.max);
      if (n == null) return { error: `백업 적재 보관 기간은 ${LEDGER_KEEP.min}~${LEDGER_KEEP.max}일입니다.`, field: 'backup.keepDays' };
      out.backup.keepDays = n;
    }
  }
  out.updatedAt = now; out.updatedBy = by ? String(by).slice(0, 64) : null;
  return { settings: out };
}

/* ───────────────────────── 회차 일정 ───────────────────────── */

function parseTime(v) {
  const m = TIME_RE.exec(String(v ?? '').trim());
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
}
/** 그 날(포탈 날짜)이 그 주기의 회차 날인가. */
function matchDay(kind, def, y, mo, d, wd) {
  if (kind === 'daily') return !(def.skipWeekend && (wd === 0 || wd === 6));
  if (kind === 'weekly') return wd === def.weekday;
  if (kind === 'monthly' || kind === 'quarterly') {
    if (kind === 'quarterly' && !QUARTER_MONTHS.includes(mo)) return false;
    const last = lastDayOf(y, mo);
    return d === Math.min(def.monthDay, last);   // 그 달에 없는 날은 말일에
  }
  return false;
}

/** after 보다 뒤(>)의 첫 회차 시각. */
export function nextSlot(kind, def, after, offsetMin = DAY_OFFSET_MIN) {
  const t = parseTime(def?.time);
  if (!KINDS.includes(kind) || !t) return null;
  const base = localParts(after, offsetMin);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d + i));
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate(); const wd = day.getUTCDay();
    if (!matchDay(kind, def, y, mo, d, wd)) continue;
    const occ = localMs(y, mo, d, t.h, t.mi, offsetMin);
    if (occ > after) return occ;
  }
  return null;
}
/** at 이하(≤)의 가장 최근 회차 시각. */
export function prevSlot(kind, def, at, offsetMin = DAY_OFFSET_MIN) {
  const t = parseTime(def?.time);
  if (!KINDS.includes(kind) || !t) return null;
  const base = localParts(at, offsetMin);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(Date.UTC(base.y, base.mo - 1, base.d - i));
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate(); const wd = day.getUTCDay();
    if (!matchDay(kind, def, y, mo, d, wd)) continue;
    const occ = localMs(y, mo, d, t.h, t.mi, offsetMin);
    if (occ <= at) return occ;
  }
  return null;
}
/** 다음 회차 n 개. 꺼져 있으면 []. */
export function nextSlots(kind, def, now = Date.now(), n = 3, offsetMin = DAY_OFFSET_MIN) {
  if (!def?.enabled) return [];
  const out = []; let at = now;
  for (let i = 0; i < n; i++) { const nx = nextSlot(kind, def, at, offsetMin); if (nx == null) break; out.push(nx); at = nx; }
  return out;
}

/**
 * 이번 틱에 그 주기에서 할 일(순수) — isidu planDigestTick 과 같은 규칙.
 * @returns {{action:'none'}|{action:'run', slot:number}|{action:'missed', slot:number, reason:string, count:number}|{action:'rebase', lastSlot:number}}
 */
export function planKindTick({ kind, def, state = {}, now = Date.now(), bootAt = 0, offsetMin = DAY_OFFSET_MIN } = {}) {
  if (!def?.enabled) return { action: 'none' };
  const last = numOrNull(state?.lastSlot);
  if (last != null && last > now + CLOCK_TOL_MS) return { action: 'rebase', lastSlot: now, reason: 'clock' };
  const slot = prevSlot(kind, def, now, offsetMin);
  if (slot == null) return { action: 'none' };
  const floor = Math.max(last ?? -Infinity, numOrNull(def.since) ?? -Infinity);
  if (!(slot > floor)) return { action: 'none' };
  if (now - slot <= GRACE_MS) return { action: 'run', slot };
  let count = 0; let at = Number.isFinite(floor) ? floor : slot - 1;
  while (count < 60) { const nx = nextSlot(kind, def, at, offsetMin); if (nx == null || nx > slot) break; count++; at = nx; }
  return { action: 'missed', slot, count: Math.max(1, count), reason: bootAt && slot < bootAt ? 'down' : 'late' };
}

/* ───────────────────────── 보고 기간 · 회차 ID ───────────────────────── */

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 포탈 날짜 y-mo-d 의 0시(epoch ms). */
const dayStart = (y, mo, d, offsetMin) => localMs(y, mo, d, 0, 0, offsetMin);
/** ISO 8601 주차(월요일 시작 · 그 주 목요일의 연도) — storage/usageReport.isoWeekOf 와 같은 정의. */
export function isoWeekOfDate(y, mo, d) {
  const t = Date.UTC(y, mo - 1, d);
  const wd = new Date(t).getUTCDay() || 7;
  const thu = new Date(t + (4 - wd) * DAY);
  const year = thu.getUTCFullYear();
  return { year, week: Math.floor((thu.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1 };
}

/**
 * 회차 시각(slot) → 그 보고서가 다루는 기간 [from, to) 과 회차 ID(기간 기준).
 *  · 일일: 회차 날의 **전날** 0시~24시 — ID `D-YYYY-MM-DD`(그 전날).
 *  · 주간: 회차 날이 든 주의 **앞 ISO 주**(월~일) — ID `W-YYYY-WW`.
 *  · 월간: 회차 달의 **앞 달** — ID `M-YYYY-MM`.
 *  · 분기: 회차 달이 든 분기의 **앞 분기** — ID `Q-YYYY-N`.
 */
export function periodOf(kind, slot, offsetMin = DAY_OFFSET_MIN) {
  const p = localParts(slot, offsetMin);
  if (kind === 'daily') {
    const to = dayStart(p.y, p.mo, p.d, offsetMin);
    const from = to - DAY;
    const q = localParts(from, offsetMin);
    return { from, to, id: `D-${q.y}-${pad(q.mo)}-${pad(q.d)}`, label: `${q.y}-${pad(q.mo)}-${pad(q.d)}` };
  }
  if (kind === 'weekly') {
    const wd = p.wd || 7;                                       // 월 = 1 … 일 = 7
    const thisMon = dayStart(p.y, p.mo, p.d, offsetMin) - (wd - 1) * DAY;
    const from = thisMon - 7 * DAY; const to = thisMon;
    const a = localParts(from, offsetMin); const b = localParts(to - DAY, offsetMin);
    const iw = isoWeekOfDate(a.y, a.mo, a.d);
    return { from, to, id: `W-${iw.year}-${pad(iw.week)}`, label: `${iw.year}년 ${iw.week}주차(${pad(a.mo)}-${pad(a.d)} ~ ${pad(b.mo)}-${pad(b.d)})` };
  }
  if (kind === 'monthly') {
    const y = p.mo === 1 ? p.y - 1 : p.y; const mo = p.mo === 1 ? 12 : p.mo - 1;
    return { from: dayStart(y, mo, 1, offsetMin), to: dayStart(p.y, p.mo, 1, offsetMin), id: `M-${y}-${pad(mo)}`, label: `${y}년 ${mo}월` };
  }
  if (kind === 'quarterly') {
    const qNow = Math.floor((p.mo - 1) / 3);                    // 0..3
    const y = qNow === 0 ? p.y - 1 : p.y; const q = qNow === 0 ? 3 : qNow - 1;
    const from = dayStart(y, q * 3 + 1, 1, offsetMin);
    const to = dayStart(p.y, qNow * 3 + 1, 1, offsetMin);
    return { from, to, id: `Q-${y}-${q + 1}`, label: `${y}년 ${q + 1}분기` };
  }
  return null;
}
/** 수동 회차 ID — 같은 기간의 예약 회차와 겹치지 않게 만든 시각(포탈 시각 HHMMSS)을 붙인다. */
export function manualRunId(baseId, at, offsetMin = DAY_OFFSET_MIN) {
  const d = new Date(Number(at) + offsetMin * 60_000);
  return `${baseId}-m${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
export const RUN_ID_RE = /^[DWMQ]-\d{4}-\d{1,2}(?:-\d{2})?(?:-m\d{6})?$/;

/* ───────────────────────── 판정 합치기 ───────────────────────── */

export const isStatus = (s) => STATUSES.includes(s);
/** 판정 목록의 가장 나쁜 것(crit > warn > unknown > ok). info · 모르는 값은 무시. 없으면 null. */
export function worstOf(list) {
  let best = null;
  for (const s of list || []) if (s in RANK && (best == null || RANK[s] > RANK[best])) best = s;
  return best;
}
/** 항목 목록 → 판정별 개수. */
export function countsOf(items) {
  const c = { ok: 0, warn: 0, crit: 0, unknown: 0, info: 0 };
  for (const it of items || []) if (it && c[it.status] != null) c[it.status] += 1;
  return c;
}
/** 종합 — 판정 항목의 가장 나쁜 것. 판정 항목이 하나도 없으면 'unknown'(보고할 것이 없음을 정상으로 말하지 않는다). */
export function overallOf(items) {
  return worstOf((items || []).filter((it) => it && it.status !== 'info').map((it) => it.status)) || 'unknown';
}
/** 항목 행(법인별)들로 항목 판정을 다시 낸다. info 항목은 info 그대로. 행이 없으면 null(그 범위에 해당 없음). */
export function itemStatusFromRows(item, rows) {
  if (item.status === 'info') return 'info';
  return worstOf((rows || []).map((r) => r.status));
}

/** 회차 문서 → 범위 절단 행렬(목록을 범위 계정 기준으로 다시 셀 때 — 회차마다 문서 전체를 읽지 않게). */
export function matrixOf(doc) {
  const keys = []; const vc = {};
  const items = doc?.items || [];
  items.forEach((it, i) => {
    keys.push(it.key);
    for (const r of it.rows || []) {
      if (!r?.vc) continue;
      if (!vc[r.vc]) vc[r.vc] = '-'.repeat(items.length).split('');
      vc[r.vc][i] = it.status === 'info' ? 'i' : (CODE[r.status] || 'u');
    }
  });
  const out = {};
  for (const [k, arr] of Object.entries(vc)) out[k] = arr.join('');
  const bk = doc?.backup ? backupMatrixOf(doc.backup) : null;   // v3.59 3절 — 보관함 '백업 실패' 열(범위로 다시 센다)
  return { keys, vc: out, ...(bk ? { bk } : {}) };
}
/** 행렬 + 보이는 vCenter 집합 → 판정별 개수 · 종합(범위 계정의 목록용). */
export function scopedCountsFromMatrix(matrix, allowed) {
  const keys = Array.isArray(matrix?.keys) ? matrix.keys : [];
  const per = keys.map(() => []);
  for (const [vc, codes] of Object.entries(matrix?.vc || {})) {
    if (!allowed.has(vc)) continue;
    for (let i = 0; i < keys.length; i++) { const ch = String(codes)[i]; if (ch && ch !== '-') per[i].push(DECODE[ch] || 'unknown'); }
  }
  const items = per.filter((l) => l.length).map((l) => ({ status: l.every((s) => s === 'info') ? 'info' : worstOf(l) || 'unknown' }));
  return { counts: countsOf(items), overall: overallOf(items), items: items.length };
}

/**
 * 범위 절단 — 보이는 vCenter 집합(allowed — null 이면 전체 범위)으로 회차 문서를 자른다(순수 · 새 객체).
 *  · 법인 행이 없는 항목(fleet)은 범위 계정에서 뺀다 · 법인 행 항목은 보이는 행만 남기고 판정을 다시 합친다 · 남은 행이 없으면 뺀다.
 *  · 종합 · 개수 · 법인 목록도 다시 낸다. 조치 필요(actions)는 보이는 법인 것만.
 */
/** 행 묶음 → '법인 3곳 — 이상 1곳 · 정상 2곳'(readers/common.js rowsBasis 와 같은 글 — 순수 · 의존을 늘리지 않으려고 여기 둔다). */
function scopedRowsText(rows) {
  const c = { crit: 0, warn: 0, unknown: 0, ok: 0 };
  for (const r of rows) if (c[r.status] != null) c[r.status] += 1;
  const parts = [];
  if (c.crit) parts.push(`이상 ${c.crit}곳`);
  if (c.warn) parts.push(`주의 ${c.warn}곳`);
  if (c.unknown) parts.push(`확인 불가 ${c.unknown}곳`);
  parts.push(`정상 ${c.ok}곳`);
  return `법인 ${rows.length}곳 — ${parts.join(' · ')}`;
}
export function scopeCutDoc(doc, allowed) {
  if (!doc || !allowed) return doc;
  const items = [];
  for (const it of doc.items || []) {
    if (!it || it.fleet || !Array.isArray(it.rows) || !it.rows.length) continue;
    const rows = it.rows.filter((r) => r && allowed.has(String(r.vc)));
    if (!rows.length) continue;
    const status = it.status === 'info' ? 'info' : (worstOf(rows.map((r) => r.status)) || 'unknown');
    const count = it.status === 'info' ? it.count : rows.reduce((a, r) => a + (numOrNull(r.count) ?? 0), 0);
    // 범위 판본에는 전 법인 글(근거 · 값 · 세부 · 직전 판정)을 싣지 않는다 — 행이 전부 범위 안이어도 근거가 전 법인 수(예 '점검 서버 412대')일 수 있다
    //   (2026-11-28 보안 축 E-1 · 반증 F8 — 기존 결함). 보이는 행으로 다시 낸다.
    const prevSt = worstOf(rows.map((r) => r.prev).filter(Boolean));
    items.push({ ...it, rows, status, count, basis: `내 범위 ${scopedRowsText(rows)}`, value: undefined, detail: undefined, prev: prevSt ? { status: prevSt } : null });
  }
  const corps = (doc.corps || []).filter((c) => allowed.has(String(c.vc)));
  return {
    ...doc, items, corps, counts: countsOf(items), overall: overallOf(items), ...(doc.backup ? { backup: scopeCutBackup(doc.backup, allowed) } : {}),
    corpsTotal: corps.length, corpsReported: corps.filter((c) => c.reported).length, scoped: true,
  };
}

/**
 * 조치 필요 목록 — 이상 → 주의 순, 같은 항목은 법인별 한 줄(설계 ④ 2절). 정보 · 확인 불가는 넣지 않는다(확인 불가는 '확인하지 못한 것' 절).
 * @returns {{status, item, label, axis, vc, corp, basis}[]}
 */
export function actionsOf(doc, corpName = (vc) => vc) {
  const out = [];
  for (const it of doc?.items || []) {
    if (it.status !== 'crit' && it.status !== 'warn') continue;
    const bad = (it.rows || []).filter((r) => r.status === 'crit' || r.status === 'warn');
    if (!bad.length) { out.push({ status: it.status, item: it.key, label: it.label, axis: it.axis, vc: null, corp: '전체', basis: it.basis || '' }); continue; }
    for (const r of bad) out.push({ status: r.status, item: it.key, label: it.label, axis: it.axis, vc: r.vc, corp: corpName(r.vc), basis: r.text || it.basis || '' });
  }
  return out.sort((a, b) => (RANK[b.status] - RANK[a.status]) || String(a.corp).localeCompare(String(b.corp)) || String(a.label).localeCompare(String(b.label)));
}
/** 확인하지 못한 것 — 항목 단위(전체)와 법인 단위 사유. */
export function unknownsOf(doc, corpName = (vc) => vc) {
  const out = [];
  for (const it of doc?.items || []) {
    if (it.status === 'info') continue;
    const unk = (it.rows || []).filter((r) => r.status === 'unknown');
    if (it.status === 'unknown' && (!unk.length || unk.length === (it.rows || []).length)) {
      out.push({ item: it.key, label: it.label, where: unk.length ? `${unk.length}곳 전부` : '전체', reason: it.unknownReason || unk[0]?.text || '확인하지 못했습니다', fix: it.fix || '' });
      continue;
    }
    if (unk.length) out.push({ item: it.key, label: it.label, where: unk.slice(0, 8).map((r) => corpName(r.vc)).join(' · ') + (unk.length > 8 ? ` 외 ${unk.length - 8}` : ''), reason: unk[0]?.text || '확인하지 못했습니다', fix: it.fix || '' });
  }
  return out;
}
