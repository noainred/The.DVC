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
 *   snap_edge(vcenterId, json, at) — 엣지가 보낸 요약(중앙). 재시작해도 다음 push 전까지 마지막 값이 보인다.
 * 보관: 31일(RETENTION_MS) — prune 은 적재 N회마다 1회(첫 회 금지) · ts 단독 인덱스.
 * node:sqlite 가 없으면 getSnapDb() 는 null — 호출부는 예전 경로(로그 DB 검색)로 간다(기능은 같고 느릴 뿐).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { openSqlite, retryOnLock } from '../util/sqliteOpen.js';
import { createYielder } from '../util/timeSlice.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';

const DAY = 86_400_000;
export const RETENTION_MS = 31 * DAY;          // 사용자 지시: 최근 1달
export const BACKFILL_FIRST_MS = 8 * DAY;      // 백필은 이만큼을 먼저(화면 7일 + 공용 계정 짝짓기 12시간) — 그다음 31일까지 넓힌다
const DAY_ROW_LIMIT = 20_000;                  // 백필 하루 창의 검색어별 상한(넘으면 그날은 일부만 — 로그로 남긴다)
const PRUNE_EVERY = 30;

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
    const ins = db.prepare('INSERT OR IGNORE INTO snap_ev (vcenterId, ts, severity, type, user, entity, message, h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const sel = db.prepare('SELECT vcenterId, ts, severity, type, user, entity, message FROM snap_ev WHERE vcenterId=? AND ts>=? ORDER BY ts DESC LIMIT ?');
    const metaGet = db.prepare('SELECT v FROM snap_meta WHERE k=?');
    const metaSet = db.prepare('INSERT INTO snap_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    const edgeSet = db.prepare('INSERT INTO snap_edge (vcenterId, json, at) VALUES (?, ?, ?) ON CONFLICT(vcenterId) DO UPDATE SET json=excluded.json, at=excluded.at');
    const edgeAll = db.prepare('SELECT vcenterId, json, at FROM snap_edge');
    // 보관 정리는 청크(util/chunkedPrune.js — 한 방 DELETE 금지 규약) · ts 단독 인덱스를 탄다 · 동시에 하나(진행 중이면 그것을 쓴다).
    const edgeDel = db.prepare('DELETE FROM snap_edge WHERE rowid IN (SELECT rowid FROM snap_edge WHERE at < ? LIMIT ?)');
    const del = db.prepare('DELETE FROM snap_ev WHERE rowid IN (SELECT rowid FROM snap_ev WHERE ts < ? LIMIT ?)');
    const pruneFlight = createPruneFlight();
    let tick = 0;
    const api = {
      /** 스냅샷 행만 골라 한 트랜잭션으로 넣는다. 반환: 넣으려 한 행 수. */
      ingest(rows) {
        const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.vcenterId != null && Number.isFinite(Number(r.ts)) && isSnapRow(r));
        if (list.length) {
          db.exec('BEGIN');
          try {
            for (const r of list) ins.run(String(r.vcenterId), Number(r.ts), r.severity ?? null, r.type ?? null, r.user ?? null, r.entity ?? null, r.message ?? null, rowHash(r));
            db.exec('COMMIT');
          } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
        }
        if ((++tick % PRUNE_EVERY) === 0) api.prune().catch(() => {});   // 첫 회 금지(기동 직후 DELETE 스캔을 피한다)
        return list.length;
      },
      /** 그 vCenter 의 since 이후 행(최신 먼저, 상한). */
      rowsFor(vcenterId, since, limit) { return sel.all(String(vcenterId), Number(since) || 0, Math.max(1, Math.floor(limit) || 1)); },
      /** 빠짐없이 가진 가장 이른 시각(백필 진행) — 모르면 null. */
      coveredFrom(vcenterId) { const r = metaGet.get(`from:${vcenterId}`); const n = Number(r?.v); return Number.isFinite(n) && n > 0 ? n : null; },
      setCoveredFrom(vcenterId, ts) { metaSet.run(`from:${vcenterId}`, String(Math.floor(ts))); },
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

/** DB 핸들(없으면 null — node:sqlite 불가). 잠금은 몇 번 기다렸다 다시 연다(sqliteOpen 규약). */
export async function getSnapDb() {
  if (impl) return impl;
  if (unavailable) return null;
  if (!ready) {
    ready = retryOnLock(() => initSqlite(config.veeamSnap.dbPath), { tag: 'veeam-snap' })
      .catch((e) => { unavailable = true; console.warn(`[veeam-snap] 전용 DB 를 열지 못했습니다 — 로그 DB 검색으로 계산합니다(느림): ${String(e?.message || e).slice(0, 200)}`); return null; });
  }
  impl = await ready;
  return impl;
}

let _ingestWarned = 0;
/** 로그 폴러가 적재한 행 중 스냅샷 행을 넣는다(실패해도 로그 적재는 그대로 — 시간당 경고 1줄). */
export async function ingestSnapRows(rows) {
  try {
    const db = await getSnapDb();
    return db ? db.ingest(rows) : 0;
  } catch (e) {
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

async function runBackfill({ logsDb, vcenterIds, now = Date.now() }) {
  const db = await getSnapDb();
  if (!db || !logsDb || typeof logsDb.queryAsync !== 'function') return { done: 0 };
  const ids = [...new Set((vcenterIds || []).map(String))];
  const maybeYield = createYielder(15);
  let days = 0; let truncatedDays = 0;
  for (const limitMs of [BACKFILL_FIRST_MS, RETENTION_MS]) {
    for (const vc of ids) {
      const floor = now - limitMs;
      let from = db.coveredFrom(vc);
      if (from == null) from = now;  // 처음 — 지금부터 거꾸로
      while (from > floor) {
        await maybeYield();
        const lo = Math.max(floor, from - DAY);
        let n = 0;
        for (const q of ['snapshot', '스냅샷']) {
          const rows = await logsDb.queryAsync({ vcenterId: vc, q, since: lo, until: from }, DAY_ROW_LIMIT);
          n = Math.max(n, rows.length);
          db.ingest(rows.map((r) => ({ ...r, vcenterId: vc })));
        }
        if (n >= DAY_ROW_LIMIT) {
          truncatedDays++;
          console.warn(`[veeam-snap] ${vc} ${new Date(lo).toISOString().slice(0, 10)} 하루 스냅샷 이벤트가 ${DAY_ROW_LIMIT}건을 넘어 일부만 옮겼습니다`);
        }
        db.setCoveredFrom(vc, lo);
        from = lo; days++;
      }
    }
  }
  return { done: days, truncatedDays };
}

/** 테스트 전용 — 핸들 닫고 상태 초기화. */
export function _resetSnapDbForTest() { try { impl?.close(); } catch { /* */ } impl = null; ready = null; unavailable = false; _backfill = null; }
