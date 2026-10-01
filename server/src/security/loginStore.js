/**
 * 로그인 실패 저장소(분석용) — 포탈 자체 실패 + 게스트 OS 조사 결과를 적재한다.
 * 인메모리 링 + CONFIG_DIR/login-fails.ndjson. vCenter 이벤트 실패는 vCenter 로그 DB에서 별도 분석.
 * 레코드: { ts, source, kind:'portal'|'guest', user, ip, vm?, vcenterId?, os?, reason? }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js'; // v2.582 ARCH-3: 상태 파일도 원자 쓰기(절단본 → 로드 실패 → 다음 저장이 빈 값으로 덮어쓰는 왕복 손상 차단)
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다

const FILE = path.join(config.configDir, 'login-fails.ndjson');
const MAX = 50_000;
const RETAIN_MS = 90 * 86_400_000;

let rows = null;
let _skippedLines = 0;
/**
 * v2.674: 줄 단위로 읽는다. 예전에는 깨진 줄이 **하나만** 있어도 catch 가 전체를 버리고(rows = [])
 * 4초 뒤 다음 저장이 새 기록만으로 파일을 덮어써 최대 90일치 로그인 실패 기록이 조용히 사라졌다.
 * 이제 깨진 줄만 건너뛰고 개수를 밝힌다. 파일 자체를 못 읽으면(권한 등) 덮어쓰기 전에 원본을 보존한다.
 */
function load() {
  if (rows) return rows;
  rows = [];
  let text = null;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') { console.warn(`[login-fails] 기록 파일을 읽지 못했습니다(${e.message}) — 원본을 보존하고 새로 시작합니다`); preserveCorrupt(FILE, e.message); }
    return rows;
  }
  let bad = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === 'object' && Number.isFinite(r.ts)) rows.push(r); else bad++;
    } catch { bad++; }
  }
  if (bad) { _skippedLines = bad; console.warn(`[login-fails] 읽지 못한 줄 ${bad}개를 건너뛰었습니다(나머지 ${rows.length}건은 유지)`); }
  return rows;
}
/** 진단 — 마지막으로 읽을 때 건너뛴 깨진 줄 수. */
export function loginStoreSkippedLines() { return _skippedLines; }

let writeTimer = null;
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const cut = Date.now() - RETAIN_MS;
    rows = load().filter((r) => r.ts >= cut).slice(-MAX);
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
  }, 4000);
  writeTimer.unref?.();
}
registerExitFlush('security/loginStore', () => { if (!writeTimer) return; clearTimeout(writeTimer); writeTimer = null; const cut = Date.now() - RETAIN_MS; rows = load().filter((r) => r.ts >= cut).slice(-MAX); atomicWriteFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); });

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
