/**
 * util/bulkRun.js — 대량 가져오기의 **실제 연결 테스트** 실행/진행률 보관(v2.513).
 *
 * 사용자 요청(2026-09-15): "실제로 테스트해서 동작하는지 검증하는 부분 추가" +
 * "검증을 통과한 일부만 등록하는 기능".
 *
 * 형식 검증(순수)만으로는 '등록하면 수집이 될지' 를 알 수 없다 — 계정·비번·방화벽·SSH 알고리즘은
 * 실제로 붙어 봐야 안다. 그래서 저장 **전에** 행마다 로그인을 시도하고 결과를 행 단위로 돌려준다.
 *
 * ── 반드시 지킬 것 (`sanswitch/testRuns.js`·폴러 규약과 같은 이유) ──────────────
 *  · **동시 실행 제한 + 장비당 시한**: 28대를 한꺼번에 SSH 하면 순간 부하가 몰리고, 느린 1대가
 *    전체를 잡는다. 기본 동시 4 · 장비당 60초.
 *  · **재진입 가드**: 같은 도구(kind)의 실행이 진행 중이면 새 실행을 거절한다 — 연타가 장비
 *    로그인 시도를 곱하지 않게(아래 '잠금' 주의 참조).
 *  · **자동 재시도 금지**: 실패를 재시도하면 잘못된 비밀번호로 로그인을 반복해 **계정이 잠긴다**.
 *    한 번만 시도하고 사유를 그대로 보고한다.
 *  · **비밀번호는 run 객체에 남지만 응답에 절대 싣지 않는다**(`publicRun` sanitize) —
 *    `sanswitch/testRuns.js` 의 같은 규약.
 *  · **TTL 로 폐기**: 자격증명을 들고 있으므로 오래 두지 않는다(기본 15분, 완료 후에도 동일).
 *
 * ⚠ 정직 규약: 중앙이 직접 닿을 수 없는 대상(엣지 위임 장비 등)은 '실패' 가 아니라
 *   **'테스트 불가'**(`skipped`)로 구분한다. 닿지 못한 것을 '연결 실패' 라고 말하면 사용자가
 *   멀쩡한 자격증명을 의심하며 고친다.
 */

import { poolRun as pool } from './pool.js'; // v2.579(ARCH-01): 동시성 풀 단일 소스 — 손으로 쓴 사본 제거(첫 rejection 전파 = 예전과 같은 의미)

const TTL_MS = 15 * 60_000;
const MAX_RUNS = 20;
const _runs = new Map();          // id → run
const _busyKinds = new Set();     // kind → 진행 중(재진입 가드)

function sweep() {
  const cut = Date.now() - TTL_MS;
  for (const [id, r] of _runs) if (r.startedAt < cut) _runs.delete(id);
  while (_runs.size > MAX_RUNS) _runs.delete(_runs.keys().next().value);
}


/** 시한 — 결과만 포기하지 않도록 testOne 에 signal 을 넘긴다(v2.417 규약). */
async function withDeadline(ms, fn) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fn(ac.signal); }
  finally { clearTimeout(t); }
}

/**
 * 연결 테스트 실행 시작(비동기 — 즉시 run id 를 돌려주고 백그라운드로 진행).
 *
 * @param {object} p
 * @param {string} p.kind            도구 구분('storage'|'sanswitch') — 재진입 가드 키
 * @param {Array} p.rows             테스트 대상 행(각 행에 `_line` 필수)
 * @param {(row:object, signal:AbortSignal)=>Promise<{ok:boolean, reason?:string, detail?:object}>} p.testOne
 * @param {(row:object)=>string|null} [p.skipReason]  닿을 수 없는 대상이면 사유(그 행은 skipped)
 * @param {string} [p.user]          감사용 요청자
 * @param {number} [p.concurrency]   기본 4
 * @param {number} [p.timeoutMs]     장비당 시한, 기본 60초
 * @returns {{ok:true, id:string}|{ok:false, reason:string}}
 */
export function startBulkTest({ kind, rows, testOne, skipReason = () => null, user = '', concurrency = 4, timeoutMs = 60_000 }) {
  sweep();
  if (_busyKinds.has(kind)) return { ok: false, reason: '이전 연결 테스트가 진행 중입니다 — 끝난 뒤 다시 실행하세요(장비 로그인 시도가 중복되지 않게).' };
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: false, reason: '테스트할 행이 없습니다.' };

  const id = `bt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const run = {
    id, kind, user, startedAt: Date.now(), finishedAt: 0, status: 'running',
    total: list.length, done: 0,
    // 행별 결과 — 초기 상태는 'pending'(아직 안 했다). '실패' 로 시작하지 않는다.
    results: list.map((r) => ({ line: r._line, name: r.name || '', host: r.host || '', status: 'pending', reason: '', ms: 0 })),
  };
  _runs.set(id, run);
  _busyKinds.add(kind);

  (async () => {
    try {
      await pool(list, Math.max(1, concurrency), async (row, i) => {
        const slot = run.results[i];
        const skip = skipReason(row);
        if (skip) { slot.status = 'skipped'; slot.reason = skip; run.done++; return; }
        slot.status = 'testing';
        const t0 = Date.now();
        try {
          const r = await withDeadline(timeoutMs, (signal) => testOne(row, signal));
          slot.status = r?.ok ? 'ok' : 'fail';
          slot.reason = r?.ok ? (r.detail?.summary || '') : (r?.reason || '알 수 없는 실패');
          if (r?.detail?.phase) slot.phase = r.detail.phase;
          if (r?.detail?.hint) slot.hint = r.detail.hint;
        } catch (e) {
          slot.status = 'fail';
          // AbortError 는 '시한 초과' 로 사람 말로 바꾼다(원문 'This operation was aborted' 는 무의미).
          slot.reason = /abort/i.test(String(e?.name || e?.message || '')) ? `시한 초과(${Math.round(timeoutMs / 1000)}초)` : (e?.message || String(e));
        } finally {
          slot.ms = Date.now() - t0;
          run.done++;
        }
      });
    } finally {
      run.status = 'done';
      run.finishedAt = Date.now();
      _busyKinds.delete(kind);
    }
  })();

  return { ok: true, id };
}

/** 응답용 — run 에서 **자격증명·원본 행을 제외**한 형태만. */
export function publicRun(id) {
  sweep();
  const r = _runs.get(String(id));
  if (!r) return null;
  const by = (s) => r.results.filter((x) => x.status === s).length;
  return {
    id: r.id, kind: r.kind, status: r.status,
    startedAt: r.startedAt, finishedAt: r.finishedAt || null,
    total: r.total, done: r.done,
    summary: { ok: by('ok'), fail: by('fail'), skipped: by('skipped'), pending: by('pending') + by('testing') },
    results: r.results.map((x) => ({ ...x })),
  };
}

/** 그 실행에서 **연결 성공한 줄 번호** 집합 — '통과한 것만 등록' 이 이 값으로 행을 고른다. */
export function passedLines(id) {
  const r = _runs.get(String(id));
  if (!r) return null;
  return r.results.filter((x) => x.status === 'ok').map((x) => x.line);
}

export function isBusy(kind) { return _busyKinds.has(kind); }
export function _resetForTest() { _runs.clear(); _busyKinds.clear(); }
