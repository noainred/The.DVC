/**
 * VM 원격 접속 버튼의 사전 도달성 점검 문구(순수 — 판정과 문구를 한 곳에 둔다).
 *
 * v2.744(최종 검토 리드 — FD 가 남긴 별건): `/remote/probe` 가 **403(범위 밖 대상)·404(범위 밖 vCenter)** 로 거부하면
 *   예전에는 그 오류를 '도달 불가' 로 그리고 버튼 툴팁이 '방화벽/포트/프록시 경로 확인' 이라 말했다 — 네트워크가 아니라 **계정 범위**가
 *   원인인데 사용자는 방화벽을 의심한다. 거부는 `denied` 로 따로 표시하고 서버가 준 사유를 그대로 보여 준다.
 *
 * v2.744(적대적 검토 VD — RV2744F-WEB-01): 403·404 를 **전부** '범위 밖 대상' 으로 단정하면 그것도 원인 오표시다.
 *   서버가 이 경로(`POST /api/remote/probe`)에서 거부하는 모양은 다섯 가지이고 조치가 다르다 — 거부 종류(`denyKind`)로 나눈다:
 *     · demo   — mock 데모 계정 거부: 403 `{error:'forbidden', demoGuest:true, reason}`(server/src/auth/demoGuest.js denyDemoGuest)
 *     · perm   — 기능 권한 거부: 403 `{error:'forbidden', requiredPerm:[…]}`(auth.js requirePerm('remote.access'))
 *     · role   — 역할 거부: 403 `{error:'forbidden', requiredRole:[…]}`(auth.js requireRole)
 *     · enroll — OTP 등록 전 세션: 403 `{error:'otp_enrollment_required', reason}`(auth.js requireEnrolled)
 *     · scope  — 범위 밖 대상 403 `{ok:false, reason}` · 범위 밖 vCenter 404 `{ok:false, reason}`(server/src/routes/remote.js /probe)
 *   표지가 하나도 없는 403(중간 프록시의 HTML 403 등)은 `unknown` — '범위' 라고 단정하지 않는다. 표지 없는 404 는 거부가 아니라
 *   점검 API 를 찾지 못한 것이라 '점검 못 함' 이다. 판정은 `web/src/api.js HttpError` 가 싣는 필드(status·demoGuest·requiredPerm·
 *   requiredRole·serverReason·body)만 본다.
 *
 * v2.744(적대적 검토 VD — RV2744F-WEB-02): `/remote/probe` 는 점검을 하지 못했을 때도 **200** `{ok:false, method:'none'|'ssh', reason}` 을
 *   준다(프록시 SSH 미설정 · 프록시 SSH 실패 · 프록시 호스트키 미신뢰). 그것은 '대상 VM 에 닿지 않음' 이 아니라 '확인하지 못함' 이다 —
 *   `unchecked` 로 따로 두고 서버 사유를 행에 보인다. 방화벽 안내·빨간색은 **실제로 점검한 결과(ok:true)가 닫혀 있을 때만** 쓴다.
 *   점검 요청 자체가 실패한 경우(시한 초과·5xx·표지 없는 404)도 같다.
 */

/** 서버가 준 사유만 남긴다(300자). 'forbidden' 같은 오류 코드는 사유가 아니다. */
function serverReasonOf(e) {
  return String(e?.serverReason || '').slice(0, 300);
}

/** 거부 종류 — 표지가 없으면 null(거부가 아님 · 404) 또는 'unknown'(403). */
function denyKindOf(status, e) {
  const body = e?.body && typeof e.body === 'object' ? e.body : null;
  if (status === 403) {
    if (e?.demoGuest === true || body?.demoGuest === true) return 'demo';
    if (Array.isArray(e?.requiredPerm) && e.requiredPerm.length) return 'perm';
    if (Array.isArray(e?.requiredRole) && e.requiredRole.length) return 'role';
    if (body?.error === 'otp_enrollment_required') return 'enroll';
    if (body?.ok === false && serverReasonOf(e)) return 'scope';
    return 'unknown';
  }
  if (status === 404 && body?.ok === false && serverReasonOf(e)) return 'scope';
  return null;
}

/** probe 실패(throw)를 화면 상태로 바꾼다 — 거부는 종류별 `denied`, 그 밖은 '점검 요청 실패'(점검 못 함). */
export function probeFailState(e) {
  const status = Number(e?.status) || 0;
  const kind = (status === 403 || status === 404) ? denyKindOf(status, e) : null;
  if (kind) {
    const need = kind === 'perm' ? e.requiredPerm.slice(0, 5).map(String)
      : kind === 'role' ? e.requiredRole.slice(0, 5).map(String) : null;
    return { loading: false, ok: false, denied: true, denyKind: kind, reason: serverReasonOf(e), ...(need ? { need } : {}), ...(status ? { status } : {}) };
  }
  const reason = (serverReasonOf(e) || String(e?.message || '')).slice(0, 300) || (status ? `HTTP ${status}` : '');
  return { loading: false, ok: false, requestFailed: true, reason, ...(status ? { status } : {}) };
}

/** 거부 종류별 짧은 글자(행 라벨). */
function deniedLabel(q) {
  switch (q.denyKind) {
    case 'demo': return '데모 계정 제한';
    case 'perm': return `권한 없음(필요 권한 ${(q.need || []).join(', ') || '원격 접속'})`;
    case 'role': return `권한 없음(필요 역할 ${(q.need || []).join('/') || '운영자 이상'})`;
    case 'enroll': return 'OTP 등록 필요';
    case 'scope': return q.status === 404 ? '범위 밖 vCenter(계정 권한)' : '범위 밖 대상(계정 권한)';
    case 'unknown': return '점검 요청 거부됨(사유 미상)';
    // 옛 상태 객체(denyKind 없이 denied 만) — 이 판의 probeFailState 는 만들지 않는다. 원인을 단정하지 않는다.
    default: return '점검 요청 거부됨';
  }
}

/** 점검을 하지 못한 이유(짧은 말) — 모르면 ''. */
function uncheckedShort(q) {
  if (q.requestFailed) return '점검 요청 실패';
  if (q.method === 'none') return '프록시 SSH 미설정';
  if (/SSH_HOSTKEY_UNTRUSTED/.test(String(q.reason || ''))) return '프록시 호스트키 미신뢰';
  if (q.method === 'ssh') return '프록시 SSH 실패';
  return '';
}

/** 점검을 하지 못한 이유의 짧은 글자(행 라벨). */
function uncheckedLabel(q) {
  const s = uncheckedShort(q);
  return s ? `점검 못 함(${s})` : '점검 못 함';
}

/**
 * IP 한 줄의 상태(st)·짧은 글자(label)·서버 사유를 붙인 글자(text).
 * st: pending | denied | up | warn | unchecked | down — down 은 **실제로 점검했고(ok:true) 닫힌 것**뿐이다.
 */
export function probeRow(p) {
  const q = p || { loading: true };
  if (q.loading) return { st: 'pending', label: '확인 중…', text: '확인 중…' };
  const withReason = (label) => (q.reason ? `${label} — ${q.reason}` : label);
  if (q.denied) { const label = deniedLabel(q); return { st: 'denied', label, text: withReason(label) }; }
  if (q.portOpen) { const label = `접속 가능 · 포트 열림${q.pingOk ? ` · ping ${q.pingMs}ms` : ''}`; return { st: 'up', label, text: label }; }
  if (q.pingOk) return { st: 'warn', label: '포트 닫힘(ping만 응답)', text: '포트 닫힘(ping만 응답)' };
  if (q.ok !== true) { const label = uncheckedLabel(q); return { st: 'unchecked', label, text: withReason(label) }; }
  return { st: 'down', label: '도달 불가', text: '도달 불가' };
}

/** 거부 종류별 버튼 툴팁 문장(전부 거부일 때). */
function deniedSentence(q) {
  const why = q?.reason ? `(서버: ${q.reason})` : '';
  switch (q?.denyKind) {
    case 'demo': return `데모 계정은 원격 접속 사전 점검을 할 수 없습니다 — 네트워크 문제가 아닙니다${why}`;
    case 'perm': return `이 계정에 원격 접속 권한(${(q.need || []).join(', ') || '원격 접속'})이 없습니다 — 네트워크 문제가 아닙니다${why}`;
    case 'role': return `이 작업은 ${(q.need || []).join('/') || '운영자 이상'} 역할이 필요합니다 — 네트워크 문제가 아닙니다${why}`;
    case 'enroll': return `OTP 등록을 마쳐야 사전 점검을 할 수 있습니다 — 네트워크 문제가 아닙니다${why}`;
    case 'scope': return `이 계정의 범위 밖 대상입니다 — 네트워크 문제가 아닙니다${why}`;
    default: return `서버가 사전 점검 요청을 거부했습니다${q?.status ? `(HTTP ${q.status})` : ''} — 대상 VM 의 도달 여부는 확인하지 못했습니다${why}`;
  }
}

/** IP 묶음의 상태 분류 — 툴팁·색·모달 하단 문구가 같은 분류를 쓴다. */
function classify(ips, probes) {
  const rows = ips.map((x) => ({ ip: x, q: probes[x], st: probeRow(probes[x]).st }));
  const of = (st) => rows.filter((r) => r.st === st);
  return { rows, open: of('up'), warn: of('warn'), down: of('down'), unchecked: of('unchecked'), denied: of('denied'), pending: of('pending') };
}

/** 거부 종류의 짧은 말(개수 요약용 — 괄호를 겹치지 않게 행 라벨보다 짧다). */
function deniedShort(q) {
  switch (q?.denyKind) {
    case 'demo': return '데모 계정 제한';
    case 'perm': return '권한 없음';
    case 'role': return '역할 부족';
    case 'enroll': return 'OTP 등록 필요';
    case 'scope': return q.status === 404 ? '범위 밖 vCenter' : '범위 밖 대상';
    default: return '사유 미상';
  }
}

/** 거부된 IP 들을 종류별 개수로 — '범위 밖 대상 2 · 데모 계정 제한 1'. */
function deniedSummary(denied) {
  const counts = new Map();
  for (const r of denied) { const k = deniedShort(r.q || {}); counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts].map(([k, n]) => `${k} ${n}`).join(' · ');
}

/** 점검 못 한 이유 — 짧은 말(여럿이면 함께) + 첫 서버 사유(같은 프록시라 보통 같다). */
function uncheckedWhy(unchecked) {
  const shorts = [...new Set(unchecked.map((r) => uncheckedShort(r.q || {})).filter(Boolean))];
  const first = unchecked.find((r) => r.q?.reason)?.q?.reason || '';
  return [shorts.join(' · '), first].filter(Boolean).join(': ') || '사유 미상';
}

/**
 * 버튼 툴팁 — 실제로 점검한 결과만 '접속 불가 · 방화벽' 으로 말하고, 거부·점검 못 함은 각자의 사실을 말한다.
 * @param {{canRemote:(boolean|null), ips:string[], probes:Record<string, object>, probePort:number}} o
 */
export function probeTip({ canRemote, ips = [], probes = {}, probePort }) {
  if (canRemote === false) return '원격 접속은 operator/admin 권한이 필요합니다.';
  if (!ips.length) return '수집된 IP가 없습니다.';
  if (ips.some((x) => probes[x]?.loading)) return '프록시 경유 접속 점검 중…';
  const c = classify(ips, probes);
  if (c.open.length) return `접속 가능 IP: ${c.open.map((r) => r.ip).join(', ')} (:${probePort})`;
  const checked = c.warn.length + c.down.length;
  const deniedTail = c.denied.length ? ` · ${c.denied.length}개 IP 는 점검 요청이 거부돼 확인하지 못했습니다(${deniedSummary(c.denied)})` : '';
  const uncheckedTail = c.unchecked.length ? ` · ${c.unchecked.length}개 IP 는 사전 점검을 하지 못했습니다(${uncheckedWhy(c.unchecked)})` : '';
  if (checked) {
    const head = checked === ips.length ? `모든 IP 접속 불가(:${probePort})` : `점검한 ${checked}개 IP 접속 불가(:${probePort})`;
    return `${head} — 방화벽/포트/프록시 경로 확인${uncheckedTail}${deniedTail}`;
  }
  if (c.denied.length === ips.length) {
    const kinds = new Set(c.denied.map((r) => r.q?.denyKind || ''));
    return kinds.size === 1 ? deniedSentence(c.denied[0].q) : `모든 IP 의 사전 점검 요청이 거부됐습니다(${deniedSummary(c.denied)}) — 대상 VM 의 도달 여부는 확인하지 못했습니다`;
  }
  // 점검한 IP 가 없고 점검 못 함이 있다 — 대상 VM 의 도달 여부는 모른다.
  return `사전 점검을 하지 못했습니다(${uncheckedWhy(c.unchecked)}) — 대상 VM 의 도달 여부는 확인하지 못했습니다${deniedTail}`;
}

/** 버튼 색 — 실제로 점검해 닫힌 IP 가 있을 때만 빨강, 거부·점검 못 함만이면 회색(장애색 금지). */
export function probeColor({ canRemote, ips = [], probes = {} }) {
  if (canRemote === false) return '#94a3b8';
  if (!ips.length) return '#f59e0b';
  if (ips.some((x) => probes[x]?.loading)) return null;
  const c = classify(ips, probes);
  if (c.open.length) return '#22c55e';
  if (c.warn.length + c.down.length) return '#f87171';
  return '#94a3b8';
}

/** 모달 하단 한 줄 — 툴팁과 같은 분류를 쓴다. */
export function probeFooter({ canRemote, ips = [], probes = {}, probePort }) {
  if (ips.some((x) => probes[x]?.loading)) return '도달성 확인 중…';
  const c = classify(ips, probes);
  if (c.open.length) return `✅ 접속 가능 IP: ${c.open.map((r) => r.ip).join(', ')} — 선택한 IP로 접속합니다.`;
  const tip = probeTip({ canRemote, ips, probes, probePort });
  if (ips.length && c.denied.length === ips.length) return `⛔ ${tip}`;
  if (ips.length && c.down.length + c.warn.length === ips.length) return '⚠ 열린 포트가 없습니다. 그래도 선택한 IP로 접속을 시도할 수 있습니다.';
  return `⚠ ${tip}. 그래도 선택한 IP로 접속을 시도할 수 있습니다.`;
}
