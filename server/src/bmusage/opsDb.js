/**
 * bmusage/opsDb.js — 5단계(v2.929 예정) 보관: **집중 모니터링**(focus_session · focus_sample) · **변경 이벤트**(change_event · change_latest).
 *   표 정의는 db.js openDb(메인 파일 `bm-usage.db` — 기간 파일이 아니다: 행이 적고 30일 보관이라 파일 삭제 대신 청크 DELETE).
 *
 * ⚠ 설계와 다른 결정(PROFILES §13): focus_sample 의 지표는 열 30개가 아니라 **JSON 한 칸**(분 × {평균, 피크})이다 — 세션당 행이 10개 안팎이고
 *   SQL 로 집계하지 않는다(그리는 쪽이 한 세션을 통째로 읽는다). 지표를 더할 때 마이그레이션이 필요 없다. 길이 상한(VALS_MAX · SNAP_MAX)을 둔다.
 * ⚠ 보존 정리는 청크(`rowid IN (SELECT rowid … LIMIT)`) · 시각 단독 인덱스(created · minute_ts · ts) — 한 방 DELETE 금지(audit2603c 스윕).
 * ⚠ 변경 이벤트에 **내용을 넣지 않는다** — before/after 는 짧은 값(커널 릴리스 · CRC 앞 8자 · 개수 · 프로파일 이름 · 화이트리스트 sysctl 값)뿐(changes.js).
 */
import { mainDb } from './db.js';

export const VALS_MAX = 16 * 1024;
export const SNAP_MAX = 16 * 1024;
export const SUMMARY_MAX = 32 * 1024;
const PRUNE_CHUNK = 2_000;
const s64 = (v, n = 64) => String(v ?? '').slice(0, n);
const json = (o, max) => { try { const j = JSON.stringify(o ?? null); return j.length > max ? JSON.stringify({ truncated: true, bytes: j.length }) : j; } catch { return null; } };
const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

/* ── 집중 모니터링 ───────────────────────────────────────────────────────── */
const sessRow = (r, withSummary = true) => r && ({
  id: String(r.id), agent: r.agent || '', key: String(r.key), vcenterId: r.vcenter_id || '', trigger: r.trigger_kind || '', rule: r.rule || '',
  by: r.by_user || '', reason: r.reason || '', created: Number(r.created), start: r.start == null ? null : Number(r.start), end: r.end == null ? null : Number(r.end),
  intervalS: Number(r.interval_s) || 0, count: Number(r.count) || 0, done: Number(r.done) || 0, missOs: Number(r.miss_os) || 0, missIdrac: Number(r.miss_idrac) || 0,
  status: r.status, ...(withSummary ? { summary: parse(r.summary_json) } : {}),
});
export async function focusStoreAvailable() { return !!(await mainDb()); }
export async function focusInsert(s) {
  const db = await mainDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  db.prepare(`INSERT INTO focus_session (id,agent,key,vcenter_id,trigger_kind,rule,by_user,reason,created,start,end,interval_s,count,done,miss_os,miss_idrac,status,summary_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?,?)`).run(String(s.id), s64(s.agent, 128), s64(s.key, 256), s64(s.vcenterId, 128), s64(s.trigger, 16), s64(s.rule, 32),
    s64(s.by, 64), s64(s.reason, 300), Math.round(Number(s.created)), s.start == null ? null : Math.round(Number(s.start)), null, Math.round(Number(s.intervalS)), Math.round(Number(s.count)),
    s64(s.status, 16), json(s.summary || null, SUMMARY_MAX));
  return { ok: true };
}
/** 머리 갱신(아는 칸만). */
export async function focusUpdate(id, patch = {}) {
  const db = await mainDb();
  if (!db) return { ok: false };
  const cols = []; const vals = [];
  const set = (c, v) => { cols.push(`${c}=?`); vals.push(v); };
  if (patch.start !== undefined) set('start', patch.start == null ? null : Math.round(Number(patch.start)));
  if (patch.end !== undefined) set('end', patch.end == null ? null : Math.round(Number(patch.end)));
  if (patch.done !== undefined) set('done', Math.round(Number(patch.done) || 0));
  if (patch.missOs !== undefined) set('miss_os', Math.round(Number(patch.missOs) || 0));
  if (patch.missIdrac !== undefined) set('miss_idrac', Math.round(Number(patch.missIdrac) || 0));
  if (patch.status !== undefined) set('status', s64(patch.status, 16));
  if (patch.summary !== undefined) set('summary_json', json(patch.summary, SUMMARY_MAX));
  if (!cols.length) return { ok: true };
  db.prepare(`UPDATE focus_session SET ${cols.join(',')} WHERE id=?`).run(...vals, String(id));
  return { ok: true };
}
export async function focusGet(id) {
  const db = await mainDb();
  if (!db) return null;
  return sessRow(db.prepare('SELECT * FROM focus_session WHERE id=?').get(String(id))) || null;
}
/** 한 서버의 세션 목록(최근순 · 보관 기간 안). */
export async function focusList({ key, agent = null, since = 0, limit = 60 } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 60)));
  const rows = agent == null
    ? db.prepare('SELECT * FROM focus_session WHERE key=? AND created>=? ORDER BY created DESC LIMIT ?').all(String(key), Math.round(Number(since) || 0), lim)
    : db.prepare('SELECT * FROM focus_session WHERE key=? AND agent=? AND created>=? ORDER BY created DESC LIMIT ?').all(String(key), String(agent), Math.round(Number(since) || 0), lim);
  return rows.map((r) => sessRow(r, true));
}
/** 이 노드의 최근 세션(함대 칩 · 봉투 요약) — 진행 중 · 대기 + 기간 안 끝난 것. */
export async function focusRecent({ agent = '', since = 0, limit = 300 } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const lim = Math.max(1, Math.min(2_000, Math.floor(Number(limit) || 300)));
  return db.prepare("SELECT * FROM focus_session WHERE agent=? AND (created>=? OR status IN ('running','queued')) ORDER BY created DESC LIMIT ?")
    .all(String(agent), Math.round(Number(since) || 0), lim).map((r) => sessRow(r, true));
}
/** 재시작 때 남은 진행 중 · 대기 세션(타이머가 사라졌다) — 'interrupted' 로 닫는다. */
export async function focusCloseOrphans({ agent = '', now = Date.now() } = {}) {
  const db = await mainDb();
  if (!db) return 0;
  return Number(db.prepare("UPDATE focus_session SET status='interrupted', end=COALESCE(end, ?) WHERE agent=? AND status IN ('running','queued')").run(Math.round(now), String(agent)).changes || 0);
}
/** 법인(vCenter)별 24시간 자동 집중 수(하루 상한) — 진행 중 포함. */
export async function focusCountSince({ vcenterId = '', since = 0, trigger = null } = {}) {
  const db = await mainDb();
  if (!db) return null;
  return trigger
    ? Number(db.prepare('SELECT COUNT(*) c FROM focus_session WHERE vcenter_id=? AND created>=? AND trigger_kind=?').get(String(vcenterId), Math.round(Number(since)), String(trigger))?.c ?? 0)
    : Number(db.prepare('SELECT COUNT(*) c FROM focus_session WHERE vcenter_id=? AND created>=?').get(String(vcenterId), Math.round(Number(since)))?.c ?? 0);
}
export async function focusSampleInsert(sample) {
  const db = await mainDb();
  if (!db) return { ok: false };
  db.prepare(`INSERT OR REPLACE INTO focus_sample (session_id,idx,minute_ts,os_ok,idrac_ok,verdict,miss_os,miss_idrac,vals_json,snap_json) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(String(sample.sessionId), Math.round(Number(sample.idx)), Math.round(Number(sample.minuteTs)), sample.osOk ? 1 : 0, sample.idracOk ? 1 : sample.idracOk === false ? 0 : null,
      s64(sample.verdict, 16) || null, s64(sample.missOs, 32) || null, s64(sample.missIdrac, 32) || null, json(sample.vals || {}, VALS_MAX), json(sample.snap || null, SNAP_MAX));
  return { ok: true };
}
export async function focusSamples(sessionId) {
  const db = await mainDb();
  if (!db) return null;
  return db.prepare('SELECT * FROM focus_sample WHERE session_id=? ORDER BY idx').all(String(sessionId)).map((r) => ({
    idx: Number(r.idx), minuteTs: Number(r.minute_ts), osOk: r.os_ok === 1, idracOk: r.idrac_ok == null ? null : r.idrac_ok === 1, verdict: r.verdict || null,
    missOs: r.miss_os || null, missIdrac: r.miss_idrac || null, vals: parse(r.vals_json) || {}, snap: parse(r.snap_json),
  }));
}
/** 서버 1대의 기간 안 표본(추이 탭 1분 점 · 구간 비교의 프로세스) — 세션 머리와 함께. */
export async function focusSamplesInRange({ key, agent = '', from, to, limit = 2_000 } = {}) {
  const db = await mainDb();
  if (!db) return null;
  return db.prepare(`SELECT s.session_id, s.idx, s.minute_ts, s.os_ok, s.verdict, s.vals_json, s.snap_json FROM focus_sample s JOIN focus_session h ON h.id = s.session_id
    WHERE h.key=? AND h.agent=? AND s.minute_ts>=? AND s.minute_ts<=? ORDER BY s.minute_ts LIMIT ?`)
    .all(String(key), String(agent), Math.round(Number(from)), Math.round(Number(to)), Math.max(1, Math.min(20_000, Number(limit) || 2_000)))
    .map((r) => ({ sessionId: r.session_id, idx: Number(r.idx), minuteTs: Number(r.minute_ts), osOk: r.os_ok === 1, verdict: r.verdict || null, vals: parse(r.vals_json) || {}, snap: parse(r.snap_json) }));
}
/** 청크 삭제 한 번 — 표 · 시각 열 · 기준(상수 이름만 — 외부 입력 없음). */
function chunkDelete(db, table, col, before, maxChunks = 50) {
  let total = 0;
  for (let i = 0; i < maxChunks; i++) {
    const n = Number(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`).run(Math.round(Number(before)), PRUNE_CHUNK).changes || 0);
    total += n;
    if (n < PRUNE_CHUNK) break;
  }
  return total;
}
/** 집중 보관 정리 — 보관 기간 밖 세션과 그 표본(표본은 시각 기준으로 따로 — 고아가 남지 않게). 진행 중 · 대기는 지우지 않는다. */
export async function focusPrune({ before }) {
  const db = await mainDb();
  if (!db) return { sessions: 0, samples: 0 };
  const samples = chunkDelete(db, 'focus_sample', 'minute_ts', before);
  let sessions = 0;
  for (let i = 0; i < 50; i++) {
    const n = Number(db.prepare("DELETE FROM focus_session WHERE rowid IN (SELECT rowid FROM focus_session WHERE created < ? AND status NOT IN ('running','queued') LIMIT ?)").run(Math.round(Number(before)), PRUNE_CHUNK).changes || 0);
    sessions += n;
    if (n < PRUNE_CHUNK) break;
  }
  return { sessions, samples };
}

/* ── 변경 이벤트 ─────────────────────────────────────────────────────────── */
export async function changeLatestGet({ agent = '', key }) {
  const db = await mainDb();
  if (!db) return { ok: false };
  const r = db.prepare('SELECT at, facts_json FROM change_latest WHERE agent=? AND key=?').get(String(agent), String(key));
  return { ok: true, at: r ? Number(r.at) : null, facts: r ? parse(r.facts_json) : null };
}
/** 이 노드(agent)의 서버별 직전 사실 전부(한 문장 — 주기마다 서버 수만큼 점 조회를 하지 않는다). 못 열면 null. */
export async function changeLatestAll({ agent = '' } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const m = new Map();
  for (const r of db.prepare('SELECT key, at, facts_json FROM change_latest WHERE agent=?').all(String(agent))) m.set(r.key, { at: Number(r.at), facts: parse(r.facts_json) });
  return m;
}
/** 한 주기의 변경 사실 최신값 · 이벤트를 **한 트랜잭션**으로(서버 수만큼 쓰기 — 이벤트 루프 블로킹 방지 규약). */
export async function changeWriteBatch({ agent = '', items = [], latest = true } = {}) {
  const db = await mainDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  const putL = db.prepare('INSERT OR REPLACE INTO change_latest (agent,key,at,facts_json) VALUES (?,?,?,?)');
  const putE = db.prepare('INSERT INTO change_event (agent,key,ts,kind,item,before_v,after_v) VALUES (?,?,?,?,?,?,?)');
  let events = 0;
  db.exec('BEGIN');
  try {
    for (const it of items) {
      if (latest) putL.run(String(agent), s64(it.key, 256), Math.round(Number(it.at)), json(it.facts || null, 64 * 1024));
      for (const e of it.events || []) {
        putE.run(String(agent), s64(it.key, 256), Math.round(Number(e.ts ?? it.at)), s64(e.kind, 24), s64(e.item, 96), e.before == null ? null : s64(e.before, 120), e.after == null ? null : s64(e.after, 120));
        events += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } return { ok: false, reason: String(e?.message || e).slice(0, 200) }; }
  return { ok: true, events };
}
export async function changeEventsRange({ key, agent = '', from, to, limit = 500 } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const lim = Math.max(1, Math.min(5_000, Math.floor(Number(limit) || 500)));
  const rows = db.prepare('SELECT id,ts,kind,item,before_v,after_v FROM change_event WHERE key=? AND agent=? AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT ?')
    .all(String(key), String(agent), Math.round(Number(from)), Math.round(Number(to)), lim + 1);
  const truncated = rows.length > lim;
  return { rows: rows.slice(0, lim).reverse().map((r) => ({ id: Number(r.id), ts: Number(r.ts), kind: r.kind, item: r.item || '', before: r.before_v, after: r.after_v })), truncated };
}
export async function changePrune({ before }) {
  const db = await mainDb();
  if (!db) return 0;
  return chunkDelete(db, 'change_event', 'ts', before);
}
/** 대상에서 사라진 서버의 최신 사실(서버당 1행)을 지운다 — 등록부에서 빠진 서버가 영원히 남지 않게(인메모리 맵 규약의 DB 판). */
export async function changeLatestKeep({ agent = '', keys = [] } = {}) {
  const db = await mainDb();
  if (!db) return 0;
  const keep = new Set(keys.map(String));
  const all = db.prepare('SELECT key FROM change_latest WHERE agent=?').all(String(agent)).map((r) => r.key);
  const gone = all.filter((k) => !keep.has(k));
  if (!gone.length) return 0;
  const del = db.prepare('DELETE FROM change_latest WHERE agent=? AND key=?');
  db.exec('BEGIN');
  try { for (const k of gone) del.run(String(agent), k); db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch { /* */ } return 0; }
  return gone.length;
}
