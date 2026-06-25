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

const FILE = path.join(config.configDir, 'auth.json');

const ENV_DEFAULTS = {
  enabled: process.env.AD_ENABLED === 'true',
  url: process.env.AD_URL || '',                       // ldap://dc.corp.local:389 or ldaps://...:636
  domain: process.env.AD_DOMAIN || '',                 // corp.local  → user@corp.local
  baseDN: process.env.AD_BASE_DN || '',                // DC=corp,DC=local
  userFilter: process.env.AD_USER_FILTER || '(|(userPrincipalName={upn})(sAMAccountName={user}))',
  adminGroup: process.env.AD_ADMIN_GROUP || '',        // CN or substring, e.g. "VMware-Portal-Admins"
  operatorGroup: process.env.AD_OPERATOR_GROUP || '',
  viewerGroup: process.env.AD_VIEWER_GROUP || '',
  defaultRole: process.env.AD_DEFAULT_ROLE || 'viewer',
  tlsRejectUnauthorized: process.env.AD_TLS_REJECT_UNAUTHORIZED === 'true',
  timeoutMs: Number(process.env.AD_TIMEOUT_MS) || 8000,
};

export function loadAdConfig() {
  let saved = {};
  try { if (fs.existsSync(FILE)) saved = JSON.parse(fs.readFileSync(FILE, 'utf8'))?.ad || {}; } catch { saved = {}; }
  return { ...ENV_DEFAULTS, ...saved };
}

export function saveAdConfig(partial) {
  const cur = loadAdConfig();
  const allowed = ['enabled', 'url', 'domain', 'baseDN', 'userFilter', 'adminGroup', 'operatorGroup', 'viewerGroup', 'defaultRole', 'tlsRejectUnauthorized', 'timeoutMs'];
  const next = { ...cur };
  for (const k of allowed) if (partial[k] !== undefined) next[k] = partial[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ ad: next }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  return next;
}

function upnFor(username, ad) {
  if (username.includes('@') || username.includes('\\')) return username;
  return ad.domain ? `${username}@${ad.domain}` : username;
}

// Map the user's memberOf list to a portal role using configured group names.
function roleFromGroups(memberOf, ad) {
  const groups = (Array.isArray(memberOf) ? memberOf : [memberOf]).filter(Boolean).map((g) => String(g).toLowerCase());
  const has = (name) => name && groups.some((g) => g.includes(String(name).toLowerCase()));
  if (has(ad.adminGroup)) return 'admin';
  if (has(ad.operatorGroup)) return 'operator';
  if (has(ad.viewerGroup)) return 'viewer';
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

function searchUser(client, ad, username, upn) {
  const filter = ad.userFilter.replace(/\{upn\}/g, upn).replace(/\{user\}/g, username);
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
