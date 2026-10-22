/**
 * Veeam 스냅샷 전용 DB 백필 — 로그 DB 읽기 워커(v2.759.1 핫픽스).
 *
 * 왜 워커인가: v2.759 는 백필의 로그 DB 검색(4열 LIKE · 1시간 조각)을 주 스레드에서 돌렸다. 조각 사이에 양보는 했지만
 *   동기 SQL 한 번이 고빈도 vCenter 에서 수십~수백 ms 이고 그것이 전 vCenter × 31일 이어져, 실서버에서 업그레이드 직후
 *   큰 vCenter 12개의 인벤토리 수집이 90초 데드라인을 넘겨 '연결 불가' 가 됐다(추정 — 시점·코드 근거). 검색은 여기서만 한다.
 * 로그 DB 파일을 **읽기 전용**으로 따로 연다(WAL — 주 스레드의 쓰기와 동시에 읽을 수 있다). 주 스레드는 받은 행을 넣기만 한다.
 * 메시지: { id, vcenterId, since, until, limit } → { id, ok, rows } | { id, ok:false, error }. 범위는 [since, until] (양끝 포함).
 */
import { parentPort, workerData } from 'node:worker_threads';
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from 'node:sqlite';

const HOUR = 3_600_000;
const esc = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;   // logs/db.js likeEscape 와 같은 규칙
const COLS = "(message LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR type LIKE ? ESCAPE '\\')";
const A = esc('snapshot'); const B = esc('스냅샷');

let db = null;
let st = null;
let openErr = '';
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  st = db.prepare(`SELECT vcenterId, ts, severity, type, user, entity, message FROM events
    WHERE vcenterId=? AND ts>=? AND ts<? AND (${COLS} OR ${COLS}) LIMIT ?`);
} catch (e) { openErr = String(e?.message || e); }

parentPort.on('message', (m) => {
  const { id } = m || {};
  if (!st) { parentPort.postMessage({ id, ok: false, error: `로그 DB 를 읽기 전용으로 열지 못했습니다: ${openErr}` }); return; }
  try {
    const limit = Math.max(1, Math.floor(m.limit) || 1);
    const out = [];
    // 1시간 조각 — 읽기 트랜잭션을 짧게(WAL 체크포인트를 오래 막지 않게)
    for (let lo = Number(m.since); lo <= Number(m.until) && out.length < limit; lo += HOUR) {
      const hi = Math.min(lo + HOUR, Number(m.until) + 1);
      for (const r of st.all(String(m.vcenterId), lo, hi, A, A, A, A, B, B, B, B, limit - out.length)) out.push(r);
    }
    parentPort.postMessage({ id, ok: true, rows: out });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
});
