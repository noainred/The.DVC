/**
 * 물리서버 운영 기능 화면 글자(v3.50 · 시안 docs/design/bm-feature-proposals ⑩ ⑥ ⑤ ⑫ ④). 순수 — 판정은 서버가 한다.
 *  · ⑩ 건강 점수: 서버가 낸 점수 · 감점 항목 · 못 읽은 수를 글자로. 규칙 · 경계는 목록 응답(check.health)의 값(숫자를 박지 않는다).
 *  · ⑥ 위치 LED: on · blink · off · ''(못 읽음 — 꺼짐이 아니다).
 *  · ⑤ 이벤트 로그: 상태 · 등급 · 찾기. ⑫ 케이스: 상태 글자. ④ 권고: 상태 · 심각도.
 *  · 값이 없으면 단위를 붙이지 않는다 · 문구에 백틱을 쓰지 않는다.
 */
import { numOrNull } from '../../../numOrNull.js';

// ───────── ⑩ 건강 점수 ─────────
export const HEALTH_BAND = Object.freeze({
  ok: { label: '양호', color: 'green' }, warn: { label: '주의', color: 'amber' }, bad: { label: '나쁨', color: 'red' }, none: { label: '판정 못 함', color: 'gray' },
});
export const HEALTH_ITEM = Object.freeze({ fault: '부품 장애', warranty: '보증', fw: '펌웨어', bios: 'BIOS 설정' });
const UNKNOWN_TEXT = Object.freeze({ fault: '부품 장애(못 읽음)', warranty: '보증(원장에 없음 · 못 읽음)', fw: '펌웨어(기준 없음 · 못 읽음)', bios: 'BIOS 설정(미분류 · 못 읽음)' });
const ZERO_TEXT = Object.freeze({ fault: '0 부품 장애 없음', warranty: '0 보증 안', 'fw:ok': '0 펌웨어 기준과 같음', 'fw:differ': '0 펌웨어(기준과 다르나 순서를 몰라 감점하지 않음)', 'fw:split': '0 펌웨어(값이 갈려 감점하지 않음)', 'bios:ok': '0 BIOS 설정 묶음과 같음', 'bios:split': '0 BIOS 설정(값이 갈려 감점하지 않음)' });
/** 감점 0 으로 견준 항목 [키, 상태?] → 글자(모르는 꼴은 null). */
const zeroText = (x) => {
  if (!Array.isArray(x) || typeof x[0] !== 'string') return null;
  const key = x[0] === 'fw' || x[0] === 'bios' ? `${x[0]}:${x[1]}` : x[0];
  return Object.hasOwn(ZERO_TEXT, key) ? ZERO_TEXT[key] : null;
};
/** 감점 한 줄 — [키, 점수, 수|null, 상태?] → 글자(보증은 상태로 끝남 · 곧 끝남을 가른다). */
export function healthItemText([k, pts, n, state]) {
  const p = numOrNull(pts) ?? 0;
  const wty = state === 'expired' ? '보증 끝남' : state === 'soon' ? '보증 곧 끝남' : '보증';
  const what = k === 'fault' ? `부품 장애 ${n ?? ''}건` : k === 'warranty' ? wty : k === 'fw' ? `펌웨어 ${n ?? ''}개가 기준보다 뒤처짐` : k === 'bios' ? `BIOS 설정 ${n ?? ''}개가 묶음과 다름` : String(k);
  return `−${p} ${what.replace(/ {2,}/g, ' ')}`;
}
/**
 * 목록 행의 hs → 칸 모델. hs 가 없으면(구버전 응답) null.
 * @returns {{ score:number|null, band:string, label:string, color:string, unknown:number, title:string } | null}
 */
export function healthCell(hs) {
  if (!hs || typeof hs !== 'object') return null;
  const s = numOrNull(hs.s); const u = numOrNull(hs.u) ?? 0;
  const band = typeof hs.b === 'string' && Object.hasOwn(HEALTH_BAND, hs.b) ? hs.b : 'none';
  const items = Array.isArray(hs.d) ? hs.d.filter(Array.isArray).map(healthItemText) : [];
  const nJudged = (Array.isArray(hs.d) ? hs.d.length : 0) + (Array.isArray(hs.z) ? hs.z.length : 0);
  const title = s == null ? `${hs.few ? `견준 항목이 ${nJudged}개뿐이라 점수를 내지 않았습니다` : '견준 항목이 없어 점수를 내지 않았습니다'}${u ? ` — 못 읽은 항목 ${u}개` : ''}${items.length ? ` · 확인된 것: ${items.join(' · ')}` : ''}.`
    : `${s}점(${HEALTH_BAND[band].label})${items.length ? ` — ${items.join(' · ')}` : ' — 감점 없음'}${u ? ` · 못 읽은 항목 ${u}개는 점수에 넣지 않았습니다` : ''}`;
  return { score: s, band, label: s == null ? '—' : String(s), color: HEALTH_BAND[band].color, unknown: u, title };
}
/**
 * 드로어 구역 모델 — 행의 hs 와 점검 요약(chk) · 부품 장애 수로 사유를 늘 함께. 못 읽은 항목은 이름으로.
 * @param {object} r 목록 행 · @param {object} rules check.health.rules(없으면 점수 글자만)
 */
export function healthView(r, rules = null) {
  const c = healthCell(r?.hs);
  if (!c) return null;
  const hs = r.hs;
  const lines = (Array.isArray(hs.d) ? hs.d : []).filter(Array.isArray).map((x) => ({ k: x[0], text: healthItemText(x) }));
  // 견준 항목 중 감점 0(hs.z) — ‘0 부품 장애 없음’ 처럼 같이 보인다(점수만 보이지 않게). 견줌 · 모름은 서버 판정(hs.z · hs.uk)만 쓴다 — 웹에서 다시 판정하지 않는다
  const judged = (Array.isArray(hs.z) ? hs.z : []).map(zeroText).filter(Boolean);
  const unknownKeys = (Array.isArray(hs.uk) ? hs.uk : []).filter((k) => typeof k === 'string' && Object.hasOwn(UNKNOWN_TEXT, k));
  const min = rules?.min || null;   // 목록 응답 check.health.min(HEALTH_MIN) — 숫자를 박지 않는다
  const minText = min && numOrNull(min.judged) != null ? ` · 견준 항목이 ${min.judged}개 미만이거나 볼 항목의 절반 미만이면 점수를 내지 않습니다` : '';
  const ruleText = rules && rules.fault ? `감점: 부품 장애 건당 ${rules.fault.per}(최대 ${rules.fault.cap}) · 보증 끝남 ${rules.warrantyExpired?.per} · 곧 끝남 ${rules.warrantySoon?.per} · 펌웨어 뒤처짐 개당 ${rules.fwBehind?.per}(최대 ${rules.fwBehind?.cap}) · BIOS 다름 개당 ${rules.biosDiff?.per}(최대 ${rules.biosDiff?.cap})` : '';
  return { ...c, few: !!hs.few, lines, judged, unknownText: unknownKeys.map((k) => UNKNOWN_TEXT[k]), ruleText: ruleText ? `${ruleText}${minText}` : '' };
}

// ───────── ⑥ 위치 LED ─────────
export const LED_TEXT = Object.freeze({ on: '켜짐', blink: '깜빡임', off: '꺼짐', '': '못 읽음' });
export const ledText = (v) => LED_TEXT[typeof v === 'string' && Object.hasOwn(LED_TEXT, v) ? v : ''];
export const LED_NOTE = '위치 LED 상태입니다(못 읽음은 꺼짐이 아닙니다). 켜기 · 끄기는 장비 상태를 바꾸는 동작이라, 관리자가 원격 전원 설정을 켠 포탈에서 그 법인의 쓰기 권한이 있는 계정이 ‘원격 전원 · 위치 LED’ 구역에서 합니다.';

// ───────── ⑤ 하드웨어 이벤트 로그 ─────────
export const HWLOG_SEV = Object.freeze({ critical: { label: '위험', color: 'red' }, warning: { label: '주의', color: 'amber' }, ok: { label: '정보', color: 'gray' }, '': { label: '모름', color: 'gray' } });
export const HWLOG_STATUS = Object.freeze({
  ok: '', empty: '이 서버의 시스템 이벤트 로그가 비어 있습니다.', absent: '이 장비에는 시스템 이벤트 로그 경로가 없습니다(제조사 · 판에 따라 다릅니다).',
  forbidden: 'iDRAC 계정에 로그를 읽을 권한이 없습니다.', auth: 'iDRAC 인증에 실패했습니다(등록 계정 확인 — 자동으로 다시 시도하지 않습니다).',
  'auth-stopped': 'iDRAC 인증 실패로 이 서버의 주기 수집이 멈춰 있어 장비에 묻지 않았습니다(계정 잠금 방지 — 등록 계정을 고친 뒤 다시 읽으십시오).',
  timeout: '장비가 시한 안에 답하지 않았습니다.', error: '장비에서 로그를 읽지 못했습니다.',
});
export const HWLOG_WHY = Object.freeze({
  esxi: 'ESXi 호스트 행은 이 화면에서 읽지 않습니다.', 'no-source': '이 포탈이 읽을 길이 없는 서버입니다(iDRAC 등록부 밖 · 꺼진 등록 등).',
  'old-version': '이 서버를 수집하는 엣지가 구버전이라 로그를 받지 못했습니다(엣지 업그레이드 뒤 읽힙니다).',
  'not-found': '그 엣지의 등록부에서 이 서버를 찾지 못했습니다.', 'edge-fail': '이 서버를 수집하는 엣지에서 로그를 받지 못했습니다(잠시 뒤 다시 읽어 보십시오).',
});
export const HWLOG_STOPPED = Object.freeze({ budget: '시간 예산이 다 돼 일부만 읽었습니다.', max: '읽을 쪽 수 상한에 닿아 일부만 읽었습니다(장비가 정렬을 알려 주지 않으면 가장 새 기록이 빠졌을 수 있습니다).', skip: '장비가 쪽 넘기기를 지원하지 않아 첫 쪽만 읽었습니다.', short: '도중에 끊겨 일부만 읽었습니다.', timeout: '시한에 걸려 일부만 읽었습니다.', error: '도중에 오류가 나 일부만 읽었습니다.' });
export const HWLOG_SCOPE_NOTE = '시스템 이벤트 로그(SEL)만 읽습니다 — 수명주기(Lifecycle) 로그는 읽지 않습니다. 그 서버를 수집하는 쪽(이 포탈 · 엣지)이 장비에서 읽고, 잠깐 사이에 다시 누르면 장비에 다시 묻지 않고 방금 읽은 결과를 보입니다.';
/** 찾기(부품 이름 · 내용 · 코드) — 소문자 일부 일치 · 등급 거르기. 입력은 64자까지. */
export function filterHwLog(rows, { q = '', sev = '' } = {}) {
  const needle = String(q || '').trim().slice(0, 64).toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => (!sev || r.sev === sev) && (!needle || `${r.msg || ''} ${r.sensor || ''} ${r.code || ''}`.toLowerCase().includes(needle)));
}
/** 응답 → 구역 머리 글(읽은 수 · 전체 · 일부만 읽음). */
export function hwLogHead(d) {
  if (!d || d.why) return '';
  const read = numOrNull(d.read); const total = numOrNull(d.total); const shown = Array.isArray(d.rows) ? d.rows.length : 0;
  const base = `최근 ${shown}건${read != null ? ` · 읽은 ${read}건` : ''}${total != null && total !== read ? ` · 장비 전체 ${total}건` : ''}`;
  const gap = numOrNull(d.gap);
  const gapText = gap != null && gap > 0 ? ` — 기록이 많아 첫 쪽과 가장 새 쪽들만 읽었습니다(가운데 ${gap}건은 읽지 않음)` : '';
  const st = typeof d.stopped === 'string' && Object.hasOwn(HWLOG_STOPPED, d.stopped) ? ` — ${HWLOG_STOPPED[d.stopped]}` : '';
  return `${base}${gapText}${st}`;
}

// ───────── ⑫ 케이스 ─────────
export const CASE_STATUS = Object.freeze({ open: { label: '접수', color: 'amber' }, parts: { label: '부품 오는 중', color: 'amber' }, replaced: { label: '교체함', color: 'blue' }, closed: { label: '끝남', color: 'gray' } });
export const caseStatusText = (s) => (CASE_STATUS[s] ? CASE_STATUS[s].label : '모름');
/** 정렬 순위 — 글자 순이 아니라 진행 순서 · 심각도 순(디버깅 1회차 화면 U2 — 반증 B12 의 다른 경로). */
export const CASE_STATUS_ORDER = Object.freeze({ open: 0, parts: 1, replaced: 2, closed: 3 });
export const HWLOG_SEV_ORDER = Object.freeze({ critical: 0, warning: 1, ok: 2, '': 3 });
export const CASE_NOTE = '포탈은 제조사에 직접 접수하지 않습니다 — 접수 자료를 받아 제조사 창구에 붙이고, 받은 케이스 번호를 여기 적어 끝까지 따라갑니다.';

/**
 * 권고 표 창의 적용 단추 상태(순수 — 시험이 고정). 검증한 결과가 지금 파일과 같고(checked) 오류 행이 없어야 열린다.
 * 권고 0줄(머리글만)은 ‘표 비우기’(v3.50 반증 B14 — 한 번 올린 표를 비울 길이 없었다).
 */
export function ledgerApplyState({ checked = false, errors = 0, rows = 0, csvOk = true, busy = false } = {}) {
  const disabled = busy || !csvOk || !checked || errors > 0;
  const empty = checked && !errors && !rows;
  const title = !checked ? '먼저 검증하십시오(검증 뒤 파일을 바꿨으면 다시 검증)' : errors ? '오류 행을 고친 뒤 다시 검증하십시오' : empty ? '권고 0줄 — 적용하면 표를 비웁니다' : undefined;
  return { disabled, label: empty ? '표 비우기' : '적용', title, empty };
}

// ───────── ④ 보안 권고 ─────────
export const ADV_SEV = Object.freeze({ critical: { label: '위험', color: 'red' }, high: { label: '높음', color: 'red' }, medium: { label: '보통', color: 'amber' }, low: { label: '낮음', color: 'gray' } });
/** /check 의 adv → 구역 모델. */
export function advisoryView(adv, { unreadable = false } = {}) {
  if (unreadable) return { badge: { label: '표 못 읽음', color: 'gray' }, why: '보안 권고 표를 읽지 못해 대조하지 않았습니다(서비스 점검에서 확인).', rows: [] };
  if (!adv || typeof adv !== 'object') return { badge: { label: '판정 안 함', color: 'gray' }, why: '펌웨어를 읽지 못해 대조하지 않았습니다.', rows: [] };
  const unknown = numOrNull(adv.unknown) ?? 0; const checked = numOrNull(adv.checked) ?? 0;
  const unk = unknown ? ` 맞는 권고 줄 가운데 ${unknown}개는 순서를 정할 수 없어(숫자 꼴이 아닌 버전 · 서버 안에서 버전이 섞인 구성요소) 따로 셉니다.` : '';
  if (adv.state === 'no-table') return { badge: { label: '대조 안 함', color: 'gray' }, why: '보안 권고 표가 비어 있어 대조하지 않았습니다 — 관리자가 확인한 권고를 CSV 로 올리면 대조합니다(포탈은 인터넷에서 가져오지 않습니다).', rows: [] };
  if (adv.state === 'no-fw') return { badge: { label: '판정 안 함', color: 'gray' }, why: '펌웨어 목록을 읽지 못해 대조하지 않았습니다.', rows: [] };
  if (adv.state === 'unmatched') return { badge: { label: '해당 권고 없음', color: 'gray' }, why: '올라온 권고 표에 이 서버의 모델 · 구성요소에 맞는 줄이 없습니다(대조할 것이 없었습니다 — 안전하다는 뜻이 아닙니다).', rows: [] };
  if (adv.state === 'unknown') return { badge: { label: '판정 못 함', color: 'gray' }, why: `맞는 권고 줄 ${checked}개를 모두 견주지 못했습니다.${unk}`, rows: [] };
  if (adv.state === 'clear') return { badge: { label: '걸린 권고 없음', color: 'gray' }, why: `올라온 권고 표와 견줬고 걸린 것이 없습니다(견준 줄 ${Math.max(0, checked - unknown)}개).${unk}`, rows: [] };
  const hits = Array.isArray(adv.hits) ? adv.hits : [];
  const total = numOrNull(adv.total) ?? hits.length;
  return {
    badge: { label: `권고 ${total}건`, color: hits.some((h) => h.sev === 'critical' || h.sev === 'high') ? 'red' : 'amber' },
    why: `설치 버전이 권고의 고친 버전보다 낮습니다.${total > hits.length ? ` 앞 ${hits.length}건만 보입니다.` : ''}${unk}`,
    rows: hits.map((h) => ({ ...h, sevLabel: (ADV_SEV[h.sev] || ADV_SEV.medium).label, sevColor: (ADV_SEV[h.sev] || ADV_SEV.medium).color })),
  };
}
