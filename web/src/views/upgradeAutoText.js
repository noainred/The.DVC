/**
 * 업그레이드 화면 '자동 업그레이드 동작' 칸 문구 — 순수 모듈(v2.736.2).
 *
 * 사용자 신고(2026-10-15): "아직도 자동 업그레이드가 안되고 동일한 메시지가 있어, 서명 필수". '릴리스 서명 › 마지막 검증 없음' 은
 * 서명이 막은 것이 아니라 **업그레이드를 시도하지 않았다** 는 뜻이었는데, 화면은 시도하지 않는 이유를 말하지 않았다(확인 주기
 * 0분이어도 '자동 적용: 예' 만 보였다). 판정은 서버(`server/src/upgrade/autoState.js`)가 코드로 하고 여기서는 문장만 만든다 —
 * **다시 판정하지 않는다**. 코드 표는 서버 `AUTO_CODES`·`TICK_OUTCOMES` 와 1:1(테스트가 서버 소스와 대조한다).
 *
 * 문구 규칙: 백틱 금지(BoldText 가 글자로 그린다), 값 인용은 ‘ ’, 주기·시각 숫자는 서버가 준 값만 쓴다.
 */
import { agoText } from './tools/relTime.js';
import { numOrNull } from '../numOrNull.js';

/** 사유 코드 → 제목·조치. 서버 AUTO_CODES 와 1:1. */
export const AUTO_TEXT = {
  disabled: { title: '자동 업그레이드 사용이 꺼져 있습니다', fix: '아래 ‘자동 업그레이드 사용’ 을 켜고 설정을 저장하세요. 꺼져 있으면 확인·적용 버튼도 잠깁니다.' },
  'no-source': { title: '확인할 곳이 없습니다(원격 소스·감시 폴더 둘 다 비어 있음)', fix: '원격 소스 URL 이나 감시 폴더 중 하나를 입력하세요.' },
  'no-interval': { title: '확인 주기가 0분(끔)이라 자동 확인을 하지 않습니다 — 자동 적용도 일어나지 않습니다', fix: '확인 주기(분)에 0 보다 큰 값(예: 60)을 넣고 설정을 저장하세요. 지금 바로 받으려면 ‘새 버전 확인’ → ‘업그레이드 적용 + 재시작’ 을 누르세요.' },
  'no-auto-apply': { title: '자동 적용이 꺼져 있어 새 버전을 찾아도 적용하지 않습니다', fix: '‘새 버전 발견 시 자동 적용 + 재시작’ 을 켜거나, 새 버전이 보이면 ‘업그레이드 적용 + 재시작’ 을 누르세요.' },
  'no-install-dir': { title: '설치 경로(installDir)가 없어 적용할 수 없습니다', fix: '‘서버에서 자동 감지’ 로 설치 경로를 채운 뒤 설정을 저장하세요.' },
  'check-failed': { title: '마지막 확인이 실패했습니다', fix: '사유를 보고 원격 소스 주소·네트워크(프록시·방화벽)를 확인하세요. 다음 확인 주기에 다시 시도합니다.' },
  'apply-failed': { title: '마지막 적용이 실패했습니다', fix: '사유를 확인하세요. 같은 사유가 반복되면 자동 적용은 매 주기 같은 곳에서 멈춥니다.' },
};

/** 상태 → 이름·톤. 서버 AUTO_STATES 와 1:1. */
export const STATE_TEXT = {
  on: { label: '자동 확인 + 자동 적용', tone: 'ok' },
  'check-only': { label: '자동 확인만(적용은 수동)', tone: 'warn' },
  manual: { label: '자동 확인 안 함(수동)', tone: 'warn' },
  off: { label: '꺼짐', tone: 'muted' },
  blocked: { label: '설정이 모자라 적용할 수 없음', tone: 'bad' },
};

/** 백그라운드 확인 한 번의 결과 → 문구. 서버 TICK_OUTCOMES 와 1:1. */
export const TICK_TEXT = {
  'up-to-date': '최신 — 받을 새 버전이 없었습니다',
  available: '새 버전을 찾았지만 자동 적용이 꺼져 있어 적용하지 않았습니다',
  applying: '적용을 시작했지만 결과가 기록되기 전에 프로세스가 끝났습니다',
  applied: '새 버전을 적용했습니다',
  'apply-failed': '새 버전을 찾았지만 적용하지 못했습니다',
  'check-failed': '확인하지 못했습니다',
  error: '확인 중 오류가 났습니다',
};

/** 화면 버튼 동작 → 이름. */
export const ACTION_LABEL = { save: '설정 저장', check: '새 버전 확인', apply: '업그레이드 적용', restart: '프로세스 재시작' };

const MIN = 60_000;
/** 주기(ms) → '60분' · '2시간' · '1일 4시간'. 모르면 null. */
export function intervalText(ms) {
  const n = numOrNull(ms);
  if (n == null || n <= 0) return null;
  const m = Math.round(n / MIN);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60); const rm = m % 60;
  if (h < 24) return rm ? `${h}시간 ${rm}분` : `${h}시간`;
  const d = Math.floor(h / 24); const rh = h % 24;
  return rh ? `${d}일 ${rh}시간` : `${d}일`;
}

/** 앞으로 남은 시간 → '12분 뒤' · '1시간 5분 뒤' · '곧'. */
export function inText(ts, now = Date.now()) {
  const t = numOrNull(ts);
  if (t == null) return null;
  const d = t - now;
  if (d < MIN) return '곧';
  const m = Math.floor(d / MIN);
  if (m < 60) return `${m}분 뒤`;
  const h = Math.floor(m / 60); const rm = m % 60;
  if (h < 48) return rm ? `${h}시간 ${rm}분 뒤` : `${h}시간 뒤`;
  return `${Math.floor(h / 24)}일 뒤`;
}

const clock = (ts) => { const t = numOrNull(ts); return t == null ? '—' : new Date(t).toLocaleString('ko-KR'); };

/** 기록 표지 — 재시작 전 기록이면 그 사실을 말한다(지금 확인한 것처럼 보이지 않게). */
export const restoredNote = (rec) => (rec && rec.restored ? '재시작 전 기록' : null);
export const triggerText = (t) => (t === 'auto' ? '자동(백그라운드)' : t === 'manual' ? '화면에서 실행' : null);

/** '자동 적용' 행 — 주기 0 이면 그 사실을 함께 말한다(예전에는 '예' 만 보였다). */
export function autoApplyRowText(status) {
  if (!status) return '—';
  const iv = intervalText(status.auto?.intervalMs ?? status.pollIntervalMs);
  const apply = status.autoApply ? '예' : '아니오';
  if (!status.enabled) return `${apply} · 자동 업그레이드 꺼짐`;
  return iv ? `${apply} · ${iv} 주기` : `${apply} · 확인 주기 0분(끔) — 자동 확인을 하지 않습니다`;
}

/**
 * '자동 업그레이드 동작' 칸 요약. 서버가 auto 를 보내지 않으면(구버전) null — 지어내지 않는다.
 * @returns {null|{label:string, tone:string, lines:{code:string,title:string,fix:string,reason:string|null,when:string|null}[], next:string, tick:string|null, tickTone:string}}
 */
export function autoSummary(status, now = Date.now()) {
  const a = status && status.auto;
  if (!a || typeof a !== 'object' || !STATE_TEXT[a.state]) return null;
  const st = STATE_TEXT[a.state];
  const lines = (Array.isArray(a.issues) ? a.issues : []).map((i) => {
    const t = AUTO_TEXT[i?.code] || { title: `알 수 없는 사유(${String(i?.code || '—')})`, fix: '' };
    return { code: String(i?.code || ''), title: t.title, fix: t.fix, reason: i?.reason ? String(i.reason) : null, when: i?.at ? agoText(i.at, now) : null };
  });
  const failing = lines.some((l) => l.code === 'check-failed' || l.code === 'apply-failed');
  const tone = st.tone === 'ok' && failing ? 'warn' : st.tone;
  let next;
  if (a.state === 'off') next = '자동 확인을 하지 않습니다(꺼짐)';
  else if (!(numOrNull(a.intervalMs) > 0)) next = '자동 확인을 하지 않습니다(확인 주기 0분)';
  else if (status.ticking) next = '지금 확인 중입니다';
  else if (numOrNull(a.nextCheckAt) != null) next = `${clock(a.nextCheckAt)} (${inText(a.nextCheckAt, now)}) · ${intervalText(a.intervalMs)} 주기`;
  else next = '예정 시각을 알 수 없습니다(타이머가 무장되지 않았습니다 — 설정을 다시 저장해 보세요)';
  const tk = status.lastTick;
  let tick = null; let tickTone = 'muted';
  if (tk && typeof tk === 'object' && numOrNull(tk.at) != null) {
    const base = TICK_TEXT[tk.outcome] || TICK_TEXT.error;
    const ver = tk.latest ? ` (최신 v${tk.latest})` : '';
    const why = tk.reason ? ` — ${tk.reason}` : '';
    tick = `${clock(tk.at)} (${agoText(tk.at, now)}) · ${base}${ver}${why}${tk.restored ? ' · 재시작 전 기록' : ''}`;
    tickTone = tk.outcome === 'applied' || tk.outcome === 'up-to-date' ? 'ok' : tk.outcome === 'available' ? 'warn' : 'bad';
  }
  return { label: st.label, tone, lines, next, tick, tickTone };
}

/** 마지막 백그라운드 확인이 없을 때의 문장 — 주기가 있으면 '아직 첫 확인 전', 없으면 '자동 확인을 하지 않는다'. */
export function noTickText(status) {
  const a = status && status.auto;
  if (!a) return '';
  if (a.state === 'off' || !(numOrNull(a.intervalMs) > 0)) return '자동 확인 기록 없음 — 자동 확인을 하지 않는 설정입니다';
  return '이 포탈이 시작된 뒤 아직 자동 확인 기록이 없습니다';
}

/** 적용 결과 한 줄 — { text, tone }. */
export function resultSummary(r) {
  if (!r || typeof r !== 'object') return null;
  const when = clock(r.at);
  const who = triggerText(r.trigger);
  const src = r.source ? ` · ${r.source}` : '';
  const tail = `${who ? ` · ${who}` : ''}${src}${r.restored ? ' · 재시작 전 기록' : ''}`;
  if (r.ok) return { text: `${when} · 성공 — v${r.from || '?'} → v${r.version || '?'}${r.restarting ? ' · 재시작' : ''}${tail}`, tone: 'ok' };
  if (r.upToDate) return { text: `${when} · 이미 최신${tail}`, tone: 'muted' };
  return { text: `${when} · 실패 — ${r.reason || '사유 없음'}${tail}`, tone: 'bad' };
}

/**
 * 버튼 결과 문구 — { label, ok, text }. 예전에는 '새 버전 확인' 응답에 ok 필드가 없어 확인이 성공해도 '실패' 로 보였다.
 */
export function actionMsg(action, r) {
  const label = ACTION_LABEL[action] || String(action || '');
  const x = r && typeof r === 'object' ? r : {};
  if (action === 'check' && x.ok === undefined && (x.remote || x.watch)) {
    const remErr = x.remote && x.remote.ok === false ? x.remote.error || '원격 확인 실패' : null;
    const newer = x.watch?.available ? `감시 폴더에 새 버전 v${x.watch.version}` : x.remote?.available ? `새 버전 v${x.remote.latest}` : null;
    if (newer) return { label, ok: true, text: `${newer} 이(가) 있습니다 — ‘업그레이드 적용 + 재시작’ 을 누르면 설치합니다${remErr ? ` (원격: ${remErr})` : ''}` };
    if (remErr) return { label, ok: false, text: remErr };
    return { label, ok: true, text: `최신입니다${x.remote?.latest ? ` (v${x.remote.latest})` : ''}` };
  }
  if (action === 'check' && x.ok === undefined) return { label, ok: false, text: '확인할 곳이 없습니다(원격 소스·감시 폴더 미설정)' };
  if (x.ok && x.note) return { label, ok: true, warn: true, text: x.note };
  if (x.ok) {
    const v = x.version ? ` — v${x.from || '?'} → v${x.version}` : '';
    return { label, ok: true, text: `성공${v}${x.backup ? ` (백업: ${x.backup})` : ''}${x.restarting ? ' · 재시작 중' : ''}` };
  }
  return { label, ok: false, text: x.reason || '실패' };
}
