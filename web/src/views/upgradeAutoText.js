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
  disabled: { title: '자동 업그레이드 사용이 꺼져 있습니다', fix: '아래 ‘자동 업그레이드 사용’ 을 켜고 설정을 저장하세요. 저장하기 전에는 확인·적용 버튼이 잠겨 있습니다.' },
  'no-source': { title: '확인할 곳이 없습니다(원격 소스·감시 폴더 둘 다 비어 있음)', fix: '원격 소스 URL 이나 감시 폴더 중 하나를 입력하세요.' },
  'no-interval': { title: '확인 주기가 0분(끔)이라 자동 확인을 하지 않습니다 — 자동 적용도 일어나지 않습니다', fix: '확인 주기(분)에 0 보다 큰 값(예: 60)을 넣고 설정을 저장하세요. 지금 바로 받으려면 ‘새 버전 확인’ → ‘업그레이드 적용 + 재시작’ 을 누르세요.' },
  'no-auto-apply': { title: '자동 적용이 꺼져 있어 새 버전을 찾아도 적용하지 않습니다', fix: '‘새 버전 발견 시 자동 적용 + 재시작’ 을 켜거나, 새 버전이 보이면 ‘업그레이드 적용 + 재시작’ 을 누르세요.' },
  'no-install-dir': { title: '설치 경로(installDir)가 없어 적용할 수 없습니다', fix: '‘서버에서 자동 감지’ 로 설치 경로를 채운 뒤 설정을 저장하세요.' },
  // 다시 시도 안내는 autoSummary 가 주기를 보고 붙인다(주기 0 이면 '다음 주기' 가 없다 — 리뷰 UPG-UI-03).
  'check-failed': { title: '마지막 확인이 실패했습니다', fix: '사유를 보고 원격 소스 주소·네트워크(프록시·방화벽)를 확인하세요.' },
  'apply-failed': { title: '마지막 적용이 실패했습니다', fix: '사유를 확인하세요. 같은 사유가 반복되면 자동 적용은 매 주기 같은 곳에서 멈춥니다.' },
  // v2.737: 실행 중 스캔(아이실론 du·iDRAC 대역·IP 대역)이 끝나면 적용한다 — 1분마다 다시 본다.
  'deferred-scans': { title: '새 버전을 찾았지만 실행 중인 스캔이 끝나기를 기다리고 있습니다', fix: '스캔이 끝나면 곧바로 적용하고 재시작합니다. 대기 상한을 넘기면 그대로 적용하고, 끊긴 스캔은 재시작 뒤 자동으로 다시 시작합니다. 바로 적용하려면 ‘업그레이드 적용 + 재시작’ 을 누르세요.' },
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
  // 재시작 전 기록일 때만 이 문장이다 — 지금 프로세스의 기록이면 아직 적용 중이다(APPLYING_NOW, 리뷰 UPG-UI-01).
  applying: '적용을 시작했지만 결과가 기록되기 전에 프로세스가 끝났습니다',
  applied: '새 버전을 적용했습니다',
  'apply-failed': '새 버전을 찾았지만 적용하지 못했습니다',
  'check-failed': '확인하지 못했습니다',
  'no-source': '확인할 곳이 없어 아무것도 확인하지 않았습니다(원격 소스·감시 폴더 미설정)',
  error: '확인 중 오류가 났습니다',
  deferred: '새 버전을 찾았지만 실행 중인 스캔이 끝나기를 기다리는 중입니다', // v2.737
};
/** 지금 프로세스가 적용 중일 때(lastTick.outcome 'applying' + 재시작 전 기록이 아님). */
export const APPLYING_NOW = '새 버전을 적용하는 중입니다 — 다운로드·엣지 배포가 끝나면 재시작합니다';

/** 적용 결과의 source 코드 → 이름(리뷰 UPG-UI-06 — 화면 버튼은 source 'auto' 를 보내 '화면에서 실행 · auto' 가 모순처럼 보였다). */
export const SOURCE_TEXT = {
  auto: '소스 자동 선택', watch: '감시 폴더', remote: '원격 소스', 'edge-push': '중앙에서 받은 번들', 'collector-push': '수집기로 받은 번들',
};
const sourceText = (v) => (v ? SOURCE_TEXT[v] || String(v) : null);

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
  const periodic = a.state !== 'off' && numOrNull(a.intervalMs) > 0;
  const lines = (Array.isArray(a.issues) ? a.issues : []).map((i) => {
    const t = AUTO_TEXT[i?.code] || { title: `알 수 없는 사유(${String(i?.code || '—')})`, fix: '' };
    let fix = t.fix;
    if (i?.code === 'check-failed') {
      fix += periodic ? ' 다음 확인 주기에 다시 시도합니다.' : ' 자동 확인을 하지 않는 설정이라, 고친 뒤 ‘새 버전 확인’ 을 눌러 다시 확인하세요.';
    }
    if (i?.code === 'deferred-scans' && numOrNull(i.until) != null) fix = `늦어도 ${clock(i.until)} (${inText(i.until, now)})에는 적용합니다. ${fix}`;
    return { code: String(i?.code || ''), title: t.title, fix, reason: i?.reason ? String(i.reason) : null, when: i?.at ? agoText(i.at, now) : null };
  });
  const noSource = lines.some((l) => l.code === 'no-source');
  const failing = lines.some((l) => l.code === 'check-failed' || l.code === 'apply-failed');
  const tone = st.tone === 'ok' && failing ? 'warn' : st.tone;
  let next;
  if (a.state === 'off') next = '자동 확인을 하지 않습니다(꺼짐)';
  else if (!(numOrNull(a.intervalMs) > 0)) next = '자동 확인을 하지 않습니다(확인 주기 0분)';
  else if (status.applying) next = '지금 새 버전을 적용하는 중입니다';
  else if (status.ticking) next = '지금 확인 중입니다';
  else if (noSource) next = '확인할 곳이 없어 자동 확인이 아무것도 확인하지 않습니다(원격 소스·감시 폴더 미설정)';
  else if (numOrNull(a.nextCheckAt) != null) next = `${clock(a.nextCheckAt)} (${inText(a.nextCheckAt, now)}) · ${intervalText(a.intervalMs)} 주기`;
  else next = '예정 시각을 알 수 없습니다(타이머가 무장되지 않았습니다 — 설정을 다시 저장해 보세요)';
  const tk = status.lastTick;
  let tick = null; let tickTone = 'muted';
  if (tk && typeof tk === 'object' && numOrNull(tk.at) != null) {
    const inProgress = tk.outcome === 'applying' && !tk.restored;
    const base = inProgress ? APPLYING_NOW : (TICK_TEXT[tk.outcome] || TICK_TEXT.error);
    const ver = tk.latest ? ` (최신 v${tk.latest})` : '';
    const why = tk.reason ? ` — ${tk.reason}` : '';
    tick = `${clock(tk.at)} (${agoText(tk.at, now)}) · ${base}${ver}${why}${tk.restored ? ' · 재시작 전 기록' : ''}`;
    tickTone = tk.outcome === 'applied' || tk.outcome === 'up-to-date' ? 'ok'
      : tk.outcome === 'deferred' ? 'warn'
      : inProgress ? 'muted' : tk.outcome === 'available' || tk.outcome === 'no-source' ? 'warn' : 'bad';
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
  const src = sourceText(r.source) ? ` · ${sourceText(r.source)}` : '';
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
  // 409 — 저장된 설정에서 '자동 업그레이드 사용' 이 꺼져 있다(체크만 하고 저장하지 않은 경우. 리뷰 UPG-UI-05).
  if (x.ok === false && x.reason === 'auto-upgrade disabled') return { label, ok: false, text: `${AUTO_TEXT.disabled.title} — ${AUTO_TEXT.disabled.fix}` };
  if (x.ok && x.note) return { label, ok: true, warn: true, text: x.note };
  if (x.ok) {
    const v = x.version ? ` — v${x.from || '?'} → v${x.version}` : '';
    return { label, ok: true, text: `성공${v}${x.backup ? ` (백업: ${x.backup})` : ''}${x.restarting ? ' · 재시작 중' : ''}` };
  }
  return { label, ok: false, text: x.reason || '실패' };
}

/**
 * v2.736.3: 확인 결과 '원격' 행의 라벨 — 예전에는 언제나 '원격(GitHub)' 이라 사내 미러(Nexus 등)를 쓰는 현장에서 오류 원인을
 *   GitHub 로 오해하게 했다(사용자 캡처: 사내 저장소 주소인데 '원격(GitHub) 오류'). 확인 결과의 `source`(계정·쿼리를 뗀 주소)로 정한다.
 *   GitHub 가 아니면 '원격 소스' 다(주소는 설정 칸에 이미 보인다 — 라벨은 줄바꿈하지 않아 긴 호스트 이름이 400px 에서 값 칸을 밀어낸다).
 *   주소를 못 읽어도 '원격 소스' 다(GitHub 라고 지어내지 않는다).
 */
export function remoteSourceLabel(source) {
  let host = '';
  try { host = new URL(String(source || '')).hostname.toLowerCase(); } catch { host = ''; }
  if (!host) return '원격 소스';
  if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')) return '원격(GitHub)';
  return '원격 소스';
}

/** v2.737: 실행 중 스캔 종류 → 이름(서버 util/scanJournal 의 kind). */
export const SCAN_KIND_TEXT = { isidu: '아이실론 디렉터리 사용량', 'idrac-scan': 'iDRAC 대역 스캔', ipscan: 'IP 스캔', 'ipscan-agent': 'IP 스캔(엣지)' };

/**
 * v2.737: 수동 적용 전 경고 — 지금 이 노드에서 도는 스캔이 있으면 그 목록을 말한다(없으면 null). 수동 적용은 기다리지 않는다.
 * @returns {null|string}
 */
export function runningScanWarning(status, now = Date.now()) {
  const list = Array.isArray(status?.runningScans) ? status.runningScans : [];
  if (!list.length) return null;
  const names = list.slice(0, 5).map((x) => `${SCAN_KIND_TEXT[x?.kind] || x?.kind || '스캔'}${x?.label ? ` ‘${x.label}’` : ''}${numOrNull(x?.since) != null ? `(${agoText(x.since, now)} 시작)` : ''}`);
  return `지금 스캔 ${list.length}개가 돌고 있습니다 — ${names.join(', ')}${list.length > 5 ? ' …' : ''}. 지금 적용하면 재시작으로 끊기고, 재시작 뒤 자동으로 다시 시작합니다(아이실론 분리 실행 du 는 결과를 이어 받습니다). 계속할까요?`;
}
