/**
 * views/tools/bmRunbookText.js — 리눅스 성능 6단계 **진단 플레이북 · 목표선(SLO)** 화면의 문구 · 좌표(순수 · vitest `bmStage6Text.test.jsx`).
 *
 * ⚠ 판정은 서버 — 판정 id · 맞는 플레이북은 `bmusage/playbooks.js`, 목표 대조(달성률 · 위반 · 상태)는 `bmusage/slo.js`. 여기는 code → 문장 · 숫자 → 글자.
 * ⚠ 명령은 복사용 글자다 — 포탈은 실행하지 않는다(화면이 그 사실을 말한다). 자리표시 채우기는 서버가 준 값(fill)만.
 * ⚠ 결측은 0 이 아니다 — 달성률이 없으면 ‘—’ · 자료 없음은 ‘자료 없음’. 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { shortStamp } from './bmOpsText.js';
import { fmtHm } from '../../components/vmperf/vmPerfText.js';
import { valText } from './bmTrendText.js';

const n = numOrNull;
export const STEP_KIND_TEXT = Object.freeze({ portal: '포탈에서 먼저 확인', command: '서버 명령(복사용 · 읽기 전용)', config: '설정 · DB 대조', hardware: '하드웨어 의심', action: '조치 후보 · 기록' });
/** 포탈에서 볼 곳(서버 상세 탭 id · 보기) → 이름. */
export const LOOK_TEXT = Object.freeze({ focus: '집중 모니터링 탭(결론 · 분별 프로세스)', trend: '추이 탭', compare: '구간 비교(어제 같은 시각)', changes: '변경 이벤트 띠', annotations: '운영 주석', faults: '장애 기록 탭', hw: '하드웨어 탭', profile: '용도 탭', ports: '추이 탭 포트 절(CVP)', summary: '요약 탭(소모품)', tuning: '튜닝 탭', snap: '진단 스냅샷 탭' });
export const RUNBOOK_HONEST = '플레이북은 판정이 ‘후보’ 로 끝난 뒤 사람이 할 다음 조사를 표준화한 것입니다. 명령은 복사용이고 **포탈은 실행하지 않습니다**(읽기 전용 명령만 싣습니다 — 쓰기 · 재시작 명령은 없습니다). 현장이 고친 단계는 위키에 덮어씁니다(포탈 판은 기본값).';
/** 판정 id → 짧은 글자. */
export function judgmentText(id) {
  const [k, v] = String(id || '').split(':');
  const head = { use: 'USE', cross: '교차', port: '포트 대조 ⑤', health: '소모품', profile: '용도 점검' }[k] || k;
  return `${head} ${v || ''}`.trim();
}
/** 자리표시 채우기(서버 fill 값만 — 서버가 화이트리스트로 거른 것). */
export function fillLine(line, fill = {}) {
  let s = String(line);
  for (const [ph, v] of Object.entries(fill || {})) if (typeof v === 'string' && v) s = s.split(ph).join(v);
  return s;
}
/** 위키 덮어쓰기 — 같은 제목의 위키 문서를 찾는 링크(없으면 새로 만들어 덮어쓴다). */
export function wikiSearchHref(title) { return `#/wiki/pub/search?q=${encodeURIComponent(String(title || '').slice(0, 120))}`; }

/* ── 목표선 ─────────────────────────────────────────────────────────── */
export const SLO_METRIC_TEXT = Object.freeze({
  cpu_pct: { label: 'CPU 사용률', unit: '%' }, mem_pct: { label: '메모리 사용률', unit: '%' }, disk_busy_pct: { label: '디스크 busy', unit: '%' }, disk_await_ms: { label: '디스크 await', unit: 'ms' },
  disk_used_pct: { label: '데이터 볼륨 공간', unit: '%' }, net_pct: { label: '네트워크 사용률', unit: '%' }, runq_per_core: { label: '런큐 ÷ 코어', unit: '' }, swap_out_ps: { label: '스왑 아웃', unit: 'pages/s' },
  psi_io_full10: { label: 'PSI io full', unit: '%' }, psi_mem_full10: { label: 'PSI memory full', unit: '%' }, tcp_retrans_pct: { label: 'TCP 재전송률', unit: '%' }, net_drop_delta: { label: 'NIC 드롭 증가', unit: '건' },
});
export const SLO_BASIS_TEXT = Object.freeze({ avg: '5분 평균', peak: '5분 피크', p95: '기간 p95' });
export const SLO_OP_TEXT = Object.freeze({ lt: '<', le: '≤', gt: '>', ge: '≥' });
export const SLO_STATUS_TEXT = Object.freeze({ met: { label: '달성', tone: 'ok' }, missed: { label: '미달', tone: 'bad' }, 'no-data': { label: '자료 없음', tone: 'idle' } });
export function sloSourceText(src) {
  if (src === 'server') return '이 서버 개별';
  if (String(src || '').startsWith('profile:')) return `용도 ${String(src).slice(8)}`;
  return '역할(기본)';
}
export function goalText(g = {}) {
  const m = SLO_METRIC_TEXT[g.metric] || { label: g.metric, unit: '' };
  return `${m.label} ${SLO_BASIS_TEXT[g.basis] || g.basis} ${SLO_OP_TEXT[g.op] || g.op} ${valText(g.value, m.unit)} · 목표 ${n(g.objectivePct) ?? '—'}%`;
}
export function hoursText(ms) { const x = n(ms); if (x == null) return '—'; const h = x / 3_600_000; return h >= 24 ? `${Math.round((h / 24) * 10) / 10}일` : `${Math.round(h * 10) / 10}시간`; }
export function longestText(l) { if (!l) return '—'; return `${shortStamp(l.from)} ~ ${fmtHm(l.to)} (${l.cycles}주기)`; }
/** 일 추이 → 막대 글자(▁~█) — 값 없는 날은 ‘·’(0 이 아니다). */
export function dailySpark(daily = []) {
  const B = '▁▂▃▄▅▆▇█';
  return (Array.isArray(daily) ? daily : []).map((d) => { const v = n(d?.pct); if (v == null) return '·'; return B[Math.min(7, Math.max(0, Math.round(((100 - v) / 100) * 7)))]; }).join('');
}
export function resNote(res) { return res === '1h' ? '창이 길어 1시간 롤업으로 셉니다(‘주기’ 대신 ‘시간’ — 5분 원시는 20일 이하 창에서만).' : '5분 주기로 셉니다.'; }
export const SLO_HONEST = '달성률 = 목표 안에 있던 주기 ÷ 값이 있는 주기(결측 주기는 분모에서 빼고 수를 적습니다). 정비 창도 분모에서 빼야 하지만 아직 원천이 없어 빼지 못합니다(8단계). p95 기준은 기간 안 주기 평균의 95번째 백분위를 목표와 대 봅니다. 목표는 설정값(관리자)이고 우선순위는 개별 > 용도 > 역할입니다.';
/** 위반 구간 → 추이 위반 띠(지표별). */
export function violationBands(resp = {}) {
  const out = {};
  for (const it of resp?.items || []) if (Array.isArray(it.bands) && it.bands.length) (out[it.goal.metric] ||= []).push(...it.bands);
  return out;
}
