/**
 * 로그인 실패 저장소(분석용) — 포탈 자체 실패 + 게스트 OS 조사 결과를 적재한다.
 * 인메모리 링 + CONFIG_DIR/login-fails.ndjson. vCenter 이벤트 실패는 vCenter 로그 DB에서 별도 분석.
 * 레코드: { ts, source, kind:'portal'|'guest', user, ip, vm?, vcenterId?, os?, reason? }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'login-fails.ndjson');
const MAX = 50_000;
const RETAIN_MS = 90 * 86_400_000;

let rows = null;
function load() {
  if (rows) return rows;
  rows = [];
  try { for (const l of fs.readFileSync(FILE, 'utf8').split('\n')) if (l.trim()) rows.push(JSON.parse(l)); } catch { rows = []; }
  return rows;
}

let writeTimer = null;
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const cut = Date.now() - RETAIN_MS;
    rows = load().filter((r) => r.ts >= cut).slice(-MAX);
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
  }, 4000);
  writeTimer.unref?.();
}

/** 범용: 실패 레코드 배열 적재(중복 dedup by ts|kind|user|ip|vm). */
export function recordLoginFails(list = []) {
  if (!list.length) return 0;
  load();
  const seen = new Set(rows.slice(-5000).map((r) => `${r.ts}|${r.kind}|${r.user}|${r.ip}|${r.vm || ''}`));
  let n = 0;
  for (const r of list) {
    const ts = r.ts || Date.now();
    const rec = { ts, source: r.source || r.kind || 'unknown', kind: r.kind || 'guest', user: String(r.user || '').slice(0, 160), ip: String(r.ip || '').slice(0, 64), vm: r.vm || '', vcenterId: r.vcenterId || '', os: r.os || '', reason: String(r.reason || '').slice(0, 200) };
    const k = `${rec.ts}|${rec.kind}|${rec.user}|${rec.ip}|${rec.vm}`;
    if (seen.has(k)) continue; seen.add(k); rows.push(rec); n++;
  }
  if (rows.length > MAX + 2000) rows = rows.slice(-MAX);
  if (n) persistSoon();
  return n;
}

export function recordPortalLoginFail({ username = '', ip = '', reason = '' } = {}) {
  recordLoginFails([{ source: 'portal', kind: 'portal', user: username, ip, reason }]);
}

/** since(ms) 이후 저장된 실패(포탈+게스트). */
export function getStoredFails(sinceTs = 0) { return load().filter((r) => r.ts >= sinceTs); }
