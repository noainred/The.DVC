/**
 * sshaccess/usage.js — **키 사용 기록**(v3.9.0 · 설계 docs/design/ssh-access §8 ‘사용 기록’).
 *
 * 무엇을: 키로 접속한 결과를 (키 지문, 서버, 기능) 마다 모은다 — 처음 · 마지막 · 횟수 · 성공/실패 · 마지막 결과. 그리고 최근 사건(처음 쓰임 ·
 *   결과가 바뀜 · 실패)을 MAX_RECENT 개. ‘평소와 다름’ = 그 키가 그 서버 또는 그 기능에서 **처음** 쓰인 접속(표시 · 사건만 — 막지 않는다).
 * 어디에: `CONFIG_DIR/ssh-key-usage.json`(0600 · 원자적 쓰기 · 손상 보존 — 비밀 없음: 지문 · 키 이름 · 서버 이름 · 기능 · 시각 · 결과 종류만).
 * 성능: 폴러가 주기마다 수백 번 부른다 — **메모리만 바꾸고** 파일은 FLUSH_MS 뒤 한 번(unref 타이머) 쓴다. 매 접속 동기 쓰기 금지(루트 CLAUDE.md 성능 규약).
 * 보존: RETAIN_MS(90일) 넘게 안 쓰인 묶음 · 사건은 쓰기 때 버린다. 묶음 상한 MAX_ROWS(넘으면 가장 오래된 것부터).
 * ⚠ 이 기록은 ‘누가 언제 어느 키를 썼나’ 를 보는 화면용이다. 접속을 허락하거나 막는 판정에 쓰지 않는다(판정은 refs.resolveOsAuth 하나).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

export const USAGE_FILE_NAME = 'ssh-key-usage.json';
const FILE = () => path.join(config.configDir, 'ssh-key-usage.json');   // = USAGE_FILE_NAME
export const RETAIN_MS = 90 * 24 * 3600_000;
export const MAX_ROWS = 20_000;
export const MAX_RECENT = 500;
const FLUSH_MS = 30_000;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

const t = (v, max = 128) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

let rows = null;      // Map key → row
let byFp = null;      // 지문 → { servers:Set(서버|법인), features:Set } — 새 묶음의 ‘평소와 다름’ 판정을 전체 훑기 없이(점검 D-4)
let recent = null;    // []
let timer = null;
let dirty = false;
let loadFailed = false;

// 법인까지 열쇠에 넣는다 — 다른 법인의 같은 이름 서버는 다른 서버다(점검 C-9).
const srvKey = (server, corp) => `${server.toLowerCase()}\u0002${String(corp || '').toLowerCase()}`;
const keyOf = (fp, server, feature, corp = '') => `${fp}\u0001${srvKey(server, corp)}\u0001${feature}`;
function indexRow(r) {
  let ix = byFp.get(r.fingerprint);
  if (!ix) { ix = { servers: new Set(), features: new Set() }; byFp.set(r.fingerprint, ix); }
  ix.servers.add(srvKey(r.server, r.corp)); ix.features.add(r.feature);
}
function rebuildIndex() { byFp = new Map(); for (const r of rows.values()) indexRow(r); }

// 읽기 오류(권한 · EMFILE 등)는 손상이 아니다 — 원본을 옮기지 않고, 그동안 모은 것은 메모리에 두었다가 다시 읽히면 합쳐 쓴다(3회차 C3-5 — EACCES 로 원본을 .corrupt 로 옮겨 90일 기록이 사라졌다).
let readBlocked = false;
function readText() {
  if (!fs.existsSync(FILE())) return '';
  return fs.readFileSync(FILE(), 'utf8');
}
function load() {
  if (rows) return;
  rows = new Map(); recent = []; byFp = new Map();
  let text;
  try { text = readText(); } catch { readBlocked = true; loadFailed = true; return; }
  if (!text) return;
  parseText(text);
}
/** 파일 글 → rows · recent(지금 메모리에 덮어쓴다). 손상이면 보존하고 빈 기록. */
function parseText(text) {
  try {
    const j = JSON.parse(text);
    for (const r of Array.isArray(j?.rows) ? j.rows.slice(0, MAX_ROWS) : []) {
      if (!r || typeof r !== 'object') continue;
      const fp = t(r.fingerprint, 80); const server = t(r.server); const feature = t(r.feature, 32);
      if (!FP_RE.test(fp) || !server || !feature) continue;
      rows.set(keyOf(fp, server, feature, t(r.corp)), {
        fingerprint: fp, keyName: t(r.keyName, 64), server, corp: t(r.corp), feature,
        firstAt: num(r.firstAt), lastAt: num(r.lastAt), count: num(r.count), okCount: num(r.okCount), failCount: num(r.failCount),
        lastOk: r.lastOk === true, lastCode: t(r.lastCode, 40),
      });
    }
    recent = (Array.isArray(j?.recent) ? j.recent : []).filter((e) => e && typeof e === 'object').slice(-MAX_RECENT).map(normEvent).filter(Boolean);
    rebuildIndex();
  } catch (e) {
    // 손상 — 보존하고 빈 기록으로 간다(이 기록은 판정에 쓰지 않는다 — 접속을 막을 이유가 없다). 화면이 ‘기록 손상’ 을 말한다.
    preserveCorrupt(FILE(), e?.message); loadFailed = true; rows = new Map(); recent = []; byFp = new Map();
  }
}
function normEvent(e) {
  const fp = t(e.fingerprint, 80);
  if (!FP_RE.test(fp)) return null;
  return { at: num(e.at), fingerprint: fp, keyName: t(e.keyName, 64), server: t(e.server), corp: t(e.corp), feature: t(e.feature, 32),
    trigger: t(e.trigger, 16), by: t(e.by, 64), ok: e.ok === true, code: t(e.code, 40), unusual: t(e.unusual, 16) };
}

function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; flushKeyUsage(); }, FLUSH_MS);
  timer.unref?.();
}

/** 파일로 쓴다(테스트 · 종료 직전 · 타이머). 실패하면 다음 기회에 다시(메모리는 그대로). */
/** 읽기 오류 뒤 다시 읽혔으면 파일 기록에 메모리에 모은 것을 합친다(같은 묶음은 수를 더하고 처음 · 마지막 시각을 넓힌다). */
function mergeAfterReadBlock() {
  let text;
  try { text = readText(); } catch { return false; }
  const memRows = rows; const memRecent = recent;
  rows = new Map(); recent = []; byFp = new Map();
  readBlocked = false; loadFailed = false;
  if (text) parseText(text);
  for (const [k, m] of memRows) {
    const f = rows.get(k);
    if (!f) { rows.set(k, m); continue; }
    rows.set(k, { ...f, keyName: m.keyName || f.keyName, firstAt: Math.min(f.firstAt || m.firstAt, m.firstAt || f.firstAt), lastAt: Math.max(f.lastAt, m.lastAt),
      count: f.count + m.count, okCount: f.okCount + m.okCount, failCount: f.failCount + m.failCount,
      lastOk: m.lastAt >= f.lastAt ? m.lastOk : f.lastOk, lastCode: m.lastAt >= f.lastAt ? m.lastCode : f.lastCode });
  }
  recent = recent.concat(memRecent).sort((a, b) => a.at - b.at).slice(-MAX_RECENT);
  rebuildIndex();
  return true;
}
export function flushKeyUsage({ now = Date.now() } = {}) {
  if (!rows || !dirty) return { ok: true, skipped: true };
  if (readBlocked && !mergeAfterReadBlock()) return { ok: false, skipped: true, reason: '사용 기록 파일을 지금 읽지 못해 덮어쓰지 않았습니다(다음에 다시)' };
  const cut = now - RETAIN_MS;
  for (const [k, r] of rows) if (r.lastAt && r.lastAt < cut) rows.delete(k);
  if (rows.size > MAX_ROWS) {
    const drop = [...rows.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt).slice(0, rows.size - MAX_ROWS);
    for (const [k] of drop) rows.delete(k);
  }
  recent = recent.filter((e) => e.at >= cut).slice(-MAX_RECENT);
  rebuildIndex();
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify({ rows: [...rows.values()], recent }), { mode: 0o600 });
    dirty = false; loadFailed = false;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e?.message || e).slice(0, 80) };
  }
}

/**
 * 접속 결과 하나를 적는다(메모리 — 파일은 나중에).
 * @param {{fingerprint:string, keyName?:string, server:string, corp?:string, feature:string, ok:boolean, code?:string, trigger?:string, by?:string}} u
 * @returns {{recorded:boolean, unusual?:string}}
 */
export function noteKeyUse(u = {}, { now = Date.now() } = {}) {
  const fp = t(u.fingerprint, 80); const server = t(u.server); const feature = t(u.feature, 32);
  if (!FP_RE.test(fp) || !server || !feature) return { recorded: false };
  load();
  const corp = t(u.corp);
  const k = keyOf(fp, server, feature, corp);
  const prev = rows.get(k);
  const ok = u.ok === true;
  const code = ok ? 'ok' : (t(u.code, 40) || 'fail');
  let unusual = '';
  if (!prev) {
    const ix = byFp.get(fp);
    unusual = !ix || !ix.servers.has(srvKey(server, corp)) ? 'new-server' : (!ix.features.has(feature) ? 'new-feature' : '');
  }
  const row = prev || { fingerprint: fp, keyName: '', server, corp, feature, firstAt: now, lastAt: 0, count: 0, okCount: 0, failCount: 0, lastOk: false, lastCode: '' };
  const changed = !prev || prev.lastOk !== ok || (!ok && prev.lastCode !== code);
  Object.assign(row, { keyName: t(u.keyName, 64) || row.keyName, corp: t(u.corp) || row.corp, lastAt: now, count: row.count + 1,
    okCount: row.okCount + (ok ? 1 : 0), failCount: row.failCount + (ok ? 0 : 1), lastOk: ok, lastCode: code });
  rows.set(k, row);
  if (!prev) indexRow(row);
  // 사건은 처음 · 결과가 바뀜 · 실패 · 사람이 누른 것만(주기 성공을 매번 쌓지 않는다 — 기록이 넘치면 볼 수 없다).
  if (changed || !ok || u.trigger === 'manual' || u.by) {
    recent.push({ at: now, fingerprint: fp, keyName: row.keyName, server, corp: row.corp, feature, trigger: t(u.trigger, 16) || 'auto', by: t(u.by, 64), ok, code, unusual });
    if (recent.length > MAX_RECENT * 2) recent = recent.slice(-MAX_RECENT);
  }
  schedule();
  return { recorded: true, ...(unusual ? { unusual } : {}) };
}

/** 지문마다 마지막 사용(화면 ‘마지막 사용’ — 전체를 한 번 훑는다 · 정렬 없음). 예전에는 최근 5묶음에서만 찾아 대부분 키를 ‘쓴 기록 없음’ 으로 그렸다(점검 D-3 · E-M3). */
export function lastUseByFingerprint() {
  load();
  const m = new Map();
  for (const r of rows.values()) { const p = m.get(r.fingerprint); if (!p || r.lastAt > p.lastAt) m.set(r.fingerprint, { lastAt: r.lastAt, server: r.server, corp: r.corp, feature: r.feature, ok: r.lastOk }); }
  return m;
}
export function keyUsageLoadFailed() { load(); return loadFailed; }

/** 화면용 — 묶음(최근 사용 순) · 최근 사건(최신 먼저). 비밀 없음. */
export function keyUsageView({ fingerprint = '', limit = 200 } = {}) {
  load();
  const fp = t(fingerprint, 80);
  const list = [...rows.values()].filter((r) => !fp || r.fingerprint === fp).sort((a, b) => b.lastAt - a.lastAt);
  const ev = recent.filter((e) => !fp || e.fingerprint === fp).slice(-Math.max(1, Math.min(MAX_RECENT, limit))).reverse();
  return { rows: list.slice(0, Math.max(1, Math.min(2000, limit * 5))), totalRows: list.length, recent: ev, retainDays: RETAIN_MS / 86_400_000, loadFailed };
}

export function _resetKeyUsageForTest() { if (timer) clearTimeout(timer); timer = null; rows = null; recent = null; byFp = null; dirty = false; loadFailed = false; readBlocked = false; }
