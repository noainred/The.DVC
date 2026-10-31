/**
 * Bareos 진행 현황판의 판정·문구(v2.833 · 순수 — BareosLiveTab.jsx 가 쓴다).
 * 값은 GET /api/tools/bareos-backup/live(서버 routes/api/bareosLive.js · bareos/liveStatus.js).
 * 규칙: 못 읽은 값은 '모름'(0 이 아니다) · 실행이 없으면 '—' · 크기는 decBytesText(10진 · 앞 4자리 버림 — Bareos 보고서와 같은 숫자) · 문구에 백틱 금지.
 */
import { decBytesText } from './bareosText.js';

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

/** 속도(바이트/초) → '168.0 MB/s' — 모르면 '모름'. */
export function rateText(bps) {
  if (!isFin(bps) || bps < 0) return '모름';
  return `${decBytesText(bps)}/s`;
}
/** 크기 — 모르면 '—'. */
export const sizeText = (b) => (isFin(b) && b >= 0 ? decBytesText(b) : '—');
/** VM 용량(GB) → 바이트(추정 진척의 분모 · 인벤토리 storageGB 는 GiB 단위로 본다). */
export const gbBytes = (gb) => (isFin(gb) && gb > 0 ? gb * 1024 ** 3 : null);
/** 경과 — '1시간 12분' · '6분' · '40초'. 모르면 '—'. */
export function elapsedText(ms) {
  if (!isFin(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
/** 추정 진척(읽은 양 / VM 용량) — 0~100 정수, 모르면 null. Incremental 은 바뀐 블록만 읽어 용량보다 훨씬 작게 끝난다(화면이 밝힌다). */
export function progressPct(bytes, sizeGb) {
  const den = gbBytes(sizeGb);
  if (!isFin(bytes) || bytes < 0 || den === null) return null;
  return Math.min(100, Math.floor((bytes / den) * 100));
}

/** 상태 조회 실패 코드 → 문구(원문은 서버가 주지 않는다). */
const LIVE_CODE_TEXT = {
  timeout: '시한 초과(응답 느림)', aborted: '시한 초과(응답 느림)', jsonrpc: 'Director 가 거부(콘솔 권한 · FD 이름 확인)',
  'auth-stopped': '인증 실패로 주기 조회 정지', auth: '인증 실패', connect: '접속 실패', tls: 'TLS 협상 실패', 'not-configured': 'Director 접속값 없음',
  'no-client': '법인 FD 미설정', 'edge-relay': '엣지 대행 실패', unknown: '결과 모름(엣지 회신 없음)', skipped: '건너뜀',
};
export const liveCodeText = (code) => LIVE_CODE_TEXT[code] || '상태 조회 실패';

/**
 * 법인 카드의 표지 — 실행 없음 · 조회 전 · 조회 실패 · 느림 · 정상.
 * @returns {{ key: string, text: string, tone: 'ok'|'warn'|'bad'|'run'|'muted' }}
 */
export function corpBadge(c) {
  if (!c) return { key: 'none', text: '—', tone: 'muted' };
  if (!(c.running > 0) && !(c.waiting > 0)) return { key: 'idle', text: '실행 없음', tone: 'muted' };
  if (!c.live) return { key: 'pending', text: '조회 전', tone: 'muted' };
  if (!c.live.ok) return { key: 'fail', text: '조회 실패', tone: 'bad' };
  if (c.slow > 0) return { key: 'slow', text: `느림 ${c.slow}`, tone: 'warn' };
  if (!(c.running > 0)) return { key: 'wait', text: '대기만', tone: 'run' };
  return { key: 'ok', text: '정상', tone: 'ok' };
}

/** 법인 거르기 — 실행 중(대기 포함) · 느림 · 조회 실패 · 전체. */
export const CORP_FILTERS = Object.freeze([['active', '실행 중'], ['slow', '느림'], ['fail', '조회 실패'], ['all', '전체']]);
export function corpMatches(c, f) {
  const b = corpBadge(c).key;
  switch (f) {
    case 'active': return c.running > 0 || c.waiting > 0;
    case 'slow': return b === 'slow';
    case 'fail': return b === 'fail';
    default: return true;
  }
}
export function corpFilterCounts(corps) {
  const out = {};
  for (const [k] of CORP_FILTERS) out[k] = (Array.isArray(corps) ? corps : []).filter((c) => corpMatches(c, k)).length;
  return out;
}
/** 카드 순서 — 실행 중이 앞, 그 안에서 지금 속도가 큰 순(모름은 뒤), 그다음 이름. */
export function sortCorps(corps) {
  return [...(Array.isArray(corps) ? corps : [])].sort((a, b) => {
    const ra = (a.running || 0) + (a.waiting || 0) > 0 ? 0 : 1; const rb = (b.running || 0) + (b.waiting || 0) > 0 ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const va = isFin(a.rateNow) ? a.rateNow : -1; const vb = isFin(b.rateNow) ? b.rateNow : -1;
    if (va !== vb) return vb - va;
    return String(a.vcName || '').localeCompare(String(b.vcName || ''));
  });
}

/**
 * 흐름(최근 점들) → SVG polyline points. 모르는 점(null)은 선을 끊는다 — 조각마다 한 줄. 점이 2개 미만이면 [].
 * @param {[number, number|null][]} hist  [[at, rate]]
 * @returns {string[]} 조각별 points 문자열
 */
export function sparkSegments(hist, w = 150, h = 40, pad = 3) {
  const pts = (Array.isArray(hist) ? hist : []).filter((p) => Array.isArray(p) && isFin(p[0]));
  if (pts.length < 2) return [];
  const t0 = pts[0][0]; const t1 = pts[pts.length - 1][0];
  const max = Math.max(1, ...pts.map((p) => (isFin(p[1]) ? p[1] : 0)));
  const x = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : 0);
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const segs = []; let cur = [];
  for (const [t, v] of pts) {
    if (!isFin(v)) { if (cur.length >= 2) segs.push(cur.join(' ')); cur = []; continue; }
    cur.push(`${x(t).toFixed(1)},${y(v).toFixed(1)}`);
  }
  if (cur.length >= 2) segs.push(cur.join(' '));
  return segs;
}

/**
 * 전체 흐름 — 법인별 점을 시각 칸(slotMs)으로 모아 더한다. 한 칸에 모르는 법인이 있으면 그 칸은 '부분 합'(partial).
 * 부분 합은 0 이나 완전한 값처럼 보이지 않게 따로 표시한다(루트 CLAUDE.md — 부분 합을 추이에 섞지 않는다).
 * @returns {{ at: number, rate: number|null, partial: boolean }[]}
 */
export function totalHist(corps, slotMs = 30_000) {
  const slots = new Map();
  for (const c of Array.isArray(corps) ? corps : []) {
    for (const p of c.hist || []) {
      if (!Array.isArray(p) || !isFin(p[0])) continue;
      const k = Math.round(p[0] / slotMs);
      const s = slots.get(k) || { at: k * slotMs, sum: 0, known: 0, unknown: 0 };
      if (isFin(p[1])) { s.sum += p[1]; s.known += 1; } else s.unknown += 1;
      slots.set(k, s);
    }
  }
  return [...slots.values()].sort((a, b) => a.at - b.at).map((s) => ({ at: s.at, rate: s.unknown ? null : s.sum, partial: s.unknown > 0 && s.known > 0 }));
}

/** 느린 잡 목록(전체 법인) — 지금 속도 ÷ 지난 성공 평균이 작은 순. */
export function slowRows(corps) {
  const out = [];
  for (const c of Array.isArray(corps) ? corps : []) for (const r of c.rows || []) if (r.slow) out.push({ ...r, corp: c.vcName, ratio: isFin(r.rateNow) && isFin(r.baseline) && r.baseline > 0 ? r.rateNow / r.baseline : null });
  return out.sort((a, b) => (a.ratio ?? 1) - (b.ratio ?? 1));
}

/** 레벨 한 글자 → 낱말. */
export const levelWord = (l) => ({ F: 'Full', I: 'Incremental', D: 'Differential', Full: 'Full', Incremental: 'Incremental', Differential: 'Differential' }[l] || (l ? String(l) : '—'));
/** 실행 주체 — 그룹 예약 · 그룹 · 수동 · Bareos 스케줄. */
export const triggerText = (r) => ({ 'group-schedule': '그룹 예약', group: '그룹 실행', schedule: 'Bareos 스케줄', manual: '수동' }[r?.trigger] || (r?.by ? '수동' : '—'));
export const STATE_TEXT = Object.freeze({ running: '실행 중', queued: '대기', waiting: '대기' });
