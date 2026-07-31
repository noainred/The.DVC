/**
 * iDRAC 스캔 실행 로그 — 주기/수동 스캔의 법인(DataCenter)별 실행 결과를 영속 저장한다.
 * scanRanges의 lastRun은 엔트리당 '최근 1건'만 남는 반면, 이 로그는 실행 이력 전체를
 * 상한 내에서 보관해 설정 > 수집 서버 > '스캔 로그' 화면에서 전체 통합/법인별로 조회한다.
 *
 * 기록 시점:
 *  - 중앙 직접 스캔: scanPoller가 법인 하나를 스캔 완료할 때마다 1건(결과 포함).
 *  - 위임 스캔: ① 위임 요청 시 1건(phase=dispatch — 결과 미정) + ② 에이전트 결과 회신 시
 *    1건(phase=result, setIdracScanResult 훅). reqId로 짝을 맞출 수 있다.
 *
 * 저장: CONFIG_DIR/idrac-scan-log.json (0600, 원자적 쓰기). 로그 유량이 작으므로
 * (주기 스캔 = 법인 수십 건/사이클) JSON 파일이면 충분하다 — 단, 매 append가 전체 파일
 * 재기록이므로 MAX_ENTRIES 상한으로 파일/응답 크기를 고정한다(초과분은 오래된 것부터 삭제).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'idrac-scan-log.json');
const MAX_ENTRIES = 2000; // 240h 주기 × 법인 ~16곳 기준 수년치 — 수동 스캔이 잦아도 충분

let cache = null;     // { entries: [...] } — 오래된 것 → 최신 순(append)
let cacheMtime = -1;

function read() {
  let mtime = -1;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch { mtime = 0; }
  if (cache && mtime === cacheMtime) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { entries: Array.isArray(j?.entries) ? j.entries : [] };
  } catch { cache = { entries: [] }; }
  cacheMtime = mtime;
  return cache;
}

function write(data) {
  cache = data;
  try {
    atomicWriteFileSync(FILE, JSON.stringify(data), { mode: 0o600 });
    try { cacheMtime = fs.statSync(FILE).mtimeMs; } catch { cacheMtime = -1; }
  } catch (e) { console.error('[idrac-scan-log] 저장 실패:', e.message); }
}

const s = (v, max = 128) => String(v ?? '').trim().slice(0, max);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 실행 기록 1건 추가. rec:
 *  { trigger:'periodic'|'manual', phase:'result'|'dispatch', kind:'central'|'delegated',
 *    datacenterId, service, agent, dispatch:'poll'|'push'|'', reqId,
 *    scanned, found, registered, durationMs, error, stopped }
 * 비밀번호/자격증명 등 민감정보는 받지도 저장하지도 않는다.
 */
export function appendIdracScanLog(rec = {}) {
  const entry = {
    at: Date.now(),
    trigger: rec.trigger === 'manual' ? 'manual' : 'periodic',
    phase: rec.phase === 'dispatch' ? 'dispatch' : 'result',
    kind: rec.kind === 'delegated' ? 'delegated' : 'central',
    datacenterId: s(rec.datacenterId),
    service: s(rec.service),
    agent: s(rec.agent),
    dispatch: rec.dispatch === 'push' ? 'push' : (rec.dispatch === 'poll' ? 'poll' : ''),
    reqId: s(rec.reqId, 64),
    scanned: n(rec.scanned),
    found: n(rec.found),
    registered: n(rec.registered),
    durationMs: n(rec.durationMs),
    error: rec.error ? s(rec.error, 500) : null,
    stopped: rec.stopped ? true : undefined,
  };
  const data = read();
  const entries = data.entries.length >= MAX_ENTRIES
    ? [...data.entries.slice(-(MAX_ENTRIES - 1)), entry]
    : [...data.entries, entry];
  write({ entries });
  return entry;
}

/**
 * 조회(최신순). opts: { datacenterId?: 특정 법인만, limit?: 최대 건수(기본 300, 상한 1000) }.
 * datacenterId 미지정 = 전체 통합 보기.
 */
export function listIdracScanLog(opts = {}) {
  const dc = s(opts.datacenterId);
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 300));
  const all = read().entries;
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const e = all[i];
    if (dc && s(e.datacenterId) !== dc) continue;
    out.push(e);
  }
  return out;
}

/** 로그에 등장하는 법인 목록(필터 셀렉트용, 가나다순). */
export function idracScanLogDatacenters() {
  const set = new Set();
  for (const e of read().entries) { const d = s(e.datacenterId); if (d) set.add(d); }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** 테스트용 캐시 리셋. */
export function _resetIdracScanLogCache() { cache = null; cacheMtime = -1; }
