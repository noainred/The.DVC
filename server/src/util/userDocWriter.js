/**
 * util/userDocWriter.js — 사용자 데이터 JSON 파일 하나의 '디바운스 · 비동기 원자 쓰기 · 저장 확인 · 실패 재시도'(v2.881).
 *
 * bulletin/store.js(v2.727) · issues/store.js(v2.864)에 같은 코드가 두 벌 있다 — 위키(v2.881)가 세 번째 사본을 만들지 않게 그 규약을
 * 그대로 옮긴 공용 판이다(두 기존 저장소는 아직 자기 사본을 쓴다 — 옮기는 일은 따로 · docs/rules/common.md).
 *
 * 규약(두 원본과 같다):
 *  · 캐시(메모리)가 진실이고 파일 쓰기는 delayMs(300ms) 안의 변경을 묶어 **한 번** 비동기로 쓴다(tmp → fsync → rename → 디렉터리 fsync).
 *    쓰는 중에 또 바뀌면 끝난 뒤 한 번 더. 종료 때는 util/exitFlush.js 에 등록한 동기 flush 가 대기분을 쓴다.
 *  · 변경마다 seq 를 올리고 실제로 쓴 마지막 seq 를 savedSeq 로 든다 — 한 변경의 상태는 saved · failed · pending(persistOf).
 *    라우트는 waitPersist(seq) 로 상한 있는 확인을 한다(묶음 창을 앞당긴다).
 *  · 실패는 제한된 지수 backoff 로 다시 쓴다(기본 5초부터 두 배씩 6회 · 상한 5분) — 그 뒤는 다음 변경 · 종료 flush.
 *  · 실패 기록은 사유 코드 + 단계 + 짧은 문구(오류 원문은 tmp 절대 경로를 담으므로 싣지 않는다).
 *  · 동기 flush 는 진행 중인 비동기 쓰기의 tmp 를 먼저 지운다(옛 본문이 새 본문을 덮지 않게 — rename 은 원자라 둘 중 하나).
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicWrite.js';
import { registerExitFlush } from './exitFlush.js';

export const WRITE_ERROR_TEXT = Object.freeze({
  ENOSPC: '디스크 공간이 부족합니다', EDQUOT: '디스크 할당량(quota)을 넘었습니다', EACCES: '저장 폴더·파일에 쓰기 권한이 없습니다',
  EPERM: '저장 폴더·파일에 대한 작업이 허용되지 않습니다', EROFS: '읽기 전용 파일 시스템입니다', EISDIR: '저장 파일 자리에 폴더가 있습니다',
  ENOTDIR: '설정 폴더 경로의 일부가 폴더가 아닙니다', ENOENT: '설정 폴더를 찾지 못했습니다', EMFILE: '열린 파일이 너무 많습니다',
  ENFILE: '시스템 전체의 열린 파일이 너무 많습니다', EIO: '디스크 입출력 오류입니다', EBUSY: '파일이 사용 중입니다',
  EUNKNOWN: '파일을 쓰지 못했습니다(서버 로그에서 원인을 확인하세요)',
});
export const RETRY_DEFAULTS = Object.freeze({ max: 6, baseMs: 5000, capMs: 300000 });

const realIo = Object.freeze({
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  writeTmp: async (tmp, body) => {
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(body, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
  },
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  syncDir: async (dir) => { const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } },
  writeFileAtomicSync: (file, body) => atomicWriteFileSync(file, body, { mode: 0o600 }),
  unlinkSync: (p) => fs.unlinkSync(p),
});
const tmpPathOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
function errCodeOf(e) { const c = typeof e?.code === 'string' ? e.code : ''; return /^E[A-Z0-9]{2,15}$/.test(c) ? c : 'EUNKNOWN'; }

/**
 * @param {{ tag:string, file:() => string, serialize:() => (string|null), delayMs?:number, persistWaitMs?:number }} opt
 *   serialize 가 null 을 주면(캐시 없음) 쓰지 않는다.
 */
export function createUserDocWriter({ tag, file, serialize, delayMs = 300, persistWaitMs = 3000 }) {
  let io = realIo;
  let RETRY = { ...RETRY_DEFAULTS };
  let w = null;
  const writer = () => {
    if (!w) {
      w = {
        timer: null, writing: false, dirty: false, gen: 0, writes: 0, lastWriteAt: null, lastWriteError: null,
        seq: 0, savedSeq: 0, attemptSeq: 0, lastFailSeq: 0, unsavedSince: null, nextUnsavedAt: null,
        failCount: 0, retryTimer: null, retryAt: null, expedite: false, tmp: null, waiters: [],
      };
    }
    return w;
  };
  const clearRetry = (ww) => { if (ww.retryTimer) { clearTimeout(ww.retryTimer); ww.retryTimer = null; } ww.retryAt = null; };
  const persistOf = (ww, seq) => ({ state: ww.savedSeq >= seq ? 'saved' : (ww.lastWriteError ? 'failed' : 'pending'), seq, savedSeq: ww.savedSeq });
  function settleWaiters(ww) {
    if (!ww.waiters.length) return;
    const keep = [];
    for (const x of ww.waiters) {
      if (ww.savedSeq >= x.seq || (ww.lastWriteError && ww.lastFailSeq >= x.seq)) { clearTimeout(x.t); x.resolve(persistOf(ww, x.seq)); } else keep.push(x);
    }
    ww.waiters = keep;
  }
  function noteWriteOk(ww, seq) {
    ww.savedSeq = Math.max(ww.savedSeq, seq);
    ww.writes += 1; ww.lastWriteAt = Date.now(); ww.lastWriteError = null; ww.failCount = 0;
    clearRetry(ww);
    ww.unsavedSince = ww.seq > ww.savedSeq ? (ww.nextUnsavedAt ?? Date.now()) : null;
  }
  function noteWriteFail(ww, e, phase, seq) {
    const code = errCodeOf(e);
    ww.lastWriteError = { at: Date.now(), code, phase, message: WRITE_ERROR_TEXT[code] || WRITE_ERROR_TEXT.EUNKNOWN };
    ww.lastFailSeq = Math.max(ww.lastFailSeq, seq);
    ww.dirty = true; ww.failCount += 1;
    clearRetry(ww);
    let next;
    if (ww.failCount <= RETRY.max) {
      const delay = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** (ww.failCount - 1));
      ww.retryAt = Date.now() + delay;
      ww.retryTimer = setTimeout(() => {
        ww.retryTimer = null; ww.retryAt = null;
        if (w !== ww) return;
        if (ww.seq <= ww.savedSeq || ww.writing || ww.timer) return;
        runWrite();
      }, delay);
      ww.retryTimer.unref?.();
      next = `${Math.round(delay / 1000)}초 뒤 다시 씁니다(${ww.failCount}/${RETRY.max})`;
    } else next = `자동 재시도 ${RETRY.max}회를 다 써서 멈춥니다 — 다음 변경·종료 때 다시 씁니다`;
    const sys = typeof e?.syscall === 'string' ? ` ${e.syscall}` : '';
    console.warn(`[${tag}] ${path.basename(file())} 저장 실패(${code}${sys} · ${phase}) — 미저장 변경 ${Math.max(0, ww.seq - ww.savedSeq)}건 · ${next}`);
  }
  function scheduleWrite() {
    const ww = writer();
    ww.dirty = true;
    if (ww.timer) return;
    ww.timer = setTimeout(runWrite, delayMs);
    ww.timer.unref?.();
  }
  function runWrite() {
    const ww = writer();
    if (ww.timer) { clearTimeout(ww.timer); ww.timer = null; }
    if (ww.writing) { scheduleWrite(); return; }
    clearRetry(ww);
    const body = serialize();
    if (body == null) { ww.dirty = false; return; }
    const f = file();
    const seq = ww.seq;
    const gen = ++ww.gen;
    ww.dirty = false; ww.writing = true; ww.attemptSeq = seq; ww.nextUnsavedAt = null;
    const tmp = tmpPathOf(f);
    ww.tmp = tmp;
    let failed = false;
    let phase = 'mkdir';
    (async () => {
      try {
        await io.mkdir(path.dirname(f));
        phase = 'write';
        await io.writeTmp(tmp, body);
        if (gen !== ww.gen) { await io.unlink(tmp).catch(() => {}); return; }
        phase = 'rename';
        await io.rename(tmp, f);
        try { await io.syncDir(path.dirname(f)); } catch { /* 디렉터리 fsync 미지원 */ }
        if (gen === ww.gen) noteWriteOk(ww, seq);
      } catch (e) {
        if (gen === ww.gen) { failed = true; noteWriteFail(ww, e, phase, seq); }
        await io.unlink(tmp).catch(() => {});
      } finally {
        ww.writing = false; ww.tmp = null;
        const urgent = ww.expedite; ww.expedite = false;
        settleWaiters(ww);
        if (ww.dirty && (urgent || !failed)) { if (urgent) runWrite(); else scheduleWrite(); }
      }
    })();
  }
  function expediteWrite() {
    const ww = writer();
    if (ww.seq <= ww.savedSeq) return;
    if (ww.writing) { ww.expedite = true; ww.dirty = true; return; }
    runWrite();
  }
  function flushNow() {
    const ww = writer();
    if (ww.timer) { clearTimeout(ww.timer); ww.timer = null; }
    if (!ww.dirty && !ww.writing && ww.seq <= ww.savedSeq) return false;
    const body = serialize();
    if (body == null) { ww.dirty = false; return false; }
    const seq = ww.seq;
    ww.gen += 1;
    if (ww.writing && ww.tmp) { try { io.unlinkSync(ww.tmp); } catch { /* 이미 rename 됐거나 아직 없다 */ } }
    try {
      io.writeFileAtomicSync(file(), body);
      ww.dirty = false;
      noteWriteOk(ww, seq);
      settleWaiters(ww);
      return true;
    } catch (e) { noteWriteFail(ww, e, 'flush', seq); settleWaiters(ww); return false; }
  }
  registerExitFlush(`${tag}/store`, () => { flushNow(); });

  return {
    /** 캐시가 바뀌었다 — 순번을 올리고 쓰기를 예약한다. */
    changed() {
      const ww = writer();
      const now = Date.now();
      if (ww.seq === ww.savedSeq) ww.unsavedSince = now;
      if (ww.writing && ww.seq === ww.attemptSeq) ww.nextUnsavedAt = now;
      ww.seq += 1;
      scheduleWrite();
    },
    flushNow,
    seq: () => w?.seq ?? 0,
    waitPersist(seq, { maxMs = persistWaitMs } = {}) {
      const ww = writer();
      if (ww.savedSeq >= seq) return Promise.resolve(persistOf(ww, seq));
      expediteWrite();
      if (ww.savedSeq >= seq || (ww.lastWriteError && ww.lastFailSeq >= seq && !ww.writing)) return Promise.resolve(persistOf(ww, seq));
      return new Promise((resolve) => {
        const x = { seq, resolve, t: null };
        x.t = setTimeout(() => { ww.waiters = ww.waiters.filter((y) => y !== x); resolve(persistOf(ww, seq)); }, Math.max(0, Math.trunc(Number(maxMs) || 0)));
        x.t.unref?.();
        ww.waiters.push(x);
      });
    },
    /** 화면 배너용 — admin:false 면 상태 · 시각만. */
    persist({ admin = false, now = Date.now(), extra = {} } = {}) {
      if (!w) return { state: 'saved', loaded: false, unsavedSince: null, retrying: false, retryExhausted: false };
      const p = persistOf(w, w.seq);
      const retrying = !!w.retryTimer;
      const out = { state: p.state, loaded: true, unsavedSince: p.state === 'saved' ? null : w.unsavedSince, retrying, retryExhausted: p.state === 'failed' && !retrying && w.failCount > RETRY.max, writing: w.writing };
      if (!admin) return out;
      return {
        ...out, unsaved: Math.max(0, w.seq - w.savedSeq), lastSavedAt: w.lastWriteAt,
        lastWriteError: w.lastWriteError ? { ...w.lastWriteError } : null, failCount: w.failCount, writes: w.writes,
        nextRetryAt: retrying ? w.retryAt : null, retryMax: RETRY.max, unsavedForMs: out.unsavedSince ? Math.max(0, now - out.unsavedSince) : null, ...extra,
      };
    },
    async idle({ maxMs = 5_000 } = {}) {
      const t0 = Date.now();
      while (w && (w.writing || w.timer)) {
        if (Date.now() - t0 > maxMs) return false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return true;
    },
    /** 테스트 전용 — 대기분을 쓰고 상태를 비운다. */
    reset() {
      flushNow();
      if (w) {
        clearRetry(w);
        if (w.timer) { clearTimeout(w.timer); w.timer = null; }
        for (const x of w.waiters) { clearTimeout(x.t); x.resolve(persistOf(w, x.seq)); }
        w.waiters = [];
      }
      w = null;
    },
    /** 테스트 전용 — 입출력 실패 주입 · 재시도 상수. */
    setIoForTest(over = null, retry = null) {
      io = over ? { ...realIo, ...over } : realIo;
      RETRY = retry ? { ...RETRY_DEFAULTS, ...retry } : { ...RETRY_DEFAULTS };
    },
  };
}
