/**
 * views/tools/bmIdleText.js — 리눅스 성능 8b단계 **저활용 서버 찾기** 문구 · 표시 도우미(순수 — vitest node 환경).
 * ⚠ 점수 · 상태 · 제외 · 주기 사용 · 뺀 지표는 서버(bmusage/idle.js — 수집 노드의 하루 계산)가 정한다 — 여기는 문장으로 바꾸기만(웹이 다시 판정하지 않는다).
 * ⚠ 값이 없으면 ‘—’(단위 없음) · 제외는 수를 적는다 · 후보 전력 합은 측정한 후보만(절감 추정 아님).
 */
import { unitText } from '../unitText.js';

export const STATUS_TEXT = Object.freeze({
  candidate: { label: '후보', tone: 'warn' },
  watch: { label: '관찰', tone: 'idle' },
  active: { label: '사용 중', tone: 'ok' },
  periodic: { label: '주기 사용', tone: 'idle' },
  excluded: { label: '제외', tone: 'idle' },
});
export const EXCLUDE_TEXT = Object.freeze({ insufficient: '데이터 부족', maint: '정비 창 중', 'no-score': '점수 없음(가중 0)', dr: '대기 · DR(검토 상태)' });
export const METRIC_TEXT = Object.freeze({ cpu: 'CPU', mem: '메모리', disk: '디스크', net: '네트', power: '전력', act: '활동 흔적' });
export const REVIEW_OPTIONS = Object.freeze(['review', 'retire', 'keep', 'dr', 'clear']);
export const REVIEW_TEXT = Object.freeze({ review: '검토 중', retire: '반납 예정', keep: '유지', dr: '대기 · DR(제외)', clear: '검토 상태 지움' });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v) => unitText(num(v), '%');
export const cpuPairText = (m) => (num(m?.cpuAvg) == null && num(m?.cpuMax) == null ? '—' : `${pct(m?.cpuAvg)} / ${pct(m?.cpuMax)}`);
export const powerText = (m) => (num(m?.powerAvgW) == null ? '—' : `${Math.round(m.powerAvgW)} W`);
/** 활동 칸 — SSH 를 모르면 ‘—’(로그를 읽지 않는 서버). */
export function actText(m) {
  if (num(m?.ssh) == null) return '—';
  const ev = (m.ssh || 0) + (m.focus || 0) + (m.snap || 0);
  return ev === 0 ? '흔적 없음' : `SSH ${m.ssh} · 집중 ${m.focus ?? '—'} · 스냅 ${m.snap ?? '—'}`;
}
/** 상태 칸 문장 — 제외 사유 · 주기 사용 · 데이터 부족 일수. */
export function statusText(r) {
  const s = STATUS_TEXT[r?.status]?.label || r?.status || '—';
  if (r?.status === 'excluded') return `${s} · ${EXCLUDE_TEXT[r.reason] || r.reason || ''}${r.reason === 'insufficient' && num(r.days) != null ? `(${r.days}일)` : ''}`;
  if (r?.status === 'periodic') return `${s}(높은 날 ${r.periodic?.highDays ?? '—'}일${r.periodic?.sameWeekday ? ' · 같은 요일' : ''})`;
  return s;
}
export const droppedText = (r) => ((r?.dropped || []).length ? `뺀 지표: ${(r.dropped || []).map((k) => METRIC_TEXT[k] || k).join(' · ')}` : '');
export function reviewText(rv) {
  if (!rv) return '—';
  return `${REVIEW_TEXT[rv.status] || rv.status}${rv.by ? ` · ${rv.by}` : ''}`;
}
/** 요약 카드(순수). */
export function idleCards(sum = {}) {
  const ex = sum.excludedBy || {};
  return [
    { k: 'cand', label: '후보(≥ 후보 점수)', value: sum.candidate, tone: 'warn', sub: '점수는 후보 표시일 뿐 판정이 아닙니다' },
    { k: 'watch', label: '관찰', value: sum.watch, tone: 'idle', sub: '후보 아래 · 관찰 점수 이상' },
    { k: 'active', label: '사용 중', value: sum.active, tone: 'ok', sub: '' },
    { k: 'periodic', label: '주기 사용', value: sum.periodic, tone: 'idle', sub: '주 1회처럼 가끔 높은 서버 — 후보에서 뺐습니다' },
    { k: 'excl', label: '제외', value: sum.excluded, tone: 'idle', sub: Object.entries(EXCLUDE_TEXT).map(([k, v]) => `${v} ${ex[k] ?? 0}`).join(' · ') },
  ];
}
export function candPowerText(sum = {}) {
  if (!num(sum.candPowerMeasured)) return { value: '—', sub: `측정한 후보 0 · 미측정 ${sum.candPowerUnmeasured ?? 0}` };
  return { value: `${(sum.candPowerW / 1000).toFixed(1)} kW`, sub: `30일 평균 W 의 합 — 절감 추정이 아니라 지금 쓰는 전력의 합(측정 ${sum.candPowerMeasured} · 미측정 ${sum.candPowerUnmeasured ?? 0} 은 제외)` };
}
export function monthText(sum = {}) {
  if (!sum.month) return { value: '—', sub: '계산 이력이 30일 안 됩니다(모두 새 후보로 보이지 않게 비웠습니다)' };
  return { value: `+${sum.month.joined} / −${sum.month.left}`, sub: '지난 30일 후보 진입 · 이탈(변경 이벤트 ‘저활용 후보’ 와 같은 전이)' };
}
export function sourceText(s, minEdge) {
  const when = s.at ? new Date(s.at).toLocaleString() : '';
  if (s.old) return `${s.node} — 엣지가 구버전입니다(저활용 계산 없음 · 엣지 v${minEdge || '?'} 이상 필요)`;
  if (s.unreadable) return `${s.node || '이 노드'} — 결과 파일을 읽지 못했습니다(손상본 보존 · 다음 계산이 새로 만듭니다)`;
  if (s.none) return `${s.node || '이 노드'} — 아직 계산 전입니다(하루 1회 · 01:20 뒤 첫 수집 틱)`;
  return `${s.node || '이 노드'}(${s.via === 'edge' ? '엣지' : '이 노드'}) — ${s.day || ''} 계산 · ${when}${s.truncated ? ' · 봉투 상한으로 ‘사용 중’ 행은 수만' : ''}`;
}
/** 점수 규칙 표(순수 — 서버 cfg 값 그대로). */
export function ruleRows(cfg = {}) {
  return [
    { m: 'CPU', win: '30일 평균 · 일 최대 평균', th: `평균 < ${cfg.cpuAvgPct}% 그리고 일 최대 < ${cfg.cpuMaxPct}%`, w: cfg.wCpu, src: 'usage_daily cpu_sum/cpu_n · cpu_max' },
    { m: '메모리', win: '30일 평균', th: `< ${cfg.memAvgPct}%`, w: cfg.wMem, src: 'mem_sum/mem_n' },
    { m: '디스크 I/O', win: '일 최대 busy 평균', th: `< ${cfg.diskBusyMaxPct}%`, w: cfg.wDisk, src: 'disk_busy_max' },
    { m: '네트워크', win: '일 최대(링크 대비) 평균', th: `< ${cfg.netMaxPct}%`, w: cfg.wNet, src: 'net_max' },
    { m: '전력', win: '창 평균 vs 창 최소(시간 평균)', th: `≤ 최소 × ${(cfg.powerIdlePct / 100).toFixed(2)}`, w: cfg.wPower, src: 'power_hourly(iDRAC) · 없으면 —(분모에서 뺌)' },
    { m: '활동 흔적', win: '창 안', th: 'SSH 로그인 0 · 사람이 연 집중 0 · 스냅샷 0', w: cfg.wAct, src: '로그 분석 · 집중 · 스냅샷(SSH 를 모르면 —)' },
  ];
}
export const IDLE_HONEST = Object.freeze([
  '**저활용 ≠ 불필요** — DR · 대기 · 분기 배치 · 라이선스 때문에 켜 둔 서버가 있습니다. ‘대기 · DR’ 은 검토 상태로 지정하면 제외하고, 분기 배치는 창 30일로 못 보니 창을 90일까지 늘릴 수 있습니다(설정). 최종 판단은 사람 · ‘유지’ 에는 사유를 남깁니다.',
  '전력 ‘유휴’ 는 **서버별 상대값**입니다 — 그 서버의 창 안 최소 시간 평균을 기준으로 봅니다(모델별 유휴값은 쓰지 않습니다). 0 W 보고 시간은 뺐습니다.',
  '기준(5% · 20% · 1.10 등)은 공식 권고가 없는 **관행 값**입니다 — 설정 › 알림 규칙에서 바꾸고 바꾼 값은 감사에 남습니다(노드마다 따로).',
  '지표가 없으면(‘—’) 그 가중은 분모에서 빼고 100 으로 환산합니다 — 뺀 지표를 행에 적습니다. 설계의 ‘프로세스 Top 에 사용자 프로세스 없음’ 신호는 계산 비용 때문에 넣지 않았습니다.',
]);
