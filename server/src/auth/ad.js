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
import ldap from 'ldapjs';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js'; // v2.478(감사 B5/S12): 원자적 쓰기 + 손상 시 preserveCorrupt — 크래시 1회로 설정이 소실되고 다음 저장이 빈 값으로 덮어쓰는 사고 방지

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
  timeoutMs: Number(process.env.AD_TIMEOUT_MS) || 8000,
};

export function loadAdConfig() {
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.ad || {}; } catch (e) { preserveCorrupt(FILE, e.message); saved = {}; }
  const merged = { ...ENV_DEFAULTS, ...saved };
  // groupMatch만 env를 우선한다 — UI 저장으로 auth.json에 'exact'가 박히면 긴급 하위호환
  // 스위치(AD_GROUP_MATCH=substring)가 먹지 않아 로그인 역할 매핑을 되돌릴 수 없게 된다.
  if (process.env.AD_GROUP_MATCH) merged.groupMatch = ENV_DEFAULTS.groupMatch;
  return merged;
}

export function saveAdConfig(partial) {
  const cur = loadAdConfig();
  const allowed = ['enabled', 'url', 'domain', 'baseDN', 'userFilter', 'adminGroup', 'operatorGroup', 'viewerGroup', 'defaultRole', 'tlsRejectUnauthorized', 'timeoutMs', 'groupMatch'];
  const next = { ...cur };
  for (const k of allowed) if (partial[k] !== undefined) next[k] = partial[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify({ ad: next }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
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

function makeClient(ad) {
  return ldap.createClient({
    url: ad.url,
    timeout: ad.timeoutMs,
    connectTimeout: ad.timeoutMs,
    tlsOptions: { rejectUnauthorized: Boolean(ad.tlsRejectUnauthorized) },
    reconnect: false,
  });
}

function bindAsync(client, dn, password) {
  return new Promise((resolve, reject) => client.bind(dn, password, (err) => (err ? reject(err) : resolve())));
}

// RFC 4515 LDAP 필터 값 이스케이프 — 사용자 입력이 필터 구조를 왜곡하지 못하게(필터 인젝션 방지).
function ldapEscape(v) {
  return String(v ?? '').replace(/[\\*() ]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function searchUser(client, ad, username, upn) {
  const filter = ad.userFilter.replace(/\{upn\}/g, ldapEscape(upn)).replace(/\{user\}/g, ldapEscape(username));
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

/** Authenticate against AD. Returns { username, name, role, source:'ad' } or null. */
export async function authenticateAD(username, password) {
  const ad = loadAdConfig();
  if (!ad.enabled || !ad.url || !username || !password) return null;
  const upn = upnFor(username, ad);
  const client = makeClient(ad);
  try {
    await new Promise((resolve, reject) => { client.on('error', reject); client.on('connect', resolve); setTimeout(() => reject(new Error('connect timeout')), ad.timeoutMs); });
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
    return { username, name: displayName || username, role, source: 'ad' };
  } catch {
    return null; // invalid credentials or AD unreachable → caller may fall back
  } finally {
    try { client.unbind(); client.destroy?.(); } catch { /* ignore */ }
  }
}

/** Connectivity/bind test for the admin UI. Optionally verifies a sample user. */
export async function testAd(cfg, sampleUser, samplePassword) {
  const ad = { ...loadAdConfig(), ...(cfg || {}) };
  if (!ad.url) return { ok: false, reason: 'AD_URL이 비어 있습니다.' };
  const client = makeClient(ad);
  const started = Date.now();
  try {
    await new Promise((resolve, reject) => { client.on('error', reject); client.on('connect', resolve); setTimeout(() => reject(new Error('connect timeout')), ad.timeoutMs); });
    if (sampleUser && samplePassword) {
      const upn = upnFor(sampleUser, ad);
      await bindAsync(client, upn, samplePassword);
      let role = ad.defaultRole, groups;
      if (ad.baseDN) {
        const entry = await searchUser(client, ad, sampleUser, upn);
        groups = attrValue(entry, 'memberOf');
        role = roleFromGroups(groups || [], ad);
      }
      return { ok: true, ms: Date.now() - started, boundAs: upn, role, groups: Array.isArray(groups) ? groups.slice(0, 20) : (groups ? [groups] : []) };
    }
    return { ok: true, ms: Date.now() - started, note: '연결 성공 (자격증명 미검증)' };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    try { client.unbind(); client.destroy?.(); } catch { /* ignore */ }
  }
}
