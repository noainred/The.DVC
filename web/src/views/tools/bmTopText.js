/**
 * views/tools/bmTopText.js — 리눅스 성능 8b단계 **프로세스 Top-N** 문구 · 표시 도우미(순수 — vitest node 환경).
 * ⚠ 판정 복제 금지: 프로파일 단서(hint) · 지속 · PID 재사용 · ‘변화 없음’ 은 서버(topStore · parse/linuxTop.js procHint)가 정한 값을 문장으로 바꾸기만 한다.
 * ⚠ 못 읽음은 0 이 아니다: 권한 없는 I/O 는 ‘권한’ · 값 없음은 ‘—’(단위를 붙이지 않는다) · 그 시각 표본이 없으면 ‘표본 없음’(0 으로 그리지 않는다).
 */
import { fmtBytes } from '../../util/fmt.js';

export const TOP_KINDS = Object.freeze([
  { k: 'cpu', label: 'CPU', valLabel: 'CPU %(1초)' },
  { k: 'mem', label: '메모리', valLabel: 'RSS' },
  { k: 'io', label: 'I/O', valLabel: '읽기 + 쓰기' },
]);
export const HINT_TEXT = Object.freeze({
  gpdb: 'GPDB(postgres + gpadmin)',
  airflow: 'Airflow',
  kswapd: '커널 · 메모리 압박 신호(교차 판정 ③)',
  sshd: '수집 세션 자신 포함 가능',
  kernel: '커널 스레드',
});
export const STATE_TEXT = Object.freeze({ R: '실행 중', S: '대기(잠듦)', D: '디스크 대기(끊을 수 없음)', Z: '좀비', T: '정지', t: '추적 정지', I: '유휴 커널 스레드', X: '종료' });
export const SRC_TEXT = Object.freeze({ top: 'top 둘째 프레임(1초 구간)', proc: '/proc 2회 차이(1초 · top 없음)' });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const cpuText = (v) => (num(v) == null ? '—' : num(v).toFixed(1));
export const rssText = (kb) => (num(kb) == null ? '—' : fmtBytes(num(kb) * 1024));
export function rateText(bps) {
  const v = num(bps);
  if (v == null) return '—';
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB/s`;
  return `${Math.round(v)} B/s`;
}
/** 누적 CPU 초 → ‘4h12m’ · ‘3m’ · ‘12s’. */
export function cpuTimeText(s) {
  const v = num(s);
  if (v == null) return '—';
  if (v >= 86_400) return `${Math.floor(v / 86_400)}d${Math.floor((v % 86_400) / 3600)}h`;
  if (v >= 3600) return `${Math.floor(v / 3600)}h${String(Math.floor((v % 3600) / 60)).padStart(2, '0')}m`;
  if (v >= 60) return `${Math.floor(v / 60)}m`;
  return `${Math.round(v)}s`;
}
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const mdhm = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm(ms)}`; };
export const whenText = (ms) => (num(ms) == null ? '—' : mdhm(ms));
/** 값 칸 — 종류별. */
export function valText(kind, r) {
  if (kind === 'cpu') return cpuText(r?.val);
  if (kind === 'mem') return rssText(r?.val);
  if (r?.ioPerm) return '권한';
  return rateText(r?.val);
}
/** 프로파일 열(서버 단서 code → 문장) · 지속 · 재사용. */
export function hintText(r) {
  const parts = [];
  if (r?.hint && HINT_TEXT[r.hint]) parts.push(HINT_TEXT[r.hint]);
  if (r?.pidReused) parts.push('PID 재사용(시작 시각이 다르다 — 다른 프로세스)');
  else if (r?.cont === true) parts.push('지속');
  return parts.join(' · ') || '—';
}
/** 표 위 안내(순수) — 표본 · 기준 표본 · 출처 · 권한 없는 I/O. */
export function sampleNotes(resp) {
  if (!resp) return [];
  if (resp.ok === false) return [String(resp.reason || '프로세스 표를 읽지 못했습니다.')];
  if (!resp.sample) return ['이 시각 가까이에 프로세스 표본이 없습니다 — 수집하지 못했거나(SSH 실패 · 정비 창) 이 기능을 켜기 전입니다(0 으로 그리지 않습니다).'];
  const s = resp.sample; const out = [];
  out.push(`표본 ${whenText(s.ts)} · ${SRC_TEXT[s.src] || '출처 모름'}${s.dtS != null ? ` · 측정 구간 ${s.dtS}초` : ''}`);
  if (s.same) out.push(`이 주기는 상위 집합 · 값이 ${whenText(s.baseTs)} 표본과 같아(CPU ±5%p · RSS · I/O ±5%) 그 표본의 행을 보여 줍니다(저장은 머리 1행).`);
  if (num(s.ioPerm)) out.push(`I/O 를 읽지 못한 프로세스 ${s.ioPerm}개 — /proc/<pid>/io 는 같은 사용자 또는 CAP_SYS_PTRACE 가 필요합니다(‘권한’ 칸 · 0 으로 적지 않습니다).`);
  return out;
}
/** 바닥 줄(순수) — 나머지 합계(전 프로세스 합 − 보인 상위 · 0 아래로 내리지 않는다) · 프로세스 수 · R · D. */
export function footText(resp) {
  const s = resp?.sample;
  if (!s) return '';
  const shown = (resp.rows?.cpu || []).reduce((a, r) => a + (num(r.val) || 0), 0);
  const rest = num(s.cpuTotal) == null ? null : Math.max(0, Math.round((s.cpuTotal - shown) * 10) / 10);
  return [`나머지 합계 CPU ${rest == null ? '—' : `${rest}%`}`, `프로세스 수 ${s.nproc ?? '—'}`, `실행 중(R) ${s.nrun ?? '—'}`, `D(디스크 대기) ${s.nd ?? '—'}`].join(' · ');
}
export const TOP_HONEST = 'CPU % 는 **1초 구간 값**(수명 평균 아님 · 코어 하나 = 100%) · RSS 는 공유 페이지가 프로세스마다 중복 계산돼 합이 실제보다 큽니다(PSS 아님) · **명령 이름(comm)만** 읽습니다(인자 · 환경 없음) · 컨테이너 이름은 알 수 없습니다(호스트 PID) · 읽기 전용(kill 없음).';

/* ── 띠(시간 × 프로세스) ── */
export const BAND_COLORS = Object.freeze(['var(--accent-2)', 'var(--amber)', 'var(--green)', 'var(--red)', 'var(--text-dim)']);
export const OTHER_COLOR = 'var(--text-faint)';
/**
 * 띠 그리기 좌표(순수) — 점마다 comm 순서대로 누적 막대(0~yMax). yMax = 점 합계의 최대(100 미만이면 100 — 코어 하나 기준 · 다중 코어면 100 을 넘는다).
 * @returns {{yMax:number, bars:Array<{x:number, w:number, segs:Array<{c:string, y0:number, y1:number, color:string, v:number}>}>}}
 */
export function bandLayout(band, { width = 1000 } = {}) {
  const pts = Array.isArray(band?.points) ? band.points : [];
  const comms = Array.isArray(band?.comms) ? band.comms : [];
  if (!pts.length) return { yMax: 100, bars: [] };
  const from = num(band.from) ?? pts[0].t; const to = num(band.to) ?? pts[pts.length - 1].t;
  const span = Math.max(1, to - from);
  const step = band.res === '1h' ? 3_600_000 : 300_000;
  const tot = (p) => comms.reduce((a, c) => a + (num(p.by?.[c]) || 0), 0) + (num(p.other) || 0);
  const yMax = Math.max(100, ...pts.map(tot));
  const w = Math.max(1, (step / span) * width * 0.9);
  const bars = pts.map((p) => {
    let y = 0; const segs = [];
    comms.forEach((c, i) => { const v = num(p.by?.[c]) || 0; if (v > 0) { segs.push({ c, y0: y, y1: y + v, color: BAND_COLORS[i % BAND_COLORS.length], v }); y += v; } });
    const o = num(p.other) || 0;
    if (o > 0) segs.push({ c: '기타 상위', y0: y, y1: y + o, color: OTHER_COLOR, v: o });
    return { t: p.t, x: ((p.t - from) / span) * width, w, segs };
  });
  return { yMax, bars };
}
export function bandNotes(band) {
  if (!band) return [];
  if (band.ok === false) return [String(band.reason || '띠를 읽지 못했습니다.')];
  const out = [band.res === '1h' ? '1시간 칸 — comm 별 CPU 초 합 ÷ 1시간(직전 주기에도 후보였던 같은 프로세스만 — 하한)' : '5분 표본 — CPU 상위 5(같은 이름 PID 여러 개는 합산)'];
  if (num(band.approx)) out.push(`변화 없는 표본 ${band.approx}개는 기준 표본 값으로 그렸습니다(±5%p).`);
  if (!(band.points || []).length) out.push('이 구간에 프로세스 표본이 없습니다(0 으로 그리지 않습니다).');
  return out;
}
