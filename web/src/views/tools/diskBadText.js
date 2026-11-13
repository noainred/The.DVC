/**
 * diskBadText.js — 디스크 배드 섹터 분석 화면의 문구 · 색 판정(순수, v3.8.0). vitest 로 고정한다.
 *
 * 판정(아직 사용 중 · 교체됨 · 판단 불가 · 근거)은 서버(`server/src/diskbad/verdict.js`)가 하고 라벨도 서버가 내려준다.
 * 여기서는 **보여 주는 방법**만 정한다 — 값이 없으면 '—'(단위를 붙이지 않는다), 못 읽음은 0 이 아니다.
 */

const p2 = (n) => String(n).padStart(2, '0');

/** 날짜(브라우저 시간대). 값이 없으면 '—'. */
export function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function fmtDateTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${fmtDate(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 'n년 m개월' · 'n개월' · 'n일'. 값이 없으면 '—'. */
export function spanText(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return '—';
  const days = Math.floor((toMs - fromMs) / 86_400_000);
  if (days < 62) return `${days}일`;
  const months = Math.floor(days / 30.44);
  const y = Math.floor(months / 12); const m = months % 12;
  return y ? `${y}년${m ? ` ${m}개월` : ''}` : `${m}개월`;
}

export const num = (v) => (Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—');
export function rateText(v, digits = 1) { return Number.isFinite(v) ? v.toFixed(digits) : '—'; }
export function pctText(v) { return Number.isFinite(v) ? `${v.toFixed(2)}%` : '—'; }

/** 분류 → 배지 색(빨강 = 복구 불가 · 주황 = 고쳐 씀/옮김/표 참 · 파랑 = 고장 예측 · 회색 = 그 밖). */
export function clsTone(cls) {
  if (cls === 'unrecoverable') return 'red';
  if (cls === 'corrected' || cls === 'reassigned' || cls === 'remapTable') return 'amber';
  if (cls === 'predictive') return 'blue';
  return 'gray';
}
export function verdictTone(v) { return v === 'inUse' ? 'red' : v === 'replaced' ? 'gray' : 'amber'; }
export function confidenceTone(c) { return c === 'confirmed' ? 'green' : c === 'estimated' ? 'amber' : 'gray'; }
export function statusTone(s) {
  if (s === 'records') return 'red';
  if (s === 'partial' || s === 'unwatched') return 'amber';
  if (s === 'clean') return 'gray';
  return 'gray';
}

/** 기록 ID 의 주석(근거 표에서). 없으면 ''. */
export function noteOf(code, refs) {
  const r = (refs || []).find((x) => x.id === code);
  return r ? r.note : '';
}
export function clsOfCode(code, refs) {
  const r = (refs || []).find((x) => x.id === code);
  return r ? r.cls : (/^(PDR|VDR)/.test(String(code || '')) ? 'other' : '');
}

/**
 * 서버 상세의 판정 띠. 못 읽음 · 일부만 읽음은 판정하지 않는다 — '기록 없음' 은 '발생한 적 없음' 이 아니다.
 * @returns {{tone:string, title:string, lines:string[]}}
 */
export function serverBand(view, now = Date.now()) {
  if (!view) return { tone: 'neutral', title: '아직 조회하지 않았습니다', lines: ['Lifecycle 로그 전체를 읽는 작업이라 탭을 열 때 자동으로 돌지 않습니다. 점검을 누르면 이 서버를 맡은 노드(법인 엣지 또는 중앙)가 읽어 옵니다.'] };
  const cov = view.coverage || {};
  const from = cov.coveredFrom ?? cov.continuousSince;
  const span = Number.isFinite(from) ? `${fmtDate(from)} ~ ${fmtDate(now)} (${spanText(from, now)})` : '구간 모름';
  if (view.status === 'unread') {
    return { tone: 'err', title: cov.lastStatusLabel ? `읽지 못했습니다 — ${cov.lastStatusLabel}` : '아직 읽지 못했습니다', lines: ['배드 섹터 유무는 판정하지 않았습니다.', ...(cov.lastReason ? [cov.lastReason] : [])] };
  }
  if (view.status === 'records') {
    const c = view.counts || {};
    return { tone: 'bad', title: `배드 섹터 기록이 있습니다 — ${c.records}건 · 디스크 자리 ${c.slots}곳`, lines: [
      `아직 사용 중 ${c.inUse} · 교체됨 ${c.replaced} · 판단 불가 ${c.unknown}`, `로그가 남아 있는 구간 ${span}`] };
  }
  if (view.status === 'unwatched') return { tone: 'warn', title: '이 방법으로는 볼 수 없는 서버입니다', lines: ['디스크가 RAID 로 묶여 있지 않아(HBA · 패스스루) Patrol Read 가 돌지 않습니다 — ‘기록 없음’ 이 아닙니다.'] };
  if (view.status === 'partial') return { tone: 'warn', title: '일부만 읽었습니다 — 읽은 구간에는 기록이 없습니다', lines: [`읽은 구간 ${span}. 다음 점검에서 처음부터 다시 읽습니다.`] };
  const short = Number.isFinite(from) && now - from < 120 * 86_400_000;
  return { tone: short ? 'warn' : 'neutral', title: short ? `기록은 없지만, 로그가 ${spanText(from, now)}치뿐입니다` : '남아 있는 로그에는 배드 섹터 기록이 없습니다',
    lines: [`${span} · 그 이전은 로그가 없어 확인할 수 없습니다. ‘발생한 적 없음’ 이 아니라 ‘이 구간에 기록 없음’ 입니다.`] };
}

export const JOB_STATE_LABEL = Object.freeze({
  queued: '엣지 대기', running: '읽는 중', done: '끝남', failed: '실패', 'not-started': '시작 못 함', 'no-response': '응답 없음', stopped: '중단됨', busy: '다른 점검 진행 중',
});
export function jobStateTone(s) {
  if (s === 'done') return 'green';
  if (s === 'running' || s === 'queued') return 'blue';
  if (s === 'failed' || s === 'not-started' || s === 'no-response') return 'red';
  return 'gray';
}
export function unitProgress(u) {
  const total = Number.isFinite(u?.total) ? u.total : null;
  const done = Number.isFinite(u?.done) ? u.done : 0;
  return { done, total, pct: total ? Math.min(100, Math.round((done / total) * 100)) : null, text: `${done} / ${total ?? '?'}` };
}
export function scopeLabel(job) {
  if (!job) return '';
  if (job.scope === 'all') return '전체';
  if (job.scope === 'corp') return `법인 · ${job.targetLabel || job.target}`;
  return `서버 · ${job.targetLabel || job.target}`;
}

export const STATUS_REASON_LABEL = Object.freeze({ never: '아직 점검하지 않음' });
