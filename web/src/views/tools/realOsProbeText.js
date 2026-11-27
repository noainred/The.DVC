// realOsProbeText.js — '실제 OS 수집 점검'(v3.54 · 실제 OS 1단계 실측) 화면 문구 · 숫자 표기(순수 — node 테스트).
// 판정(사유 키)은 서버 inventory/osProbe.js NO_DETAIL_REASONS 하나다 — 여기는 그 키의 글자만 소유한다(키가 같은지 테스트가 대조).

export const REASON_TEXT = Object.freeze({
  notRead: '아직 읽지 않음(수집 전 · 엣지 미업그레이드)',
  notAsked: '묻지 않음(vCenter API 8.0.2 미만 또는 판 미상)',
  unparsed: '보고는 왔으나 형식을 못 읽음',
  template: '템플릿',
  toolsOld: 'Tools 11.2 미만',
  toolsNotRunning: '켜짐 · Tools 미실행',
  poweredOff: '꺼짐 · 보고 기록 없음',
  toolsUnknown: 'Tools 판 미상',
  other: 'Tools 정상인데 보고 없음',
});

/** 수 → '1,234' · 못 읽음(null · NaN)은 '—'. */
export function n(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—';
}

/** a / b 백분율('87%') — 분모가 0 이거나 못 읽으면 '—'(0% 로 말하지 않는다). */
export function pct(a, b) {
  if (!(typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && b > 0)) return '—';
  return `${Math.round((a / b) * 100)}%`;
}

/** 시각(ms) → 'MM-DD HH:mm' · 없으면 '—'. */
export function at(ms) {
  if (!(typeof ms === 'number' && Number.isFinite(ms) && ms > 0)) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 수집 상태 칸 — 이 포탈이 직접 수집하지 않는 vCenter(엣지 수집)는 상태가 이 포탈에 없다. */
export function statusText(st) {
  if (!st) return { text: '엣지 수집(상태는 엣지에)', tone: 'muted' };
  if (st.osError) return { text: `오류 — ${String(st.osError).slice(0, 80)}`, tone: 'amber' };
  if (st.osAt == null) return { text: '아직 수집 전', tone: 'muted' };
  return { text: `${at(st.osAt)} · ${st.osAsked ? 'Tools 보고 요청' : '제품 정보만(판 미달)'}`, tone: 'ok' };
}

/** {value,count}[] → 'A 3 · B 1' (상위 몇 개). */
export function topText(list, max = 3) {
  if (!Array.isArray(list) || !list.length) return '—';
  return list.slice(0, max).map((x) => `${x.value} ${x.count}`).join(' · ');
}

/** 내려받을 파일 이름 — real-os-probe-YYYYMMDD-HHmm.json */
export function probeFileName(now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `real-os-probe-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}
