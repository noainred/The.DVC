/**
 * curuser/db.js — '현재 사용자' 전용 시계열 DB(v2.520).
 *
 * 사용자 요구: **"10분마다 DB 에 저장해줘"**. `CONFIG_DIR`(또는 `config.dbDir`) 아래
 * `curuser.db` 하나를 쓴다. node:sqlite 가 없으면 기능을 **비활성으로 정직하게 보고**한다
 * (NDJSON 폴백을 두지 않는다 — 조회가 전부 집계라 파일 스캔 폴백은 실익 없이 복잡도만 키운다.
 *  `vmtrack/db.js` 와 같은 판단).
 *
 * ── 계열 수를 먼저 계산했다(CLAUDE.md v2.504 규칙) ─────────────────────────────
 *  · `vc_series` : (28 vCenter + 전체 1) × 6회/시간 = 하루 4,176행 → **연 152만행**.
 *    보존 기본 180일이면 정상 상태 약 **75만행**. 인덱스 포함 수십 MB 수준.
 *  · `vm_series` : 대상 400대 × 6회/시간 = 하루 57,600행 → **연 2,100만행**. 그래서
 *    **기본 꺼짐**이고 `CURUSER_VM_SERIES=1` 로만 켠다. 이 옵트인을 기본값으로 바꾸지 말 것.
 *  · `latest`    : 대상 VM 수만큼(≤ maxVms). 계정명은 **여기에만** 둔다 — 시계열에 계정명을
 *    쌓으면 (사용자 수 × 주기) 행이 되고 개인정보가 장기 보존된다(`aggregate.js seriesRow` 참조).
 *
 * PRAGMA 는 저장소 규칙대로 WAL + synchronous=NORMAL + busy_timeout=3000. 적재는 주기당
 * **트랜잭션 1회**(수백 행 INSERT 의 fsync 를 1회로 — 무트랜잭션 대량 write 가 이벤트 루프를
 * 막은 사고가 이 저장소에 있다). 파일 권한 0600.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = () => process.env.CURUSER_DB_PATH
  || path.join(config.dbDir || config.configDir, 'curuser.db');

/** VM 단위 시계열은 **옵트인**(위 머리말 — 연 2,100만행). */
export const vmSeriesEnabled = () => String(process.env.CURUSER_VM_SERIES || '') === '1';

let x = null;         // { db, st, path }
let ready = null;
let initError = null;
let tick = 0;

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS latest (
      vm_id TEXT PRIMARY KEY,
      vcenter_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,              -- 포탈이 읽은 시각(ms)
      at INTEGER,                       -- 게스트가 발행한 시각(ms, 없으면 NULL)
      kind TEXT NOT NULL,               -- guestinfoSource.kind ('ok'|'stale'|'no-agent'|…)
      ok INTEGER NOT NULL DEFAULT 0,
      active INTEGER, disc INTEGER, other INTEGER, sessions INTEGER,
      users TEXT NOT NULL DEFAULT '[]', -- JSON [{name,kind}] — **최신 1건만**
      error TEXT NOT NULL DEFAULT '',
      guest_host TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_latest_vc ON latest (vcenter_id);
    CREATE TABLE IF NOT EXISTS vc_series (
      vcenter_id TEXT NOT NULL,         -- '' = 전체 합계(고유 사용자 합집합)
      ts INTEGER NOT NULL,
      users INTEGER NOT NULL DEFAULT 0,
      users_active INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      sessions_active INTEGER NOT NULL DEFAULT 0,
      sessions_disc INTEGER NOT NULL DEFAULT 0,
      vms_ok INTEGER NOT NULL DEFAULT 0,
      vms_failed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (vcenter_id, ts)
    );
    -- ⚠ prune 은 \`DELETE WHERE ts<?\` 다 — **ts 단독 인덱스**가 있어야 풀스캔을 피한다
    --   (복합 PK (vcenter_id, ts) 로는 탈 수 없다. CLAUDE.md 성능 불변조건).
    CREATE INDEX IF NOT EXISTS idx_vc_series_ts ON vc_series (ts);
    CREATE TABLE IF NOT EXISTS vm_series (
      vm_id TEXT NOT NULL, ts INTEGER NOT NULL,
      sessions INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (vm_id, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_vm_series_ts ON vm_series (ts);
  `);
  return {
    upLatest: db.prepare(`INSERT INTO latest
      (vm_id, vcenter_id, name, folder, ts, at, kind, ok, active, disc, other, sessions, users, error, guest_host)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vm_id) DO UPDATE SET vcenter_id=excluded.vcenter_id, name=excluded.name, folder=excluded.folder,
        ts=excluded.ts, at=excluded.at, kind=excluded.kind, ok=excluded.ok, active=excluded.active,
        disc=excluded.disc, other=excluded.other, sessions=excluded.sessions, users=excluded.users,
        error=excluded.error, guest_host=excluded.guest_host`),
    delLatestVc: db.prepare('DELETE FROM latest WHERE vcenter_id=?'),
    allLatest: db.prepare('SELECT * FROM latest ORDER BY vcenter_id, name'),
    latestOfVc: db.prepare('SELECT * FROM latest WHERE vcenter_id=? ORDER BY name'),
    upSeries: db.prepare(`INSERT INTO vc_series
      (vcenter_id, ts, users, users_active, sessions, sessions_active, sessions_disc, vms_ok, vms_failed)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vcenter_id, ts) DO UPDATE SET users=excluded.users, users_active=excluded.users_active,
        sessions=excluded.sessions, sessions_active=excluded.sessions_active, sessions_disc=excluded.sessions_disc,
        vms_ok=excluded.vms_ok, vms_failed=excluded.vms_failed`),
    seriesOf: db.prepare('SELECT * FROM vc_series WHERE vcenter_id=? AND ts>=? AND ts<=? ORDER BY ts'),
    seriesSpan: db.prepare('SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM vc_series WHERE vcenter_id=?'),
    upVmSeries: db.prepare('INSERT INTO vm_series (vm_id, ts, sessions, active) VALUES (?,?,?,?) ON CONFLICT(vm_id, ts) DO UPDATE SET sessions=excluded.sessions, active=excluded.active'),
    vmSeriesOf: db.prepare('SELECT ts, sessions, active FROM vm_series WHERE vm_id=? AND ts>=? AND ts<=? ORDER BY ts'),
    pruneSeries: db.prepare('DELETE FROM vc_series WHERE ts < ?'),
    pruneVmSeries: db.prepare('DELETE FROM vm_series WHERE ts < ?'),
    stats: db.prepare('SELECT (SELECT COUNT(*) FROM latest) AS latestRows, (SELECT COUNT(*) FROM vc_series) AS seriesRows, (SELECT COUNT(*) FROM vm_series) AS vmSeriesRows'),
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

/** 기능 가용성 — 화면이 '비활성' 사유를 그대로 말한다(조용히 빈 화면을 만들지 않는다). */
export async function curUserDbStatus() {
  const h = await open();
  return {
    available: !!h,
    path: h ? h.path : DB_PATH(),
    error: initError ? String(initError.message || initError).slice(0, 200) : '',
    vmSeries: vmSeriesEnabled(),
    ...(h ? h.st.stats.get() : { latestRows: null, seriesRows: null, vmSeriesRows: null }),
  };
}

/**
 * 한 주기 결과를 적재(트랜잭션 1회).
 *
 * @param {object} p
 * @param {number} p.ts                 이 주기의 기준 시각(ms) — 모든 행이 같은 ts 를 쓴다
 * @param {object[]} p.records          VM 단위 결과(`collect.js` 형태)
 * @param {object[]} p.series           [{ vcenterId, ...seriesRow() }] (''=전체)
 * @param {string[]} [p.replaceVcenters] 이 vCenter 들의 latest 를 **교체**한다(대상에서 빠진 VM 정리)
 */
export async function commitCurUser({ ts, records = [], series = [], replaceVcenters = [] }) {
  const h = await open();
  if (!h) return { ok: false, reason: initError ? String(initError.message) : 'node:sqlite 없음' };
  const t = Date.now();
  h.db.exec('BEGIN');
  try {
    // 대상에서 빠진 VM(폴더 이동·삭제)의 낡은 최신값이 화면에 남지 않게 법인 단위로 교체한다.
    for (const vc of replaceVcenters) h.st.delLatestVc.run(String(vc));
    for (const r of records) {
      h.st.upLatest.run(
        String(r.vmId), String(r.vcenterId || ''), String(r.name || ''), String(r.folder || ''),
        Number(ts), r.at == null ? null : Number(r.at), String(r.kind || 'unknown'), r.ok ? 1 : 0,
        r.active == null ? null : Number(r.active), r.disc == null ? null : Number(r.disc),
        r.other == null ? null : Number(r.other), r.sessions == null ? null : Number(r.sessions),
        JSON.stringify((r.users || []).slice(0, 200)), String(r.error || '').slice(0, 300), String(r.guestHost || ''),
      );
      if (vmSeriesEnabled() && r.ok) h.st.upVmSeries.run(String(r.vmId), Number(ts), Number(r.sessions) || 0, Number(r.active) || 0);
    }
    for (const s of series) {
      h.st.upSeries.run(String(s.vcenterId || ''), Number(ts), Number(s.users) || 0, Number(s.usersActive) || 0,
        Number(s.sessions) || 0, Number(s.sessionsActive) || 0, Number(s.sessionsDisc) || 0,
        Number(s.vmsOk) || 0, Number(s.vmsFailed) || 0);
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
  return { ok: true, records: records.length, series: series.length, ms: Date.now() - t };
}

/** 최신 스냅샷(전체 또는 한 법인). `users` 는 JSON 을 푼다. */
export async function latestRecords(vcenterId = null) {
  const h = await open();
  if (!h) return [];
  const rows = vcenterId == null ? h.st.allLatest.all() : h.st.latestOfVc.all(String(vcenterId));
  return rows.map((r) => ({
    vmId: r.vm_id, vcenterId: r.vcenter_id, name: r.name, folder: r.folder,
    ts: Number(r.ts), at: r.at == null ? null : Number(r.at), kind: r.kind, ok: !!r.ok,
    active: r.active == null ? null : Number(r.active), disc: r.disc == null ? null : Number(r.disc),
    other: r.other == null ? null : Number(r.other), sessions: r.sessions == null ? null : Number(r.sessions),
    users: (() => { try { return JSON.parse(r.users); } catch { return []; } })(),
    error: r.error || '', guestHost: r.guest_host || '',
  }));
}

/** 추이 조회. `vcenterId: ''` 는 전체 합계 계열. */
export async function seriesRange(vcenterId, fromTs, toTs) {
  const h = await open();
  if (!h) return { available: false, rows: [], span: null };
  const rows = h.st.seriesOf.all(String(vcenterId ?? ''), Number(fromTs), Number(toTs)).map((r) => ({
    ts: Number(r.ts), users: r.users, usersActive: r.users_active,
    sessions: r.sessions, sessionsActive: r.sessions_active, sessionsDisc: r.sessions_disc,
    vmsOk: r.vms_ok, vmsFailed: r.vms_failed,
  }));
  const sp = h.st.seriesSpan.get(String(vcenterId ?? ''));
  return {
    available: true,
    rows,
    // ⚠ `first` 는 '수집 시작' 이 아니라 **max(수집 시작, 보존 경계)** 다 — prune 된 테이블의
    //   MIN(ts) 이므로 화면이 '기다리면 채워진다' 고 단정하면 거짓이 될 수 있다(plan D1 과 같은 유형).
    span: sp && sp.n ? { first: Number(sp.mn), last: Number(sp.mx), rows: Number(sp.n) } : null,
  };
}

export async function vmSeriesRange(vmId, fromTs, toTs) {
  const h = await open();
  if (!h || !vmSeriesEnabled()) return { available: false, rows: [] };
  return { available: true, rows: h.st.vmSeriesOf.all(String(vmId), Number(fromTs), Number(toTs)).map((r) => ({ ts: Number(r.ts), sessions: r.sessions, active: r.active })) };
}

/**
 * 보존기간 prune — **N주기에 1회만** 돈다.
 *
 * ⚠ `(++tick % N) === 0` 으로 쓸 것. `tick++ % N === 0`(tick 0 시작)은 **첫 폴에서 즉시 참**이라
 *   보존기간을 줄이고 재시작하면 첫 틱이 그 차액을 한 번에 지운다(v2.453 규칙 · v2.503 재발).
 */
export async function pruneCurUser(retentionDays, { every = 6 } = {}) {
  if ((++tick % Math.max(1, every)) !== 0) return { skipped: true };
  const days = Number(retentionDays) || 0;
  if (days <= 0) return { skipped: true, reason: '무제한' };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  const before = Date.now() - days * 86_400_000;
  let s = 0; let v = 0;
  try { s = h.st.pruneSeries.run(before)?.changes ?? 0; } catch { /* */ }
  try { v = h.st.pruneVmSeries.run(before)?.changes ?? 0; } catch { /* */ }
  return { skipped: false, series: s, vmSeries: v, before };
}

export function _resetForTest() {
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; tick = 0;
}
