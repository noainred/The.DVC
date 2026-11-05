/**
 * views/vms/vmHubText.js — 가상화 서버 허브(v2.909 · 시안 docs/design/vm-screen 시안 1)의 글자·판정 보조(순수 — vitest 고정).
 *
 * 판정은 서버가 한다(inventory/vmSignals.js · vmByVcenter.js) — 여기서는 **이름·문구·배치**만 정한다.
 *  · 신호 키 SIGNAL_ORDER 는 서버 SIGNAL_KEYS 와 같다(테스트가 서버 파일과 대조).
 *  · 못 읽은 값은 '—' 이고 단위를 붙이지 않는다(numOrNull). 숫자를 문장에 박지 않는다 — 기준 일수(snapAgeDays)는 응답 값.
 *  · 도구 탭은 도구 키(#/tools/<k>)로 간다 — 키는 바꾸지 않는다(권한 파일의 값). 이름만 여기서 짧게 붙인다.
 */
import { numOrNull } from '../../numOrNull.js';

export const HUB_VIEWS = Object.freeze([['list', '현황'], ['corp', '법인별'], ['attention', '조치 필요']]);
export const HUB_VIEW_KEYS = Object.freeze(HUB_VIEWS.map(([k]) => k));
/** 허브 탭 줄 오른쪽의 기존 도구(특수 기능) — [도구 키, 짧은 이름]. 순서 = 탭 순서. */
export const HUB_TOOLS = Object.freeze([
  ['vmfinder', 'VM 정밀 검색'], ['guestos', 'Guest OS'], ['vmtools', 'VMware Tools'],
  ['vm-track', '수량 추이'], ['curuser', '현재 사용자'], ['real-os', '실제 OS 확인'],
]);
export const HUB_TOOL_KEYS = Object.freeze(HUB_TOOLS.map(([k]) => k));

export const SIGNAL_ORDER = Object.freeze(['overload', 'usageUnknown', 'toolsOld', 'snapOld']);
const SIG = Object.freeze({
  overload: { label: '과부하', tone: 'crit', badge: 'red', desc: '구동 VM 중 CPU 또는 메모리 사용률 90% 이상 — 분포 패널의 90%↑ 와 같은 판정입니다.' },
  usageUnknown: { label: '사용률 미수집', tone: 'none', badge: 'gray', desc: '구동 중인데 CPU·메모리 사용률을 읽지 못했습니다 — 평균에서 빠져 있고 과부하로 세지 않습니다.' },
  toolsOld: { label: 'VMware Tools 업그레이드 필요', tone: 'warn', badge: 'amber', desc: 'Tools 버전 상태가 업그레이드 필요 · 너무 오래됨 · 차단 판입니다. 업그레이드는 ‘VMware Tools’ 도구에서 합니다.' },
  snapOld: { label: '오래된 스냅샷', tone: 'warn', badge: 'amber', desc: '가장 오래된 스냅샷이 기준 일수를 넘었습니다. 기준과 예외 목록은 ‘VM 구성 점검’ 설정을 따릅니다.' },
});

/** 신호 이름(표 배지용 짧은 이름 포함). days = 스냅샷 기준 일수(응답 값 — 없으면 '오래됨'). */
export function signalText(key, { days = null } = {}) {
  const s = SIG[key];
  if (!s) return { label: String(key), short: String(key), tone: 'none', badge: 'gray', desc: '' };
  const d = numOrNull(days);
  const short = key === 'overload' ? 'CPU·메모리 90%↑'
    : key === 'usageUnknown' ? '사용률 미수집'
      : key === 'toolsOld' ? 'Tools 구버전'
        : (d != null ? `스냅샷 ${d}일↑` : '스냅샷 오래됨');
  return { ...s, short };
}

export const fmtN = (v) => { const n = numOrNull(v); return n == null ? '—' : n.toLocaleString('en-US'); };
export const pctText = (v) => { const n = numOrNull(v); return n == null ? '—' : `${n}%`; };
/** 사용률 색 — 90 이상 위험 · 75 이상 주의(분포 패널의 75%↑·90%↑ 와 같은 경계). 못 읽으면 none.
 *  (현황 탭 타일 5장 = 예전 KPI 8장의 값을 묶은 것 — 값 글자는 Vms.jsx 가 unitText 로 그린다(못 읽으면 '—' · v2.629 고정 테스트).) */
export function usageTone(v) {
  const n = numOrNull(v);
  if (n == null || n < 0) return 'none';
  return n >= 90 ? 'crit' : n >= 75 ? 'warn' : 'ok';
}

export const TONE_COLOR = Object.freeze({ ok: 'var(--accent)', warn: 'var(--amber)', crit: 'var(--red)', none: 'var(--text-faint)' });
export const TONE_TEXT = Object.freeze({ ok: 'var(--text)', warn: '#fcd34d', crit: '#fca5a5', none: 'var(--text-dim)' });

/** 조치 필요 탭의 신호 카드 — 개수가 없으면(응답 전) null. */
export function attentionCards(sc) {
  return SIGNAL_ORDER.map((k) => ({ key: k, ...signalText(k, { days: sc?.snapAgeDays }), count: sc ? numOrNull(sc[k]) : null }));
}

/** 목록에서 지금 VM 의 앞·뒤(드로어 ‹ › · ↑↓). 목록에 없으면 둘 다 null. */
export function neighborOf(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const i = list.findIndex((r) => r && r.id === id);
  if (i < 0) return { prev: null, next: null, index: -1, total: list.length };
  return { prev: list[i - 1] || null, next: list[i + 1] || null, index: i, total: list.length };
}

/**
 * 스파크라인 path — points=[{t,v}] (v null 은 끊김 — 잇지 않는다). 값 범위는 0~max(100 고정이 아니면 최대값).
 * 점이 2개 미만이면 null('—' — 지어내지 않는다).
 */
export function sparkPath(points, { w = 100, h = 26, max = null } = {}) {
  const pts = (Array.isArray(points) ? points : []).map((p) => numOrNull(p?.v));
  const vals = pts.filter((v) => v != null);
  if (vals.length < 2) return null;
  const top = max != null ? max : Math.max(...vals, 1);
  const step = pts.length > 1 ? w / (pts.length - 1) : w;
  let d = '';
  let pen = false;
  pts.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const x = Math.round(i * step * 10) / 10;
    const y = Math.round((h - (Math.max(0, Math.min(top, v)) / top) * (h - 2) - 1) * 10) / 10;
    d += `${pen ? 'L' : 'M'}${x},${y} `;
    pen = true;
  });
  return d.trim();
}
/** 값이 있는 점 중 최대값(없으면 null). */
export function peakOf(points) {
  const vals = (Array.isArray(points) ? points : []).map((p) => numOrNull(p?.v)).filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}

/** 법인별 표 VM 열 정렬 키(STable data-sort) — 모르는 값은 ''(방향과 무관하게 뒤 · 표지값 -1 금지 WEB2631-04). */
export const corpVmsSort = (c) => (numOrNull(c?.vms) == null ? '' : c.vms);
/** 막대 폭(0~100) — 못 읽은 값은 0 폭(글자는 따로 '—'). 글자에 쓰지 말 것(단위 붙인 날값 금지 — v2.629). */
export const barW = (v) => { const n = numOrNull(v); return n == null ? 0 : Math.max(0, Math.min(100, n)); };
/** 법인 한 줄의 '수집' 칸 글자. */
export function corpCollectText(c, now = Date.now()) {
  const base = c?.collect === 'site' ? '엣지' : '직접';
  const at = numOrNull(c?.receivedAt);
  if (c?.collect !== 'site' || at == null) return base;
  const min = Math.max(0, Math.round((now - at) / 60_000));
  return `${base} · ${min < 60 ? `${min}분 전` : `${Math.round(min / 60)}시간 전`}`;
}
