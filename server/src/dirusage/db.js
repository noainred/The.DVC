/**
 * dirusage/db.js — 폴더 사용량 스캔 이력 DB (`dirusage.db`, v2.454).
 *
 * 저장 정책 — **Top-N + 요약만** 저장한다(전량 저장 금지).
 * 하위 폴더가 수천 개인 공유를 매 주기 전량 적재하면 vmtrack(v2.345~2.355)이 피하려던 그 문제가
 * 그대로 재현된다: 대상 10개 × 폴더 2,000개 × 하루 1회 = 연 730만 행. Top-N(기본 20)만 남기면
 * 같은 조건에서 연 7.3만 행이고, 요약(전체 용량·폴더 수·기타 합계)이 있어 추이는 그대로 보인다.
 *
 * 정직한 한계: Top-N 밖에 있던 폴더는 나중에 커져도 **과거 값을 소급해 볼 수 없다**(그 시점 '기타'에
 * 합산돼 있을 뿐). Top-N 을 크게 잡으면 그만큼 남지만 저장량도 같이 는다.
 *
 * PRAGMA·경로·prune 은 저장소 규칙을 따른다(WAL + synchronous=NORMAL + busy_timeout, config.dbDir,
 * ts 단독 인덱스). 대량 삭제는 util/chunkedPrune 으로 끊어 이벤트 루프를 막지 않는다(v2.453 교훈).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { chunkedDelete } from '../util/chunkedPrune.js';

const DB_PATH = process.env.DIRUSAGE_DB_PATH
  || path.join(config.dbDir || config.configDir, 'dirusage.db');

let impl = null;
let ready = null;
let initError = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
    db.exec(`
      -- 스캔 1회 = 1행. entries 는 Top-N 만 담은 JSON 배열([{name,bytes}]).
      -- JSON 으로 두는 이유: 항목 수가 N(≤200)으로 유계이고 조회가 항상 '그 스캔 전체'라
      -- 정규화해도 조인만 늘 뿐 이득이 없다(vmtrack ds_series 와 달리 항목 단위 시계열 조회가 없다).
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT '',
        root TEXT NOT NULL,
        ts INTEGER NOT NULL,
        total_bytes INTEGER,           -- du 가 보고한 루트 합계(없으면 NULL)
        sum_bytes INTEGER NOT NULL DEFAULT 0,   -- 하위 폴더 합(루트 직속 파일은 빠진다)
        count INTEGER NOT NULL DEFAULT 0,       -- 하위 폴더 개수(전체)
        others_bytes INTEGER NOT NULL DEFAULT 0,
        others_count INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        entries TEXT NOT NULL DEFAULT '[]',
        mailed INTEGER NOT NULL DEFAULT 0,      -- 0=미발송 1=발송 2=발송실패
        mail_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scans_target_ts ON scans (target_id, ts);
      CREATE INDEX IF NOT EXISTS idx_scans_ts ON scans (ts);  -- prune(ts<?) 풀스캔 방지
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }

    const ins = db.prepare(`INSERT INTO scans
      (target_id, agent, root, ts, total_bytes, sum_bytes, count, others_bytes, others_count, skipped, truncated, entries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const lastFor = db.prepare('SELECT * FROM scans WHERE target_id=? ORDER BY ts DESC LIMIT 1');
    const prevFor = db.prepare('SELECT * FROM scans WHERE target_id=? AND ts<? ORDER BY ts DESC LIMIT 1');
    const listFor = db.prepare('SELECT * FROM scans WHERE target_id=? ORDER BY ts DESC LIMIT ?');
    const byId = db.prepare('SELECT * FROM scans WHERE id=?');
    const latestAll = db.prepare(`SELECT s.* FROM scans s
      JOIN (SELECT target_id, MAX(ts) mts FROM scans GROUP BY target_id) m
        ON s.target_id=m.target_id AND s.ts=m.mts`);
    const setMail = db.prepare('UPDATE scans SET mailed=?, mail_note=? WHERE id=?');
    const pruneStmt = db.prepare('DELETE FROM scans WHERE rowid IN (SELECT rowid FROM scans WHERE ts < ? LIMIT ?)');

    const hydrate = (r) => (r ? { ...r, truncated: !!r.truncated, entries: safeJson(r.entries) } : null);

    return {
      kind: 'sqlite',
      path: DB_PATH,
      insertScan(rec) {
        const r = ins.run(rec.targetId, rec.agent || '', rec.root, rec.ts,
          rec.totalBytes == null ? null : Math.round(rec.totalBytes),
          Math.round(rec.sumBytes || 0), rec.count || 0,
          Math.round(rec.othersBytes || 0), rec.othersCount || 0,
          rec.skipped || 0, rec.truncated ? 1 : 0,
          JSON.stringify(rec.entries || []));
        return Number(r.lastInsertRowid);
      },
      /** 이 대상의 가장 최근 스캔. */
      last(targetId) { return hydrate(lastFor.get(String(targetId))); },
      /** ts 직전 스캔 — 증감 계산의 기준선. */
      prev(targetId, ts) { return hydrate(prevFor.get(String(targetId), Number(ts))); },
      list(targetId, limit = 50) { return listFor.all(String(targetId), Math.max(1, Math.min(1000, limit))).map(hydrate); },
      get(id) { return hydrate(byId.get(Number(id))); },
      latestAll() { return latestAll.all().map(hydrate); },
      markMailed(id, state, note = '') { setMail.run(Number(state) || 0, String(note || '').slice(0, 500), Number(id)); },
      async prune(beforeTs) {
        const r = await chunkedDelete(pruneStmt, [Number(beforeTs)], { label: 'dirusage.scans' });
        if (r.deleted > 0) console.log(`[dirusage] 이력 prune ${r.deleted.toLocaleString()}행 삭제`);
        return r.deleted;
      },
    };
  });
}

function safeJson(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }

/** DB 핸들. node:sqlite 가 없으면 null 을 돌려주고 상태로 정직하게 보고한다. */
export async function getDb() {
  if (impl) return impl;
  if (!ready) {
    ready = initSqlite().then((d) => { impl = d; return d; }).catch((e) => {
      initError = e.message;
      console.warn(`[dirusage] SQLite 초기화 실패 — 이력 저장이 비활성됩니다: ${e.message}`);
      return null;
    });
  }
  return ready;
}

export function dbStatus() {
  return { available: !!impl, path: DB_PATH, error: initError };
}
