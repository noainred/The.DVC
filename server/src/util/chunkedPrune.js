/**
 * util/chunkedPrune.js — 대량 시계열 DELETE 를 청크로 끊어 이벤트 루프를 막지 않는다 (v2.453).
 *
 * 왜 필요한가 (운영 장애 실사례):
 *   v2.451 이 온도 원본 보존을 90일로 줄이자, 5년치가 쌓인 `host-temp.db`(운영 실측 34.3GB)에서
 *   **수억 행이 한 번에 삭제 대상**이 됐다. `node:sqlite` 는 동기 API 뿐이라
 *   `DELETE FROM samples WHERE ts < ?` 한 방은 그 시간 동안 **프로세스 전체**를 멈춘다.
 *   게다가 metrics 샘플러의 prune 스로틀이 `% 20 === 1` 이라 **기동 후 첫 샘플에서 즉시** 실행됐다.
 *   결과: 서비스는 `active (running)` 인데 로그가 끊기고 웹은 ERR_CONNECTION_TIMED_OUT.
 *
 * 처방은 대량 export 와 같다(`routes/api.js gpuSeriesExport`): 행 수를 청크로 끊고
 * 청크 사이에 `setImmediate` 로 양보한다. 부수 효과로 청크마다 커밋되므로
 * **WAL 이 무한정 부풀지 않는다**(한 트랜잭션으로 수억 행을 지우면 WAL 이 디스크를 채운다 —
 * 여유가 6.3GB 뿐인 환경에서는 이것만으로 디스크가 찬다).
 *
 * 한 번에 다 지우지 않는다. 상한(`maxRows`)에서 멈추고 남은 분은 다음 주기가 이어서 지운다.
 * 정직한 한계: 그래서 **과거에 쌓인 수억 행이 하루아침에 사라지지는 않는다**. 이 모듈의 목적은
 * '언젠가 정리되게 하면서 그동안 포탈이 살아있게' 하는 것이지 즉시 회수가 아니다.
 * 즉시 디스크를 회수하려면 경로 이동 + VACUUM 이 필요하다(docs/SETTINGS.md 부록 A-2).
 */

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** 한 번의 DELETE 로 지울 행 수. 작을수록 응답성이 좋고 클수록 총 처리량이 크다. */
export const PRUNE_CHUNK_ROWS = Math.max(500, num(process.env.PRUNE_CHUNK_ROWS, 20_000));
/** 한 번의 prune 호출이 지울 총 행 수 상한. 0 이면 무제한(권장하지 않음). */
export const PRUNE_MAX_ROWS = Math.max(0, num(process.env.PRUNE_MAX_ROWS, 1_000_000));

/**
 * 다음 청크를 더 돌아야 하는가 — 순수 함수라 테스트로 고정한다.
 * @param {number} lastDeleted 직전 청크가 실제로 지운 행 수
 * @param {number} total       지금까지 지운 총 행 수
 * @param {number} maxRows     이번 호출의 상한(0=무제한)
 * @returns {boolean}
 */
export function shouldContinuePrune(lastDeleted, total, maxRows = PRUNE_MAX_ROWS) {
  if (lastDeleted <= 0) return false;              // 더 지울 게 없다
  if (maxRows > 0 && total >= maxRows) return false; // 이번 주기 몫을 다 했다 — 다음 주기에 계속
  return true;
}

/**
 * v2.742(감사 DB-04): 시간 기준 적응 청크의 다음 크기 — 순수 함수(chunkedDelete 의 targetMs 와, 호출부가 한 청크씩 부르는 경로
 * (logs/db.js pruneOldest)가 같은 규칙을 쓴다 — 두 벌을 두지 않는다).
 *   직전 청크(want 행)가 목표보다 오래 걸렸으면 그 비율만큼 줄이고(하한 minChunk), 목표의 절반도 안 걸렸고 줄여 요청한 것이 아니면
 *   두 배로 늘린다(상한 maxChunk). 그 사이면 그대로.
 * @returns {number}
 */
export function nextAdaptiveChunk(chunk, want, tookMs, { targetMs, minChunk = 1, maxChunk = chunk } = {}) {
  if (!(Number.isFinite(targetMs) && targetMs > 0) || !Number.isFinite(tookMs)) return chunk;
  if (tookMs > targetMs) return Math.max(minChunk, Math.floor(want * (targetMs / tookMs)));
  if (tookMs < targetMs / 2 && want >= chunk) return Math.min(maxChunk, chunk * 2);
  return chunk;
}

/**
 * 청크 DELETE 를 돌린다.
 *
 * @param {{run:(...a:any[])=>{changes?:number}}} stmt
 *   `DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE <조건> LIMIT ?)` 형태의 준비된 문.
 *   **rowid 서브쿼리를 쓰는 이유**: SQLite 의 `DELETE ... LIMIT` 은 컴파일 옵션
 *   (SQLITE_ENABLE_UPDATE_DELETE_LIMIT)이 켜져야 동작한다 — 번들 빌드에 의존하지 않으려면
 *   rowid 서브쿼리가 안전하다. 조건 컬럼에 인덱스가 있어야 풀스캔을 피한다.
 * @param {any[]} args   조건 바인딩 값들(마지막 LIMIT 은 이 함수가 붙인다)
 * @param {{chunk?:number, maxRows?:number, label?:string, onProgress?:(n:number)=>void,
 *          targetMs?:number, minChunk?:number, maxChunk?:number, clock?:()=>number}} [opt]
 *   v2.742(감사 DB-04): `targetMs` 를 주면 **시간 기준 적응 청크**다 — 직전 청크가 목표보다 오래 걸렸으면 그 비율만큼 줄이고
 *   (하한 minChunk), 목표의 절반도 안 걸렸으면 두 배로 늘린다(상한 maxChunk — 기본은 시작 청크). 행 수가 같아도 표마다 비용이
 *   다르다(인덱스 7개 + 긴 메시지 열인 vCenter 이벤트 표는 2만 행 한 청크가 0.2~0.5초 — 재현). 조건·상한(maxRows)·종료 판정은
 *   같으므로 **지우는 행은 같다**(청크 크기만 바뀐다). 주지 않으면 예전 그대로 모든 청크가 같은 크기다(다른 호출부 무변경).
 *   clock 은 테스트용 시계(기본 performance.now).
 * @returns {Promise<{deleted:number, done:boolean, chunks:number}>}
 *   `done=false` 면 상한에 걸려 남은 게 있다는 뜻이다.
 */
export async function chunkedDelete(stmt, args = [], opt = {}) {
  let chunk = Math.max(1, opt.chunk || PRUNE_CHUNK_ROWS);
  const maxRows = opt.maxRows == null ? PRUNE_MAX_ROWS : opt.maxRows;
  const targetMs = Number.isFinite(opt.targetMs) && opt.targetMs > 0 ? opt.targetMs : 0;
  const minChunk = Math.max(1, Math.trunc(num(opt.minChunk, Math.min(500, chunk))));
  const maxChunk = Math.max(minChunk, Math.trunc(num(opt.maxChunk, chunk)));
  const clock = typeof opt.clock === 'function' ? opt.clock : () => performance.now();
  let deleted = 0;
  let chunks = 0;
  for (;;) {
    // 상한에 가까우면 남은 만큼만 요청해 초과 삭제를 막는다.
    const want = maxRows > 0 ? Math.min(chunk, maxRows - deleted) : chunk;
    if (want <= 0) break;
    const t0 = targetMs ? clock() : 0;
    const r = stmt.run(...args, want);
    if (targetMs) chunk = nextAdaptiveChunk(chunk, want, clock() - t0, { targetMs, minChunk, maxChunk });
    const n = Number(r?.changes ?? 0);
    deleted += n;
    chunks++;
    if (opt.onProgress && n > 0) opt.onProgress(deleted);
    if (!shouldContinuePrune(n, deleted, maxRows)) {
      // 마지막 청크가 요청량을 꽉 채웠다면 아직 남은 것이다(상한에서 멈춘 경우).
      return { deleted, done: !(n >= want), chunks };
    }
    // ★ 이벤트 루프 양보 — 이 한 줄이 없으면 위 루프가 곧 동기 DELETE 한 방과 같아진다.
    await new Promise((res) => setImmediate(res));
  }
  return { deleted, done: false, chunks };
}

/**
 * 보존 정리의 '진행 공유' — v2.603(감사 DB2603-02·RECENT2603-06). 정리끼리는 겹치지 않게 한다(청크 사이에 적재·다른 정리가
 * 끼어들 수 있다). 규칙은 둘이다:
 *   · 진행 중인 정리가 **이번 요청을 덮으면**(같은 보존일, 또는 더 늦은 경계) 그 약속을 공유한다.
 *   · 덮지 못하면(보존일을 줄였다 — 경계가 더 늦다) **그것이 끝난 뒤 새 경계로 한 번 더** 돈다. 공유만 하면 새 보존일이
 *     그 호출에 적용되지 않고 옛 경계의 결과(deleted:0)를 돌려받는다 — RECENT2603-06 재현.
 * 모듈마다 복제하지 말 것(v2.603 초판이 6벌이었다). 파일별 DB 는 파일마다 하나씩 만든다.
 *
 * @param {{covers?:(runningKey:any, newKey:any)=>boolean}} [opt]  기본은 키가 같을 때만 공유
 * @returns {{run:(key:any, fn:()=>Promise<any>)=>Promise<any>, readonly active:boolean, reset:()=>void}}
 */
export function createPruneFlight({ covers = (a, b) => a === b } = {}) {
  let cur = null;   // { key, p }
  return {
    run(key, fn) {
      if (cur && covers(cur.key, key)) return cur.p;
      const prev = cur ? cur.p.catch(() => {}) : Promise.resolve();
      const flight = { key, p: null };
      flight.p = prev.then(() => fn()).finally(() => { if (cur === flight) cur = null; });
      cur = flight;
      return flight.p;
    },
    get active() { return cur != null; },
    reset() { cur = null; },
  };
}
