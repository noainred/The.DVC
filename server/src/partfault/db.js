/**
 * partfault/db.js — 파트 장애 이력 DB(v2.547). 파일 `part-faults.db`.
 *
 * ── 왜 '전이만' 저장하는가 (행 수를 먼저 계산했다 — v2.504 규약) ───────────────────
 * 파트 모수: iDRAC 965대 × 37~66개 = **3.5만~6.4만** + 스토리지 78대 + SAN + PDU.
 *  · 매 주기 전량 적재(30분 주기 = 48회/일) → **연 10억 행** ❌
 *  · 상태 **전이만** 적재 → 장비당 연 수 건 → **연 수만 행** ✅
 * 그래서 2테이블이다:
 *  · `part_state` — **지금 상태**. 파트 수만큼만 존재하는 고정 크기(upsert).
 *  · `part_event` — **전이만** append(open / change / close).
 *
 * 스키마·PRAGMA·권한은 `sanswitch/healthHistory.js` 의 패턴을 그대로 따른다(코어는 하나다):
 * lazy + single-flight open · WAL + synchronous=NORMAL + busy_timeout=3000 · `chmodSync(0o600)` ·
 * 열기 실패는 **던지지 않고** `available:false` 로 정직 보고(포탈을 막지 않는다).
 *
 * ⚠ **`part_state` 를 지우지 말 것** — 이것이 없으면 전이를 계산할 수 없어 매 주기가
 *   '전부 새 장애' 가 된다(알림 폭주). 재시작해도 살아남아야 하므로 메모리가 아니라 DB 다.
 *   (`pdu/thresholds.js:141` 의 `_state` 는 인메모리라 재기동마다 리셋된다 — PDU 임계는
 *    그래도 되지만 파트 장애는 며칠~몇 주 지속되므로 그 방식을 쓰면 안 된다.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/*
 * ⚠ **`config.dbDir` 을 따른다**(설정 › DB 위치). 경로만 configDir 로 굳히면 사용자가 DB 를
 *   옮겼을 때 이 파일만 옛 경로에 남는다. 반대로 경로만 dbDir 을 따르고 `insights/dbLocation.js`
 *   의 `MIGRATABLE` 에 등재하지 않으면 **이전이 안 돼 이력이 사라진다**(둘을 같이 해야 한다 —
 *   `test/dbLocation2451.test.js` 가 누락을 자동 검출한다).
 */
const DB_PATH = () => process.env.PARTFAULT_DB_PATH
  || path.join(config.dbDir || config.configDir, 'part-faults.db');
/** 이벤트 보존일. 전이만 쌓으므로 길게 잡아도 작다. */
const RETENTION_DAYS = Math.max(30, Number(process.env.PARTFAULT_RETENTION_DAYS) || 730);

let x = null;
let ready = null;
let initError = null;
let _pruneTick = 0;

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS part_state (
      part_key    TEXT PRIMARY KEY,
      scope       TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      device_name TEXT,
      kind        TEXT,
      part_id     TEXT,
      key_kind    TEXT,
      label       TEXT,
      detail      TEXT,
      agent       TEXT,
      state       TEXT NOT NULL,
      raw_state   TEXT,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      hold_reason TEXT,
      notified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_state_dev   ON part_state(device_id);
    CREATE INDEX IF NOT EXISTS ix_state_scope ON part_state(scope, state);

    CREATE TABLE IF NOT EXISTS part_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      part_key    TEXT NOT NULL,
      scope       TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      device_name TEXT,
      kind        TEXT,
      label       TEXT,
      key_kind    TEXT,
      event       TEXT NOT NULL,   -- open | change | close
      state       TEXT,
      prev_state  TEXT,
      raw_state   TEXT,
      close_reason TEXT,
      agent       TEXT
    );
    -- prune 은 at 단독 인덱스가 있어야 풀스캔을 피한다(CLAUDE.md 시계열 규약).
    CREATE INDEX IF NOT EXISTS ix_event_at  ON part_event(at);
    CREATE INDEX IF NOT EXISTS ix_event_key ON part_event(part_key, at);
    CREATE INDEX IF NOT EXISTS ix_event_dev ON part_event(device_id, at);
  `);
  return {
    upsert: db.prepare(`INSERT INTO part_state
      (part_key,scope,device_id,device_name,kind,part_id,key_kind,label,detail,agent,state,raw_state,first_seen,last_seen,hold_reason,notified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(part_key) DO UPDATE SET
        device_name=excluded.device_name, kind=excluded.kind, key_kind=excluded.key_kind,
        label=excluded.label, detail=excluded.detail, agent=excluded.agent,
        state=excluded.state, raw_state=excluded.raw_state, last_seen=excluded.last_seen,
        hold_reason=excluded.hold_reason`),
    touch: db.prepare('UPDATE part_state SET last_seen=?, hold_reason=?, raw_state=COALESCE(?,raw_state) WHERE part_key=?'),
    markNotified: db.prepare('UPDATE part_state SET notified_at=? WHERE part_key=?'),
    del: db.prepare('DELETE FROM part_state WHERE part_key=?'),
    openList: db.prepare('SELECT * FROM part_state ORDER BY first_seen DESC LIMIT ?'),
    openByScope: db.prepare('SELECT * FROM part_state WHERE scope=? ORDER BY first_seen DESC LIMIT ?'),
    openAll: db.prepare('SELECT * FROM part_state'),
    event: db.prepare(`INSERT INTO part_event
      (at,part_key,scope,device_id,device_name,kind,label,key_kind,event,state,prev_state,raw_state,close_reason,agent)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    events: db.prepare('SELECT * FROM part_event WHERE at>=? ORDER BY at DESC LIMIT ?'),
    eventsOfPart: db.prepare('SELECT * FROM part_event WHERE part_key=? ORDER BY at DESC LIMIT ?'),
    prune: db.prepare('DELETE FROM part_event WHERE at < ?'),
    stats: db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS mn, MAX(at) AS mx FROM part_event'),
    stateStats: db.prepare('SELECT COUNT(*) AS n FROM part_state'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready) {
    ready = (async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const db = new DatabaseSync(p);
      try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      x = { db, st, path: p };
      return x;
    })().catch((e) => { initError = e; return null; });
  }
  return ready;
}

export async function partFaultDbStatus() {
  const h = await open();
  return {
    available: !!h, path: h ? h.path : DB_PATH(), retentionDays: RETENTION_DAYS,
    error: initError ? String(initError.message || initError).slice(0, 200) : '',
    openParts: h ? (h.st.stateStats.get()?.n ?? null) : null,
    ...(h ? h.st.stats.get() : { rows: null, mn: null, mx: null }),
  };
}

/** 지금 열려 있는 장애 전량 — 전이 계산의 입력. */
export async function openFaults({ scope = '', limit = 20_000 } = {}) {
  const h = await open();
  if (!h) return [];
  const rows = scope ? h.st.openByScope.all(scope, limit) : h.st.openList.all(limit);
  return rows.map(rowToPart);
}

function rowToPart(r) {
  return {
    partKey: r.part_key, scope: r.scope, deviceId: r.device_id, deviceName: r.device_name,
    kind: r.kind, partId: r.part_id, keyKind: r.key_kind, label: r.label, detail: r.detail,
    agent: r.agent, state: r.state, rawState: r.raw_state,
    firstSeenAt: r.first_seen, lastSeenAt: r.last_seen, holdReason: r.hold_reason,
    notifiedAt: r.notified_at,
  };
}

/**
 * 전이 결과를 **한 트랜잭션으로** 반영한다.
 * ⚠ 대량 write 는 반드시 트랜잭션으로 묶는다(CLAUDE.md 성능 불변조건 — 무트랜잭션 6천 행이
 *   25초 블로킹을 만든 사고가 있다).
 * @returns {{saved:boolean, opened:number, closed:number, changed:number, reason?:string}}
 */
export async function applyTransition(tr, { now = Date.now() } = {}) {
  const h = await open();
  if (!h) return { saved: false, opened: 0, closed: 0, changed: 0, reason: initError ? String(initError.message).slice(0, 200) : 'node:sqlite 없음' };
  const { db, st } = h;
  const ev = (e, p, extra = {}) => st.event.run(
    now, p.partKey, p.scope, p.deviceId, p.deviceName || '', p.kind || '', p.label || '',
    p.keyKind || '', e, extra.state ?? p.state ?? null, extra.prevState ?? null,
    p.rawState || '', extra.closeReason ?? null, p.agent || '',
  );
  db.exec('BEGIN');
  try {
    for (const p of tr.opened || []) {
      st.upsert.run(p.partKey, p.scope, p.deviceId, p.deviceName || '', p.kind || '', p.partId || '',
        p.keyKind || '', p.label || '', p.detail || '', p.agent || '', p.state, p.rawState || '',
        p.firstSeenAt || now, p.lastSeenAt || now, null, null);
      ev('open', p);
    }
    for (const p of tr.updated || []) {
      st.upsert.run(p.partKey, p.scope, p.deviceId, p.deviceName || '', p.kind || '', p.partId || '',
        p.keyKind || '', p.label || '', p.detail || '', p.agent || '', p.state, p.rawState || '',
        p.firstSeenAt || now, p.lastSeenAt || now, null, null);
      // 같은 상태가 이어지는 것은 **이벤트가 아니다** — 이벤트로 남기면 전이 테이블이 전량 적재가 된다.
      if (!p.sameState) ev('change', p, { prevState: p.prevState });
    }
    for (const p of tr.closed || []) {
      st.del.run(p.partKey);
      ev('close', p, { state: null, prevState: p.state, closeReason: p.closeReason || 'ok' });
    }
    // 유지(held)는 **이벤트를 만들지 않는다** — 사유만 갱신해 화면이 '왜 아직 열려 있나' 를 말한다.
    for (const p of tr.held || []) st.touch.run(p.lastSeenAt || p.lastHeldAt || now, p.holdReason || null, p.rawState || null, p.partKey);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { saved: false, opened: 0, closed: 0, changed: 0, reason: String(e.message || e).slice(0, 200) };
  }
  // prune 스로틀 — `(++tick % N) === 0`(v2.453 규칙: 기동 첫 틱에 즉시 참이 되면 안 된다).
  if ((++_pruneTick % 20) === 0) {
    try { st.prune.run(now - RETENTION_DAYS * 86_400_000); } catch { /* 정리 실패는 적재에 영향 없음 */ }
  }
  return {
    saved: true,
    opened: (tr.opened || []).length,
    closed: (tr.closed || []).length,
    changed: (tr.updated || []).filter((u) => !u.sameState).length,
  };
}

export async function markNotified(partKeys, { now = Date.now() } = {}) {
  const h = await open();
  if (!h || !partKeys?.length) return 0;
  h.db.exec('BEGIN');
  try { for (const k of partKeys) h.st.markNotified.run(now, k); h.db.exec('COMMIT'); }
  catch { try { h.db.exec('ROLLBACK'); } catch { /* */ } return 0; }
  return partKeys.length;
}

export async function recentEvents({ sinceMs = 30 * 86_400_000, limit = 500, partKey = '' } = {}) {
  const h = await open();
  if (!h) return [];
  const rows = partKey ? h.st.eventsOfPart.all(partKey, limit) : h.st.events.all(Date.now() - sinceMs, limit);
  return rows.map((r) => ({
    at: r.at, partKey: r.part_key, scope: r.scope, deviceId: r.device_id, deviceName: r.device_name,
    kind: r.kind, label: r.label, keyKind: r.key_kind, event: r.event, state: r.state,
    prevState: r.prev_state, rawState: r.raw_state, closeReason: r.close_reason, agent: r.agent,
  }));
}

export function _resetForTest() { x = null; ready = null; initError = null; _pruneTick = 0; }
