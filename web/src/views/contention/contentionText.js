// v2.706(C2·C3) — CPU 경합·디스크 지연 문구·판정. 서버 contention/parse.js 와 같은 입력으로 대조한다(번들 경계라 두 벌).
// 문구에 백틱·별표 금지(BoldText 는 **강조** 만 해석).
import { unitText } from '../unitText.js';

export const CONTENTION_CODES = Object.freeze({
  'cpu-ready': 'warn', 'cpu-ready-crit': 'crit', 'cpu-costop': 'warn', 'cpu-costop-crit': 'crit', 'cpu-latency': 'info',
  'disk-latency': 'warn', 'disk-latency-crit': 'crit',
});
export const THRESHOLDS = Object.freeze({ readyWarn: 5, readyCrit: 10, costopWarn: 3, costopCrit: 10, latencyWarn: 10, diskWarn: 20, diskCrit: 50 });

export const CONTENTION_TEXT = Object.freeze({
  'cpu-ready': { title: 'CPU 대기(Ready) 높음', fix: 'vCPU 가 실행할 차례를 기다립니다 · 호스트 과밀이면 VM 을 옮기고, VM 의 vCPU 가 과하면 줄이세요' },
  'cpu-ready-crit': { title: 'CPU 대기(Ready) 매우 높음', fix: '체감 성능 저하 수준입니다 · 같은 호스트의 사용량 상위 VM 과 호스트 CPU 사용률을 함께 보세요' },
  'cpu-costop': { title: 'Co-stop 높음', fix: 'vCPU 여러 개를 동시에 스케줄하지 못해 멈춥니다 · 대개 vCPU 가 너무 많은 VM 입니다 — 실제 사용량에 맞게 줄이세요' },
  'cpu-costop-crit': { title: 'Co-stop 매우 높음', fix: 'vCPU 수를 줄이는 것이 가장 효과가 큽니다(라이트사이징 화면 참고)' },
  'cpu-latency': { title: 'CPU 지연(latency) 높음', fix: '참고 · Ready 외에 전력 관리·하이퍼스레딩 공유·메모리 접근 지연도 포함된 값입니다' },
  'disk-latency': { title: '디스크 지연 높음', fix: '그 VM 디스크가 있는 데이터스토어의 지연·경로·어레이 부하를 확인하세요' },
  'disk-latency-crit': { title: '디스크 지연 매우 높음', fix: '애플리케이션 시간 초과가 날 수 있는 수준입니다 · 데이터스토어 표에서 같은 시각 지연을 함께 보세요' },
});
export const SEV_LABEL = Object.freeze({ crit: '위험', warn: '주의', info: '참고' });
export const SEV_BADGE = Object.freeze({ crit: 'red', warn: 'amber', info: 'gray' });

/** 서버 vmContentionFindings 와 같은 규칙(창 평균으로 판정). */
export function vmContentionFindings(vm) {
  const p = vm?.perfc;
  const out = [];
  if (!p || vm.powerState !== 'POWERED_ON') return out;
  const add = (code, facts) => out.push({ code, sev: CONTENTION_CODES[code], facts });
  const r = p.readyPct?.avg; const c = p.costopPct?.avg; const l = p.latencyPct?.avg;
  if (r != null) { if (r >= THRESHOLDS.readyCrit) add('cpu-ready-crit', { avg: r, max: p.readyPct.max }); else if (r >= THRESHOLDS.readyWarn) add('cpu-ready', { avg: r, max: p.readyPct.max }); }
  if (c != null) { if (c >= THRESHOLDS.costopCrit) add('cpu-costop-crit', { avg: c, max: p.costopPct.max }); else if (c >= THRESHOLDS.costopWarn) add('cpu-costop', { avg: c, max: p.costopPct.max }); }
  if (l != null && l >= THRESHOLDS.latencyWarn && !(r != null && r >= THRESHOLDS.readyWarn)) add('cpu-latency', { avg: l });
  const d = Math.max(p.readMs?.avg ?? -1, p.writeMs?.avg ?? -1);
  if (d >= THRESHOLDS.diskCrit) add('disk-latency-crit', { avg: d, disk: p.disk });
  else if (d >= THRESHOLDS.diskWarn) add('disk-latency', { avg: d, disk: p.disk });
  return out;
}

export const pctText = (v) => unitText(v, '%');
export const msText = (v) => unitText(v, ' ms');
/** 평균(최대) 한 칸 — 값이 없으면 '—'. */
export function avgMaxText(am, unit) {
  if (!am || am.avg == null) return '—';
  return `${am.avg}${unit}${am.max != null && am.max !== am.avg ? ` (최대 ${am.max}${unit})` : ''}`;
}

/** 수집 범위 — 측정하지 못한 VM 을 '경합 없음' 이라 말하지 않는다. */
export function coverageNote(data) {
  if (!data) return null;
  if (data.scan && data.scan.enabled === false) return 'CPU 경합·디스크 지연 수집이 꺼져 있습니다(CONTENTION_SCAN=false) — 이 화면은 판정하지 않습니다.';
  const c = data.coverage || {};
  const parts = [];
  if (c.poweredOn > 0 && c.measured === 0 && !c.stale) return '아직 측정한 VM 이 없습니다 — 수집 서버가 켜진 VM 을 주기마다 나눠 읽습니다(재시작 직후면 몇 주기 뒤에 채워집니다).';
  if (c.notMeasured) parts.push(`아직 측정하지 않은 켜진 VM ${c.notMeasured.toLocaleString()}대`);
  if (c.stale) parts.push(`측정이 오래된 VM ${c.stale.toLocaleString()}대`);
  return parts.length ? `${parts.join(' · ')}는 판정에서 빠졌습니다(경합이 없다는 뜻이 아닙니다).` : null;
}
/** 창 설명 — 실시간 통계의 최근 몇 분인지. */
export function windowText(scan) {
  const sec = Number(scan?.windowSec);
  if (!Number.isFinite(sec) || sec <= 0) return '최근 창';
  return sec % 60 === 0 ? `최근 ${sec / 60}분` : `최근 ${sec}초`;
}
/** 없는 카운터 — vCenter 카탈로그에 그 카운터가 없으면 그 값만 '—' 다. */
export function missingCounterNote(status) {
  const rows = (Array.isArray(status) ? status : []).filter((s) => Array.isArray(s.missingCounters) && s.missingCounters.length);
  if (!rows.length) return null;
  return `카운터가 없는 vCenter ${rows.length}곳: ${rows.slice(0, 3).map((s) => `${s.name}(${s.missingCounters.join(', ')})`).join(' · ')}${rows.length > 3 ? ' 외' : ''} — 그 값은 '—' 로 보입니다.`;
}
