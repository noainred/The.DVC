/**
 * svcStatusText.js — 특수 기능 '포탈 서비스 상태 모니터링'(도구 키 svc-status)의 문구 · 색 · 계산(순수 — React 없음, vitest 로 고정).
 *
 * 설계 docs/design/portal-svc-status (아트보드 Main · Detail · Settings · Narrow — 컨펌 '좋아 기본값대로 구현해줘').
 *
 * 판정은 서버(`server/src/svcstatus/judge.js`)가 한다 — 이 모듈은 서버가 준 `state` · `reason` · `failKind` 로 **색과 문장만** 고른다.
 *  · 상태 코드 · 사유 코드 · 띠 칸 값은 서버 목록과 1:1 이다(svcStatusText.test.js 가 judge.js 를 불러 대조한다).
 *  · 상태 넷(정상 · 지연 · 끊김 · 못 잼)만 합계에 든다. 꺼짐 · 제외 · 설정 오류는 따로 센다(합계에 넣지 않는다).
 *  · 못 잼은 정상에도 끊김에도 세지 않는다 — 초록도 빨강도 아닌 회색이다.
 *  · 값이 없으면 '—' 다(단위를 붙이지 않는다 — '— ms' 는 0 처럼 읽힌다). 수치 판정은 numOrNull(Number('')===0 함정).
 *  · 주기 · 배수 · 연속 횟수 · 시한 · 보관 같은 숫자는 응답 값으로 문장을 만든다 — 여기 박지 않는다.
 *  · 값이 없는 이유는 서버 사유 코드의 문구만 쓴다(지어내지 않는다).
 *  · 화면 문구에 백틱을 쓰지 않는다(BoldText 는 별표 두 개 강조만 해석한다) — 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';
import { hashSegments } from '../../hooks/hashTab.js';

const t = (v) => String(v ?? '').trim();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── 상태 ─────────────────────────────────────────────────────────────────────

/**
 * 상태 → 라벨 · 기호 · 색(공용 .badge 색 이름) · 심각도. 서버 STATE_CODES 와 1:1(시험이 대조).
 * 색만으로 말하지 않는다 — 기호와 글자가 늘 함께 간다. 심각도는 서버 judge.SEVERITY 와 같은 값(클수록 나쁘다 · 시험이 대조).
 */
export const STATES = Object.freeze({
  ok: Object.freeze({ label: '정상', mark: '●', tone: 'green', sev: 3 }),
  slow: Object.freeze({ label: '지연', mark: '▲', tone: 'amber', sev: 4 }),
  down: Object.freeze({ label: '끊김', mark: '■', tone: 'red', sev: 6 }),
  unknown: Object.freeze({ label: '못 잼', mark: '○', tone: 'gray', sev: 5 }),
  off: Object.freeze({ label: '꺼짐', mark: '◇', tone: 'gray', sev: 1 }),
  excluded: Object.freeze({ label: '제외', mark: '□', tone: 'gray', sev: 0 }),
  problem: Object.freeze({ label: '설정 오류', mark: '◆', tone: 'purple', sev: 2 }),
});
/** 합계(전체)에 드는 상태 넷 — 타일 순서이기도 하다. */
export const MEASURED = Object.freeze(['ok', 'slow', 'down', 'unknown']);
/** 합계에 넣지 않고 따로 세는 상태. */
export const SIDE = Object.freeze(['off', 'excluded', 'problem']);

/** 모르는 코드도 화면이 죽지 않게 — 코드를 그대로 보이고 회색(지어낸 라벨을 붙이지 않는다). */
export function stateInfo(code) {
  const k = t(code);
  if (Object.hasOwn(STATES, k)) return STATES[k];
  return { label: k || '—', mark: '·', tone: 'gray', sev: -1 };
}
/** 정렬값 — 오름차순이 '나쁜 상태가 위' 가 되게(STable 은 첫 클릭이 오름차순). */
export function stateSort(code) {
  return 10 - stateInfo(code).sev;
}

// ── 사유 · 실패 종류 ─────────────────────────────────────────────────────────

/**
 * 행 사유(reason) → 짧은 표지 · 긴 설명. 서버 REASON_CODES 와 1:1(시험이 대조).
 * 행에는 short 만, 긴 설명은 표 아래 각주에 한 번(같은 문단을 행마다 되풀이하지 않는다).
 * long 은 응답 값(ctx)으로 숫자를 채운다 — 값이 없으면 숫자 없이 말한다.
 */
export const REASON_TEXT = Object.freeze({
  'no-data': { short: '첫 측정 대기', long: () => '아직 측정 기록이 없습니다 — 첫 측정을 기다리는 중입니다.' },
  stale: {
    short: '측정이 멈춤',
    long: (c) => `마지막 측정이 오래됐습니다${c.staleMs != null ? `(${spanText(c.staleMs)} 넘게 새 측정 없음)` : ''} — 측정이 멈췄거나 이 대상을 건너뛰고 있습니다.`,
  },
  judging: {
    short: '판정 중',
    long: (c) => `첫 측정부터 실패하고 있습니다 — ${c.failThreshold != null ? `연속 ${c.failThreshold}회째에` : '연속 실패가 기준에 닿으면'} 끊김으로 판정합니다.`,
  },
  'edge-waiting': { short: '엣지 첫 보고 대기', long: () => '이 대상을 재는 엣지가 아직 첫 보고를 보내지 않았습니다.' },
  'edge-silent': {
    short: '엣지 보고 없음',
    long: () => '이 대상을 재는 엣지의 보고가 끊겼습니다(오래됨 기준을 넘김) — 확인할 곳: 엣지의 중앙 토큰 거부(403) · 엣지 워커 미동작 · 회선.',
  },
  'edge-old-version': {
    short: '엣지 버전 낮음',
    long: (c) => `엣지 버전이 낮아 이 측정을 보내지 않습니다${c.minEdgeVersion ? ` — ${c.minEdgeVersion} 이상으로 올리면 채워집니다` : ''}.`,
  },
  'edge-unknown-version': { short: '엣지 버전 모름', long: () => '엣지가 버전을 알리지 않아 이 측정을 보낼 수 있는지 모릅니다.' },
  'edge-disabled': { short: '엣지에서 꺼짐', long: () => '엣지가 이 측정이 중앙에서 꺼져 있다고 보고했습니다.' },
  'edge-missing': { short: '엣지 보고에 없음', long: () => '엣지는 보고하고 있지만 그 보고에 이 대상이 없습니다.' },
  unassigned: { short: '담당 엣지 모름', long: () => '엣지가 수집하는 대상인데 담당 엣지가 정해지지 않았습니다 — 재는 곳이 없습니다.' },
  'registry-held': { short: '등록부 보류', long: () => '등록부를 읽지 못해 대상을 지우지 않고 마지막 목록으로 보류하고 있습니다.' },
  disabled: { short: '사용 안 함', long: () => '등록부에 ‘사용 안 함’ 으로 등록된 대상입니다 — 대상에 올리되 측정하지 않습니다.' },
  'demo-live': { short: '데모 항목', long: () => '데모 항목이라 실제로 재지 않습니다.' },
  excluded: { short: '측정 제외', long: () => '관리자가 측정에서 제외한 대상입니다 — 등록부에서는 지워지지 않습니다.' },
  'bad-address': { short: '주소 해석 실패', long: () => '등록된 주소에서 접속처(주소:포트)를 만들지 못했습니다 — 등록부의 주소를 확인하세요.' },
  'measure-off': { short: '자동 측정 꺼짐', long: () => '자동 측정을 꺼 두어 재지 않고 있습니다 — 자동 등록 · 설정에서 켜면 다음 주기부터 잽니다(꺼 둔 동안은 알림을 보내지 않습니다).' },
  'db-unavailable': { short: '측정 DB 못 씀', long: () => '중앙의 측정 DB(svc-status.db)를 읽거나 쓰지 못하고 있습니다 — 측정 결과를 저장 · 표시할 수 없습니다. 서비스 점검과 서버 로그를 확인하세요.' },
});

/** 사유 표지(짧은 것). 모르는 코드는 코드 그대로(지어내지 않는다) · 없으면 ''. */
export function reasonShort(code) {
  const k = t(code);
  if (!k) return '';
  return Object.hasOwn(REASON_TEXT, k) ? REASON_TEXT[k].short : k;
}
/** 사유 설명(긴 것) — ctx 는 응답 값 { staleMs, failThreshold, minEdgeVersion }. */
export function reasonLong(code, ctx = {}) {
  const k = t(code);
  if (!k || !Object.hasOwn(REASON_TEXT, k)) return '';
  return REASON_TEXT[k].long({
    staleMs: numOrNull(ctx.staleMs),
    failThreshold: numOrNull(ctx.failThreshold),
    minEdgeVersion: t(ctx.minEdgeVersion),
  });
}

/** 연결 실패 종류(failKind — 서버 linkcheck FAIL_KINDS 키) → 라벨. 라벨은 서버 표와 같은 글자(시험이 대조). */
export const FAIL_TEXT = Object.freeze({
  refused: '연결 거부',
  timeout: '타임아웃',
  unreach: '경로 없음',
  reset: '연결 끊김',
  'dns-fail': '이름 해석 실패',
  'dns-blocked': '차단 대역',
  unknown: '원인 미상',
});
export function failText(kind) {
  const k = t(kind);
  if (!k) return '';
  return Object.hasOwn(FAIL_TEXT, k) ? FAIL_TEXT[k] : k;
}

// ── 숫자 · 시각 ──────────────────────────────────────────────────────────────

const comma = (v) => Math.round(v).toLocaleString('en-US');
const trimNum = (v, digits = 1) => String(Number(Number(v).toFixed(digits)));

/** 연결 시간(ms) — 천 단위 쉼표 + ' ms'. 못 읽은 값(null · '' · 문자)은 '—'(0 이 아니다). */
export function msText(v) {
  const n = numOrNull(v);
  return unitText(n != null && n >= 0 ? n : null, ' ms', { fmt: comma });
}
/** 성공률(%) — 100 이 아닌 값은 내림(99.96 을 '100.0' 으로 보이지 않게). 측정 0 이면 서버가 null → '—'. */
export function pctText(v) {
  const n = numOrNull(v);
  if (n == null || n < 0) return '—';
  if (n >= 100) return '100 %';
  return `${(Math.floor(n * 10) / 10).toFixed(1)} %`;
}
/** 평소 대비 배수(지금 ÷ 평소) — 둘 중 하나라도 없으면 ''. */
export function ratioText(ms, baseMs) {
  const a = numOrNull(ms);
  const b = numOrNull(baseMs);
  if (a == null || b == null || b <= 0 || a < 0) return '';
  return `${(a / b).toFixed(1)}배`;
}
/** 경과 · 길이(ms) → '35분' · '3시간' · '11일'(끝에 '전' 을 붙이지 않는다 — '…째' · '… 넘게' 로 쓴다). */
export function spanText(ms) {
  const v = numOrNull(ms);
  if (v == null || v < 0) return '—';
  if (v < MIN) return `${Math.max(1, Math.round(v / 1000))}초`;
  if (v < HOUR) return `${Math.round(v / MIN)}분`;
  if (v < 2 * DAY) return `${Math.round(v / HOUR)}시간`;
  return `${Math.round(v / DAY)}일`;
}
/** 측정 주기 — 2분 미만은 초(시안 '주기 60초'), 그 위로 분으로 나누어떨어지면 분. */
export function intervalText(ms) {
  const v = numOrNull(ms);
  if (v == null || v <= 0) return '—';
  if (v < 2 * MIN || v % MIN !== 0) return `${trimNum(v / 1000)}초`;
  return `${v / MIN}분`;
}
/** 시한 — 초(소수 한 자리). */
export function secText(ms) {
  const v = numOrNull(ms);
  if (v == null || v < 0) return '—';
  return `${trimNum(v / 1000)}초`;
}

/** 이 시각의 표시 오프셋(분) — 응답이 주면 그 값, 아니면 브라우저 시간대. */
const offsetOf = (ts, offsetMin) => {
  const o = numOrNull(offsetMin);
  return o != null ? o : -new Date(ts).getTimezoneOffset();
};
const p2 = (x) => String(x).padStart(2, '0');
/** 날짜 키(오프셋 적용) — 같은 날 · 어제 판정용. */
const dayKey = (ts, off) => Math.floor((ts + off * MIN) / DAY);

/**
 * 시각 문구 — 오늘이면 'HH:MM', 어제면 '어제 HH:MM', 그 밖은 'MM-DD HH:MM'. 0 이하 · 못 읽음은 '—'.
 * @param {{offsetMin?:number, sec?:boolean, date?:boolean}} [o] sec = 초까지 · date = 늘 날짜를 붙인다
 */
export function clockText(ts, now = Date.now(), { offsetMin, sec = false, date = false } = {}) {
  const v = numOrNull(ts);
  if (v == null || v <= 0) return '—';
  const off = offsetOf(v, offsetMin);
  const d = new Date(v + off * MIN);
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${sec ? `:${p2(d.getUTCSeconds())}` : ''}`;
  const n = numOrNull(now);
  if (!date && n != null) {
    const dk = dayKey(v, off);
    const nk = dayKey(n, off);
    if (dk === nk) return hm;
    if (dk === nk - 1) return `어제 ${hm}`;
  }
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hm}`;
}

/** '지금 상태가 시작된 때' — '09:12 부터 35분째'. since 를 모르면 '—'. */
export function sinceText(since, now = Date.now(), o = {}) {
  const s = numOrNull(since);
  if (s == null || s <= 0) return '—';
  const n = numOrNull(now);
  const span = n != null && n - s >= 0 ? ` ${spanText(n - s)}째` : '';
  return `${clockText(s, now, o)} 부터${span}`;
}

// ── 행 문구 ──────────────────────────────────────────────────────────────────

/** 종류별 수집 방식(sub) → 글자. 모르는 값은 그대로. */
const SUB_TEXT = Object.freeze({
  vcenter: Object.freeze({ direct: '직접 수집', site: '엣지 수집' }),
  storage: Object.freeze({ api: 'REST', ssh: 'SSH' }),
});
/** 이름 아래 보조 줄 — 기종 · 수집 방식('PowerMax · REST' · '엣지 수집'). 없으면 ''. */
export function subText(row = {}) {
  const sub = t(row.sub);
  const map = SUB_TEXT[t(row.kind)];
  const s = sub ? (map && Object.hasOwn(map, sub) ? map[sub] : sub) : '';
  return [t(row.typeLabel), s].filter(Boolean).join(' · ');
}
/**
 * 측정하는 곳 — 엣지면 엣지 이름(edge:true — 화면이 청록으로), 중앙이면 '중앙', 모르면 '—'. 서버 값을 다시 판정하지 않는다.
 * 꺼짐 · 제외 · 설정 오류 행은 재지 않는다 — '중앙 측정' · '엣지 측정' 이라고 쓰지 않고 '측정 안 함'(measured:false).
 */
export function byText(row = {}) {
  if (SIDE.includes(t(row.state))) return { text: '측정 안 함', edge: false, measured: false };
  const by = t(row.by);
  if (by === 'central') return { text: '중앙', edge: false, measured: true };
  if (by) return { text: by, edge: row.byEdge === true, measured: true };
  return { text: '—', edge: false, measured: null };
}
/** 표 · 카드 한 줄 — '중앙 측정' · 'edge-x 측정' · '측정 안 함' · '측정하는 곳 —'. */
export function byLine(row = {}) {
  const b = byText(row);
  if (b.measured === false) return '측정 안 함';
  if (b.text === '—') return '측정하는 곳 —';
  return `${b.text} 측정`;
}
/** 상세 '등록 출처' — 접속처를 정하는 곳(종류 · 수집 방식별). 스토리지 REST 는 등록부에 포트 칸이 없다. */
export function portSourceText(row = {}) {
  if (t(row.kind) === 'storage' && t(row.sub) === 'api') return '포트는 기종별 포탈 설정값(등록부에 포트 칸 없음)';
  if (t(row.kind) === 'storage' && t(row.sub) === 'ssh') return '등록부의 주소 · SSH 포트';
  return '등록부의 주소:포트(없으면 https 443 · http 80)';
}
/** 접속처 — 가린 응답이거나 비었으면 '—'. */
export function addrText(row = {}, addressHidden = false) {
  if (addressHidden) return '—';
  return t(row.address) || '—';
}
/** 법인 라벨 — 모르면 '—'. */
export function corpLabel(row = {}) {
  return t(row.corp?.label) || t(row.corp?.key) || '—';
}

/**
 * 정상 · 지연인데 마지막 측정이 실패한 행(연속 실패가 끊김 기준 미만) — '일시 실패 2회째(끊김 판정 전 — 연속 3회째에 끊김)'.
 * 성공 표본은 서버가 failStreak 을 0 으로 되돌리므로 ok · slow 에서 failStreak > 0 이면 마지막 측정이 실패였다(서버 값 그대로 — 다시 판정하지 않는다).
 * 끊김 기준 숫자는 응답 rules.failThreshold 로만(없으면 숫자 없이). 해당 없으면 ''.
 */
export function transientFailText(row = {}, failThreshold = null) {
  const st = t(row.state);
  const streak = numOrNull(row.failStreak);
  if ((st !== 'ok' && st !== 'slow') || streak == null || streak <= 0) return '';
  const th = numOrNull(failThreshold);
  const head = `일시 실패 ${streak}회째(끊김 판정 전${th != null && th > 0 ? ` — 연속 ${th}회째에 끊김` : ''})`;
  return [head, failText(row.failKind)].filter(Boolean).join(' · ');
}

/**
 * 행의 짧은 사유 줄 — 서버 사유 코드 문구 · 실패 종류 · 연속 실패 · 일시 실패 · 평소 대비. 행 보충(note)은 뒤에 붙인다.
 * 상태를 다시 판정하지 않는다(서버 state 그대로 — 지연이면 배수만 말한다). ctx.failThreshold = 응답 rules.failThreshold.
 */
export function whyText(row = {}, ctx = {}) {
  const st = t(row.state);
  const streak = numOrNull(row.failStreak);
  const parts = [];
  const r = t(row.reason);
  if (r) {
    parts.push(reasonShort(r));
    if (r === 'judging' && streak != null && streak > 0) parts.push(`실패 ${streak}회째`);
  }
  if (st === 'down' || (r === 'judging' && row.failKind)) {
    if (st === 'down' && streak != null && streak > 0) parts.push(`연속 ${streak}회 실패`);
    const fk = failText(row.failKind);
    if (fk) parts.push(fk);
  }
  const tf = transientFailText(row, ctx?.failThreshold);
  if (tf) parts.push(tf);
  if (st === 'slow') {
    const ratio = ratioText(row.ms, row.baseMs);
    if (ratio) parts.push(`평소의 ${ratio}`);
  }
  const note = t(row.note);
  if (note) parts.push(note);
  return parts.join(' · ');
}

/** 상세 '지금 연결 시간' 카드의 보조 줄 — 끊김 · 일시 실패 · 사유 · 평소 대비 순(서버 값 그대로). */
export function nowSubText(row = {}, ctx = {}) {
  const base = numOrNull(row.baseMs);
  const baseText = base == null ? '평소 —' : `평소 ${msText(base)}`;
  if (t(row.state) === 'down') {
    const streak = numOrNull(row.failStreak);
    return [streak != null && streak > 0 ? `연속 ${streak}회 실패` : '', failText(row.failKind)].filter(Boolean).join(' · ') || '연결 실패';
  }
  const tf = transientFailText(row, ctx?.failThreshold);
  if (tf) return [tf, base == null ? '' : baseText].filter(Boolean).join(' · ');
  if (t(row.reason)) return reasonShort(row.reason);
  const ratio = ratioText(row.ms, row.baseMs);
  return base == null ? baseText : `${baseText}${ratio ? ` 의 ${ratio}` : ''}`;
}

/** 제외 표지(row.excluded · 설정 excluded[]) → '제외 11-18 12:32 · admin · 사유: 이전 작업 중'. 시각을 모르면 '제외 —'. 없으면 ''. */
export function excludedText(ex, now = Date.now(), o = {}) {
  if (!ex || typeof ex !== 'object') return '';
  const at = numOrNull(ex.at);
  const bits = [`제외 ${at != null && at > 0 ? clockText(at, now, { ...o, date: true }) : '—'}`];
  if (t(ex.by)) bits.push(t(ex.by));
  if (t(ex.reason)) bits.push(`사유: ${t(ex.reason)}`);
  return bits.join(' · ');
}

/** 표 아래 각주 — 보이는 행의 사유 코드마다 긴 설명 한 번(행 순서대로 처음 나온 순). */
export function reasonNotes(rows = [], ctx = {}) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = t(r?.reason);
    if (!k || seen.has(k) || !Object.hasOwn(REASON_TEXT, k)) continue;
    seen.add(k);
    out.push({ code: k, short: REASON_TEXT[k].short, long: reasonLong(k, ctx) });
  }
  return out;
}

// ── 합계 · 타일 ──────────────────────────────────────────────────────────────

/**
 * 합계 — 서버 counts 를 그대로 쓴다(없을 때만 행으로 센다 — 상태는 서버 state). total 은 상태 넷의 합이다.
 * 카운터는 0 이 정답일 수 있다(numOrNull 의 '못 읽음' 과 다르다) — 없는 칸만 행에서 센다.
 */
export function countsOf(data = {}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const fromRows = { ok: 0, slow: 0, down: 0, unknown: 0, off: 0, excluded: 0, problem: 0 };
  for (const r of rows) if (Object.hasOwn(fromRows, t(r?.state))) fromRows[t(r.state)] += 1;
  const c = data?.counts && typeof data.counts === 'object' ? data.counts : null;
  const out = {};
  for (const k of Object.keys(fromRows)) {
    const v = c ? numOrNull(c[k]) : null;
    out[k] = v != null && v >= 0 ? v : fromRows[k];
  }
  const tot = c ? numOrNull(c.total) : null;
  out.total = tot != null && tot >= 0 ? tot : MEASURED.reduce((s, k) => s + out[k], 0);
  return out;
}

/** 요약 타일 다섯(전체 · 정상 · 지연 · 끊김 · 못 잼). 보조 문구의 숫자는 응답 규칙 값. */
export function tilesOf(counts = {}, rules = {}, kindsN = null) {
  const f = numOrNull(rules?.slowFactor);
  const th = numOrNull(rules?.failThreshold);
  const kn = numOrNull(kindsN);
  return [
    { key: 'all', label: '전체 대상', mark: '', tone: '', n: counts.total ?? 0, sub: kn != null && kn > 0 ? `등록부 ${kn}종에서 자동 등록` : '등록부에서 자동 등록' },
    { key: 'ok', ...pick('ok'), n: counts.ok ?? 0, sub: '연결됨' },
    { key: 'slow', ...pick('slow'), n: counts.slow ?? 0, sub: f != null ? `평소의 ${trimNum(f)}배 초과` : '평소보다 느림' },
    { key: 'down', ...pick('down'), n: counts.down ?? 0, sub: th != null ? `연속 ${th}회 실패` : '연결 실패' },
    { key: 'unknown', ...pick('unknown'), n: counts.unknown ?? 0, sub: '정상에도 끊김에도 세지 않음' },
  ];
}
function pick(k) { const s = STATES[k]; return { label: s.label, mark: s.mark, tone: s.tone }; }

/** 합계에 넣지 않은 대상 한 줄 — 셋 모두 밝힌다(0 이어도). */
export function sideText(counts = {}) {
  return `합계에 넣지 않은 대상 — 꺼짐 ${counts.off ?? 0} · 제외 ${counts.excluded ?? 0} · 설정 오류 ${counts.problem ?? 0}`;
}

/** 범례 — 숫자는 응답 규칙 값(없으면 숫자 없이). */
export function legendOf(rules = {}) {
  const f = numOrNull(rules?.slowFactor);
  const th = numOrNull(rules?.failThreshold);
  const days = numOrNull(rules?.baselineDays);
  const delta = numOrNull(rules?.slowMinDeltaMs);
  const base = days != null ? `평소(최근 ${days}일 중앙값)` : '평소(대상별 중앙값)';
  return [
    { state: 'ok', text: '정상 — 연결됨' },
    { state: 'slow', text: `지연 — 연결되지만 ${base}${f != null ? `의 ${trimNum(f)}배 초과` : '보다 느림'}${delta != null && delta > 0 ? `(차이 ${comma(delta)} ms 이상)` : ''}` },
    { state: 'down', text: `끊김 — ${th != null ? `연속 ${th}회` : '연속'} 연결 실패` },
    { state: 'unknown', text: '못 잼 — 측정값이 오지 않음(정상에도 끊김에도 세지 않음)' },
  ];
}

/** 측정 방식 한 줄 — 'TCP 연결 · 60초마다 · 시한 2.5초(평소가 큰 대상은 자동으로 늘림)'. 값이 없으면 그 조각을 뺀다. */
export function measureText({ intervalMs, timeoutMs } = {}) {
  const parts = ['TCP 연결'];
  if (numOrNull(intervalMs) != null) parts.push(`${intervalText(intervalMs)}마다`);
  if (numOrNull(timeoutMs) != null) parts.push(`시한 ${secText(timeoutMs)}(평소가 큰 대상은 자동으로 늘림)`);
  return parts.join(' · ');
}

/**
 * 머리의 마지막 측정 줄 + 툴팁 + 톤. 주기가 실패했으면(last.ok === false · error) '마지막 주기 실패' + tone 'warn'(문구에 '실패' — 색만으로 말하지 않는다) ·
 * 자동 측정이 꺼져 건너뛴 주기(last.disabled)는 '자동 측정 꺼짐'(그 시각을 '마지막 측정' 이라고 하지 않는다). poller 가 없으면 '측정 기록 없음'.
 */
export function lastRunText(poller, intervalMs, now = Date.now(), o = {}) {
  const iv = numOrNull(intervalMs) != null ? ` · 주기 ${intervalText(intervalMs)}` : '';
  if (poller?.running) return { text: `측정 중…${iv}`, title: '', tone: '' };
  const last = poller?.last;
  const at = numOrNull(last?.at);
  const when = at != null && at > 0 ? ` ${clockText(at, now, { ...o, sec: true })}` : '';
  const err = t(last?.error);
  if (last && (last.ok === false || err)) {
    const bits = [`주기 실패 — ${err.slice(0, 300) || '사유 없음'}`];
    if (numOrNull(last.ms) != null) bits.push(`걸린 시간 ${msText(last.ms)}`);
    return { text: `마지막 주기 실패${when}${iv}`, title: bits.join(' · '), tone: 'warn', error: err.slice(0, 300) };
  }
  if (last?.disabled === true) return { text: '자동 측정 꺼짐', title: when ? `마지막 확인${when}` : '', tone: '' };
  if (at == null || at <= 0) return { text: `아직 측정 기록 없음${iv}`, title: '', tone: '' };
  const bits = [];
  for (const [k, label] of [['measured', '측정'], ['failed', '실패'], ['skipped', '건너뜀']]) {
    const v = numOrNull(last[k]);
    if (v != null) bits.push(`${label} ${v}`);
  }
  if (numOrNull(last.ms) != null) bits.push(`걸린 시간 ${msText(last.ms)}`);
  const head = last.trigger === 'manual' ? '수동 측정 — ' : '';
  return { text: `마지막 측정${when}${iv}`, title: bits.length ? `${head}마지막 측정 주기 — ${bits.join(' · ')}` : '', tone: '' };
}

/** 엣지 보고 각주 — 오래됨 · 받지 않은 항목 · 보충이 있는 엣지만. */
export function edgeNotes(edges = [], now = Date.now(), o = {}) {
  const out = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || typeof e !== 'object') continue;
    const rej = numOrNull(e.rejected);
    const note = t(e.note);
    if (!e.stale && !(rej > 0) && !note) continue;
    const at = numOrNull(e.lastReportAt);
    const bits = [t(e.agent) || '—', t(e.version) || '버전 모름', at != null && at > 0 ? `마지막 보고 ${clockText(at, now, o)}` : '보고 기록 없음'];
    if (e.stale) bits.push('보고 오래됨');
    if (rej > 0) bits.push(`받지 않은 항목 ${rej}건`);
    if (note) bits.push(note);
    out.push(bits.join(' · '));
  }
  return out;
}

/**
 * 종류 키 → 라벨(서버 응답 라벨이 없을 때만 — 꺼진 종류는 kinds 에 오지 않는다). 서버 targets.js KIND_LABEL 과 같은 글자(시험이 대조).
 */
export const KIND_FALLBACK_LABEL = Object.freeze({ collector: '엣지 포탈', vcenter: 'vCenter', cvp: 'CVP', storage: '스토리지' });
export function kindName(key, kinds = []) {
  const k = t(key);
  const hit = (Array.isArray(kinds) ? kinds : []).find((x) => t(x?.key) === k);
  if (hit && t(hit.label)) return t(hit.label);
  return Object.hasOwn(KIND_FALLBACK_LABEL, k) ? KIND_FALLBACK_LABEL[k] : (k || '—');
}
/** 등록부 오류 배너 한 줄 — 라벨은 서버 label 이 먼저, 측정이 꺼진 종류면 '(측정 꺼짐)'. */
export function sourceErrorText(e = {}, kinds = []) {
  const label = t(e?.label) || kindName(e?.kind, kinds);
  return `${label} 등록부${e?.off === true ? '(측정 꺼짐)' : ''} — ${t(e?.reason) || '읽지 못했습니다'}`;
}
/** 꺼진 종류 안내(없으면 ''). */
export function kindsOffText(kindsOff = [], kinds = []) {
  const keys = (Array.isArray(kindsOff) ? kindsOff : []).map(t).filter(Boolean);
  if (!keys.length) return '';
  return `측정이 꺼진 종류: ${keys.map((k) => kindName(k, kinds)).join(' · ')} — 자동 등록 · 설정에서 켜면 대상이 됩니다.`;
}
/** 대상이 0개일 때의 빈 문구 — 종류가 전부 꺼졌으면 그 사실을, 등록부 오류가 있으면 그것을(거짓 '대상 없음' 금지). */
export function emptyRowsText({ kinds = null, sourceErrors = [] } = {}) {
  if (Array.isArray(kinds) && kinds.length === 0) return '측정할 종류가 모두 꺼져 있습니다 — 자동 등록 · 설정에서 켜세요.';
  if (Array.isArray(sourceErrors) && sourceErrors.length) return '등록부를 읽지 못한 종류가 있습니다(위 안내) — 목록이 비어 보여도 등록이 없는 것이 아닐 수 있습니다.';
  const names = (Array.isArray(kinds) ? kinds : []).map((k) => t(k?.label) || kindName(k?.key)).filter(Boolean);
  return `등록부에 대상이 없습니다 — ${names.length ? names.join(' · ') : '등록부'}에 장비를 등록하면 다음 측정 주기에 대상이 됩니다.`;
}

/** 상세의 '지금' 기준 — 서버 generatedAt(응답을 만든 시각). d.end 는 추이 칸 경계로 올린 값(최대 한 칸 미래)이라 '오늘 · 어제' 판정에 쓰면 저녁 시각이 '어제' 가 된다 — 축에만 쓴다. */
export function detailNowOf(d, fallback = Date.now()) {
  const g = numOrNull(d?.generatedAt);
  return g != null && g > 0 ? g : fallback;
}
/** 측정에서 제외한 대상인가 — 서버 row.excluded 표지 또는 state. */
export function isExcludedRow(row = {}) {
  return (row?.excluded != null && row.excluded !== false) || t(row?.state) === 'excluded';
}
/**
 * 상세의 제외 줄 — '제외 11-18 12:32 · admin · 사유: …'. 제외인데 지금 상태가 꺼짐 · 설정 오류면 두 사실을 함께 밝힌다
 * (다시 측정으로 바꿔도 그 상태가 풀릴 때까지 재지 않는다). 제외가 아니면 ''.
 */
export function excludedNote(row = {}, now = Date.now(), o = {}) {
  if (!isExcludedRow(row)) return '';
  const base = excludedText(row.excluded && typeof row.excluded === 'object' ? row.excluded : null, now, o) || '측정에서 제외한 대상입니다';
  const st = t(row.state);
  if (st === 'off' || st === 'problem') return `${base} — 지금 ‘${STATES[st].label}’ 상태이기도 해 측정하지 않습니다(다시 측정으로 바꿔도 ‘${STATES[st].label}’ 이 풀릴 때까지 재지 않습니다).`;
  return base;
}

// ── 거르기 · 격자 ────────────────────────────────────────────────────────────

/** 표 거르기 — 종류 탭 · 상태 타일 · 법인 칸 · 찾기(법인 · 이름 · 주소 · 측정하는 곳 · 기종). */
export function filterRows(rows = [], { kind = 'all', state = 'all', corp = null, q = '' } = {}) {
  const needle = t(q).toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r) return false;
    if (kind !== 'all' && t(r.kind) !== kind) return false;
    if (state !== 'all' && t(r.state) !== state) return false;
    if (corp != null && t(r.corp?.key) !== corp) return false;
    if (!needle) return true;
    const hay = [corpLabel(r), r.corp?.key, r.name, r.address, r.host, r.by, r.kindLabel, r.typeLabel].map((x) => t(x).toLowerCase()).join(' ');
    return hay.includes(needle);
  });
}

/** 종류 탭 — 서버 kinds 순서. 서버가 주지 않은 종류가 행에 있으면 뒤에 붙인다(라벨은 행의 kindLabel). */
export function kindTabs(kinds = [], rows = []) {
  const out = [];
  const seen = new Set();
  for (const k of Array.isArray(kinds) ? kinds : []) {
    const key = t(k?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: t(k.label) || key });
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = t(r?.kind);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: t(r.kindLabel) || key });
  }
  const n = (key) => (Array.isArray(rows) ? rows : []).filter((r) => t(r?.kind) === key).length;
  return out.map((k) => ({ ...k, n: n(k.key) }));
}

/**
 * 법인 × 종류 격자. 칸 = 그 법인 그 종류 대상 중 **가장 나쁜 상태**(서버 state 의 심각도). 대상이 없으면 null(빈 칸).
 * 법인을 모르는 대상은 '—' 열로 맨 뒤에 모은다.
 * 열 순서: **나쁜 상태가 있는 법인이 왼쪽**(법인 28곳이면 가로 스크롤 뒤로 문제 법인이 숨는다 — Chromium 1440 실측) → 이름순.
 */
export function matrixOf(rows = [], kinds = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const corps = new Map();
  for (const r of list) {
    const key = t(r.corp?.key);
    if (!corps.has(key)) corps.set(key, { key, label: key ? corpLabel(r) : '—', sev: 0 });
    const c = corps.get(key);
    // 정상보다 나쁜 측정 상태(지연 · 못 잼 · 끊김)만 앞으로 당긴다 — 꺼짐 · 제외 · 설정 오류는 순서를 바꾸지 않는다.
    const sv = ['slow', 'unknown', 'down'].includes(t(r.state)) ? stateInfo(r.state).sev : 0;
    if (sv > c.sev) c.sev = sv;
  }
  const corpList = [...corps.values()].sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return (b.sev - a.sev) || a.label.localeCompare(b.label, 'ko');
  });
  const lines = kindTabs(kinds, list).map((k) => ({
    kind: k.key,
    label: k.label,
    cells: corpList.map((c) => {
      const hit = list.filter((r) => t(r.kind) === k.key && t(r.corp?.key) === c.key);
      if (!hit.length) return null;
      const by = {};
      for (const r of hit) by[t(r.state)] = (by[t(r.state)] || 0) + 1;
      const worst = hit.reduce((w, r) => (stateInfo(r.state).sev > stateInfo(w).sev ? t(r.state) : w), t(hit[0].state));
      const breakdown = Object.keys(by).sort((a, b) => stateInfo(b).sev - stateInfo(a).sev).map((s) => `${stateInfo(s).label} ${by[s]}`).join(' · ');
      return { corp: c.key, state: worst, n: hit.length, title: `${c.label} · ${k.label} — 대상 ${hit.length}개: ${breakdown}` };
    }),
  }));
  return { corps: corpList, lines };
}

// ── 24시간 띠 ────────────────────────────────────────────────────────────────

/** 띠 칸 값(서버 judge.SAMPLE) → 색 클래스 · 설명. 2 = 일시 실패(끊김 판정 전 — 끊김보다 옅은 빨강). */
export const STRIP = Object.freeze({
  0: Object.freeze({ cls: 'c0', label: '정상' }),
  1: Object.freeze({ cls: 'c1', label: '지연' }),
  2: Object.freeze({ cls: 'c2', label: '일시 실패(끊김 판정 전)' }),
  3: Object.freeze({ cls: 'c3', label: '끊김' }),
});
export const STRIP_NONE = Object.freeze({ cls: 'cn', label: '측정 없음' });

const stripVal = (v) => {
  const n = numOrNull(v);
  return n != null && Object.hasOwn(STRIP, String(n)) ? n : null;
};
export function stripCell(v) {
  const n = stripVal(v);
  return n == null ? STRIP_NONE : STRIP[n];
}
/** 칸마다 { cls, title } — title 은 칸이 덮는 때(지금에서 거꾸로 '1시간~2시간 전 · 지연') · 가장 최근 칸은 '최근 30분 · 정상'. 칸 길이는 응답 bucketMs. */
export function stripCells(strip = [], bucketMs = 30 * MIN) {
  const a = Array.isArray(strip) ? strip : [];
  const b = numOrNull(bucketMs) != null && bucketMs > 0 ? bucketMs : null;
  return a.map((v, i) => {
    const c = stripCell(v);
    const back = a.length - 1 - i;
    let when = '';
    if (b != null) when = back === 0 ? `최근 ${spanText(b)}` : `${spanText(back * b)}~${spanText((back + 1) * b)} 전`;
    return { cls: c.cls, title: when ? `${when} · ${c.label}` : c.label };
  });
}
/** 두 칸을 하나로(좁은 화면 — 1시간 칸). 더 나쁜 값 · 둘 다 없으면 null. 최근 쪽에 맞춘다(홀수면 가장 오래된 칸이 혼자). */
export function stripHourly(strip = []) {
  const a = (Array.isArray(strip) ? strip : []).map(stripVal);
  const out = [];
  for (let i = a.length; i > 0; i -= 2) {
    const x = a[i - 1];
    const y = i - 2 >= 0 ? a[i - 2] : null;
    out.unshift(x == null && y == null ? null : Math.max(x ?? -1, y ?? -1));
  }
  return out;
}
/** 띠의 읽는 글(aria-label) — 칸 수를 상태별로. */
export function stripSummary(strip = [], name = '') {
  const a = Array.isArray(strip) ? strip : [];
  const cnt = { 0: 0, 1: 0, 2: 0, 3: 0, n: 0 };
  for (const v of a) { const n = stripVal(v); if (n == null) cnt.n += 1; else cnt[n] += 1; }
  const parts = [0, 1, 2, 3].filter((k) => cnt[k]).map((k) => `${STRIP[k].label} ${cnt[k]}칸`);
  if (cnt.n) parts.push(`측정 없음 ${cnt.n}칸`);
  return `${name ? `${name} ` : ''}상태 띠 ${a.length}칸 — ${parts.join(' · ') || '칸 없음'}`;
}
/** 띠 머리 — '24시간(30분 칸)'(칸 길이 × 칸 수 — 숫자를 박지 않는다). */
export function stripHead(bucketMs, len = 48) {
  const b = numOrNull(bucketMs);
  const n = numOrNull(len);
  if (b == null || b <= 0 || n == null || n <= 0) return '상태 띠';
  return `${spanText(b * n)}(${spanText(b)} 칸)`;
}

// ── 상세 ─────────────────────────────────────────────────────────────────────

/** 상태 변화 기록 한 줄 → { from, to, registered, text }. to 'registered' = 그 접속처로 감시를 시작한 시각. */
export function eventView(ev = {}) {
  const to = t(ev.to);
  const from = t(ev.from);
  const bits = [];
  if (to === 'registered') {
    const addr = t(ev.address);
    bits.push(addr ? `등록부에서 자동 등록 · ${addr}` : '등록부에서 자동 등록');
  } else {
    if (!from) bits.push('첫 판정');
    if (numOrNull(ev.ms) != null) bits.push(msText(ev.ms));
    const fk = failText(ev.failKind);
    if (fk) bits.push(fk);
    const by = t(ev.by);
    if (by) bits.push(by === 'central' ? '중앙 측정' : `${by} 측정`);
  }
  const note = t(ev.note);
  if (note) bits.push(note);
  return { from: to === 'registered' ? '' : from, to: to === 'registered' ? '' : to, registered: to === 'registered', text: bits.join(' · ') };
}

/** 추이 칸들의 표본 · 실패 합(카운터 — 0 이 정답일 수 있다). 칸이 없으면 null. */
export function seriesTally(series = []) {
  const a = Array.isArray(series) ? series : [];
  if (!a.length) return null;
  let n = 0;
  let fail = 0;
  for (const p of a) { n += Math.max(0, numOrNull(p?.n) ?? 0); fail += Math.max(0, numOrNull(p?.fail) ?? 0); }
  return { n, fail };
}

/** 같은 주소의 다른 포트 + 이 대상(맨 위로 가지 않게 포트 순으로 섞는다 — self 표지). */
export function sameHostRows(row, sameHost = []) {
  const others = (Array.isArray(sameHost) ? sameHost : []).filter((x) => x && t(x.id) !== t(row?.id)).map((x) => ({ ...x, self: false }));
  const all = row ? [{ ...row, self: true }, ...others] : others;
  return all.sort((a, b) => (numOrNull(a.port) ?? Infinity) - (numOrNull(b.port) ?? Infinity));
}

const niceCeil = (v) => {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * e) return m * e;
  return 10 * e;
};

/**
 * 연결 시간 추이 그림 좌표(순수). 칸 평균 선 + 최저~최고 띠 · 평소선 · 지연 판정선 · 실패 칸 표지.
 * 측정이 없는 칸(avg null)에서 선을 끊는다(0 으로 내리지 않는다) · 앞뒤가 끊긴 칸 하나는 점으로.
 * @returns {object|null} 시작 · 끝이 없으면 null
 */
export function chartModel(series = [], { w = 900, h = 240, start, end, baseMs = null, slowAtMs = null, offsetMin, now = Date.now() } = {}) {
  const padL = 58; const padR = 14; const padT = 14; const padB = 26;
  const pts = (Array.isArray(series) ? series : []).filter((p) => p && numOrNull(p.ts) != null).sort((a, b) => a.ts - b.ts);
  const t0 = numOrNull(start) ?? (pts.length ? pts[0].ts : null);
  const t1 = numOrNull(end) ?? (pts.length ? pts[pts.length - 1].ts : null);
  if (t0 == null || t1 == null || !(t1 > t0)) return null;
  const vals = [];
  for (const p of pts) for (const k of ['avg', 'max']) { const v = numOrNull(p[k]); if (v != null && v >= 0) vals.push(v); }
  const base = numOrNull(baseMs);
  const slowAt = numOrNull(slowAtMs);
  const refs = [base, slowAt].filter((v) => v != null && v > 0);
  const top = niceCeil(Math.max(1, ...vals, ...refs) * 1.08);
  const iw = Math.max(1, w - padL - padR);
  const ih = Math.max(1, h - padT - padB);
  const x = (ts) => +(padL + ((ts - t0) / (t1 - t0)) * iw).toFixed(1);
  const y = (v) => +(padT + (1 - Math.min(v, top) / top) * ih).toFixed(1);
  const segs = [];
  let cur = [];
  for (const p of pts) {
    const avg = numOrNull(p.avg);
    if (avg == null || avg < 0) { if (cur.length) segs.push(cur); cur = []; continue; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  const line = []; const band = []; const singles = [];
  for (const s of segs) {
    if (s.length === 1) { singles.push({ x: x(s[0].ts), y: y(numOrNull(s[0].avg)) }); continue; }
    line.push(s.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts)},${y(numOrNull(p.avg))}`).join(' '));
    const mm = s.filter((p) => numOrNull(p.min) != null && numOrNull(p.max) != null);
    if (mm.length > 1) {
      const upper = mm.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts)},${y(numOrNull(p.max))}`).join(' ');
      const lower = mm.slice().reverse().map((p) => `L${x(p.ts)},${y(numOrNull(p.min))}`).join(' ');
      band.push(`${upper} ${lower} Z`);
    }
  }
  const fails = pts.filter((p) => (numOrNull(p.fail) ?? 0) > 0).map((p) => ({ x: x(p.ts), ts: p.ts, down: numOrNull(p.worst) === 3, n: numOrNull(p.fail) }));
  // 축 눈금 — 값이 없으면 0 만(빈 차트에 '2 · 2 · 1 · 1' 같은 눈금이 나왔다 — Chromium 1440 실측), 작은 범위는 소수 한 자리(반올림으로 같은 글자가 겹치지 않게).
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const v = (top * k) / 4;
    const label = k === 0 ? '0 ms' : !vals.length ? '' : top < 10 ? String(Math.round(v * 10) / 10) : comma(v);
    return { y: y(v), label };
  });
  const multiDay = t1 - t0 > 2 * DAY;
  const xticks = [0, 1, 2, 3, 4].map((k) => {
    const ts = t0 + ((t1 - t0) * k) / 4;
    return { x: x(ts), ts, label: multiDay ? clockText(ts, now, { offsetMin, date: true }).slice(0, 5) : clockText(ts, now, { offsetMin }) };
  });
  return {
    w, h, padL, padR, padT, padB, top, t0, t1,
    line, band, singles, fails, grid, xticks,
    baseY: base != null && base > 0 ? y(base) : null,
    slowY: slowAt != null && slowAt > 0 ? y(slowAt) : null,
    hasData: vals.length > 0,
    points: pts.map((p) => ({ x: x(p.ts), p })),
  };
}

/** 그림 위 마우스 x(viewBox 단위) → 가장 가까운 칸과 설명 줄. */
export function hoverAt(m, px, now = Date.now(), o = {}) {
  if (!m || px == null || !m.points.length) return null;
  let best = null;
  for (const q of m.points) if (!best || Math.abs(q.x - px) < Math.abs(best.x - px)) best = q;
  if (!best) return null;
  const p = best.p;
  const avg = numOrNull(p.avg);
  const n = numOrNull(p.n);
  const fail = numOrNull(p.fail);
  const lines = [];
  lines.push(avg == null ? '측정 없음' : `평균 ${msText(avg)} · 최저 ${msText(p.min)} · 최고 ${msText(p.max)}`);
  if (n != null) lines.push(`표본 ${n}개${fail ? ` · 실패 ${fail}` : ''}`);
  return { x: best.x, y: avg == null ? null : +(m.padT + (1 - Math.min(avg, m.top) / m.top) * (m.h - m.padT - m.padB)).toFixed(1), head: clockText(p.ts, now, o), lines };
}

/** 추이 기간(서버 계약 range 값 그대로). */
export const RANGES = Object.freeze([['24h', '24시간'], ['7d', '7일'], ['30d', '30일']]);

/** 표본 합 → '1,440회 중 실패 0회'(합이 없으면 ''). */
export function tallyText(tally) {
  if (!tally) return '';
  return `${comma(tally.n)}회 중 실패 ${comma(tally.fail)}회`;
}

/**
 * '지금 측정' 응답 → 안내 한 줄. 서버 note 가 먼저 · 그 밖은 measured · failed · skipped 값으로.
 * 0개를 잰 경우에 '표가 곧 바뀐다' 고 말하지 않는다(원인은 단정하지 않는다).
 */
export function runResultText(r = {}) {
  const note = t(r?.note);
  if (note) return note;
  const m = numOrNull(r?.measured);
  const f = numOrNull(r?.failed);
  const sk = numOrNull(r?.skipped);
  const skip = sk != null && sk > 0 ? `(측정하지 못한 대상 ${sk}개)` : '';
  if (m === 0) return `중앙이 이번에 잰 대상은 없습니다${skip} — 엣지가 재는 대상은 다음 엣지 보고 때 반영됩니다.`;
  if (m != null) return `${m}개를 쟀습니다${f != null && f > 0 ? `(그중 연결 실패 ${f}개)` : ''}${skip ? ` · 측정하지 못한 대상 ${sk}개` : ''} — 표는 곧 새 값으로 바뀝니다.`;
  const q = numOrNull(r?.queued);
  if (q != null) return `${q}개 측정을 시작했습니다 — 결과는 곧 표에 보입니다.`;
  if (r?.queued === true) return '측정을 시작했습니다 — 결과는 곧 표에 보입니다.';
  return '측정을 요청했습니다.';
}

// ── 설정 폼 ──────────────────────────────────────────────────────────────────

/**
 * 측정 설정 칸. scale = 화면 단위 → 서버 단위(초 → ms). zeroOk = 0 이 뜻 있는 값(최소 차이 0 = 배수만 본다).
 * 범위는 서버 응답 limits(서버 단위)로 검사한다 — 숫자를 박지 않는다.
 */
export const SETTING_FIELDS = Object.freeze([
  Object.freeze({ key: 'intervalMs', label: '측정 주기(초)', unit: '초', scale: 1000 }),
  Object.freeze({ key: 'timeoutMs', label: '연결 시한(초)', unit: '초', scale: 1000 }),
  Object.freeze({ key: 'failThreshold', label: '끊김 판정 — 연속 실패(회)', unit: '회', scale: 1, int: true }),
  Object.freeze({ key: 'slowFactor', label: '지연 판정 — 평소의 몇 배', unit: '배', scale: 1 }),
  Object.freeze({ key: 'slowMinDeltaMs', label: '지연 판정 — 평소와의 최소 차이(ms)', unit: 'ms', scale: 1, int: true, zeroOk: true }),
  Object.freeze({ key: 'retentionDays', label: '기록 보관(일)', unit: '일', scale: 1, int: true }),
  Object.freeze({ key: 'concurrency', label: '동시 측정(개)', unit: '개', scale: 1, int: true }),
]);

/** 서버 값 → 입력 칸 글자(못 읽은 값은 빈 칸). */
export function toUi(v, scale = 1) {
  const n = numOrNull(v);
  return n == null ? '' : String(Number((n / scale).toFixed(3)));
}
/** limits 한 칸 → '30~3600초' (없으면 ''). */
export function rangeText(field, limits) {
  const l = limits?.[field.key];
  const lo = numOrNull(l?.min);
  const hi = numOrNull(l?.max);
  if (lo == null || hi == null) return '';
  return `${toUi(lo, field.scale)}~${toUi(hi, field.scale)}${field.unit === 'ms' ? ' ms' : field.unit}`;
}

/** 받는 사람 칸 → 배열(쉼표 · 공백 · 세미콜론으로 나눔). */
export function parseRecipients(s) {
  return [...new Set(t(s).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}

/** 응답 설정 → 폼 상태(글자 칸은 문자열). */
export function formFromSettings(s = {}) {
  const f = {
    enabled: s?.enabled !== false,
    kinds: { ...(s?.kinds && typeof s.kinds === 'object' ? s.kinds : {}) },
    alertDown: s?.alerts?.down !== false,
    alertSlow: s?.alerts?.slow === true,
    unknownOn: (numOrNull(s?.alerts?.unknownMin) ?? 0) > 0,
    unknownMin: (numOrNull(s?.alerts?.unknownMin) ?? 0) > 0 ? toUi(s.alerts.unknownMin) : '',
    to: (Array.isArray(s?.alerts?.to) ? s.alerts.to : []).join(', '),
  };
  for (const fd of SETTING_FIELDS) f[fd.key] = toUi(s?.[fd.key], fd.scale);
  return f;
}

const MAIL_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * 폼 → 저장 본문(PUT). 빈 칸 · 0 이하(0 이 뜻 있는 칸은 음수)는 **보내지 않는다**(서버가 현재 값을 유지) — 그 칸 이름을 kept 로 돌려준다(조용히 버리지 않는다).
 * 숫자가 아닌 칸 · 정수 칸의 소수 · 범위 밖은 issues(저장하지 않는다).
 * @returns {{ body: object, issues: {key:string,label:string,reason:string}[], kept: string[] }}
 */
export function bodyFromForm(form = {}, settings = {}, limits = {}) {
  const body = { enabled: !!form.enabled, kinds: { ...(form.kinds || {}) } };
  const issues = [];
  const kept = [];
  for (const fd of SETTING_FIELDS) {
    const raw = t(form[fd.key]);
    if (!raw) { kept.push(fd.label); continue; }
    const v = numOrNull(raw);
    if (v == null) { issues.push({ key: fd.key, label: fd.label, reason: '숫자가 아닙니다' }); continue; }
    if (fd.zeroOk ? v < 0 : v <= 0) { kept.push(fd.label); continue; }
    if (fd.int && !Number.isInteger(v)) { issues.push({ key: fd.key, label: fd.label, reason: '정수로 입력하세요' }); continue; }
    const sv = fd.scale === 1 ? v : Math.round(v * fd.scale);
    const l = limits?.[fd.key];
    const lo = numOrNull(l?.min);
    const hi = numOrNull(l?.max);
    if ((lo != null && sv < lo) || (hi != null && sv > hi)) {
      issues.push({ key: fd.key, label: fd.label, reason: `${rangeText(fd, limits)} 사이로 입력하세요` });
      continue;
    }
    body[fd.key] = sv;
  }
  const cur = settings?.alerts || {};
  let unknownMin = 0;
  if (form.unknownOn) {
    const raw = t(form.unknownMin);
    const v = raw ? numOrNull(raw) : null;
    const curMin = numOrNull(cur.unknownMin);
    if (!raw) {
      if (curMin != null && curMin > 0) unknownMin = curMin;
      else issues.push({ key: 'unknownMin', label: '‘못 잼’ 알림(분)', reason: '분을 입력하세요' });
    } else if (v == null) issues.push({ key: 'unknownMin', label: '‘못 잼’ 알림(분)', reason: '숫자가 아닙니다' });
    else if (!Number.isInteger(v) || v <= 0) issues.push({ key: 'unknownMin', label: '‘못 잼’ 알림(분)', reason: '1 이상의 정수로 입력하세요' });
    else {
      const l = limits?.unknownMin;
      const hi = numOrNull(l?.max);
      if (hi != null && v > hi) issues.push({ key: 'unknownMin', label: '‘못 잼’ 알림(분)', reason: `${hi}분 이하로 입력하세요` });
      else unknownMin = v;
    }
  }
  const to = parseRecipients(form.to);
  const badMail = to.filter((x) => !MAIL_RE.test(x));
  if (badMail.length) issues.push({ key: 'to', label: '받는 사람', reason: `메일 주소 형식이 아닙니다(${badMail.slice(0, 3).join(', ')})` });
  // 상한은 서버 limits.alertsTo.max(숫자를 박지 않는다) — 넘는 몫을 서버가 자르기 전에 저장을 막는다.
  const toMax = numOrNull(limits?.alertsTo?.max);
  if (toMax != null && toMax >= 0 && to.length > toMax) issues.push({ key: 'to', label: '받는 사람', reason: `${toMax}명까지 넣을 수 있습니다(지금 ${to.length}명)` });
  body.alerts = { down: !!form.alertDown, slow: !!form.alertSlow, unknownMin, to };
  return { body, issues, kept };
}

/** 저장 본문이 지금 설정과 다른 칸의 이름(없으면 [] — '바뀐 값이 없습니다'). */
export function changedLabels(body = {}, s = {}) {
  const out = [];
  if (!!body.enabled !== (s?.enabled !== false)) out.push('자동 측정');
  for (const fd of SETTING_FIELDS) if (Object.hasOwn(body, fd.key) && numOrNull(s?.[fd.key]) !== body[fd.key]) out.push(fd.label);
  const ks = { ...(s?.kinds || {}) };
  for (const k of new Set([...Object.keys(ks), ...Object.keys(body.kinds || {})])) if (!!ks[k] !== !!body.kinds?.[k]) { out.push('측정할 등록부'); break; }
  const a = s?.alerts || {};
  const b = body.alerts || {};
  if (!!b.down !== (a.down !== false) || !!b.slow !== (a.slow === true) || (numOrNull(a.unknownMin) ?? 0) !== b.unknownMin) out.push('알림');
  const ta = (Array.isArray(a.to) ? a.to : []).join('\n');
  if (ta !== (b.to || []).join('\n')) out.push('받는 사람');
  return out;
}
export const NO_CHANGE_TEXT = '바뀐 값이 없습니다 — 저장하지 않았습니다.';

// ── 주소(해시) ───────────────────────────────────────────────────────────────

export const BASE = Object.freeze(['tools', 'svc-status']);
/** 해시 → 보기. '#/tools/svc-status' 메인 · '…/target/<id>' 상세 · '…/settings' 설정. 잘못된 딥링크는 메인. */
export function routeOf(hash) {
  const s = hashSegments(hash);
  if (s[0] !== BASE[0] || s[1] !== BASE[1]) return { view: 'main', id: '' };
  if (s[2] === 'settings') return { view: 'settings', id: '' };
  if (s[2] === 'target' && s[3]) {
    try { return { view: 'target', id: decodeURIComponent(s.slice(3).join('/')) }; } catch { return { view: 'main', id: '' }; }
  }
  return { view: 'main', id: '' };
}
export function hashOf(view = 'main', id = '') {
  const b = `#/${BASE.join('/')}`;
  if (view === 'settings') return `${b}/settings`;
  if (view === 'target' && id) return `${b}/target/${encodeURIComponent(id)}`;
  return b;
}

/** 403 · 404 는 다시 물어도 같다 — 다음 폴링을 걸지 않는다. */
export function shouldStopPolling(e) {
  const s = Number(e?.status);
  return s === 403 || s === 404;
}
