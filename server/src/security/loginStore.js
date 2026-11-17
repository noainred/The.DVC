/**
 * 로그인 실패 저장소(분석용) — 포탈 자체 실패 + 게스트 OS 조사 결과를 적재한다.
 * 인메모리 링 + CONFIG_DIR/login-fails.ndjson. vCenter 이벤트 실패는 vCenter 로그 DB에서 별도 분석.
 * 레코드: { ts, source, kind:'portal'|'guest', user, ip, vm?, vcenterId?, os?, reason? }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { READ_RETRY_MS, nowMs } from '../util/jsonFileRead.js';   // 97회차 F9: 읽기 오류 재읽기 간격 · 시계(테스트가 바꾼다) // v2.582 ARCH-3: 상태 파일도 원자 쓰기(절단본 → 로드 실패 → 다음 저장이 빈 값으로 덮어쓰는 왕복 손상 차단)
import { pushAll } from '../util/pushAll.js';   // 97회차 F9: 읽기 오류 동안 쌓인 기록 이어 붙이기 — 원소 수 무관(audit2603a 스윕)
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다

const FILE = path.join(config.configDir, 'login-fails.ndjson');
const MAX = 50_000;
const RETAIN_MS = 90 * 86_400_000;

let rows = null;
let _skippedLines = 0;
/**
 * v2.674: 줄 단위로 읽는다. 예전에는 깨진 줄이 **하나만** 있어도 catch 가 전체를 버리고(rows = [])
 * 4초 뒤 다음 저장이 새 기록만으로 파일을 덮어써 최대 90일치 로그인 실패 기록이 조용히 사라졌다.
 * 이제 깨진 줄만 건너뛰고 개수를 밝힌다.
 * 97회차 F9(재현 — EISDIR): 파일 자체를 못 읽으면(권한 · 디스크 — **손상이 아니다**) 예전에는 원본을 보존본으로 **옮기고** 빈 기록으로 시작해,
 *   다음 저장이 새 기록만 든 파일을 썼다(권한을 바로잡아도 90일치는 보존본에만). 이제 원본은 그대로 두고 · 그동안 파일에 쓰지 않고(새 기록은 메모리에) ·
 *   READ_RETRY_MS(30초) 간격으로 다시 읽어, 읽히면 파일 기록에 메모리 기록을 이어 붙여 쓴다.
 */
let _readErr = null;      // 읽기 오류 코드(원본 그대로 — 쓰지 않는다)
let _readRetryAt = 0;
function load() {
  if (rows && !_readErr) return rows;
  if (rows && _readErr && nowMs() < _readRetryAt) return rows;
  const pending = _readErr && rows ? rows : [];   // 읽기 오류 동안 메모리에만 쌓인 기록
  let text = null;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') {
      if (!_readErr) console.warn(`[login-fails] 기록 파일을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상이 아니라 원본은 그대로 둡니다 · 그동안 파일에 쓰지 않고 ${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽습니다`);
      _readErr = String(e?.code || 'read-error').slice(0, 32); _readRetryAt = nowMs() + READ_RETRY_MS;
      rows = pending;
      return rows;
    }
    if (_readErr) console.warn('[login-fails] 기록 파일이 없어졌습니다(읽기 오류 풀림) — 메모리 기록으로 이어 갑니다');
    _readErr = null; rows = pending;
    return rows;
  }
  if (_readErr) console.warn('[login-fails] 기록 파일을 다시 읽었습니다(읽기 오류 풀림)');
  _readErr = null;
  rows = [];
  let bad = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === 'object' && Number.isFinite(r.ts)) rows.push(r); else bad++;
    } catch { bad++; }
  }
  if (bad) { _skippedLines = bad; console.warn(`[login-fails] 읽지 못한 줄 ${bad}개를 건너뛰었습니다(나머지 ${rows.length}건은 유지)`); }
  if (pending.length) { pushAll(rows, pending); persistSoon(); }
  return rows;
}
/** 97회차 F9: 기록 파일 읽기 오류 코드(원본 그대로 · 쓰지 않는 중) 또는 null. */
export function loginStoreReadError() { load(); return _readErr; }
/** 테스트 전용 — 메모리 · 읽기 오류 상태를 버린다(파일은 건드리지 않는다). */
export function _resetLoginStoreForTest() { rows = null; _readErr = null; _readRetryAt = 0; _skippedLines = 0; if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } }
/** 진단 — 마지막으로 읽을 때 건너뛴 깨진 줄 수. */
export function loginStoreSkippedLines() { return _skippedLines; }

let writeTimer = null;
function persistSoon() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const cut = Date.now() - RETAIN_MS;
    rows = load().filter((r) => r.ts >= cut).slice(-MAX);
    if (_readErr) return;   // 97회차 F9: 읽기 오류 중에는 원본을 덮지 않는다(다시 읽히면 load 가 이어 붙여 다시 예약한다)
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
  }, 4000);
  writeTimer.unref?.();
}
registerExitFlush('security/loginStore', () => { if (!writeTimer) return; clearTimeout(writeTimer); writeTimer = null; const cut = Date.now() - RETAIN_MS; rows = load().filter((r) => r.ts >= cut).slice(-MAX); if (_readErr) return; atomicWriteFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); });

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
