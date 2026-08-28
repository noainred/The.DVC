/**
 * DB 정합성·일관성 점검(v2.378) — 포탈이 쓰는 SQLite 파일의 상태를 **읽기 전용**으로 진단한다.
 *
 * 무엇을 보나
 *  - integrity_check / quick_check : 페이지·인덱스 손상 여부(SQLite 공식 진단)
 *  - foreign_key_check             : FK 위반 행(스키마에 FK 가 없으면 항상 통과)
 *  - journal_mode / synchronous    : 저널 설정이 이 저장소 규약과 맞는지
 *                                    (metrics·idrac·logs 는 WAL, ipam.db 는 WAL 금지 — 외부 리더 공유)
 *  - page_count / freelist_count   : 단편화(빈 페이지 비율) — VACUUM 필요 여부 판단 근거
 *  - 테이블별 행 수 · 인덱스 목록 · 스키마(DDL) · 데이터 기간(ts/h 컬럼 min~max)
 *
 * 안전 원칙(중요)
 *  - **읽기 전용으로 연다**(readOnly). 점검이 데이터를 바꾸거나 잠그지 않는다.
 *  - integrity_check 는 전 페이지를 읽으므로 **큰 DB 에서 수 초 이상 걸릴 수 있다** →
 *    기본은 quick_check(가벼움)이고, full 은 사용자가 명시적으로 요청할 때만 수행한다.
 *  - 행 수는 COUNT(*) 라 대형 테이블에서 비싸다 → 파일 크기 상한(기본 512MB) 초과 DB 는
 *    행 수 집계를 건너뛰고 그 사실을 응답에 표기한다(추정치를 지어내지 않는다).
 *  - 어떤 실패도 다른 DB 점검을 막지 않는다(파일별 격리).
 */

import fs from 'node:fs';
import path from 'node:path';

// COUNT(*) 를 수행할 파일 크기 상한 — 초과 시 rowCount 는 null 이고 skipped 이유를 남긴다.
const COUNT_MAX_BYTES = Number(process.env.DB_HEALTH_COUNT_MAX_BYTES) || 512 * 1024 * 1024;
// full(integrity_check) 는 전 페이지를 동기로 읽어 **파일 크기에 비례해 이벤트 루프를 정지**시킨다
// (node:sqlite 는 동기 API — GB 급 DB 면 수 초 이상 전체 API·폴러가 멈춘다). 상한 초과 시
// quick_check 로 강등하고 그 사실을 skipped 로 알린다(추정치를 지어내지 않는다).
const FULL_MAX_BYTES = Number(process.env.DB_HEALTH_FULL_MAX_BYTES) || 256 * 1024 * 1024;

/** 이 저장소 규약: ipam.db 는 외부 프로그램이 직접 읽어 WAL 금지, 나머지 시계열 DB 는 WAL 권장. */
const EXPECT_WAL = (file) => !/^ipam\.db$/i.test(file);

async function loadSqlite() {
  try {
    // eslint-disable-next-line import/no-unresolved
    return await import('node:sqlite');
  } catch { return null; }
}

const first = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const val = (row) => (row ? Object.values(row)[0] : null);

/**
 * SQLite 파일 1개 점검. { ok, file, checks, tables, ... }
 * @param {string} absPath .db 절대 경로
 * @param {{ full?: boolean }} opts full=true 면 integrity_check(전체), 아니면 quick_check
 */
export async function inspectSqlite(absPath, { full = false } = {}) {
  const file = path.basename(absPath);
  const out = {
    file, path: absPath, ok: false, error: null,
    sizeBytes: null, walBytes: null,
    checks: {}, pragmas: {}, tables: [], indexes: [], warnings: [], skipped: [],
  };
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(absPath).size; out.sizeBytes = sizeBytes; } catch { out.error = '파일 없음'; return out; }
  try { out.walBytes = fs.statSync(`${absPath}-wal`).size; } catch { out.walBytes = 0; }

  const mod = await loadSqlite();
  if (!mod) { out.error = 'node:sqlite 미지원 런타임'; return out; }

  let db = null;
  try {
    // 읽기 전용 — 점검이 데이터를 수정하거나 스키마를 만들지 않게 한다.
    db = new mod.DatabaseSync(absPath, { readOnly: true });
    // busy_timeout 없이는 쓰기와 겹치는 순간 SQLITE_BUSY 즉시 실패 → 'database is locked' 가
    // 정합성 실패로 보고되어 **손상 오탐**이 된다(특히 DELETE 저널인 ipam.db).
    try { db.exec('PRAGMA busy_timeout=3000'); } catch { /* 구버전 폴백 */ }
  } catch (e) {
    out.error = `열기 실패: ${e.message}`;
    return out;
  }
  const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return { __err: e.message }; } };

  try {
    // ── 정합성 ────────────────────────────────────────────────────────
    // 크기 상한 초과면 full 요청이라도 quick 으로 강등(이벤트 루프 보호).
    const fullOk = full && sizeBytes <= FULL_MAX_BYTES;
    if (full && !fullOk) out.skipped.push(`전체 점검 생략 — 파일이 ${Math.round(sizeBytes / 1048576)}MB(상한 ${Math.round(FULL_MAX_BYTES / 1048576)}MB) 로 동기 스캔이 이벤트 루프를 막음 → 빠른 점검으로 대체`);
    const chkSql = fullOk ? 'PRAGMA integrity_check' : 'PRAGMA quick_check';
    const chk = q(chkSql);
    if (chk?.__err) out.checks.integrity = { mode: fullOk ? 'full' : 'quick', ok: false, detail: chk.__err };
    else {
      const msgs = chk.map((r) => String(val(r))).filter(Boolean);
      const good = msgs.length === 1 && /^ok$/i.test(msgs[0]);
      out.checks.integrity = { mode: fullOk ? 'full' : 'quick', ok: good, detail: good ? 'ok' : msgs.slice(0, 20).join(' | ') };
      if (!good) out.warnings.push(`정합성 점검 실패(${fullOk ? 'integrity_check' : 'quick_check'}) — 백업 후 복구 필요`);
    }

    const fk = q('PRAGMA foreign_key_check');
    if (fk?.__err) out.checks.foreignKeys = { ok: false, violations: null, detail: fk.__err };
    else {
      out.checks.foreignKeys = { ok: fk.length === 0, violations: fk.length, detail: fk.length ? `${fk.length}건 위반` : '위반 없음' };
      if (fk.length) out.warnings.push(`외래키 위반 ${fk.length}건`);
    }

    // ── PRAGMA 설정/단편화 ────────────────────────────────────────────
    const jm = String(val(first(q('PRAGMA journal_mode'))) || '').toLowerCase();
    const sync = val(first(q('PRAGMA synchronous')));
    const pageCount = Number(val(first(q('PRAGMA page_count'))) || 0);
    const pageSize = Number(val(first(q('PRAGMA page_size'))) || 0);
    const freelist = Number(val(first(q('PRAGMA freelist_count'))) || 0);
    const fragPct = pageCount > 0 ? Math.round((freelist / pageCount) * 100) : 0;
    out.pragmas = {
      journalMode: jm, synchronous: sync, pageCount, pageSize, freelistCount: freelist,
      fragmentationPct: fragPct, reclaimableBytes: freelist * pageSize,
    };
    // 규약 대조 — 되돌리면 성능/외부호환이 깨지는 설정이라 어긋나면 알린다.
    const wantWal = EXPECT_WAL(file);
    if (wantWal && jm && jm !== 'wal') out.warnings.push(`저널 모드가 ${jm} — 이 DB 는 WAL 권장(쓰기 지연·읽기 병행)`);
    if (!wantWal && jm === 'wal') out.warnings.push('ipam.db 가 WAL 이다 — 외부 프로그램이 -wal/-shm 을 못 읽을 수 있어 기본 저널 유지가 규약');
    if (fragPct >= 25) out.warnings.push(`빈 페이지 ${fragPct}% — VACUUM 으로 ${Math.round((freelist * pageSize) / 1048576)}MB 회수 가능(쓰기 잠금 발생, 유지보수 시간에 권장)`);

    // ── 테이블·인덱스·행 수·데이터 기간 ──────────────────────────────
    const tbls = q("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const idxs = q("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name");
    out.indexes = Array.isArray(idxs) ? idxs.map((r) => ({ name: r.name, table: r.tbl_name, sql: r.sql || '(자동)' })) : [];

    const countable = sizeBytes <= COUNT_MAX_BYTES;
    if (!countable) out.skipped.push(`행 수 집계 생략 — 파일이 ${Math.round(sizeBytes / 1048576)}MB(상한 ${Math.round(COUNT_MAX_BYTES / 1048576)}MB) 로 COUNT(*) 가 비쌈`);

    for (const t of (Array.isArray(tbls) ? tbls : [])) {
      const cols = q(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`);
      const colNames = Array.isArray(cols) ? cols.map((c) => c.name) : [];
      let rowCount = null;
      if (countable) {
        const c = q(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`);
        rowCount = c?.__err ? null : Number(val(first(c)) || 0);
      }
      // 데이터 기간 — 시계열 관례상 ts(ms) 또는 h(시간 버킷) 컬럼을 쓴다.
      let range = null;
      const tsCol = colNames.includes('ts') ? 'ts' : colNames.includes('h') ? 'h' : null;
      if (tsCol) {
        const r = q(`SELECT MIN("${tsCol}") AS mn, MAX("${tsCol}") AS mx FROM "${t.name.replace(/"/g, '""')}"`);
        const row = r?.__err ? null : first(r);
        if (row && row.mn != null) range = { column: tsCol, firstTs: Number(row.mn), lastTs: Number(row.mx) };
      }
      out.tables.push({
        name: t.name, sql: t.sql || '', columns: colNames, rowCount, range,
        indexCount: out.indexes.filter((i) => i.table === t.name).length,
      });
    }
    out.ok = out.checks.integrity?.ok !== false && out.checks.foreignKeys?.ok !== false;
  } catch (e) {
    out.error = e.message;
  } finally {
    try { db.close(); } catch { /* 이미 닫힘 */ }
  }
  return out;
}

/**
 * 여러 SQLite 파일을 순차 점검. 파일별 실패는 격리한다.
 * 순차로 도는 이유: integrity_check 는 디스크를 많이 읽어 동시에 돌리면 I/O 가 몰린다.
 */
export async function inspectMany(absPaths, { full = false } = {}) {
  const results = [];
  for (const p of absPaths) {
    try { results.push(await inspectSqlite(p, { full })); }
    catch (e) { results.push({ file: path.basename(p), path: p, ok: false, error: e.message, checks: {}, tables: [], indexes: [], warnings: [], skipped: [] }); }
    // 파일 사이에 이벤트 루프 양보 — 큰 DB 연속 점검이 폴링/요청을 굶기지 않게.
    await new Promise((r) => setImmediate(r));
  }
  const warnings = results.reduce((n, r) => n + (r.warnings?.length || 0), 0);
  return {
    generatedAt: Date.now(), mode: full ? 'full' : 'quick',
    count: results.length,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
    warningCount: warnings,
    results,
  };
}
