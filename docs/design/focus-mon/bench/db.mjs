// 1분 묶음 저장의 SQLite 비용 — node:sqlite(이 포탈과 같은 동기 API) · WAL · 합성 묶음(8KB · 2KB).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
const file = process.argv[2]; for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch { /* */ } }
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
db.exec(`CREATE TABLE fm_metric (target INTEGER NOT NULL, minute INTEGER NOT NULL, res INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (target, minute));
CREATE INDEX fm_metric_minute ON fm_metric(minute);
CREATE TABLE fm_proc (target INTEGER NOT NULL, minute INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (target, minute));
CREATE INDEX fm_proc_minute ON fm_proc(minute);`);
const TARGETS = 20; const MINUTES = Number(process.argv[3] || 3000);
const blob8 = () => crypto.randomBytes(8000 + Math.floor(Math.random() * 500));   // 압축된 묶음은 사실상 난수다
const blob2 = () => crypto.randomBytes(1900);
const insM = db.prepare('INSERT OR REPLACE INTO fm_metric (target, minute, res, n, data) VALUES (?, ?, 2, 30, ?)');
const insP = db.prepare('INSERT OR REPLACE INTO fm_proc (target, minute, data) VALUES (?, ?, ?)');
const lat = [];
const t0 = performance.now();
for (let m = 0; m < MINUTES; m++) {
  const blobs = []; for (let t = 0; t < TARGETS; t++) blobs.push([blob8(), blob2()]);
  const s = performance.now();
  db.exec('BEGIN');
  for (let t = 0; t < TARGETS; t++) { insM.run(t, m, blobs[t][0]); insP.run(t, m, blobs[t][1]); }
  db.exec('COMMIT');
  lat.push(performance.now() - s);
}
const total = performance.now() - t0;
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(2);
console.log(`쓰기: 1분치(서버 20대 · 지표 20줄 + 프로세스 20줄)를 한 트랜잭션으로 — 중앙값 ${pct(0.5)}ms · p99 ${pct(0.99)}ms · 최대 ${lat[lat.length - 1].toFixed(2)}ms (${MINUTES}분치, 전체 ${(total / 1000).toFixed(1)}초)`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const size = fs.statSync(file).size;
console.log(`파일: ${(size / 1048576).toFixed(0)}MB / 줄 ${TARGETS * MINUTES * 2}개 → 1분 · 서버 1대당 ${(size / (TARGETS * MINUTES) / 1024).toFixed(2)}KB(인덱스 · 페이지 여분 포함, 원본 9.9KB)`);
const selM = db.prepare('SELECT minute, data FROM fm_metric WHERE target = ? AND minute >= ? AND minute < ? ORDER BY minute');
const bench = (label, win, targets) => { const ts = []; for (let r = 0; r < 40; r++) { const start = Math.floor(Math.random() * (MINUTES - win)); const s = performance.now(); let bytes = 0; for (let t = 0; t < targets; t++) for (const row of selM.all(t, start, start + win)) bytes += row.data.length; ts.push(performance.now() - s); } ts.sort((a, b) => a - b); console.log(`읽기 ${label}: 중앙값 ${ts[20].toFixed(2)}ms · 최대 ${ts[39].toFixed(2)}ms`); };
bench('서버 1대 × 5분 구간(5줄)', 5, 1);
bench('서버 1대 × 30분 구간(30줄)', 30, 1);
bench('서버 20대 × 5분 구간(100줄)', 5, 20);
bench('서버 20대 × 30분 구간(600줄 · 약 4.9MB)', 30, 20);
const delM = db.prepare('DELETE FROM fm_metric WHERE rowid IN (SELECT rowid FROM fm_metric WHERE minute < ? LIMIT 500)');
const s = performance.now(); const r = delM.run(60); const d1 = performance.now() - s;
console.log(`정리: 오래된 줄 500개 한 조각 삭제 ${d1.toFixed(2)}ms (지운 줄 ${r.changes})`);
const plan = db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM fm_metric WHERE minute < ? LIMIT 500').all(60).map((x) => x.detail).join(' | ');
console.log('정리 실행 계획:', plan);
db.close(); for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch { /* */ } }
