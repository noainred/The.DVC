/**
 * 업그레이드 화면 '엣지 자동 업그레이드' 칸 문구 — 순수 모듈(v2.859, 사용자 요청 "중앙 포탈이 자동 업그레이드 되면 엣지도 모두
 * 자동으로 업그레이드 · 기본값 켬").
 *
 * 판정은 서버(`server/src/upgrade/edgeSync.js`)가 코드로 하고 여기서는 문장만 만든다 — **다시 판정하지 않는다**.
 * 코드 표(EDGE_STATE_TEXT·SYNC_OUTCOME_TEXT)는 서버 `EDGE_SYNC_STATES`·`EDGE_SYNC_OUTCOMES` 와 1:1(테스트가 서버 소스와 대조한다).
 * 문구 규칙: 백틱 금지(BoldText 가 글자로 그린다), 값 인용은 ‘ ’, 주기·시각 숫자는 서버가 준 값만 쓴다.
 */
import { agoText } from './tools/relTime.js';
import { numOrNull } from '../numOrNull.js';
import { intervalText, inText } from './upgradeAutoText.js';

/** 엣지 하나의 판정 → 이름·톤. 서버 EDGE_SYNC_STATES 와 1:1. */
export const EDGE_STATE_TEXT = {
  'up-to-date': { label: '최신', tone: 'ok' },
  behind: { label: '구버전 — 다음 동기화 때 밀어 넣습니다', tone: 'warn' },
  ahead: { label: '중앙보다 새 버전 — 내리지 않습니다', tone: 'warn' },
  unknown: { label: '버전 모름 — 밀지 않습니다', tone: 'muted' },
  unreachable: { label: '닿지 않음(수집 pull 실패 중) — 돌아오면 밀어 넣습니다', tone: 'bad' },
  disabled: { label: '수집 중지', tone: 'muted' },
  waiting: { label: '밀어 넣음 — 엣지가 재시작해 새 버전을 보고하기를 기다립니다', tone: 'muted' },
  backoff: { label: '최근 push 실패 — 잠시 뒤 다시', tone: 'bad' },
};

/** 동기화 한 번의 결과 → 문구. 서버 EDGE_SYNC_OUTCOMES 와 1:1. */
export const SYNC_OUTCOME_TEXT = {
  off: '엣지 자동 업그레이드가 꺼져 있어 아무것도 하지 않았습니다',
  skipped: '업그레이드 확인·적용이 진행 중이라 이번 주기는 건너뛰었습니다',
  'no-edges': '등록된 수집 서버가 없어 할 일이 없었습니다',
  idle: '뒤처진 엣지가 없었습니다',
  pushed: '뒤처진 엣지에 중앙 버전 번들을 밀어 넣었습니다',
  'no-bundle': '뒤처진 엣지가 있지만 중앙 현재 버전의 번들을 구하지 못했습니다',
  error: '동기화 중 오류가 났습니다',
};

export const EDGE_SYNC_OFF_FIX = '아래 ‘중앙 포탈이 업그레이드되면 등록된 엣지도 모두 자동 업그레이드’ 를 켜고 설정을 저장하세요. 꺼져 있는 동안은 수집 서버 화면의 ‘모두 업그레이드’ 로만 맞출 수 있습니다.';

const clock = (ts) => { const t = numOrNull(ts); return t == null ? '—' : new Date(t).toLocaleString('ko-KR'); };

/**
 * '엣지 자동 업그레이드' 칸 요약. 서버가 edgeSync 를 보내지 않으면(구버전) null — 지어내지 않는다.
 * @returns {null|{label:string, tone:string, next:string, last:string|null, lastTone:string, counts:string|null, rows:{id:string,name:string,version:string|null,text:string,tone:string,reason:string|null}[], fix:string|null}}
 */
export function edgeSyncSummary(status, now = Date.now()) {
  const e = status && status.edgeSync;
  if (!e || typeof e !== 'object') return null;
  const featureOff = status.enabled === false;
  const settingOff = status.edgeAutoUpgrade === false;
  let label; let tone; let fix = null;
  if (featureOff) { label = '꺼짐 — 자동 업그레이드 사용이 꺼져 있습니다'; tone = 'muted'; fix = '‘자동 업그레이드 사용’ 을 켜고 저장하면 엣지 동기화도 함께 동작합니다.'; }
  else if (settingOff || !e.enabled) { label = '꺼짐'; tone = 'warn'; fix = EDGE_SYNC_OFF_FIX; }
  else { label = '켬 — 중앙이 업그레이드되면 등록된 엣지도 모두 같은 버전으로'; tone = 'ok'; }

  let next;
  if (!e.enabled) next = '동기화를 하지 않습니다(꺼짐)';
  else if (e.running) next = '지금 동기화 중입니다';
  else if (numOrNull(e.nextRunAt) != null) next = `${clock(e.nextRunAt)} (${inText(e.nextRunAt, now)})${intervalText(e.intervalMs) ? ` · ${intervalText(e.intervalMs)} 주기` : ''}`;
  else next = '예정 시각을 알 수 없습니다(타이머가 무장되지 않았습니다 — 설정을 다시 저장해 보세요)';

  const lr = e.lastRun;
  let last = null; let lastTone = 'muted';
  if (lr && typeof lr === 'object' && numOrNull(lr.at) != null) {
    const base = SYNC_OUTCOME_TEXT[lr.outcome] || SYNC_OUTCOME_TEXT.error;
    const detail = lr.outcome === 'pushed' ? ` — ${lr.ok ?? 0}/${lr.pushed ?? 0}대 성공${lr.version ? ` (v${lr.version})` : ''}`
      : lr.outcome === 'no-bundle' ? ` — 뒤처진 ${lr.behind ?? 0}대${lr.reason ? ` · ${lr.reason}` : ''}`
        : lr.reason ? ` — ${lr.reason}` : '';
    last = `${clock(lr.at)} (${agoText(lr.at, now)}) · ${base}${detail}`;
    lastTone = lr.outcome === 'pushed' && (lr.ok ?? 0) === (lr.pushed ?? 0) ? 'ok'
      : lr.outcome === 'idle' || lr.outcome === 'no-edges' ? 'ok'
        : lr.outcome === 'skipped' || lr.outcome === 'off' ? 'muted' : lr.outcome === 'pushed' ? 'warn' : 'bad';
  }

  const c = e.counts && typeof e.counts === 'object' ? e.counts : null;
  const n = (k) => numOrNull(c?.[k]) ?? 0;
  const counts = c ? [
    `등록 ${numOrNull(e.total) ?? 0}대`, `최신 ${n('up-to-date')}`,
    n('behind') + n('waiting') + n('backoff') ? `구버전 ${n('behind') + n('waiting') + n('backoff')}` : '',
    n('ahead') ? `중앙보다 새 버전 ${n('ahead')}` : '', n('unknown') ? `버전 모름 ${n('unknown')}` : '',
    n('unreachable') ? `닿지 않음 ${n('unreachable')}` : '', n('disabled') ? `중지 ${n('disabled')}` : '',
  ].filter(Boolean).join(' · ') : null;

  const rows = (Array.isArray(e.pending) ? e.pending : []).filter((r) => r && typeof r === 'object').map((r) => {
    const t = EDGE_STATE_TEXT[r.state] || { label: `알 수 없는 상태(${String(r.state || '—')})`, tone: 'muted' };
    const when = numOrNull(r.nextAt) != null ? ` (${inText(r.nextAt, now)} 다시)` : '';
    return { id: String(r.id || ''), name: String(r.name || r.id || ''), version: r.version ? String(r.version) : null, text: `${t.label}${when}`, tone: t.tone, reason: r.reason ? String(r.reason) : null };
  });
  return { label, tone, next, last, lastTone, counts, rows, fix };
}

/** 마지막 동기화가 없을 때의 문장. */
export function noSyncText(status) {
  const e = status && status.edgeSync;
  if (!e) return '';
  if (!e.enabled) return '동기화 기록 없음 — 꺼져 있습니다';
  return '이 포탈이 시작된 뒤 아직 동기화 기록이 없습니다(기동 2분 뒤 첫 실행)';
}

/** 설정 체크박스 옆 설명 — 주기는 서버 값. */
export function edgeAutoCheckboxHint(status) {
  const iv = intervalText(status?.edgeSync?.intervalMs);
  return `적용 직후 등록된 수집 서버 전부에 번들을 밀고, 그 뒤 ${iv ? `${iv}마다` : '주기적으로'} 구버전으로 남은 엣지(꺼져 있었거나 닿지 않았던)에 다시 밉니다. 중앙 /dl 에도 번들을 두어 엣지 스스로의 확인(1시간 주기)으로도 올라옵니다.`;
}
