/**
 * rollupBackfillText.js — 설정 › 지표 수집 '현재 상태' 의 롤업 백필 한 줄(v2.675, 순수 — vitest).
 *
 * 서버(metrics/rollupBackfill.js)는 롤업 도입(v2.252) 이전 원본을 시간당 롤업으로 한 번 옮긴다 — 긴 기간 차트가 원본 수십만 행을
 * 동기로 집계하지 않게(v2.672 운영 장애의 근본 해법). 상태는 /admin/metrics/settings 의 status.rollupBackfill 이다.
 * 숫자는 서버 값만 쓴다(시작 지연·하한을 문구에 박지 않는다 — v2.509 규약). 백틱·별표 금지(BoldText 규약).
 * 범위 관리자에게는 서버가 state·시각만 준다(키·행 수는 전 함대 집계) — 없는 숫자를 0 으로 채우지 않는다.
 */
import { agoText } from './tools/relTime.js';
import { numOrNull } from '../numOrNull.js';

const nf = new Intl.NumberFormat('ko-KR');
const cnt = numOrNull;   // 서버가 주지 않은 숫자는 null(0 으로 채우지 않는다)
const LABEL = '옛 원본 → 시간당 롤업 이전';

/**
 * @param {object|null} rb status.rollupBackfill
 * @param {number} [nowMs]
 * @returns {{text:string, warn:string}} 둘 다 빈 문자열이면 표시하지 않는다(구버전 서버·대상 아님)
 */
export function rollupBackfillNote(rb, nowMs = Date.now()) {
  if (!rb || typeof rb !== 'object' || !rb.state) return { text: '', warn: '' };
  const stuck = cnt(rb.stuckKeys);
  const stuckTail = stuck ? ` · 진행하지 못해 건너뛴 키 ${nf.format(stuck)}개(포탈 로그의 metrics 줄을 보세요)` : '';
  switch (rb.state) {
    case 'off': return { text: `${LABEL}: 꺼져 있습니다(긴 기간 차트가 옛 구간을 원본으로 집계할 수 있습니다).`, warn: '' };
    case 'waiting': return { text: `${LABEL}: 기동 뒤 잠시 후 백그라운드에서 한 번 시작합니다.`, warn: '' };
    case 'running': {
      const done = cnt(rb.keysDone); const total = cnt(rb.keysTotal); const hours = cnt(rb.hours);
      const parts = [];
      if (done != null && total != null) parts.push(`키 ${nf.format(done)}/${nf.format(total)}(지표를 넘어갈 때마다 늘어납니다)`);
      if (hours != null) parts.push(`옮긴 시간 ${nf.format(hours)}`);
      return { text: `${LABEL} 진행 중${parts.length ? ` — ${parts.join(' · ')}` : ''}. 포탈을 멈추지 않게 천천히 옮깁니다.${stuckTail}`, warn: '' };
    }
    case 'done': {
      const m = rb.marker && typeof rb.marker === 'object' ? rb.marker : null;
      const when = m?.doneAt ? agoText(m.doneAt, nowMs, { dash: '' }) : '';
      const filled = cnt(m?.keysFilled); const hours = cnt(m?.hours);
      const what = filled == null ? '' : filled === 0 ? ' — 옮길 옛 원본이 없었습니다' : ` — 키 ${nf.format(filled)}개 · 시간당 ${nf.format(hours ?? 0)}행`;
      return { text: `${LABEL} 완료${when ? `(${when})` : ''}${what}.${stuckTail}`, warn: '' };
    }
    case 'disk-low':
    case 'error':
      return { text: '', warn: `${LABEL} 멈춤: ${String(rb.lastError || '사유 미상').slice(0, 300)}${stuckTail}` };
    default: return { text: '', warn: '' };   // idle·unsupported(NDJSON 폴백) — 표시할 것이 없다
  }
}
