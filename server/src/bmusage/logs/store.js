/**
 * bmusage/logs/store.js — 7a단계 로그 분석 **보관**(엣지 메인 DB `bm-usage.db` — 표 정의는 db.js openDb).
 *
 * 규약(perf-db.md · opsDb.js 와 같다): 한 주기의 서버들을 **묶음 트랜잭션**으로(서버마다 커밋하지 않는다) · 보존 정리는 청크
 *   (`rowid IN (SELECT rowid … LIMIT)` — 한 방 DELETE 금지 · util/chunkedPrune.js chunkedDelete — 청크 사이 양보) · 시각 단독 인덱스(log_hour.hour · log_sec.hour · log_pattern.last) · 원문 없음.
 *   v2.954(점검 C-1): 예전에는 주기의 서버 **전부**를 한 동기 트랜잭션으로 써서 1,000대 첫 읽기에서 이벤트 루프가 1.2~1.4초 멈췄다(실측).
 *   지금은 서버 단위(원자 단위 — 커서 비교 후 쓰기 · 패턴 · 시간 · 보안이 한 서버 안에서 같이 들어가거나 같이 빠진다)로 묶어,
 *   묶음이 sliceMs 를 넘으면 COMMIT → 양보(createYielder) → 다음 묶음 BEGIN. ⚠ 양보 동안 트랜잭션을 열어 두지 않는다
 *   (같은 연결을 쓰는 다른 모듈의 BEGIN 이 ‘트랜잭션 안의 트랜잭션’ 으로 깨진다). 묶음 하나가 실패하면 그 묶음만 되돌리고
 *   앞 묶음(이미 커밋)은 writtenKeys 로 알린다(호출부가 그 서버들의 알림 입력만 남긴다).
 * ⚠⚠ 읽기 위치(log_cursor)는 패턴 · 시간 집계와 **같은 트랜잭션**에서 **비교 후 쓰기**(rev — 읽을 때 본 rev 와 같을 때만):
 *   · 쓰기가 실패하면 위치가 넘어가지 않는다 → 다음 주기에 같은 줄을 다시 읽는다(세지 않은 줄이 사라지지 않는다 · 센 줄은 두 번 세지 않는다).
 *   · 늦게 끝난 옛 주기(시한을 넘긴 주기 · 수동 수집과 겹친 주기)가 같은 서버를 쓰려 하면 rev 가 달라 **그 서버를 통째로 건너뛴다**(conflicts 로 센다 — 두 번 세지 않는다).
 *   · 모든 쓰기는 이 모듈의 직렬 큐(_chain) 하나를 지난다(읽기-수정-쓰기 경쟁 — 5단계 반증 F1 과 같은 대책).
 * ⚠ 상태 JSON 이 손상(파싱 실패)이면 ‘처음 읽기’ 로 돌아가되 손상본을 bad_json 에 **보존**한다(조용히 덮지 않는다 · 화면이 cursorReset 으로 말한다).
 */
import { pushAll } from '../../util/pushAll.js';
import { mainDb } from '../db.js';
import { SAMPLES_MAX, SEC_ITEMS_MAX } from './classify.js';
import { SEVERITY_RANK } from '../../loganalysis/rules.js';
import { createYielder } from '../../util/timeSlice.js';
import { chunkedDelete } from '../../util/chunkedPrune.js';

export const PATTERN_MAX = 500;          // 서버당 서명 수 상한 — 넘치면 분류별 ‘서명 상한 초과’ 한 행으로 묶는다(센다)
/**
 * high · critical 서명은 PATTERN_MAX 를 넘어도 이만큼 더 받는다(반증 F8 — 낮은 심각도 서명이 상한을 채우면 다음 주기의 MCE(critical)가 묶음 행으로 접혀
 *   규칙 · 근거 · 연계 · 공통 원인 후보에서 사라졌다). 한 주기 안에서는 심각도 높은 것부터 쓴다. 이 여유까지 차면 high 도 묶는다(묶음 행 심각도 = 묶인 것 중 가장 높은 것).
 */
export const HIGH_RESERVE = 100;
const sevRank = (s) => SEVERITY_RANK[s] || 0;
const HIGH_RANK = SEVERITY_RANK.high;
const PRUNE_CHUNK = 2_000;
const PRUNE_TARGET_MS = 15;   // v2.954(점검 C-2): 청크 하나의 목표 시간(적응 청크)
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
 * 한 주기의 로그 결과를 묶음 트랜잭션으로(서버 단위 원자 · 묶음 사이 양보 — v2.954 점검 C-1).
 * @param {{agent:string, items:Array<{key, readRev:number|null, at:number, state:object, status:object, bad?:string, patterns:Array, hours:Array, sec:Array}>, sliceMs?:number}} o
 * @returns {Promise<{ok:boolean, written:number, conflicts:number, overflow:number, writtenKeys:string[], batches:number, reason?:string}>}
 *   ok:false 여도 writtenKeys 는 **이미 커밋된** 서버다(실패한 묶음의 서버는 들어가지 않는다 — 다음 주기에 같은 줄을 다시 읽는다).
 */
export function logWriteBatch({ agent = '', items = [], sliceMs = 15 } = {}) {
  return withLogChain(async () => {
    const db = await mainDb();
    if (!db) return { ok: false, reason: 'db-unavailable', written: 0, conflicts: 0, overflow: 0, writtenKeys: [] };
    const ag = s64(agent, 128);
    const insCur = db.prepare('INSERT INTO log_cursor (agent,key,at,rev,state_json,status_json,bad_json) VALUES (?,?,?,1,?,?,?) ON CONFLICT(agent,key) DO NOTHING');
    const updCur = db.prepare('UPDATE log_cursor SET at=?, rev=rev+1, state_json=?, status_json=?, bad_json=COALESCE(?, bad_json) WHERE agent=? AND key=? AND rev=?');
    const getPat = db.prepare('SELECT samples_json, severity FROM log_pattern WHERE agent=? AND key=? AND sig=?');
    const cntPat = db.prepare('SELECT COUNT(*) c FROM log_pattern WHERE agent=? AND key=?');
    const upPat = db.prepare(`INSERT INTO log_pattern (agent,key,sig,cls,severity,rule_id,src,unit,tmpl,count,first,last,samples_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent,key,sig) DO UPDATE SET count=count+excluded.count, first=min(first, excluded.first), last=max(last, excluded.last),
        cls=excluded.cls, severity=excluded.severity, rule_id=excluded.rule_id, unit=excluded.unit, tmpl=excluded.tmpl, samples_json=excluded.samples_json`);
    const upHour = db.prepare('INSERT INTO log_hour (agent,key,hour,sig,cls,count) VALUES (?,?,?,?,?,?) ON CONFLICT(agent,key,hour,sig) DO UPDATE SET count=count+excluded.count');
    const hasSec = db.prepare('SELECT 1 FROM log_sec WHERE agent=? AND key=? AND hour=? AND kind=? AND item=?');
    const cntSec = db.prepare('SELECT COUNT(*) c FROM log_sec WHERE agent=? AND key=? AND hour=? AND kind=?');
    const upSec = db.prepare('INSERT INTO log_sec (agent,key,hour,kind,item,count) VALUES (?,?,?,?,?,?) ON CONFLICT(agent,key,hour,kind,item) DO UPDATE SET count=count+excluded.count');
    let written = 0; let conflicts = 0; let overflow = 0; const writtenKeys = [];
    // 묶음 단위 집계 — COMMIT 이 성공한 뒤에만 바깥 합계로 옮긴다(되돌린 묶음은 세지 않는다)
    let bWritten = 0; let bConflicts = 0; let bOverflow = 0; let bKeys = [];
    const maybeYield = createYielder(sliceMs);
    let batches = 0; let txAt = 0;
    const settle = () => { written += bWritten; conflicts += bConflicts; overflow += bOverflow; pushAll(writtenKeys, bKeys); bWritten = 0; bConflicts = 0; bOverflow = 0; bKeys = []; };
    let open = false;
    try {
      for (const it of items) {
        if (!open) { db.exec('BEGIN'); open = true; batches += 1; txAt = performance.now(); }
        const key = s64(it.key, 256);
        const stJ = json(it.state || null, STATE_MAX) ?? json({ ...(it.state || {}), carry: null }, STATE_MAX);   // carry 가 넘치면 버린다(위치는 지킨다)
        const ssJ = json(it.status || null, STATE_MAX);
        const bad = it.bad ? String(it.bad).slice(0, 4_096) : null;
        const ch = it.readRev == null
          ? Number(insCur.run(ag, key, Math.round(Number(it.at) || Date.now()), stJ, ssJ, bad).changes || 0)
          : Number(updCur.run(Math.round(Number(it.at) || Date.now()), stJ, ssJ, bad, ag, key, Math.round(Number(it.readRev))).changes || 0);
        if (!ch) { bConflicts += 1; continue; }   // 다른 주기가 먼저 썼다 — 이 서버의 이번 결과는 버린다(두 번 세지 않는다)
        let have = Number(cntPat.get(ag, key)?.c ?? 0);
        const fold = new Map();   // 서명 상한 초과 — 원래 서명 → 분류별 묶음 서명(시간 집계도 같은 곳으로)
        // 심각도 높은 것부터(같으면 횟수 많은 것) — 상한에 닿을 때 접히는 쪽이 낮은 심각도가 되게
        const pats = [...(it.patterns || [])].sort((a, b) => sevRank(b?.severity) - sevRank(a?.severity) || (Number(b?.count) || 0) - (Number(a?.count) || 0));
        for (const p of pats) {
          let sig = s64(p.sig, 64); let tmpl = s64(p.tmpl, 200); let ruleId = s64(p.ruleId, 40); let severity = s64(p.severity, 10);
          let row = getPat.get(ag, key, sig);
          const cap = sevRank(p.severity) >= HIGH_RANK ? PATTERN_MAX + HIGH_RESERVE : PATTERN_MAX;
          if (!row && have >= cap) {
            bOverflow += Math.round(Number(p.count) || 0);
            const over = `#over:${s64(p.cls, 8)}`;
            fold.set(sig, over); sig = over; tmpl = '(서명 수 상한 초과 — 이 분류의 나머지 서명을 한 행에 묶었다)'; ruleId = '';
            row = getPat.get(ag, key, sig);
            if (row && sevRank(row.severity) > sevRank(severity)) severity = s64(row.severity, 10);
          }
          const old = parse(row?.samples_json);
          const prevS = Array.isArray(old.value) ? old.value : [];
          const merged = [...prevS, ...(p.samples || [])].filter((x) => x && typeof x.text === 'string').sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-SAMPLES_MAX)
            .map((x) => ({ ts: Math.round(Number(x.ts) || 0), text: s64(x.text, 300) }));
          upPat.run(ag, key, sig, s64(p.cls, 8), severity, ruleId, s64(p.src, 16), s64(p.unit, 64), tmpl, Math.round(Number(p.count) || 0),
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
        bWritten += 1; bKeys.push(key);
        // 묶음이 길어졌으면 여기(서버 경계)에서 커밋하고 양보한다 — 트랜잭션을 연 채로 양보하지 않는다
        if (performance.now() - txAt >= sliceMs) { db.exec('COMMIT'); open = false; settle(); await maybeYield(); }
      }
      if (open) { db.exec('COMMIT'); open = false; settle(); }
    } catch (e) {
      if (open) { try { db.exec('ROLLBACK'); } catch { /* */ } }
      return { ok: false, reason: String(e?.message || e).slice(0, 200), written, conflicts, overflow, writtenKeys, batches };
    }
    return { ok: true, written, conflicts, overflow, writtenKeys, batches };
  });
}

/**
 * 청크 삭제(표 · 열은 상수 이름만 — 외부 입력 없음). v2.954(점검 C-2): 예전에는 동기 for 루프(2,000행 × 최대 50청크)로 양보가 없었다
 *   (10만 행 0.4~0.9초 단일 정지 실측) — 공용 chunkedDelete(청크 사이 setImmediate · 시간 기준 적응 청크)로. 상한(호출당 10만 행)은 같다.
 */
async function chunkDelete(db, table, col, before, maxChunks = 50) {
  const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${col} < ? LIMIT ?)`);
  const r = await chunkedDelete(stmt, [Math.round(Number(before))], { chunk: PRUNE_CHUNK, maxRows: PRUNE_CHUNK * maxChunks, targetMs: PRUNE_TARGET_MS, minChunk: 200 });
  return r.deleted;
}
/** 보관 정리(보관 기간 밖 시간 집계 · 보안 상위 · 마지막이 오래된 패턴) + 대상에서 사라진 서버의 읽기 위치(keys 를 주면). */
export function logPrune({ before, agent = '', keys = null } = {}) {
  return withLogChain(async () => {
    const db = await mainDb();
    if (!db) return { hours: 0, sec: 0, patterns: 0, cursors: 0 };
    const hours = await chunkDelete(db, 'log_hour', 'hour', before);
    const sec = await chunkDelete(db, 'log_sec', 'hour', before);
    const patterns = await chunkDelete(db, 'log_pattern', 'last', before);
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
 *   ⚠ 성능(반증 7 — 예전 한 문장 `GROUP BY key, sig` + SUM · MAX 는 PK(agent,key,hour,sig)의 agent 앞부분만 써 **보관 전체**를 훑었다: 1,000대 1일 733ms 동기):
 *     서버 키마다 PK 앞부분 (agent, key, hour ≥ since) 범위만 읽는다(창 안 행만 · 새 인덱스 없음) · 합 · 마지막 시각은 JS 에서(한 문장 집계 둘 금지 — perf-db) ·
 *     서버 사이에 시간 기준 양보(createYielder — 큰 노드가 이벤트 루프를 한 번에 붙잡지 않게).
 * @returns {Promise<{rows:Array<{key,sig,cls,c,h}>, metas:Array, curs:Array}|null>}
 */
export async function logFleetQuery({ agent = '', since, sliceMs = 15 } = {}) {
  const db = await mainDb();
  if (!db) return null;
  const ag = String(agent); const s = Math.round(Number(since));
  const maybeYield = createYielder(sliceMs);
  const curs = db.prepare('SELECT key, at, status_json FROM log_cursor WHERE agent=?').all(ag);
  const hourQ = db.prepare('SELECT sig, cls, hour, count FROM log_hour WHERE agent=? AND key=? AND hour>=?');
  const metaQ = db.prepare('SELECT sig, cls, severity, rule_id, src, unit, tmpl, last, samples_json FROM log_pattern WHERE agent=? AND key=? AND last>=?');
  const rows = []; const metas = [];
  for (const c of curs) {
    await maybeYield();
    const acc = new Map();
    for (const r of hourQ.all(ag, c.key, s)) {
      const e = acc.get(r.sig);
      if (e) { e.c += Number(r.count) || 0; if (r.hour > e.h) e.h = r.hour; } else acc.set(r.sig, { key: c.key, sig: r.sig, cls: r.cls, c: Number(r.count) || 0, h: Number(r.hour) });
    }
    for (const e of acc.values()) rows.push(e);
    for (const m of metaQ.all(ag, c.key, s)) metas.push({ key: c.key, ...m });
  }
  return { rows, metas, curs: curs.map((r) => ({ key: r.key, at: Number(r.at) || null, status: parse(r.status_json).value })) };
}
