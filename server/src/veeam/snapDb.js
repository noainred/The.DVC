/**
 * Veeam 스냅샷 이벤트 전용 DB(v2.759 — 사용자 요청: '별도 DB 에 저장해 두고 화면은 바로 · 최근 1달 보관').
 *
 * 왜: vCenter 카드의 백업 수량·VM 화면의 'Veeam 백업 시도' 는 요청 때마다 로그 DB(전 이벤트 · 고빈도 vCenter 는 하루 수십만 행)를
 *   '스냅샷' 검색어로 4열 LIKE · 1시간 조각 168개 × 2 로 훑었다 — 연동 없는 vCenter 마다. 재시작 직후 캐시가 비면 첫 화면이 수 초~수십 초.
 *   이 DB 는 **스냅샷 생성·제거 행만** 담는다(전체 이벤트의 극히 일부) — 로그 폴러가 적재할 때 같이 넣고, 화면은 이 작은 표만 읽는다.
 *
 * 표:
 *   snap_ev(vcenterId, ts, severity, type, user, entity, message, h) — UNIQUE(vcenterId, h). h = 시각·종류·대상·계정·문구 해시
 *     (로그 DB 적재분과 기존 로그에서 옮긴 분이 겹쳐도 한 번 — localSnapSummary 의 중복 제거 키와 같은 필드).
 *   snap_meta(k, v) — 'from:<vcenterId>' = 이 DB 가 그 vCenter 의 스냅샷 행을 빠짐없이 가진 가장 이른 시각(백필이 거꾸로 넓힌다).
 *     v2.765: 'cur:<vcenterId>'·'ok:<vcenterId>'·'seen:<vcenterId>' = Veeam 계정 전용 수집기(snapCollector.js)의 읽기 커서·완결 시각·
 *     '그 계정 표기로 이벤트를 한 번이라도 읽었다'(okAt 은 seen 뒤에만 유효 — 표기 불일치의 0건 완결을 '최신' 으로 믿지 않는다).
 *   snap_edge(vcenterId, json, at) — 엣지가 보낸 요약(중앙). 재시작해도 다음 push 전까지 마지막 값이 보인다.
 * 보관: 31일(RETENTION_MS) — prune 은 적재 N회마다 1회(첫 회 금지) · ts 단독 인덱스.
 * node:sqlite 가 없으면 getSnapDb() 는 null — 호출부는 예전 경로(로그 DB 검색)로 간다(기능은 같고 느릴 뿐).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { createYielder } from '../util/timeSlice.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';

const DAY = 86_400_000;
export const RETENTION_MS = 31 * DAY;          // 사용자 지시: 최근 1달
export const BACKFILL_FIRST_MS = 8 * DAY;      // 백필은 이만큼을 먼저(화면 7일 + 공용 계정 짝짓기 12시간) — 그다음 31일까지 넓힌다
const DAY_ROW_LIMIT = 20_000;                  // 백필 하루 창의 검색어별 상한(넘으면 그날은 일부만 — 로그로 남긴다)
const PRUNE_EVERY = 30;
const INGEST_CHUNK_ROWS = 2_000;               // v2.765: ingestSnapRows 조각 — 40,000행 한 트랜잭션 373ms(실측) → 조각당 수십 ms + 양보

/** 스냅샷 관련 행인가 — 로그 DB 검색(4열 LIKE '%snapshot%' · '%스냅샷%', ASCII 대소문자 무시)과 같은 판정. */
export function isSnapRow(r) {
  if (!r || typeof r !== 'object') return false;
  const t = `${r.message || ''} ${r.entity || ''} ${r.user || ''} ${r.type || ''}`.toLowerCase();
  return t.includes('snapshot') || t.includes('스냅샷');
}
const rowHash = (r) => crypto.createHash('sha1').update(`${Number(r.ts) || 0}\u0000${r.type || ''}\u0000${r.entity || ''}\u0000${r.user || ''}\u0000${r.message || ''}`).digest('base64');

let impl = null;
let ready = null;
let unavailable = false;
// v2.761(C9): 잠금으로 못 열면 래치하지 않고 30초 뒤 다시 연다(sqliteOpen 규칙 3) — 잠금이 아닌 오류만 unavailable 로 래치한다.
const _lock = createLockRetry(30_000);
/*
 * v2.761(C5): 실시간 적재가 실패한(또는 DB 를 못 연 동안 버린) vCenter — vcenterId → 무효로 한 시각.
 *   coveredFrom 은 이 vCenter 를 '모름(null)' 으로 돌려 화면은 로그 DB 경로·백필로 간다(빠진 행을 믿지 않는다).
 *   DB 가 쓰이면 meta 'from:<vc>' 도 지운다(재시작 뒤에도 무효) · 무효로 한 뒤 시작한 백필이 덮음을 다시 기록하면 풀린다.
 */
const _coverInvalid = new Map();
/*
 * v2.762(E1): 덮음 무효 표지 파일(DB 옆 '<db>.invalid') — 메모리 무효(C5)는 재시작에 사라지고, 잠금이 아닌 open 실패로 래치된 프로세스는
 *   버린 행을 무효로 하지도 않았다(다음 프로세스가 열면 빠진 행을 '완전' 으로 믿었다). 버린 행의 vCenter 를 이 파일에 적어 두면
 *   다음 open 이 그 vCenter 의 'from:' meta 를 지우고 표지를 지운다 — 백필(워커)이 다시 메운다. 파일을 못 읽으면 전 vCenter 를 지운다(안전 쪽).
 *   표지 쓰기 자체가 실패하면(같은 볼륨 장애) 예전과 같다 — 경고 1줄.
 */
const markerPath = () => `${config.veeamSnap.dbPath}.invalid`;
const _markerIds = new Set();   // 이 프로세스가 표지에 적은 vCenter(같은 내용을 매 주기 다시 쓰지 않는다)
let _markerWarned = false;
/** 표지 읽기 — none(없음) · ids(적힌 vCenter) · all(못 읽음·손상·all 표지 — 어느 vCenter 인지 모르므로 전부). 손상은 보존해 둔다. */
function readInvalidMarker() {
  let raw;
  try { raw = fs.readFileSync(markerPath(), 'utf8'); } catch (e) { return e?.code === 'ENOENT' ? { state: 'none' } : { state: 'all' }; }
  try {
    const j = JSON.parse(raw);
    if (j?.all === true) return { state: 'all' };
    if (Array.isArray(j?.vcenterIds)) return { state: 'ids', ids: j.vcenterIds.filter((v) => typeof v === 'string') };
    throw new Error('형식 오류');
  } catch (e) { preserveCorrupt(markerPath(), e?.message); return { state: 'all' }; }
}
function writeInvalidMarker(ids) {
  const add = [...ids].filter((v) => !_markerIds.has(v));
  if (!add.length) return;
  const prev = readInvalidMarker();
  // 이미 있던 표지를 못 읽으면 그 안의 vCenter 를 모른다 — 이번 것으로 덮어 좁히지 않고 '전부' 로 둔다.
  const body = prev.state === 'all' ? { v: 1, at: Date.now(), all: true }
    : { v: 1, at: Date.now(), vcenterIds: [...new Set([...(prev.state === 'ids' ? prev.ids : []), ..._markerIds, ...add])].slice(0, 4096) };
  try {
    atomicWriteFileSync(markerPath(), JSON.stringify(body));
    for (const v of add) _markerIds.add(v);
  } catch (e) {
    if (!_markerWarned) { _markerWarned = true; console.warn(`[veeam-snap] 덮음 무효 표지를 남기지 못했습니다(다음 기동이 빠진 행을 모를 수 있습니다): ${String(e?.message || e).slice(0, 200)}`); }
  }
}
/** open 직후 — 표지가 있으면 적힌 vCenter(못 읽으면 전부)의 덮음 meta 를 지우고 표지를 지운다. */
function consumeInvalidMarker(db) {
  const m = readInvalidMarker();
  if (m.state === 'none') return;
  const ids = m.state === 'ids' ? m.ids : null;
  db.exec('BEGIN');
  try {
    if (ids) { const d = db.prepare('DELETE FROM snap_meta WHERE k=?'); for (const v of ids) d.run(`from:${v}`); }
    else db.exec("DELETE FROM snap_meta WHERE k LIKE 'from:%'");
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
  try { fs.unlinkSync(markerPath()); } catch (e) { if (e?.code !== 'ENOENT') console.warn(`[veeam-snap] 덮음 무효 표지를 지우지 못했습니다(다음 기동에 한 번 더 백필합니다): ${String(e?.message || e).slice(0, 200)}`); }
  _markerIds.clear();
  console.warn(`[veeam-snap] 지난 실행에서 전용 DB 에 넣지 못한 스냅샷 행이 있어 ${ids ? `vCenter ${ids.length}곳` : '전 vCenter'} 의 덮음 기록을 지웠습니다 — 백필이 다시 메웁니다`);
}

function initSqlite(dbPath) {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openSqlite(new DatabaseSync(dbPath));
    db.exec(`
      CREATE TABLE IF NOT EXISTS snap_ev (
        vcenterId TEXT NOT NULL, ts INTEGER NOT NULL, severity TEXT, type TEXT, user TEXT, entity TEXT, message TEXT, h TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_uniq ON snap_ev (vcenterId, h);
      CREATE INDEX IF NOT EXISTS idx_snap_vc_ts ON snap_ev (vcenterId, ts);
      CREATE INDEX IF NOT EXISTS idx_snap_ts ON snap_ev (ts);
      CREATE TABLE IF NOT EXISTS snap_meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS snap_edge (vcenterId TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    consumeInvalidMarker(db);   // v2.762(E1): 지난 실행이 버린 행이 있으면 그 덮음을 믿지 않는다
    const ins = db.prepare('INSERT OR IGNORE INTO snap_ev (vcenterId, ts, severity, type, user, entity, message, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const sel = db.prepare('SELECT vcenterId, ts, severity, type, user, entity, message FROM snap_ev WHERE vcenterId=? AND ts>=? ORDER BY ts DESC LIMIT ?');
    const metaGet = db.prepare('SELECT v FROM snap_meta WHERE k=?');
    const metaSet = db.prepare('INSERT INTO snap_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    const metaDel = db.prepare('DELETE FROM snap_meta WHERE k=?');
    const edgeSet = db.prepare('INSERT INTO snap_edge (vcenterId, json, at) VALUES (?, ?, ?) ON CONFLICT(vcenterId) DO UPDATE SET json=excluded.json, at=excluded.at');
    const edgeAll = db.prepare('SELECT vcenterId, json, at FROM snap_edge');
    // 보관 정리는 청크(util/chunkedPrune.js — 한 방 DELETE 금지 규약) · ts 단독 인덱스를 탄다 · 동시에 하나(진행 중이면 그것을 쓴다).
    const edgeDel = db.prepare('DELETE FROM snap_edge WHERE rowid IN (SELECT rowid FROM snap_edge WHERE at < ? LIMIT ?)');
    const del = db.prepare('DELETE FROM snap_ev WHERE rowid IN (SELECT rowid FROM snap_ev WHERE ts < ? LIMIT ?)');
    const pruneFlight = createPruneFlight();
    let tick = 0;
    const insertTx = (list) => {
      db.exec('BEGIN');
      try {
        for (const r of list) ins.run(String(r.vcenterId), Number(r.ts), r.severity ?? null, r.type ?? null, r.user ?? null, r.entity ?? null, r.message ?? null, rowHash(r));
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
    };
    const api = {
      /** 스냅샷 행만 골라 한 트랜잭션으로 넣는다(동기 — 호출부가 조각을 작게 넘긴다). 반환: 넣으려 한 행 수. tick:false 는 ingestAsync 의 조각(prune 셈은 묶음당 1). */
      ingest(rows, { tick: countTick = true } = {}) {
        const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.vcenterId != null && Number.isFinite(Number(r.ts)) && isSnapRow(r));
        if (list.length) insertTx(list);
        if (countTick && (++tick % PRUNE_EVERY) === 0) api.prune().catch(() => {});   // 첫 회 금지(기동 직후 DELETE 스캔을 피한다)
        return list.length;
      },
      /**
       * v2.765(1-a): 큰 묶음(로그 폴러 회차 40,000행·전용 수집기 호출분)은 조각(chunkRows) 트랜잭션 + 조각 사이 시간 기준 양보(createYielder).
       *   조각마다 api.ingest 를 탄다(적재 실패 주입·C5 테스트가 그 함수를 바꾼다) — prune 셈은 묶음당 1 로 예전과 같다.
       *   해시 UNIQUE 라 조각 사이에 실패해도 다시 넣으면 한 번이다 — 던지면 호출부(ingestSnapRows)가 덮음 무효(C5/E1)로 간다. 반환: 넣으려 한 행 수.
       */
      async ingestAsync(rows, { chunkRows = INGEST_CHUNK_ROWS, yieldMs = 15 } = {}) {
        const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.vcenterId != null && Number.isFinite(Number(r.ts)) && isSnapRow(r));
        const per = Math.max(1, Math.floor(Number(chunkRows)) || INGEST_CHUNK_ROWS);
        const maybeYield = createYielder(yieldMs);
        let n = 0;
        for (let i = 0; i < list.length; i += per) { n += api.ingest(list.slice(i, i + per), { tick: false }); await maybeYield(); }
        if ((++tick % PRUNE_EVERY) === 0) api.prune().catch(() => {});
        return n;
      },
      /** 그 vCenter 의 since 이후 행(최신 먼저, 상한). */
      rowsFor(vcenterId, since, limit) { return sel.all(String(vcenterId), Number(since) || 0, Math.max(1, Math.floor(limit) || 1)); },
      /** 빠짐없이 가진 가장 이른 시각(백필 진행) — 모르면 null(적재 실패로 무효가 된 vCenter 도 — v2.761 C5). */
      coveredFrom(vcenterId) {
        if (_coverInvalid.has(String(vcenterId))) return null;
        const r = metaGet.get(`from:${vcenterId}`); const n = Number(r?.v); return Number.isFinite(n) && n > 0 ? n : null;
      },
      /** startedAt = 그 백필을 시작한 시각 — 무효로 한 뒤 시작한 백필만 덮음을 다시 기록한다(그 전 백필은 빠진 구간을 다시 읽지 않았다). */
      setCoveredFrom(vcenterId, ts, startedAt = Date.now()) {
        const k = String(vcenterId); const inv = _coverInvalid.get(k);
        if (inv != null && startedAt < inv) return false;
        metaSet.run(`from:${k}`, String(Math.floor(ts)));
        if (inv != null) _coverInvalid.delete(k);
        return true;
      },
      /*
       * v2.765: Veeam 계정 전용 수집기(snapCollector.js)의 커서·완결 시각 — snap_meta 'cur:<vc>'(마지막으로 읽은 이벤트 시각) ·
       *   'ok:<vc>'(그 vCenter 의 Veeam 계정 이벤트가 온전한 마지막 시각). 재시작해도 이어 읽고, 화면의 collectedAt 결합(snapEventsOkAt)에 쓴다.
       *   수가 아니면 null(모름) — 0 으로 읽지 않는다.
       */
      snapCursor(vcenterId) { const n = Number(metaGet.get(`cur:${vcenterId}`)?.v); return Number.isFinite(n) && n > 0 ? n : null; },
      setSnapCursor(vcenterId, ts) { metaSet.run(`cur:${vcenterId}`, String(Math.floor(Number(ts)))); },
      snapOkAt(vcenterId) { const n = Number(metaGet.get(`ok:${vcenterId}`)?.v); return Number.isFinite(n) && n > 0 ? n : null; },
      setSnapOkAt(vcenterId, ts) { metaSet.run(`ok:${vcenterId}`, String(Math.floor(Number(ts)))); },
      /** v2.765(4-a): 'seen:<vc>' — 전용 수집기가 그 vCenter 에서 계정 필터로 이벤트를 1건 이상 읽은 시각(없으면 null). */
      snapSeenAt(vcenterId) { const n = Number(metaGet.get(`seen:${vcenterId}`)?.v); return Number.isFinite(n) && n > 0 ? n : null; },
      setSnapSeenAt(vcenterId, ts) { metaSet.run(`seen:${vcenterId}`, String(Math.floor(Number(ts)))); },
      /**
       * v2.766(점검 R1-A1-1·A5-1): 'fp:<vc>' — 전용 수집기의 커서·완결 시각이 어떤 계정 목록(userList 지문)으로 만든 것인가. 없으면 null.
       *   목록이 바뀌면 resetSnapCollector 가 커서·완결 시각·seen 을 한 트랜잭션으로 지우고 새 지문을 적는다(새 계정의 지난 이벤트를 다시 읽게).
       */
      snapFp(vcenterId) { const v = metaGet.get(`fp:${vcenterId}`)?.v; return typeof v === 'string' && v ? v : null; },
      resetSnapCollector(vcenterId, fp) {
        db.exec('BEGIN');
        try {
          for (const k of ['cur', 'ok', 'seen']) metaDel.run(`${k}:${vcenterId}`);
          metaSet.run(`fp:${vcenterId}`, String(fp));
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
      },
      /** 덮음 기록 지우기(적재 실패 — 다음 요청이 백필로 다시 메운다. 해시로 중복 없음). 실패해도 메모리 무효는 남는다. */
      dropCoverage(vcenterIds) {
        let ok = true;
        for (const vc of vcenterIds) { try { metaDel.run(`from:${vc}`); } catch { ok = false; /* 메모리 무효 + 표지로 대신한다 */ } }
        return ok;
      },
      saveEdge(vcenterId, obj, at) { edgeSet.run(String(vcenterId), JSON.stringify(obj), Math.floor(Number(at) || Date.now())); },
      loadEdge() { return edgeAll.all().map((r) => { try { return { vcenterId: r.vcenterId, at: r.at, obj: JSON.parse(r.json) }; } catch { return null; } }).filter(Boolean); },
      /** 31일보다 오래된 행 정리(청크 · 비동기). */
      prune(now = Date.now()) {
        const cut = now - RETENTION_MS;
        return pruneFlight.run(cut, async () => {
          const r = await chunkedDelete(del, [cut], { label: 'veeam-snap.snap_ev' });
          await chunkedDelete(edgeDel, [cut], { label: 'veeam-snap.snap_edge' });
          return r;
        });
      },
      close() { try { db.close(); } catch { /* */ } },
    };
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
    return api;
  });
}

/**
 * DB 핸들(없으면 null — node:sqlite 불가·잠금 재시도 대기). 잠겨 있으면 래치하지 않고 30초 뒤 다음 호출이 다시 연다
 * (v2.761 C9 — sqliteOpen 규칙 3). 잠금이 아닌 오류만 프로세스 수명 동안 래치한다.
 * v2.762(E3): 시도당 **한 번만** 연다(withOpenCleanup) — v2.761 은 retryOnLock(5회 × busy_timeout 3초 동기 대기)을 30초 재시도와 겹쳐
 *   잠금이 이어지는 동안 30초마다 12~15초씩 주 스레드가 멈췄다(실측). 다른 createLockRetry 모듈(rma/historyDb.js 등)과 같은 방식.
 */
export async function getSnapDb() {
  if (impl) return impl;
  if (unavailable || _lock.blocked()) return null;
  if (!ready) {
    ready = withOpenCleanup(() => initSqlite(config.veeamSnap.dbPath))
      .then((db) => { _lock.ok(); if (_coverInvalid.size) db.dropCoverage([..._coverInvalid.keys()]); return db; })
      .catch((e) => {
        if (_lock.onFail(e)) console.warn(`[veeam-snap] 전용 DB 가 잠겨 있어 열지 못했습니다 — 30초 뒤 다시 엽니다(그동안 로그 DB 검색): ${String(e?.message || e).slice(0, 200)}`);
        else { unavailable = true; console.warn(`[veeam-snap] 전용 DB 를 열지 못했습니다 — 로그 DB 검색으로 계산합니다(느림): ${String(e?.message || e).slice(0, 200)}`); }
        return null;
      });
  }
  const p = ready;
  const db = await p;
  if (db) impl = db;
  else if (ready === p) ready = null;   // 다음 시도(잠금이면 30초 뒤)가 다시 연다
  return db;
}

/** v2.761(C5): 적재하지 못한 스냅샷 행의 vCenter 를 '덮음 무효' 로 — 메모리 + (DB 가 있으면) meta 삭제. */
function invalidateCoverage(rows, db) {
  const ids = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.vcenterId != null && isSnapRow(r)) ids.add(String(r.vcenterId));
  if (!ids.size) return;
  const t = Date.now();
  for (const vc of ids) _coverInvalid.set(vc, t);
  let dropped = false;
  if (db) { try { dropped = db.dropCoverage([...ids]) !== false; } catch { dropped = false; } }
  // v2.762(E1): DB 의 meta 를 지우지 못했으면(열지 못함·잠금 대기·삭제 실패) 표지로 남긴다 — 메모리 무효는 재시작에 사라진다.
  if (!dropped) writeInvalidMarker(ids);
}

let _ingestWarned = 0;
/**
 * 로그 폴러가 적재한 행 중 스냅샷 행을 넣는다(실패해도 로그 적재는 그대로 — 시간당 경고 1줄). 실패·DB 없음이면 그 vCenter 의 덮음을 무효로(v2.761 C5).
 * v2.765(1-a): 조각(2,000행) 트랜잭션 + 조각 사이 양보(db.ingestAsync) — 한 덩어리 373ms 가 이벤트 루프를 막았다. 조각 중간에 실패해도
 *   '덮음 무효' 의미는 그대로(0 을 돌려준다 — 호출부는 넣으려 한 수와 다르면 실패로 본다).
 */
export async function ingestSnapRows(rows) {
  let db = null;
  try {
    db = await getSnapDb();
    if (db) return await db.ingestAsync(rows);
    // 잠금 대기 중이거나 래치(잠금이 아닌 open 실패) — 버린 행이 있다. v2.762(E1): 래치도 무효로 한다(표지 파일 — 다음 프로세스가 열면
    //   빠진 행을 믿지 않는다). 예전에는 'node:sqlite 자체가 없을 때' 만 전제로 래치 중 버린 행을 무효로 하지 않았다.
    invalidateCoverage(rows, null);
    return 0;
  } catch (e) {
    invalidateCoverage(rows, db);
    if (Date.now() - _ingestWarned > 3_600_000) { _ingestWarned = Date.now(); console.warn(`[veeam-snap] 스냅샷 행 적재 실패: ${String(e?.message || e).slice(0, 200)}`); }
    return 0;
  }
}

/**
 * 백필 — 이 DB 를 쓰기 전부터 로그 DB 에 있던 스냅샷 행을 옮긴다(업그레이드 뒤 한 번). vCenter 마다 지금부터 하루씩 거꾸로,
 * 먼저 BACKFILL_FIRST_MS(8일)까지 전 vCenter 를 채운 뒤 RETENTION_MS(31일)까지 넓힌다(화면이 쓰는 7일이 먼저 준비되게).
 * 하루를 마칠 때마다 coveredFrom 을 그날 시작으로 낮춘다 — 중간에 재시작해도 이어서 한다. 동시에 하나만(진행 중 약속 공유).
 * 이 사이 새로 들어오는 이벤트는 로그 폴러가 ingest 로 넣는다(겹치면 h 로 한 번).
 * @param {{ logsDb: object, vcenterIds: string[], now?: number }} a
 */
let _backfill = null;
export function backfillSnap(a) {
  if (_backfill) return _backfill;
  _backfill = runBackfill(a).finally(() => { _backfill = null; });
  return _backfill;
}
export function backfillRunning() { return !!_backfill; }

/*
 * v2.759.1 핫픽스 — 백필의 로그 DB 검색은 **워커 스레드**에서(snapBackfillWorker.js · 로그 DB 를 읽기 전용으로 따로 연다).
 *   v2.759 는 주 스레드에서 검색해(조각 사이 양보는 했으나 동기 SQL 한 번이 수십~수백 ms) 업그레이드 직후 큰 vCenter 12개의 인벤토리
 *   수집이 90초 데드라인을 넘겼다(실서버 — 시점·코드 근거의 추정). 주 스레드는 받은 행을 넣기만 한다(하루 수천 행 · 해시 + 트랜잭션 1번).
 *   워커를 못 쓰면(NDJSON 폴백 로그 · 워커 생성 실패) 주 스레드에서 읽되 **하루마다 쉰다**(BACKFILL_PAUSE_MS — 수집에 자리를 내준다).
 */
const BACKFILL_PAUSE_MS = 200;
const WORKER_PAUSE_MS = 50;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

let _workerUrl = new URL('./snapBackfillWorker.js', import.meta.url);
export function _setBackfillWorkerUrlForTest(u) { _workerUrl = u || new URL('./snapBackfillWorker.js', import.meta.url); }
export const _backfillStats = { worker: 0, inline: 0 };   // 테스트·진단용 — 어느 경로로 읽었는가(하루 창 수)

/** 워커 읽기 — read(vc, since, until, limit) → rows. 워커가 죽으면 reject(호출부가 중단한다 — 주 스레드 검색으로 넘어가지 않는다). */
function workerReader(file) {
  const w = new Worker(_workerUrl, { workerData: { file } });
  let seq = 0; const pending = new Map();
  const failAll = (err) => { for (const [, p] of pending) p.reject(err); pending.clear(); };
  w.on('message', (m) => { const p = pending.get(m?.id); if (!p) return; pending.delete(m.id); if (m.ok) p.resolve(m.rows || []); else p.reject(new Error(m.error || 'worker error')); });
  w.on('error', (e) => failAll(e));
  w.on('exit', (code) => { if (pending.size) failAll(new Error(`백필 워커 종료(exit ${code})`)); });
  return {
    kind: 'worker',
    read(vcenterId, since, until, limit) {
      return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ id, vcenterId, since, until, limit }); });
    },
    close() { try { w.terminate(); } catch { /* */ } },
  };
}

/** 주 스레드 읽기(워커를 못 쓸 때만) — 예전과 같은 검색 두 번 · 하루마다 쉰다. */
function inlineReader(logsDb, pauseMs) {
  return {
    kind: 'inline',
    async read(vcenterId, since, until, limit) {
      const out = [];
      for (const q of ['snapshot', '스냅샷']) for (const r of await logsDb.queryAsync({ vcenterId, q, since, until }, limit)) out.push(r);
      if (pauseMs > 0) await sleep(pauseMs);
      return out;
    },
    close() {},
  };
}

async function runBackfill({ logsDb, vcenterIds, now = Date.now(), pauseMs = BACKFILL_PAUSE_MS }) {
  const db = await getSnapDb();
  if (!db || !logsDb || typeof logsDb.queryAsync !== 'function') return { done: 0 };
  const ids = [...new Set((vcenterIds || []).map(String))];
  let reader = null;
  if (logsDb.kind === 'sqlite' && typeof logsDb.file === 'string' && logsDb.file) {
    try { reader = workerReader(logsDb.file); } catch (e) { console.warn(`[veeam-snap] 백필 워커를 만들지 못했습니다 — 백필을 미룹니다: ${String(e?.message || e).slice(0, 200)}`); return { done: 0, error: 'worker' }; }
  } else reader = inlineReader(logsDb, pauseMs);
  const maybeYield = createYielder(15);
  let days = 0; let truncatedDays = 0;
  try {
    for (const limitMs of [BACKFILL_FIRST_MS, RETENTION_MS]) {
      for (const vc of ids) {
        const floor = now - limitMs;
        let from = db.coveredFrom(vc);
        if (from == null) from = now;  // 처음 — 지금부터 거꾸로
        while (from > floor) {
          await maybeYield();
          const lo = Math.max(floor, from - DAY);
          const rows = await reader.read(vc, lo, from, DAY_ROW_LIMIT * 2);
          // 넣기는 주 스레드 — 조각(2,000행)마다 양보
          for (let i = 0; i < rows.length; i += 2000) { db.ingest(rows.slice(i, i + 2000).map((r) => ({ ...r, vcenterId: vc }))); await maybeYield(); }
          if (rows.length >= DAY_ROW_LIMIT * 2) {
            truncatedDays++;
            console.warn(`[veeam-snap] ${vc} ${new Date(lo).toISOString().slice(0, 10)} 하루 스냅샷 이벤트가 ${DAY_ROW_LIMIT * 2}건을 넘어 일부만 옮겼습니다`);
          }
          db.setCoveredFrom(vc, lo, now);   // v2.761(C5): 이 백필 시작 전에 무효가 된 vCenter 는 기록하지 않는다
          _backfillStats[reader.kind]++;
          if (reader.kind === 'worker' && pauseMs > 0) await sleep(Math.min(pauseMs, WORKER_PAUSE_MS));   // 워커도 하루마다 잠깐 — CPU·디스크를 수집과 나눈다
          from = lo; days++;
        }
      }
    }
  } catch (e) {
    console.warn(`[veeam-snap] 백필 중단(다음 요청·재시작 때 이어서): ${String(e?.message || e).slice(0, 200)}`);
    return { done: days, truncatedDays, error: String(e?.message || e) };
  } finally { reader.close(); }
  return { done: days, truncatedDays };
}

/** 테스트 전용 — 핸들 닫고 상태 초기화. */
export function _resetSnapDbForTest() { try { impl?.close(); } catch { /* */ } impl = null; ready = null; unavailable = false; _backfill = null; _lock.ok(); _coverInvalid.clear(); _markerIds.clear(); _markerWarned = false; }
/** 테스트 전용 — 덮음 무효 표지 파일 경로(_resetSnapDbForTest 는 메모리 무효까지 지운다 = 재시작 — 표지만 남는다). */
export const _invalidMarkerPathForTest = () => markerPath();
/** 테스트 전용 — 잠금 재시도 대기를 끝낸다. */
export function _expireSnapLockForTest() { _lock._expire(); }
