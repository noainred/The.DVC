/**
 * 아이실론 디렉터리 사용량 **종합 메일** 설정 화면의 판정·문구(v2.742, 순수 — vitest).
 *
 * 사용자 요청: 전 법인 결과를 모아 정한 요일·시각에 한 통으로 보낸다(Claude Design 시안 ② '종합 메일 설정' 승인).
 *  · 저장 판정은 서버(`server/src/isidu/digestRules.js normalizeDigest`)가 한다 — 형식이 틀리면 400 이 칸(field)을 짚는다.
 *    이 모듈은 입력 중에 미리 알려 줄 뿐이고, 같은 규칙의 사본이다(번들 경계 — 웹 테스트가 서버 모듈과 같은 입력으로 대조한다):
 *    받는 사람(`recipientsOf` ↔ `digestRecipients`) · 다음 회차(`nextSlots` ↔ `nextDigestSlots`) · 요일 표기(`daysLabel`).
 *  · 시각은 서버가 준 포탈 오프셋(`offsetMin`, 기본 한국 시각)으로 쓴다 — 브라우저 시간대에 기대지 않는다.
 *  · 기록 문구의 코드는 서버와 1:1 이다(`MISSED_TEXT` ↔ DIGEST_MISSED_REASONS · `SKIP_TEXT` ↔ DIGEST_SKIP_CODES — 웹 테스트가 서버 소스에서 뽑아 대조).
 */
import { parseMailInput, isEmail, MAIL_LIST_MAX } from './isiduText.js';

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
export const TOPN_CHOICES = Object.freeze([5, 10, 20]);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;
const DEF_OFFSET = 540;

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
    topN: TOPN_CHOICES.includes(Number(g.topN)) ? Number(g.topN) : 10,
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

/** 화면 폼 → 저장 요청 본문(서버가 다시 판정한다). */
export function digestBody(f) {
  return {
    enabled: !!f.enabled, days: intDays(f.days), time: `${f.hour}:${f.minute}`, includeAdmin: !!f.includeAdmin,
    to: String(f.to ?? ''), topN: Number(f.topN), includeWatch: !!f.includeWatch, includeTargets: !!f.includeTargets, skipIfNoNew: !!f.skipIfNoNew,
  };
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
  return out;
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
  if (r.ok && r.state === 'sent') return { tone: 'ok', text: `보냈습니다 — 받는 사람 ${r.to ?? '—'}명 · 대상 ${r.targets ?? '—'}개.` };
  if (r.state === 'edge') return { tone: 'muted', text: '엣지 포탈은 종합 메일을 보내지 않습니다(메인만 보냅니다).' };
  if (r.state === 'skipped') return { tone: 'muted', text: `보내지 않았습니다 — ${(r.code && SKIP_TEXT[r.code]) || r.reason || '사유 미상'}.` };
  return { tone: 'bad', text: `보내지 못했습니다 — ${r.reason || '사유 미상'}` };
}

/** 메일 준비 상태(서버 isiduMailReady) → 경고 한 줄(준비됐으면 null). */
export function mailReadyNote(r) {
  if (!r || r.ok) return null;
  return `${r.reason || '메일을 보낼 수 없는 상태입니다.'} 저장은 되지만 정한 시각에 보내지 못하고 기록에 '생략' 으로 남습니다.`;
}
