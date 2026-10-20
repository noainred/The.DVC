/**
 * vmDistText.js — 가상머신 상세 C안(v2.746): 분포 패널·선택 칩·표 칸의 판정과 문구 한 벌(순수 — React·DOM 없음).
 *
 * 서버 계약(server/src/inventory/vmDist.js vmDistribution, /vms?dist=1):
 *  - 칸은 5% 20개다. 칸 번호와 개수는 **서버가 센다**(구동 중인 VM 만 칸에 들어가고, 사용률을 못 읽은 구동 VM 은 na,
 *    구동 중이 아닌 VM 은 off 로 따로 센다). 화면은 그 결과를 그리기만 한다 — 여기서 VM 을 다시 세지 않는다.
 *  - 각 패널의 개수는 **다른 패널에서 고른 조건만** 반영한다(자기 선택으로 자기 개수를 줄이지 않는다).
 *  - 선택 쿼리 키 cpuBin·memBin(a-b 또는 na) · power(on·off·suspended·other) · osName(원문 또는 ~). 형식이 틀리면
 *    서버가 400 bad-facet 로 거절하므로 facetParams 는 형식이 맞는 값만 보낸다.
 * 임계값은 consoleData 의 WARN_PCT(75)·CRIT_PCT(90) 하나 — 숫자를 박지 않는다.
 * 문구 규칙: 백틱·별표 강조 금지 · 값이 없으면 단위를 붙이지 않는다 · 숫자는 en-US 천 단위 구분.
 */
import { WARN_PCT, CRIT_PCT } from '../console/consoleData.js';
import { numOrNull } from '../numOrNull.js';

export const BIN_PCT = 5;
export const BIN_COUNT = 20;
export const WARN_BIN = Math.round(WARN_PCT / BIN_PCT); // 15 — 75%↑
export const CRIT_BIN = Math.round(CRIT_PCT / BIN_PCT); // 18 — 90%↑
const LAST_BIN = BIN_COUNT - 1;
const OS_NAME_MAX = 200;
/** 전원 선택 값 — 서버 계약의 power 키. 순서가 곧 막대 순서다. */
export const POWER_KEYS = ['on', 'off', 'suspended', 'other'];
// ⚠ POWERED_OFF 는 '꺼짐' 이다 — '정지' 는 위 KPI '전체 VM' 메타가 이미 '구동 아님 전부(= 전체 − 구동)' 뜻으로 쓴다.
//   같은 화면에서 같은 낱말이 두 숫자(정지 8 vs 정지 4)를 가리키지 않게 새 패널·칩·전원 점은 이 낱말을 쓰지 않는다(C-04).
export const POWER_LABEL = { on: '구동', off: '꺼짐', suspended: '일시정지', other: '기타' };
export const POWER_TITLE = {
  on: '전원이 켜진 VM',
  off: '전원이 꺼진 VM',
  suspended: '일시정지한 VM',
  other: '전원 상태가 켜짐·꺼짐·일시정지가 아니거나 비어 있는 VM',
};
export const GPU_KEYS = ['vgpu', 'passthrough', 'mixed'];
export const GPU_LABEL = { vgpu: 'vGPU', passthrough: '패스쓰루', mixed: '혼합' };
export const EMPTY_FACETS = Object.freeze({ cpuBin: '', memBin: '', power: '', osName: '' });
const FACET_KEYS = ['cpuBin', 'memBin', 'power', 'osName'];

/** 색은 전부 CSS 변수 — 정의는 styles.css :root 와 vmDist.css 의 .vmd 토큰 블록. */
export const TONE_COLOR = {
  ok: 'var(--accent-2)',
  warn: 'var(--amber)',
  crit: 'var(--red)',
  dim: 'var(--vmd-dim)',
  none: 'var(--text-faint)',
};
export const TONE_TEXT = {
  ok: 'var(--text)',
  warn: 'var(--vmd-warn-text)',
  crit: 'var(--vmd-crit-text)',
  none: 'var(--text-faint)',
};

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/* ── 칸 ───────────────────────────────────────────────────────────── */

/** 칸 i(0~19)의 톤 — 칸 하한 i*5 가 90 이상이면 crit, 75 이상이면 warn. */
export function binTone(i) {
  const lo = i * BIN_PCT;
  if (lo >= CRIT_PCT) return 'crit';
  if (lo >= WARN_PCT) return 'warn';
  return 'ok';
}

/** 표 칸의 사용률 톤 — 값을 못 읽었으면 none(0 이 아니다). */
export function pctTone(pct) {
  const v = numOrNull(pct);
  if (v == null) return 'none';
  if (v >= CRIT_PCT) return 'crit';
  if (v >= WARN_PCT) return 'warn';
  return 'ok';
}

/** 'a-b'·'na' → {a,b}·{na:true}. 형식이 틀리면 null(서버의 bad-facet 판정과 같은 경계). */
export function parseBinSel(s) {
  if (typeof s !== 'string') return null;
  if (s === 'na') return { na: true };
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  if (a > b || b > LAST_BIN) return null;
  return { a, b };
}

const inSel = (i, sel) => !!sel && !sel.na && i >= sel.a && i <= sel.b;

/** 막대 색 — 다른 칸이 골라져 있으면 선택 밖 ok 칸만 흐리게(warn·crit 은 제 색으로 둔다 — 시안). */
export function binColor(i, selStr) {
  const tone = binTone(i);
  const sel = parseBinSel(selStr);
  if (sel && !inSel(i, sel) && tone === 'ok') return TONE_COLOR.dim;
  return TONE_COLOR[tone];
}

/** 칸이 고른 구간 안인가. */
export function binSelected(i, selStr) { return inSel(i, parseBinSel(selStr)); }

/** 서버 bins 를 20칸 숫자 배열로(모자라거나 틀린 값은 0). */
function normBins(bins) {
  const src = Array.isArray(bins) ? bins : [];
  return Array.from({ length: BIN_COUNT }, (_, i) => cnt(src[i]));
}

/**
 * 막대 높이(%) — 최댓값 대비. 개수가 있으면 최소 3%(1대짜리 칸도 보이게), **개수 0 인 칸은 0**(화면은 중립 1px 선 —
 * CLAUDE.md v2.556: 0 인 칸을 온도·경고색으로 칠하면 '그 구간에 VM 이 있다' 고 말하게 된다).
 */
export function barHeights(bins) {
  const b = normBins(bins);
  const max = Math.max(0, ...b);
  return b.map((n) => {
    if (n <= 0 || max <= 0) return { n: 0, h: 0, zero: true };
    return { n, h: Math.max(3, Math.round((n / max) * 100)), zero: false };
  });
}

/** 구간 문구 — binLabel(18,19) = '90~100%' · binLabel('na') = '사용률 미수집'. */
export function binLabel(a, b) {
  if (a === 'na') return '사용률 미수집';
  const hi = b == null ? a : b;
  return `${a * BIN_PCT}~${(hi + 1) * BIN_PCT}%`;
}

/** 선택 문자열 → 구간 문구(틀린 값·빈 값은 ''). */
export function selLabel(selStr) {
  const sel = parseBinSel(selStr);
  if (!sel) return '';
  return sel.na ? binLabel('na') : binLabel(sel.a, sel.b);
}

/** 막대 버튼의 화면판독 라벨 — 'CPU 90~95% 11대'. */
export function binAria(what, i, n) {
  return `${what} ${i === 'na' ? binLabel('na') : binLabel(i)} ${fmt(cnt(n))}대`;
}

/** 패널 머리 '90%↑'·'75%↑' 를 눌렀을 때의 선택 — 그 이상 전체. */
export function thresholdSel(level) {
  return `${level === 'crit' ? CRIT_BIN : WARN_BIN}-${LAST_BIN}`;
}

/** 선택 구간에 든 VM 수(패널 기준). 패널이 없거나 선택이 없으면 null. */
export function panelCount(p, selStr) {
  if (!p || typeof p !== 'object') return null;
  const sel = parseBinSel(selStr);
  if (!sel) return null;
  if (sel.na) return cnt(p.na);
  const b = normBins(p.bins);
  let s = 0;
  for (let i = sel.a; i <= sel.b; i += 1) s += b[i];
  return s;
}

/** 머리 개수 — 90%↑ = 칸 18~19 합 · 75%↑ = 칸 15~19 합. */
export function thresholdCount(p, level) { return panelCount(p, thresholdSel(level)); }

/**
 * 막대 칸 버튼의 상태 — 눌림·화면판독 라벨·title 을 클릭 동작(toggleBin)에서 끌어낸다.
 *  - on: 고른 구간 안의 칸(겉모양 강조). 90%↑(18-19) 처럼 여러 칸을 고르면 그 칸들이 모두 on 이다.
 *  - pressed: 누르면 해제되는 칸 = toggleBin 이 빈 값을 주는 칸(칸 하나만 고른 상태의 그 칸)뿐이다.
 *    구간 안의 다른 칸은 누르면 해제가 아니라 그 칸만 남으므로 눌림이 아니고, 문구도 그렇게 말한다(W-R3 —
 *    '다시 누르면 해제' 라 해 놓고 누르면 그 칸으로 좁혀지던 거짓 안내).
 */
export function binButton(what, i, n, selStr) {
  const sel = parseBinSel(selStr);
  const on = inSel(i, sel);
  const pressed = toggleBin(selStr, i) === '';
  const base = `${binLabel(i)} · ${fmt(cnt(n))}대`;
  const range = sel && !sel.na ? binLabel(sel.a, sel.b) : '';
  if (pressed) return { on, pressed, label: binAria(what, i, n), title: `${base} — 다시 누르면 해제` };
  if (on) {
    return {
      on, pressed,
      label: `${binAria(what, i, n)} · 고른 ${range} 구간에 포함`,
      title: `${base} — 눌러서 이 칸만 보기(지금은 ${range} 구간 선택 중)`,
    };
  }
  return { on, pressed, label: binAria(what, i, n), title: `${base} — 눌러서 이 구간만 보기` };
}

/** 같은 칸을 다시 누르면 해제, 다른 칸이면 그 칸만. i 는 칸 번호 또는 'na'. */
export function toggleBin(cur, i) {
  const next = i === 'na' ? 'na' : `${i}-${i}`;
  return cur === next ? '' : next;
}
/** 구간 선택 토글(머리 개수·OS·전원) — 같으면 해제. */
export function toggleSel(cur, sel) { return cur === sel ? '' : sel; }

/* ── facet 쿼리 ───────────────────────────────────────────────────── */

function cleanOs(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t && t.length <= OS_NAME_MAX ? t : '';
}

/** /vms 에 보낼 선택 쿼리 — 빈 값·형식이 틀린 값은 키째 뺀다. */
export function facetParams(state) {
  const s = state && typeof state === 'object' ? state : {};
  const out = {};
  if (parseBinSel(s.cpuBin)) out.cpuBin = s.cpuBin;
  if (parseBinSel(s.memBin)) out.memBin = s.memBin;
  if (POWER_KEYS.includes(s.power)) out.power = s.power;
  const os = cleanOs(s.osName);
  if (os) out.osName = os;
  return out;
}

/** 선택의 안정된 키(순서 무관) — 비면 ''. 페이지 순회 조건 키에 쓴다. */
export function facetKey(state) {
  const p = facetParams(state);
  const keys = Object.keys(p).sort();
  return keys.length ? JSON.stringify(keys.map((k) => [k, p[k]])) : '';
}
export function hasFacet(state) { return facetKey(state) !== ''; }
export function clearFacet(state, key) {
  const s = { ...EMPTY_FACETS, ...(state && typeof state === 'object' ? state : {}) };
  if (FACET_KEYS.includes(key)) s[key] = '';
  return s;
}

/** 400 bad-facet — 고른 구간을 서버가 받지 않았다. 다른 오류는 ''. */
export function facetErrorText(error) {
  const s = typeof error === 'string' ? error : (error && typeof error.message === 'string' ? error.message : '');
  if (s !== 'bad-facet') return '';
  return '고른 구간을 서버가 받지 않았습니다(형식이 맞지 않음) — 고른 구간을 모두 해제하고 다시 보세요.';
}

/* ── 문구 ─────────────────────────────────────────────────────────── */

/** Guest OS 표시 이름 — 서버의 '~'(정보 없음)는 사람이 읽을 말로. */
export function osLabel(name) {
  if (name == null || name === '' || name === '~') return '(OS 정보 없음)';
  return String(name);
}

/** 선택 칩 — [{ key, label, text, tone, count }]. 개수는 dist 의 그 패널 합(dist 가 없으면 null — 개수를 지어내지 않는다). */
export function chipList(state, dist, gpu) {
  const s = { ...EMPTY_FACETS, ...(state && typeof state === 'object' ? state : {}) };
  const d = dist && typeof dist === 'object' ? dist : null;
  const out = [];
  const push = (key, label, tone, count) => {
    out.push({ key, label, tone, count, text: count == null ? label : `${label} · ${fmt(count)}대` });
  };
  const binChip = (key, what, panel) => {
    const sel = parseBinSel(s[key]);
    if (!sel) return;
    const tone = sel.na ? 'none' : binTone(sel.a);
    push(key, `${what} ${selLabel(s[key])}`, tone, d ? panelCount(panel, s[key]) : null);
  };
  binChip('cpuBin', 'CPU', d?.cpu);
  binChip('memBin', '메모리', d?.mem);
  if (POWER_KEYS.includes(s.power)) {
    const n = d?.power && typeof d.power === 'object' ? cnt(d.power[s.power]) : null;
    push('power', `전원 ${POWER_LABEL[s.power]}`, 'info', d ? n : null);
  }
  const os = cleanOs(s.osName);
  if (os) {
    const hit = Array.isArray(d?.os?.top) ? d.os.top.find((o) => o && o.name === os) : null;
    push('osName', `OS ${osLabel(os)}`, 'info', d ? (hit ? cnt(hit.n) : null) : null);
  }
  const g = gpu && typeof gpu === 'object' ? gpu : {};
  if (g.gpuOnly || g.gpuType) {
    const t = GPU_KEYS.includes(g.gpuType) ? g.gpuType : '';
    const gd = d?.gpu && typeof d.gpu === 'object' ? d.gpu : null;
    const n = gd ? cnt(t ? gd[t] : gd.total) : null;
    push('gpu', t ? `GPU ${GPU_LABEL[t]}` : 'GPU 할당 VM', 'info', d ? n : null);
  }
  return out;
}

/** 패널 하단 각주 — 무엇을 셌고 무엇을 뺐는지(0 인 조각은 생략). */
export function distNote(p) {
  if (!p || typeof p !== 'object') return '';
  const read = normBins(p.bins).reduce((a, b) => a + b, 0);
  const parts = [`구동 중이고 사용률을 읽은 ${fmt(read)}대`];
  if (cnt(p.na)) parts.push(`미수집 ${fmt(cnt(p.na))}대는 따로`);
  // 분포 밖 = 구동 중이 아닌 VM 전부(꺼짐·일시정지·전원 모름) — KPI '정지'(전체 − 구동)와 같은 집합이다(C-04).
  if (cnt(p.off)) parts.push(`구동 중이 아닌 ${fmt(cnt(p.off))}대는 분포 밖`);
  if (cnt(p.over100)) parts.push(`100% 초과 ${fmt(cnt(p.over100))}대는 마지막 칸`);
  return parts.join(' · ');
}

/** 패널 상태 — missing(서버가 안 줌) · none(구동 VM 0) · unread(구동 VM 은 있는데 사용률을 하나도 못 읽음) · ok. */
export function panelState(p) {
  if (!p || typeof p !== 'object') return 'missing';
  const read = normBins(p.bins).reduce((a, b) => a + b, 0);
  if (read + cnt(p.na) === 0) return 'none';
  if (read === 0) return 'unread';
  return 'ok';
}
export const EMPTY_PANEL_TEXT = {
  none: '구동 중인 VM 이 없어 분포가 없습니다',
  unread: '구동 중인 VM 의 사용률을 하나도 읽지 못했습니다',
  missing: '이 패널의 집계가 응답에 없습니다',
};
/** 응답에 dist 가 없을 때(구버전 서버·집계 실패) — 패널 대신 이 한 줄. 표와 필터는 그대로 동작한다. */
export const NO_DIST_TEXT = '분포 집계가 응답에 없습니다(서버가 이 기능보다 오래된 버전일 수 있습니다) — 아래 표와 필터는 그대로 쓸 수 있습니다.';

/** 전원 구성 막대 — 비율(전체 대비) · 0 인 칸은 빼되 고른 칸은 남긴다(사라지면 해제할 수 없다). */
export function powerSegments(power, selected) {
  const p = power && typeof power === 'object' ? power : {};
  const total = POWER_KEYS.reduce((a, k) => a + cnt(p[k]), 0);
  const items = POWER_KEYS
    .filter((k) => cnt(p[k]) > 0 || selected === k)
    .map((k) => ({ key: k, n: cnt(p[k]), w: total > 0 ? (cnt(p[k]) / total) * 100 : 0, label: POWER_LABEL[k], title: POWER_TITLE[k], selected: selected === k }));
  return { total, items };
}

/** GPU 구성 막대 — 비율은 (할당 + 없음) 대비. 클릭은 기존 gpuOnly·gpuType 상태로 간다(새 상태를 만들지 않는다). */
export function gpuSegments(gpu, sel) {
  const g = gpu && typeof gpu === 'object' ? gpu : {};
  const s = sel && typeof sel === 'object' ? sel : {};
  const total = cnt(g.total);
  const none = cnt(g.none);
  const all = total + none;
  const items = GPU_KEYS
    .filter((k) => cnt(g[k]) > 0 || s.gpuType === k)
    .map((k) => ({ key: k, n: cnt(g[k]), w: all > 0 ? (cnt(g[k]) / all) * 100 : 0, label: GPU_LABEL[k], selected: s.gpuType === k }));
  return { total, none, items, allSelected: !!s.gpuOnly && !s.gpuType };
}

/**
 * GPU 칸·머리를 눌렀을 때의 다음 상태 — key 'all'(GPU 할당 전체) 또는 vgpu·passthrough·mixed. 같은 것을 다시 누르면 해제.
 * 결과는 Vms 의 기존 gpuOnly·gpuType 상태(KPI GPU 카드와 같은 상태)에 그대로 넣는다.
 */
export function gpuToggle(cur, key) {
  const c = cur && typeof cur === 'object' ? cur : {};
  const on = !!(c.gpuOnly || c.gpuType);
  if (key === 'all') return on && !c.gpuType ? { gpuOnly: false, gpuType: '' } : { gpuOnly: true, gpuType: '' };
  if (!GPU_KEYS.includes(key)) return { gpuOnly: !!c.gpuOnly, gpuType: c.gpuType || '' };
  return c.gpuType === key ? { gpuOnly: false, gpuType: '' } : { gpuOnly: true, gpuType: key };
}

/**
 * Guest OS 줄 — 폭은 목록 최댓값 대비. 고른 OS 가 상위 밖이면 서버가 목록 끝에 붙여 준다(그래서 해제할 줄이 남는다).
 * 눌림(selected)은 서버 메아리(os.top[].selected)가 아니라 **웹 상태 selName(facets.osName)** 에서 정한다 — CPU·메모리 칸·
 * 전원·GPU 와 같은 규칙이고, 클릭 동작(toggleSel(selName, name))과 같은 근거다. 서버 값을 쓰면 선택을 반영하는 동안(직전
 * 응답을 흐리게 보일 때) 고른 줄이 눌리지 않은 것으로 보이고, 한 번 더 누르면 해제된다(C-03 — 보이는 상태와 반대 동작).
 */
export function osRows(os, selName) {
  const top = Array.isArray(os?.top) ? os.top.filter((o) => o && typeof o.name === 'string') : [];
  const max = Math.max(0, ...top.map((o) => cnt(o.n)));
  const sel = typeof selName === 'string' && selName !== '' ? selName : null;
  return top.map((o) => ({ name: o.name, label: osLabel(o.name), n: cnt(o.n), w: max > 0 ? Math.round((cnt(o.n) / max) * 100) : 0, selected: sel != null && o.name === sel }));
}
export function osFooter(os) {
  if (!os || typeof os !== 'object') return '';
  const parts = [];
  if (cnt(os.other)) parts.push(`그 밖 ${fmt(cnt(os.other))}대`);
  if (cnt(os.distinct)) parts.push(`OS 종류 ${fmt(cnt(os.distinct))}가지`);
  return parts.join(' · ');
}

/* ── 표 칸 ────────────────────────────────────────────────────────── */

/** CPU·메모리 칸 — 값을 못 읽었으면 '—'(막대 없음). 문구는 값 그대로, 막대 폭은 0~100. */
export function usageView(pct) {
  const v = numOrNull(pct);
  if (v == null) return { text: '—', w: 0, tone: 'none' };
  return { text: `${v}%`, w: Math.max(0, Math.min(100, v)), tone: pctTone(v) };
}

/** 전원 점 — 색만으로 말하지 않는다(글자 라벨을 함께 싣는다). */
export function powerDot(state) {
  if (state === 'POWERED_ON') return { key: 'on', label: '구동 중', color: 'var(--green)' };
  if (state === 'POWERED_OFF') return { key: 'off', label: POWER_LABEL.off, color: 'var(--text-faint)' };
  if (state === 'SUSPENDED') return { key: 'suspended', label: '일시정지', color: 'var(--amber)' };
  return { key: 'other', label: '전원 상태 모름', color: 'var(--border)' };
}

/** 'vCPU · RAM' 칸 — '32 · 128 GB'. 못 읽은 쪽은 —. */
export function specText(vm) {
  const c = numOrNull(vm?.cpuCount);
  const m = numOrNull(vm?.memMB);
  if (c == null && m == null) return '—';
  return `${c == null ? '—' : c} · ${m == null ? '—' : `${Math.round(m / 1024)} GB`}`;
}
/** 정렬값 — vCPU 우선 그다음 메모리. 둘 다 모르면 null(표가 뒤로 보낸다). */
export function specSort(vm) {
  const c = numOrNull(vm?.cpuCount);
  const m = numOrNull(vm?.memMB);
  if (c == null && m == null) return null;
  return (c ?? 0) * 1e8 + (m ?? 0);
}

/* ── 선택 반영 중(직전 응답을 흐리게 보일 때) ─────────────────────── */

/**
 * 지금 그릴 응답과 그것이 **지금 조건의 응답인지**.
 *  - last: 응답이 도착한 렌더에서 기록한 { data, baseKey, fKey }(Vms 의 lastRef). baseKey = 필터·GPU, fKey = 패널 선택.
 *  - pendingSel: 필터·GPU 는 같고 패널 선택만 바뀌어 새 응답을 기다리는 동안 — 직전 응답(last.data)을 흐리게 보인다.
 *  - current: view 가 지금 조건(baseKey·fKey)으로 받은 응답이다. 아니면(흐림 중 · 선택을 바꾼 직후 usePolling 이 아직
 *    옛 응답을 들고 있는 한 렌더) 그 응답의 **다음 페이지 커서와 칩 개수를 지금 조건에 쓰지 않는다** — 옛 커서를 새
 *    선택에 붙이면 서버가 400 cursor-query-mismatch 로 거절하고 화면은 '페이지 정보를 읽지 못해 첫 페이지로' 라는 틀린
 *    원인을 말했다(W-R1·C-01). 옛 분포로 칩 개수를 세면 칩끼리·머리 알약과 어긋난 숫자가 나란히 보였다(W-R4).
 */
export function selectionView({ data, loading, last, baseKey, fKey } = {}) {
  const l = last && typeof last === 'object' ? last : null;
  const pendingSel = !data && !!loading && !!l && l.baseKey === baseKey && l.fKey !== fKey;
  const view = data || (pendingSel ? l.data : null);
  const current = !!view && !!l && l.data === view && l.baseKey === baseKey && l.fKey === fKey;
  return { view: view || null, pendingSel, current };
}

/** 좁은 화면 기준(시안 MobileC) — 이 폭 미만이면 표 대신 2줄 목록. */
export const NARROW_QUERY = '(max-width: 719.98px)';
