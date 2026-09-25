/**
 * SQLite 첫 open 공용 규칙(v2.599 감사 DB2599-02 후속).
 *
 * 왜: 다른 연결(외부 도구·백업 스크립트·다른 프로세스)이 잠금을 쥐고 있는 순간 첫 open 이 걸리면, 예전 모듈들은
 * `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;` 을 **한 exec** 로 보내 기다리지도
 * 않고 'database is locked' 로 실패했고, 그 실패를 initError·'unavailable' 로 **래치**해 프로세스 수명 동안 그 기능의
 * 저장이 꺼졌다. 잠금은 일시적이다 — storage/db.js·metrics/db.js(v2.597 L2597-02)가 먼저 고친 규칙을 여기로 모은다.
 *
 * 규칙:
 *  1) `PRAGMA busy_timeout` 을 **먼저 단독으로** 건다 — journal_mode 전환·스키마 생성도 잠금을 기다리게.
 *  2) journal_mode/synchronous 실패는 구버전 폴백으로 넘기되, **잠금 오류는 다시 던진다**(삼키면 뒤 CREATE 가 같은
 *     잠금으로 실패하는데 원인이 가려진다).
 *  3) 잠금 오류로 open 이 실패하면 호출부는 **핸들을 닫고 래치하지 않는다** — `createLockRetry` 가 재시도 시각을 쥔다.
 *
 * 사용법 두 가지:
 *  · NDJSON 폴백을 가진 모듈(idrac·ping·logs·capacity) — `retryOnLock(initSqlite, {tag})` 로 몇 번 기다렸다 다시 연다
 *    (metrics/db.js v2.597 과 같은 방식). 잠금이 아닌 오류만 폴백으로 간다.
 *  · 'unavailable' 을 래치하는 모듈 — `createLockRetry()` 로 잠금이면 래치하지 않고 잠시 뒤 다시 연다.
 *  두 경우 모두 `openSqlite(new DatabaseSync(…))` 로 핸들을 만들면, 시도가 실패했을 때 그 시도에서 연 핸들이 닫힌다
 *  (`withOpenCleanup` — AsyncLocalStorage 로 그 시도의 핸들만 추적한다. 동시에 다른 모듈이 열어도 섞이지 않는다).
 */
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

const attempt = new AsyncLocalStorage();

/** SQLITE_BUSY(5)·SQLITE_LOCKED(6) 또는 그 문구. */
export function isSqliteLockError(e) {
  const code = e && (e.errcode ?? e.errno);
  return code === 5 || code === 6 || /database is (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(String(e?.message || ''));
}

/** 표준 PRAGMA 묶음(WAL + NORMAL + busy_timeout) — busy_timeout 을 먼저. 잠금 오류만 던진다. */
export function applyStdPragmas(db, { busyMs = 3000, wal = true } = {}) {
  db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(Number(busyMs) || 0))};`);
  if (!wal) return;
  try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;'); }
  catch (e) { if (isSqliteLockError(e)) throw e; /* 구버전 폴백 */ }
}

/**
 * 잠금 재시도 상태. `onFail(e)` 가 true 면 잠금이라 래치하지 말 것(호출부는 핸들을 닫는다).
 * `blocked()` 가 true 인 동안은 다시 열지 않는다(매 호출마다 3초 busy_timeout 을 태우지 않게).
 */
export function createLockRetry(retryMs = 30_000) {
  let retryAt = 0;
  let lastLock = null;
  return {
    blocked: (now = Date.now()) => retryAt > 0 && now < retryAt,
    onFail(e, now = Date.now()) {
      if (!isSqliteLockError(e)) return false;
      lastLock = e; retryAt = now + retryMs;
      return true;
    },
    ok() { retryAt = 0; lastLock = null; },
    lastLock: () => lastLock,
    /** 화면·상태용 문구(잠금 중일 때만). */
    note: () => (lastLock ? `DB 파일이 잠겨 있어 열지 못했습니다(잠시 뒤 다시 시도합니다): ${String(lastLock.message || lastLock).slice(0, 160)}` : ''),
    _expire() { retryAt = 0; },
  };
}

/**
 * v2.611(DB2611-01): DB 본체와 **기존 -wal/-shm** 을 0600 으로(없는 파일은 무시). `new DatabaseSync()` 는 umask 로 본체를 0644 로
 *   만들고, WAL 은 첫 쓰기 때 **그 순간의 본체 권한**을 따라 생긴다 — chmod 가 첫 쓰기 뒤면 -wal/-shm 이 0644 로 남고, 닫지 않고
 *   종료하면 다음 기동이 그 파일을 재사용해 계속 0644 였다(재현). **PRAGMA·스키마 생성(첫 쓰기) 전에** 부를 것.
 * @param {string} file  DB 파일 경로(':memory:'·빈 값은 건너뜀)
 */
export function chmodDbFiles(file) {
  const p = typeof file === 'string' ? file : '';
  if (!p || p === ':memory:') return;
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    try { fs.chmodSync(f, 0o600); } catch { /* 없는 파일·권한 없음 — best effort */ }
  }
}

/**
 * 방금 만든 핸들을 이번 시도에 등록하고 표준 PRAGMA 를 건다: `openSqlite(new DatabaseSync(file))`.
 * `withOpenCleanup`/`retryOnLock` 안에서 부르면 시도 실패 시 자동으로 닫힌다. PRAGMA 단계에서 잠금으로 실패하면
 * 여기서 바로 닫고 던진다. (핸들 생성을 호출부에 두는 이유: 'DatabaseSync 를 여는 모듈' 을 찾는 소스 스윕 —
 * 파일 권한 0600·open 공유 검사 — 이 그대로 그 모듈을 본다.)
 */
export function openSqlite(db, opts = {}) {
  attempt.getStore()?.push(db);
  // 파일 권한은 PRAGMA(첫 쓰기) 전에(DB2611-01). ⚠ wal:false(ipam.db — 외부 프로그램이 직접 읽는 공유 파일)는 건드리지 않는다 —
  //   그 파일의 권한은 외부 리더 계약이다(ipam/db.js 가 스스로 정한다).
  if (opts.wal !== false) {
    let loc = null;
    try { loc = typeof db.location === 'function' ? db.location() : null; } catch { loc = null; }
    chmodDbFiles(loc);
  }
  try { applyStdPragmas(db, opts); } catch (e) { try { db.close(); } catch { /* */ } throw e; }
  return db;
}

/** fn 을 한 번 실행하고, 던지면 그 안에서 `openSqlite` 로 연 핸들을 닫은 뒤 다시 던진다. */
export async function withOpenCleanup(fn) {
  const opened = [];
  try { return await attempt.run(opened, fn); }
  catch (e) { for (const db of opened) { try { db.close(); } catch { /* 이미 닫힘 */ } } throw e; }
}

/** 잠금 오류면 waitMs 기다렸다 다시(최대 tries 회). 잠금이 아닌 오류·마지막 시도는 그대로 던진다. */
export async function retryOnLock(fn, { tries = 5, waitMs = 3_000, tag = 'sqlite' } = {}) {
  for (let i = 1; ; i++) {
    try { return await withOpenCleanup(fn); } catch (e) {
      if (i >= tries || !isSqliteLockError(e)) throw e;
      console.warn(`[${tag}] SQLite 잠금(${e.message}) — ${Math.round(waitMs / 1000)}초 뒤 다시 엽니다(${i}/${tries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
