/**
 * 연결 테스트 화면 순수 헬퍼(v2.421) — 단계 라벨·상태 문구·추적 로그 텍스트. node 환경 테스트로 고정.
 */
import { unitText, isBlank } from '../unitText.js';

export const PHASE_LABEL = {
  dns: 'DNS 이름 해석', tcp: 'TCP 연결', 'ssh-handshake': 'SSH 핸드셰이크', 'ssh-auth': 'SSH 인증',
  exec: '명령 실행', parse: '출력 해석', rest: 'REST 호출', timeout: '전체 타임아웃', edge: '엣지 대행', done: '완료', unknown: '분류 불가',
};
export const phaseLabel = (p) => PHASE_LABEL[p] || p || '—';

/** 진행 상태 한 줄 — 실행 중이면 마지막 추적 줄을 '지금 단계'로 보여준다(어디서 기다리는지). */
export function statusText(run) {
  if (!run) return '';
  const sec = Math.round((run.elapsedMs || 0) / 1000);
  const last = (run.trace || []).slice(-1)[0];
  if (run.status === 'queued') return `엣지 "${run.target}" 가 요청을 가져가길 기다리는 중 (${sec}초) — 엣지의 다음 설정 pull 때 실행됩니다.`;
  if (run.status === 'dispatched') return `엣지 "${run.target}" 가 현지에서 실행 중 (${sec}초) — 결과 회신 대기.`;
  if (run.status === 'running') return `${last ? `진행 중: ${last.msg}` : '시작 중'} (${sec}초)`;
  if (run.status === 'done') {
    const r = run.result || {};
    return r.ok ? `연결 성공 (${Math.round((r.ms || run.elapsedMs || 0) / 1000 * 10) / 10}초)` : `연결 실패 — ${phaseLabel(r.phase)} 단계 (${sec}초)`;
  }
  return run.status;
}

/** 추적 로그 → 복사용 텍스트. 서버 testDiag.traceText 와 같은 형식. */
export function traceText(lines = []) {
  return lines.map((l) => `[+${(Number(l.t) / 1000).toFixed(3)}s] ${l.level === 'error' ? '✖ ' : l.level === 'debug' ? '  · ' : l.level === 'warn' ? '⚠ ' : ''}${l.msg}`).join('\n');
}

/** 실행 중인지(폴링을 계속할지). */
export const isActive = (run) => !!run && run.status !== 'done';

/**
 * 테스트 요약 스냅샷의 표시 값(v2.604 감사 CEN2604-05 — 웹 가드). 엣지가 회신한 snap 은 서버가 정제하지만(testRuns.sanitizeTestSnap)
 * 구버전 중앙·중앙 직접 실행 결과도 이 화면을 지나므로 여기서도 **타입부터** 좁힌다:
 *  · 객체·배열 값을 텍스트 자식으로 두면 React #31 로 모달이 죽는다 → 표시할 수 없는 값은 '—'.
 *  · ports 가 없으면 예전 `snap.ports.online` 이 TypeError 였다 → 빈 객체로 본다.
 *  · 값이 없으면 단위(%)를 붙이지 않는다(v2.575 unitText 규약 — '—%' 는 0 처럼 읽힌다).
 */
export function testSnapView(snap) {
  const s = snap && typeof snap === 'object' && !Array.isArray(snap) ? snap : {};
  const txt = (v) => (isBlank(v) ? '—' : String(v));
  const p = s.ports && typeof s.ports === 'object' && !Array.isArray(s.ports) ? s.ports : {};
  const sec = s.sections && typeof s.sections === 'object' && !Array.isArray(s.sections) ? s.sections : {};
  const missing = Object.entries(sec).filter(([, v]) => typeof v === 'string' && v !== 'ok').map(([k, v]) => `${k}(${v})`);
  return {
    name: txt(s.name), model: txt(s.model), fabricOs: txt(s.fabricOs), serial: txt(s.serial), domainId: txt(s.domainId),
    online: txt(p.online), licensed: txt(p.licensed), usedPct: unitText(p.usedPct, '%'), free: txt(p.free), total: txt(p.total),
    missing,
  };
}
