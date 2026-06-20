/**
 * IPMS settings — IP ranges to hide from the IP ledger. Supports a global
 * ignore list and per-vCenter ignore lists. Entries may be CIDR (10.0.0.0/8),
 * a range (10.0.0.1-10.0.0.50), or a single IP. Stored in CONFIG_DIR/ipam-settings.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { ipToNum } from './ledger.js';

const FILE = path.join(config.configDir, 'ipam-settings.json');

let cache = null;       // raw settings
let matcherCache = null; // compiled matcher

let classifierCache = null;

function load() {
  if (cache) return cache;
  cache = { global: [], vcenters: {}, publicRanges: [], privateRanges: [] };
  try { if (fs.existsSync(FILE)) { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = { global: s.global || [], vcenters: s.vcenters || {}, publicRanges: s.publicRanges || [], privateRanges: s.privateRanges || [] }; } } catch { /* defaults */ }
  return cache;
}

export function loadSettings() { return load(); }

export function saveSettings(body = {}) {
  const next = {
    global: cleanList(body.global),
    vcenters: Object.fromEntries(Object.entries(body.vcenters || {}).map(([k, v]) => [k, cleanList(v)]).filter(([, v]) => v.length)),
    publicRanges: cleanList(body.publicRanges),
    privateRanges: cleanList(body.privateRanges),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next; matcherCache = null; classifierCache = null;
  return next;
}

// RFC1918 private space (default when no explicit rule matches).
const RFC1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(parseRange);
const inAny = (n, ranges) => ranges.some((r) => n >= r.lo && n <= r.hi);

/** Returns ip → 'public' | 'private'. Explicit rules win; else RFC1918 = private. */
export function getClassifier() {
  if (classifierCache) return classifierCache;
  const s = load();
  const pub = (s.publicRanges || []).map(parseRange).filter(Boolean);
  const priv = (s.privateRanges || []).map(parseRange).filter(Boolean);
  classifierCache = (ip) => {
    const n = ipToNum(ip);
    if (n == null) return 'private';
    if (inAny(n, priv)) return 'private';
    if (inAny(n, pub)) return 'public';
    return inAny(n, RFC1918) ? 'private' : 'public';
  };
  return classifierCache;
}

const cleanList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);

function parseRange(s) {
  s = String(s).trim();
  if (!s) return null;
  if (s.includes('/')) {
    const [b, m] = s.split('/');
    const base = ipToNum(b); const mask = Number(m);
    if (base == null || !(mask >= 0 && mask <= 32)) return null;
    const size = 2 ** (32 - mask);
    const lo = Math.floor(base / size) * size;
    return { lo, hi: lo + size - 1 };
  }
  if (s.includes('-')) {
    const [a, b] = s.split('-');
    const lo = ipToNum(a.trim()), hi = ipToNum(b.trim());
    if (lo == null || hi == null) return null;
    return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  }
  const n = ipToNum(s);
  return n == null ? null : { lo: n, hi: n };
}

/** Returns (ip, vcenterId) → true if the IP should be hidden. */
export function getIgnoreMatcher() {
  if (matcherCache) return matcherCache;
  const s = load();
  const global = (s.global || []).map(parseRange).filter(Boolean);
  const vc = {};
  for (const [k, arr] of Object.entries(s.vcenters || {})) vc[k] = (arr || []).map(parseRange).filter(Boolean);
  const inAny = (n, ranges) => ranges.some((r) => n >= r.lo && n <= r.hi);
  matcherCache = (ip, vcenterId) => {
    const n = ipToNum(ip);
    if (n == null) return false;
    if (inAny(n, global)) return true;
    const v = vc[vcenterId];
    return v ? inAny(n, v) : false;
  };
  matcherCache.empty = global.length === 0 && Object.keys(vc).length === 0;
  return matcherCache;
}
