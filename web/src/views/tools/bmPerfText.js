/**
 * views/tools/bmPerfText.js — 리눅스 베어메탈 통합 성능 **2단계 화면의 문구·표시 규약**(순수 · vitest `bmPerfText.test.js`).
 *
 * 설계 `docs/design/linux-bm-perf/README.md` §3.2(커버리지 4등급 · 교차 판정) · §5 ①~④(보드 · 서버 상세 · 400 · 상태 9종).
 *
 * ⚠⚠ **판정은 서버 한 곳이다**(`server/src/bmusage/useJudge.js`) — 이 모듈은 서버가 준 code(칸 · 판정 · 커버리지 · 교차 상태)를
 *   **문장 · 색 · 각주로 바꾸기만** 한다. 기준값과 비교하거나 칸 등급을 다시 매기지 않는다(웹·서버 두 벌 판정 금지 — 루트 CLAUDE.md).
 *   판정 한 줄(`line`)은 서버 문장을 그대로 쓴다. 기준 숫자는 API 값(`perfThresholds`)을 **보여 주기만** 한다.
 * ⚠ ‘—’ 는 0 이 아니다 — 못 읽음(missing) · 그 커널에 없음(none) · 경로 없음(nopath) · 오래됨(stale)을 **각주 기호로 구분**한다.
 *   ‘경로 없음’ 은 ‘못 읽음’ 과 다르다(등록이 없으니 시도도 없었다).
 * ⚠ 문구에 백틱 금지(BoldText 는 `**강조**` 만 해석) — 값 인용은 ‘ ’. 주기·상한·기준 숫자는 문구에 박지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { ageText } from './bmUsageText.js';

const n = numOrNull;
const t = (v) => String(v ?? '').trim();

export const RES_ORDER = Object.freeze(['cpu', 'mem', 'disk', 'net', 'hw']);
export const RES_LABEL = Object.freeze({ cpu: 'CPU', mem: '메모리', disk: '디스크', net: '네트워크', hw: '하드웨어' });
export const USE_KEYS = Object.freeze(['U', 'S', 'E']);
export const USE_LABEL = Object.freeze({ U: '사용률', S: '포화', E: '오류' });
/** 하드웨어(iDRAC) 축의 U·S·E 는 뜻이 다르다(설계 §3.2) — 전력 cap 대비 · 흡기 온도 · 부품 장애/SEL. */
export const HW_USE_LABEL = Object.freeze({ U: '전력', S: '온도', E: '부품' });

/**
 * 칸 code → 표시. 판정된 칸(ok·warn·bad)만 색이 있고, 나머지는 ‘—’ + 각주 기호다.
 * `mark` 는 각주 기호(표 아래 `cellFootnotes` 가 같은 기호로 설명한다).
 */
export const CODE_INFO = Object.freeze({
  ok: { short: '정상', tone: 'ok', rank: 1, judged: true },
  warn: { short: '주의', tone: 'warn', rank: 2, judged: true },
  bad: { short: '초과', tone: 'bad', rank: 3, judged: true },
  missing: { short: '—', mark: '¹', tone: 'idle', rank: 0, judged: false, label: '못 읽음' },
  none: { short: '—', mark: '²', tone: 'idle', rank: 0, judged: false, label: '그 커널에 없음' },
  nopath: { short: '—', mark: '³', tone: 'idle', rank: 0, judged: false, label: '경로 없음' },
  stale: { short: '—', mark: '⁴', tone: 'idle', rank: 0, judged: false, label: '오래됨' },
});
const codeInfo = (code) => CODE_INFO[code] || CODE_INFO.missing;   // 모르는 code 는 ‘못 읽음’ — 지어내지 않는다

/** 수 표시 — 100 이상은 정수, 그 아래는 소수 1자리(서버 판정 한 줄과 같은 자릿수). 값이 없으면 ‘—’ 이고 단위를 붙이지 않는다. */
export function numText(v, unit = '') {
  const x = n(v);
  if (x == null) return '—';
  const s = Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
  return `${s}${unit || ''}`;
}

/**
 * 매트릭스 칸 하나. `value` 는 그 칸의 **입력이 하나뿐인 경우**(U 칸 — 사용률)에만 준다 — 여러 입력 중 가장 나쁜 것이
 * 색을 정하는 S·E 칸에 대표값 하나를 적으면 색과 숫자가 어긋날 수 있다(그 칸은 짧은 판정 낱말만).
 * @returns {{text:string, mark:string, tone:string, sort:number|string, title:string, judged:boolean}}
 */
export function cellView(code, { value = null, unit = '' } = {}) {
  const c = codeInfo(code);
  if (!c.judged) return { text: '—', mark: c.mark, tone: 'idle', sort: '', title: c.label, judged: false };
  const v = n(value);
  return {
    text: v != null ? numText(v, unit) : c.short,
    mark: '', tone: c.tone,
    // 정렬: 등급 먼저(초과 > 주의 > 정상), 같은 등급 안에서 값. ‘—’ 칸은 빈 값이라 STable 이 늘 뒤로 보낸다.
    sort: c.rank * 1_000_000 + (v != null ? v : 0),
    title: `${c.short}${v != null ? ` · ${numText(v, unit)}` : ''}`,
    judged: true,
  };
}

/** 각주 — 표에 **실제로 나온** 비판정 code 만 한 번씩(없으면 빈 배열). */
export const CELL_FOOTNOTE = Object.freeze({
  missing: '‘—¹’ **못 읽음** — 경로는 있는데 이번에 읽지 못했습니다(첫 주기 · 출력 잘림 · 이 저장소가 받지 않는 값 포함). 0 이 아닙니다.',
  none: '‘—²’ **그 커널에 없음** — 구획은 왔는데 비어 있습니다(예: PSI 가 없는 커널). 못 읽은 것과 다릅니다.',
  nopath: '‘—³’ **경로 없음** — 그 값을 주는 경로가 이 서버에 없습니다(OS 계정 없음 → OS 칸 · iDRAC 등록 없음 → 하드웨어 칸). 시도하지 않았으니 못 읽음과 다릅니다.',
  stale: '‘—⁴’ **오래됨** — 마지막 표본이 신선도 한계를 넘어 판정하지 않았습니다(옛 값을 지금 값처럼 칠하지 않습니다).',
});
export function cellFootnotes(codes = []) {
  const seen = new Set(codes);
  return ['missing', 'none', 'nopath', 'stale'].filter((c) => seen.has(c)).map((c) => CELL_FOOTNOTE[c]);
}
/**
 * 그리는 칸 code — 항목은 있는데 그 칸 code 가 빠졌으면 ‘못 읽음’(화면 · 각주가 같은 함수를 쓴다 — 반증 D3: 칸은 ‘—¹’ 인데 각주가 없던 결함).
 * 항목 자체가 없는 행(표본 없음)은 이 함수를 쓰지 않는다 — 그 행은 각주 없는 ‘—’ 와 행 문장(판정 항목 없음)으로 그린다.
 */
export function cellCode(entry, r, k) {
  const c = entry?.codes?.[r]?.[k];
  return typeof c === 'string' && c ? c : 'missing';
}
/** 성능 항목 목록에서 **실제로 그리는** 칸 code 전부(각주용). 항목이 없는 행(null)은 세지 않는다(그 행의 ‘—’ 에는 기호가 없다). */
export function codesUsed(entries = []) {
  const out = new Set();
  for (const e of entries) { if (!e) continue; for (const r of RES_ORDER) for (const k of USE_KEYS) out.add(cellCode(e, r, k)); }
  return [...out];
}
/** 표본(판정 항목)이 없는 행의 칸 — 각주 기호 없는 ‘—’(못 읽음이 아니다 — 등록 경로가 없을 수도 있다). */
export const NO_ENTRY_CELL = Object.freeze({ text: '—', mark: '', tone: 'idle', sort: '', title: '판정 항목 없음 — 아직 표본이 없습니다', judged: false });
export const NO_ENTRY_FOOTNOTE = '기호 없는 ‘—’ 행은 **판정 항목 없음** — 이 서버의 표본이 아직 없습니다(꺼짐 · 첫 수집 전 · 등록 경로 없음 중 무엇인지는 행의 경로 칸과 수집 상세가 말합니다).';

/** 서버 판정(verdict) code → 배지. 문구는 서버 VERDICT_LABEL 과 같은 낱말이다(화면 쪽 사본은 낱말뿐 — 판정이 아니다). */
export const VERDICT_INFO = Object.freeze({
  bottleneck: { label: '병목', tone: 'bad', rank: 6 },
  saturated: { label: '포화', tone: 'bad', rank: 5 },
  errors: { label: '오류', tone: 'bad', rank: 4 },
  warn: { label: '주의', tone: 'warn', rank: 3 },
  ok: { label: '정상', tone: 'ok', rank: 2 },
  partial: { label: '대부분 못 읽음', tone: 'idle', rank: 1 },
  stale: { label: '오래됨', tone: 'idle', rank: 1 },
  unknown: { label: '판정 불가', tone: 'idle', rank: 0 },
});
export function verdictView(verdict) {
  return VERDICT_INFO[verdict] || VERDICT_INFO.unknown;
}

/** 커버리지 4등급(설계 §3.2) → 경로 칩. */
export const COVERAGE_INFO = Object.freeze({
  both: { label: 'OS + iDRAC', short: '둘 다', tone: 'ok' },
  os: { label: 'OS 만', short: 'OS 만', tone: 'warn' },
  idrac: { label: 'iDRAC 만', short: 'iDRAC 만', tone: 'warn' },
  none: { label: '읽힌 경로 없음', short: '없음', tone: 'bad' },
});
export function coverageView(cov) { return COVERAGE_INFO[cov] || COVERAGE_INFO.none; }

/**
 * 경로 하나의 상태 — 등록(paths)과 읽힘(coverage)을 함께 본다.
 *  'read'   — 신선도 한계 안에서 읽혔다
 *  'unread' — 등록은 있는데 지금 읽히지 않는다(못 읽음 — 시한·거부·정지 …)
 *  'nopath' — 등록이 없다(경로 없음 — 시도도 없었다)
 * ⚠ iDRAC 쪽은 주 iDRAC 폴러가 받은 사실로도 읽힌다(서버 coverageOf) — 등록 목록에 없더라도 coverage 가 읽혔다고 하면 읽힘이다.
 */
export function pathState(coverage, paths = [], which = 'os') {
  const readIt = coverage === 'both' || coverage === which;
  if (readIt) return 'read';
  return (paths || []).includes(which) ? 'unread' : 'nopath';
}

/**
 * 상태 9종(설계 §5 ④ · States.dc.html) + 2단계에서 데이터가 주는 보조 상태. 보드 행 칩(short)과 상세 머리 문구(title·body)를 함께 고정한다.
 * ⚠ ‘권한 부족’(진단 스냅샷의 /proc/pid/io · dmesg)은 4단계 진단 스냅샷 탭(BmSnapshotTab)이 그린다 — 행 상태 칩(rowStates)에는 넣지 않는다(주기 수집의 상태가 아니다).
 */
export const STATE_TEXT = Object.freeze({
  off: { short: '꺼짐', tone: 'idle', title: '성능 수집이 꺼져 있습니다', body: '베어메탈 사용률 설정에서 수집을 켜고 법인을 고르면 다음 주기부터 사용률이, 그다음 주기부터 포화·오류 칸이 채워집니다. 켜기는 법인 단위이고 기본은 꺼짐입니다.' },
  first: { short: '첫 주기', tone: 'idle', title: '첫 수집 — 다음 주기부터 값이 나옵니다', body: 'CPU 분해·디스크·네트워크·스왑처럼 누적 카운터의 **두 표본 차이**인 칸은 첫 주기에 ‘—’ 입니다. 0 으로 채우면 ‘부하 없음’ 이라는 거짓이 됩니다. 메모리 사용률·런큐·PSI 같은 순간값은 지금부터 보입니다.' },
  psiAbsent: { short: 'PSI 없음', tone: 'idle', title: '포화 칸 일부 없음 — 이 커널에 PSI 가 없습니다', body: '/proc/pressure 가 없습니다(커널 4.20 미만이거나 psi=1 부팅 옵션이 꺼진 RHEL 8 계열). 포화는 런큐 ÷ 코어 · 스왑아웃 · 대기열 · 드롭으로만 판정하고 PSI 칸은 ‘그 커널에 없음’ 으로 둡니다 — 못 읽음과 다릅니다.' },
  perm: { short: '권한 부족', tone: 'warn', title: '일부를 권한 때문에 읽지 못했습니다', body: '읽은 것은 그대로 보여 주고 읽지 못한 칸은 ‘확인 불가’ 로 둡니다. sudo 를 자동으로 시도하지 않습니다.' },
  stale: { short: '오래됨', tone: 'idle', title: '오래된 값 — 판정하지 않았습니다', body: '마지막 표본이 신선도 한계를 넘었습니다. 옛 값을 지금 값처럼 판정하지 않고 그 칸은 ‘오래됨’ 으로 둡니다. 다음 주기에 읽히면 풀립니다.' },
  auth: { short: '인증 정지', tone: 'bad', title: '자격증명이 거부되어 이 서버의 주기 수집을 멈췄습니다', body: '계정 잠금을 막으려고 자동으로 다시 시도하지 않습니다. 등록부에서 자격증명을 고치면 다음 주기에 자동으로 재개하고, ‘지금 수집’ 은 막지 않습니다.' },
  osOnly: { short: 'OS 만', tone: 'warn', title: '하드웨어 면이 비어 있습니다 — iDRAC 경로가 없습니다', body: 'OS(SSH) 로만 읽힙니다. CPU·메모리·디스크·네트워크 USE 는 있지만 온도·전력·부품은 ‘경로 없음’ 이고 교차 판정은 꺼집니다. iDRAC 등록부에 이 서버를 넣으면 다음 주기부터 채워집니다.' },
  osOnlyUnread: { short: 'iDRAC 못 읽음', tone: 'warn', title: 'iDRAC 이 등록돼 있지만 지금 읽히지 않습니다', body: '하드웨어 칸은 ‘경로 없음’ 이 아니라 읽지 못한 상태입니다. 교차 판정은 두 경로가 다 읽혀야 켜집니다.' },
  idracOnly: { short: 'iDRAC 만', tone: 'warn', title: 'OS 안을 보지 못합니다 — OS 경로가 없습니다', body: 'iDRAC 으로만 읽힙니다. CPU·메모리는 BMC 집계값이고 런큐·PSI·스왑·디스크 busy·대기열은 ‘경로 없음’ 입니다. 베어메탈 스토리지 등록부에 OS 계정을 넣으면 다음 주기부터 OS 면이 채워집니다.' },
  idracOnlyUnread: { short: 'OS 못 읽음', tone: 'warn', title: 'OS 계정이 등록돼 있지만 지금 읽히지 않습니다', body: 'OS 칸은 ‘경로 없음’ 이 아니라 읽지 못한 상태입니다(시한 · 거부 · 정지 — 이 서버를 눌러 수집 상세를 보세요).' },
  noneRead: { short: '못 읽음', tone: 'bad', title: '두 경로 다 지금 읽히지 않습니다', body: '등록된 경로를 신선도 한계 안에서 읽지 못했습니다. 이유는 아래 수집 상세와 인증 정지 안내가 말합니다 — 이 화면이 단정하지 않습니다.' },
  noPath: { short: '경로 없음', tone: 'idle', title: '읽을 경로가 등록돼 있지 않습니다', body: 'OS 계정도 iDRAC 등록도 없어 시도하지 않았습니다. 등록부에 하나 이상 넣으면 다음 주기부터 읽습니다.' },
  mismatch: { short: '불일치', tone: 'warn', title: 'CPU 사용률이 두 경로에서 다릅니다', body: '화면은 OS 값을 쓰되 iDRAC 값을 곁에 적습니다. 어느 쪽이 맞는지 단정하지 않습니다 — 샘플링 창이나 텔레메트리 메트릭 정의가 다를 수 있습니다.' },
  partial: { short: '대부분 못 읽음', tone: 'idle', title: '대부분 못 읽음 — ‘정상’ 이라 말하지 않습니다', body: '경로가 있는 칸 중 판정한 칸이 기준 비율보다 적습니다. 읽은 칸은 정상이지만 그것만으로 정상이라 하지 않습니다.' },
  edgeStale: { short: '보관분 오래됨', tone: 'idle', title: '엣지 보관분이 오래됐습니다', body: '중앙이 마지막으로 받은 엣지 봉투의 값입니다. 판정은 그 시각 기준이고, 엣지 보관분의 ‘지금 가져오기’ 로 새로 받습니다.' },
});

/** 상태 칩 순서 — 사람이 먼저 손대야 하는 것부터. */
const STATE_ORDER = ['off', 'auth', 'noneRead', 'noPath', 'stale', 'edgeStale', 'idracOnlyUnread', 'osOnlyUnread', 'idracOnly', 'osOnly', 'mismatch', 'partial', 'first', 'psiAbsent'];

/**
 * 한 서버의 상태 code 목록(서버 code 를 읽기만 — 판정하지 않는다).
 * @param {object} entry   성능 항목(목록·상세 공용)
 * @param {object} target  대상(paths — 등록된 경로)
 * @param {{authStops?:Array, snapAt?:number|null, staleMs?:number|null, now?:number, off?:boolean}} o
 */
export function rowStates(entry, target = {}, { authStops = [], snapAt = null, staleMs = null, now = Date.now(), off = false } = {}) {
  const out = new Set();
  // 꺼짐(반증 D4) — 이 노드(또는 그 엣지)의 수집이 꺼져 있다. 서버 설정의 enabled 를 그대로 쓴다(화면이 판정하지 않는다).
  if (off) out.add('off');
  const key = t(target?.key ?? entry?.key);
  if (key && (authStops || []).some((a) => t(a?.key) === key)) out.add('auth');
  if (!entry) return STATE_ORDER.filter((s) => out.has(s));
  const paths = Array.isArray(target?.paths) ? target.paths : [];
  const cov = entry.coverage;
  const os = pathState(cov, paths, 'os');
  const id = pathState(cov, paths, 'idrac');
  if (cov === 'none') out.add(os === 'nopath' && id === 'nopath' ? 'noPath' : 'noneRead');
  else if (cov === 'os') out.add(id === 'unread' ? 'osOnlyUnread' : 'osOnly');
  else if (cov === 'idrac') out.add(os === 'unread' ? 'idracOnlyUnread' : 'idracOnly');
  if (entry.rowStale || entry.verdict === 'stale') out.add('stale');
  if (entry.verdict === 'partial') out.add('partial');
  if (entry.firstSample) out.add('first');
  if (entry.psiAbsent) out.add('psiAbsent');
  if (entry.mismatch?.cpu?.flag) out.add('mismatch');
  if (n(snapAt) != null && n(staleMs) != null && now - n(snapAt) > n(staleMs)) out.add('edgeStale');
  return STATE_ORDER.filter((s) => out.has(s));
}

/** 불일치 한 줄 — 두 값과 차이, 기준(API 값). 단정하지 않는다. */
export function mismatchText(mm, th = {}) {
  const c = mm?.cpu;
  if (!c || !c.flag) return '';
  const base = n(th?.cpuMismatchPct);
  return `CPU 사용률이 두 경로에서 다릅니다 — OS ${numText(c.os, '%')} · iDRAC ${numText(c.idrac, '%')}(차이 ${numText(c.diffPp, '%p')}${base != null ? ` · 기준 ${numText(base, '%p')}` : ''}). OS 값을 쓰고 iDRAC 값을 곁에 적습니다 — 어느 쪽이 맞는지 단정하지 않습니다.`;
}

/** ‘읽은 칸 j/a’ — 서버 read 를 그대로. */
export function readText(read) {
  const j = n(read?.judged); const a = n(read?.applicable);
  return j != null && a != null ? `읽은 칸 ${j}/${a}` : '';
}

/* ───────────────────────── 교차 판정 ①~④ ───────────────────────── */
export const CROSS_NO = Object.freeze({ 1: '①', 2: '②', 3: '③', 4: '④' });
export const CROSS_STATE_INFO = Object.freeze({
  candidate: { label: '후보', tone: 'warn' },
  clear: { label: '다른 후보', tone: 'ok' },
  inactive: { label: '해당 없음', tone: 'idle' },
  missing: { label: '못 읽음', tone: 'idle' },
  nopath: { label: '경로 없음', tone: 'idle' },
});
/** 교차 결론 code → 문장(‘후보’ 로만 — 상관은 원인이 아니다). */
export const CROSS_CODE_TEXT = Object.freeze({
  'power-thermal-limit': '코어 부족이 아니라 **전력·열 제한** 후보입니다',
  'cpu-demand': '전력·열 제한 근거가 없습니다 — **CPU 수요 자체**가 후보입니다',
  'replace-candidate': '**고장 전조** 후보입니다 — 교체 대상인지 확인하세요',
  'io-volume': '고장 전조 근거가 없습니다 — **I/O 양** 문제가 후보입니다',
  'dimm-slot': '**DIMM 위치** 후보가 있습니다',
  'kernel-queue': '회선이 아니라 **커널·큐(irq·ring)** 쪽이 후보입니다',
  'cable-optic': '**케이블·광모듈** 쪽이 후보입니다',
});
const CROSS_STATE_TEXT = Object.freeze({
  inactive: 'OS 쪽 조건이 서지 않아 해당 없습니다.',
  missing: '판정에 필요한 값을 읽지 못했습니다(이 저장소가 받지 않는 값 포함) — 단정하지 않습니다.',
  nopath: '두 경로가 다 읽혀야 켜집니다 — 한 경로만으로는 원인을 특정하지 않습니다.',
});
/** 교차 판정 하나 → 표시. */
export function crossView(item = {}) {
  const st = CROSS_STATE_INFO[item.state] || CROSS_STATE_INFO.missing;
  // ③(DIMM)은 OS 쪽 조건이 아니라 iDRAC 쪽 이상 유무로 켜진다 — ‘해당 없음’ 의 이유가 다르다(서버 crossJudge ③).
  const why = item.state === 'inactive' && item.id === 3 ? 'iDRAC 에서 DIMM 이상이 보이지 않아 해당 없습니다.' : (CROSS_STATE_TEXT[item.state] || CROSS_STATE_TEXT.missing);
  const conclusion = (item.state === 'candidate' || item.state === 'clear') ? (CROSS_CODE_TEXT[item.code] || '') : why;
  const dev = Array.isArray(item.devices) && item.devices.length ? ` — ${item.devices.slice(0, 4).map((d) => `‘${t(d)}’`).join(' · ')}` : '';
  return {
    no: CROSS_NO[item.id] || '', title: t(item.title), stateLabel: st.label, tone: st.tone,
    evidence: Array.isArray(item.evidence) ? item.evidence.map(t).filter(Boolean) : [],
    conclusion: `${conclusion}${item.state === 'candidate' ? dev : ''}`,
  };
}
/** 판정 띠에 붙일 교차 판정 요약 — 후보·다른 후보만(해당 없음·못 읽음은 패널에서). */
export function crossBandText(list = []) {
  const hits = (list || []).filter((x) => x && (x.state === 'candidate' || x.state === 'clear') && CROSS_CODE_TEXT[x.code]);
  return hits.map((x) => `교차 ${CROSS_NO[x.id] || ''} ${CROSS_CODE_TEXT[x.code]}`);
}

/* ───────────────────────── 기준값 · 근거 ───────────────────────── */
/**
 * 근거 key → 기준값 키(API `perfThresholds`) — **보여 주기만** 한다(비교하지 않는다). 증가분 칸은 ‘증가 → 주의 · n주기 연속 → 초과’.
 * 받지 않는 값(스로틀·ECC·SMART 재할당·CRC)과 부품·SEL 칸은 기준 숫자가 없다(null).
 */
export const BASIS_TH = Object.freeze({
  cpu_pct: ['utilWarn', 'utilBad', '%'], mem_pct: ['utilWarn', 'utilBad', '%'], disk_busy_pct: ['utilWarn', 'utilBad', '%'], net_pct: ['utilWarn', 'utilBad', '%'],
  runq_per_core: ['runqWarn', 'runqBad', ''], psi_cpu_some10: ['psiCpuSomeWarn', 'psiCpuSomeBad', '%'],
  swap_out_ps: ['swapOutWarn', 'swapOutBad', 'pages/s'], psi_mem_full10: ['psiFullWarn', 'psiFullBad', '%'],
  disk_aqu: ['queueWarn', 'queueBad', ''], psi_io_full10: ['psiFullWarn', 'psiFullBad', '%'],
  tcp_retrans_pct: ['retransWarn', 'retransBad', '%'],
  power_cap_pct: ['powerCapWarnPct', 'powerCapBadPct', '%'], inlet_c: ['inletWarnC', 'inletBadC', '℃'],
  oom_kill_delta: 'repeat', net_drop_delta: 'repeat', net_err_delta: 'repeat',
});
export function thresholdText(key, th) {
  const m = BASIS_TH[key];
  if (!m || !th || typeof th !== 'object') return '';
  if (m === 'repeat') { const r = n(th.errRepeatBad); return r != null ? `증가 → 주의 · ${r}주기 연속 → 초과` : ''; }
  const w = n(th[m[0]]); const b = n(th[m[1]]);
  if (w == null || b == null) return '';
  return `주의 ${numText(w, m[2])} · 초과 ${numText(b, m[2])}`;
}
/** 근거 한 줄 — ‘nvme0n1 평균 대기열 9.2’. 값이 없으면 code 의 뜻(못 읽음 · 없음 · 경로 없음)을 적는다. */
export function basisText(b = {}) {
  const c = codeInfo(b.code);
  const dev = t(b.device) ? `${t(b.device)} ` : '';
  const v = n(b.value);
  return `${dev}${t(b.label)} ${v != null ? numText(v, t(b.unit)) : (c.judged ? '—' : `—(${c.label})`)}`;
}

/**
 * 근거 열(판정에 쓰지 않는 값 — API `perfCols` 의 judged:false)을 자원별로. 값이 없는 열도 남긴다(‘—’ — 못 읽음을 숨기지 않는다).
 * @returns {Array<{col,label,use,text}>}
 */
export function evidenceRows(perfCols = [], values = {}, res) {
  return (perfCols || []).filter((c) => c && c.res === res && c.judged === false)
    .map((c) => ({ col: c.col, label: t(c.label), use: c.use, text: numText(values?.[c.col], c.unit) }));
}

/* ───────────────────────── 보드(목록) ───────────────────────── */
/** U 칸의 값 열(입력이 하나뿐인 칸 — 색과 숫자가 어긋나지 않는다). 하드웨어 U(전력 cap 대비)는 목록 행에 값이 없다. */
export const U_COL = Object.freeze({ cpu: 'cpu_pct', mem: 'mem_pct', disk: 'disk_busy_pct', net: 'net_pct' });

/**
 * 보드 항목 — 이 노드의 대상(+최신값 · 성능 항목)과 엣지 보관분(대상 · 최신값 · 성능 항목)을 한 목록으로. 같은 키는 이 노드 것이 먼저다.
 * ⚠ 위임 수집 환경에서 중앙 보드가 비면 안 된다(루트 CLAUDE.md) — 엣지 행은 `agent` · `snapAt` 을 달고 들어온다.
 */
export function boardItems(data = {}, edges = null) {
  const out = [];
  const seen = new Set();
  const add = (targets, rows, perf, extra = {}) => {
    const rowBy = new Map((rows || []).map((r) => [t(r?.key), r]));
    const perfBy = new Map((perf || []).map((p) => [t(p?.key), p]));
    for (const tg of targets || []) {
      const k = t(tg?.key);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ key: k, name: t(tg.name) || k, vcenterId: t(tg.vcenterId), target: tg, row: rowBy.get(k) || null, entry: perfBy.get(k) || null, ...extra });
    }
  };
  // 꺼짐(반증 D4): 이 노드 수집이 꺼졌으면(데모는 켜진 것처럼 돈다 — 기존 emptyDiag 규약) · 엣지는 그 엣지가 보고한 enabledOnEdge === false.
  add(data?.targets, data?.rows, data?.perf, { agent: '', snapAt: null, th: data?.perfThresholds || null, off: data?.enabled === false && !data?.demo });
  for (const e of (edges?.rows || [])) {
    if (!e?.snapAt) continue;
    add(e.targets, e.rows, e.perf, { agent: t(e.agent), snapAt: n(e.snapAt), th: e.perfThresholds || null, perfTruncated: e.perfTruncated || null, off: e.enabledOnEdge === false });
  }
  return out;
}

/** 인증 정지 목록 — 이 노드 것 + 엣지 보관분 것(반증 D6: 엣지 위임 서버의 ‘인증 정지’ 가 빠졌다). 엣지 목록은 서버가 이미 범위로 걸렀다. */
export function allAuthStops(data = {}, edges = null) {
  const out = [...(Array.isArray(data?.authStops) ? data.authStops : [])];
  for (const e of (edges?.rows || [])) if (e?.snapAt && Array.isArray(e.authStops)) out.push(...e.authStops);
  return out;
}

/** 신뢰 띠 수(보이는 항목 기준 — 전부 서버 code 를 센 것). */
export function trustCounts(items = [], { authStops = [], staleMs = null, now = Date.now() } = {}) {
  const c = { total: items.length, off: 0, both: 0, os: 0, idrac: 0, none: 0, noEntry: 0, read: 0, first: 0, unreadOs: 0, unreadIdrac: 0, psiAbsent: 0, stale: 0, auth: 0, edge: 0 };
  for (const it of items) {
    const e = it.entry;
    if (it.agent) c.edge += 1;
    if (it.off) c.off += 1;
    if ((authStops || []).some((a) => t(a?.key) === it.key)) c.auth += 1;
    if (!e) { c.noEntry += 1; continue; }
    const cov = COVERAGE_INFO[e.coverage] ? e.coverage : 'none';
    c[cov] += 1;
    if (cov !== 'none') c.read += 1;
    if (e.firstSample) c.first += 1;
    if (e.psiAbsent) c.psiAbsent += 1;
    const paths = it.target?.paths || [];
    if (pathState(cov, paths, 'os') === 'unread') c.unreadOs += 1;
    if (pathState(cov, paths, 'idrac') === 'unread') c.unreadIdrac += 1;
    if (e.rowStale || e.verdict === 'stale' || (n(it.snapAt) != null && n(staleMs) != null && now - n(it.snapAt) > n(staleMs))) c.stale += 1;
  }
  return c;
}
/** 신뢰 띠 문장 조각 — 0 인 칸은 빼고(‘못 읽음 0’ 을 늘어놓지 않는다), 경로 분포는 늘 적는다. */
export function trustBandParts(c = {}, { intervalMs = null, corpOff = 0 } = {}) {
  const parts = [];
  if (c.off) parts.push(`꺼짐 **${c.off}** — 수집이 꺼진 노드의 서버(값은 마지막 수집 기준)`);
  parts.push(`경로 — 둘 다 **${c.both || 0}** · OS 만 **${c.os || 0}** · iDRAC 만 **${c.idrac || 0}** · 없음 **${(c.none || 0) + (c.noEntry || 0)}**`);
  const iv = n(intervalMs);
  parts.push(`읽음 **${c.read || 0}/${c.total || 0}**${iv ? ` · 주기 ${Math.round(iv / 60_000)}분` : ''}`);
  if (c.first) parts.push(`첫 주기 **${c.first}** — 다음 주기부터 값`);
  if (c.unreadOs || c.unreadIdrac) parts.push(`못 읽음 — OS(SSH) **${c.unreadOs || 0}** · iDRAC **${c.unreadIdrac || 0}**`);
  if (c.auth) parts.push(`인증 정지 **${c.auth}**`);
  if (c.stale) parts.push(`오래됨 **${c.stale}**`);
  if (c.psiAbsent) parts.push(`PSI 없음 **${c.psiAbsent}** — 그 커널에 없음(못 읽음 아님)`);
  if (c.noEntry) parts.push(`판정 항목 없음 **${c.noEntry}** — 아직 표본이 없습니다`);
  if (c.edge) parts.push(`엣지 보관분 **${c.edge}**대 포함`);
  if (n(corpOff)) parts.push(`꺼진 법인의 서버 **${n(corpOff)}**대는 표에 없습니다(법인 단위로 켭니다)`);
  return parts;
}

/** KPI — 서버 verdict 를 센다(병목·포화·오류·정상) + 판정 보류(대부분 못 읽음 · 오래됨 · 판정 불가 · 항목 없음). 자원별 포화는 perResource. */
export function kpiCounts(items = []) {
  const k = { total: items.length, both: 0, bottleneck: 0, saturated: 0, errors: 0, warn: 0, ok: 0, held: 0, satByRes: { cpu: 0, mem: 0, disk: 0, net: 0, hw: 0 }, errByRes: { cpu: 0, mem: 0, disk: 0, net: 0, hw: 0 } };
  for (const it of items) {
    const e = it.entry;
    if (!e) { k.held += 1; continue; }
    if (e.coverage === 'both') k.both += 1;
    const v = VERDICT_INFO[e.verdict] ? e.verdict : 'unknown';
    if (v === 'partial' || v === 'stale' || v === 'unknown') k.held += 1; else k[v] += 1;
    for (const r of RES_ORDER) {
      if (e.codes?.[r]?.S === 'bad') k.satByRes[r] += 1;
      if (e.codes?.[r]?.E === 'bad') k.errByRes[r] += 1;
    }
  }
  return k;
}
/** 자원별 수 → ‘CPU 3 · 디스크 6’(0 은 뺀다). */
export function byResText(m = {}) {
  return RES_ORDER.filter((r) => n(m[r])).map((r) => `${RES_LABEL[r]} ${m[r]}`).join(' · ');
}

/** 병목 Top — 서버 판정 등급 순(병목 > 포화 > 오류 > 주의), 같은 등급은 병목 자원 수 · 이름. 정상·판정 보류는 넣지 않는다. */
export function topBottlenecks(items = [], limit = 5) {
  return items.filter((it) => it.entry && ['bottleneck', 'saturated', 'errors', 'warn'].includes(it.entry.verdict))
    .sort((a, b) => (verdictView(b.entry.verdict).rank - verdictView(a.entry.verdict).rank)
      || ((n(b.entry.bottleneckCount) ?? 0) - (n(a.entry.bottleneckCount) ?? 0))
      || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}
/** 매트릭스 기본 순서 — 심각도 먼저(판정 보류는 맨 뒤). 열 클릭 정렬은 STable 이 한다. */
export function severityOrder(items = []) {
  return [...items].sort((a, b) => (verdictView(b.entry?.verdict).rank - verdictView(a.entry?.verdict).rank) || a.name.localeCompare(b.name));
}

/* ───────────────────────── 서버 상세 ───────────────────────── */
/** 탭 열 — 기능이 있는 것만(없는 기능을 그리지 않는다). 순서는 아트보드 ② · ⑤ ⑥ ⑦ 의 탭 열 그대로. */
export const DETAIL_TABS = Object.freeze([
  { id: 'summary', label: '요약' },
  { id: 'res', label: '자원(USE)' },
  { id: 'hw', label: '하드웨어(iDRAC)' },
  // v2.923(4단계): 장애 기록 · 튜닝 · 용도 · 진단 스냅샷 — 서버 API(perf/:key/faults · tuning · profile · snapshot(s)) 가 생겨 더했다. 문구는 bmOpsText.js.
  { id: 'faults', label: '장애 기록' },
  { id: 'tuning', label: '튜닝' },
  { id: 'profile', label: '용도' },
  { id: 'snap', label: '진단 스냅샷' },
  // v2.923(3b): 추이 탭 — 서버 3a 의 추이 API(시간 단위 파일 · 평균/피크) 가 생겨 더했다. 문구는 bmTrendText.js.
  { id: 'trend', label: '추이(평균 · 피크)' },
  // v2.929(5단계): 집중 모니터링 — 서버 API(perf/:key/focus) 가 생겨 더했다. 문구는 bmPerfOpsText.js.
  { id: 'focus', label: '집중 모니터링' },
  // 6단계: 진단 플레이북(판정 → 읽기 전용 런북 — 포탈은 실행하지 않음) · 목표선(SLO 달성률) — 서버 API(perf/:key/playbook · slo)가 생겨 더했다. 문구는 bmRunbookText.js.
  { id: 'playbook', label: '진단 플레이북' },
  { id: 'slo', label: '목표선' },
]);

/** 상세 머리 아래 안내 — 응답이 말하는 사실(엣지 보관분 · 상세 생략 · 표본 없음 · 엣지 기준값)을 그대로. */
export function detailNotes(resp = {}, { now = Date.now() } = {}) {
  const out = [];
  if (!resp || typeof resp !== 'object') return out;
  if (resp.via === 'edge') out.push(`엣지 **${t(resp.agent)}** 가 판정해 보낸 보관분입니다${n(resp.snapAt) != null ? `(${ageText(resp.snapAt, now)} 받음)` : ''} — 중앙은 다시 판정하지 않습니다.`);
  if (resp.via === 'edge-none') out.push(`엣지 **${t(resp.agent)}** 보관분에 이 서버의 성능 항목이 없습니다 — 엣지가 아직 성능 수집 이전 판이거나 표본이 없습니다. 엣지 보관분의 ‘지금 가져오기’ 로 새로 받을 수 있습니다.`);
  if (resp.reason === 'no-sample') out.push('이 서버의 표본이 아직 없습니다 — 다음 주기에 채워집니다.');
  if (resp.detailOmitted) out.push(`엣지 봉투가 크기 상한을 넘어 **근거·장치별 상세를 뺐습니다**${resp.perfTruncated?.reason ? `(사유 ‘${t(resp.perfTruncated.reason)}’)` : ''} — 칸 판정과 판정 한 줄은 그대로입니다.`);
  else if (resp.perfTruncated) out.push('엣지 봉투가 크기 상한에 닿아 일부 서버의 성능 상세가 빠졌습니다 — 이 서버는 상세가 있습니다.');
  if (resp.edgeThresholds) out.push('기준값은 **그 엣지의 설정**입니다(중앙 설정과 다를 수 있습니다).');
  return out;
}

/** 두 경로 읽은 시각 — 각 경로의 **마지막 성공**(서버 os_at · idrac_at). 등록이 없으면 ‘경로 없음’, 등록은 있는데 기록이 없으면 ‘읽은 적 없음’. */
export function pathAtText(entry = {}, paths = [], { now = Date.now() } = {}) {
  const one = (label, at, which) => {
    if (n(at) != null) return `${label} ${ageText(at, now)}`;
    // iDRAC 은 텔레메트리 시각이 없어도 주 폴러 사실로 읽힐 수 있다(coverage) — 그때는 ‘읽힘(텔레메트리 시각 없음)’.
    if (which === 'idrac' && (entry.coverage === 'both' || entry.coverage === 'idrac')) return `${label} 읽힘(센서·인벤토리)`;
    return `${label} ${(paths || []).includes(which) ? '읽은 적 없음' : '경로 없음'}`;
  };
  return `${one('OS(SSH)', entry.osAt, 'os')} · ${one('iDRAC(Redfish)', entry.idracAt, 'idrac')}`;
}

/** 하드웨어 사실 표(1단계 hwFacts 가 주는 것만) — 값이 null 이면 ‘—’ 와 그 이유(받지 않는 값 · 못 읽음). */
export const HW_NOT_RECEIVED = Object.freeze({ throttle: 'CPU 스로틀', eccCorrectable: 'ECC 정정 수', smartRealloc: 'SMART 재할당', nicCrc: 'NIC CRC' });
export function hwFactRows(hw, { now = Date.now() } = {}) {
  if (!hw || typeof hw !== 'object') return [];
  const list = (v) => (Array.isArray(v) ? (v.length ? v.map((x) => `‘${t(x)}’`).join(' · ') : '없음') : '—(못 읽음)');
  const p = hw.power || null;
  const rows = [
    { label: '전력', text: p && n(p.watts) != null ? `${numText(p.watts, 'W')}${n(p.capWatts) != null ? ` / cap ${numText(p.capWatts, 'W')}` : ' · cap 정보 없음'}${n(p.capPct) != null ? ` (${numText(p.capPct, '%')})` : ''}` : (p && n(p.capWatts) != null ? `—(전력 표본 없음) · cap ${numText(p.capWatts, 'W')}` : '—(못 읽음)') },
    { label: '흡기 온도', text: n(hw.inletC) != null ? `${numText(hw.inletC, '℃')}${n(hw.sensorAt) != null ? ` · ${ageText(hw.sensorAt, now)}` : ''}` : '—(흡기 센서를 찾지 못함)' },
    { label: 'iDRAC CPU', text: n(hw.cpuPct) != null ? numText(hw.cpuPct, '%') : '—(못 읽음)' },
    { label: 'DIMM 이상', text: hw.dimmBad == null ? '—(못 읽음)' : `Critical ${list(hw.dimmBad)} · Warning ${list(hw.dimmWarn)}` },
    { label: 'SMART 예측 장애', text: list(hw.diskPredicted) },
    { label: 'SEL Critical', text: n(hw.selCritical) != null ? `${hw.selCritical}건(인벤토리 이벤트 — 시간 창 없음)` : '—(못 읽음)' },
    { label: '부품 장애(열림)', text: n(hw.faultCount) != null ? `${hw.faultCount}건` : '—(못 읽음)' },
    { label: '인벤토리', text: n(hw.inventoryAt) != null ? `${ageText(hw.inventoryAt, now)}${hw.inventoryStale ? ' — 오래돼 쓰지 않음' : ''}` : '—(없음)' },
  ];
  const nr = Object.entries(HW_NOT_RECEIVED).filter(([k]) => hw[k] == null).map(([, l]) => l);
  if (nr.length) rows.push({ label: '받지 않는 값', text: `${nr.join(' · ')} — 이 저장소가 아직 받지 않습니다(‘—¹’ · 없다고 단정하지 않음)` });
  return rows;
}

/** 상세 조회 실패 문구 — 404 는 ‘없거나 범위 밖’(존재 은닉 규약 — 둘을 구분하지 않는다). 403 은 화면이 ErrorBox 로 권한 안내. */
export function detailErrorText(err) {
  const s = t(err?.message || err);
  if (err?.status === 404 || /404|찾지 못했/.test(s)) return '이 서버의 성능 상세를 찾지 못했습니다 — 대상에서 빠졌거나 볼 수 있는 범위 밖입니다.';
  return `성능 상세를 읽지 못했습니다: ${s || '사유 미상'}`;
}

/** 하드웨어 사실이 없을 때의 이유 — 상태 code(경로 없음 · 못 읽음)로 고른다. 단정하지 않는다. */
export function hwEmptyText(states = []) {
  if (states.includes('osOnly') || states.includes('noPath')) return STATE_TEXT.osOnly.body;
  if (states.includes('osOnlyUnread') || states.includes('noneRead')) return STATE_TEXT.osOnlyUnread.body;
  return '하드웨어 사실이 없습니다 — 엣지 봉투에서 상세가 빠졌거나 iDRAC 사실을 아직 받지 못했습니다.';
}
