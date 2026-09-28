/**
 * ipam/scanLog.js — IP 스캔 **실행 로그**(v2.636 — 사용자 요청 "sub menu 에 scan 상태, 로그를 볼 수 있는 기능도 추가해줘",
 * 선택 "스캔 실행 로그를 새로 기록").
 *
 * 왜 새로 두는가: 기존 `scanStore.recordRun` 은 **완료된 스캔의 개수**(에이전트·스캔 수·응답 수·소요)만 남긴다. 그래서
 * '왜 스캔이 안 돌았나'(비활성·대역 없음·이미 실행 중) · '어디서 실패했나'(오류 문구) · '누가 대역을 바꿨나' 는 어디에도
 * 없었다. 이 로그가 그 사건들을 시간순으로 남긴다.
 *
 * 기록하는 사건(`event`):
 *  · start / finish / fail — 이 포탈이 직접 도는 스캔(주기·수동). start 에는 대역 수와 앞 몇 개 대역 표본이 들어간다.
 *  · skip — 주기 틱에서 스캔하지 않은 이유(비활성·대역 없음). ⚠ 같은 사유가 연속되면 **새 줄을 만들지 않고** 그 줄의
 *    `count` 와 `at` 만 올린다 — 꺼진 채 두면 주기마다 같은 줄이 쌓여 상한을 비이벤트로 소진한다(v2.517 규약).
 *  · busy — '지금 스캔' 을 눌렀는데 이미 실행 중이었다.
 *  · report / reject — 엣지(에이전트)가 보낸 스캔 결과를 받았다 / 받지 않았다(배정 범위 없음 등). 엣지 **안에서** 돈
 *    스캔의 상세는 그 엣지에 있다 — 중앙은 받은 보고만 안다(화면이 그 사실을 말한다).
 *  · settings — 스캔 대역·주기 설정이 바뀌었다(누가, 어느 에이전트, 대역 수). CSV 가져오기도 여기로 온다.
 *
 * 규약:
 *  · 인메모리 링버퍼 + 파일 영속(0600, 원자 쓰기, 같은 틱 기록은 한 번에 — `util/activityLog.js` 와 같은 방식).
 *    재생성 가능한 기록이라 손상 파일은 보존하지 않고 새로 시작한다(activityLog 와 같은 판단).
 *  · 상한 `IPAM_SCAN_LOG_MAX`(기본 1000, 하한 100). 문구는 300자로 자른다. 비밀은 들어오지 않는다(대역·개수·사유뿐).
 *  · 수치 필드는 유한수가 아니면 **null**(0 과 '모름' 을 섞지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { numOrNull } from '../util/numOrNull.js';

export const SCAN_LOG_FILE_NAME = 'ipam-scan-log.json';
registerStateFile(SCAN_LOG_FILE_NAME);
const FILE = () => path.join(config.configDir, SCAN_LOG_FILE_NAME);
export const SCAN_LOG_EVENTS = Object.freeze(['start', 'finish', 'fail', 'skip', 'busy', 'report', 'reject', 'settings']);
const LEVEL_OF = Object.freeze({ start: 'info', finish: 'info', report: 'info', settings: 'info', skip: 'warn', busy: 'warn', reject: 'warn', fail: 'error' });
export const SCAN_LOG_MAX = (() => {
  const n = numOrNull(process.env.IPAM_SCAN_LOG_MAX);
  return n != null && n > 0 ? Math.max(100, Math.floor(n)) : 1000;
})();

let buf = null;
let tickOpen = false;
let dirty = false;

function load() {
  if (buf) return buf;
  try {
    const a = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    buf = Array.isArray(a) ? a.slice(-SCAN_LOG_MAX) : [];
  } catch { buf = []; }
  return buf;
}
function writeNow() {
  if (!buf) return;
  dirty = false;
  try { atomicWriteFileSync(FILE(), JSON.stringify(buf), { mode: 0o600 }); } catch { dirty = true; }
}
function flush() { if (dirty) writeNow(); }
registerExitFlush(`ipam/${SCAN_LOG_FILE_NAME}`, flush);

const str = (v, max = 300) => (v == null ? '' : String(v).slice(0, max));
const strList = (v, n = 8) => (Array.isArray(v) ? v.map((x) => str(x, 64)).filter(Boolean).slice(0, n) : []);

/**
 * 사건 1건 기록. 모르는 event 는 기록하지 않는다(판정이 흩어지지 않게 — 목록은 SCAN_LOG_EVENTS 하나).
 * @returns {object|null} 기록된 줄(또는 연속 skip 으로 합쳐진 줄)
 */
export function recordScanLog(evt = {}) {
  const event = String(evt.event || '');
  if (!SCAN_LOG_EVENTS.includes(event)) return null;
  const b = load();
  const at = numOrNull(evt.at) ?? Date.now();
  const agent = str(evt.agent || '__local__', 120);
  const message = str(evt.message);
  // 같은 사유의 연속 skip·reject 는 한 줄로 합친다(비이벤트가 상한을 소진하지 않게).
  const last = b[b.length - 1];
  if ((event === 'skip' || event === 'reject') && last && last.event === event && last.agent === agent && last.message === message) {
    last.count = (numOrNull(last.count) ?? 1) + 1;
    last.lastAt = at;
    markDirty();
    return last;
  }
  const e = {
    at, event, level: LEVEL_OF[event], agent,
    trigger: evt.trigger === 'manual' ? 'manual' : evt.trigger === 'periodic' ? 'periodic' : evt.trigger ? str(evt.trigger, 32) : '',
    ranges: numOrNull(evt.ranges),
    rangesSample: strList(evt.rangesSample),
    scanned: numOrNull(evt.scanned),
    alive: numOrNull(evt.alive),
    durationMs: numOrNull(evt.durationMs),
    dropped: numOrNull(evt.dropped),
    user: str(evt.user, 64),
    message,
  };
  b.push(e);
  if (b.length > SCAN_LOG_MAX) b.splice(0, b.length - SCAN_LOG_MAX);
  markDirty();
  return e;
}
function markDirty() {
  if (tickOpen) { dirty = true; return; }
  tickOpen = true;
  writeNow();
  queueMicrotask(() => { tickOpen = false; flush(); });
}

/**
 * 최근 기록 newest-first. 필터: agent(대소문자 무시)·level·event. 반환에 전체·걸러진 개수·상한을 싣는다(조용한 상한 금지).
 */
export function listScanLog({ limit = 200, agent = '', level = '', event = '' } = {}) {
  flush();
  const all = load();
  const ag = String(agent || '').trim().toLowerCase();
  const lv = String(level || '').trim();
  const ev = String(event || '').trim();
  const rows = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (ag && String(e.agent || '').toLowerCase() !== ag) continue;
    if (lv && e.level !== lv) continue;
    if (ev && e.event !== ev) continue;
    rows.push(e);
  }
  const n = Math.max(1, Math.min(SCAN_LOG_MAX, Math.floor(numOrNull(limit) ?? 200)));
  return { entries: rows.slice(0, n), matched: rows.length, total: all.length, max: SCAN_LOG_MAX, truncated: rows.length > n };
}

export function _resetScanLogForTest() { flush(); buf = null; tickOpen = false; dirty = false; }
