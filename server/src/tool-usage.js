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
import { registerExitFlush } from './util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다
import { TOOL_PATH_KEYS, TOOL_PATH2_KEYS, TOOL_EXACT_PATHS, TOOL_ENFORCEMENT_NOTES } from './auth/toolAccess.js';

const FILE = path.join(config.configDir, 'tool-usage.json');

let state = null; // { counts: {k:n}, last: {k:ts}, seq: {k:n} }
let flushTimer = null;
let tick = 0; // 동률 시 '가장 최근 사용' 판정용 단조 증가 시퀀스(같은 ms 클릭도 구분).

/**
 * v2.598(감사 AUTHZ-2598-05): 맵은 null-proto 로 만들고 **자기 속성·유한 수치만** 옮긴다.
 * 예전에는 `{}` 라 `constructor`·`toString` 같은 키가 형식 검사(영숫자·하이픈)를 통과해
 * `counts.constructor + 1` 이 함수 문자열이 됐다(상속 속성에 더하기).
 */
function cleanMap(o) {
  const m = Object.create(null);
  if (!o || typeof o !== 'object') return m;
  for (const k of Object.keys(o)) {
    const v = Number(o[k]);
    if (/^[a-z0-9-]{1,40}$/i.test(k) && Number.isFinite(v)) m[k] = v;
  }
  return m;
}

function load() {
  if (state) return state;
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { counts: cleanMap(p?.counts), last: cleanMap(p?.last), seq: cleanMap(p?.seq) };
    tick = Math.max(0, ...Object.values(state.seq));
  } catch {
    state = { counts: Object.create(null), last: Object.create(null), seq: Object.create(null) };
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
registerExitFlush('tool-usage', () => { if (!flushTimer) return; clearTimeout(flushTimer); flushTimer = null; atomicWriteFileSync(FILE, JSON.stringify(state)); });

/**
 * 키 유효성(v2.598 AUTHZ-2598-05): **서버가 아는 도구 키만** 받는다. 예전에는 형식(영숫자·하이픈 40자)만 봐서
 * viewer 가 임의 키를 무제한으로 쌓고(파일·메모리 증가) 전역 '자주 쓰는 메뉴' 를 없는 키로 채울 수 있었다.
 * 키 집합은 `auth/toolAccess.js` 의 경로 매핑 + 집행 사유 선언이다 — `audit2506` 이 웹 카탈로그의 모든
 * 키가 둘 중 하나에 있음을 고정하므로 카탈로그 전체와 같다(새 도구는 그 표에 올라가는 순간 여기서도 받는다).
 */
let _known = null;
export function knownToolKeys() {
  if (!_known) {
    _known = new Set([...Object.values(TOOL_PATH_KEYS), ...Object.values(TOOL_PATH2_KEYS),
      ...Object.values(TOOL_EXACT_PATHS), ...Object.keys(TOOL_ENFORCEMENT_NOTES)].filter((k) => typeof k === 'string'));
  }
  return _known;
}
export const MAX_KEYS = 300;   // 방어선 — 알려진 키 집합(현재 90개)보다 넉넉히
function validKey(k) {
  return typeof k === 'string' && /^[a-z0-9-]{1,40}$/i.test(k) && knownToolKeys().has(k);
}

/** 도구 1회 사용 기록. 잘못된 키는 무시. */
export function recordToolUse(k) {
  if (!validKey(k)) return { ok: false, reason: 'unknown-tool' };
  const s = load();
  if (!Object.hasOwn(s.counts, k) && Object.keys(s.counts).length >= MAX_KEYS) return { ok: false, reason: 'too-many-keys' };
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
  state = { counts: Object.create(null), last: Object.create(null), seq: Object.create(null) };
  tick = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* */ }
}
