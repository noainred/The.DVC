/**
 * bmusage/logs/store.js — 7a단계 로그 분석 **보관**(엣지 메인 DB `bm-usage.db` — 표 정의는 db.js openDb).
 *
 * 규약(perf-db.md · opsDb.js 와 같다): 한 주기의 서버 전부를 **한 트랜잭션**으로(서버 수만큼 쓰기 — 이벤트 루프 블로킹 방지) · 보존 정리는 청크
 *   (`rowid IN (SELECT rowid … LIMIT)` — 한 방 DELETE 금지) · 시각 단독 인덱스(log_hour.hour · log_sec.hour · log_pattern.last) · 원문 없음.
 * ⚠⚠ 읽기 위치(log_cursor)는 패턴 · 시간 집계와 **같은 트랜잭션**에서 **비교 후 쓰기**(rev — 읽을 때 본 rev 와 같을 때만):
 *   · 쓰기가 실패하면 위치가 넘어가지 않는다 → 다음 주기에 같은 줄을 다시 읽는다(세지 않은 줄이 사라지지 않는다 · 센 줄은 두 번 세지 않는다).
 *   · 늦게 끝난 옛 주기(시한을 넘긴 주기 · 수동 수집과 겹친 주기)가 같은 서버를 쓰려 하면 rev 가 달라 **그 서버를 통째로 건너뛴다**(conflicts 로 센다 — 두 번 세지 않는다).
 *   · 모든 쓰기는 이 모듈의 직렬 큐(_chain) 하나를 지난다(읽기-수정-쓰기 경쟁 — 5단계 반증 F1 과 같은 대책).
 * ⚠ 상태 JSON 이 손상(파싱 실패)이면 ‘처음 읽기’ 로 돌아가되 손상본을 bad_json 에 **보존**한다(조용히 덮지 않는다 · 화면이 cursorReset 으로 말한다).
 */
import { mainDb } from '../db.js';
import { SAMPLES_MAX, SEC_ITEMS_MAX } from './classify.js';

export const PATTERN_MAX = 500;          // 서버당 서명 수 상한 — 넘치면 분류별 ‘서명 상한 초과’ 한 행으로 묶는다(센다)
const PRUNE_CHUNK = 2_000;
const STATE_MAX = 64 * 1024;
const s64 = (v, n = 64) => String(v ?? '').slice(0, n);
const parse = (v) => { if (!v) return { ok: true, value: null }; try { return { ok: true, value: JSON.parse(v) }; } catch { return { ok: false, value: null }; } };
const json = (o, max) => { try { const j = JSON.stringify(o ?? null); return j.length > max ? null : j; } catch { return null; } };

let _chain = Promise.resolve();
/** 직렬 큐 — 커서 · 패턴 쓰기 · 정리는 한 줄로(늦게 끝난 쪽이 앞의 결과를 덮지 않게). */
export function withLogChain(fn) {
  const run = _chain.then(fn);
  _chain = run.catch(() => {});
  return run;
}
export function _resetLogStoreForTest() { _chain = Promise.resolve(); }

/**
 * 이 노드(agent)의 서버별 읽기 위치 전부(한 문장 — 주기마다 서버 수만큼 점 조회를 하지 않는다). 못 열면 null.
 * @returns {Promise<Map<string,{rev:number, at:number, state:object|null, status:object|null, corrupt:boolean}>|null>}
 */
export async function logCursorsAll({ agent = '' } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const m = new Map();
  for (const r of db.prepare('SELECT key, at, rev, state_json, status_json FROM log_cursor WHERE agent=?').all(String(agent))) {
    const st = parse(r.state_json); const ss = parse(r.status_json);
    m.set(r.key, { rev: Number(r.rev) || 0, at: Number(r.at) || 0, state: st.ok ? st.value : null, status: ss.ok ? ss.value : null, corrupt: !st.ok, ...(st.ok ? {} : { rawBad: String(r.state_json || '').slice(0, 4_096) }) });
  }
  return m;
}

/**
 * 한 주기의 로그 결과를 한 트랜잭션으로.
 * @param {{agent:string, items:Array<{key, readRev:number|null, at:number, state:object, status:object, bad?:string, patterns:Array, hours:Array, sec:Array}>}} o
 * @returns {Promise<{ok:boolean, written:number, conflicts:number, overflow:number, reason?:string}>}
 */
export function logWriteBatch({ agent = '', items = [] } = {}) {
  return withLogChain(async () => {
    const db = await mainDb();
    if (!db) return { ok: false, reason: 'db-unavailable', written: 0, conflicts: 0, overflow: 0 };
    const ag = s64(agent, 128);
    const insCur = db.prepare('INSERT INTO log_cursor (agent,key,at,rev,state_json,status_json,bad_json) VALUES (?,?,?,1,?,?,?) ON CONFLICT(agent,key) DO NOTHING');
    const updCur = db.prepare('UPDATE log_cursor SET at=?, rev=rev+1, state_json=?, status_json=?, bad_json=COALESCE(?, bad_json) WHERE agent=? AND key=? AND rev=?');
    const getPat = db.prepare('SELECT samples_json FROM log_pattern WHERE agent=? AND key=? AND sig=?');
    const cntPat = db.prepare('SELECT COUNT(*) c FROM log_pattern WHERE agent=? AND key=?');
    const upPat = db.prepare(`INSERT INTO log_pattern (agent,key,sig,cls,severity,rule_id,src,unit,tmpl,count,first,last,samples_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent,key,sig) DO UPDATE SET count=count+excluded.count, first=min(first, excluded.first), last=max(last, excluded.last),
        cls=excluded.cls, severity=excluded.severity, rule_id=excluded.rule_id, unit=excluded.unit, tmpl=excluded.tmpl, samples_json=excluded.samples_json`);
    const upHour = db.prepare('INSERT INTO log_hour (agent,key,hour,sig,cls,count) VALUES (?,?,?,?,?,?) ON CONFLICT(agent,key,hour,sig) DO UPDATE SET count=count+excluded.count');
    const hasSec = db.prepare('SELECT 1 FROM log_sec WHERE agent=? AND key=? AND hour=? AND kind=? AND item=?');
    const cntSec = db.prepare('SELECT COUNT(*) c FROM log_sec WHERE agent=? AND key=? AND hour=? AND kind=?');
    const upSec = db.prepare('INSERT INTO log_sec (agent,key,hour,kind,item,count) VALUES (?,?,?,?,?,?) ON CONFLICT(agent,key,hour,kind,item) DO UPDATE SET count=count+excluded.count');
    let written = 0; let conflicts = 0; let overflow = 0;
    db.exec('BEGIN');
    try {
      for (const it of items) {
        const key = s64(it.key, 256);
        const stJ = json(it.state || null, STATE_MAX) ?? json({ ...(it.state || {}), carry: null }, STATE_MAX);   // carry 가 넘치면 버린다(위치는 지킨다)
        const ssJ = json(it.status || null, STATE_MAX);
        const bad = it.bad ? String(it.bad).slice(0, 4_096) : null;
        const ch = it.readRev == null
          ? Number(insCur.run(ag, key, Math.round(Number(it.at) || Date.now()), stJ, ssJ, bad).changes || 0)
          : Number(updCur.run(Math.round(Number(it.at) || Date.now()), stJ, ssJ, bad, ag, key, Math.round(Number(it.readRev))).changes || 0);
        if (!ch) { conflicts += 1; continue; }   // 다른 주기가 먼저 썼다 — 이 서버의 이번 결과는 버린다(두 번 세지 않는다)
        let have = Number(cntPat.get(ag, key)?.c ?? 0);
        const fold = new Map();   // 서명 상한 초과 — 원래 서명 → 분류별 묶음 서명(시간 집계도 같은 곳으로)
        for (const p of it.patterns || []) {
          let sig = s64(p.sig, 64); let tmpl = s64(p.tmpl, 200); let ruleId = s64(p.ruleId, 40);
          let row = getPat.get(ag, key, sig);
          if (!row && have >= PATTERN_MAX) {
            overflow += Math.round(Number(p.count) || 0);
            const over = `#over:${s64(p.cls, 8)}`;
            fold.set(sig, over); sig = over; tmpl = '(서명 수 상한 초과 — 이 분류의 나머지 서명을 한 행에 묶었다)'; ruleId = '';
            row = getPat.get(ag, key, sig);
          }
          const old = parse(row?.samples_json);
          const prevS = Array.isArray(old.value) ? old.value : [];
          const merged = [...prevS, ...(p.samples || [])].filter((x) => x && typeof x.text === 'string').sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-SAMPLES_MAX)
            .map((x) => ({ ts: Math.round(Number(x.ts) || 0), text: s64(x.text, 300) }));
          upPat.run(ag, key, sig, s64(p.cls, 8), s64(p.severity, 10), ruleId, s64(p.src, 16), s64(p.unit, 64), tmpl, Math.round(Number(p.count) || 0),
            Math.round(Number(p.first) || 0), Math.round(Number(p.last) || 0), json(merged, 8_192) || '[]');
          if (!row) have += 1;
        }
        for (const h of it.hours || []) {
          const sig0 = s64(h.sig, 64);
          upHour.run(ag, key, Math.round(Number(h.hour)), fold.get(sig0) || sig0, s64(h.cls, 8), Math.round(Number(h.count) || 0));
        }
        const secCnt = new Map();
        for (const e of it.sec || []) {
          const hour = Math.round(Number(e.hour)); const kind = s64(e.kind, 16); let item = s64(e.item, 128);
          const ck = `${hour}|${kind}`;
          if (!hasSec.get(ag, key, hour, kind, item)) {
            if (!secCnt.has(ck)) secCnt.set(ck, Number(cntSec.get(ag, key, hour, kind)?.c ?? 0));
            if (secCnt.get(ck) >= SEC_ITEMS_MAX && item !== '(기타)') item = '(기타)';
            else secCnt.set(ck, secCnt.get(ck) + 1);
          }
          upSec.run(ag, key, hour, kind, item, Math.round(Number(e.count) || 0));
        }
        written += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* */ }
      return { ok: false, reason: String(e?.message || e).slice(0, 200), written: 0, conflicts, overflow };
    }
    return { ok: true, written, conflicts, overflow };
  });
}

/** 청크 삭제(표 · 열은 상수 이름만 — 외부 입력 없음). */
function chunkDelete(db, table, col, before, maxChunks = 50) {
  let total = 0;
  for (let i = 0; i < maxChunks; i++) {
    const n = Number(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`).run(Math.round(Number(before)), PRUNE_CHUNK).changes || 0);
    total += n;
    if (n < PRUNE_CHUNK) break;
  }
  return total;
}
/** 보관 정리(보관 기간 밖 시간 집계 · 보안 상위 · 마지막이 오래된 패턴) + 대상에서 사라진 서버의 읽기 위치(keys 를 주면). */
export function logPrune({ before, agent = '', keys = null } = {}) {
  return withLogChain(async () => {
    const db = await mainDb();
    if (!db) return { hours: 0, sec: 0, patterns: 0, cursors: 0 };
    const hours = chunkDelete(db, 'log_hour', 'hour', before);
    const sec = chunkDelete(db, 'log_sec', 'hour', before);
    const patterns = chunkDelete(db, 'log_pattern', 'last', before);
    let cursors = 0;
    if (Array.isArray(keys)) {
      const keep = new Set(keys.map(String));
      const gone = db.prepare('SELECT key FROM log_cursor WHERE agent=?').all(String(agent)).map((r) => r.key).filter((k) => !keep.has(k));
      if (gone.length) {
        const del = db.prepare('DELETE FROM log_cursor WHERE agent=? AND key=?');
        db.exec('BEGIN');
        try { for (const k of gone) del.run(String(agent), k); db.exec('COMMIT'); cursors = gone.length; } catch { try { db.exec('ROLLBACK'); } catch { /* */ } }
      }
    }
    return { hours, sec, patterns, cursors };
  });
}

/**
 * 서버 1대의 기간 조회(화면 · 엣지 대행이 같은 함수). 패턴 = 메타(log_pattern) + 기간 안 횟수(log_hour) · 시간 칸(분류별) · 읽은 양 · 보안 상위 · 마지막 상태.
 *   ⚠ 집계 함수 둘 이상은 PK 앞부분(agent,key,hour)으로 좁힌 문장에서만(perf-db 규약 — WHERE 없는 전체 집계 아님).
 */
export async function logServerQuery({ agent = '', key, from, to, secTop = 15 } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const ag = String(agent); const k = String(key); const f = Math.round(Number(from)); const t = Math.round(Number(to));
  const hourRows = db.prepare('SELECT hour, sig, cls, count FROM log_hour WHERE agent=? AND key=? AND hour>=? AND hour<=? ORDER BY hour').all(ag, k, f, t);
  const metas = new Map(db.prepare('SELECT sig, cls, severity, rule_id, src, unit, tmpl, count, first, last, samples_json FROM log_pattern WHERE agent=? AND key=?').all(ag, k).map((r) => [r.sig, r]));
  const secRows = db.prepare('SELECT kind, item, SUM(count) c FROM log_sec WHERE agent=? AND key=? AND hour>=? AND hour<=? GROUP BY kind, item ORDER BY c DESC LIMIT 400').all(ag, k, f, t);
  const totals = Object.fromEntries(db.prepare('SELECT kind, SUM(count) c FROM log_sec WHERE agent=? AND key=? AND hour>=? AND hour<=? GROUP BY kind').all(ag, k, f, t).map((r) => [r.kind, Number(r.c) || 0]));
  const cur = db.prepare('SELECT at, status_json, bad_json FROM log_cursor WHERE agent=? AND key=?').get(ag, k) || null;
  const st = parse(cur?.status_json);
  const sec = {};
  for (const r of secRows) { (sec[r.kind] ||= []); if (sec[r.kind].length < secTop) sec[r.kind].push({ item: r.item, count: Number(r.c) || 0 }); }
  return { hourRows, metas, sec, secTotals: totals, cursor: cur ? { at: Number(cur.at) || null, status: st.ok ? st.value : null, corruptKept: !!cur.bad_json } : null };
}

/**
 * 이 노드의 서버별 요약(최근 since 부터 — 주기마다 한 번 계산해 메모리에 둔다: 봉투 · 함대 표는 SQL 을 요청마다 돌리지 않는다).
 * @returns {Promise<Map<string, object>|null>}
 */
export async function logFleetQuery({ agent = '', since } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const ag = String(agent); const s = Math.round(Number(since));
  const rows = db.prepare('SELECT key, sig, cls, SUM(count) c, MAX(hour) h FROM log_hour WHERE agent=? AND hour>=? GROUP BY key, sig').all(ag, s);
  const metas = db.prepare('SELECT key, sig, cls, severity, rule_id, src, unit, tmpl, last, samples_json FROM log_pattern WHERE agent=? AND last>=?').all(ag, s);
  const curs = db.prepare('SELECT key, at, status_json FROM log_cursor WHERE agent=?').all(ag);
  return { rows, metas, curs: curs.map((r) => ({ key: r.key, at: Number(r.at) || null, status: parse(r.status_json).value })) };
}
