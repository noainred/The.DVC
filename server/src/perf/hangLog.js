/**
 * perf/hangLog.js — hang(이벤트 루프 정체·화면 장기 로딩) 이벤트를 `perf-hangs.ndjson` 에 남긴다(v2.498).
 *
 * 사용자 요청: "이런 hang 현상이 발생할 때 로그 찍어서 나중에 튜닝할 때 사용하게 하자" — 재시작해도
 * 남아야 하므로 파일이다. 한 줄 = 한 이벤트(NDJSON)로 **append 만** 한다:
 *  · JSON 배열 파일은 append 마다 전량 재기록 + fsync 라(util/atomicWrite) 정체 직후 버스트에서
 *    오히려 루프를 더 막는다. append 는 O(1) 이고 비동기다.
 *  · 쓰기는 `fs.appendFile`(비동기, 실패 무시) — 계측이 서비스를 방해하지 않는다는 원칙(loopLag.js).
 * 유량 방어: 분당 상한 + 파일 줄 수 상한(초과 시 뒤쪽 N줄만 남겨 1회 재기록) + 보존일 지난 줄 제거.
 * 비밀은 담지 않는다 — 경로(쿼리 제거)·사용자명·수치만.
 *
 * **쓰기는 직렬화한다**(v2.498 개발 중 실측으로 확정): `fs.appendFile` 을 동시에 여러 번 부르면
 * 스레드풀에서 처리 순서가 보장되지 않아 파일의 줄 순서가 호출 순서와 달라진다(테스트에서 1004
 * 다음에 1003 이 오는 것을 실제로 관측). 더 나쁜 것은, 그 사이에 트림(동기 읽기+전량 재기록)이
 * 끼면 읽은 뒤 도착한 줄이 재기록으로 사라진다. 그래서 메모리 큐에 모아 **동시 1건만** append 하고,
 * 트림은 큐가 비고 쓰기가 없을 때만 돌린다. 조회는 그래도 `at` 기준으로 정렬해 돌려준다
 * (외부에서 파일을 편집·병합한 경우에도 최신 먼저를 보장).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'perf-hangs.ndjson');
const MAX_LINES = Math.max(500, Math.min(200_000, Number(process.env.PERF_HANG_LOG_MAX_LINES) || 20_000));
const MAX_PER_MIN = Math.max(1, Math.min(600, Number(process.env.PERF_HANG_LOG_MAX_PER_MIN) || 60));
const MAX_READ_BYTES = 8 * 1024 * 1024; // tail 읽기 상한 — 큰 파일 전체를 메모리로 올리지 않는다
// 파일 크기 상한. **줄 수만으로 판정하면 트림이 무력해진다**: 트림은 꼬리 MAX_READ_BYTES 만 읽어
// 줄을 세므로, 이벤트 1건이 ~1KB 인 이 로그에서는 꼬리에 8,600줄밖에 안 담기고 MAX_LINES(기본
// 20,000)에 영원히 도달하지 못해 파일이 무한히 자란다(개발 중 20.8MB 파일로 실측: trimmed 0).
const MAX_BYTES = Math.max(1024 * 1024, Math.min(256 * 1024 * 1024, Number(process.env.PERF_HANG_LOG_MAX_BYTES) || 8 * 1024 * 1024));

let minuteBucket = 0;
let minuteCount = 0;
let dropped = 0;      // 분당 상한으로 버린 줄 수(정직 표기용)
let appended = 0;
let lastError = '';
let sinceTrim = 0;
let queue = [];       // 대기 중인 줄(동시 append 금지 — 위 주석 참조)
let writing = false;
const MAX_QUEUE = 1_000;
// 분당 상한은 모듈 로드 시 env 로 굳는다(문서 스캐너가 그 형태를 읽는다). 테스트에서만 바꿀 수
// 있게 오버라이드를 둔다 — 운영 코드에서는 절대 호출하지 않는다.
let maxPerMinOverride = 0;
let maxBytesOverride = 0;
const perMinLimit = () => maxPerMinOverride || MAX_PER_MIN;
const maxBytesLimit = () => maxBytesOverride || MAX_BYTES;

export function hangLogFile() { return FILE; }

/** 큐를 한 번의 append 로 흘린다. 쓰기가 끝난 뒤에만 다음 쓰기·트림을 한다. */
function flushQueue() {
  if (writing || !queue.length) return;
  writing = true;
  const lines = queue;
  queue = [];
  const chunk = lines.join('');
  try {
    fs.appendFile(FILE, chunk, { mode: 0o600 }, (err) => {
      writing = false;
      if (err) lastError = err.message; else appended += lines.length;
      if (queue.length) { flushQueue(); return; }
      // 트림은 쓰기가 없을 때만 — 동시에 하면 읽은 뒤 도착한 줄이 재기록으로 사라진다.
      if (sinceTrim >= 200) { sinceTrim = 0; trimHangLog(); }
    });
  } catch (e) {
    writing = false;
    lastError = e.message;
  }
}

/** 이벤트 1건 기록(비동기·실패 무시). 반환: 큐에 넣었는지(분당 상한 초과면 false). */
export function appendHang(ev) {
  const now = Date.now();
  const bucket = Math.floor(now / 60_000);
  if (bucket !== minuteBucket) { minuteBucket = bucket; minuteCount = 0; }
  if (minuteCount >= perMinLimit()) { dropped += 1; return false; }
  if (queue.length >= MAX_QUEUE) { dropped += 1; return false; }
  minuteCount += 1;
  let line;
  try { line = `${JSON.stringify({ ...ev, at: ev?.at || now })}\n`; }
  catch { return false; }
  queue.push(line);
  sinceTrim += 1;
  flushQueue();
  return true;
}

/** 대기 중인 줄이 모두 파일에 들어갈 때까지 기다린다(테스트·종료 시). */
export async function flushHangLog({ timeoutMs = 2_000 } = {}) {
  const t0 = Date.now();
  while ((queue.length || writing) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { pending: queue.length, writing };
}

/**
 * 파일을 보존일·줄 수·**바이트** 상한으로 정리(동기 1회, 드묾). retentionDays 0 이면 크기·줄 수만 본다.
 * 반환에 tailOnly 를 실어 '꼬리만 검사했다' 는 사실을 숨기지 않는다(보존일 정리가 꼬리 밖 줄에는
 * 닿지 않는다 — 대신 바이트 상한이 그 줄들을 밀어낸다).
 */
export function trimHangLog(retentionDays = 0) {
  try {
    if (!fs.existsSync(FILE)) return { trimmed: 0 };
    const sizeBefore = fs.statSync(FILE).size;
    const tailOnly = sizeBefore > MAX_READ_BYTES;
    const raw = tailRaw();
    let lines = raw.split('\n').filter(Boolean);
    const before = lines.length;
    const days = Number(retentionDays) || 0;
    if (days > 0) {
      const cut = Date.now() - days * 86_400_000;
      lines = lines.filter((l) => {
        const i = l.indexOf('"at":');
        if (i < 0) return true;              // at 이 없으면 판단하지 않고 남긴다(추정 금지)
        const n = Number(/"at":\s*(\d+)/.exec(l)?.[1]);
        return !Number.isFinite(n) || n >= cut;
      });
    }
    if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
    // 바이트 상한 — 꼬리부터 남기고 앞을 버린다(줄 수 상한보다 먼저 걸리는 실질 상한).
    let bytes = Buffer.byteLength(`${lines.join('\n')}\n`);
    while (lines.length > 1 && bytes > maxBytesLimit()) {
      const drop = Math.max(1, Math.floor(lines.length * 0.2));   // 20% 씩 버려 재계산 횟수를 줄인다
      lines = lines.slice(drop);
      bytes = Buffer.byteLength(`${lines.join('\n')}\n`);
    }
    // 트림은 전량 재기록이다 — 원자적으로 써서 중간에 죽어도 로그가 잘리지 않게 한다.
    // 호출 시점 보장: flushQueue 콜백에서 쓰기가 없고 큐가 빈 순간에만 부른다(같은 틱에 append 가
    // 끼어들 수 없으므로 rename 으로 줄이 유실되지 않는다).
    // 꼬리만 읽었을 때도 그 꼬리로 파일을 대체한다 — 그래야 8MB 를 넘긴 파일이 실제로 줄어든다.
    if (lines.length !== before || tailOnly) atomicWriteFileSync(FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
    return { trimmed: before - lines.length, lines: lines.length, tailOnly, bytesBefore: sizeBefore, bytesAfter: bytes };
  } catch (e) { lastError = e.message; return { trimmed: 0, error: e.message }; }
}

/** 파일 끝 MAX_READ_BYTES 만 문자열로 읽는다(첫 줄이 잘릴 수 있어 호출부가 파싱 실패를 버린다). */
function tailRaw() {
  const st = fs.statSync(FILE);
  if (st.size <= MAX_READ_BYTES) return fs.readFileSync(FILE, 'utf8');
  const fd = fs.openSync(FILE, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    fs.readSync(fd, buf, 0, MAX_READ_BYTES, st.size - MAX_READ_BYTES);
    const s = buf.toString('utf8');
    return s.slice(s.indexOf('\n') + 1); // 잘린 첫 줄 버림
  } finally { fs.closeSync(fd); }
}

/** 최근 limit 건(최신 먼저). kind 로 필터 가능. 파싱 실패 줄은 건너뛴다. */
export function readHangs({ limit = 200, kind = '' } = {}) {
  const out = [];
  try {
    if (!fs.existsSync(FILE)) return { rows: [], total: 0, file: FILE, exists: false };
    // total 은 '읽은 꼬리의 줄 수' 다 — 파일이 읽기 상한을 넘었으면 그 사실을 함께 알린다
    // (앞부분을 세지 않고 '총 N건' 이라고 말하면 거짓이 된다).
    const tailOnly = fs.statSync(FILE).size > MAX_READ_BYTES;
    const lines = tailRaw().split('\n').filter(Boolean);
    const want = Math.max(1, Math.min(2000, Number(limit) || 200));
    let bad = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (kind && o?.kind !== kind) continue;
        out.push(o);
      } catch { bad += 1; }
      // 정렬을 위해 want 보다 조금 더 모은다(뒤쪽 줄이 항상 최신이라는 보장이 없다 — 위 주석).
      if (out.length >= want * 2 + 50) break;
    }
    out.sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
    return { rows: out.slice(0, want), total: lines.length, tailOnly, badLines: bad, file: FILE, exists: true };
  } catch (e) {
    return { rows: [], total: 0, file: FILE, exists: true, error: e.message };
  }
}

/** 파일 삭제(관리자 '로그 비우기'). */
export function clearHangs() {
  try { if (fs.existsSync(FILE)) fs.rmSync(FILE); appended = 0; dropped = 0; return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

export function hangLogStatus() {
  let bytes = null; let mtime = null;
  try { const st = fs.statSync(FILE); bytes = st.size; mtime = st.mtimeMs; } catch { /* 파일 없음 */ }
  return { file: FILE, bytes, mtime, appended, dropped, pending: queue.length, maxLines: MAX_LINES, maxBytes: maxBytesLimit(), maxPerMin: perMinLimit(), lastError: lastError || null };
}

/** 테스트 전용 — 분당 상한·바이트 상한 오버라이드(0 이면 env/기본값). */
export function _setHangLogMaxPerMinForTest(n) { maxPerMinOverride = Math.max(0, Number(n) || 0); }
export function _setHangLogMaxBytesForTest(n) { maxBytesOverride = Math.max(0, Number(n) || 0); }
export function _resetHangLogCounters() { minuteBucket = 0; minuteCount = 0; dropped = 0; appended = 0; lastError = ''; sinceTrim = 0; queue = []; writing = false; }
