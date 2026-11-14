/**
 * diskBadText.js — 디스크 배드 섹터 분석 화면의 문구 · 색 판정(순수, v3.8.0). vitest 로 고정한다.
 *
 * 판정(아직 사용 중 · 교체됨 · 판단 불가 · 근거)은 서버(`server/src/diskbad/verdict.js`)가 하고 라벨도 서버가 내려준다.
 * 여기서는 **보여 주는 방법**만 정한다 — 값이 없으면 '—'(단위를 붙이지 않는다), 못 읽음은 0 이 아니다.
 */

const p2 = (n) => String(n).padStart(2, '0');

/** 날짜(브라우저 시간대). 값이 없으면 '—'. */
export function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function fmtDateTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${fmtDate(ms)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 'n년 m개월' · 'n개월' · 'n일' · 이틀 미만은 'n시간'(0일로 보이지 않게 — v3.8.2). 값이 없으면 '—'. */
export function spanText(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return '—';
  const days = Math.floor((toMs - fromMs) / 86_400_000);
  if (days < 2) return `${Math.max(1, Math.floor((toMs - fromMs) / 3_600_000))}시간`;
  if (days < 62) return `${days}일`;
  const months = Math.floor(days / 30.44);
  const y = Math.floor(months / 12); const m = months % 12;
  return y ? `${y}년${m ? ` ${m}개월` : ''}` : `${m}개월`;
}

export const num = (v) => (Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—');
export function rateText(v, digits = 1) { return Number.isFinite(v) ? v.toFixed(digits) : '—'; }
export function pctText(v) { return Number.isFinite(v) ? `${v.toFixed(2)}%` : '—'; }

/** 분류 → 배지 색(빨강 = 복구 불가 · 주황 = 고쳐 씀/옮김/표 참 · 파랑 = 고장 예측 · 회색 = 그 밖). */
export function clsTone(cls) {
  if (cls === 'unrecoverable') return 'red';
  if (cls === 'corrected' || cls === 'reassigned' || cls === 'remapTable') return 'amber';
  if (cls === 'predictive') return 'blue';
  return 'gray';
}
export function verdictTone(v) { return v === 'inUse' ? 'red' : v === 'replaced' ? 'gray' : 'amber'; }
export function confidenceTone(c) { return c === 'confirmed' ? 'green' : c === 'estimated' ? 'amber' : 'gray'; }
export function statusTone(s) {
  if (s === 'records') return 'red';
  if (s === 'partial' || s === 'unwatched') return 'amber';
  if (s === 'clean') return 'gray';
  return 'gray';
}

/** 기록 ID 의 주석(근거 표에서). 없으면 ''. */
export function noteOf(code, refs) {
  const r = (refs || []).find((x) => x.id === code);
  return r ? r.note : '';
}
export function clsOfCode(code, refs) {
  const r = (refs || []).find((x) => x.id === code);
  return r ? r.cls : (/^(PDR|VDR)/.test(String(code || '')) ? 'other' : '');
}

/**
 * 서버 상세의 판정 띠. 못 읽음 · 일부만 읽음은 판정하지 않는다 — '기록 없음' 은 '발생한 적 없음' 이 아니다.
 * @returns {{tone:string, title:string, lines:string[]}}
 */
export function serverBand(view, now = Date.now()) {
  if (!view) return { tone: 'neutral', title: '아직 조회하지 않았습니다', lines: ['Lifecycle 로그 전체를 읽는 작업이라 탭을 열 때 자동으로 돌지 않습니다. 점검을 누르면 이 서버를 맡은 노드(법인 엣지 또는 중앙)가 읽어 옵니다.'] };
  const cov = view.coverage || {};
  // 구간은 **끊김 없이 본 구간**(continuousSince)으로 말한다 — '지금까지 본 가장 오래된 시각'(coveredFrom)은 사이에 못 본 틈이 있어도 내려간다(반증 3.8.2 #1).
  const from = cov.continuousSince;
  const span = Number.isFinite(from) ? `${fmtDate(from)} ~ ${fmtDate(now)} (${spanText(from, now)})` : '구간 모름';
  if (view.status === 'unread') {
    return { tone: 'err', title: cov.lastStatusLabel ? `읽지 못했습니다 — ${cov.lastStatusLabel}` : '아직 읽지 못했습니다', lines: ['배드 섹터 유무는 판정하지 않았습니다.', ...(cov.lastReason ? [cov.lastReason] : [])] };
  }
  // 과거 기록 읽기 1단계: 로그 기록이 없는 디스크의 누적 값에 흔적이 있으면 띠가 말한다(날짜는 모른다 — 서버 verdict.js traceOf).
  const traces = Number.isFinite(view.counts?.traces) ? view.counts.traces : 0;
  const traceLine = traces > 0 ? [`로그 기록이 없는 디스크 ${traces}개의 누적 값에 흔적(재할당 · 보류 · 복구 불가)이 있습니다 — 값은 누적이라 언제 생겼는지 모릅니다. 아래 ‘디스크 값’ 표를 보세요.`] : [];
  const unrecTrace = Array.isArray(view.diskVals) && view.diskVals.some((d) => d && d.trace === 'unrecoverable');
  if (view.status === 'records') {
    const c = view.counts || {};
    return { tone: 'bad', title: `배드 섹터 기록이 있습니다 — ${c.records}건 · 디스크 자리 ${c.slots}곳`, lines: [
      `아직 사용 중 ${c.inUse} · 교체됨 ${c.replaced} · 판단 불가 ${c.unknown}`, `끊김 없이 본 구간 ${span}`, ...traceLine] };
  }
  if (view.status === 'unwatched') return { tone: unrecTrace ? 'bad' : 'warn', title: '이 방법으로는 볼 수 없는 서버입니다', lines: ['디스크가 RAID 로 묶여 있지 않아(HBA · 패스스루) Patrol Read 가 돌지 않습니다 — ‘기록 없음’ 이 아닙니다.', ...traceLine] };
  if (view.status === 'partial') {
    const why = READ_STOP_LABEL[cov.readStop] || '';
    return { tone: unrecTrace ? 'bad' : 'warn', title: '일부만 읽었습니다 — 읽은 구간에는 기록이 없습니다', lines: [`읽은 구간 ${span}. 다음 점검에서 처음부터 다시 읽습니다.`, ...(why ? [why] : []), ...traceLine] };
  }
  if (traces > 0) {
    return { tone: unrecTrace ? 'bad' : 'warn', title: `남은 로그에는 기록이 없지만, 디스크 값에 흔적이 있는 디스크가 ${traces}개 있습니다`, lines: [...traceLine,
      `끊김 없이 본 구간 ${span} — 로그의 ‘기록 없음’ 은 이 구간에서만의 말입니다.`] };
  }
  // v3.8.2: iDRAC 가 이 경로로 주는 것은 활성 로그로 보인다(Dell 안내서 검색 요약 + 실제 서버 1대) — 그 이전 기록이 '없다' 가 아니라 '여기서는 안 보인다' 이다.
  //   '며칠치뿐' 은 **활성 로그가 담은 기간**(서버 summary.logSpanOf — 시간이 지나도 늘지 않는다)으로 말하고, 기준 일수는 서버가 준 값을 쓴다(전 법인 경고와 같은 값).
  const spanMs = cov.logSpan?.ms;
  const limitDays = Number.isFinite(cov.shortLogDays) ? cov.shortLogDays : 30;
  const short = Number.isFinite(spanMs) && spanMs < limitDays * 86_400_000;
  return { tone: short ? 'warn' : 'neutral', title: short ? `기록은 없지만, iDRAC 가 보여 주는 로그가 ${spanText(0, spanMs)}치뿐입니다` : '남아 있는 로그에는 배드 섹터 기록이 없습니다',
    lines: [`끊김 없이 본 구간 ${span} · 그 이전 기록은 iDRAC 가 보여 주는 로그에 없어 확인하지 못했습니다(보관 로그로 넘어갔을 수 있고, 이 기능은 아직 보관 로그를 읽지 않습니다). ‘발생한 적 없음’ 이 아니라 ‘이 구간에 기록 없음’ 입니다.`] };
}

/** 끝까지 못 읽은 이유(서버 db.js read_stop). 모르는 값은 말하지 않는다. */
export const READ_STOP_LABEL = Object.freeze({
  budget: '서버 한 대에 쓰는 시간이 다 차서 멈췄습니다.',
  max: '한 번에 읽는 항목 수 상한에 닿아 멈췄습니다.',
  skip: '이 iDRAC 가 쪽 넘김($skip)을 받지 않아 첫 쪽만 읽었습니다 — 펌웨어를 확인하세요. 이 서버는 이 방법으로 끝까지 읽을 수 없습니다.',
  capped: '배드 섹터 계열 기록이 한 번에 5,000건을 넘어 가장 새 것만 남겼습니다 — 그보다 오래된 구간은 본 것으로 치지 않습니다.',
  short: 'iDRAC 가 알려 준 건수보다 먼저 빈 쪽을 줘서 도중에 멈췄습니다 — 그 아래 구간은 읽지 못했습니다.',
  empty: 'iDRAC 가 로그 항목을 하나도 주지 않았습니다 — 로그가 비었거나 이 장비의 응답 모양이 달라 읽지 못한 것입니다.',
});

/**
 * 읽기 진단(서버 db.js read_diag — 처음부터 읽은 점검이 **무엇을 읽었는지**). 판정이 아니라 사실만 말한다.
 * @returns {{lines:string[], warn:string}|null}
 */
export function diagInfo(diag) {
  if (!diag || typeof diag !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—');
  const lines = [];
  const sec = Number.isFinite(diag.ms) ? `${Math.max(1, Math.round(diag.ms / 1000)).toLocaleString('ko-KR')}초` : '—';
  lines.push(`처음부터 읽은 점검(${fmtDateTime(diag.at)}): ${n(diag.read)}건 · ${n(diag.pages)}쪽 · ${sec}${diag.reachedEnd ? ' · iDRAC 가 준 끝까지 읽음' : ' · 끝까지 읽지 못함'}${diag.path === 'legacy' ? ' · 옛 경로(Logs/Lclog)' : ''}`);
  if (Number.isFinite(diag.oldest)) lines.push(`읽은 로그의 범위: ${fmtDateTime(diag.oldest)} ~ ${fmtDateTime(diag.newest)} (${spanText(diag.oldest, Number.isFinite(diag.newest) ? diag.newest : diag.at)})${diag.oldestCode ? ` · 가장 오래된 항목 ${diag.oldestCode}` : ''}`);
  const top = Array.isArray(diag.top) ? diag.top.filter((x) => x && x.code) : [];
  if (top.length) lines.push(`많이 나온 기록 ID: ${top.map((x) => `${x.code} ${n(x.n)}`).join(' · ')}${Number.isFinite(diag.distinct) && diag.distinct > top.length ? ` · 그 밖 ${n(diag.distinct - top.length)}종` : ''}`);
  let warn = '';
  if (Number.isFinite(diag.loginShare) && diag.loginShare >= 0.5) {
    warn = `읽은 로그의 ${Math.floor(diag.loginShare * 100)}% 이상이 로그인 계열로 보이는 기록(${(diag.loginCodes || []).join(' · ')})${diag.repeatCode ? `과 그 반복 표시(${diag.repeatCode})` : ''}입니다 — 위 ‘많이 나온 기록 ID’ 로 직접 확인할 수 있습니다. 이런 기록이 로그를 채우면 그 이전의 디스크 기록은 보관 로그로 넘어갔을 수 있습니다.`;
  }
  return { lines, warn };
}

/**
 * 점검 요청의 답을 화면 문구로(v3.8.3). 서버는 시작하지 못한 점검을 409 + `ok:false` + reason 으로 답하고, api.js 는 409 를 던지지 않는다 —
 * 그래서 답을 보지 않으면 건너뛰어진 점검도 '보냈습니다' 가 된다(실사용에서 서버 한 대 점검이 조용히 건너뛰어졌다).
 * @returns {{ok:boolean, text:string}}
 */
export function scanSent(r, okText = '점검을 보냈습니다 — 이 서버를 맡은 노드가 읽고 나면 아래가 바뀝니다. 서버 한 대를 직접 점검하면 장비 진단(이 iDRAC 가 무엇을 주는지)도 함께 받아 옵니다 — 장비 진단은 관리자 화면에만 보입니다.') {
  if (r && r.ok === false) return { ok: false, text: String(r.reason || '점검을 시작하지 못했습니다.') };
  return { ok: true, text: okText };
}

/**
 * 전 법인 요약의 경고 — 로그가 며칠치뿐인 서버가 있으면 '0' 이 '과거에 없었다' 로 읽히지 않게 말한다. 없으면 null.
 * @returns {{title:string, body:string}|null}
 */
export function shortLogNote(T) {
  if (!T || !Number.isFinite(T.shortLog) || T.shortLog <= 0) return null;
  const days = Number.isFinite(T.shortLogDays) ? T.shortLogDays : 30;
  const med = Number.isFinite(T.medianLogDays) ? ` 로그 길이의 가운데값은 ${T.medianLogDays < 2 ? `${Math.max(1, Math.round(T.medianLogDays * 24))}시간` : `${Math.round(T.medianLogDays)}일`}입니다.` : '';
  const login = Number.isFinite(T.loginHeavy) && T.loginHeavy > 0 ? ` 읽기 진단이 있는 ${num(T.diagKnown)}대 가운데 ${num(T.loginHeavy)}대는 읽은 로그의 절반 이상이 로그인 계열로 보이는 기록입니다.` : '';
  return {
    title: `읽은 서버 ${num(T.spanKnown)}대 가운데 ${num(T.shortLog)}대는 iDRAC 가 보여 주는 로그가 ${days}일치 미만입니다`,
    body: `iDRAC 가 이 경로로 보여 주는 것은 활성 로그로 보입니다(Dell 안내서 요약 기준 — 실제 서버에서 확인 중). 그 이전에 난 배드 섹터 기록은 이 결과에 없습니다 — 아래 수치의 ‘0’ 은 ‘과거에 없었다’ 가 아닙니다.${med}${login} 서버 탭에서 서버별 로그 길이를 봅니다.`,
  };
}

/** 디스크 값 판정(서버 verdict.js TRACE) → 배지 색. */
export function traceTone(t) {
  if (t === 'records' || t === 'unrecoverable') return 'red';
  if (t === 'trace') return 'amber';
  if (t === 'none') return 'green';
  return 'gray';
}
/** 출처 상태(서버 summary.js SOURCE_STATUS_LABEL) → 배지 색. 못 읽음 · 장비에 없음은 '정상' 색이 아니다. */
export function sourceTone(s) {
  if (s === 'ok') return 'green';
  if (s === 'forbidden' || s === 'error' || s === 'timeout' || s === 'auth') return 'red';
  if (s === 'absent') return 'amber';
  return 'gray';
}
/** 건수 칸 — 못 읽은 값은 '—'(0 이 아니다). */
export const valCell = (v) => (Number.isFinite(v) ? v.toLocaleString('ko-KR') : '—');

/**
 * 출처 표(과거 기록 읽기 1단계 — 어디까지 봤나). 서버가 준 값만 쓴다 — 기간을 모르면 '—'.
 * @returns {Array<{key:string, name:string, what:string, range:string, rangeSort:number|null, count:string, status:string, statusLabel:string, at:number|null, note:string}>}
 */
export function sourceRows(cov) {
  if (!cov) return [];
  const d = cov.diag || null;
  const lcFrom = Number.isFinite(d?.oldest) ? d.oldest : cov.continuousSince;
  const lcTo = Number.isFinite(d?.newest) ? d.newest : cov.lastOkAt;
  const rangeOf = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? `${fmtDate(a)} ~ ${fmtDate(b)} (${spanText(a, b)})` : '—');
  const s = cov.sel || {};
  const v = cov.vals || {};
  const selKept = Number.isFinite(s.keptFrom) && (!s.range || !Number.isFinite(s.range.oldest) || s.keptFrom < s.range.oldest)
    ? `포탈이 보관한 디스크 항목은 ${fmtDate(s.keptFrom)} 부터입니다(그 뒤 SEL 이 지워졌거나 넘어갔습니다).` : '';
  const stale = (x) => (x.stale || (x.status !== 'ok' && x.status !== 'never' && Number.isFinite(x.at)) ? `이번 점검(${fmtDateTime(x.tryAt)})에는 못 읽어 ${fmtDateTime(x.at)} 에 읽은 것을 보입니다.` : '');
  return [
    { key: 'lclog', name: '활성 Lifecycle 로그', what: '배드 섹터 계열 기록', range: rangeOf(lcFrom, lcTo), rangeSort: Number.isFinite(lcFrom) ? lcFrom : null,
      count: Number.isFinite(cov.logTotal) ? `${num(cov.logTotal)}건` : '—', status: cov.lastOkAt ? 'ok' : 'error', statusLabel: cov.lastOkAt ? '읽음' : (cov.lastStatusLabel || '읽기 실패'),
      at: cov.lastOkAt ?? null, note: '' },
    { key: 'sel', name: '시스템 이벤트 로그(SEL)', what: '디스크 탈거 · 장착 · 고장 시각', range: rangeOf(s.range?.oldest, s.range?.newest), rangeSort: Number.isFinite(s.range?.oldest) ? s.range.oldest : null,
      count: Number.isFinite(s.read) ? `${num(s.read)}건 · 디스크 항목 ${num(s.events)}건` : '—', status: s.status || 'never', statusLabel: s.label || '아직 읽지 않음', at: s.at ?? null,
      note: [selKept, stale(s)].filter(Boolean).join(' ') },
    { key: 'vals', name: '디스크 값', what: '재할당 · 보류 · 복구 불가(누적)', range: '날짜 없음 — 디스크가 만들어진 뒤의 누적', rangeSort: null,
      count: Number.isFinite(v.drives) && v.drives > 0 ? `디스크 ${num(v.drives)}개` : '—', status: v.status || 'never', statusLabel: v.label || '아직 읽지 않음', at: v.at ?? null,
      // 장비가 준 값 이름(메트릭 id) — 이름이 정해 둔 것과 달라 못 읽은 장비를 사용자가 직접 본다('항목 없음' 일 때 특히).
      note: [v.note || '', stale(v), Array.isArray(v.seen) && v.seen.length ? `장비가 준 값 이름: ${v.seen.slice(0, 12).join(' · ')}${v.seen.length > 12 ? ` 외 ${v.seen.length - 12}개` : ''}` : ''].filter(Boolean).join(' ') },
  ];
}

/**
 * 전 법인 — 출처별 서버 수(과거 기록 읽기 1단계). 서버가 상태별로 센 값(T.valsBy · T.selBy)을 그대로 말한다. 옛 중앙 응답이면 null.
 * @returns {{vals:string, sel:string}|null}
 */
export function pastCoverageText(T) {
  if (!T || !T.valsBy || !T.selBy) return null;
  const n = (o, k) => (Number.isFinite(o[k]) ? o[k] : 0);
  const other = (o) => ['forbidden', 'error', 'timeout', 'auth'].reduce((a, k) => a + n(o, k), 0);
  const parts = (o, okWord) => [
    `${okWord} ${num(n(o, 'ok'))}대`,
    n(o, 'absent') ? `장비에 없음 ${num(n(o, 'absent'))}대` : '',
    n(o, 'empty') ? `항목 없음 ${num(n(o, 'empty'))}대` : '',
    other(o) ? `못 읽음 ${num(other(o))}대` : '',
    n(o, 'never') ? `아직 읽지 않음 ${num(n(o, 'never'))}대` : '',
  ].filter(Boolean).join(' · ');
  return {
    vals: `디스크 값 — ${parts(T.valsBy, '읽음')}${Number.isFinite(T.valsDisks) ? ` (값을 읽은 디스크 ${num(T.valsDisks)}개 · 값 모름 ${num(T.valsUnknownDisks)}개)` : ''}`,
    sel: `시스템 이벤트 로그 — ${parts(T.selBy, '읽음')}${Number.isFinite(T.selDriveEvents) ? ` (디스크 항목 ${num(T.selDriveEvents)}건)` : ''}`,
  };
}

/** 시스템 이벤트 로그 항목 종류(서버 sel.js SEL_KINDS). */
export const SEL_KIND_LABEL = Object.freeze({ removed: '빠짐', installed: '장착', fault: '고장', predictive: '고장 예측', other: '그 밖' });
export function selKindTone(k) { return k === 'fault' ? 'red' : k === 'predictive' ? 'blue' : k === 'removed' ? 'amber' : 'gray'; }

export const JOB_STATE_LABEL = Object.freeze({
  queued: '엣지 대기', running: '읽는 중', done: '끝남', failed: '실패', 'not-started': '시작 못 함', 'no-response': '응답 없음', stopped: '중단됨', busy: '다른 점검 진행 중',
});
export function jobStateTone(s) {
  if (s === 'done') return 'green';
  if (s === 'running' || s === 'queued') return 'blue';
  if (s === 'failed' || s === 'not-started' || s === 'no-response') return 'red';
  return 'gray';
}
export function unitProgress(u) {
  const total = Number.isFinite(u?.total) ? u.total : null;
  const done = Number.isFinite(u?.done) ? u.done : 0;
  return { done, total, pct: total ? Math.min(100, Math.round((done / total) * 100)) : null, text: `${done} / ${total ?? '?'}` };
}
export function scopeLabel(job) {
  if (!job) return '';
  if (job.scope === 'all') return '전체';
  if (job.scope === 'corp') return `법인 · ${job.targetLabel || job.target}`;
  return `서버 · ${job.targetLabel || job.target}`;
}

export const STATUS_REASON_LABEL = Object.freeze({ never: '아직 점검하지 않음' });
