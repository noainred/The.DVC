/**
 * 특수 기능 사용 빈도 집계 — "사람들이 자주 쓰는 메뉴"를 자동 추천하기 위한 카운터.
 *
 * 특수 기능 카드를 클릭(실행)할 때마다 키별 누적 횟수와 마지막 사용시각을 센다. 상단에
 * 상위 N개를 노출해 자주 쓰는 기능을 바로 찾게 한다. 여러 사용자의 클릭이 한 중앙 포탈로
 * 모이므로 집계는 "전체 사용자 합산"이다(개인 브라우저 localStorage가 아님).
 *
 * 저장은 CONFIG_DIR/tool-usage.json. 클릭마다 동기 디스크 쓰기로 이벤트 루프를 막지 않도록
 * 메모리에 누적하고 쓰기는 디바운스(2s)로 묶는다. 고RTT·다수 vCenter 폴링과 같은 루프에서
 * 도는 프로세스라 매 클릭 fsync는 피한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync } from './util/atomicWrite.js';

const FILE = path.join(config.configDir, 'tool-usage.json');

let state = null; // { counts: {k:n}, last: {k:ts}, seq: {k:n} }
let flushTimer = null;
let tick = 0; // 동률 시 '가장 최근 사용' 판정용 단조 증가 시퀀스(같은 ms 클릭도 구분).

function load() {
  if (state) return state;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = {
      counts: p && typeof p.counts === 'object' && p.counts ? p.counts : {},
      last: p && typeof p.last === 'object' && p.last ? p.last : {},
      seq: p && typeof p.seq === 'object' && p.seq ? p.seq : {},
    };
    tick = Math.max(0, ...Object.values(state.seq).map(Number).filter(Number.isFinite));
  } catch {
    state = { counts: {}, last: {}, seq: {} };
  }
  return state;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { atomicWriteFileSync(FILE, JSON.stringify(state)); }
    catch (e) { console.warn('[tool-usage] 저장 실패:', e.message); }
  }, 2_000);
  flushTimer.unref?.();
}

/** 키 유효성: 영문/숫자/하이픈만 허용(임의 입력으로 파일이 부풀지 않게). */
function validKey(k) {
  return typeof k === 'string' && /^[a-z0-9-]{1,40}$/i.test(k);
}

/** 도구 1회 사용 기록. 잘못된 키는 무시. */
export function recordToolUse(k) {
  if (!validKey(k)) return { ok: false };
  const s = load();
  s.counts[k] = (s.counts[k] || 0) + 1;
  s.last[k] = Date.now();
  s.seq[k] = ++tick;
  scheduleFlush();
  return { ok: true, count: s.counts[k] };
}

/**
 * 상위 N개 키 반환. 정렬: 누적 횟수 내림차순 → 동률 시 최근 사용 우선.
 * @param {number} n
 * @returns {{k:string,count:number,last:number}[]}
 */
export function getTopTools(n = 3) {
  const s = load();
  return Object.keys(s.counts)
    .map((k) => ({ k, count: s.counts[k] || 0, last: s.last[k] || 0, seq: s.seq[k] || 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || b.seq - a.seq)
    .slice(0, Math.max(0, n))
    .map(({ k, count, last }) => ({ k, count, last }));
}

/** 테스트/관리용 초기화. */
export function resetToolUsage() {
  state = { counts: {}, last: {}, seq: {} };
  tick = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
