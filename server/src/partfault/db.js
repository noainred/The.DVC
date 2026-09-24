/**
 * partfault/db.js — 파트 장애 이력 DB(v2.547, 스키마 v2 는 v2.548). 파일 `part-faults.db`.
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
 *
 * ── v2.548 스키마 v2 — 기본키 `(agent, part_key)` (F2) ────────────────────────────────
 * v1 의 `part_state` 는 PK 가 `part_key` 하나였다. 그런데 iDRAC 의 deviceId 는 **IP 문자열**이라
 * (`idrac/registry.js:272`) 두 법인이 같은 사설 IP 를 쓰면 서로 다른 물리 서버가 **같은 행**이 되고,
 * 한쪽의 열린 장애가 다른 쪽 관측으로 **거짓 '복구'** 처리된다 — 이 기능이 스스로 '최악의 거짓'
 * 이라 적어 둔 바로 그 경로였다(`types.js` 머리말). 계약(`types.js partKeyOf`)대로 **법인 축은 이
 * DB 의 기본키가 담당한다** — 파트 키에 agent 를 넣지 않는다(AGENT_NAME 기본값이 호스트명이라
 * 호스트명 변경만으로 전 장애가 닫혔다 열리는 것을 막기 위해). `agent = ''` 는 중앙 직접 수집이다.
 *
 * 함께 실은 것: `device_key`·`device_key_kind`(types.js makePart 의 deviceKey/deviceKeyKind) —
 * 파트 키의 장비 축이 서비스태그인지 로컬 id(IP)인지 화면이 밝힐 수 있게 한다.
 *
 * ── 왜 마이그레이션이 아니라 '재생성' 인가 ──────────────────────────────────────────
 * v1 파일을 만나면 `part_state`·`part_event` 를 **DROP 하고 다시 만든다**. 근거:
 *  · v2.547 이 방금 릴리스됐고 기본 꺼짐(opt-in)이라 이력이 거의 없다.
 *  · IP 키로 쌓인 행은 어느 법인 것인지 **알 수 없어** 이어 붙일 수 없다(agent 를 빈 값으로 채우면
 *    엣지 법인의 장애가 '중앙 직접' 으로 둔갑한다 — 지어내는 것이다).
 *  · v2.534 `capacityBasisMigration` 과 같은 판단 — **측정 기준이 바뀌면 이어 붙이지 않는다**.
 * ⚠ 조용히 지우지 않는다 — `meta.reset` 에 `{at, from, to, reason, rows}` 를 남기고 `console.warn`
 *   한 줄을 찍는다. 화면은 `resetInfo()` 로 '키 체계가 바뀌어 이력을 새로 시작했습니다' 를 띄운다.
 * ⚠ **1회만** — `schema_version` 이 2 인 파일은 다시 지우지 않는다(재기동마다 지우면 이력이
 *   영원히 안 쌓인다). 새 파일은 마커 없이 version 2 만 적는다('처음부터 새 파일' 과 '지우고 새로
 *   시작' 은 다르다 — 화면이 배지를 잘못 띄우면 안 된다).
 * ⚠ 이 코드보다 **높은** 버전의 파일은 열지 않는다(`available:false`) — 모르는 스키마를 DROP 하면
 *   새 버전이 쌓은 이력을 잃고, 그대로 쓰면 statement 가 조용히 틀린 열을 읽는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';

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

/**
 * 스키마 버전. **1** = v2.547(PK part_key 단일) · **2** = v2.548(PK (agent, part_key) + device_key).
 * 올리면 `open()` 이 낮은 버전의 파일을 재생성한다 — 이어 붙일 수 없는 변경일 때만 올릴 것.
 */
export const SCHEMA_VERSION = 2;
const RESET_REASON = '파트 키 체계 변경 — 기본키 (agent, part_key) + 장비 키 등급(v2.548 F2). IP 키로 쌓인 v1 행은 법인을 알 수 없어 이어 붙이지 않는다.';

let x = null;
let ready = null;
let initError = null;
// v2.599 DB2599-02: 첫 open 이 잠금이면 initError 로 래치하지 않고 잠시 뒤 다시 연다(util/sqliteOpen.js).
const lockRetry = createLockRetry();
let _pruneTick = 0;

/** 두 테이블의 DDL — 재생성 경로와 신규 경로가 **같은 문장**을 쓴다(둘이 갈라지면 재생성 파일만 다른 스키마가 된다). */
const DDL = `
    CREATE TABLE IF NOT EXISTS part_state (
      agent       TEXT NOT NULL DEFAULT '',   -- 수집 주체(법인 축). '' = 중앙 직접
      part_key    TEXT NOT NULL,              -- scope:deviceKey:kind:partId (types.js partKeyOf)
      scope       TEXT NOT NULL,
      device_id   TEXT NOT NULL,              -- 노드 로컬 id(iDRAC 은 IP) — 표시·조회용, 키가 아니다
      device_key  TEXT,                       -- 파트 키의 장비 축(서비스태그·UUID·중앙 id·로컬 id)
      device_key_kind TEXT,                   -- 그 장비 키의 등급(types.js DEVICE_KEY_KIND)
      device_name TEXT,
      kind        TEXT,
      part_id     TEXT,
      key_kind    TEXT,
      label       TEXT,
      detail      TEXT,
      state       TEXT NOT NULL,
      raw_state   TEXT,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      hold_reason TEXT,
      notified_at INTEGER,
      PRIMARY KEY (agent, part_key)
    );
    CREATE INDEX IF NOT EXISTS ix_state_dev   ON part_state(agent, device_id);
    CREATE INDEX IF NOT EXISTS ix_state_scope ON part_state(scope, state);

    CREATE TABLE IF NOT EXISTS part_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      agent       TEXT NOT NULL DEFAULT '',
      part_key    TEXT NOT NULL,
      scope       TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      device_key  TEXT,
      device_key_kind TEXT,
      device_name TEXT,
      kind        TEXT,
      label       TEXT,
      key_kind    TEXT,
      event       TEXT NOT NULL,   -- open | change | close
      state       TEXT,
      prev_state  TEXT,
      raw_state   TEXT,
      close_reason TEXT
    );
    -- prune 은 at 단독 인덱스가 있어야 풀스캔을 피한다(CLAUDE.md 시계열 규약).
    CREATE INDEX IF NOT EXISTS ix_event_at  ON part_event(at);
    -- 파트 이력 조회는 법인 축까지 같이 잡는다 — 같은 part_key 의 두 법인 행이 섞이지 않게.
    CREATE INDEX IF NOT EXISTS ix_event_key ON part_event(agent, part_key, at);
    CREATE INDEX IF NOT EXISTS ix_event_dev ON part_event(agent, device_id, at);
`;

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const countOr0 = (db, table) => { try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0); } catch { return 0; } };

/**
 * 스키마 버전 판정 + 필요하면 재생성. **열기 전 파일 상태**로 셋을 가른다:
 *  · 새 파일(두 테이블 다 없음) → 만들고 version 2. 마커 없음.
 *  · v1 파일(테이블은 있는데 meta 없음 / version < 2) → DROP + 재생성 + `reset` 마커 + warn 한 줄.
 *  · version > 2 → 던진다(호출부가 `available:false` 로 정직 보고). 모르는 스키마를 건드리지 않는다.
 */
function migrate(db, p, now) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  const metaGet = db.prepare('SELECT v FROM meta WHERE k=?');
  const metaSet = db.prepare('INSERT INTO meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  const existed = hasTable(db, 'part_state') || hasTable(db, 'part_event');
  const verRow = metaGet.get('schema_version');
  // meta 가 없는데 테이블이 있으면 v1 이다(v2.547 은 meta 를 만들지 않았다).
  const from = verRow ? Number(verRow.v) : (existed ? 1 : 0);

  if (from > SCHEMA_VERSION) {
    throw new Error(`part-faults.db 스키마 버전 ${from} 은 이 코드(v${SCHEMA_VERSION})보다 높습니다 — 다운그레이드된 포탈은 이 파일을 열지 않습니다(이력 보호)`);
  }
  if (existed && from < SCHEMA_VERSION) {
    // 무엇을 지우는지 **개수를 세어** 남긴다 — '지웠다' 만으로는 사용자가 잃은 것을 가늠할 수 없다.
    const rows = { states: countOr0(db, 'part_state'), events: countOr0(db, 'part_event') };
    db.exec('BEGIN');
    try {
      db.exec('DROP TABLE IF EXISTS part_state; DROP TABLE IF EXISTS part_event;');
      db.exec(DDL);
      metaSet.run('schema_version', String(SCHEMA_VERSION));
      metaSet.run('reset', JSON.stringify({ at: now, from, to: SCHEMA_VERSION, reason: RESET_REASON, rows }));
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    console.warn(`[partfault] ${p}: 스키마 v${from} → v${SCHEMA_VERSION} — 파트 상태 ${rows.states}행·이벤트 ${rows.events}행을 지우고 새로 시작합니다(${RESET_REASON})`);
    return;
  }
  db.exec(DDL);
  if (!verRow) metaSet.run('schema_version', String(SCHEMA_VERSION));
}

function prepare(db) {
  return {
    // ⚠ ON CONFLICT 는 **(agent, part_key)** 다 — part_key 만 보면 v1 결함(F2)이 그대로 재발한다.
    //   같은 키가 다시 관측되면 표시 정보는 최신을 따른다. `device_id` 도 갱신한다 — v2 의 키는
    //   deviceKey(서비스태그)라 IP 가 바뀌어도 같은 파트이고, 화면은 지금 주소를 보여야 한다.
    //   `first_seen`·`notified_at` 은 보존한다(처음 감지·알림 시각은 사실이다).
    upsert: db.prepare(`INSERT INTO part_state
      (agent,part_key,scope,device_id,device_key,device_key_kind,device_name,kind,part_id,key_kind,label,detail,state,raw_state,first_seen,last_seen,hold_reason,notified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent, part_key) DO UPDATE SET
        device_id=excluded.device_id, device_key=excluded.device_key, device_key_kind=excluded.device_key_kind,
        device_name=excluded.device_name, kind=excluded.kind, key_kind=excluded.key_kind,
        label=excluded.label, detail=excluded.detail,
        state=excluded.state, raw_state=excluded.raw_state, last_seen=excluded.last_seen,
        hold_reason=excluded.hold_reason`),
    touch: db.prepare('UPDATE part_state SET last_seen=?, hold_reason=?, raw_state=COALESCE(?,raw_state) WHERE agent=? AND part_key=?'),
    markNotified: db.prepare('UPDATE part_state SET notified_at=? WHERE agent=? AND part_key=?'),
    del: db.prepare('DELETE FROM part_state WHERE agent=? AND part_key=?'),
    openList: db.prepare('SELECT * FROM part_state ORDER BY first_seen DESC LIMIT ?'),
    openByScope: db.prepare('SELECT * FROM part_state WHERE scope=? ORDER BY first_seen DESC LIMIT ?'),
    openAll: db.prepare('SELECT * FROM part_state'),
    event: db.prepare(`INSERT INTO part_event
      (at,agent,part_key,scope,device_id,device_key,device_key_kind,device_name,kind,label,key_kind,event,state,prev_state,raw_state,close_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    events: db.prepare('SELECT * FROM part_event WHERE at>=? ORDER BY at DESC LIMIT ?'),
    eventsOfPart: db.prepare('SELECT * FROM part_event WHERE agent=? AND part_key=? ORDER BY at DESC LIMIT ?'),
    prune: db.prepare('DELETE FROM part_event WHERE at < ?'),
    stats: db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS mn, MAX(at) AS mx FROM part_event'),
    stateStats: db.prepare('SELECT COUNT(*) AS n FROM part_state'),
    metaGet: db.prepare('SELECT v FROM meta WHERE k=?'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = (async () => withOpenCleanup(async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const db = openSqlite(new DatabaseSync(p));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
      // 버전이 더 높은 파일이면 여기서 던진다 → initError → `available:false`(포탈은 뜬다).
      try { migrate(db, p, Date.now()); } catch (e) { try { db.close(); } catch { /* */ } throw e; }
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      x = { db, st, path: p, schemaVersion: SCHEMA_VERSION };
      return x;
    }))().catch((e) => { if (lockRetry.onFail(e)) { ready = null; return null; } initError = e; return null; });
  }
  return ready;
}

function readReset(h) {
  try {
    const r = h.st.metaGet.get('reset');
    if (!r) return null;
    const j = JSON.parse(r.v);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }   // 손상 행은 '마커 없음' 이 아니라 읽지 못한 것이지만, 배지를 지어내지는 않는다
}

/**
 * 재시작(재생성) 마커 — 화면이 '키 체계가 바뀌어 이력을 새로 시작했습니다' 배지를 띄우는 근거.
 * @returns {Promise<null|{at:number, from:number, to:number, reason:string, rows?:{states:number, events:number}}>}
 *   없으면(새 파일이거나 재생성이 없었으면) `null`.
 */
export async function resetInfo() {
  const h = await open();
  return h ? readReset(h) : null;
}

export async function partFaultDbStatus() {
  const h = await open();
  return {
    available: !!h, path: h ? h.path : DB_PATH(), retentionDays: RETENTION_DAYS,
    schemaVersion: h ? h.schemaVersion : null,
    reset: h ? readReset(h) : null,
    error: initError ? String(initError.message || initError).slice(0, 200) : (h ? '' : lockRetry.note()),
    openParts: h ? (h.st.stateStats.get()?.n ?? null) : null,
    ...(h ? h.st.stats.get() : { rows: null, mn: null, mx: null }),
  };
}

/** 지금 열려 있는 장애 전량 — 전이 계산의 입력. `agent` 열이 함께 나온다(법인 축). */
export async function openFaults({ scope = '', limit = 20_000 } = {}) {
  const h = await open();
  if (!h) return [];
  const rows = scope ? h.st.openByScope.all(scope, limit) : h.st.openList.all(limit);
  return rows.map(rowToPart);
}

function rowToPart(r) {
  return {
    partKey: r.part_key, scope: r.scope, deviceId: r.device_id,
    deviceKey: r.device_key, deviceKeyKind: r.device_key_kind, deviceName: r.device_name,
    kind: r.kind, partId: r.part_id, keyKind: r.key_kind, label: r.label, detail: r.detail,
    agent: r.agent, state: r.state, rawState: r.raw_state,
    firstSeenAt: r.first_seen, lastSeenAt: r.last_seen, holdReason: r.hold_reason,
    notifiedAt: r.notified_at,
  };
}

const agentOf = (p) => String(p?.agent || '');

/**
 * 전이 결과를 **한 트랜잭션으로** 반영한다. 각 파트의 법인 축은 `p.agent || ''` 다.
 * ⚠ 대량 write 는 반드시 트랜잭션으로 묶는다(CLAUDE.md 성능 불변조건 — 무트랜잭션 6천 행이
 *   25초 블로킹을 만든 사고가 있다).
 * @returns {{saved:boolean, opened:number, closed:number, changed:number, reason?:string}}
 */
export async function applyTransition(tr, { now = Date.now() } = {}) {
  const h = await open();
  if (!h) return { saved: false, opened: 0, closed: 0, changed: 0, reason: initError ? String(initError.message).slice(0, 200) : 'node:sqlite 없음' };
  const { db, st } = h;
  const ev = (e, p, extra = {}) => st.event.run(
    now, agentOf(p), p.partKey, p.scope, p.deviceId, p.deviceKey || p.deviceId || '', p.deviceKeyKind || '',
    p.deviceName || '', p.kind || '', p.label || '', p.keyKind || '',
    e, extra.state ?? p.state ?? null, extra.prevState ?? null,
    p.rawState || '', extra.closeReason ?? null,
  );
  const put = (p) => st.upsert.run(
    agentOf(p), p.partKey, p.scope, p.deviceId, p.deviceKey || p.deviceId || '', p.deviceKeyKind || '',
    p.deviceName || '', p.kind || '', p.partId || '', p.keyKind || '', p.label || '', p.detail || '',
    p.state, p.rawState || '', p.firstSeenAt || now, p.lastSeenAt || now, null, null,
  );
  db.exec('BEGIN');
  try {
    for (const p of tr.opened || []) { put(p); ev('open', p); }
    for (const p of tr.updated || []) {
      put(p);
      // 같은 상태가 이어지는 것은 **이벤트가 아니다** — 이벤트로 남기면 전이 테이블이 전량 적재가 된다.
      if (!p.sameState) ev('change', p, { prevState: p.prevState });
    }
    for (const p of tr.closed || []) {
      st.del.run(agentOf(p), p.partKey);
      ev('close', p, { state: null, prevState: p.state, closeReason: p.closeReason || 'ok' });
    }
    // 유지(held)는 **이벤트를 만들지 않는다** — 사유만 갱신해 화면이 '왜 아직 열려 있나' 를 말한다.
    for (const p of tr.held || []) st.touch.run(p.lastSeenAt || p.lastHeldAt || now, p.holdReason || null, p.rawState || null, agentOf(p), p.partKey);
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

/**
 * 알림 발송 시각을 찍는다. **(agent, partKey) 쌍**을 받는다(v2.548 — 시그니처 변경. v2.547 은
 * partKey 문자열 배열이었다). 문자열을 주면 `agent:''`(중앙 직접) 로 본다 — 엣지 법인의 행에는
 * 닿지 않으므로 호출부는 반드시 `p.agent` 를 실어야 한다.
 * @param {Array<{agent?:string, partKey:string}|string>} items
 * @returns {Promise<number>} **실제로 갱신된 행 수**(요청 수가 아니다 — 0 이면 키가 맞지 않은 것이다).
 */
export async function markNotified(items, { now = Date.now() } = {}) {
  const h = await open();
  if (!h || !items?.length) return 0;
  let n = 0;
  h.db.exec('BEGIN');
  try {
    for (const it of items) {
      const agent = typeof it === 'string' ? '' : agentOf(it);
      const key = typeof it === 'string' ? it : String(it?.partKey || '');
      if (!key) continue;
      n += Number(h.st.markNotified.run(now, agent, key)?.changes || 0);
    }
    h.db.exec('COMMIT');
  } catch { try { h.db.exec('ROLLBACK'); } catch { /* */ } return 0; }
  return n;
}

/**
 * 최근 전이 이벤트. 파트 하나로 좁힐 때는 **`{agent, partKey}`** 로 준다(v2.548) — 같은 part_key 의
 * 두 법인 이력이 섞이지 않게. `partKey` 에 문자열을 주면 `agent` 옵션(기본 '' = 중앙 직접)과 짝이 된다.
 * @param {{sinceMs?:number, limit?:number, partKey?:string|{agent?:string, partKey:string}, agent?:string}} [o]
 */
export async function recentEvents({ sinceMs = 30 * 86_400_000, limit = 500, partKey = '', agent = '' } = {}) {
  const h = await open();
  if (!h) return [];
  const key = typeof partKey === 'object' && partKey ? String(partKey.partKey || '') : String(partKey || '');
  const ag = typeof partKey === 'object' && partKey ? agentOf(partKey) : String(agent || '');
  // v2.607 DB2607-04: node:sqlite 는 JS number 를 REAL 로 바인딩한다 — 소수 limit 은 'datatype mismatch'. 정수 [1, 2000].
  const lim = Math.max(1, Math.min(2_000, Math.trunc(Number(limit)) || 500));
  const rows = key ? h.st.eventsOfPart.all(ag, key, lim) : h.st.events.all(Math.trunc(Date.now() - (Number(sinceMs) || 0)), lim);
  return rows.map((r) => ({
    at: r.at, partKey: r.part_key, scope: r.scope, deviceId: r.device_id,
    deviceKey: r.device_key, deviceKeyKind: r.device_key_kind, deviceName: r.device_name,
    kind: r.kind, label: r.label, keyKind: r.key_kind, event: r.event, state: r.state,
    prevState: r.prev_state, rawState: r.raw_state, closeReason: r.close_reason, agent: r.agent,
  }));
}

export function _resetForTest() {
  lockRetry.ok();
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; _pruneTick = 0;
}
