/**
 * Active Directory (LDAP) authentication — UPN simple bind + group→role mapping.
 *
 * Flow: bind to AD as <username>@<domain> (or the raw username if it already
 * contains '@'/'\\'). On success, search the directory for the user's entry to
 * read memberOf, then map AD groups to a portal role. No service account needed.
 *
 * Config lives in CONFIG_DIR/auth.json (editable in 설정 → 인증) and falls back
 * to AD_* environment variables. Secrets are not stored (UPN bind uses the
 * user's own password).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import ldap from 'ldapjs';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js'; // v2.478(감사 B5/S12): 원자적 쓰기 + 손상 시 preserveCorrupt — 크래시 1회로 설정이 소실되고 다음 저장이 빈 값으로 덮어쓰는 사고 방지
import { notifySessionRevoked } from './sessionRevocation.js';

const FILE = path.join(config.configDir, 'auth.json');

const ENV_DEFAULTS = {
  enabled: process.env.AD_ENABLED === 'true',
  url: process.env.AD_URL || '',                       // ldap://dc.corp.local:389 or ldaps://...:636
  domain: process.env.AD_DOMAIN || '',                 // corp.local  → user@corp.local
  baseDN: process.env.AD_BASE_DN || '',                // DC=corp,DC=local
  userFilter: process.env.AD_USER_FILTER || '(|(userPrincipalName={upn})(sAMAccountName={user}))',
  adminGroup: process.env.AD_ADMIN_GROUP || '',        // CN 또는 전체 DN, 예: "VMware-Portal-Admins"
  operatorGroup: process.env.AD_OPERATOR_GROUP || '',
  viewerGroup: process.env.AD_VIEWER_GROUP || '',
  defaultRole: process.env.AD_DEFAULT_ROLE || 'viewer',
  // 그룹→역할 매핑 방식. 기본 'exact'(CN 완전일치 / 전체 DN 완전일치) — 과거 부분문자열
  // 매칭은 AD_ADMIN_GROUP=IT 설정 시 "IT-Interns" 멤버까지 admin으로 승격시켰다(권한 상승).
  // 부분문자열에 의존하던 기존 배포가 있으면 AD_GROUP_MATCH=substring 으로만 되돌린다(비권장).
  groupMatch: process.env.AD_GROUP_MATCH === 'substring' ? 'substring' : 'exact',
  // LDAPS 인증서 검증은 기본 ON(MITM 방지). 내부 자체서명 DC만 AD_TLS_REJECT_UNAUTHORIZED=false로 opt-out.
  tlsRejectUnauthorized: process.env.AD_TLS_REJECT_UNAUTHORIZED !== 'false',
  timeoutMs: normTimeoutMs(process.env.AD_TIMEOUT_MS) ?? 8000,
  // 2026-10-09 검토 S-03: ldap:// 에서 비밀번호를 보내기 전에 StartTLS 로 암호화한다(ldaps:// 면 쓰지 않는다).
  startTls: process.env.AD_STARTTLS === 'true',
  // 사설 CA(PEM, 여러 개 가능 — 공개 인증서라 비밀이 아니다). 주면 그 CA 만 신뢰한다(시스템 기본 신뢰 저장소 대신).
  caCert: '',
  // 인증서 이름 검증에 쓸 이름 — 비우면 URL 의 호스트명. URL 을 IP 로 적었는데 인증서에 DNS 이름만 있을 때 쓴다.
  tlsServerName: '',
  // 2026-10-09 검토 S-08: AD 세션 최대 시간(시간). 포탈은 사용자 비밀번호를 갖고 있지 않아(UPN 직접 바인드) 로그인 뒤에
  //   LDAP 로 그룹을 다시 확인할 수 없다 — 도메인 쪽 계정 비활성화·그룹 변경은 '다음 로그인' 에만 반영된다. 이 값이 그 최대
  //   지연이다(연장으로도 넘지 못한다). 1~168, 빈 값·0 이하는 기본 12.
  maxSessionHours: normAdHours(process.env.AD_SESSION_MAX_HOURS) ?? 12,
};

/** AD 세션 상한(시간) → [1, 168] 정수, 빈 값·숫자 아님·0 이하면 null(= 미지정). */
function normAdHours(v) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return null;
  return Math.min(168, Math.max(1, Math.round(n)));
}

/**
 * v2.601(LO2601-02): AD 타임아웃 → [1초, 60초] 정수 ms, 빈 값·숫자 아님·0 이하면 null(= 미지정).
 * 예전에는 화면이 보낸 문자열을 그대로 저장해, 칸을 비우면 `''` 가 저장되고 `setTimeout(reject, '')` 가 ~1ms 에
 * 발화해 **모든 AD 로그인이 'connect timeout'** 으로 실패했다(authenticateAD 가 null 을 돌려 '비밀번호 틀림' 처럼 보인다).
 */
function normTimeoutMs(v) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return null;
  return Math.min(60_000, Math.max(1000, Math.round(n)));
}

export function loadAdConfig() {
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.ad || {}; } catch (e) { preserveCorrupt(FILE, e.message); saved = {}; }
  const merged = { ...ENV_DEFAULTS, ...saved };
  // 이미 저장된 '' · 문자열 · 범위 밖 값도 여기서 복구한다(저장 경로만 고치면 옛 파일이 계속 로그인을 막는다).
  merged.timeoutMs = normTimeoutMs(merged.timeoutMs) ?? ENV_DEFAULTS.timeoutMs;
  merged.maxSessionHours = normAdHours(merged.maxSessionHours) ?? ENV_DEFAULTS.maxSessionHours;
  // 검증은 명시적 false('false') 일 때만 끈다 — null·빈 값을 Boolean() 으로 읽으면 화면은 '검증 켬' 인데 실제로는 꺼진다.
  merged.tlsRejectUnauthorized = !(merged.tlsRejectUnauthorized === false || merged.tlsRejectUnauthorized === 'false');
  merged.startTls = merged.startTls === true;
  merged.caCert = typeof merged.caCert === 'string' ? merged.caCert : '';
  merged.tlsServerName = typeof merged.tlsServerName === 'string' ? merged.tlsServerName.trim() : '';
  merged.policyEpoch = Math.max(0, Math.floor(Number(merged.policyEpoch) || 0));
  // groupMatch만 env를 우선한다 — UI 저장으로 auth.json에 'exact'가 박히면 긴급 하위호환
  // 스위치(AD_GROUP_MATCH=substring)가 먹지 않아 로그인 역할 매핑을 되돌릴 수 없게 된다.
  if (process.env.AD_GROUP_MATCH) merged.groupMatch = ENV_DEFAULTS.groupMatch;
  return merged;
}

/* ----------------------- 전송 보호(S-03) · 정책 epoch(S-08) ----------------------- */

const CA_MAX_CHARS = 65_536;
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const URL_RE = /^ldaps?:\/\/[^\s/?#]+(?:\/[^\s]*)?$/i;

/** URL 의 호스트(대괄호 없는 IPv6)·스킴. 못 읽으면 null. */
export function adUrlParts(url) {
  const u = String(url || '').trim();
  if (!u || u.length > 512 || !URL_RE.test(u)) return null;
  try {
    const p = new URL(u);
    const scheme = p.protocol.replace(/:$/, '').toLowerCase();
    if (scheme !== 'ldap' && scheme !== 'ldaps') return null;
    const host = p.hostname.replace(/^\[|\]$/g, '');
    if (!host) return null;
    return { scheme, host, port: p.port ? Number(p.port) : (scheme === 'ldaps' ? 636 : 389) };
  } catch { return null; }
}

/** 인증 연결의 보호 방식 — 'ldaps' | 'starttls' | 'plain'(평문 bind) | 'none'(URL 없음·못 읽음). */
export function adTransportMode(ad) {
  const p = adUrlParts(ad?.url);
  if (!p) return 'none';
  if (p.scheme === 'ldaps') return 'ldaps';
  return ad?.startTls === true ? 'starttls' : 'plain';
}

/** PEM 묶음 → 인증서 문자열 배열. 하나라도 못 읽으면 { error }. 빈 값이면 []. */
export function parseCaBundle(pem) {
  const s = String(pem || '').trim();
  if (!s) return { certs: [] };
  if (s.length > CA_MAX_CHARS) return { error: `CA 인증서가 너무 깁니다(최대 ${CA_MAX_CHARS}자).` };
  const blocks = s.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length) return { error: 'CA 인증서는 PEM(-----BEGIN CERTIFICATE-----) 형식이어야 합니다.' };
  for (const b of blocks) {
    try { new crypto.X509Certificate(b); } catch (e) { return { error: `CA 인증서를 읽지 못했습니다(${e?.message || e}).` }; }
  }
  return { certs: blocks };
}

/** 화면·상태·자가진단용 전송 상태. warnings 는 코드 배열(문장은 화면이 만든다). */
export function adTransportStatus(ad = loadAdConfig()) {
  const mode = adTransportMode(ad);
  const warnings = [];
  if (mode === 'plain') warnings.push('plain-ldap');
  if ((mode === 'ldaps' || mode === 'starttls') && ad.tlsRejectUnauthorized === false) warnings.push('tls-verify-off');
  if (ad.caCert && parseCaBundle(ad.caCert).error) warnings.push('ca-invalid');
  return { mode, verify: ad.tlsRejectUnauthorized !== false, ca: !!String(ad.caCert || '').trim(), serverName: ad.tlsServerName || '', enabled: !!(ad.enabled && ad.url), warnings };
}

/** 역할 결정에 영향을 주는 필드의 지문 — 바뀌면 그 전에 발급된 AD 토큰은 무효(epoch 의 일부). */
const MAPPING_KEYS = ['url', 'domain', 'baseDN', 'userFilter', 'adminGroup', 'operatorGroup', 'viewerGroup', 'defaultRole', 'groupMatch'];
function mappingFingerprint(ad) {
  const o = {};
  for (const k of MAPPING_KEYS) o[k] = typeof ad?.[k] === 'string' ? ad[k].trim() : (ad?.[k] ?? null);
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 12);
}
/** AD 토큰의 정책 epoch — '<저장된 변경 카운터>.<매핑 지문>'. 카운터는 비활성화·매핑 변경 저장마다 오른다. */
export function adEpochOf(ad) { return `${Math.max(0, Math.floor(Number(ad?.policyEpoch) || 0))}.${mappingFingerprint(ad)}`; }

// 핫패스 캐시(resolveTokenUser 가 AD 토큰마다 본다) — 파일을 매 요청 읽지 않게 3초. 저장 시 즉시 무효화.
let _psAt = 0; let _ps = null;
/** { enabled, epoch, counter, maxSessionHours } — resolveTokenUser 가 쓰는 AD 정책 상태. */
export function adPolicyState() {
  const now = Date.now();
  if (_ps && _psAt && now - _psAt < 3000) return _ps;
  const ad = loadAdConfig();
  _ps = { enabled: !!(ad.enabled && ad.url), epoch: adEpochOf(ad), counter: ad.policyEpoch || 0, maxSessionHours: ad.maxSessionHours };
  _psAt = now;
  return _ps;
}
export function invalidateAdPolicyCache() { _psAt = 0; _ps = null; }

/**
 * 저장 검증(S-03) — 새로 저장하는 평문 ldap://(StartTLS 없음)는 거부한다. 이미 저장된 평문 설정은 URL·StartTLS·사용 여부를
 * 건드리지 않는 저장(그룹명 수정 등)이면 그대로 둔다(동작 유지 + 화면·자가진단 경고 — 사용자 선택 '새 저장만 거부').
 * @returns {null | { reason: string, field: string, code: string }}
 */
export function adSaveIssue(cur, next, partial = {}) {
  if (partial.url !== undefined) {
    const u = String(partial.url ?? '').trim();
    if (u && !adUrlParts(u)) return { field: 'url', code: 'url-invalid', reason: 'AD 서버 URL 은 ldaps://호스트[:포트] 또는 ldap://호스트[:포트] 형식이어야 합니다.' };
  }
  if (partial.caCert !== undefined && typeof partial.caCert !== 'string') return { field: 'caCert', code: 'ca-invalid', reason: 'CA 인증서는 PEM 문자열이어야 합니다.' };
  const ca = parseCaBundle(next.caCert);
  if (ca.error && partial.caCert !== undefined) return { field: 'caCert', code: 'ca-invalid', reason: ca.error };
  if (next.tlsServerName && (net.isIP(next.tlsServerName) || !HOSTNAME_RE.test(next.tlsServerName))) return { field: 'tlsServerName', code: 'servername-invalid', reason: '인증서 이름은 DNS 이름(예: dc01.corp.local)이어야 합니다 — IP 는 쓰지 않습니다.' };
  const plainNext = adTransportMode(next) === 'plain';
  if (plainNext && next.url) {
    const urlChanged = String(next.url || '').trim() !== String(cur.url || '').trim();
    const tlsChanged = (next.startTls === true) !== (cur.startTls === true);
    const turnedOn = !!next.enabled && !cur.enabled;
    if (urlChanged || tlsChanged || turnedOn) {
      return { field: 'url', code: 'ldap-plain', reason: '평문 ldap:// 에서는 사용자 비밀번호가 암호화되지 않은 채 전송됩니다 — ldaps://(636) 를 쓰거나 StartTLS 를 켜세요. 새로 저장하는 평문 설정은 받지 않습니다.' };
    }
  }
  return null;
}

export function saveAdConfig(partial) {
  partial = partial && typeof partial === 'object' ? partial : {};
  const cur = loadAdConfig();
  const allowed = ['enabled', 'url', 'domain', 'baseDN', 'userFilter', 'adminGroup', 'operatorGroup', 'viewerGroup', 'defaultRole', 'tlsRejectUnauthorized', 'timeoutMs', 'groupMatch', 'startTls', 'caCert', 'tlsServerName', 'maxSessionHours'];
  const next = { ...cur };
  for (const k of allowed) if (partial[k] !== undefined) next[k] = partial[k];
  if (typeof next.url === 'string') next.url = next.url.trim();
  next.startTls = next.startTls === true;
  next.tlsRejectUnauthorized = !(next.tlsRejectUnauthorized === false || next.tlsRejectUnauthorized === 'false');
  next.caCert = typeof next.caCert === 'string' ? next.caCert.trim() : '';
  next.tlsServerName = typeof next.tlsServerName === 'string' ? next.tlsServerName.trim() : '';
  // 빈 칸·0 이하는 '미지정' — 이전 값을 유지한다(v2.583 dropUnspecifiedNumbers 규약).
  next.timeoutMs = normTimeoutMs(partial.timeoutMs) ?? cur.timeoutMs;
  next.maxSessionHours = normAdHours(partial.maxSessionHours) ?? cur.maxSessionHours;
  const issue = adSaveIssue(cur, next, partial);
  if (issue) throw Object.assign(new Error(issue.reason), { status: 400, field: issue.field, code: issue.code });
  // S-08: 사용 여부나 역할 결정 필드가 바뀌면 카운터를 올린다 — 그 전에 발급된 AD 토큰은 resolveTokenUser 에서 무효가 된다.
  //   (지문만 쓰면 A→B→A 로 되돌렸을 때 A 시절 토큰이 되살아난다 — 카운터가 그것을 막는다.)
  const changed = (!!next.enabled !== !!cur.enabled) || mappingFingerprint(next) !== mappingFingerprint(cur);
  next.policyEpoch = Math.max(0, Math.floor(Number(cur.policyEpoch) || 0)) + (changed ? 1 : 0);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify({ ad: next }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  invalidateAdPolicyCache();
  if (changed) {
    const reason = (!!next.enabled !== !!cur.enabled) ? (next.enabled ? 'ad-enabled' : 'ad-disabled') : 'ad-policy-changed';
    try { notifySessionRevoked({ scope: 'source', source: 'ad', reason }); } catch { /* 구독자 오류는 저장을 막지 않는다 */ }
  }
  return next;
}

function upnFor(username, ad) {
  if (username.includes('@') || username.includes('\\')) return username;
  return ad.domain ? `${username}@${ad.domain}` : username;
}

/* ------------------------- 그룹(DN) → 역할 매핑 유틸 ------------------------- */
// memberOf는 전체 DN(예: CN=VM-Admins,OU=Groups,DC=corp,DC=local)이다. 설정값이
//   (a) 전체 DN  → DN 완전일치
//   (b) 그룹명(CN) → DN의 첫 RDN(CN=...) 값과 완전일치(대소문자 무시)
// 로만 매칭한다(부분문자열 승격 차단). 여러 그룹은 세미콜론(권장)/줄바꿈으로 나열하고,
// DN이 아닌 그룹명 목록은 쉼표로도 나열할 수 있다(쉼표는 DN 내부 구분자이므로,
// 'attr=' 로 시작하는 항목은 하나의 DN으로 취급한다).

// 이스케이프(\, \; \\ 등)를 보존하면서 미이스케이프 구분자로만 자른다.
function splitUnescaped(s, seps) {
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i += 1; continue; }
    if (seps.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// RFC 4514 이스케이프 해제 — `\,`·`\+` 등 문자 이스케이프와 `\2C` 형태의 16진 이스케이프.
function unescapeRdnValue(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== '\\') { out += v[i]; continue; }
    const hex = v.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; continue; }
    out += v[i + 1] ?? ''; i += 1;
  }
  return out;
}

const ATTR_RE = /^\s*[A-Za-z][A-Za-z0-9-]*\s*=/; // 'CN=' / 'ou =' 등 DN 성분 시작 판정

// DN 문자열 정규화(비교용): 속성명 소문자 + 값 이스케이프 해제·소문자 + 공백 정리.
function normalizeDn(dn) {
  return splitUnescaped(String(dn ?? ''), ',').map((seg) => {
    const s = seg.trim();
    const eq = s.indexOf('=');
    if (eq < 0) return s.toLowerCase();
    return `${s.slice(0, eq).trim().toLowerCase()}=${unescapeRdnValue(s.slice(eq + 1).trim()).toLowerCase()}`;
  }).join(',');
}

// DN의 첫 RDN이 CN이면 그 값(소문자, 이스케이프 해제)을 반환. 아니면 null.
// 다중값 RDN(CN=a+OU=b)도 첫 성분만 본다.
function firstRdnCn(dn) {
  const first = splitUnescaped(String(dn ?? ''), ',+')[0] || '';
  const s = first.trim();
  const eq = s.indexOf('=');
  if (eq < 0) return null;
  if (s.slice(0, eq).trim().toLowerCase() !== 'cn') return null;
  return unescapeRdnValue(s.slice(eq + 1).trim()).toLowerCase();
}

/** 설정된 그룹 문자열을 매칭 항목 배열로 파싱. 항목: { dn?, cn? }(둘 다 소문자 정규화). */
export function parseGroupSpec(spec) {
  const entries = [];
  const push = (raw) => {
    const t = String(raw).trim();
    if (!t) return;
    if (ATTR_RE.test(t)) {
      // 전체 DN 지정. 단일 RDN(CN=x)만 적은 경우는 그룹명 지정으로도 인정(운영 편의).
      const parts = splitUnescaped(t, ',').map((p) => p.trim()).filter(Boolean);
      entries.push({ dn: normalizeDn(t), cn: parts.length === 1 ? firstRdnCn(t) : null });
    } else {
      // 그룹명은 memberOf의 CN 값(이스케이프 해제된 상태)과 비교하므로 같은 방식으로 해제한다
      // — 쉼표를 포함한 그룹명은 설정에 `Admins\, Global` 처럼 이스케이프해 적어야 한다.
      entries.push({ dn: null, cn: unescapeRdnValue(t).toLowerCase() });
    }
  };
  for (const chunk of splitUnescaped(String(spec ?? ''), ';\n\r')) {
    const t = chunk.trim();
    if (!t) continue;
    // DN이면 통째로, 아니면 쉼표 구분 그룹명 목록으로 취급.
    if (ATTR_RE.test(t)) push(t);
    else for (const part of splitUnescaped(t, ',')) push(part);
  }
  return entries;
}

/** memberOf 값 하나가 파싱된 항목과 일치하는지. */
function memberMatchesEntry(member, entry) {
  const raw = String(member ?? '').trim();
  if (!raw) return false;
  const cn = firstRdnCn(raw);
  if (entry.dn && normalizeDn(raw) === entry.dn) return true;   // 전체 DN 완전일치
  if (entry.cn) {
    if (cn && cn === entry.cn) return true;                     // CN 완전일치
    // memberOf가 DN이 아닌 평문 그룹명으로 오는 디렉터리 호환.
    if (!raw.includes('=') && raw.toLowerCase() === entry.cn) return true;
  }
  return false;
}

/** memberOf 목록이 설정된 그룹(spec)에 속하는지. mode='substring'이면 구버전 동작. */
export function matchesGroupSpec(memberOf, spec, mode = 'exact') {
  if (!spec) return false;
  const members = (Array.isArray(memberOf) ? memberOf : [memberOf]).filter(Boolean).map((g) => String(g));
  if (!members.length) return false;
  if (mode === 'substring') { // 하위호환 opt-out(AD_GROUP_MATCH=substring) — 권한 상승 위험 있음
    const needle = String(spec).toLowerCase();
    return members.some((g) => g.toLowerCase().includes(needle));
  }
  const entries = parseGroupSpec(spec);
  if (!entries.length) return false;
  return members.some((m) => entries.some((e) => memberMatchesEntry(m, e)));
}

/** Map the user's memberOf list to a portal role using configured group names. */
export function roleFromGroups(memberOf, ad) {
  const mode = ad?.groupMatch === 'substring' ? 'substring' : 'exact';
  const has = (spec) => matchesGroupSpec(memberOf, spec, mode);
  if (has(ad.adminGroup)) return 'admin';
  if (has(ad.operatorGroup)) return 'operator';
  if (has(ad.viewerGroup)) return 'viewer';
  // 진단: 과거 부분문자열 매칭에 의존하던 설정이면 이번 정확매칭 전환으로 역할이 내려간다
  // (관리자 잠금 사고). 어떤 그룹 설정이 왜 안 맞는지 로그로 알려 즉시 교정할 수 있게 한다.
  if (mode === 'exact') {
    for (const [role, spec] of [['admin', ad.adminGroup], ['operator', ad.operatorGroup], ['viewer', ad.viewerGroup]]) {
      if (spec && matchesGroupSpec(memberOf, spec, 'substring')) {
        const cns = (Array.isArray(memberOf) ? memberOf : [memberOf]).filter(Boolean)
          .map((g) => firstRdnCn(g) || String(g)).slice(0, 12).join(', ');
        console.warn(`[ad] 그룹 설정 '${spec}'(${role})이 부분문자열로는 맞지만 정확일치가 아닙니다 — 설정을 실제 그룹명(CN) 또는 전체 DN으로 맞추세요. 이 사용자의 그룹: ${cns}`);
        break;
      }
    }
  }
  return ad.defaultRole || 'viewer';
}

/**
 * TLS 옵션(S-03) — 사설 CA 를 주면 그것만 신뢰하고, 이름 검증은 tlsServerName(있으면) 또는 URL 호스트명으로 한다.
 * URL 이 IP 면 SNI 를 싣지 않는다(RFC 6066 — Node 가 DEP0123 경고). 그때 이름 검증은 IP(인증서 IP SAN)로 된다.
 */
function tlsOptionsFor(ad) {
  const p = adUrlParts(ad.url);
  const o = { rejectUnauthorized: ad.tlsRejectUnauthorized !== false };
  const ca = parseCaBundle(ad.caCert);
  if (ca.certs && ca.certs.length) o.ca = ca.certs;
  const name = ad.tlsServerName || (p && !net.isIP(p.host) ? p.host : '');
  if (name) o.servername = name;
  return o;
}

function makeClient(ad) {
  return ldap.createClient({
    url: ad.url,
    timeout: ad.timeoutMs,
    connectTimeout: ad.timeoutMs,
    tlsOptions: tlsOptionsFor(ad),
    reconnect: false,
  });
}

const stageErr = (stage, e) => {
  const err = e instanceof Error ? e : new Error(String(e?.message || e || stage));
  if (!err.stage) err.stage = stage;
  return err;
};

/** 연결(ldaps 면 TLS 핸드셰이크까지)을 기다린다. 시한·오류는 stage 'connect' 로 던진다. */
function waitConnect(client, ad) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fin = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
    const t = setTimeout(() => fin(reject, stageErr('connect', new Error('connect timeout'))), ad.timeoutMs);
    for (const ev of ['error', 'connectError', 'connectTimeout', 'connectRefused', 'setupError']) client.on(ev, (e) => fin(reject, stageErr('connect', e)));
    client.on('connect', () => fin(resolve));
  });
}

/**
 * StartTLS(S-03) — 성공을 확인해야만 돌아온다. ⚠ ldapjs 는 TLS 협상이 실패하면 '평문 모드로 되돌아간다'(starttls 주석) —
 * 그래서 실패면 반드시 던지고, 호출부는 bind 를 하지 않고 연결을 버린다(평문 bind 로 내려가지 않는다).
 */
function startTlsAsync(client, ad) {
  const p = adUrlParts(ad.url);
  const opts = { ...tlsOptionsFor(ad), host: p?.host };
  return new Promise((resolve, reject) => {
    let done = false;
    const fin = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
    const t = setTimeout(() => fin(reject, stageErr('starttls', new Error('StartTLS timeout'))), ad.timeoutMs);
    try {
      client.starttls(opts, [], (err) => (err ? fin(reject, stageErr('starttls', err)) : fin(resolve)));
    } catch (e) { fin(reject, stageErr('starttls', e)); }
  });
}

let _plainWarnAt = 0;
/** 연결 + 전송 보호. 돌아오면 bind 해도 되는 상태다(평문 모드는 기존 설정 호환으로만 — 경고를 남긴다). */
async function connectSecured(client, ad) {
  const mode = adTransportMode(ad);
  if (mode === 'none') throw stageErr('config', new Error('AD 서버 URL 이 ldap:// 또는 ldaps:// 형식이 아닙니다.'));
  const ca = parseCaBundle(ad.caCert);
  if (ca.error) throw stageErr('config', new Error(ca.error));
  await waitConnect(client, ad);
  if (mode === 'starttls') await startTlsAsync(client, ad);
  else if (mode === 'plain' && Date.now() - _plainWarnAt > 3_600_000) {
    _plainWarnAt = Date.now();
    console.warn('[ad] ⚠ 평문 ldap:// 로 비밀번호 bind 를 합니다(기존 저장 설정 호환) — ldaps:// 또는 StartTLS 로 바꾸세요. 새로 저장하는 평문 설정은 거부됩니다.');
  }
  return mode;
}

function bindAsync(client, dn, password) {
  return new Promise((resolve, reject) => client.bind(dn, password, (err) => (err ? reject(err) : resolve())));
}

// RFC 4515 LDAP 필터 값 이스케이프 — 사용자 입력이 필터 구조를 왜곡하지 못하게(필터 인젝션 방지).
function ldapEscape(v) {
  return String(v ?? '').replace(/[\\*()\x00]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/**
 * 사용자 검색 필터 조립(순수 — v2.598, 감사 INJ-05).
 * ⚠ **치환은 함수형으로 한 번에** 한다. 문자열 치환(`.replace(re, str)`)은 치환값의 `$\``·`$'`·`$&` 를 특수 패턴으로
 *   읽어(ldapEscape 는 `$` 를 이스케이프하지 않는다) 사용자명에 그 문자가 있으면 필터 앞뒤 조각이 끼어든다.
 *   두 번에 나눠 치환하면 앞 치환값 안의 `{user}` 글자가 다시 치환된다 — 한 번의 정규식으로 둘 다 막는다.
 */
export function buildUserFilter(userFilter, username, upn) {
  const vals = { upn: ldapEscape(upn), user: ldapEscape(username) };
  return String(userFilter || '').replace(/\{(upn|user)\}/g, (_m, k) => vals[k]);
}

function searchUser(client, ad, username, upn) {
  const filter = buildUserFilter(ad.userFilter, username, upn);
  return new Promise((resolve, reject) => {
    client.search(ad.baseDN, { scope: 'sub', filter, attributes: ['memberOf', 'displayName', 'cn', 'distinguishedName'] }, (err, res) => {
      if (err) return reject(err);
      let entry = null;
      res.on('searchEntry', (e) => { entry = e.pojo || e.object || e; });
      res.on('error', (e) => reject(e));
      res.on('end', () => resolve(entry));
    });
  });
}

function attrValue(entry, name) {
  if (!entry) return undefined;
  if (entry.attributes) { // pojo form
    const a = entry.attributes.find((x) => x.type === name);
    return a ? (a.values?.length > 1 ? a.values : a.values?.[0]) : undefined;
  }
  return entry[name];
}

/**
 * Authenticate against AD. Returns { username, name, role, source:'ad', adEpoch } or null.
 * adEpoch = 이 판정에 쓴 정책(epoch) — 토큰에 실어 정책이 바뀌면 무효가 되게 한다(S-08). 판정과 같은 설정에서 뽑는다.
 * 실패 사유(연결·StartTLS·bind)는 로그인 응답으로 내보내지 않는다(계정 열거 방지) — `lastAdAuthFailure()` 로 내부 진단만.
 */
let _lastFail = null;
export function lastAdAuthFailure() { return _lastFail; }
export async function authenticateAD(username, password) {
  const ad = loadAdConfig();
  if (!ad.enabled || !ad.url || !username || !password) return null;
  const upn = upnFor(username, ad);
  const adEpoch = adEpochOf(ad);
  const client = makeClient(ad);
  client.on('error', () => { /* 아래 단계에서 처리 — 미처리 'error' 로 프로세스를 죽이지 않게 */ });
  try {
    await connectSecured(client, ad);
    await bindAsync(client, upn, password); // verifies the password
    let memberOf, displayName;
    if (ad.baseDN) {
      try {
        const entry = await searchUser(client, ad, username, upn);
        memberOf = attrValue(entry, 'memberOf');
        displayName = attrValue(entry, 'displayName') || attrValue(entry, 'cn');
      } catch { /* search optional; fall back to default role */ }
    }
    const role = roleFromGroups(memberOf || [], ad);
    _lastFail = null;
    return { username, name: displayName || username, role, source: 'ad', adEpoch };
  } catch (e) {
    _lastFail = { at: Date.now(), stage: e?.stage || 'bind', reason: String(e?.message || e).slice(0, 300) };
    return null; // invalid credentials or AD unreachable → caller may fall back
  } finally {
    try { client.unbind(); client.destroy?.(); } catch { /* ignore */ }
  }
}

/** Connectivity/bind test for the admin UI. Optionally verifies a sample user. */
export async function testAd(cfg, sampleUser, samplePassword) {
  const base = loadAdConfig();
  const ad = { ...base, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  ad.timeoutMs = normTimeoutMs(ad.timeoutMs) ?? base.timeoutMs; // 화면의 빈 칸이 즉시 'connect timeout' 이 되지 않게
  ad.startTls = ad.startTls === true;
  ad.caCert = typeof ad.caCert === 'string' ? ad.caCert.trim() : '';
  ad.tlsServerName = typeof ad.tlsServerName === 'string' ? ad.tlsServerName.trim() : '';
  if (!ad.url) return { ok: false, stage: 'config', reason: 'AD_URL이 비어 있습니다.' };
  const mode = adTransportMode(ad);
  const transport = adTransportStatus(ad);
  // S-03: 평문 연결에는 테스트 비밀번호도 보내지 않는다(연결만 확인).
  const wantBind = !!(sampleUser && samplePassword);
  if (wantBind && mode === 'plain') {
    return { ok: false, stage: 'policy', transport, reason: '평문 ldap://(StartTLS 없음)에서는 비밀번호를 보내지 않습니다 — ldaps:// 를 쓰거나 StartTLS 를 켠 뒤 다시 테스트하세요(사용자를 비우면 연결만 확인합니다).' };
  }
  const client = makeClient(ad);
  client.on('error', () => { /* 단계별로 처리 */ });
  const started = Date.now();
  try {
    await connectSecured(client, ad);
    if (wantBind) {
      const upn = upnFor(sampleUser, ad);
      try { await bindAsync(client, upn, samplePassword); } catch (e) { throw stageErr('bind', e); }
      let role = ad.defaultRole, groups;
      if (ad.baseDN) {
        let entry;
        try { entry = await searchUser(client, ad, sampleUser, upn); } catch (e) { throw stageErr('search', e); }
        groups = attrValue(entry, 'memberOf');
        role = roleFromGroups(groups || [], ad);
      }
      return { ok: true, ms: Date.now() - started, mode, transport, boundAs: upn, role, groups: Array.isArray(groups) ? groups.slice(0, 20) : (groups ? [groups] : []) };
    }
    return { ok: true, ms: Date.now() - started, mode, transport, note: mode === 'plain' ? '연결 성공 (평문 — 자격증명 미검증)' : '연결 성공 (자격증명 미검증)' };
  } catch (err) {
    return { ok: false, stage: err?.stage || 'connect', mode, transport, reason: err?.message || String(err) };
  } finally {
    try { client.unbind(); client.destroy?.(); } catch { /* ignore */ }
  }
}
