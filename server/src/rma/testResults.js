/**
 * RMA 점검 결과(중앙, v2.418) — 최신 상태(인메모리) + 이력(sqlite `rma-tests.db`) + 상태 변화 알림.
 *
 *  - 최신: key `${agentLower}\0${testId}` → { agent, instance, testId, status, reply, value, at, since(상태 유지 시작), okAt }
 *  - 이력: test_results(agent, test_id, instance, ts, status, reply, value) — 상태가 **바뀔 때 + 1시간마다 1회**만
 *    저장(diff-저장, CLAUDE.md 추이 트래킹 규약 — 30초 점검 × 수백 항목을 전량 적재하면 연 수천만 행).
 *  - 알림: ok→bad/unknown(연속 N회, 기본 2회) 시 notify(key `rma-test:${agent}:${id}`), 복구 시 해소 알림.
 *    'rma-itself' 는 하트비트로 중앙이 판정한다(evaluateRmaItself).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { notify } from '../alerts.js';

import { numOrNull } from '../util/numOrNull.js';
const FILE = () => path.join(config.dbDir || config.configDir, 'rma-tests.db');
const RETENTION_DAYS = Math.max(1, Number(process.env.RMA_TEST_HISTORY_DAYS) || 90);
const REPEAT_LOG_MS = 60 * 60_000;
const BAD_STREAK = Math.max(1, Number(process.env.RMA_TEST_ALERT_STREAK) || 2);
const PRUNE_EVERY = 50;
const latest = new Map();
let _db = null; let _tick = 0;

// v2.580(BUG-A): 진행 중인 open 을 공유한다 — `/api/central/rma-result` 는 엣지 여러 곳이 동시에 부르므로
// 첫 보고 2건이 겹치면 같은 파일에 핸들이 2개 열렸다(테스트 스윕이 잡은 7번째 모듈).
let _opening = null;
async function open() {
  if (_db) return _db === 'unavailable' ? null : _db;
  if (_opening) return _opening;
  _opening = openInner().finally(() => { _opening = null; });
  return _opening;
}
async function openInner() {
  if (_db) return _db === 'unavailable' ? null : _db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(FILE());
    // v2.447(감사 S4): DB 파일 권한 0600 — 다른 DB 모듈(idrac/metrics/logs/ipam/vmtrack/capacity/ping)은
    // 전부 적용돼 있는데 이 파일만 빠져 있었다. 같은 호스트의 다른 로컬 사용자가 읽을 수 있었다.
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS test_results (agent TEXT NOT NULL, test_id TEXT NOT NULL, instance TEXT, ts INTEGER NOT NULL, status TEXT NOT NULL, reply TEXT, value REAL);
      CREATE INDEX IF NOT EXISTS idx_tr_ts ON test_results (ts);
      CREATE INDEX IF NOT EXISTS idx_tr_key_ts ON test_results (agent, test_id, ts);`);
    _db = { conn, ins: conn.prepare('INSERT INTO test_results (agent, test_id, instance, ts, status, reply, value) VALUES (?,?,?,?,?,?,?)'),
      hist: conn.prepare('SELECT * FROM test_results WHERE agent = ? COLLATE NOCASE AND test_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?'),
      prune: conn.prepare('DELETE FROM test_results WHERE ts < ?') };
    return _db;
  } catch { _db = 'unavailable'; return null; }
}

const key = (agent, id) => `${String(agent).toLowerCase()}\0${id}`;

/**
 * 결과 반영. r = { id(스케줄 항목 id), test, name, status, reply, value, at, instance }.
 * 반환 { changed, alerted }. now 주입은 테스트용.
 */
export async function ingestResult(agent, r, { now = Date.now(), alert = true, name = '' } = {}) {
  const k = key(agent, r.id);
  const prev = latest.get(k);
  const status = ['ok', 'warn', 'bad', 'unknown'].includes(r.status) ? r.status : 'unknown';
  const at = Math.min(Number(r.at) || now, now);
  // ⚠ v2.574 BUG-08 — `value` 는 **측정값**이다(RTT·손실률·인증서 잔여일). 예전 형태는
  //   `Number(null) === 0` 이라 '값 없음' 을 **0** 으로 바꿨다. 도달 경로가 확정돼 있다 —
  //   `rma/agent.js:219` 가 실행 오류 시 `value: null` 을 보내고 `rma/tests.js:164` 는 값이
  //   없으면 `?? null` 을 준다. 같은 코드베이스가 `value == null` 을 '값 없음' 으로 정의해 두고
  //   sink 에서 0 으로 바꾸고 있었다.
  // v2.602(감사 CEN2602-04): name·test·instance 는 **글자로** 좁힌다. 스케줄 이름이 비어 있으면 엣지가 보낸 r.name 이
  //   그대로 남는데, 그것이 객체면 latestResults 의 localeCompare 가 던져 **재시작 전까지** 점검 결과 조회가 500 이었다
  //   (prev.name 으로 대물림되므로 다음 정상 보고로도 풀리지 않았다). durationMs 도 측정값이라 numOrNull.
  const txt = (v, n) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, n);
  const cur = {
    agent: String(agent), instance: txt(r.instance, 64), testId: String(r.id), test: txt(r.test, 64) || txt(prev?.test, 64), name: txt(name, 80) || txt(r.name, 80) || txt(prev?.name, 80),
    status, reply: txt(r.reply, 500), value: numOrNull(r.value), at,
    since: prev && prev.status === status ? prev.since : at,
    okAt: status === 'ok' ? at : (prev?.okAt ?? null),
    streak: prev && prev.status === status ? (prev.streak || 1) + 1 : 1,
    lastLoggedAt: prev?.lastLoggedAt || 0, alerted: prev?.alerted || false, durationMs: numOrNull(r.durationMs),
  };
  const changed = !prev || prev.status !== status;
  // 이력: 변화 시 + 1시간마다
  if (changed || now - cur.lastLoggedAt >= REPEAT_LOG_MS) {
    const db = await open();
    if (db) { try { db.ins.run(cur.agent, cur.testId, cur.instance, at, status, cur.reply, cur.value); if (++_tick % PRUNE_EVERY === 0) db.prune.run(now - RETENTION_DAYS * 86400e3); } catch { /* */ } }
    cur.lastLoggedAt = now;
  }
  // 알림: 실패 연속 N회 → 1회 발화, 복구 시 해소
  let alerted = false;
  if (alert) {
    const bad = status === 'bad' || status === 'unknown';
    if (bad && cur.streak >= BAD_STREAK && !cur.alerted) {
      cur.alerted = true; alerted = true;
      notify({ key: `rma-test:${cur.agent}:${cur.testId}`, severity: status === 'bad' ? 'critical' : 'warning',
        title: `[RMA 점검] ${cur.agent} · ${cur.name || cur.test} ${status === 'bad' ? '실패' : '불명'}`,
        detail: `${cur.reply}${cur.instance ? ` (인스턴스 ${cur.instance})` : ''}` }).catch(() => {});
    } else if (!bad && cur.alerted) {
      cur.alerted = false;
      notify({ key: `rma-test-ok:${cur.agent}:${cur.testId}`, severity: 'warning', title: `[RMA 점검] ${cur.agent} · ${cur.name || cur.test} 복구`, detail: cur.reply }).catch(() => {});
    }
  }
  latest.set(k, cur);
  return { changed, alerted, cur };
}

/** 'rma-itself' — 하트비트 기반 판정(중앙). onlineCount 0 → bad. */
export async function evaluateRmaItself(agent, itemId, { online, total, now = Date.now() }) {
  return ingestResult(agent, { id: itemId, test: 'rma-itself', status: online > 0 ? 'ok' : 'bad', reply: online > 0 ? `인스턴스 ${online}/${total} 온라인` : `온라인 인스턴스 없음(${total}개 등록)`, value: online, at: now }, { now, name: 'RMA 자체 상태' });
}

export function latestResults({ agent = '' } = {}) {
  const a = String(agent).toLowerCase();
  return [...latest.values()].filter((x) => !a || x.agent.toLowerCase() === a).sort((x, y) => String(x.agent).localeCompare(String(y.agent)) || String(x.name || x.test || '').localeCompare(String(y.name || y.test || '')));
}
export function dropResult(agent, id) { latest.delete(key(agent, id)); }

export async function testHistory(agent, id, { hours = 24, limit = 500 } = {}) {
  const db = await open();
  if (!db) return { unavailable: true, rows: [] };
  const rows = db.hist.all(String(agent), String(id), Date.now() - Math.max(1, hours) * 3600e3, Math.max(1, Math.min(5000, limit)));
  return { rows: rows.map((r) => ({ ts: r.ts, status: r.status, reply: r.reply, value: r.value, instance: r.instance })) };
}

/** 요약: 법인별 ok/warn/bad/unknown 개수. */
export function summarize(rows = latestResults()) {
  const out = {};
  for (const r of rows) { const g = out[r.agent] || (out[r.agent] = { agent: r.agent, ok: 0, warn: 0, bad: 0, unknown: 0, total: 0 }); g[r.status]++; g.total++; }
  return Object.values(out);
}

export function _resetTestResults() { latest.clear(); try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _tick = 0; }
