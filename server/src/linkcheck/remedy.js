/**
 * linkcheck/remedy.js — **해결책 판정**(순수, v2.553).
 *
 * 사용자 선택: 해결책은 **고정 조치문 + 맞춤 진단 둘 다**.
 *   · 고정 조치문 = 실패 단계·종류별로 정해진 문구(`phases.js FAIL_KINDS.fix`)
 *   · 맞춤 진단   = **그 대상의 실제 설정값·응답을 근거로** 만드는 발견(이 파일)
 *
 * ⚠⚠ **조언이 틀리면 무음 실패보다 나쁘다**(v2.525 Horizon 실제 사고 — "URL 을 빼세요" 라는
 *   기본 조언이 `https://` 가 **필수**인 Horizon 에 떠서 사용자가 잘못된 수정을 했다). 그래서:
 *   ① 종류마다 **주소 형식(`hostForm`)이 다르다**는 것을 표로 못 박고
 *   ② 근거(`facts`)가 없으면 **발견을 만들지 않는다**(추측으로 채우지 않는다)
 *   ③ 판정(`code` + 근거)은 여기, **문구는 웹 순수 모듈**이 만든다(v2.517 규약).
 *
 * `severity`: `blocker`(이것 때문에 점검 자체가 불가) · `warn`(동작하지만 곧 문제) ·
 *   `info`(알고 있어야 하는 사실). 화면은 이 순서로 정렬한다.
 */
import { FAIL_KINDS } from './phases.js';
import { SETTING_KINDS } from './settingsKinds.js';

const t = (v) => String(v ?? '').trim();

/**
 * 종류별 주소 형식. **이 표가 잘못된 조언을 막는 유일한 장치다.**
 *   `url`   — 스킴이 **필수**(Horizon·엣지·웹훅·업그레이드 소스·Data Plane)
 *   `either`— 스킴이 있어도 없어도 정상(iDRAC 등록부는 스킴을 붙여 저장한다)
 *   `host`  — **주소만**(스킴을 넣으면 수집기가 접속하지 못한다 — 스토리지·SAN·PDU·SSH 류)
 *   `ldap`  — `ldap://` 또는 `ldaps://`
 */
export const HOST_FORM = Object.freeze({
  'set:vcenter': 'either',
  'set:nsx': 'either',
  'set:collector': 'url',
  'set:central': 'url',
  'set:horizon': 'url',
  'set:idrac': 'either',
  'set:ome': 'either',
  'set:storage-api': 'host',
  'set:storage-ssh': 'host',
  'set:sanswitch-ssh': 'host',
  'set:sanswitch-rest': 'host',
  'set:pdu': 'host',
  'set:bmstor': 'host',
  'set:gpu-physical': 'host',
  'set:dataplane': 'url',
  'set:remote-ssh': 'host',
  'set:capture': 'host',
  'set:deploy': 'host',
  'set:relaytopo': 'host',
  'set:credential-host': 'host',
  'set:smtp': 'host',
  'set:webhook': 'url',
  'set:ad': 'ldap',
  'set:upgrade-src': 'url',
  'set:package-repo': 'url',
});

/** 인증서 경고 경계(일). 30일은 갱신 리드타임이라 업계 관행이고, 화면이 숫자를 밝힌다. */
export const CERT_WARN_DAYS = 30;

const find = (code, severity, facts = {}) => ({ code, severity, facts });

/**
 * **설정만 보고 찾는 발견**(네트워크 왕복 0). 점검을 켜지 않아도 즉시 보여줄 수 있다.
 *
 * @param {object} target `settingsLinks.buildSettingsTargets()` 의 항목
 * @param {object} [ctx]  `{ hostCounts: Map<'kind|host', number>, ipBlockReason: (h)=>string|null }`
 */
export function configFindings(target = {}, ctx = {}) {
  const out = [];
  const kind = t(target.kind);
  const spec = SETTING_KINDS[kind];
  if (!spec) return out;
  const form = HOST_FORM[kind] || 'either';
  const addr = t(target.address);
  const f = target.facts || {};

  if (target.bad) out.push(find('address-unparsable', 'blocker', { reason: target.bad, address: addr }));

  /* ── 주소 형식 ─────────────────────────────────────────────────────────── */
  if (addr) {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(addr);
    if (form === 'host' && hasScheme) {
      out.push(find('scheme-in-host', 'blocker', { address: addr, stripped: addr.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '') }));
    }
    if ((form === 'url' || form === 'ldap') && !hasScheme) {
      out.push(find('scheme-missing', 'blocker', { address: addr, form }));
    }
    if (form === 'ldap' && hasScheme && !/^ldaps?:\/\//i.test(addr)) {
      out.push(find('ldap-scheme-wrong', 'blocker', { address: addr }));
    }
    if (form === 'host' && /\//.test(addr.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))) {
      out.push(find('path-in-host', 'warn', { address: addr }));
    }
    if (/\s/.test(addr)) out.push(find('address-whitespace', 'blocker', { address: addr }));
  } else {
    out.push(find('address-empty', 'blocker', {}));
  }

  /* ── 자격증명 유무(값은 보지 않는다 — 있다/없다만) ───────────────────────── */
  if (f.hasPassword === false && f.hasKey !== true) out.push(find('no-password', 'blocker', { username: t(f.username) }));
  if (f.hasToken === false) out.push(find('no-token', 'blocker', {}));
  if (t(f.username) === '' && ['set:storage-api', 'set:storage-ssh', 'set:sanswitch-ssh', 'set:sanswitch-rest', 'set:pdu', 'set:bmstor', 'set:gpu-physical', 'set:capture'].includes(kind)) {
    out.push(find('no-username', 'blocker', {}));
  }

  /* ── 포트와 수집 방식의 어긋남(오류 없이 조용히 실패하는 조합) ───────────── */
  const port = Number(target.port);
  const method = t(f.collectMethod);
  if (spec.probe.mode === 'ssh' && port === 443) out.push(find('ssh-port-443', 'warn', { port, method }));
  if (spec.probe.mode !== 'ssh' && port === 22) out.push(find('api-port-22', 'warn', { port, method }));

  /* ── SSRF 가드에 걸리는 주소(저장은 됐지만 접속이 차단된다) ───────────────── */
  if (typeof ctx.ipBlockReason === 'function' && t(target.host)) {
    const r = ctx.ipBlockReason(t(target.host));
    if (r) out.push(find('ssrf-blocked', 'blocker', { host: t(target.host), reason: t(r) }));
  }

  /* ── 같은 종류에 같은 host 가 둘 이상(한쪽이 다른쪽을 덮어쓰거나 중복 수집) ── */
  if (ctx.hostCounts instanceof Map && t(target.host)) {
    const n = ctx.hostCounts.get(`${kind}|${t(target.host).toLowerCase()}`) || 0;
    if (n > 1) out.push(find('duplicate-host', 'warn', { host: t(target.host), count: n }));
  }

  /* ── 종류별 맞춤 ───────────────────────────────────────────────────────── */
  if (kind === 'set:webhook' && /^http:\/\//i.test(addr)) out.push(find('webhook-plain-http', 'warn', { address: addr }));
  if (kind === 'set:ad' && /^ldap:\/\//i.test(addr)) out.push(find('ad-plain-ldap', 'warn', { address: addr }));
  if (kind === 'set:smtp' && !t(f.from)) out.push(find('smtp-no-from', 'warn', {}));
  if (kind === 'set:dataplane') {
    const bp = t(f.basePath);
    // v2.503 S-1: basePath 에 `@`·`//`·`?`·`#` 가 있으면 조립된 주소의 **호스트가 바뀐다**.
    if (bp && (/[@?#\s]/.test(bp) || bp.startsWith('//') || !bp.startsWith('/'))) {
      out.push(find('dataplane-basepath', 'blocker', { basePath: bp }));
    }
  }
  if (kind === 'set:vcenter' && t(f.collectMode) === 'site' && !t(target.agent)) {
    out.push(find('site-no-agent', 'blocker', {}));
  }
  if (['set:storage-api', 'set:storage-ssh', 'set:sanswitch-ssh', 'set:sanswitch-rest', 'set:pdu', 'set:bmstor'].includes(kind) && !t(target.agent)) {
    // ⚠ '중앙 직접 수집' 은 **정상 구성**이다 — 그래서 `info` 이고, 중앙에서 안 닿을 때만 뜻이 생긴다.
    out.push(find('central-direct', 'info', {}));
  }
  if (target.enabled === false) out.push(find('disabled', 'info', {}));

  return out;
}

/**
 * **점검 결과를 보고 찾는 발견**. 고정 조치문(`FAIL_KINDS.fix`)은 여기서 코드만 주고
 * 문구는 웹이 만든다(서버 문구는 알림·로그가 쓴다).
 *
 * @param {object} target
 * @param {object} verdict `phases.judge()` 결과
 * @param {object} steps
 */
export function resultFindings(target = {}, verdict = null, steps = {}) {
  const out = [];
  if (!verdict) return out;
  const kind = t(target.kind);
  const spec = SETTING_KINDS[kind] || null;

  if (!verdict.ok) {
    const fk = t(verdict.failKind) || 'unknown';
    out.push(find('failed', 'blocker', {
      failKind: fk, phase: t(verdict.phase), reached: t(verdict.reached),
      fix: FAIL_KINDS[fk]?.fix || FAIL_KINDS.unknown.fix,
      error: t(steps?.[verdict.phase]?.error).slice(0, 300),
    }));
  }

  /*
   * ⚠⚠ **무인증 점검에서 401/403 은 실패가 아니다** — 우리가 자격증명을 보내지 않았으므로
   *   "서비스가 살아 있고 인증을 요구한다" 는 **양성 신호**다. 이것을 실패로 세면 화면이
   *   정상 장비 수십 대를 '인증 실패' 라 말한다(이 기능 최악의 오설계).
   */
  const st = Number(steps?.http?.status);
  if (spec?.probe?.authMode === 'none' && (st === 401 || st === 403)) {
    out.push(find('auth-required-ok', 'info', { status: st }));
  }
  if (spec?.probe?.authMode === 'none' && st === 404) {
    // 무인증 경로가 없는 제품일 수 있다 — '고장' 이라 단정하지 않는다.
    out.push(find('probe-path-404', 'info', { status: st, path: t(spec?.probe?.path) }));
  }

  /* 인증서 — 만료는 실패(steps.tls 가 이미 잡는다), 임박은 여기서 경고 */
  const days = steps?.tls?.certDaysLeft;
  if (days != null && Number.isFinite(Number(days))) {
    const d = Number(days);
    if (d >= 0 && d <= CERT_WARN_DAYS) out.push(find('cert-expiring', 'warn', { days: d, subject: t(steps.tls.subject), issuer: t(steps.tls.issuer) }));
    if (d < 0) out.push(find('cert-expired', 'blocker', { days: d, subject: t(steps.tls.subject) }));
  }
  if (steps?.tls && steps.tls.authorized === false && t(steps.tls.authError)) {
    // 이 현장은 자체서명이 흔하다 — **info** 다(우리는 검증을 끄고 접속한다). 사실만 알린다.
    out.push(find('cert-untrusted', 'info', { authError: t(steps.tls.authError), issuer: t(steps.tls.issuer) }));
  }
  if (steps?.ssh?.ok && t(steps.ssh.banner)) out.push(find('ssh-banner', 'info', { banner: t(steps.ssh.banner).slice(0, 120) }));
  if (steps?.smtp?.ok && steps.smtp.starttls === false) out.push(find('smtp-no-starttls', 'warn', {}));

  return out;
}

/** 두 발견을 합쳐 심각도 순으로. 같은 code 는 하나만(행마다 같은 말 반복 금지 — v2.509). */
const SEV_RANK = { blocker: 0, warn: 1, info: 2 };
export function mergeFindings(...lists) {
  const seen = new Set();
  const all = [];
  for (const l of lists) for (const x of (l || [])) {
    if (!x || seen.has(x.code)) continue;
    seen.add(x.code);
    all.push(x);
  }
  return all.sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
}

/** 같은 host 가 몇 번 등장하는지(중복 판정 재료). 종류가 다르면 정상이므로 **종류별로** 센다. */
export function hostCountsOf(targets = []) {
  const m = new Map();
  for (const x of targets) {
    const h = t(x?.host).toLowerCase();
    if (!h) continue;
    const k = `${t(x.kind)}|${h}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
