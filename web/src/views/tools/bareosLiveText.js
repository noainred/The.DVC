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
  if (c.stuck > 0) return { key: 'stuck', text: `멈춤 의심 ${c.stuck}`, tone: 'warn' };   // v2.833.1 — FD 조회는 됐고 3시간 넘게 진행 보고 없음
  if (!c.live.ok) return { key: 'fail', text: '조회 실패', tone: 'bad' };
  if (c.slow > 0) return { key: 'slow', text: `느림 ${c.slow}`, tone: 'warn' };
  if (!(c.running > 0)) return { key: 'wait', text: '대기만', tone: 'run' };
  return { key: 'ok', text: '정상', tone: 'ok' };
}

/** 법인 거르기 — 실행 중(대기 포함) · 느림 · 조회 실패 · 전체. */
export const CORP_FILTERS = Object.freeze([['active', '실행 중'], ['stuck', '멈춤 의심'], ['slow', '느림'], ['fail', '조회 실패'], ['all', '전체']]);
export function corpMatches(c, f) {
  const b = corpBadge(c).key;
  switch (f) {
    case 'active': return c.running > 0 || c.waiting > 0;
    case 'stuck': return c.stuck > 0;
    case 'slow': return b === 'slow' || (c.slow > 0 && b === 'stuck');
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

/* ── v2.833.1 Director 상태 문구 · 멈춤 의심 ── */
/** Director 상태 사유 키(서버 liveParse.dirReasonOf) → 우리말. */
export const DIR_REASON_TEXT = Object.freeze({
  running: '실행 중', mount: '마운트 대기', volume: '볼륨 대기', maxjobs: '동시 실행 상한', storage: '스토리지 대기', client: 'FD 대기',
  priority: '우선순위 대기', starttime: '시작 시각 대기', created: '실행 대기', blocked: '막힘', done: '끝남(반영 전)', other: '기타', unknown: '사유 모름',
});
export const reasonText = (k) => DIR_REASON_TEXT[k] || DIR_REASON_TEXT.other;
/** 사유별 도움말 — 사람이 볼 곳(설정 지시어 이름은 Bareos 문서 기준). */
export const REASON_HINT = Object.freeze({
  maxjobs: 'Client·Storage·Job 의 Maximum Concurrent Jobs 를 확인하세요',
  mount: 'SD 에서 볼륨 마운트를 기다립니다 — Storage 장치·볼륨 상태를 확인하세요',
  volume: '쓸 수 있는 볼륨이 없습니다 — 풀의 볼륨·라벨·보존 기간을 확인하세요',
  storage: 'SD 접속·장치를 확인하세요',
  client: 'FD 접속(방화벽·FD 서비스)을 확인하세요',
  unknown: 'Director 상태에 없는 대기(조회 실패 · 막 보냄)',
});
/** 멈춤 의심 까닭(서버 runningRow.stuck). */
export const STUCK_TEXT = Object.freeze({ 'no-report': '3시간 넘게 FD 진행 보고 없음', zero: '3시간 넘게 속도 0' });
/** 대기 행 — 오래 기다린 순(보낸 시각 오름차순 · 모르면 뒤). */
export const sortWaiting = (rows) => [...(Array.isArray(rows) ? rows : [])].sort((a, b) => (isFin(a.since) ? a.since : Infinity) - (isFin(b.since) ? b.since : Infinity));

/* ── v2.858 실행 중 작업 상세(사용자 승인 시안 — 진행 현황 행 펼침 · 실행 현황 · 이력 표) ── */
/** 레벨 글자(F·I·D·V) — 'Full'·'F' 를 한 모양으로(서버 bareosLive.levelKey 와 같은 판정). 모르면 ''. */
export const levelKey = (v) => { const c = String(v ?? '').trim().charAt(0).toUpperCase(); return c && 'FIDV'.includes(c) ? c : ''; };

/**
 * 추정 진척의 기준 — ① 지난 같은 레벨 성공 실행의 바이트(서버 prev) ② 없으면 Full 만 VM 용량 ③ 그 밖은 기준 없음(Incremental 을 VM 용량으로 나누면 2% 처럼 뜻 없는 값이 된다).
 * @returns {{ kind: 'prev'|'size'|null, basis: number|null, pct: number|null, over: boolean, label: string, short: string }}
 *   pct = 0~100 정수(진행량이 기준을 넘으면 100 · over) · 진행량을 모르면 null.
 */
export function progressBasis(r) {
  const bytes = isFin(r?.bytes) && r.bytes >= 0 ? r.bytes : null;
  const prevB = isFin(r?.prev?.bytes) && r.prev.bytes > 0 ? r.prev.bytes : null;
  const lv = levelKey(r?.level);
  let kind = null; let basis = null; let label; let short;
  if (prevB !== null) {
    kind = 'prev'; basis = prevB;
    label = `지난 ${levelWord(r.prev.level || lv)}(jobid ${r.prev.jobid}) ${sizeText(prevB)} 기준`;
    short = `지난 ${sizeText(prevB)}`;
  } else if (lv === 'F' && gbBytes(r?.sizeGb) !== null) {
    kind = 'size'; basis = gbBytes(r.sizeGb);
    label = `VM 용량 ${sizeText(basis)} 기준(지난 Full 기록 없음)`;
    short = `VM ${sizeText(basis)}`;
  } else {
    label = lv && lv !== 'F' ? `지난 ${levelWord(lv)} 기록이 없어 진척을 계산하지 않음` : '기준을 몰라 진척을 계산하지 않음';
    short = gbBytes(r?.sizeGb) !== null ? `VM ${sizeText(gbBytes(r.sizeGb))}` : '기준 모름';
  }
  const pct = bytes !== null && basis !== null ? Math.min(100, Math.floor((bytes / basis) * 100)) : null;
  return { kind, basis, pct, over: bytes !== null && basis !== null && bytes > basis, label, short };
}

/** 남은 시간(초 · 추정) — (기준 − 진행량) ÷ 지금 속도. 하나라도 모르거나 이미 넘었으면 null. */
export function etaSec(r, pb = progressBasis(r)) {
  if (!isFin(r?.bytes) || !isFin(r?.rateNow) || r.rateNow <= 0 || !isFin(pb?.basis) || pb.basis <= r.bytes) return null;
  return Math.round((pb.basis - r.bytes) / r.rateNow);
}

/**
 * 지금 단계 — 지금까지의 로그 단계(bareosText.jobTimeline 의 steps)로. 끝 보고가 있으면 '끝남(반영 전)'.
 * @returns {{ key: 'done'|'tail'|'data'|'prep'|'start'|'none', text: string }}
 */
export function runPhase(steps, ended = false) {
  const has = (t) => (Array.isArray(steps) ? steps : []).some((s) => s?.title === t || String(s?.title || '').startsWith(t));
  if (ended) return { key: 'done', text: '끝남 — 목록 반영 전' };
  if (has('임시 스냅샷 정리') || has('장치 해제')) return { key: 'tail', text: '정리 중' };
  if (has('데이터 백업 시작')) return { key: 'data', text: '데이터 전송 중' };
  if (has('FD 연결') || has('vSphere 접속') || has('시작')) return { key: 'prep', text: '준비 중' };
  return { key: 'none', text: '로그에 단계 없음' };
}
/** 아직 오지 않은 단계(흐린 줄) — 지금 단계 다음에 남은 것. */
export function futurePhases(key) {
  return ({ none: '시작 · 준비 · 데이터 전송 · 정리 · 종료', start: '준비 · 데이터 전송 · 정리 · 종료', prep: '데이터 전송 · 임시 스냅샷 정리 · 종료', data: '임시 스냅샷 정리 · 장치 해제 · 종료', tail: '종료' })[key] || '';
}

/** 진행 현황 응답(corps[].rows)을 '법인|jobid' 열쇠로 — 실행 현황 · 이력 표가 원장 실행 목록에 FD·Director 값을 붙인다. */
export function liveRowIndex(live) {
  const m = new Map();
  for (const c of Array.isArray(live?.corps) ? live.corps : []) {
    for (const r of Array.isArray(c.rows) ? c.rows : []) if (r?.jobid) m.set(`${c.vcenterId}|${r.jobid}`, { row: r, corp: c });
  }
  return m;
}

/**
 * 대기 사유 요약(실행 현황 · 이력 띠) — 법인들의 waitGroups 를 사유별로 합친다. 대기가 없으면 null.
 * @returns {{ waiting: number, running: number, top: { reason: string, n: number }|null, kinds: number }|null}
 */
export function waitSummary(live) {
  const corps = Array.isArray(live?.corps) ? live.corps : [];
  const by = new Map(); let waiting = 0; let running = 0;
  for (const c of corps) {
    waiting += c.waiting || 0; running += c.running || 0;
    for (const g of Array.isArray(c.waitGroups) ? c.waitGroups : []) by.set(g.reason, (by.get(g.reason) || 0) + (g.n || 0));
  }
  if (!waiting) return null;
  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  return { waiting, running, top: top ? { reason: top[0], n: top[1] } : null, kinds: by.size };
}

/**
 * 실행 현황 · 이력의 한 행 — 원장 잡(pending · lastRun)에 진행 현황 행(FD · Director 상태)을 붙인다. 진행 현황에 없으면(조회 전 · 실패) 원장 값만 —
 * 진행량 · 속도 · Director 상태는 null(모름 — 0 이 아니다).
 * @param {object} j  목록 응답의 잡 한 줄 · @param {Map} idx  liveRowIndex 결과 · @returns {{ key: string, row: object, corp: object|null }}
 */
export function runRowOf(j, idx, now = Date.now()) {
  const p = j?.pending?.jobid ? j.pending : null;
  const L = j?.lastRun || null;
  const jobid = p?.jobid || L?.jobid || null;
  const key = `${j?.vcenterId || ''}|${jobid}`;
  const hit = idx instanceof Map ? idx.get(key) : null;
  const since = isFin(p?.since) ? p.since : isFin(L?.startedAt) ? L.startedAt : null;
  const base = {
    id: j?.id || '', jobid, vmName: j?.vmName || j?.vmId || '', vcenterId: j?.vcenterId || '', directorId: j?.directorId || '',
    client: j?.client || '', pool: j?.pool || '', storage: j?.storage || '',
    status: (p ? p.status : L?.status) || '',
  };
  if (hit) return { key, row: { ...hit.row, ...base, vmName: hit.row.vmName || base.vmName }, corp: hit.corp };
  return {
    key, corp: null,
    row: {
      ...base, level: (p ? p.level : L?.level) || '', state: (p ? p.state : L?.state) || 'queued', since, elapsed: since !== null ? Math.max(0, now - since) : null,
      trigger: p ? (p.trigger || '') : 'schedule', by: p?.by || '', group: '',
      bytes: null, files: null, rateNow: null, rateAvg: null, baseline: null, dirStatus: null, prev: null, sizeGb: null,
    },
  };
}
