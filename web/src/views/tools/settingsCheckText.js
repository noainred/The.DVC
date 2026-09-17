/**
 * settingsCheckText.js — 설정 전수 점검의 **문구와 해결책**(순수, v2.553).
 *
 * 사용자 요청: "설정에 있는 모든 통신이 되는지 점검하고 **해결책 제시**하는 기능".
 * 서버(`linkcheck/remedy.js`)가 코드 + 근거만 주고 **문장은 여기서** 만든다
 * (v2.517 규약 — 판정은 서버 순수 모듈, 문구는 웹 순수 모듈).
 *
 * ⚠⚠ **조언이 틀리면 무음 실패보다 나쁘다**(v2.525 실제 사고): 사용자가 그 말을 믿고 멀쩡한
 *   설정을 고친다. 그래서 ① 근거가 없으면 문장을 만들지 않고 ② 종류마다 다른 정답 형식을
 *   서버의 `hostForm` 에서 받아 쓰고 ③ 조치가 없으면 빈 문자열이다(지어내지 않는다).
 *
 * ⚠⚠ **화면 문구에 백틱을 쓰지 말 것**(v2.439·2.440·2.505·2.545 실제 사고): `BoldText` 는
 *   `**강조**` 만 해석하고 백틱은 **글자로 샌다**. 값을 인용할 때는 홑화살괄호 ‘ ’ 를 쓴다.
 *   (v2.553 초판이 백틱을 썼고 자체 검사에서 잡았다.)
 */
const t = (v) => String(v ?? '').trim();
const q = (v) => `‘${t(v)}’`;

export const SEVERITY_LABEL = Object.freeze({ blocker: '차단', warn: '주의', info: '참고' });

export function severityTone(sev) {
  if (sev === 'blocker') return 'var(--bad, #ef5a5a)';
  if (sev === 'warn') return 'var(--warn, #e8b23a)';
  return 'var(--muted)';
}

/** 종류별 '정답 형식' 문구 — 서버 `HOST_FORM` 과 짝이다. */
const FORM_TEXT = Object.freeze({
  url: '스킴을 포함한 URL(‘https://호스트’)',
  host: '스킴 없는 **주소만**(‘10.0.0.1’ 또는 ‘호스트명’)',
  either: '주소만 또는 URL 둘 다',
  ldap: '‘ldap://’ 또는 ‘ldaps://’ 로 시작하는 URL',
});

/** 발견 하나 → `{ title, detail, action }`. `action` 은 사용자가 할 일이고, 모르면 빈 문자열이다. */
export function remedyText(finding = {}, ctx = {}) {
  const f = finding.facts || {};
  const formText = FORM_TEXT[t(ctx.hostForm)] || '';
  const formTail = formText ? ` — 이 종류는 ${formText} 형식입니다` : '';
  switch (t(finding.code)) {
    case 'address-empty':
      return { title: '주소가 비어 있습니다', detail: '등록 항목에 host/url 이 없어 점검할 대상이 없습니다.', action: `설정에서 주소를 넣으세요${formTail}.` };
    case 'address-unparsable':
      return { title: '주소를 해석할 수 없습니다', detail: t(f.reason), action: `등록된 ${q(f.address)} 를 고치세요${formTail}.` };
    case 'address-whitespace':
      return { title: '주소에 공백이 있습니다', detail: `${q(f.address)} — 붙여넣기 사고의 최다 원인이고 화면에서는 보이지 않습니다.`, action: '앞뒤·중간 공백을 지우세요.' };
    case 'scheme-in-host':
      return {
        title: '주소에 스킴(https://)이 붙어 있습니다',
        detail: `이 종류는 ${formText || '주소만'} 형식이라, 스킴이 붙으면 수집기가 접속하지 못합니다.`,
        action: `${q(f.stripped)} 로 고치세요.`,
      };
    case 'scheme-missing':
      return {
        title: '주소에 스킴이 없습니다',
        detail: `이 종류는 ${formText || '스킴을 포함한 URL'} 이 **필수**입니다.`,
        action: `${q(`https://${t(f.address)}`)} 처럼 스킴을 붙이세요(평문이면 http://).`,
      };
    case 'ldap-scheme-wrong':
      return { title: 'LDAP 스킴이 아닙니다', detail: q(f.address), action: '‘ldaps://호스트:636’(권장) 또는 ‘ldap://호스트:389’ 로 고치세요.' };
    case 'path-in-host':
      return { title: '주소에 경로가 들어 있습니다', detail: `${q(f.address)} — 이 종류는 호스트만 씁니다.`, action: '경로를 지우세요. 동작할 수도 있지만 등록값이 뜻과 다릅니다.' };
    case 'no-password':
      return { title: '비밀번호가 저장돼 있지 않습니다', detail: `계정${t(f.username) ? ` ${q(f.username)}` : ''}은 있는데 비밀번호가 비어 있습니다. 접속처(host·계정)를 바꾸면 저장 비밀이 **의도적으로 폐기**됩니다(보안 규약).`, action: '설정에서 비밀번호를 다시 넣으세요.' };
    case 'no-token':
      return { title: '토큰이 저장돼 있지 않습니다', detail: '토큰 없이는 인증 단계를 확인할 수 없습니다.', action: '설정에서 토큰을 넣으세요.' };
    case 'no-username':
      return { title: '계정이 비어 있습니다', detail: '수집기가 로그인할 계정이 없습니다.', action: '설정에서 계정을 넣으세요.' };
    case 'ssh-port-443':
      return { title: 'SSH 수집인데 포트가 443 입니다', detail: `등록 포트 ${f.port}${t(f.method) ? ` · 수집 방식 ${q(f.method)}` : ''}.`, action: 'SSH 포트(대개 22)로 고치거나, 수집 방식을 API 로 바꾸세요.' };
    case 'api-port-22':
      return { title: 'API 수집인데 포트가 22 입니다', detail: `등록 포트 ${f.port}${t(f.method) ? ` · 수집 방식 ${q(f.method)}` : ''}.`, action: 'HTTPS 포트(대개 443)로 고치거나, 수집 방식을 SSH 로 바꾸세요.' };
    case 'ssrf-blocked':
      return { title: '차단 대역 주소입니다', detail: `${t(f.host)} — ${t(f.reason)}`, action: '사내 주소(RFC1918)로 고치세요. 루프백·링크로컬은 SSRF 가드가 막습니다.' };
    case 'duplicate-host':
      return { title: `같은 주소가 ${f.count}번 등록돼 있습니다`, detail: `${t(f.host)} — 같은 종류에서 중복이면 한쪽이 다른쪽을 덮거나 같은 장비를 두 번 수집합니다.`, action: '중복 등록을 지우세요(의도한 구성이면 무시해도 됩니다).' };
    case 'webhook-plain-http':
      return { title: '웹훅이 평문 HTTP 입니다', detail: `${t(f.address)} — 웹훅 URL 자체가 인증 토큰 역할을 하는 경우가 많아 그대로 노출됩니다.`, action: 'https 웹훅으로 바꾸세요.' };
    case 'ad-plain-ldap':
      return { title: 'AD 연동이 평문 LDAP 입니다', detail: '로그인 시 사용자 비밀번호가 평문으로 흐릅니다.', action: '‘ldaps://…:636’ 으로 바꾸세요(도메인 컨트롤러 인증서가 필요합니다).' };
    case 'smtp-no-from':
      return { title: '보내는 주소(From)가 비어 있습니다', detail: '연결은 되지만 발송이 거부될 수 있습니다.', action: '설정 › 메일 발송에서 보내는 주소를 넣으세요.' };
    case 'dataplane-basepath':
      return {
        title: 'Data Plane 기본 경로가 위험한 형태입니다',
        detail: `${q(f.basePath)} — 조립된 최종 주소의 **호스트가 바뀔 수 있습니다**(‘@’·‘//’·‘?’·‘#’ 가 있거나 ‘/’ 로 시작하지 않는 경우).`,
        action: '‘/v3’ 처럼 슬래시로 시작하는 단순 경로로 고치세요.',
      };
    case 'site-no-agent':
      return { title: '담당 엣지가 지정되지 않았습니다', detail: 'collectMode=site 인데 remoteAgent 가 비어 있어 누가 수집·점검하는지 알 수 없습니다.', action: '설정에서 담당 엣지를 지정하거나 수집 방식을 direct 로 바꾸세요.' };
    case 'central-direct':
      return { title: '중앙이 직접 수집하는 대상입니다', detail: '담당 엣지가 지정돼 있지 않습니다 — **정상 구성**이며, 중앙에서 닿지 않을 때만 뜻이 생깁니다.', action: '' };
    case 'disabled':
      return { title: '비활성', detail: '등록부에서 껐습니다 — 점검하지 않습니다.', action: '' };
    case 'failed':
      return {
        title: `${t(f.phase) || '?'} 단계에서 막혔습니다`,
        detail: `${t(f.error) || '오류 원문이 없습니다.'}${t(f.reached) ? ` (도달한 마지막 단계: ${t(f.reached)})` : ''}`,
        action: t(f.fix),
      };
    case 'auth-required-ok':
      return { title: '인증을 요구했습니다 — 정상입니다', detail: `HTTP ${f.status}. 이 점검은 **자격증명을 보내지 않으므로** 401/403 은 서비스가 살아 있다는 뜻입니다.`, action: '계정·비밀번호까지 확인하려면 그 설정 화면의 ‘연결 테스트’ 를 쓰세요.' };
    case 'probe-path-404':
      return { title: '무인증 확인 경로가 없습니다', detail: `HTTP ${f.status}${t(f.path) ? ` (${q(f.path)})` : ''} — 연결 자체는 됐습니다. 제품·버전에 그 경로가 없을 수 있습니다.`, action: '' };
    case 'cert-expiring':
      return { title: `인증서가 ${f.days}일 뒤 만료됩니다`, detail: `${t(f.subject) ? `주체 ${t(f.subject)}` : ''}${t(f.issuer) ? ` · 발급 ${t(f.issuer)}` : ''}`.trim() || '만료일만 확인했습니다.', action: '만료 전에 갱신하세요 — 지나면 이 연결이 끊깁니다.' };
    case 'cert-expired':
      return { title: `인증서가 ${Math.abs(Number(f.days) || 0)}일 전에 만료됐습니다`, detail: t(f.subject) ? `주체 ${t(f.subject)}` : '', action: '즉시 갱신하세요.' };
    case 'cert-untrusted':
      return { title: '인증서를 신뢰할 수 없습니다(자체서명 등)', detail: `${t(f.authError)}${t(f.issuer) ? ` · 발급 ${t(f.issuer)}` : ''} — 이 포탈은 검증을 끄고 접속하므로 **동작에는 문제가 없습니다**.`, action: '' };
    case 'ssh-banner':
      return { title: 'SSH 서버 정보', detail: t(f.banner), action: '' };
    case 'smtp-no-starttls':
      return { title: 'STARTTLS 를 광고하지 않습니다', detail: '평문 SMTP 로 흐릅니다(내부망 릴레이면 의도된 구성일 수 있습니다).', action: 'TLS(465) 또는 STARTTLS 지원 릴레이로 바꾸는 것을 검토하세요.' };
    default:
      return { title: t(finding.code) || '알 수 없는 발견', detail: '', action: '' };
  }
}

/** 대상 행의 상태. ⚠ **측정값이 없으면 '정상' 이 아니다**(v2.552 규약과 같다). */
export function targetState(row = {}, { enabled = true, settingsCheck = true } = {}) {
  if (row.enabled === false) return { state: 'disabled', short: '비활성' };
  if (row.bad) return { state: 'config', short: '주소 오류' };
  if ((row.findings || []).some((x) => x.severity === 'blocker' && x.code !== 'failed')) {
    return { state: 'config', short: '설정 문제' };
  }
  const L = row.latest || null;
  if (L) return { state: L.ok ? 'ok' : 'fail', short: L.ok ? '정상' : '실패' };
  if (!enabled) return { state: 'no-data', short: '점검 꺼짐' };
  if (!settingsCheck) return { state: 'no-data', short: '설정 점검 꺼짐' };
  if (t(row.agent)) return { state: 'no-data', short: '엣지 위임' };
  return { state: 'no-data', short: '첫 주기 대기' };
}

export const STATE_LABEL = Object.freeze({ ok: '정상', fail: '실패', config: '설정 문제', 'no-data': '측정 없음', disabled: '비활성' });

export function stateTone(state) {
  if (state === 'ok') return 'var(--ok, #35c46a)';
  if (state === 'fail') return 'var(--bad, #ef5a5a)';
  if (state === 'config') return 'var(--warn, #e8b23a)';
  return 'var(--muted)';
}

/**
 * KPI. ⚠ `측정 없음`·`설정 문제`·`비활성` 을 정상에도 실패에도 넣지 않는다 —
 * 겹치지 않아야 `합계 = 정상 + 실패 + 설정문제 + 측정없음 + 비활성` 항등식이 성립한다.
 */
export function kpisOf(rows = [], opt = {}) {
  const k = { total: rows.length, ok: 0, fail: 0, config: 0, nodata: 0, disabled: 0, blockers: 0, warns: 0 };
  for (const r of rows) {
    const st = targetState(r, opt).state;
    if (st === 'ok') k.ok += 1;
    else if (st === 'fail') k.fail += 1;
    else if (st === 'config') k.config += 1;
    else if (st === 'disabled') k.disabled += 1;
    else k.nodata += 1;
    for (const f of (r.findings || [])) {
      if (f.severity === 'blocker') k.blockers += 1;
      else if (f.severity === 'warn') k.warns += 1;
    }
  }
  k.measured = k.ok + k.fail;
  k.okPct = k.measured > 0 ? Math.round((k.ok / k.measured) * 1000) / 10 : null;
  return k;
}

/**
 * 도달한 단계 → **실제로 확인한 깊이**.
 *
 * ⚠⚠ **선언 깊이를 그대로 '확인했다' 고 말하면 거짓이 된다**(v2.553 실제 API 판독에서 발견):
 *   `set:idrac` 은 선언 깊이가 `identity`(제품 확인까지)인데, 무인증 요청이 403 을 받으면
 *   `stepHttp` 가 인증 단계에서 끝내므로 **정체 대조는 하지 않는다**. 그런데도 화면이
 *   '제품 확인까지' 라고 적으면 "이 주소가 정말 iDRAC 임을 확인했다" 는 **거짓**이 된다
 *   (실측: 403 을 준 74대가 전부 그랬다). 그래서 **도달한 단계에서 되돌린다.**
 */
const PHASE_DEPTH = Object.freeze({
  identity: 'identity', auth: 'http', http: 'http', tls: 'tls', ssh: 'ssh', smtp: 'smtp', port: 'tcp', tcp: 'tcp', dns: 'dns',
});
const DEPTH_RANK = Object.freeze({ dns: 0, tcp: 1, tls: 2, ssh: 3, smtp: 3, http: 4, identity: 5 });

/**
 * @returns {{depth:string, declared:string, shallower:boolean}} `shallower` 면 화면이 그 사실을 말한다.
 */
export function depthReached(row = {}) {
  const declared = t(row.depth) || 'tcp';
  const L = row.latest || null;
  const reached = t(L?.reached);
  if (!L || !reached) return { depth: declared, declared, shallower: false, measured: false, failed: false };
  /*
   * ⚠⚠ **실패한 대상의 '확인 깊이' 를 말하지 않는다**(v2.553 스크린샷 판독에서 발견):
   *   `judge()` 의 `reached` 는 **실패한 단계**를 가리키므로, TCP 실패를 그대로 옮기면 화면이
   *   "포트 열림까지 봤습니다" 라고 말한다 — 포트는 열리지 않았다. 실패 행의 깊이 칸은
   *   `null`(화면 '—')이고, 무엇이 막혔는지는 상태·해결책 칸이 말한다.
   */
  if (L.ok === false) return { depth: null, declared, shallower: false, measured: true, failed: true, failedAt: reached };
  const actual = PHASE_DEPTH[reached] || declared;
  const shallower = (DEPTH_RANK[actual] ?? 9) < (DEPTH_RANK[declared] ?? 9);
  return { depth: actual, declared, shallower, measured: true, failed: false };
}

/** '정상' 의 뜻을 종류마다 밝힌다 — tcp 를 identity 처럼 말하면 거짓이다. */
export function depthNote(depth, depthLabel = {}, opt = {}) {
  if (opt.failed) {
    const at = t(depthLabel[PHASE_DEPTH[t(opt.failedAt)]]) || t(opt.failedAt);
    return `${at ? `${at} 단계에서` : '점검 도중'} 막혀 확인 깊이를 말할 수 없습니다 — 상태·해결책 칸을 보세요.`;
  }
  const d = t(depth);
  const label = t(depthLabel[d]) || d;
  if (opt.measured === false) return `아직 측정하지 않았습니다 — 이 종류는 ${label} 볼 수 있습니다.`;
  if (opt.shallower) {
    const dec = t(depthLabel[t(opt.declared)]) || t(opt.declared);
    return `${label}만 도달했습니다 — 이 종류는 ${dec} 볼 수 있지만 이번 응답은 그 전에 끝났습니다(무인증 요청이 인증을 요구받으면 제품 확인까지 가지 않습니다).`;
  }
  // ⚠ 라벨이 이미 '…까지' 로 끝나므로 '확인했습니다' 를 덧붙이면 "확인까지 확인했습니다" 가 된다.
  if (d === 'identity') return `${label} 봤습니다 — 응답이 그 제품인지까지 대조했습니다.`;
  if (d === 'tcp') return `${label}만 봤습니다 — 프로토콜 대화는 하지 않았습니다.`;
  if (d === 'tls') return `${label} 봤습니다 — HTTP 응답은 확인하지 않았습니다.`;
  return `${label} 봤습니다.`;
}

/** 맨 위 배너 — 긴 설명은 **여기 한 번만**(v2.509). */
export function headerNote(data = {}) {
  const out = [];
  const rows = data.targets || [];
  const opt = { enabled: data.enabled, settingsCheck: data.settingsCheck };
  const k = kpisOf(rows, opt);
  out.push('이 점검은 **장비 계정으로 로그인하지 않습니다** — 도달성·TLS·엔드포인트 존재까지만 봅니다(5분마다 로그인하면 계정이 잠깁니다). 계정까지 확인하려면 각 설정 화면의 ‘연결 테스트’ 를 쓰세요.');
  if (!data.enabled) out.push('통신 점검이 **꺼져 있습니다** — 아래 ‘설정 문제’ 는 네트워크 없이도 보이지만, 도달성 측정은 켜야 쌓입니다.');
  else if (data.settingsCheck === false) out.push('설정 전수 점검이 **꺼져 있습니다**(링크 점검만 돌고 있습니다).');
  if (k.config > 0) out.push(`설정만 보고도 **${k.config}개** 대상에서 접속을 막는 문제를 찾았습니다 — 점검을 켜기 전에 먼저 고치세요.`);
  if (k.nodata > 0 && data.enabled) out.push(`측정값이 없는 대상이 **${k.nodata}개** 있습니다 — 정상이라는 뜻이 아닙니다.`);
  if ((data.sourceErrors || []).length) {
    out.push(`⚠ 등록부 **${data.sourceErrors.length}곳**을 읽지 못해 그 종류가 목록에서 통째로 빠졌습니다 — "모든 통신" 이라고 말할 수 없는 상태입니다.`);
  }
  return out;
}

/** 그룹 묶음(표시 순서 유지). 목록에 없는 그룹은 뒤에 붙인다. */
export function groupRows(rows = [], order = []) {
  const m = new Map();
  for (const r of rows) {
    const g = t(r.group) || '기타';
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(r);
  }
  const known = order.filter((g) => m.has(g));
  const rest = [...m.keys()].filter((g) => !order.includes(g)).sort();
  return [...known, ...rest].map((g) => ({ group: g, rows: m.get(g) }));
}

/** 설정 화면 딥링크. 좌표가 없으면 **링크를 만들지 않는다**(죽은 링크 금지). */
export function settingsLinkOf(row = {}, paths = {}) {
  const p = paths[t(row.settings)] || null;
  if (!p || !t(p.hash)) return null;
  return { label: t(p.label) || '설정', hash: t(p.hash) };
}

/** 표 아래 각주 — **있는 종류만**(v2.509). */
export function tableFootnotes(rows = [], opt = {}) {
  const out = [];
  const states = rows.map((r) => targetState(r, opt).state);
  if (states.includes('no-data')) out.push('**측정 없음**: 아직 값이 없습니다 — 정상도 장애도 아닙니다.');
  if (states.includes('config')) out.push('**설정 문제**: 네트워크를 보기 전에 등록값 자체가 접속을 막습니다. 행을 펼치면 고칠 값이 나옵니다.');
  if (rows.some((r) => t(r.agent))) out.push('**엣지 위임** 대상은 중앙에서 닿지 않는 것이 정상입니다 — 그 엣지가 수집합니다(중앙은 점검하지 않습니다).');
  if (rows.some((r) => { const d = depthReached(r); return d.shallower && !d.failed; })) {
    out.push('**선언한 깊이보다 얕게 끝난 대상**이 있습니다 — 무인증 요청이 401/403 을 받으면 제품 확인까지 가지 않습니다(연결·TLS 는 정상입니다). 그 행의 깊이 칸이 실제 도달 지점을 말합니다.');
  }
  if (rows.some((r) => r.depth === 'tcp' || r.depth === 'tls')) out.push('**포트·TLS 까지만** 보는 종류가 있습니다(웹훅은 POST 만 받고, LDAP 는 익명 bind 를 하지 않습니다) — ‘정상’ 의 뜻이 종류마다 다르므로 ‘확인 깊이’ 열을 함께 보세요.');
  return out;
}
