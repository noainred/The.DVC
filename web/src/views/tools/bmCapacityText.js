/**
 * 리눅스 성능 8a단계 — **용량 소진 예측** 화면 문구 · 형식(순수 — React 없음 · vitest node 환경).
 * ⚠ 예측(선형 · R² · 리셋 · 불안정 · 도달일)은 서버가 한다(bmusage/capacity.js) — 여기는 서버 값을 글자 · 색으로 옮기고 그림 좌표만 만든다(다시 판정하지 않는다).
 * ⚠ ‘못 읽음’ 은 0 이 아니다: 데이터 부족 · 불안정 · 상한 없음 · 증가 없음은 ‘—’ 와 그 사유이고 ‘안전’ 으로 적지 않는다. 숫자(목표선 · 기준 일수)는 API cfg 값만.
 * ⚠ 문구에 백틱 금지(BoldText 는 ‘**’ 만 해석) — 값 인용은 ‘ ’.
 */
import { numOrNull } from '../../numOrNull.js';

const n = numOrNull;
export const KIND_TEXT = Object.freeze({ fs: '파일시스템', inode: 'inode', mem: '메모리(참고)' });
/** 상태(서버 CAP_STATUS 와 1:1). */
export const STATUS_TEXT = Object.freeze({
  forecast: { label: '예측', tone: 'warn' }, reached: { label: '이미 목표선 위', tone: 'bad' }, 'no-growth': { label: '증가 없음', tone: 'idle' },
  unstable: { label: '불안정 · 예측 안 함', tone: 'idle' }, insufficient: { label: '데이터 부족', tone: 'idle' }, 'no-limit': { label: '상한 없음', tone: 'idle' },
});
/** 사유(서버 CAP_REASONS 와 1:1). */
export const REASON_TEXT = Object.freeze({
  'few-days': '14일 창의 점이 기준보다 적음', flat: '값이 거의 그대로(추세 없음)', r2: 'R² 가 낮음(직선으로 설명되지 않음)', 'slope-diff': '14일 · 30일 기울기가 크게 다름(계단형 · 주기 정리 추정)',
  declining: '줄어드는 중', 'periodic-reset': '30일 안 리셋(하루 큰 하락)이 여러 번 — 주기 정리형', 'xfs-dynamic': 'xfs 는 inode 를 동적으로 만든다(값은 참고)', 'no-inode-limit': 'inode 상한을 보고하지 않는 파일시스템',
});
export const CONF_TEXT = Object.freeze({ high: '높음', mid: '보통' });
const mmdd = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5) : '');

/** 자원 이름 — 마운트 · ‘마운트 inode’ · 메모리. */
export function resText(r = {}) {
  if (r.kind === 'mem') return '메모리 (MemAvailable)';
  return r.kind === 'inode' ? `${r.res} inode` : String(r.res || '—');
}
/** 현재 % — 없으면 ‘—’. */
export function pctText(v) { const x = n(v); return x == null ? '—' : `${x}%`; }
/** 하루 증가 ‘+0.9%p’ — 예측 상태가 아니면 ‘—’(불안정 · 부족 값을 쓰지 않는다). */
export function slopeText(r = {}) {
  const s = n(r.slope);
  if (s == null || !['forecast', 'reached', 'no-growth'].includes(r.status) || r.reason === 'flat') return '—';
  return `${s > 0 ? '+' : ''}${s}%p`;
}
/** 목표 도달 칸 — 도달 · n일(MM-DD) · 1년 넘음 · 사유 글자. */
export function daysText(r = {}, which = 'target') {
  const d = n(which === 'target' ? r.daysToTarget : r.daysTo100);
  const date = which === 'target' ? r.dateToTarget : r.dateTo100;
  const beyond = which === 'target' ? r.beyondTarget : r.beyond100;
  if (r.status === 'reached' && which === 'target') return '도달';
  if (r.status === 'forecast' || r.status === 'reached') {
    if (d === 0) return '도달';
    if (d != null) return `${d}일${mmdd(date) ? ` (${mmdd(date)})` : ''}`;
    if (beyond) return '1년 넘음';
  }
  return STATUS_TEXT[r.status]?.label && !['forecast', 'reached'].includes(r.status) ? STATUS_TEXT[r.status].label : '—';
}
/** 신뢰 — 글자로(색만이 아니라): ‘높음 R² .94’ · 상태가 예측이 아니면 R² 만 또는 ‘—’. */
export function confText(r = {}) {
  const r2 = n(r.r2);
  const r2t = r2 == null ? '' : `R² ${r2.toFixed(2).replace(/^0/, '')}`;
  if (r.conf && CONF_TEXT[r.conf]) return `${CONF_TEXT[r.conf]} ${r2t}`.trim();
  if (r.status === 'unstable' && r2t) return r2t;
  if (r.status === 'insufficient') return n(r.n) != null ? `표본 ${r.n}일` : '—';   // ‘0일’ 이 남은 날로 읽히지 않게(r1 판독)
  return '—';
}
/** 메모 — 사유 · 리셋 · 정비 창 제외 · 결측 · 참고 등급. */
export function noteText(r = {}) {
  const p = [];
  if (r.reason && REASON_TEXT[r.reason]) p.push(REASON_TEXT[r.reason]);
  if (r.reset && r.resetDay) p.push(`리셋형 — ${mmdd(r.resetDay)} 뒤부터 창`);
  if (n(r.excluded)) p.push(`정비 창 ${r.excluded}일 제외`);
  if (n(r.missing)) p.push(`결측 ${r.missing}일`);
  if (n(r.dailyWin)) p.push(`매일 반복 정비 창 ${r.dailyWin}개는 빼지 않음(모든 날에 같은 영향)`);
  if (r.grade === 'ref' || r.kind === 'mem') p.push('참고 등급(캐시 회수로 과대할 수 있음 · 누수 단정 안 함)');
  if (r.status === 'unstable' && n(r.max30) != null) p.push(`최근 30일 최대 ${r.max30}%`);
  return p.join(' · ');
}
/** 요약 카드(서버 summarize — 서버 수). */
export function summaryCards(s = {}, cfg = {}) {
  const days = n(cfg.alertDays);
  return [
    { k: 'soon', label: `${days == null ? '—' : `${days}일`} 안 목표선 도달`, value: n(s.soon), tone: 'bad', sub: s.soonByKind ? `파일시스템 ${s.soonByKind.fs ?? 0} · inode ${s.soonByKind.inode ?? 0} · 메모리 ${s.soonByKind.mem ?? 0}` : '' },
    { k: 'month', label: '30일 안 목표선 도달', value: n(s.month), tone: 'warn', sub: s.monthByKind ? `파일시스템 ${s.monthByKind.fs ?? 0} · inode ${s.monthByKind.inode ?? 0} · 메모리 ${s.monthByKind.mem ?? 0}` : '' },
    { k: 'unstable', label: '추세 불안정(예측 안 함)', value: n(s.unstable), tone: 'idle', sub: '14일 · 30일 추세가 다르거나 R² 가 낮은 서버' },
    { k: 'insufficient', label: '데이터 부족 · 상한 없음', value: n(s.insufficient), tone: 'idle', sub: '‘0일’ 로 적지 않는다 — 서버 수' },
  ];
}
/** 출처 상태 한 줄(이 노드 · 엣지) — 행이 없는 이유를 0 이 아니라 표지로. */
export function sourceText(s = {}, minEdgeVersion = null, cfg = {}) {
  const at = n(cfg.recomputeAfterMin);
  const when = at != null ? `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}` : '—';
  const name = s.via === 'local' ? `이 노드${s.node ? `(${s.node})` : ''}` : `엣지 ${s.node}`;
  if (s.old) return `${name} — 구버전 엣지(용량 예측을 싣지 않음${minEdgeVersion ? ` · v${minEdgeVersion} 이상 필요` : ''})`;
  if (s.unreadable) return `${name} — 계산 결과 파일을 읽지 못함(다음 계산에서 다시 만든다)`;
  if (s.none) return `${name} — 아직 계산 전(하루 1회 · ${when} 뒤 첫 주기)`;
  return `${name} — ${s.day || '—'} 기준${s.truncated ? ' · 일부만(상한)' : ''}`;
}
/**
 * 상세 그림 좌표(순수) — 일 계열(오름차순) + 맞춤선 연장(목표 도달일 또는 +14일까지). 뷰박스 1000 × 100 · y 0~100%.
 * @returns {{ line:string, fit:string, xToday:number|null, target:number, days:string[], exDays:Set }}
 */
export function capChart(series = [], fit = null, { today = null, extendDays = 14, targetPct = 90 } = {}) {
  const pts = (series || []).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.day)).sort((a, b) => a.day.localeCompare(b.day));
  if (!pts.length) return { line: '', fit: '', xToday: null, target: targetPct, days: [], dayEnd: null };
  const dnum = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const x0 = dnum(pts[0].day);
  const xEnd = Math.max(dnum(pts[pts.length - 1].day), today ? dnum(today) : 0) + extendDays;
  const W = 1000; const H = 100;
  const X = (d) => ((d - x0) / Math.max(1, xEnd - x0)) * W;
  const Y = (v) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  let line = ''; let pen = false;
  for (const p of pts) {
    const v = n(p.v);
    if (v == null || p.ex) { pen = false; continue; }
    line += `${pen ? 'L' : 'M'}${X(dnum(p.day)).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true;
  }
  let fitD = '';
  if (fit && n(fit.slope) != null && n(fit.intercept) != null && /^\d{4}-\d{2}-\d{2}$/.test(String(fit.fromDay))) {
    const a = dnum(fit.fromDay);
    const v = (d) => fit.intercept + fit.slope * d;
    fitD = `M${X(a).toFixed(1)} ${Y(v(a)).toFixed(1)} L${X(xEnd).toFixed(1)} ${Y(v(xEnd)).toFixed(1)}`;
  }
  const pad = (v) => String(v).padStart(2, '0');
  const dayStr = (k) => { const dt = new Date(k * 86_400_000); return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; };   // 달력 날짜 번호 → 글자(오늘 날짜가 아니다)
  return { line: line.trim(), fit: fitD, xToday: today ? X(dnum(today)) : null, target: Y(targetPct), days: [pts[0].day, dayStr(xEnd)], exX: pts.filter((p) => p.ex).map((p) => X(dnum(p.day))) };
}
export const CAPACITY_HONEST = '예측은 **참고**입니다(판정이 아닙니다 · ML 없음 — 최근 14일 일 최대의 직선). 계단형 적재 · 주기 정리(로그 로테이션 · VACUUM)는 직선이 틀리게 봅니다 — 그래서 ‘불안정 · 예측 안 함’ 으로 값을 쓰지 않고 최근 30일 최대만 적습니다. '
  + '메모리는 MemAvailable 기준이라 캐시 회수로 과대할 수 있고, 재부팅 리셋형은 누수라고 단정하지 않습니다. df 는 파일시스템 기준이라 씬 풀 · LVM 여유는 보지 않습니다. '
  + '마운트는 일 롤업만 저장해 하루 최대로 계산합니다 · 정비 창(⑤ 분모 제외)이 걸친 날은 추세에서 뺍니다(기간의 절반 넘는 날에 걸치는 매일 반복 창은 빼지 않습니다 — 모든 날에 같은 영향) · 수집 노드가 하루 한 번 계산합니다.';

/** 보드 KPI(순수) — 30일 안 소진 서버 수 · 7일 안 · 불안정 · 부족. 계산된 출처가 하나도 없으면 ‘—’(0 이 아니다). */
export function capacityKpi(resp) {
  if (!resp || resp.ok === false) return { value: '—', meta: '용량 예측을 읽지 못했습니다', soon: 0 };
  const computed = (resp.sources || []).some((s) => !s.none && !s.old && !s.unreadable);
  if (!computed) return { value: '—', meta: '아직 계산 전(하루 1회)', soon: 0 };
  const s = resp.summary || {};
  return { value: n(s.month) ?? '—', meta: `${n(resp.cfg?.alertDays) == null ? '—' : `${resp.cfg.alertDays}일`} 안 ${n(s.soon) ?? '—'} · 불안정 ${n(s.unstable) ?? '—'} · 부족 ${n(s.insufficient) ?? '—'}`, soon: n(s.soon) || 0 };
}
