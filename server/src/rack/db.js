/**
 * rack/db.js — 랙 실장도 **원장**(중앙 한 곳 · 2026-11-20 사용자 결정 '원장 위치는 중앙에 한곳').
 *
 * 계층: 법인(`datacenter/store.js` 의 DataCenter — 법인 묶음) → 데이터센터(site · 물리) → 전산실(room) → 랙(rack, 줄 이름 포함) → 배치(place).
 *   법인 하나에 데이터센터가 여럿일 수 있다(루트 CLAUDE.md 2026-11-20 규칙). 구역(zone)은 1차에 두지 않는다 — 줄 이름으로 충분한지 운영 뒤에 본다.
 * 측정값(상태 · 온도 · 전력)은 여기에 넣지 않는다 — 화면을 그릴 때 수집 모듈에서 서비스 태그로 이어 읽는다(원장 = 사람이 정한 위치만).
 *
 * 동시 편집: 전산실마다 `rev`. 랙 · 배치를 바꾸는 쓰기는 요청의 rev 가 지금 값과 같을 때만 반영하고 rev 를 올린다 — 다르면 409(조용히 덮어쓰지 않는다).
 * 쓰기는 한 트랜잭션(동기 · 행 몇 개라 이벤트 루프를 오래 잡지 않는다). 변경 이력(rack_log)도 같은 트랜잭션에 적는다(이력만 빠지는 반쪽 저장 없음).
 * 파일: `RACK_DB` 또는 `<dbDir|configDir>/rack.db`, 권한 0600. 열기 규칙은 util/sqliteOpen.js(busy_timeout 먼저 · 잠금이면 래치하지 않고 다시 연다).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { openSqlite, createLockRetry, chmodDbFiles } from '../util/sqliteOpen.js';
import { placementIssue, overflowOnResize, serialKeyOf, LIMITS } from './layout.js';

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

export function rackDbError() { return _initError; }

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
      CREATE INDEX IF NOT EXISTS ix_rack_place_key ON rack_place(serial_key);
      CREATE TABLE IF NOT EXISTS rack_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user TEXT NOT NULL, corp_id TEXT NOT NULL,
        room_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS ix_rack_log_room ON rack_log(room_id, id);
    `);
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
export function _closeForTest() { try { _db?.close(); } catch { /* */ } _db = null; _initError = ''; }

async function need() {
  const db = await openRackDb();
  if (!db) fail(503, '랙 실장도 원장을 열 수 없습니다(잠금 또는 저장소 오류) — 잠시 뒤 다시 시도하세요.', { code: 'rackDbUnavailable' });
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
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

function log(db, { user, corpId, roomId = '', action, detail = '' }) {
  db.prepare('INSERT INTO rack_log (ts,user,corp_id,room_id,action,detail) VALUES (?,?,?,?,?,?)')
    .run(Date.now(), String(user || '').slice(0, 64), corpId, roomId, action, String(detail).slice(0, 500));
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
export async function getRoom(roomId, { logLimit = 100 } = {}) {
  const db = await need();
  const room = roomRow(db.prepare('SELECT * FROM rack_room WHERE id = ?').get(String(roomId || '')));
  if (!room) return null;
  const site = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(room.siteId));
  if (!site) return null;
  const racks = db.prepare('SELECT * FROM rack_rack WHERE room_id = ? ORDER BY sort, row_name, name').all(room.id).map(rackRow);
  const places = db.prepare('SELECT p.* FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id WHERE r.room_id = ? ORDER BY p.rack_id, p.u_start DESC').all(room.id).map(placeRow);
  const logs = db.prepare('SELECT ts, user, action, detail FROM rack_log WHERE room_id = ? ORDER BY id DESC LIMIT ?').all(room.id, Math.max(1, Math.min(500, logLimit)));
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
export async function placedSerialKeys(corpId) {
  const db = await need();
  const rows = db.prepare(`SELECT p.serial_key AS k, p.extra_serials AS x FROM rack_place p JOIN rack_rack r ON r.id = p.rack_id
    JOIN rack_room m ON m.id = r.room_id JOIN rack_site s ON s.id = m.site_id WHERE s.corp_id = ?`).all(String(corpId || ''));
  const out = new Set();
  for (const r of rows) {
    if (r.k) out.add(r.k);
    try { for (const x of JSON.parse(r.x || '[]')) { const k = serialKeyOf(x); if (k) out.add(k); } } catch { /* */ }
  }
  return out;
}

// ───────────────────────── 쓰기 ─────────────────────────

export async function addSite({ corpId, name, user }) {
  const db = await need();
  return tx(db, () => {
    const dup = db.prepare('SELECT id FROM rack_site WHERE corp_id = ? AND name = ?').get(corpId, name);
    if (dup) fail(409, '같은 이름의 데이터센터가 이 법인에 이미 있습니다.');
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
    const dup = db.prepare('SELECT id FROM rack_site WHERE corp_id = ? AND name = ? AND id <> ?').get(s.corpId, name, id);
    if (dup) fail(409, '같은 이름의 데이터센터가 이 법인에 이미 있습니다.');
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
    if (db.prepare('SELECT id FROM rack_room WHERE site_id = ? AND name = ?').get(siteId, name)) fail(409, '같은 이름의 전산실이 이미 있습니다.');
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
    if (db.prepare('SELECT id FROM rack_room WHERE site_id = ? AND name = ? AND id <> ?').get(m.siteId, name, id)) fail(409, '같은 이름의 전산실이 이미 있습니다.');
    const s = siteRow(db.prepare('SELECT * FROM rack_site WHERE id = ?').get(m.siteId));
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
    db.prepare('DELETE FROM rack_room WHERE id = ?').run(id);
    db.prepare('DELETE FROM rack_log WHERE room_id = ?').run(id);
    log(db, { user, corpId: s?.corpId || '', action: 'room.remove', detail: `${s?.name || ''} › ${m.name}` });
    return { id };
  });
}

export async function addType({ name, heightU, widthMm = null, depthMm = null }) {
  const db = await need();
  return tx(db, () => {
    if (db.prepare('SELECT id FROM rack_type WHERE name = ?').get(name)) fail(409, '같은 이름의 랙 종류가 이미 있습니다.');
    const id = newId();
    db.prepare('INSERT INTO rack_type (id,name,height_u,width_mm,depth_mm) VALUES (?,?,?,?,?)').run(id, name, heightU, widthMm, depthMm);
    return { id };
  });
}

/** 랙 종류 삭제 — 쓰는 랙이 있으면 거절. */
export async function removeType({ id }) {
  const db = await need();
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
    const racksById = new Map(db.prepare('SELECT * FROM rack_rack WHERE room_id = ?').all(room.id).map((r) => [r.id, rackRow(r)]));
    const placesOf = (rackId) => db.prepare('SELECT * FROM rack_place WHERE rack_id = ?').all(rackId).map(placeRow);
    const out = fn({ db, room, corpId: site?.corpId || '', racksById, placesOf });
    const next = room.rev + 1;
    db.prepare('UPDATE rack_room SET rev = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), room.id);
    log(db, { user, corpId: site?.corpId || '', roomId: room.id, action: out.action, detail: out.detail });
    return { ...(out.result || {}), rev: next };
  });
}

export function addRack({ roomId, rev, user, input }) {
  return roomWrite(roomId, rev, user, ({ db, room, racksById }) => {
    if (racksById.size >= LIMITS.maxRacksPerRoom) fail(409, `전산실 하나에 랙은 ${LIMITS.maxRacksPerRoom}개까지입니다.`);
    if ([...racksById.values()].some((r) => r.name === input.name)) fail(409, '같은 이름의 랙이 이 전산실에 이미 있습니다.');
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
    if (input.name != null && [...racksById.values()].some((r) => r.id !== id && r.name === input.name)) fail(409, '같은 이름의 랙이 이 전산실에 이미 있습니다.');
    if (input.typeId) {
      const t = typeRow(db.prepare('SELECT * FROM rack_type WHERE id = ?').get(input.typeId));
      if (!t) fail(400, '랙 종류를 찾지 못했습니다.');
      next.heightU = t.heightU;
    }
    const over = overflowOnResize(placesOf(id), next.heightU);
    if (over.length) fail(409, `높이를 ${next.heightU}U 로 줄이면 장비 ${over.length}대가 랙 밖으로 나갑니다 — 장비를 먼저 옮기세요.`, { overflow: over });
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
    return { result: { id }, action: 'place.add', detail: `${nameOf(input)} → ${rack.name} ${where(input)}` };
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
    db.prepare(`UPDATE rack_place SET rack_id=?, face=?, u_start=?, u_size=?, kind=?, label=?, model=?, serial=?, serial_key=?, extra_serials=?, note=?,
      rated_w=?, op_w=?, weight_kg=?, updated_at=? WHERE id=?`)
      .run(toRackId, next.face, next.uStart, next.uSize, next.kind, next.label || '', next.model || '', next.serial || '', serialKeyOf(next.serial),
        JSON.stringify(next.extraSerials || []), next.note || '', next.ratedW ?? null, next.opW ?? null, next.weightKg ?? null, Date.now(), id);
    const moved = toRackId !== cur.rackId || next.uStart !== cur.uStart || next.face !== cur.face || next.uSize !== cur.uSize;
    const fromRack = racksById.get(cur.rackId);
    return {
      result: { id },
      action: moved ? 'place.move' : 'place.update',
      detail: moved ? `${nameOf(next)}: ${fromRack?.name || ''} ${where(cur)} → ${rack.name} ${where(next)}` : `${nameOf(next)} 정보 수정`,
    };
  });
}

export function removePlace({ roomId, rev, user, id }) {
  return roomWrite(roomId, rev, user, ({ db, racksById }) => {
    const cur = placeRow(db.prepare('SELECT * FROM rack_place WHERE id = ?').get(id));
    if (!cur || !racksById.has(cur.rackId)) fail(404, '장비를 찾지 못했습니다.');
    db.prepare('DELETE FROM rack_place WHERE id = ?').run(id);
    return { result: { id }, action: 'place.remove', detail: `${nameOf(cur)} ← ${racksById.get(cur.rackId)?.name || ''} ${where(cur)}` };
  });
}
