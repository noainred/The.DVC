/**
 * 아이실론 디렉터리 사용량 **종합 메일** 설정 화면의 판정·문구(v2.742, 순수 — vitest).
 *
 * 사용자 요청: 전 법인 결과를 모아 정한 요일·시각에 한 통으로 보낸다(Claude Design 시안 ② '종합 메일 설정' 승인).
 *  · 저장 판정은 서버(`server/src/isidu/digestRules.js normalizeDigest`)가 한다 — 형식이 틀리면 400 이 칸(field)을 짚는다.
 *    이 모듈은 입력 중에 미리 알려 줄 뿐이고, 같은 규칙의 사본이다(번들 경계 — 웹 테스트가 서버 모듈과 같은 입력으로 대조한다):
 *    받는 사람(`recipientsOf` ↔ `digestRecipients`) · 다음 회차(`nextSlots` ↔ `nextDigestSlots`) · 요일 표기(`daysLabel`).
 *  · 시각은 서버가 준 포탈 오프셋(`offsetMin`, 기본 한국 시각)으로 쓴다 — 브라우저 시간대에 기대지 않는다.
 *  · 기록 문구의 코드는 서버와 1:1 이다(`MISSED_TEXT` ↔ DIGEST_MISSED_REASONS · `SKIP_TEXT` ↔ DIGEST_SKIP_CODES — 웹 테스트가 서버 소스에서 뽑아 대조).
 *  · v2.745 '담을 내용'(시안 ⑥): 전 법인 사용자 Top N · 법인별 사용자 Top M 의 범위는 `DIGEST_RANGES`(서버와 같은 값 — 웹 테스트가 대조)이고
 *    숫자 칸 판정(`countField`)도 서버 `normalizeDigest` 와 같은 규칙이다 — 빈 칸은 '그대로'(저장된 값 유지 — `Number('')` 가 0 이 되는 함정),
 *    범위 밖·정수 아님은 저장하지 않는다(자르지 않는다). 폼은 숫자 칸을 **입력한 글자 그대로** 들고 있어 틀린 값이 화면에서 사라지지 않는다.
 *    '메일에 싣는 사용자 행' 은 최대치(전 법인 N + 법인 수 × M)이고 법인 수는 화면이 받은 대상 목록에서 센다 — 모르면 '—'(지어내지 않는다).
 */
import { parseMailInput, isEmail, MAIL_LIST_MAX } from './isiduText.js';
import { unitText } from '../unitText.js';
import { numOrNull } from '../../numOrNull.js';

export const DAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
/** 화면 요일 버튼 순서 — 월요일부터(사람이 읽는 순서). 값은 0 = 일요일. */
export const DAY_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);
export const DAY_PRESETS = Object.freeze([
  { key: 'weekdays', label: '평일', days: [1, 2, 3, 4, 5] },
  { key: 'every', label: '매일', days: [0, 1, 2, 3, 4, 5, 6] },
  { key: 'mwf', label: '월·수·금', days: [1, 3, 5] },
  { key: 'none', label: '모두 해제', days: [] },
]);
export const HOURS = Object.freeze(Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')));
export const MINUTES = Object.freeze(['00', '10', '20', '30', '40', '50']);
/** 순위 개수 범위(v2.745) — 서버 `digestRules.js DIGEST_RANGES` 와 같은 값(웹 테스트가 대조한다). 화면 문구의 숫자는 이 값에서 만든다. */
export const DIGEST_RANGES = Object.freeze({
  topN: Object.freeze({ min: 1, max: 50, def: 10 }),
  corpTopM: Object.freeze({ min: 0, max: 20, def: 0 }),
});
/** 빠른 선택(시안 ⑥) — 전 법인 / 법인별. 0 = 법인별 절을 싣지 않는다. */
export const TOPN_PRESETS = Object.freeze([5, 10, 20, 30]);
export const CORP_TOPM_PRESETS = Object.freeze([0, 3, 5, 10]);
/** 사용자 행이 이보다 많으면 '메일이 길어집니다' 경고(화면 안내 기준 — 서버가 막지는 않는다). */
export const LONG_MAIL_ROWS = 120;
const COUNT_KEYS = Object.freeze(['topN', 'corpTopM']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;
const DEF_OFFSET = 540;

/** 범위 안의 정수면 그 값, 아니면 null(서버 digestRules.js intIn 과 같은 규칙 — 같은 numOrNull 판정). */
const intIn = (v, r) => { const n = numOrNull(v); return n != null && Number.isInteger(n) && n >= r.min && n <= r.max ? n : null; };

/**
 * 순위 개수 칸 하나의 판정 — 서버 `normalizeDigest` 의 숫자 칸(numField)과 같은 규칙.
 * 빈 값·빠진 칸 = `{keep:true}`(저장된 값 그대로) · 범위 안 정수 = `{value}` · 그 밖(범위 밖·소수·글자·true·[]) = `{error:true}`.
 * @param {unknown} v @param {'topN'|'corpTopM'} key
 */
export function countField(v, key) {
  const r = DIGEST_RANGES[key];
  if (!r) return { error: true };
  if (v == null || (typeof v === 'string' && v.trim() === '')) return { keep: true };
  const n = intIn(v, r);
  return n == null ? { error: true } : { value: n };
}

/** 빠른 선택 버튼 글자 — 0 은 '0 · 빼기'(법인별 절을 싣지 않음). */
export const presetLabel = (v) => (Number(v) === 0 ? '0 · 빼기' : String(v));

/** 칸 설명(시안 ⑥) — 범위 숫자는 DIGEST_RANGES 에서. */
export function countHint(key) {
  const r = DIGEST_RANGES[key];
  if (key === 'topN') return `모든 법인을 합쳐 큰 순서로 싣습니다. ${r.min}~${r.max}명.`;
  return `법인마다 그 법인 안에서 큰 순서로 싣습니다. ${r.min}~${r.max}명 · ${r.min} 이면 이 절을 싣지 않습니다.`;
}

/** 저장된 폼의 숫자 칸 값(없거나 틀리면 null). */
const savedCount = (saved, key) => countField(saved?.[key], key).value ?? null;

/** 빈 칸이면 '저장된 값을 그대로 둡니다' 안내(빈 칸이 아니면 null). */
export function keptHint(f, saved, key) {
  if (!countField(f?.[key], key).keep) return null;
  const v = savedCount(saved, key);
  return v == null ? '비워 두면 저장된 값을 그대로 둡니다.' : `비워 두면 저장된 값 ${v} 을 그대로 둡니다.`;
}

const intDays = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);

/** 요일 목록 → '평일' / '매일' / '월·수·금'(서버 daysLabel 과 같은 글자). */
export function daysLabel(days) {
  const d = intDays(days);
  if (d.length === 7) return '매일';
  if (d.join(',') === '1,2,3,4,5') return '평일';
  if (!d.length) return '요일 없음';
  return d.map((x) => DAY_LABELS[x]).join('·');
}

/** 일정 한 줄 — '매주 월·수·금 08:00' / '평일 08:00'(메일 본문 scheduleText 와 같은 글자). */
export function scheduleText(days, time) {
  const lab = daysLabel(days);
  return lab === '매일' || lab === '평일' ? `${lab} ${time || '—'}` : `매주 ${lab} ${time || '—'}`;
}

/** 서버 설정 → 화면 폼. 시각이 10분 단위가 아니면(API 로 저장한 값) 그 분을 그대로 둔다 — 선택지에 넣어 보인다. */
export function formFromDigest(d) {
  const g = d && typeof d === 'object' ? d : {};
  const time = TIME_RE.test(String(g.time || '')) ? String(g.time) : '08:00';
  return {
    enabled: g.enabled === true,
    days: Array.isArray(g.days) ? intDays(g.days) : [1],
    hour: time.slice(0, 2), minute: time.slice(3, 5),
    includeAdmin: g.includeAdmin !== false,
    to: (Array.isArray(g.to) ? g.to : []).join('\n'),
    // 숫자 칸은 글자로 든다(입력한 그대로 — 틀린 값이 화면에서 사라지지 않게). 저장값 판정은 서버 digestOf 와 같다(옛 파일 corpTopM 없음 = 0).
    topN: String(intIn(g.topN, DIGEST_RANGES.topN) ?? DIGEST_RANGES.topN.def),
    corpTopM: String(intIn(g.corpTopM, DIGEST_RANGES.corpTopM) ?? DIGEST_RANGES.corpTopM.def),
    includeWatch: g.includeWatch !== false,
    includeTargets: g.includeTargets !== false,
    skipIfNoNew: g.skipIfNoNew === true,
  };
}

/** 분 선택지 — 기본 10분 단위 + 지금 값(10분 단위가 아니면). */
export function minuteChoices(cur) {
  const c = String(cur || '');
  return MINUTES.includes(c) || !/^[0-5]\d$/.test(c) ? [...MINUTES] : [...MINUTES, c].sort();
}

/**
 * 화면 폼 → 저장 요청 본문(서버가 다시 판정한다).
 * 순위 개수: 빈 칸은 **보내지 않는다**(서버가 저장된 값을 그대로 둔다 — '' 를 0 으로 보내면 법인별 절이 조용히 꺼진다) ·
 * 범위 안 정수는 수로 · 틀린 값은 글자 그대로 보내 서버가 400 으로 칸을 짚게 한다(화면은 그 전에 저장을 잠근다).
 */
export function digestBody(f) {
  const out = {
    enabled: !!f.enabled, days: intDays(f.days), time: `${f.hour}:${f.minute}`, includeAdmin: !!f.includeAdmin,
    to: String(f.to ?? ''), includeWatch: !!f.includeWatch, includeTargets: !!f.includeTargets, skipIfNoNew: !!f.skipIfNoNew,
  };
  for (const k of COUNT_KEYS) {
    const c = countField(f?.[k], k);
    if (c.value != null) out[k] = c.value;
    else if (c.error) out[k] = String(f[k]);
  }
  return out;
}

/**
 * 바뀐 칸이 있는가 — 숫자 칸은 **값**으로 비교한다('010' = '10', 빈 칸 = 저장된 값 그대로). 틀린 값은 바뀐 것이다.
 * 이 판정이 '지금 한 번 보내기' 를 잠근다(저장된 설정으로 보내기 때문 — 기존 규칙).
 */
export function formDirty(f, saved) {
  if (!f || !saved) return false;
  const canon = (x) => {
    const o = { ...x };
    for (const k of COUNT_KEYS) {
      const c = countField(x?.[k], k);
      o[k] = c.error ? `bad:${String(x?.[k] ?? '').trim()}` : c.keep ? savedCount(saved, k) : c.value;
    }
    return o;
  };
  return JSON.stringify(canon(f)) !== JSON.stringify(canon(saved));
}

/** 요일 하나 켜기/끄기. */
export function toggleDay(days, d) {
  const set = new Set(intDays(days));
  if (set.has(d)) set.delete(d); else set.add(d);
  return intDays([...set]);
}

/** 프리셋이 지금 요일과 같은가(버튼 눌림 표시). */
export const presetActive = (days, p) => intDays(days).join(',') === intDays(p.days).join(',');

/**
 * 받는 사람(서버 digestRecipients 와 같은 규칙) — 통합 관리자(고르면) ∪ 추가 주소, 같은 주소(대소문자 무시)는 한 번.
 * @returns {{count:number, fromAdmin:number, fromExtra:number, dupes:number, invalid:string[], over:number}}
 */
export function recipientsOf(f, adminTo = []) {
  const extra = parseMailInput(f?.to);
  const admin = f?.includeAdmin ? (Array.isArray(adminTo) ? adminTo : []).map((a) => String(a ?? '').trim()).filter(isEmail) : [];
  const seen = new Set(); let fromAdmin = 0; let fromExtra = 0; let dupes = extra.dupes;
  for (const [src, list] of [['a', admin], ['e', extra.list]]) {
    for (const a of list) {
      const k = a.toLowerCase();
      if (seen.has(k)) { dupes++; continue; }
      seen.add(k);
      if (src === 'a') fromAdmin++; else fromExtra++;
    }
  }
  return { count: fromAdmin + fromExtra, fromAdmin, fromExtra, dupes, invalid: extra.invalid, over: extra.over };
}

/** 입력 중 문제(저장 전에 미리) — 서버가 같은 이유로 400 을 준다. */
export function formIssues(f, adminTo = []) {
  const r = recipientsOf(f, adminTo);
  const out = {};
  if (f?.enabled && !intDays(f.days).length) out.days = '요일을 하나 이상 고르세요 — 이대로는 저장할 수 없습니다.';
  if (r.invalid.length) out.to = `형식이 틀린 주소 ${r.invalid.length}개: ${r.invalid.slice(0, 3).join(', ')}${r.invalid.length > 3 ? ' …' : ''} — 저장하지 않습니다.`;
  else if (r.over) out.to = `추가 받는 사람은 ${MAIL_LIST_MAX}명까지입니다(${r.over}명 초과).`;
  if (f?.enabled && !r.count && !out.to) out.noRecipients = '받는 사람이 없습니다 — 통합 관리자를 넣거나 주소를 적으세요.';
  // 순위 개수 — 서버는 켜짐과 무관하게 400 이므로 꺼져 있어도 본다.
  const RN = DIGEST_RANGES.topN; const RM = DIGEST_RANGES.corpTopM;
  if (countField(f?.topN, 'topN').error) out.topN = `전 법인 사용자 Top 은 ${RN.min}~${RN.max} 사이 정수여야 합니다 — 이대로는 저장할 수 없습니다.`;
  if (countField(f?.corpTopM, 'corpTopM').error) out.corpTopM = `법인별 사용자 Top 은 ${RM.min}~${RM.max} 사이 정수여야 합니다(${RM.min} = 싣지 않음) — 이대로는 저장할 수 없습니다.`;
  return out;
}

/* ── 담을 내용 — 사용자 행 미리 계산(v2.745) ─────────────────────────── */
/**
 * 대상 목록(메인 목록 응답의 행) → 법인 묶음 수. **실제 메일의 법인별 절과 같은 묶음**이다(서버 buildDigestModel —
 * 법인 = corp → datacenterId, 법인 미지정 대상은 한 묶음, 데모(mock-) 대상은 실제 메일에서 빠진다). 목록을 모르면 null.
 * @returns {{corps:number, unassigned:boolean, demoTargets:number}|null}
 */
export function corpGroupsOf(rows) {
  if (!Array.isArray(rows)) return null;
  const real = new Set(); let demo = 0;
  for (const t of rows) {
    if (!t || typeof t !== 'object' || !t.id) continue;
    if (String(t.id).startsWith('mock-')) { demo++; continue; }
    real.add(String(t.corp || t.datacenterId || '').trim());
  }
  return { corps: real.size, unassigned: real.has(''), demoTargets: demo };
}

/**
 * 사용자 행 최대치 = 전 법인 N + 법인 수 × M(M = 0 이면 N). 빈 칸은 저장된 값으로 센다. 값이 틀리거나 법인 수를 모르면 null.
 * @returns {{topN:number|null, corpTopM:number|null, corps:number|null, total:number|null, long:boolean, invalid:boolean, groups:object|null}}
 */
export function rowsPlan(f, saved, groups) {
  const val = (k) => { const c = countField(f?.[k], k); return c.error ? null : c.keep ? savedCount(saved, k) : c.value; };
  const n = val('topN'); const m = val('corpTopM');
  const g = groups && Number.isInteger(groups.corps) && groups.corps >= 0 ? groups : null;
  const corps = g ? g.corps : null;
  const total = n == null || m == null ? null : m === 0 ? n : corps == null ? null : n + corps * m;
  return { topN: n, corpTopM: m, corps, total, long: total != null && total > LONG_MAIL_ROWS, invalid: n == null || m == null, groups: g };
}

/**
 * 미리 계산 문구 — { total('35'·'—'), expr('전 법인 10 + 법인별 5곳 × 5'), notes[], long(경고 문장 또는 null) }.
 * '최대' 다 — 사용자 폴더가 그보다 적으면 있는 만큼만 싣는다.
 */
export function rowsPlanText(p) {
  const n = p?.topN == null ? '—' : String(p.topN);
  let corp;
  if (p?.corpTopM == null) corp = '—';
  else if (p.corpTopM === 0) corp = '0(싣지 않음)';
  else corp = `${p.corps == null ? '—' : p.corps}곳 × ${p.corpTopM}`;
  const notes = [];
  const g = p?.groups || null;
  if (p?.corpTopM === 0) notes.push('법인별 사용자 Top 절은 싣지 않습니다.');
  else if (p?.corpTopM != null && g) {
    notes.push(`지금 등록된 법인 ${g.corps}곳 기준입니다${g.unassigned ? '(법인 미지정 대상은 한 묶음으로 셉니다)' : ''}. 사용자 폴더가 그보다 적은 법인은 있는 만큼만 싣습니다.`);
  } else if (p?.corpTopM != null) notes.push('등록된 법인 수를 알 수 없어 줄 수를 계산하지 않았습니다(이 화면이 대상 목록을 받지 못했습니다).');
  if (g?.demoTargets) {
    notes.push(g.corps === 0
      ? '데모 대상만 있습니다 — 데모 데이터는 실제 메일에 넣지 않습니다(미리보기에는 넣습니다).'
      : `데모 대상 ${g.demoTargets}개는 실제 메일에서 빠집니다 — 위 법인 수에 넣지 않았습니다(미리보기에는 넣습니다).`);
  }
  return {
    total: p?.total == null ? '—' : String(p.total),
    expr: `전 법인 ${n} + 법인별 ${corp}`,
    notes,
    long: p?.long ? `사용자 행이 최대 ${p.total}줄이라 메일이 길어집니다. 휴대폰 메일 앱에서는 아래로 많이 내려야 합니다.` : null,
  };
}

/**
 * 메일 순서(시안 ⑥ 오른쪽 카드) — 서버 renderDigestMail 의 절 순서와 같다(웹 테스트가 서버 소스로 대조).
 * 끈 절은 지우지 않고 off 로 둔다(무엇이 빠지는지 보이게).
 * @returns {{key:string, text:string, off:boolean, focus:boolean}[]}
 */
export function mailOrder(f, plan) {
  const n = plan?.topN; const m = plan?.corpTopM;
  return [
    { key: 'kpi', text: '요약 숫자', off: false, focus: false },
    { key: 'watch', text: '먼저 볼 것', off: !f?.includeWatch, focus: false },
    { key: 'corps', text: '법인별 사용량', off: false, focus: false },
    { key: 'top', text: `전 법인 사용자 Top ${n == null ? '—' : n}`, off: false, focus: true },
    { key: 'corpTop', text: `법인별 사용자 Top ${m == null ? '—' : m}`, off: m === 0, focus: true },
    { key: 'targets', text: '수집 대상별', off: !f?.includeTargets, focus: false },
    { key: 'how', text: '숫자를 읽는 법', off: false, focus: false },
  ];
}

/* ── 시각 ─────────────────────────────────────────────────────────── */
const parts = (ms, off) => { const d = new Date(Number(ms) + off * MIN); return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };

/** 다음 회차 n 개(서버 nextDigestSlots 와 같은 계산 — 포탈 시각의 매주 일정). 켜지 않았거나 요일이 없으면 []. */
export function nextSlots(f, now = Date.now(), n = 3, offsetMin = DEF_OFFSET) {
  const days = intDays(f?.days);
  if (!f?.enabled || !days.length) return [];
  const h = Number(f.hour); const mi = Number(f.minute);
  if (!Number.isInteger(h) || !Number.isInteger(mi)) return [];
  const out = []; let after = now;
  for (let k = 0; k < n; k++) {
    const b = parts(after, offsetMin); let found = null;
    for (let i = 0; i <= 8 && found == null; i++) {
      const day = new Date(Date.UTC(b.y, b.mo, b.d + i));
      if (!days.includes(day.getUTCDay())) continue;
      const occ = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi) - offsetMin * MIN;
      if (occ > after) found = occ;
    }
    if (found == null) break;
    out.push(found); after = found;
  }
  return out;
}

/** epoch ms → '2026-10-19 (월) 08:00'(포탈 시각). */
export function slotText(ms, offsetMin = DEF_OFFSET) {
  if (ms == null || ms === '' || !Number.isFinite(Number(ms))) return '—';
  const p = parts(ms, offsetMin);
  return `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')} (${DAY_LABELS[p.wd]}) ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
/** 짧게 — '10/19(월) 08:00'. */
export function slotShort(ms, offsetMin = DEF_OFFSET) {
  if (ms == null || ms === '' || !Number.isFinite(Number(ms))) return '—';
  const p = parts(ms, offsetMin);
  return `${p.mo + 1}/${p.d}(${DAY_LABELS[p.wd]}) ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
/** 지금부터 회차까지 — '2일 3시간 뒤' / '40분 뒤'. */
export function untilText(ms, now = Date.now()) {
  const d = Number(ms) - now;
  if (!Number.isFinite(d)) return '';
  if (d < MIN) return '곧';
  const days = Math.floor(d / 86_400_000); const hrs = Math.floor((d % 86_400_000) / 3_600_000); const mins = Math.floor((d % 3_600_000) / MIN);
  if (days) return `${days}일${hrs ? ` ${hrs}시간` : ''} 뒤`;
  if (hrs) return `${hrs}시간${mins ? ` ${mins}분` : ''} 뒤`;
  return `${mins}분 뒤`;
}

/* ── 기록 ─────────────────────────────────────────────────────────── */
/** 놓친 회차의 사유 — 서버 DIGEST_MISSED_REASONS 와 1:1. */
export const MISSED_TEXT = Object.freeze({
  down: '포탈이 꺼져 있던 동안의 회차 — 몰아서 보내지 않았습니다',
  late: '정한 시각보다 30분 넘게 늦게 확인 — 몰아서 보내지 않았습니다',
  clock: '서버 시계가 뒤로 가 처리 기록을 다시 잡았습니다',
});
/** 보내지 않은 사유 — 서버 DIGEST_SKIP_CODES 와 1:1. */
export const SKIP_TEXT = Object.freeze({
  'no-targets': '수집 대상이 없습니다',
  'no-recipients': '받는 사람이 없습니다',
  'no-new': '직전 발송 뒤 새로 끝난 성공 조사가 없습니다(새 조사 없으면 생략)',
  'mail-off': '메일을 보낼 수 없는 상태였습니다(메일 발송·종류가 꺼져 있거나 메일 서버 설정 문제)',
  'auth-stopped': '메일 서버 인증이 거부되어 자동 발송이 멈춰 있습니다(설정 › 메일 발송)',
  'demo-only': '데모 대상만 있습니다 — 데모 데이터는 실제 메일에 넣지 않습니다',
  unreadable: '설정 파일을 읽지 못했습니다',
});
const STATE_TAG = Object.freeze({ sent: ['보냄', 'ok'], skipped: ['생략', 'muted'], failed: ['실패', 'bad'], missed: ['놓침', 'warn'] });

/** 기록 한 줄 → { tag, tone, when, text }. 사유는 서버 문구(reason)가 있으면 그것, 없으면 코드 문구. */
export function historyLine(h, offsetMin = DEF_OFFSET) {
  const [tag, tone] = STATE_TAG[h?.state] || [String(h?.state || '—'), 'muted'];
  const when = slotShort(h?.slot ?? h?.at, offsetMin);
  const kind = h?.kind === 'manual' ? '지금 보내기' : '';
  let text;
  if (h?.state === 'sent') text = [kind, h.to != null ? `${h.to}명` : '', h.targets != null ? `대상 ${h.targets}개` : '', h.corps != null ? `법인 ${h.corps}곳` : ''].filter(Boolean).join(' · ');
  else if (h?.state === 'missed') text = `${MISSED_TEXT[h.code] || '보내지 않았습니다'}${h.count > 1 ? ` · ${h.count}번` : ''}`;
  else text = [kind, (h?.code && SKIP_TEXT[h.code]) || h?.reason || '사유 미상'].filter(Boolean).join(' · ');
  if (h?.state === 'failed' && h?.reason) text = [kind, String(h.reason).slice(0, 160)].filter(Boolean).join(' · ');
  return { tag, tone, when, text };
}

/** 보내기·미리보기 결과 → 한 줄 문구. */
export function sendResultText(r) {
  if (!r) return null;
  if (r.ok && r.state === 'sent') return { tone: 'ok', text: `보냈습니다 — 받는 사람 ${unitText(r.to, '명')} · 대상 ${unitText(r.targets, '개')}.` };
  if (r.state === 'edge') return { tone: 'muted', text: '엣지 포탈은 종합 메일을 보내지 않습니다(메인만 보냅니다).' };
  if (r.state === 'skipped') return { tone: 'muted', text: `보내지 않았습니다 — ${(r.code && SKIP_TEXT[r.code]) || r.reason || '사유 미상'}.` };
  return { tone: 'bad', text: `보내지 못했습니다 — ${r.reason || '사유 미상'}` };
}

/** 메일 준비 상태(서버 isiduMailReady) → 경고 한 줄(준비됐으면 null). */
export function mailReadyNote(r) {
  if (!r || r.ok) return null;
  return `${r.reason || '메일을 보낼 수 없는 상태입니다.'} 저장은 되지만 정한 시각에 보내지 못하고 기록에 '생략' 으로 남습니다.`;
}
