/**
 * rack/db.js — 랙 실장도 **원장**(중앙 한 곳 · 2026-11-20 사용자 결정 '원장 위치는 중앙에 한곳').
 *
 * 계층: 법인(`datacenter/store.js` 의 DataCenter — 법인 묶음) → 데이터센터(site · 물리) → 전산실(room) → 랙(rack, 줄 이름 포함) → 배치(place).
 *   법인 하나에 데이터센터가 여럿일 수 있다(루트 CLAUDE.md 2026-11-20 규칙). 구역(zone)은 1차에 두지 않는다 — 줄 이름으로 충분한지 운영 뒤에 본다.
 * 측정값(상태 · 온도 · 전력)은 여기에 넣지 않는다 — 화면을 그릴 때 수집 모듈에서 서비스 태그로 이어 읽는다(원장 = 사람이 정한 위치만).
 *
 * 동시 편집: 전산실마다 `rev`. 랙 · 배치를 바꾸는 쓰기는 요청의 rev 가 지금 값과 같을 때만 반영하고 rev 를 올린다 — 다르면 409(조용히 덮어쓰지 않는다).
 * 쓰기는 한 트랜잭션(동기). 변경 이력(rack_log)과 법인 판(rack_version)도 같은 트랜잭션에 적는다(반쪽 저장 없음).
 *   ⚠ 판 저장 때문에 쓰기 1건이 법인 원장 전체를 읽고 · 직렬화 · 압축한다 — 실측(점검 C28, 4 vCPU 컨테이너): 장비 1,500대 법인 약 15ms ·
 *   5,000대 약 40~80ms · 20,000대 약 140~240ms 동안 이벤트 루프를 잡는다. 사람이 하는 편집 빈도라 지금은 받아들이고, 대량 가져오기(엑셀 import)는
 *   한 트랜잭션에 판 하나로 만들 것(행마다 판을 만들지 말 것).
 * 파일: `RACK_DB` 또는 `<dbDir|configDir>/rack.db`, 권한 0600. 열기 규칙은 util/sqliteOpen.js(busy_timeout 먼저 · 잠금이면 래치하지 않고 다시 연다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { openSqlite, createLockRetry, chmodDbFiles } from '../util/sqliteOpen.js';
import { createYielder } from '../util/timeSlice.js';
import { placementIssue, overflowOnResize, serialKeyOf, foldWidth, LIMITS } from './layout.js';
import { buildSnapshot, validateSnapshot, countsOf, diffSnapshots, VERSION_KEEP, capExceeded, restorableSnapshot } from './versions.js';

const lockRetry = createLockRetry();
const fileOf = () => process.env.RACK_DB || path.join(config.dbDir || config.configDir, 'rack.db');
const LOG_KEEP_PER_ROOM = 2000;   // 전산실마다 최근 이력만 남긴다(나머지는 쓰기 때 잘라 낸다 — 몇 행)

let _db = null;
let _opening = null;
let _initError = '';

export class RackError extends Error {
  constructor(status, reason, extra = {}) { super(reason); this.status = status; this.reason = reason; this.extra = extra; }
}
const fail = (status, reason, extra) => { throw new RackError(status, reason, extra); };
const newId = () => crypto.randomBytes(8).toString('hex');
/**
 * 같은 이름이 이미 있는가 — 전각 · 반각을 같은 글로 본다(6회차 정확성 D2: 새 입력은 저장 전에 접히는데 옛 값이 전각이면 'ＤＣ２' 옆에 'DC2' 가 생겼다).
 * 대소문자는 예전처럼 가른다. `rows` = 같은 범위(법인 · 데이터센터 · 전산실 · 전체)의 { id, name }.
 */
function nameTaken(rows, name, ignoreId = '') {
  const want = foldWidth(String(name ?? ''));
  return (rows || []).some((r) => r && r.id !== ignoreId && foldWidth(String(r.name ?? '')) === want);
}

export function rackDbError() { return _initError; }
/** 원장 파일 경로(주기 흡수가 '파일이 있을 때만' 돌려고 본다 — 열지 않는다). */
export const rackDbFile = () => fileOf();
/** 원장에 자료가 있는 법인 전부(지운 법인 포함). */
export async function ledgerCorpIds() {
  const db = await need();
  return db.prepare('SELECT DISTINCT corp_id AS c FROM rack_site ORDER BY corp_id').all().map((r) => r.c);
}

export async function openRackDb() {
  if (_db) return _db;
  if (lockRetry.blocked()) return null;
  if (_opening) return _opening;
  _opening = openInner().finally(() => { _opening = null; });
  return _opening;
}

async function openInner() {
  if (_db) return _db;
  let conn = null;
  const FILE = fileOf();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    conn = openSqlite(new DatabaseSync(FILE));
    try { fs.chmodSync(FILE, 0o600); chmodDbFiles(FILE); } catch { /* best effort */ }   // 0600(v2.503 S-5) — -wal/-shm 도 chmodDbFiles 가
    conn.exec(`
      CREATE TABLE IF NOT EXISTS rack_site (
        id TEXT PRIMARY KEY, corp_id TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_rack_site_corp ON rack_site(corp_id);
      CREATE TABLE IF NOT EXISTS rack_room (
        id TEXT PRIMARY KEY, site_id TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_rack_room_site ON rack_room(site_id);
      CREATE TABLE IF NOT EXISTS rack_type (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, height_u INTEGER NOT NULL, width_mm INTEGER, depth_mm INTEGER
      );
      CREATE TABLE IF NOT EXISTS rack_rack (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, name TEXT NOT NULL, row_name TEXT NOT NULL DEFAULT '',
        type_id TEXT NOT NULL DEFAULT '', height_u INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '',
        pdu_a INTEGER NOT NULL DEFAULT 0, pdu_b INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ix_rack_rack_room ON rack_rack(room_id);
      CREATE TABLE IF NOT EXISTS rack_place (
        id TEXT PRIMARY KEY, rack_id TEXT NOT NULL, face TEXT NOT NULL, u_start INTEGER NOT NULL, u_size INTEGER NOT NULL,
        kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        serial TEXT NOT NULL DEFAULT '', serial_key TEXT NOT NULL DEFAULT '', extra_serials TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '', rated_w REAL, op_w REAL, weight_kg REAL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_rack_place_rack ON rack_place(rack_id);
      DROP INDEX IF EXISTS ix_rack_place_key;
      CREATE TABLE IF NOT EXISTS rack_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user TEXT NOT NULL, corp_id TEXT NOT NULL,
        room_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS ix_rack_log_room ON rack_log(room_id, id);
      CREATE TABLE IF NOT EXISTS rack_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT, corp_id TEXT NOT NULL, ts INTEGER NOT NULL, user TEXT NOT NULL,
        action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', counts TEXT NOT NULL DEFAULT '{}', data BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_rack_version_corp ON rack_version(corp_id, id);
      CREATE TABLE IF NOT EXISTS rack_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rack_place_key (
        key TEXT NOT NULL, place_id TEXT NOT NULL, PRIMARY KEY (key, place_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ix_rack_place_key_place ON rack_place_key(place_id);
      CREATE TABLE IF NOT EXISTS rack_serial_seen (
        corp_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (corp_id, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS rack_mask_seen (
        kind TEXT NOT NULL, key TEXT NOT NULL, first_seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, key)
      ) WITHOUT ROWID;
    `);
    if (!conn.prepare('PRAGMA table_info(rack_mask_seen)').all().some((c) => c.name === 'first_seen')) conn.exec('ALTER TABLE rack_mask_seen ADD COLUMN first_seen INTEGER NOT NULL DEFAULT 0');
    // 가림 재료의 메모리 사본(`_mat`)은 핸들을 다시 열어도 버리지 않는다 — 파일보다 앞선 값(아직 못 쓴 값)이 있을 수 있다. 대기 중인 값은 새 핸들로 쓴다.
    if (_matPend.h.size + _matPend.t.size) setImmediate(() => scheduleMaskFlush());
    // 이력 · 판 글(detail)은 장비 표시 이름으로 만든다 — 그 이름에 든 시리얼을 가리려면 그 행이 말하는 장비의 시리얼을 알아야 한다(1회차 점검: 원장에서 뺀 장비의
    //   시리얼은 '지금 원장' 에 없어 옛 글에서 가려지지 않았다). 행마다 tags(JSON 배열 — 응답에 싣지 않는다)를 둔다. NULL = 이 칸이 생기기 전의 행(알 수 없음).
    for (const t of ['rack_log', 'rack_version']) {
      if (!conn.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'tags')) conn.exec(`ALTER TABLE ${t} ADD COLUMN tags TEXT`);
    }
    dropRoomFrags();   // 새 핸들 — 앞 핸들에서 읽은 조각을 믿지 않는다
    // 시리얼 키 색인(rack_place_key)은 한 번만 채운다 — 이 표가 없던 원장(업그레이드 전)에서 올라온 경우.
    // 법인별 '한 번이라도 원장에 있었던 시리얼'(rack_serial_seen)은 한 번만 채운다 — 지금 원장 + 남아 있는 판(법인마다 최대 30개)의 시리얼.
    _seenReady = false; _seenRetryAt = 0; _seenFails = 0;
    try { if (metaGet(conn, SEEN_META) !== SEEN_VER) tx(conn, () => backfillSeen(conn)); _seenReady = true; } catch (e) { console.warn('[rack-db] 시리얼 기록(가림 재료)을 채우지 못했습니다(가림 재료를 읽을 때 다시 시도):', e.message); }
    DETAIL_CACHE.clear();   // 새 핸들 — 다른 원장의 같은 (법인, 판) 키가 섞이지 않게
    _keysReady = false; _keysRetryAt = 0;
    try { if (metaGet(conn, PLACE_KEYS_META) !== PLACE_KEYS_VER) tx(conn, () => rebuildPlaceKeys(conn)); _keysReady = true; } catch (e) { console.warn('[rack-db] 시리얼 키 색인을 만들지 못했습니다(다음 조회 · 쓰기에서 다시 시도):', e.message); }
    // 판 기능 이전에 쌓인 원장 — 판이 하나도 없는 법인은 지금 모습을 '기준 판' 으로 남긴다(첫 변경 전 상태로 되돌릴 수 있게).
    try {
      const corps = conn.prepare('SELECT DISTINCT corp_id AS c FROM rack_site').all().map((r) => r.c);
      const has = conn.prepare('SELECT id FROM rack_version WHERE corp_id = ? LIMIT 1');
      const need0 = corps.filter((c) => !has.get(c));
      if (need0.length) tx(conn, () => { for (const c of need0) saveVersion(conn, c, { user: 'system', action: 'version.baseline', detail: '판 기록 시작 시점의 원장' }); });
    } catch (e) { console.warn('[rack-db] 기준 판을 만들지 못했습니다:', e.message); }
    _db = conn;
    _initError = '';
    return _db;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[rack-db] ${lockRetry.note()}`); _initError = 'locked'; return null; }
    console.error('[rack-db] 랙 실장도 원장을 열 수 없습니다:', e.message);
    _initError = 'unavailable';
    return null;
  }
}

/** 테스트 전용 — 핸들을 닫고 다음 호출이 다시 열게 한다. */
export function _closeForTest() { try { _flushMaskForTest(); } catch { /* */ } try { _db?.close(); } catch { /* */ } _db = null; _initError = ''; dropRoomFrags(); _keysReady = false; _keysRetryAt = 0; _seenReady = false; _seenRetryAt = 0; _seenFails = 0; DETAIL_CACHE.clear(); }
/** 테스트 전용 — 색인 다시 채우기의 재시도 대기를 없앤다(대기 시간을 기다리지 않고 '다음 시도' 를 보려고). */
export function _keysRetryNowForTest() { _keysRetryAt = 0; }
/** 테스트 전용 — SQL 로 원장을 직접 고친 뒤(전산실 rev 를 올리지 않는 변경) 조각 캐시와 시리얼 키 색인을 원장에 맞춘다. */
export async function _resyncForTest() { const db = await need(); dropRoomFrags(); tx(db, () => rebuildPlaceKeys(db)); _keysReady = true; }

async function need() {
  const db = await openRackDb();
  if (!db) fail(503, '랙 실장도 원장을 열 수 없습니다(잠금 또는 저장소 오류) — 잠시 뒤 다시 시도하세요.', { code: 'rackDbUnavailable' });
  return db;
}

/**
 * 한 트랜잭션. 그 안에서 새로 읽은 전산실 조각(판 재료)은 **COMMIT 이 끝난 뒤에만** 캐시에 넣는다 — ROLLBACK 된 내용이 (전산실, rev) 로 남으면
 * 다음 쓰기가 같은 rev 로 다른 내용을 만들 때 틀린 판이 저장된다(fn 은 동기라 _pending 이 다른 트랜잭션과 섞이지 않는다).
 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  const prev = _pending; const mine = new Map(); _pending = mine;
  const keysReadyAtStart = _keysReady;
  try {
    const r = fn(); db.exec('COMMIT');
    _pending = prev;
    for (const f of mine.values()) putRoomFrag(f);
    return r;
  } catch (e) {
    _pending = prev;
    // 1회차 반증 B-3: 이 트랜잭션 안에서 색인을 다시 채웠는데(keysUsable — SAVEPOINT) 쓰기가 ROLLBACK 되면 채운 색인도 사라진다 — 준비 표식을 시작 때 값으로 되돌린다.
    _keysReady = keysReadyAtStart;
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
}

const siteRow = (r) => r && ({ id: r.id, corpId: r.corp_id, name: r.name, sort: r.sort });
const roomRow = (r) => r && ({ id: r.id, siteId: r.site_id, name: r.name, sort: r.sort, rev: r.rev, updatedAt: r.updated_at });
const typeRow = (r) => r && ({ id: r.id, name: r.name, heightU: r.height_u, widthMm: r.width_mm ?? null, depthMm: r.depth_mm ?? null });
const rackRow = (r) => r && ({
  id: r.id, roomId: r.room_id, name: r.name, row: r.row_name, typeId: r.type_id, heightU: r.height_u, role: r.role,
  pduA: r.pdu_a, pduB: r.pdu_b, sort: r.sort,
});
function placeRow(r) {
  if (!r) return r;
  let extra = [];
  try { const v = JSON.parse(r.extra_serials || '[]'); if (Array.isArray(v)) extra = v.filter((x) => typeof x === 'string'); } catch { extra = []; }
  return {
    id: r.id, rackId: r.rack_id, face: r.face, uStart: r.u_start, uSize: r.u_size, kind: r.kind, label: r.label, model: r.model,
    serial: r.serial, serialKey: r.serial_key, extraSerials: extra, note: r.note,
    ratedW: r.rated_w ?? null, opW: r.op_w ?? null, weightKg: r.weight_kg ?? null, updatedAt: r.updated_at,
  };
}

// ───────────────────────── 판(법인별 스냅샷 · 최근 VERSION_KEEP 개) ─────────────────────────

/** 한 법인 원장의 지금 모습(판 재료). 같은 트랜잭션 안에서 부른다. */
function corpRows(db, corpId) {
  const sites = db.prepare('SELECT * FROM rack_site WHERE corp_id = ?').all(corpId).map(siteRow);
  const rooms = db.prepare('SELECT m.* FROM rack_room m JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?').all(corpId).map(roomRow);
  const racks = db.prepare('SELECT r.* FROM rack_rack r JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?').all(corpId).map(rackRow);
  const places = db.prepare(`SELECT p.* FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id JOIN rack_room m ON m.id = r.room_id
    JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?`).all(corpId).map(placeRow);
  return { sites, rooms, racks, places };
}
/**
 * 전산실 조각 캐시(개선 1 — 2026-11-26 사용자 요청): 판 하나는 법인 원장 전체라 쓰기 1건마다 법인의 랙 · 장비를 전부 읽었다(장비 5,000대 법인 약 22ms).
 * 랙 · 장비를 바꾸는 쓰기는 반드시 그 전산실 rev 를 올리므로(roomWrite · 되돌리기), (전산실 id, rev) 가 같으면 그 전산실의 랙 · 장비 행은 같다 —
 * 바뀐 전산실만 다시 읽고 나머지는 앞에 읽은 행을 쓴다. 판 모양은 예전과 같은 `buildSnapshot` 하나가 만든다(행이 같으면 글자도 같다).
 *  · 캐시는 핸들 수명 — 열 때 · 닫을 때 비운다 · COMMIT 된 내용만 넣는다(tx) · 장비 수 합이 상한을 넘으면 오래된 전산실부터 버린다.
 *  · ⚠ 전산실 rev 를 올리지 않고 랙 · 장비를 바꾸는 코드를 만들지 말 것(이 캐시와 편집 화면의 충돌 판정이 함께 틀린다). 자기 점검: RACK_SELF_CHECK=1.
 */
const ROOM_FRAG = new Map();            // roomId → { roomId, rev, racks: rackRow[], places: placeRow[] }
const FRAG_MAX_PLACES = 200_000;        // 캐시에 두는 장비 행 수 상한(전 법인 합)
let _fragPlaces = 0;
let _pending = null;                    // 트랜잭션 안에서 새로 읽은 조각(roomId → 조각) — COMMIT 뒤에 캐시로
const SELF_CHECK = () => process.env.RACK_SELF_CHECK === '1';
function dropRoomFrags() { ROOM_FRAG.clear(); _fragPlaces = 0; }
function putRoomFrag(f) {
  const old = ROOM_FRAG.get(f.roomId);
  if (old) { _fragPlaces -= old.places.length; ROOM_FRAG.delete(f.roomId); }
  ROOM_FRAG.set(f.roomId, f); _fragPlaces += f.places.length;
  for (const [id, x] of ROOM_FRAG) {   // 오래 안 바뀐 전산실부터(넣은 순서)
    if (_fragPlaces <= FRAG_MAX_PLACES || id === f.roomId) break;
    ROOM_FRAG.delete(id); _fragPlaces -= x.places.length;
  }
}
function roomFrag(db, roomId, rev) {
  const hit = _pending?.get(roomId) || ROOM_FRAG.get(roomId);
  if (hit && hit.rev === rev) return hit;
  const f = {
    roomId, rev,
    racks: db.prepare('SELECT * FROM rack_rack WHERE room_id = ?').all(roomId).map(rackRow),
    places: db.prepare('SELECT p.* FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id WHERE r.room_id = ?').all(roomId).map(placeRow),
  };
  if (_pending) _pending.set(roomId, f); else putRoomFrag(f);   // 트랜잭션 밖(읽기 경로)에서 읽은 것은 이미 확정된 내용
  return f;
}
/** corpRows 와 같은 결과 — 바뀌지 않은 전산실은 조각 캐시에서. */
function corpRowsFast(db, corpId) {
  const sites = db.prepare('SELECT * FROM rack_site WHERE corp_id = ?').all(corpId).map(siteRow);
  const rooms = db.prepare('SELECT m.* FROM rack_room m JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?').all(corpId).map(roomRow);
  const racks = []; const places = [];
  for (const m of rooms) {
    const f = roomFrag(db, m.id, m.rev);
    for (const r of f.racks) racks.push(r);
    for (const p of f.places) places.push(p);
  }
  return { sites, rooms, racks, places };
}
/** 법인 원장의 지금 모습을 판으로. 자기 점검 모드면 캐시 없이 만든 판과 글자까지 대조한다(다르면 던진다 — 테스트가 켠다). */
function currentSnapshot(db, corpId) {
  const snap = buildSnapshot(corpId, corpRowsFast(db, corpId));
  if (SELF_CHECK() && JSON.stringify(snap) !== JSON.stringify(buildSnapshot(corpId, corpRows(db, corpId)))) {
    throw new Error('[rack-db] 자기 점검: 전산실 조각 캐시로 만든 판이 원장과 다릅니다');
  }
  return snap;
}
// gzip 1단계(개선 1): 판 30개 × 법인이라 크기보다 쓰기마다 걸리는 시간이 문제다 — 6단계 대비 압축 시간이 절반쯤이고 크기는 조금 는다(실측은 rack/CLAUDE.md).
const packSnap = (snap) => zlib.gzipSync(Buffer.from(JSON.stringify(snap)), { level: 1 });
/** 판 하나를 풀 때 허용하는 최대 크기(반증 L-1 — 압축 해제에는 예외 없이 maxOutputLength · docs/rules/security-api.md). 장비 50만 대 판도 이 안이다(추정). */
export const SNAP_MAX_BYTES = 256 * 1024 * 1024;
function unpackSnap(blob, corpId) {
  let raw;
  try { raw = zlib.gunzipSync(Buffer.from(blob), { maxOutputLength: SNAP_MAX_BYTES }); } catch (e) {
    console.warn(`[rack-db] 판을 풀지 못했습니다(${e?.code || '손상'}) — 법인 ${String(corpId).slice(0, 64)}`); return null;
  }
  let obj;
  try { obj = JSON.parse(raw.toString('utf8')); } catch { console.warn(`[rack-db] 판 JSON 을 읽지 못했습니다 — 법인 ${String(corpId).slice(0, 64)}`); return null; }
  const v = validateSnapshot(obj, corpId);
  if (!v) console.warn(`[rack-db] 판 모양이 맞지 않습니다(형식 · 참조 · 크기) — 법인 ${String(corpId).slice(0, 64)}`);
  return v;
}

/**
 * 반증 L-4: 판이 하나도 없는 법인이면 **변경 전** 지금 모습을 기준 판으로 남긴다 — 열 때 만든 기준 판이 실패했어도 첫 변경 전에 다시 만든다.
 * 쓰기 트랜잭션 안에서 변경보다 먼저 부른다(원장이 비어 있으면 남길 것이 없다).
 */
function ensureBaseline(db, corpId) {
  if (!corpId) return;
  if (db.prepare('SELECT id FROM rack_version WHERE corp_id = ? LIMIT 1').get(corpId)) return;
  if (!db.prepare('SELECT id FROM rack_site WHERE corp_id = ? LIMIT 1').get(corpId)) return;
  saveVersion(db, corpId, { user: 'system', action: 'version.baseline', detail: '판 기록 시작 시점의 원장' });
}

/** 반증 L-2: 전역 rev 바닥값 — 지워진 전산실의 rev 를 기억해 되살아난 전산실이 옛 rev 를 다시 받지 않게 한다. */
const metaGet = (db, k) => db.prepare('SELECT v FROM rack_meta WHERE k = ?').get(k)?.v ?? 0;
function bumpRevFloor(db, rev) {
  const cur = metaGet(db, 'revFloor');
  if (Number.isInteger(rev) && rev > cur) db.prepare('INSERT INTO rack_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('revFloor', rev);
}

/**
 * 변경 직후 법인 원장을 판 하나로 남기고, 그 법인의 판을 최근 VERSION_KEEP 개로 자른다(같은 트랜잭션 — 변경과 판이 함께 저장되거나 함께 취소).
 * 오래된 판은 지운다(2026-11-20 사용자 선택 '지운다' — 감사 로그에는 남는다).
 */
const CAP_LABEL = { sites: '데이터센터', rooms: '전산실', racks: '랙', places: '장비' };
function saveVersion(db, corpId, { user, action, detail, tags = [] }) {
  const snap = currentSnapshot(db, corpId);
  // 점검 C8: 판으로 되살릴 수 없는 크기가 되는 변경은 받지 않는다(같은 트랜잭션이라 변경도 취소된다 — 판 검사와 같은 상한).
  const over = capExceeded(countsOf(snap));
  if (over) fail(409, `이 법인의 ${CAP_LABEL[over]} 수가 상한을 넘어 저장하지 않았습니다(판으로 되돌릴 수 있는 크기까지만).`, { code: 'corpCap' });
  db.prepare('INSERT INTO rack_version (corp_id,ts,user,action,detail,counts,data,tags) VALUES (?,?,?,?,?,?,?,?)')
    .run(corpId, Date.now(), String(user || '').slice(0, 64), action, String(detail || '').slice(0, 500), JSON.stringify(countsOf(snap)), packSnap(snap), tagsJson(tags));
  const cut = db.prepare('SELECT id FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(corpId, VERSION_KEEP);
  if (cut) db.prepare('DELETE FROM rack_version WHERE corp_id = ? AND id <= ?').run(corpId, cut.id);
}

/** 행의 tags 칸에 넣을 글 — 그 글(detail)이 말하는 장비의 시리얼 원문(주 + 추가 · 중복 제거 · 상한). */
const tagsJson = (tags) => JSON.stringify([...new Set((tags || []).filter((t) => typeof t === 'string' && t))].slice(0, 64));
const serialsOf = (...ps) => ps.flatMap((p) => (p ? [p.serial, ...(p.extraSerials || [])] : [])).filter(Boolean);
export const LEGACY_DETAIL_HIDDEN = '(옛 기록 — 장비 이름은 이 계정에 보이지 않습니다)';
/** 행의 tags 칸 → 시리얼 원문 배열. NULL(이 칸이 생기기 전의 행) · 깨진 값은 **null**('어떤 시리얼이 들었는지 모른다' — 가림 함수가 통째로 가린다). */
function rowTags(v) {
  if (v == null) return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : null; } catch { return null; }
}

function log(db, { user, corpId, roomId = '', action, detail = '', version = true, tags = [] }) {
  if (version && corpId) saveVersion(db, corpId, { user, action, detail, tags });
  db.prepare('INSERT INTO rack_log (ts,user,corp_id,room_id,action,detail,tags) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), String(user || '').slice(0, 64), corpId, roomId, action, String(detail).slice(0, 500), tagsJson(tags));
  if (!roomId && corpId) {
    // 점검 C12: 전산실이 없는 이력(데이터센터 추가 · 이름 · 삭제, 전산실 삭제)도 법인마다 같은 수만 남긴다(예전엔 끝없이 쌓였다).
    const cut = db.prepare("SELECT id FROM rack_log WHERE room_id = '' AND corp_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(corpId, LOG_KEEP_PER_ROOM);
    if (cut) db.prepare("DELETE FROM rack_log WHERE room_id = '' AND corp_id = ? AND id <= ?").run(corpId, cut.id);
  }
  if (roomId) {
    // 그 전산실의 오래된 이력 정리(몇 행) — 경계 id 를 먼저 구해 지운다(집계 함수 하나 · 같은 트랜잭션).
    const cut = db.prepare('SELECT id FROM rack_log WHERE room_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(roomId, LOG_KEEP_PER_ROOM);
    if (cut) db.prepare('DELETE FROM rack_log WHERE room_id = ? AND id <= ?').run(roomId, cut.id);
  }
}

// ───────────────────────── 조회 ─────────────────────────

/** 법인들의 데이터센터 · 전산실 목록(+ 랙 · 배치 수). corpIds 가 null 이면 전체. */
export async function listTree(corpIds = null) {
  const db = await need();
  const sites = db.prepare('SELECT * FROM rack_site ORDER BY sort, name').all().map(siteRow)
    .filter((s) => !corpIds || corpIds.has(s.corpId));
  const siteIds = new Set(sites.map((s) => s.id));
  const rooms = db.prepare('SELECT * FROM rack_room ORDER BY sort, name').all().map(roomRow).filter((r) => siteIds.has(r.siteId));
  const rackCount = new Map(db.prepare('SELECT room_id AS k, COUNT(*) AS n FROM rack_rack GROUP BY room_id').all().map((r) => [r.k, r.n]));
  const placeCount = new Map(db.prepare('SELECT r.room_id AS k, COUNT(*) AS n FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id GROUP BY r.room_id').all().map((r) => [r.k, r.n]));
  return {
    sites,
    rooms: rooms.map((r) => ({ ...r, racks: rackCount.get(r.id) || 0, places: placeCount.get(r.id) || 0 })),
  };
}

export async function listTypes() {
  const db = await need();
  return db.prepare('SELECT * FROM rack_type ORDER BY height_u, name').all().map(typeRow);
}

/** 전산실 하나 — 소속(데이터센터 · 법인) · 랙 · 배치 · 최근 이력. 없으면 null. */
/**
 * @param {object} [o]
 * @param {(detail:string, tags:string[]|null, action:string)=>string} [o.maskRow] 비관리자 판본의 이력 글 가림(routes/api/rack.js textMaskOf.row) —
 *   행의 tags(그 글이 말하는 장비의 시리얼 원문 · 모르면 null)를 여기서 넘겨주고 **tags 자체는 돌려주지 않는다**.
 */
export async function getRoom(roomId, { logLimit = 100, maskRow = null } = {}) {
  const db = await need();
  const room = roomRow(db.prepare('SELECT * FROM rack_room WHERE id = ?').get(String(roomId || '')));
  if (!room) return null;
  const site = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(room.siteId));
  if (!site) return null;
  const racks = db.prepare('SELECT * FROM rack_rack WHERE room_id = ? ORDER BY sort, row_name, name').all(room.id).map(rackRow);
  const places = db.prepare('SELECT p.* FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id WHERE r.room_id = ? ORDER BY p.rack_id, p.u_start DESC').all(room.id).map(placeRow);
  // tags 는 가림에만 쓰고 돌려주지 않는다(시리얼 원문이다).
  const logs = db.prepare('SELECT ts, user, action, detail, tags FROM rack_log WHERE room_id = ? ORDER BY id DESC LIMIT ?').all(room.id, Math.max(1, Math.min(500, logLimit)))
    .map((r) => ({ ts: r.ts, user: r.user, action: r.action, detail: maskRow ? maskRow(r.detail, rowTags(r.tags), r.action) : r.detail }));
  return { room, site, racks, places, logs };
}

/** 소속 법인 찾기(쓰기 판정용) — 전산실 · 데이터센터 · 랙 · 배치 id 어느 것으로든. 없으면 null. */
export async function corpOf(kind, id) {
  const db = await need();
  const q = {
    site: 'SELECT s.corp_id AS c, NULL AS room FROM rack_site s WHERE s.id = ?',
    room: 'SELECT s.corp_id AS c, m.id AS room FROM rack_room m JOIN rack_site s ON s.id = m.site_id WHERE m.id = ?',
    rack: 'SELECT s.corp_id AS c, m.id AS room FROM rack_rack r JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE r.id = ?',
    place: 'SELECT s.corp_id AS c, m.id AS room FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE p.id = ?',
  }[kind];
  if (!q) return null;
  const r = db.prepare(q).get(String(id || ''));
  return r ? { corpId: r.c, roomId: r.room || '' } : null;
}

/** 한 법인 원장에 이미 놓인 시리얼 키(미배치 계산용). */
/** 그 법인의 시리얼 가림 재료 — 지금 원장의 시리얼 원문(주 + 추가) + 한 번이라도 원장에 있었던 시리얼의 비교 키. 시리얼을 가리는 판본의 글자 가림(textMask.js)에만 쓴다. 응답에 싣지 말 것. */
export async function corpSerials(corpId) {
  const db = await need();
  const out = [];
  for (const r of db.prepare(`SELECT p.serial AS s, p.extra_serials AS x FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id
    JOIN rack_room m ON m.id = r.room_id JOIN rack_site t ON t.id = m.site_id WHERE t.corp_id = ? AND (p.serial <> '' OR p.extra_serials <> '[]')`).all(String(corpId || ''))) {
    if (r.s) out.push(r.s);
    try { for (const x of JSON.parse(r.x || '[]')) if (typeof x === 'string' && x) out.push(x); } catch { /* */ }
  }
  // + 한 번이라도 이 법인 원장에 있었던 시리얼의 비교 키(뺀 장비 · 나중에 넣은 시리얼의 옛 글까지 가리려고 — rack_serial_seen)
  if (!_seenReady && Date.now() >= _seenRetryAt) {   // 열 때 채우지 못했으면 여기서 다시
    // 실패가 이어지면 간격을 두 배씩 늘린다(30초 → 1분 → … 최대 16분): 채우기는 판 전부를 풀어 읽은 **뒤에야** 쓰기에서 실패하므로(디스크 가득 등),
    //   고정 30초면 그동안 범위 계정 조회 한 건이 30초마다 그 비용을 통째로 치른다(4회차 점검 성능 1 — 장비 5,600대 · 판 420개에서 재시도 1회 0.4~0.5초 실측).
    try { tx(db, () => backfillSeen(db)); _seenReady = true; _seenFails = 0; } catch (e) {
      const wait = KEYS_RETRY_MS * 2 ** Math.min(_seenFails, SEEN_RETRY_MAX_DOUBLINGS); _seenFails += 1;
      _seenRetryAt = Date.now() + wait;
      console.warn(`[rack-db] 시리얼 기록(가림 재료)을 채우지 못했습니다 — ${Math.round(wait / 1000)}초 뒤 다시 시도합니다:`, e.message);
    }
  }
  for (const r of db.prepare('SELECT key FROM rack_serial_seen WHERE corp_id = ?').all(String(corpId || ''))) out.push(r.key);
  return out;
}

// ── 가림 재료 기록(2026-11-27 — 설계 docs/design/rack-mask-redesign J4 '재료는 줄지 않는다') ──
//   가림 재료(등록 서버의 관리 주소 · 서비스 태그)는 등록부에서 모은다. 엣지가 올린 서버 목록은 메모리에만 있어(`collector/remoteInventory.js`)
//   중앙을 다시 띄운 직후 · 수집 서버를 끈 뒤에는 비어 있고, 그동안 그 서버들의 주소 · 태그가 든 이름이 조회 계정에 원문으로 나갔다(반증 재현).
//   한 번이라도 본 재료를 원장 옆에 남기고(rack_mask_seen — kind 'h' 주소 · 't' 태그) 가림은 **이 기록** 으로 만든다(흡수한 '지금 값' 이 곧 기록에 든다).
//   지운 서버의 주소도 남는다(의도 — 가림이 풀리지 않게). 잘못 들어간 값은 전체 범위 관리자가 지운다(`maskForget` — 감사 · 6회차 반증 R1).
//   ⓐ 메모리 사본이 진실이고 파일은 뒤따른다 — 흡수는 사본에 바로 넣고(그 요청부터 가린다) 파일 쓰기는 응답 뒤에 모아서(`flushMask` · 잠금을 기다리지 않는다 ·
//      실패하면 30초부터 두 배씩 최대 16분 뒤 다시 — 6회차 성능 3: 읽기 요청이 30초마다 3초씩 잠금을 기다렸다).
//   ⓑ 세대(`maskState().gen`): 사본이 바뀔 때만 오른다 — 가림 색인은 세대마다 한 번 만든다(`rack/material.js` · 6회차 성능 1: 요청마다 기록 전체로 색인을 다시 만들어
//      기록 20만에서 요청 하나가 3~17초였다).
//   ⓒ 닫힌 쪽 실패: 기록을 못 읽으면 던진다(`MaskUnavailable`) — 조회 계정 요청은 503(6회차 보안 2: 읽기 오류 하나로 가림이 조용히 풀렸다).
//   ⓓ 상한: 종류마다 기록 `MASK_SEEN_MAX`. 넘은 '지금 값' 과 너무 긴 값은 파일에 쓰지 않고 메모리(`over` · `MASK_OVER_MAX`)에만 둔다 — 그동안은 가린다.
//   값은 `rack/material.js` 가 정리해 넘긴 글 그대로. **응답에 싣지 말 것**(관리 화면 `maskSeenRows` 는 전체 범위 관리자만).
const MASK_SEEN_MAX = 200_000;
const MASK_OVER_MAX = 50_000;
const MASK_KEY_MAX = Object.freeze({ h: 255, t: 64 });
const MASK_FLUSH_CHUNK = 2000;                 // 파일 쓰기 한 번(한 트랜잭션)에 넣는 행 — 사이마다 양보
const MASK_KINDS = Object.freeze(['h', 't']);
export class MaskUnavailable extends Error {}
let _mat = null;                               // { h:Set, t:Set, over:{h:Set,t:Set} } — 이 프로세스의 사본(핸들을 다시 열어도 유지 — 파일보다 앞설 수 있다)
let _matGen = 0;
let _matLoading = null;
let _matLoadFailAt = 0;
const _matPend = { h: new Map(), t: new Map() };   // 값 → 처음 본 시각(아직 파일에 쓰지 못한 것)
let _matFlushTimer = null;
let _matFlushFails = 0;
let _matCapWarned = false;
/** 잘라 낸 부분 문자열이 원문(엣지가 보낸 큰 글)을 붙들지 않게 새 글로 만든다(6회차 성능 4 — V8 의 잘린 문자열은 원문을 쥔다). */
const ownStr = (s) => JSON.parse(JSON.stringify(s));

/** 기록을 메모리로 읽는다(조각마다 양보 · 진행 중인 읽기는 함께 기다린다). 실패하면 `MaskUnavailable`(5초 동안은 다시 읽지 않고 바로 던진다). */
async function maskLoad() {
  if (_mat) return _mat;
  if (_matLoading) return _matLoading;
  if (Date.now() - _matLoadFailAt < 5000) throw new MaskUnavailable('가림 재료 기록을 읽지 못했습니다(잠시 뒤 다시 시도합니다).');
  _matLoading = (async () => {
    const db = await need();
    const m = { h: new Set(), t: new Set(), over: { h: new Set(), t: new Set() } };
    const pause = createYielder(15);
    try {
      const page = db.prepare('SELECT kind, key FROM rack_mask_seen WHERE kind > ? OR (kind = ? AND key > ?) ORDER BY kind, key LIMIT 5000');
      let lk = ''; let lv = '';
      for (;;) {
        const rows = page.all(lk, lk, lv);
        for (const r of rows) m[r.kind]?.add(r.key);
        if (rows.length < 5000) break;
        lk = rows[rows.length - 1].kind; lv = rows[rows.length - 1].key;
        await pause();
      }
    } catch (e) {
      _matLoadFailAt = Date.now();
      console.warn('[rack-db] 가림 재료 기록을 읽지 못했습니다 — 조회 계정 요청은 503 으로 답합니다:', e.message);
      throw new MaskUnavailable('가림 재료 기록을 읽지 못했습니다.');
    }
    // 읽는 사이에 다른 길로 사본이 생겼으면(그럴 수 없지만) 합친다 · 아직 파일에 쓰지 못한 값도 사본에
    for (const k of MASK_KINDS) for (const v of _matPend[k].keys()) m[k].add(v);
    _mat = m; _matGen += 1;
    return m;
  })().finally(() => { _matLoading = null; });
  return _matLoading;
}

/** 지금 사본(세대 · 값). 값은 **같은 Set 을** 돌려준다 — 고치지 말 것(색인을 만드는 쪽은 배열로 베껴 쓴다). */
export async function maskState() {
  const m = await maskLoad();
  return { gen: _matGen, hosts: m.h, tags: m.t, overHosts: m.over.h, overTags: m.over.t };
}

/**
 * 지금 재료를 사본에 더한다(새 값만 · 그 요청부터 가린다) — 파일 쓰기는 응답 뒤로 미룬다. 돌려주는 값 = 세대.
 * @param {string[]} hosts  등록 주소(정리된 글)   @param {string[]} tags  서비스 태그(정리된 글)
 */
export async function maskAbsorb(hosts = [], tags = [], { now = Date.now() } = {}) {
  const m = await maskLoad();
  let changed = false;
  const lists = { h: hosts, t: tags };
  for (const k of MASK_KINDS) {
    for (const v0 of lists[k] || []) {
      if (typeof v0 !== 'string' || !v0 || m[k].has(v0) || m.over[k].has(v0)) continue;
      const v = ownStr(v0);
      if (v.length > MASK_KEY_MAX[k] || m[k].size >= MASK_SEEN_MAX) {
        if (m[k].size >= MASK_SEEN_MAX && !_matCapWarned) {
          _matCapWarned = true;
          console.warn(`[rack-db] 가림 재료 기록이 상한(${MASK_SEEN_MAX})에 닿았습니다 — 새 값은 파일에 남기지 않고 메모리에만 둡니다(다시 띄우면 그 값은 지금 등록부에 있을 때만 가립니다). 가림 집계 화면에서 지금 등록부에 없는 기록을 정리하세요.`);
        }
        if (m.over[k].size >= MASK_OVER_MAX) m.over[k].clear();   // 메모리 상한 — 넘치면 비우고 지금 값부터 다시(넘치는 고장은 위 경고가 이미 알렸다)
        m.over[k].add(v);
      } else {
        m[k].add(v); _matPend[k].set(v, now);
      }
      changed = true;
    }
  }
  if (changed) { _matGen += 1; scheduleMaskFlush(); }
  return _matGen;
}

function scheduleMaskFlush(delayMs = 0) {
  if (_matFlushTimer) return;
  const t = delayMs > 0 ? setTimeout(flushMask, delayMs) : setImmediate(flushMask);
  if (delayMs > 0) t.unref?.();
  _matFlushTimer = t;
}
/** 아직 파일에 쓰지 못한 값을 쓴다(잠금을 기다리지 않는다 — 다른 연결이 잡고 있으면 바로 실패하고 나중에 다시). 동기 · 조각 하나. */
function flushMask() {
  _matFlushTimer = null;
  const db = _db;
  const total = _matPend.h.size + _matPend.t.size;
  if (!db || !total) return;
  const batch = [];
  for (const k of MASK_KINDS) for (const [v, at] of _matPend[k]) { if (batch.length >= MASK_FLUSH_CHUNK) break; batch.push([k, v, at]); }
  let prevBusy = null;
  try {
    try { prevBusy = db.prepare('PRAGMA busy_timeout').get()?.timeout ?? null; } catch { prevBusy = null; }
    db.exec('PRAGMA busy_timeout = 0');
    try {
      tx(db, () => {
        const ins = db.prepare('INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES (?, ?, ?)');
        for (const [k, v, at] of batch) ins.run(k, v, at);
      });
    } finally { if (prevBusy != null) { try { db.exec(`PRAGMA busy_timeout = ${Number(prevBusy) | 0}`); } catch { /* */ } } }
    for (const [k, v] of batch) _matPend[k].delete(v);
    _matFlushFails = 0;
    if (_matPend.h.size + _matPend.t.size) scheduleMaskFlush();   // 남은 조각은 다음 틱에
  } catch (e) {
    const wait = KEYS_RETRY_MS * 2 ** Math.min(_matFlushFails, SEEN_RETRY_MAX_DOUBLINGS); _matFlushFails += 1;
    console.warn(`[rack-db] 가림 재료를 파일에 남기지 못했습니다(${total}건 대기 — 메모리에서는 가립니다) — ${Math.round(wait / 1000)}초 뒤 다시 시도합니다:`, e.message);
    scheduleMaskFlush(wait);
  }
}
/** 테스트 전용 — 대기 중인 기록을 지금 파일에 쓴다(다시 열기 전에). */
export function _flushMaskForTest() { if (_matFlushTimer) { clearTimeout(_matFlushTimer); clearImmediate(_matFlushTimer); _matFlushTimer = null; } for (let i = 0; i < 200 && _matPend.h.size + _matPend.t.size; i += 1) flushMask(); }
/** 테스트 전용 — 프로세스를 다시 띄운 것처럼 메모리 사본을 버린다(파일의 기록만 남는다). */
export function _dropMaskMemoryForTest() { _flushMaskForTest(); _mat = null; _matLoadFailAt = 0; _matCapWarned = false; _matFlushFails = 0; }

/** 기록 수(메모리 사본 — 파일에 아직 쓰지 못한 값 포함) · 파일에 쓰지 못한 수 · 메모리에만 둔 수. */
export async function maskSeenCounts() {
  const m = await maskLoad();
  return { hosts: m.h.size, tags: m.t.size, pending: _matPend.h.size + _matPend.t.size, overflow: m.over.h.size + m.over.t.size, max: MASK_SEEN_MAX };
}

/** 관리 화면용 — 파일의 기록 행 전부(종류 · 값 · 처음 본 시각). 조각마다 양보. **전체 범위 관리자 라우트만** 부른다. */
export async function maskSeenRows() {
  const db = await need();
  const pause = createYielder(15);
  const out = [];
  const page = db.prepare('SELECT kind, key, first_seen FROM rack_mask_seen WHERE kind > ? OR (kind = ? AND key > ?) ORDER BY kind, key LIMIT 5000');
  let lk = ''; let lv = '';
  for (;;) {
    const rows = page.all(lk, lk, lv);
    for (const r of rows) out.push({ kind: r.kind, key: r.key, firstSeen: r.first_seen || null });
    if (rows.length < 5000) break;
    lk = rows[rows.length - 1].kind; lv = rows[rows.length - 1].key;
    await pause();
  }
  for (const k of MASK_KINDS) for (const [v, at] of _matPend[k]) out.push({ kind: k, key: v, firstSeen: at, pending: true });
  return out;
}

/** 기록에서 지운다(전체 범위 관리자 · 감사는 라우트가). 사본 · 대기 · 파일에서 함께. 돌려주는 값 = 지운 수. */
export async function maskForget(items = []) {
  const db = await need();
  const m = await maskLoad();
  const list = (items || []).filter((x) => x && MASK_KINDS.includes(x.kind) && typeof x.key === 'string' && x.key);
  let removed = 0;
  tx(db, () => {
    const del = db.prepare('DELETE FROM rack_mask_seen WHERE kind = ? AND key = ?');
    for (const { kind, key } of list) del.run(kind, key);
  });
  for (const { kind, key } of list) {
    const had = m[kind].delete(key) | m.over[kind].delete(key) | _matPend[kind].delete(key);
    if (had) removed += 1;
  }
  if (removed) _matGen += 1;
  return removed;
}

/**
 * 그 법인 원장의 자유 글(가림 집계용 — `routes/api/rack.js` 의 관리자 전용 집계만 쓴다 · 응답에 그대로 싣는 곳은 그 라우트뿐).
 * 조회 계정에 보이는 칸(표시 이름 · 모델 · 랙의 이름 · 줄 · 용도 · 전산실 · 데이터센터 이름)을 칸 이름 · 위치 · 그 장비의 시리얼과 함께. 메모는 건수만.
 */
export async function corpTexts(corpId, { pause = null } = {}) {
  const db = await need();
  const cid = String(corpId || '');
  const sites = db.prepare('SELECT * FROM rack_site WHERE corp_id = ?').all(cid).map(siteRow);
  const rooms = db.prepare('SELECT m.* FROM rack_room m JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?').all(cid).map(roomRow);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const texts = [];
  const push = (field, text, where, own = []) => { if (typeof text === 'string' && text) texts.push({ field, text, where, own }); };
  for (const s of sites) push('siteName', s.name, s.name);
  let notes = 0; let placeN = 0; let rackN = 0;
  const qRacks = db.prepare('SELECT * FROM rack_rack WHERE room_id = ?');
  const qPlaces = db.prepare('SELECT p.* FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id WHERE r.room_id = ?');
  // 전산실마다 읽고 양보한다(6회차 성능 5: 법인 하나를 통째로 읽으면 장비 5만 대 법인에서 0.4초 · 집계 전체 최대 정지 1초 넘음).
  for (const r of rooms) {
    const roomWhere = `${siteName.get(r.siteId) || ''} › ${r.name}`;
    push('roomName', r.name, roomWhere);
    const racks = qRacks.all(r.id).map(rackRow);
    const rackWhere = new Map(racks.map((k) => [k.id, `${roomWhere} › ${k.name}`]));
    for (const k of racks) { const w = rackWhere.get(k.id); push('rackName', k.name, w); push('rackRow', k.row, w); push('rackRole', k.role, w); }
    rackN += racks.length;
    for (const p of qPlaces.all(r.id).map(placeRow)) {
      const w = `${rackWhere.get(p.rackId) || ''} U${p.uStart}`;
      const own = [p.serial, ...(p.extraSerials || [])].filter(Boolean);
      push('label', p.label, w, own); push('model', p.model, w, own);
      if (p.note) notes += 1;
      placeN += 1;
    }
    if (pause) await pause();
  }
  return { texts, notes, places: placeN, racks: rackN };
}

export async function placedSerialKeys(corpId) {
  const db = await need();
  const out = new Set();
  if (!keysUsable(db, false)) {   // 색인을 못 쓰면 원장에서 직접
    for (const r of db.prepare(`SELECT p.serial AS serial, p.extra_serials AS extra_serials FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id
      JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?`).all(String(corpId || ''))) for (const k of keysOf(placeRow({ ...r, serial_key: '' }))) out.add(k);
    return out;
  }
  for (const r of db.prepare(`SELECT k.key AS k FROM rack_place_key k JOIN rack_place p ON p.id = k.place_id JOIN rack_rack r ON r.id = p.rack_id
    JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?`).all(String(corpId || ''))) out.add(r.k);
  return out;
}

// ───────────────────────── 쓰기 ─────────────────────────

export async function addSite({ corpId, name, user }) {
  const db = await need();
  return tx(db, () => {
    ensureBaseline(db, corpId);
    if (nameTaken(db.prepare('SELECT id, name FROM rack_site WHERE corp_id = ?').all(corpId), name)) fail(409, '같은 이름의 데이터센터가 이 법인에 이미 있습니다.');
    const id = newId();
    const sort = (db.prepare('SELECT MAX(sort) AS m FROM rack_site WHERE corp_id = ?').get(corpId)?.m ?? -1) + 1;
    db.prepare('INSERT INTO rack_site (id,corp_id,name,sort,created_at) VALUES (?,?,?,?,?)').run(id, corpId, name, sort, Date.now());
    log(db, { user, corpId, action: 'site.add', detail: name });
    return { id };
  });
}

export async function renameSite({ id, name, user }) {
  const db = await need();
  return tx(db, () => {
    const s = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(id));
    if (!s) fail(404, '데이터센터를 찾지 못했습니다.');
    if (name === s.name) return { id, unchanged: true };   // 같은 이름 — 판 · 이력(기준 판 포함)을 만들지 않는다
    ensureBaseline(db, s.corpId);
    if (nameTaken(db.prepare('SELECT id, name FROM rack_site WHERE corp_id = ?').all(s.corpId), name, id)) fail(409, '같은 이름의 데이터센터가 이 법인에 이미 있습니다.');
    db.prepare('UPDATE rack_site SET name = ? WHERE id = ?').run(name, id);
    log(db, { user, corpId: s.corpId, action: 'site.rename', detail: `${s.name} → ${name}` });
    return { id };
  });
}

/** 데이터센터 삭제 — 전산실이 남아 있으면 거절(아래 자료를 조용히 지우지 않는다). */
export async function removeSite({ id, user }) {
  const db = await need();
  return tx(db, () => {
    const s = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(id));
    if (!s) fail(404, '데이터센터를 찾지 못했습니다.');
    ensureBaseline(db, s.corpId);
    const n = db.prepare('SELECT COUNT(*) AS n FROM rack_room WHERE site_id = ?').get(id).n;
    if (n) fail(409, `전산실 ${n}곳이 남아 있어 지울 수 없습니다 — 전산실을 먼저 지우세요.`);
    db.prepare('DELETE FROM rack_site WHERE id = ?').run(id);
    log(db, { user, corpId: s.corpId, action: 'site.remove', detail: s.name });
    return { id };
  });
}

export async function addRoom({ siteId, name, user }) {
  const db = await need();
  return tx(db, () => {
    const s = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(siteId));
    if (!s) fail(404, '데이터센터를 찾지 못했습니다.');
    ensureBaseline(db, s.corpId);
    if (nameTaken(db.prepare('SELECT id, name FROM rack_room WHERE site_id = ?').all(siteId), name)) fail(409, '같은 이름의 전산실이 이미 있습니다.');
    const id = newId();
    const sort = (db.prepare('SELECT MAX(sort) AS m FROM rack_room WHERE site_id = ?').get(siteId)?.m ?? -1) + 1;
    db.prepare('INSERT INTO rack_room (id,site_id,name,sort,rev,updated_at) VALUES (?,?,?,?,0,?)').run(id, siteId, name, sort, Date.now());
    log(db, { user, corpId: s.corpId, roomId: id, action: 'room.add', detail: `${s.name} › ${name}` });
    return { id };
  });
}

export async function renameRoom({ id, name, user }) {
  const db = await need();
  return tx(db, () => {
    const m = roomRow(db.prepare('SELECT * FROM rack_room WHERE id = ?').get(id));
    if (!m) fail(404, '전산실을 찾지 못했습니다.');
    if (nameTaken(db.prepare('SELECT id, name FROM rack_room WHERE site_id = ?').all(m.siteId), name, id)) fail(409, '같은 이름의 전산실이 이미 있습니다.');
    const s = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(m.siteId));
    if (name === m.name) return { id, unchanged: true };   // 같은 이름 — 판 · 이력을 만들지 않는다
    ensureBaseline(db, s?.corpId);
    db.prepare('UPDATE rack_room SET name = ? WHERE id = ?').run(name, id);
    log(db, { user, corpId: s?.corpId || '', roomId: id, action: 'room.rename', detail: `${m.name} → ${name}` });
    return { id };
  });
}

export async function removeRoom({ id, user }) {
  const db = await need();
  return tx(db, () => {
    const m = roomRow(db.prepare('SELECT * FROM rack_room WHERE id = ?').get(id));
    if (!m) fail(404, '전산실을 찾지 못했습니다.');
    const n = db.prepare('SELECT COUNT(*) AS n FROM rack_rack WHERE room_id = ?').get(id).n;
    if (n) fail(409, `랙 ${n}개가 남아 있어 지울 수 없습니다 — 랙을 먼저 지우세요.`);
    const s = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(m.siteId));
    ensureBaseline(db, s?.corpId);
    bumpRevFloor(db, m.rev);
    db.prepare('DELETE FROM rack_room WHERE id = ?').run(id);
    // 점검 C11: 이력은 지우지 않는다 — 판으로 전산실을 되살리면 이력도 함께 보인다(되돌리기와 같은 규칙 · 전산실마다 상한은 그대로).
    log(db, { user, corpId: s?.corpId || '', action: 'room.remove', detail: `${s?.name || ''} › ${m.name}` });
    return { id };
  });
}

export async function addType({ name, heightU, widthMm = null, depthMm = null }) {
  const db = await need();
  return tx(db, () => {
    if (nameTaken(db.prepare('SELECT id, name FROM rack_type').all(), name)) fail(409, '같은 이름의 랙 종류가 이미 있습니다.');
    const id = newId();
    db.prepare('INSERT INTO rack_type (id,name,height_u,width_mm,depth_mm) VALUES (?,?,?,?,?)').run(id, name, heightU, widthMm, depthMm);
    return { id };
  });
}

/** 랙 종류 삭제 — 쓰는 랙이 있으면 거절. */
let typeGen = 0;   // 랙 종류가 지워지면 '되돌리면 바뀌는 것' 이 달라진다(지워진 종류 → 직접 높이) — 차이 캐시 키에 넣는다
export async function removeType({ id }) {
  const db = await need();
  typeGen += 1;
  return tx(db, () => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM rack_rack WHERE type_id = ?').get(id).n;
    if (n) fail(409, `이 종류를 쓰는 랙 ${n}개가 있어 지울 수 없습니다.`);
    const r = db.prepare('DELETE FROM rack_type WHERE id = ?').run(id);
    if (!r.changes) fail(404, '랙 종류를 찾지 못했습니다.');
    return { id };
  });
}

/**
 * 전산실 단위 쓰기(랙 · 배치) — rev 대조 + 올림 + 이력을 한 트랜잭션에.
 * @param {(ctx:{db:object, room:object, corpId:string, racksById:Map, placesOf:(rackId:string)=>object[]}) => {result?:object, action:string, detail:string}} fn
 */
async function roomWrite(roomId, rev, user, fn) {
  const db = await need();
  return tx(db, () => {
    const room = roomRow(db.prepare('SELECT * FROM rack_room WHERE id = ?').get(String(roomId || '')));
    if (!room) fail(404, '전산실을 찾지 못했습니다.');
    if (!Number.isInteger(rev)) fail(400, '판 번호(rev)가 없습니다 — 화면을 새로 고친 뒤 다시 하세요.', { code: 'revRequired' });
    if (rev !== room.rev) fail(409, '다른 사람이 이 전산실을 먼저 바꿨습니다 — 최신 배치를 불러온 뒤 다시 하세요.', { code: 'revConflict', rev: room.rev });
    const site = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(room.siteId));
    ensureBaseline(db, site?.corpId);
    const racksById = new Map(db.prepare('SELECT * FROM rack_rack WHERE room_id = ?').all(room.id).map((r) => [r.id, rackRow(r)]));
    const placesOf = (rackId) => db.prepare('SELECT * FROM rack_place WHERE rack_id = ?').all(rackId).map(placeRow);
    const out = fn({ db, room, corpId: site?.corpId || '', racksById, placesOf });
    // 1회차 점검 정확성 1: 바뀐 것이 없으면 rev · 판 · 이력을 만들지 않는다 — 제자리 저장 30번이 판 30개를 채워 실제 변경의 되돌릴 지점을 밀어냈다.
    if (out.noop) return { ...(out.result || {}), rev: room.rev, unchanged: true };
    const next = room.rev + 1;
    db.prepare('UPDATE rack_room SET rev = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), room.id);
    log(db, { user, corpId: site?.corpId || '', roomId: room.id, action: out.action, detail: out.detail, tags: out.tags });
    return { ...(out.result || {}), rev: next };
  });
}

export function addRack({ roomId, rev, user, input }) {
  return roomWrite(roomId, rev, user, ({ db, room, racksById }) => {
    if (racksById.size >= LIMITS.maxRacksPerRoom) fail(409, `전산실 하나에 랙은 ${LIMITS.maxRacksPerRoom}개까지입니다.`);
    if (nameTaken([...racksById.values()], input.name)) fail(409, '같은 이름의 랙이 이 전산실에 이미 있습니다.');
    let heightU = input.heightU;
    if (input.typeId) {
      const t = typeRow(db.prepare('SELECT * FROM rack_type WHERE id = ?').get(input.typeId));
      if (!t) fail(400, '랙 종류를 찾지 못했습니다.');
      heightU = t.heightU;
    }
    const id = newId();
    const sort = racksById.size ? Math.max(...[...racksById.values()].map((r) => r.sort)) + 1 : 0;
    db.prepare('INSERT INTO rack_rack (id,room_id,name,row_name,type_id,height_u,role,pdu_a,pdu_b,sort) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, room.id, input.name, input.row || '', input.typeId || '', heightU, input.role || '', input.pduA || 0, input.pduB || 0, sort);
    return { result: { id }, action: 'rack.add', detail: `${input.row ? `${input.row} 줄 ` : ''}${input.name} · ${heightU}U` };
  });
}

export function updateRack({ roomId, rev, user, id, input }) {
  return roomWrite(roomId, rev, user, ({ db, racksById, placesOf }) => {
    const cur = racksById.get(id);
    if (!cur) fail(404, '랙을 찾지 못했습니다.');
    const next = { ...cur, ...input };
    // 반증 F8: 높이만 고치고 종류를 고르지 않았으면 '직접 높이' 로 본다(종류의 높이와 어긋난 채 종류 이름이 남지 않게).
    if (input.heightU != null && !input.typeId) next.typeId = '';
    if (input.name != null && nameTaken([...racksById.values()], input.name, id)) fail(409, '같은 이름의 랙이 이 전산실에 이미 있습니다.');
    if (input.typeId) {
      const t = typeRow(db.prepare('SELECT * FROM rack_type WHERE id = ?').get(input.typeId));
      if (!t) fail(400, '랙 종류를 찾지 못했습니다.');
      next.heightU = t.heightU;
    }
    const over = overflowOnResize(placesOf(id), next.heightU);
    if (over.length) fail(409, `높이를 ${next.heightU}U 로 줄이면 장비 ${over.length}대가 랙 밖으로 나갑니다 — 장비를 먼저 옮기세요.`, { overflow: over });
    const stored = { name: next.name, row: next.row || '', typeId: next.typeId || '', heightU: next.heightU, role: next.role || '', pduA: next.pduA || 0, pduB: next.pduB || 0 };
    if (Object.keys(stored).every((k) => stored[k] === cur[k])) return { noop: true, result: { id } };
    db.prepare('UPDATE rack_rack SET name=?, row_name=?, type_id=?, height_u=?, role=?, pdu_a=?, pdu_b=? WHERE id=?')
      .run(next.name, next.row || '', next.typeId || '', next.heightU, next.role || '', next.pduA || 0, next.pduB || 0, id);
    return { result: { id }, action: 'rack.update', detail: `${cur.name}${cur.name !== next.name ? ` → ${next.name}` : ''} · ${next.heightU}U` };
  });
}

/** 랙 삭제 — 장비가 남아 있으면 거절(장비를 조용히 지우지 않는다). */
export function removeRack({ roomId, rev, user, id }) {
  return roomWrite(roomId, rev, user, ({ db, racksById, placesOf }) => {
    const cur = racksById.get(id);
    if (!cur) fail(404, '랙을 찾지 못했습니다.');
    const n = placesOf(id).length;
    if (n) fail(409, `장비 ${n}대가 남아 있어 랙을 지울 수 없습니다 — 장비를 먼저 옮기거나 빼세요.`);
    db.prepare('DELETE FROM rack_rack WHERE id = ?').run(id);
    return { result: { id }, action: 'rack.remove', detail: cur.name };
  });
}

const where = (p) => `U${p.uStart}${p.uSize > 1 ? `–${p.uStart + p.uSize - 1}` : ''}${p.face === 'front' ? '(앞)' : p.face === 'rear' ? '(뒤)' : ''}`;
// 반증 F1: 이력 detail 은 범위 비관리자에게도 나간다 — 시리얼을 싣지 않는다(이름이 없으면 '이름 없는 장비').
const nameOf = (p) => p.label || '이름 없는 장비';

/** 이 배치의 시리얼 키(본 시리얼 + 추가 시리얼). */
// ── 법인별 시리얼 기록(가림 재료 — 1회차 반증 B-2) ──
//   시리얼을 가리는 판본은 표시 이름 · 이력 · 판 글에서 '그 법인 원장의 시리얼' 을 걷어 낸다. 지금 원장에 있는 시리얼만 재료로 쓰면
//   ① 원장에서 뺀 장비 ② 글이 쓰인 **뒤에** 시리얼을 넣은 장비(놓을 때는 빈칸)의 옛 글이 가려지지 않는다 — 한 번이라도 원장에 있었던 시리얼의 비교 키를 법인별로 남긴다.
//   (장비 수만큼만 는다 · 지우지 않는다 · 응답에 싣지 않는다)
const SEEN_META = 'seenKeys'; const SEEN_VER = 2;   // 2 = 비교 키가 폭에 무관해졌다(다시 채워 접은 키를 더한다 — 옛 키는 남겨 둔다)
let _seenReady = false;   // 이 핸들에서 시리얼 기록 채우기가 끝났는가(열 때 실패했으면 false — corpSerials 가 다시 시도한다)
let _seenRetryAt = 0;
let _seenFails = 0;       // 읽을 때 다시 채우기가 이어서 실패한 횟수(간격을 늘리는 데 쓴다 — 성공 · 다시 열기에 0)
const SEEN_RETRY_MAX_DOUBLINGS = 5;   // 30초 × 2^5 = 16분
function seeSerials(db, corpId, keys) {
  if (!corpId || !keys || !keys.size) return;
  const ins = db.prepare('INSERT OR IGNORE INTO rack_serial_seen (corp_id, key) VALUES (?, ?)');
  for (const k of keys) ins.run(corpId, k);
}
function backfillSeen(db) {
  // 키를 법인별 집합으로 먼저 모아 **새 키만** 넣는다 — 판 30개에 같은 장비가 되풀이되므로 장비마다 넣으면 시도의 97% 가 중복이다
  //   (3회차 점검 성능 4 실측: 장비 70,230대 · 판 420개에서 넣기 시도 253만 회 3.7초 → 집합으로 모으면 0.15초).
  const byCorp = new Map();
  const add = (c, k) => { let g = byCorp.get(c); if (!g) { g = new Set(); byCorp.set(c, g); } g.add(k); };
  for (const r of db.prepare(`SELECT t.corp_id AS c, p.serial AS serial, p.extra_serials AS extra_serials FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id
    JOIN rack_room m ON m.id = r.room_id JOIN rack_site t ON t.id = m.site_id WHERE p.serial <> '' OR p.extra_serials <> '[]'`).all()) {
    for (const k of keysOf(placeRow({ ...r, serial_key: '' }))) add(r.c, k);
  }
  for (const v of db.prepare('SELECT corp_id AS c, data FROM rack_version').all()) {
    const snap = unpackSnap(v.data, v.c);
    for (const p of snap?.places || []) for (const k of keysOf(p)) add(v.c, k);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO rack_serial_seen (corp_id, key) VALUES (?, ?)');
  for (const [c, g] of byCorp) for (const k of g) ins.run(c, k);
  db.prepare('INSERT INTO rack_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(SEEN_META, SEEN_VER);
}

// ── 시리얼 키 색인(개선 2 — 2026-11-26 사용자 요청) ──
//   예전 중복 검사는 쓰기마다 법인 장비 전부를 읽고 행마다 추가 시리얼 JSON 을 풀었다(5,000대 법인 약 10ms · 전산실 조회의 placedSerialKeys 도 같은 훑기).
//   rack_place_key(key, place_id) 에 장비마다 비교 키(주 시리얼 + 추가 시리얼 · serialKeyOf)를 둔다 — 장비 행을 쓰는 곳(놓기 · 고치기 · 빼기 · 되돌리기)이
//   같은 트랜잭션에서 `setPlaceKeys` 로 맞춘다. 색인이 없던 원장은 열 때 한 번 채운다(rack_meta placeKeys).
const PLACE_KEYS_META = 'placeKeys'; const PLACE_KEYS_VER = 2;   // 2 = 2026-11-27 비교 키가 폭에 무관해졌다(`layout.js serialKeyOf` — 키 칸 · 색인을 다시 만든다)
/** 시험 · 점검용 — 원장 옆 표들의 판 번호(키 함수가 바뀌면 올린다 — 열 때 다시 채운다). */
export const RACK_META_VERSIONS = Object.freeze({ seenKeys: SEEN_VER, placeKeys: PLACE_KEYS_VER });
let _keysReady = false;   // 이 핸들에서 색인이 원장과 맞춰졌는가(열 때 채우기에 실패했으면 false — 1회차 점검 정확성 4)
let _keysRetryAt = 0;     // 다시 채우기가 실패했으면 이 시각까지는 다시 시도하지 않는다(그동안은 원장 훑기로 판정)
const KEYS_RETRY_MS = 30_000;
/**
 * 색인을 쓸 수 있는가. 열 때 채우지 못했으면(잠금 · 디스크 오류) 여기서 다시 채운다 — 그래도 못 하면 false 를 돌려주고 부르는 쪽이 원장 훑기로 판정한다
 * (예전엔 빈 색인으로 계속 돌아 놓인 서버가 미배치로 보이고 같은 시리얼이 두 자리에 들어갔다). `inTx` = 이미 쓰기 트랜잭션 안(SAVEPOINT 로 감싼다).
 */
function keysUsable(db, inTx) {
  if (_keysReady) return true;
  // 2회차 점검 성능 5: 실패가 이어지는 동안(다른 연결의 잠금 · 고장 난 색인 표) 요청마다 다시 시도하면 조회 1회가 잠금 대기 3초를 통째로 물고 경고가 줄줄이 찍혔다 —
  //   한 번 실패하면 KEYS_RETRY_MS 동안은 훑기로만 답한다(경고도 그때 한 번).
  if (Date.now() < _keysRetryAt) return false;
  try {
    if (inTx) {
      db.exec('SAVEPOINT rack_keys');
      try { rebuildPlaceKeys(db); db.exec('RELEASE rack_keys'); } catch (e) {
        // SAVEPOINT 로 되돌리지 못하면(‘no such savepoint’) 바깥 쓰기 트랜잭션이 통째로 사라진 것이다 — 표식을 달아 올린다.
        //   `db.isTransaction` 은 Node 22.16 에 생긴 속성이라 그 전 버전(engines 는 22.5 부터)에서는 undefined 다(3회차 점검 정확성 2).
        try { db.exec('ROLLBACK TO rack_keys'); db.exec('RELEASE rack_keys'); } catch { e.rackTxLost = true; }
        throw e;
      }
    } else tx(db, () => rebuildPlaceKeys(db));
    _keysReady = true;
  } catch (e) {
    // 1회차 반증 C-1: 디스크 가득 · I/O 오류는 SQLite 가 **쓰기 트랜잭션 전체**를 스스로 되돌린다 — 그 상태로 쓰기를 이어 가면 변경이 트랜잭션 밖에서 하나씩 확정된다
    //   (재현: places · rev · 판 · 이력이 늘고 응답은 500). 트랜잭션이 사라졌으면 훑기로 넘어가지 않고 오류를 올려 이 쓰기를 멈춘다.
    _keysRetryAt = Date.now() + KEYS_RETRY_MS;
    if (inTx && (e?.rackTxLost === true || db.isTransaction === false)) throw e;
    console.warn(`[rack-db] 시리얼 키 색인을 다시 만들지 못했습니다 — ${Math.round(KEYS_RETRY_MS / 1000)}초 동안 원장을 훑어 판정합니다:`, e.message);
  }
  return _keysReady;
}
function setPlaceKeys(db, placeId, keys) {
  if (!_keysReady) return;   // 아직 못 채운 색인 — 다음 keysUsable 이 원장에서 통째로 다시 만든다(여기서 조각만 넣으면 '채워진 것처럼' 보인다)
  db.prepare('DELETE FROM rack_place_key WHERE place_id = ?').run(placeId);
  if (!keys || !keys.size) return;
  const ins = db.prepare('INSERT OR IGNORE INTO rack_place_key (key, place_id) VALUES (?, ?)');
  for (const k of keys) ins.run(k, placeId);
}
function rebuildPlaceKeys(db) {
  db.exec('DELETE FROM rack_place_key');
  const ins = db.prepare('INSERT OR IGNORE INTO rack_place_key (key, place_id) VALUES (?, ?)');
  const fix = db.prepare('UPDATE rack_place SET serial_key = ? WHERE id = ?');
  // 장비 행의 키 칸(serial_key — 등록 서버와 잇는 키)도 지금 키 함수로 맞춘다(키 함수가 바뀐 판에서 옛 키가 남지 않게).
  for (const r of db.prepare("SELECT id, serial, serial_key, extra_serials FROM rack_place WHERE serial <> '' OR serial_key <> '' OR extra_serials <> '[]'").all()) {
    const k0 = serialKeyOf(r.serial);
    if (k0 !== r.serial_key) fix.run(k0, r.id);
    for (const k of keysOf(placeRow({ ...r, serial_key: '' }))) ins.run(k, r.id);
  }
  db.prepare('INSERT INTO rack_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(PLACE_KEYS_META, PLACE_KEYS_VER);
}

function keysOf(p) {
  const out = new Set();
  const k = serialKeyOf(p.serial); if (k) out.add(k);
  for (const x of p.extraSerials || []) { const kx = serialKeyOf(x); if (kx) out.add(kx); }
  return out;
}
/**
 * 반증 F7: 같은 법인 원장에 같은 시리얼이 두 자리에 있으면 거절한다 — 한 장비가 두 곳에 '연결됨' 으로 보이면 어느 쪽이 맞는지 알 수 없다.
 * (법인 안 모든 데이터센터 · 전산실을 본다 · 자기 자신은 뺀다)
 */
function serialClash(db, corpId, keys, ignoreId = '') {
  if (!keys.size) return null;
  if (!keysUsable(db, true)) return serialClashScan(db, corpId, keys, ignoreId);
  const q = db.prepare(`SELECT p.id, p.label, r.name AS rack, m.name AS room FROM rack_place_key k JOIN rack_place p ON p.id = k.place_id
    JOIN rack_rack r ON r.id = p.rack_id JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id
    WHERE k.key = ? AND s.corp_id = ? AND k.place_id <> ? LIMIT 1`);
  let hit = null;
  for (const k of keys) { const r = q.get(k, corpId, ignoreId); if (r) { hit = { id: r.id, where: `${r.room} › ${r.rack}`, label: r.label || '이름 없는 장비' }; break; } }
  if (SELF_CHECK() && !!hit !== !!serialClashScan(db, corpId, keys, ignoreId)) throw new Error('[rack-db] 자기 점검: 시리얼 키 색인의 중복 판정이 원장 훑기와 다릅니다');
  return hit;
}
/** 색인 없이 원장을 훑는 예전 판정 — 자기 점검(RACK_SELF_CHECK=1)에서만 색인 결과와 대조한다. */
function serialClashScan(db, corpId, keys, ignoreId = '') {
  const rows = db.prepare(`SELECT p.id, p.label, p.serial_key AS k, p.extra_serials AS x, r.name AS rack, m.name AS room FROM rack_place p
    JOIN rack_rack r ON r.id = p.rack_id JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?`).all(corpId);
  for (const r of rows) {
    if (r.id === ignoreId) continue;
    const theirs = new Set(r.k ? [r.k] : []);
    try { for (const x of JSON.parse(r.x || '[]')) { const kx = serialKeyOf(x); if (kx) theirs.add(kx); } } catch { /* */ }
    for (const k of keys) if (theirs.has(k)) return { id: r.id, where: `${r.room} › ${r.rack}`, label: r.label || '이름 없는 장비' };
  }
  return null;
}

export function addPlace({ roomId, rev, user, rackId, input }) {
  return roomWrite(roomId, rev, user, ({ db, racksById, placesOf, corpId }) => {
    const rack = racksById.get(rackId);
    if (!rack) fail(404, '랙을 찾지 못했습니다.');
    const places = placesOf(rackId);
    if (places.length >= LIMITS.maxPlacesPerRack) fail(409, `랙 하나에 장비는 ${LIMITS.maxPlacesPerRack}대까지입니다.`);
    const issue = placementIssue(rack, places, input);
    if (issue) fail(409, issue.reason, { code: issue.code, withId: issue.withId });
    const dup = serialClash(db, corpId, keysOf(input));
    if (dup) fail(409, `같은 시리얼이 이미 ${dup.where} 의 ${dup.label} 에 있습니다 — 한 장비를 두 자리에 둘 수 없습니다.`, { code: 'serialDup', withId: dup.id });
    const id = newId();
    db.prepare(`INSERT INTO rack_place (id,rack_id,face,u_start,u_size,kind,label,model,serial,serial_key,extra_serials,note,rated_w,op_w,weight_kg,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, rackId, input.face, input.uStart, input.uSize, input.kind, input.label || '', input.model || '', input.serial || '',
        serialKeyOf(input.serial), JSON.stringify(input.extraSerials || []), input.note || '', input.ratedW ?? null, input.opW ?? null, input.weightKg ?? null, Date.now());
    setPlaceKeys(db, id, keysOf(input));
    seeSerials(db, corpId, keysOf(input));
    return { result: { id }, action: 'place.add', detail: `${nameOf(input)} → ${rack.name} ${where(input)}`, tags: serialsOf(input) };
  });
}

/** 장비 고치기 · 옮기기 — input 에 있는 필드만 바꾼다. rackId 가 오면 다른 랙으로 옮긴다(같은 전산실 안). */
export function updatePlace({ roomId, rev, user, id, rackId = '', input }) {
  return roomWrite(roomId, rev, user, ({ db, racksById, placesOf, corpId }) => {
    const curRow = db.prepare('SELECT * FROM rack_place WHERE id = ?').get(id);
    const cur = placeRow(curRow);
    if (!cur || !racksById.has(cur.rackId)) fail(404, '장비를 찾지 못했습니다.');
    const toRackId = rackId || cur.rackId;
    const rack = racksById.get(toRackId);
    if (!rack) fail(404, '옮길 랙을 이 전산실에서 찾지 못했습니다.');
    const next = { ...cur, ...input, rackId: toRackId };
    // 반증 F4: 고친 결과가 이름도 시리얼도 없는 장비가 되면 거절(새로 놓을 때와 같은 기준).
    if (!next.label && !next.serial) fail(400, '장비 이름이나 시리얼 중 하나는 있어야 합니다.');
    const there = placesOf(toRackId);
    // 반증 F5: 다른 랙으로 옮길 때도 랙당 장비 상한을 지킨다(놓을 때만 보던 상한).
    if (toRackId !== cur.rackId && there.length >= LIMITS.maxPlacesPerRack) fail(409, `랙 하나에 장비는 ${LIMITS.maxPlacesPerRack}대까지입니다.`);
    const issue = placementIssue(rack, there, next, id);
    if (issue) fail(409, issue.reason, { code: issue.code, withId: issue.withId });
    if ('serial' in input || 'extraSerials' in input) {
      const dup = serialClash(db, corpId, keysOf(next), id);
      if (dup) fail(409, `같은 시리얼이 이미 ${dup.where} 의 ${dup.label} 에 있습니다 — 한 장비를 두 자리에 둘 수 없습니다.`, { code: 'serialDup', withId: dup.id });
    }
    const storedP = {
      rackId: toRackId, face: next.face, uStart: next.uStart, uSize: next.uSize, kind: next.kind, label: next.label || '', model: next.model || '', serial: next.serial || '',
      note: next.note || '', ratedW: next.ratedW ?? null, opW: next.opW ?? null, weightKg: next.weightKg ?? null,
    };
    if (Object.keys(storedP).every((k) => storedP[k] === cur[k]) && JSON.stringify(next.extraSerials || []) === JSON.stringify(cur.extraSerials || [])) return { noop: true, result: { id } };
    db.prepare(`UPDATE rack_place SET rack_id=?, face=?, u_start=?, u_size=?, kind=?, label=?, model=?, serial=?, serial_key=?, extra_serials=?, note=?,
      rated_w=?, op_w=?, weight_kg=?, updated_at=? WHERE id=?`)
      .run(toRackId, next.face, next.uStart, next.uSize, next.kind, next.label || '', next.model || '', next.serial || '', serialKeyOf(next.serial),
        JSON.stringify(next.extraSerials || []), next.note || '', next.ratedW ?? null, next.opW ?? null, next.weightKg ?? null, Date.now(), id);
    if ('serial' in input || 'extraSerials' in input) { setPlaceKeys(db, id, keysOf(next)); seeSerials(db, corpId, keysOf(next)); }
    const moved = toRackId !== cur.rackId || next.uStart !== cur.uStart || next.face !== cur.face || next.uSize !== cur.uSize;
    const fromRack = racksById.get(cur.rackId);
    return {
      result: { id },
      action: moved ? 'place.move' : 'place.update',
      detail: moved ? `${nameOf(next)}: ${fromRack?.name || ''} ${where(cur)} → ${rack.name} ${where(next)}` : `${nameOf(next)} 정보 수정`,
      tags: serialsOf(cur, next),
    };
  });
}

export function removePlace({ roomId, rev, user, id }) {
  return roomWrite(roomId, rev, user, ({ db, racksById }) => {
    const cur = placeRow(db.prepare('SELECT * FROM rack_place WHERE id = ?').get(id));
    if (!cur || !racksById.has(cur.rackId)) fail(404, '장비를 찾지 못했습니다.');
    db.prepare('DELETE FROM rack_place WHERE id = ?').run(id);
    setPlaceKeys(db, id, null);
    return { result: { id }, action: 'place.remove', detail: `${nameOf(cur)} ← ${racksById.get(cur.rackId)?.name || ''} ${where(cur)}`, tags: serialsOf(cur) };
  });
}

// ───────────────────────── 판 조회 · 되돌리기 ─────────────────────────

/** 한 법인의 판 목록(최신 먼저 · 최대 VERSION_KEEP 개). */
export async function listVersions(corpId, { maskRow = null } = {}) {
  const db = await need();
  return db.prepare('SELECT id, ts, user, action, detail, counts, tags FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(corpId || ''), VERSION_KEEP)
    .map((r) => { let c = {}; try { c = JSON.parse(r.counts || '{}'); } catch { c = {}; } return { id: r.id, ts: r.ts, user: r.user, action: r.action, detail: maskRow ? maskRow(r.detail, rowTags(r.tags), r.action) : r.detail, counts: c }; });
}

/**
 * 판 하나의 차이 두 가지 — ① 이 판에서 바뀐 것(바로 앞 판 → 이 판) ② 되돌리면 바뀌는 것(지금 원장 → 이 판).
 * 판을 읽지 못하면(손상) readable:false. 없거나 다른 법인 판이면 null.
 */
const DETAIL_CACHE = new Map();   // `${corp}\0${vid}\0${latestId}` → 결과(최근 40개) — 최신 판이 바뀌면 키가 달라져 자연히 버려진다
const DETAIL_CACHE_MAX = 40;
/**
 * @param {object} [o] 비관리자 판본의 가림 함수(routes/api/rack.js textMaskOf) — 캐시에는 가리지 않은 결과를 두고, 꺼낸 사본에 요청마다 적용한다.
 * @param {(detail:string, tags:string[]|null, action:string)=>string} [o.maskRow]  판 글(version.detail)
 * @param {(name:string, tags:string[])=>string} [o.maskItem]  차이 항목 이름(장비면 그 장비의 시리얼을 함께 넘긴다)
 * 캐시 안의 `_tags`(시리얼 원문)는 **여기서 반드시 지우고** 돌려준다 — 이 함수가 유일한 출구다.
 */
export async function versionDetail(corpId, versionId, { maskRow = null, maskItem = null } = {}) {
  const db = await need();
  const latest = db.prepare('SELECT id FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT 1').get(String(corpId))?.id ?? 0;
  const key = `${corpId}\0${Number(versionId)}\0${latest}\0${typeGen}`;
  let raw = DETAIL_CACHE.get(key);
  if (!raw) {
    raw = versionDetailRaw(db, corpId, versionId);
    if (raw) { DETAIL_CACHE.set(key, raw); while (DETAIL_CACHE.size > DETAIL_CACHE_MAX) DETAIL_CACHE.delete(DETAIL_CACHE.keys().next().value); }
  }
  if (!raw) return raw;
  const out = structuredClone(raw);
  if (maskRow) out.version.detail = maskRow(out.version.detail, out.version._tags, out.version.action);
  delete out.version._tags;
  for (const part of [out.changes, out.restore]) {
    for (const it of part?.items || []) { if (maskItem) it.name = maskItem(it.name, it._tags || []); delete it._tags; }
  }
  return out;
}
function versionDetailRaw(db, corpId, versionId) {
  const v = db.prepare('SELECT id, ts, user, action, detail, data, tags FROM rack_version WHERE id = ? AND corp_id = ?').get(Number(versionId), String(corpId));
  if (!v) return null;
  const snap = unpackSnap(v.data, corpId);
  const head = { id: v.id, ts: v.ts, user: v.user, action: v.action, detail: v.detail, _tags: rowTags(v.tags) };
  if (!snap) return { version: head, readable: false };
  const prev = db.prepare('SELECT data FROM rack_version WHERE corp_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(String(corpId), v.id);
  const prevSnap = prev ? unpackSnap(prev.data, corpId) : null;
  const now = validateSnapshot(currentSnapshot(db, corpId), corpId);
  const typeOk = db.prepare('SELECT 1 AS x FROM rack_type WHERE id = ?');
  const target = restorableSnapshot(snap, (id) => !!typeOk.get(id));   // 되돌리면 실제로 들어갈 모습(점검 C10)
  // 차이 항목(장비)마다 그 장비의 시리얼을 `_tags` 로 붙여 둔다 — 판 세 개(앞 · 이 판 · 지금)에 있는 값 전부(지금 원장에 없는 옛 장비 포함).
  //   versionDetail 이 가림 함수에 넘기고 지운다(응답에 싣지 않는다).
  const serialsById = new Map();
  for (const sn of [prevSnap, snap, now]) for (const p of sn?.places || []) {
    const xs = [p.serial, ...(p.extraSerials || [])].filter(Boolean);
    if (xs.length) serialsById.set(p.id, [...new Set([...(serialsById.get(p.id) || []), ...xs])]);
  }
  const hide = (d) => (d ? { ...d, items: d.items.map((it) => (it.type === 'place' ? { ...it, _tags: serialsById.get(it.id) || [] } : it)) } : d);
  return {
    version: head, readable: true, counts: countsOf(snap),
    changes: prevSnap ? hide(diffSnapshots(prevSnap, snap)) : null,
    prevUnreadable: !!prev && !prevSnap,   // 점검 C13: 앞 판이 '없음' 과 '손상' 을 가른다(화면이 '가장 오래된 판' 으로 잘못 설명했다)
    restore: now ? hide(diffSnapshots(now, target)) : null,
  };
}

/**
 * 법인 원장을 고른 판의 모습으로 되돌린다(한 트랜잭션 — 지우기 · 다시 넣기 · 판 · 이력이 함께).
 *  · expectLatestId: 화면이 본 최신 판 id — 그 사이 누가 바꿨으면 409(덮어쓰지 않는다).
 *  · 판 안의 id 가 다른 법인 자료와 겹치면 거절(다른 법인 원장을 건드리지 않는다).
 *  · 랙 종류가 그 사이 지워졌으면 그 랙은 '직접 높이' 로(높이는 판 값 그대로).
 *  · 전산실 rev 는 새 값으로 올린다 — 열려 있던 편집 화면은 다음 저장에서 충돌로 최신을 다시 불러온다.
 *  · 되돌리기 자체도 새 판으로 남는다(되돌리기를 되돌릴 수 있다).
 */
export async function restoreVersion({ corpId, versionId, expectLatestId, user }) {
  const db = await need();
  return tx(db, () => {
    const latest = db.prepare('SELECT id FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT 1').get(corpId);
    if (!latest) fail(404, '이 법인에는 저장된 판이 없습니다.');
    if (!Number.isInteger(expectLatestId) || expectLatestId !== latest.id) {
      fail(409, '그 사이 이 법인의 랙 실장도가 바뀌었습니다 — 판 목록을 다시 불러온 뒤 고르세요.', { code: 'versionConflict', latestId: latest.id });
    }
    const v = db.prepare('SELECT id, ts, data FROM rack_version WHERE id = ? AND corp_id = ?').get(Number(versionId), corpId);
    if (!v) fail(404, '판을 찾지 못했습니다.');
    if (v.id === latest.id) fail(409, '고른 판이 지금 원장과 같은 최신 판입니다.', { code: 'versionSame' });
    const snap = unpackSnap(v.data, corpId);
    if (!snap) fail(409, '이 판을 읽지 못했습니다(손상) — 되돌리지 않았습니다.', { code: 'versionUnreadable' });
    const cur = corpRows(db, corpId);
    const mine = { site: new Set(cur.sites.map((x) => x.id)), room: new Set(cur.rooms.map((x) => x.id)), rack: new Set(cur.racks.map((x) => x.id)), place: new Set(cur.places.map((x) => x.id)) };
    const exists = {
      site: db.prepare('SELECT 1 AS x FROM rack_site WHERE id = ?'), room: db.prepare('SELECT 1 AS x FROM rack_room WHERE id = ?'),
      rack: db.prepare('SELECT 1 AS x FROM rack_rack WHERE id = ?'), place: db.prepare('SELECT 1 AS x FROM rack_place WHERE id = ?'),
    };
    for (const [k, list] of [['site', snap.sites], ['room', snap.rooms], ['rack', snap.racks], ['place', snap.places]]) {
      for (const x of list) if (!mine[k].has(x.id) && exists[k].get(x.id)) fail(409, '판의 자료가 다른 법인 원장과 겹쳐 되돌릴 수 없습니다.', { code: 'versionIdClash' });
    }
    // 반증 L-2: 새 rev = (전역 바닥값 · 지금 전 전산실 rev 최댓값 · 이 법인 전산실 rev) 중 가장 큰 값 + 1 — 지워졌다 되살아난 전산실도 옛 rev 를 다시 받지 않는다.
    for (const r of cur.rooms) bumpRevFloor(db, r.rev);
    const maxNow = db.prepare('SELECT MAX(rev) AS m FROM rack_room').get()?.m ?? 0;
    const newRev = Math.max(metaGet(db, 'revFloor'), maxNow) + 1;
    // 지금 원장 지우기(이 법인 것만). 반증 L-3: 이력(rack_log)은 지우지 않는다 — 그 전산실이 다시 되돌려지면 이력도 함께 보인다(전산실마다 2,000건 상한은 그대로).
    const del = { place: db.prepare('DELETE FROM rack_place WHERE id = ?'), rack: db.prepare('DELETE FROM rack_rack WHERE id = ?'), room: db.prepare('DELETE FROM rack_room WHERE id = ?'), site: db.prepare('DELETE FROM rack_site WHERE id = ?') };
    // 시리얼 키 색인도 함께(색인을 아직 못 채운 핸들이면 건너뛴다 — 다음 keysUsable 이 원장에서 통째로 다시 만든다). 문장은 반복문 밖에서 한 번만 준비한다
    //   (1회차 점검 성능 축 — 실측: 장비마다 setPlaceKeys 를 부르면 문장 준비 때문에 5,100대 되돌리기가 145 → 225ms).
    const delKeys = _keysReady ? db.prepare('DELETE FROM rack_place_key WHERE place_id = ?') : null;
    const insKey = _keysReady ? db.prepare('INSERT OR IGNORE INTO rack_place_key (key, place_id) VALUES (?, ?)') : null;
    const insSeen = db.prepare('INSERT OR IGNORE INTO rack_serial_seen (corp_id, key) VALUES (?, ?)');
    for (const p of cur.places) { del.place.run(p.id); if (delKeys) delKeys.run(p.id); }
    for (const r of cur.racks) del.rack.run(r.id);
    for (const r of cur.rooms) del.room.run(r.id);
    for (const s of cur.sites) del.site.run(s.id);
    // 판 넣기(문장은 반복문 밖에서 한 번만 준비 — 반증 M-1)
    const now = Date.now();
    const typeOk = db.prepare('SELECT 1 AS x FROM rack_type WHERE id = ?');
    const ins = {
      site: db.prepare('INSERT INTO rack_site (id,corp_id,name,sort,created_at) VALUES (?,?,?,?,?)'),
      room: db.prepare('INSERT INTO rack_room (id,site_id,name,sort,rev,updated_at) VALUES (?,?,?,?,?,?)'),
      rack: db.prepare('INSERT INTO rack_rack (id,room_id,name,row_name,type_id,height_u,role,pdu_a,pdu_b,sort) VALUES (?,?,?,?,?,?,?,?,?,?)'),
      place: db.prepare(`INSERT INTO rack_place (id,rack_id,face,u_start,u_size,kind,label,model,serial,serial_key,extra_serials,note,rated_w,op_w,weight_kg,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    };
    for (const s of snap.sites) ins.site.run(s.id, corpId, s.name, s.sort, now);
    for (const r of snap.rooms) ins.room.run(r.id, r.siteId, r.name, r.sort, newRev, now);
    for (const r of restorableSnapshot(snap, (id) => !!typeOk.get(id)).racks) ins.rack.run(r.id, r.roomId, r.name, r.row, r.typeId, r.heightU, r.role, r.pduA, r.pduB, r.sort);
    for (const p of snap.places) {
      ins.place.run(p.id, p.rackId, p.face, p.uStart, p.uSize, p.kind, p.label, p.model, p.serial, serialKeyOf(p.serial), JSON.stringify(p.extraSerials), p.note, p.ratedW, p.opW, p.weightKg, now);
      const ks = keysOf(p);
      if (insKey) for (const k of ks) insKey.run(k, p.id);
      for (const k of ks) insSeen.run(corpId, k);
    }
    const detail = `판 #${v.id} 으로 되돌림`;
    for (const r of snap.rooms) log(db, { user, corpId, roomId: r.id, action: 'version.restore', detail, version: false });
    saveVersion(db, corpId, { user, action: 'version.restore', detail });
    const next = db.prepare('SELECT id FROM rack_version WHERE corp_id = ? ORDER BY id DESC LIMIT 1').get(corpId);
    return { restoredFrom: v.id, latestId: next.id, counts: countsOf(snap) };
  });
}
