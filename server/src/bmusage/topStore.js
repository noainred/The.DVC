/**
 * bmusage/topStore.js — 리눅스 성능 8b단계 **프로세스 Top-N 저장 · 조회**(설계 PROFILES §20 ⑳ · 아트보드 TopProc).
 *
 * 저장(시간 단위 파일 — monthStore 가족 `top` · `toph`):
 *   · `bm-usage-top-YYYY-MM-DD.db`(날 파일 · 보존 기본 7일 = **파일 삭제**) — top_sample(서버 · 주기마다 머리 1행) + top_proc(‘바뀐 표본’ 에만 종류 cpu · mem · io × 순위 1~5).
 *   · `bm-usage-toph-YYYY-MM.db`(월 파일 · 보존 기본 90일) — top_proc_hourly(서버 · 시간 · comm 별 CPU 초 합 · 최대 RSS · 표본 수).
 *
 * ── ‘변화 있을 때만 저장’ 기준(설계 ‘상위 집합과 값 ±5%p 안이면 생략’ 을 이렇게 정했다) ───────────────────────
 *   직전 **전체 저장 표본(기준)** 과 비교해 세 종류 모두 ① 상위 5 의 (PID, 시작 시각 ±2초 — sameProcStart) 집합이 같고 ② 값 차이가 CPU ±5%p · RSS ±5% · I/O ±5%(둘 다 1MB/s 미만이면 같음)
 *   안이면 그 주기는 **머리 1행만**(base_ts = 기준 표본 시각) 적는다. 기준이 60분보다 오래됐거나 날(파일)이 바뀌었거나 재시작 뒤 첫 표본이면 전체 저장.
 *   머리는 매 주기 남는다 — ‘변화 없음’ 과 ‘그 시각 표본 없음(수집 실패)’ 을 가른다(못 읽은 주기를 같은 값으로 메우지 않는다).
 *   ⚠ 8b 반증 F2: 메모리 상위의 시작 시각은 uptime − etimes(ps) 라 실장비 셸에서 매 주기 ±1초 흔들린다(14회 연속 실측 — 5 PID 전부) → 정확 일치로 비교하면 거의 매 주기
 *     전체 저장이었다(1,000대 × 1시간 실측 14.7MB vs 2.9MB). 지속 · PID 재사용 판정(topAt)과 **같은 허용(±2초) 하나**로 비교한다.
 *   ⚠ 8b 반증 F3: 기준은 **적재가 성공한 뒤에만** 바꾼다(파일 열기 실패 · 되돌림 · 같은 ts 무시면 그대로) — 행이 없는 표본을 기준으로 삼아 ‘같음’ 머리가 빈 기준을 가리키지 않게.
 *     조회는 ‘같음’ 머리의 기준 머리 · 행이 없으면 reason 'base-missing'(화면 ‘기준 표본을 읽지 못함’ — 상위 행이 ‘없다’ 고 말하지 않는다). 날 가족 보존은 파일 삭제만이다.
 *
 * ── 시간 집계(comm 별 CPU 초 합) ─────────────────────────────────────────────────────
 *   CPU 상위 후보 20 중 **직전 주기에도 후보였던 같은 (PID, 시작 시각)** 의 누적 CPU 초(utime+stime) 차이를 그 comm 에 더한다 — 측정값이지만 **하한**이다
 *   (후보 밖으로 나간 시간 · 재시작 뒤 첫 주기는 빠진다). 1초 창 % × 주기로 늘려 추정하지 않는다. 최대 RSS = 그 표본에서 같은 comm PID 들의 RSS 합(후보 ∪ 메모리 상위)의 최대.
 *   서버 · 시간당 comm 행 상한 HOURLY_COMMS_MAX — 넘치면 ‘(기타)’ 한 행으로 모은다. ⚠ 8b 반증 F4: 인메모리 집합이 없으면(재시작 · 새 시간) 그 시간의 기존 comm 을
 *   파일에서 읽어 채운다(서버 · 시간당 1회) — 재시작 · 자동 업그레이드마다 상한이 한 번 더 열리지 않게.
 *
 * 규약(perf-db.md): 파일마다 트랜잭션 1회 · 트랜잭션 안 await 없음 · 쓰기는 직렬(_chain) · 시각 단독 인덱스 · 보존은 날 파일 삭제만(top — 경계 청크 없음: 반증 F3) · 월 파일 삭제 + 경계 청크(toph) ·
 *   집계 함수는 한 문장에 하나도 쓰지 않는다(시간 집계는 upsert 누적 · 조회 집계는 JS).
 * ⚠ 못 읽음은 0 이 아니다: ##TOP 이 missing 이면 그 주기 머리도 적지 않는다(‘표본 없음’) · 권한 없는 I/O 는 io_perm=1 · 값 null(‘—’).
 */
import { numOrNull } from '../util/numOrNull.js';
import { createYielder } from '../util/timeSlice.js';
import { periodKeyOf, withPeriodFile, forEachPeriod, hourOf } from './monthStore.js';
import { TOP_KEEP, cleanComm, cleanUser, procHint } from './parse/linuxTop.js';

const n = numOrNull;
export const CHANGE_PP = 5;
export const CHANGE_REL = 0.05;
export const IO_FLOOR_BPS = 1_048_576;
export const BASE_MAX_MS = 60 * 60_000;
export const HOURLY_COMMS_MAX = 24;
export const OTHER_COMM = '(기타)';
/** 점 조회 허용 오차 하한(이 노드 주기 × 1.5 와 큰 쪽) — 그 안에 표본이 없으면 ‘그 시각 표본 없음’. */
export const POINT_TOLERANCE_MIN_MS = 10 * 60_000;
/** 띠 조회 — 이 길이 이하면 5분 표본(top_proc) · 넘으면 시간 집계(top_proc_hourly). 띠 comm 수. */
export const BAND_RAW_MAX_MS = 26 * 3_600_000;
export const BAND_COMMS = 5;
export const BAND_MAX_MS = 90 * 86_400_000;
export const KINDS = Object.freeze(['cpu', 'mem', 'io']);

const _base = new Map();     // `${agent}|${key}` → { ts, day, kinds:{cpu,mem,io} }
const _ticks = new Map();    // `${agent}|${key}` → { ts, map: Map('pid:start' → cpuS) }
const _hourComms = new Map();   // `${agent}|${key}` → { hour, set:Set(comm) }
let _chain = Promise.resolve();
export function _resetTopStoreForTest() { _base.clear(); _ticks.clear(); _hourComms.clear(); _chain = Promise.resolve(); }
/** 대상에서 사라진 서버의 인메모리 상태를 버린다(누수 방지 — poller dropStaleState 와 같은 규약). */
export function dropTopState(liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  for (const m of [_base, _ticks, _hourComms]) for (const k of m.keys()) if (!live.has(k.slice(k.indexOf('|') + 1))) m.delete(k);
}

/** 파싱 값 → 종류별 상위 5(순수). */
export function kindsOf(top) {
  const cpu = (top?.cpu || []).slice(0, TOP_KEEP).map((x) => ({ pid: x.pid, start: x.start, user: x.user, comm: x.comm, val: x.cpu, rss: x.rssKb, state: x.state, cpuS: x.cpuS, rd: x.rd, wr: x.wr, ioPerm: !!x.ioPerm }));
  const mem = (top?.mem || []).slice(0, TOP_KEEP).map((x) => ({ pid: x.pid, start: x.start, user: x.user, comm: x.comm, val: x.rssKb, rss: x.rssKb, state: x.state, cpuS: null, rd: null, wr: null, ioPerm: false }));
  const io = (top?.io || []).slice(0, TOP_KEEP).map((x) => ({ pid: x.pid, start: x.start, user: x.user, comm: x.comm, val: (x.rd ?? 0) + (x.wr ?? 0), rss: x.rssKb, state: x.state, cpuS: x.cpuS, rd: x.rd, wr: x.wr, ioPerm: false }));
  return { cpu, mem, io };
}
const idOf = (x) => `${x.pid}:${x.start ?? ''}`;
/** 시작 시각 허용(초) — 메모리 상위는 uptime − etimes 라 ±1초 흔들린다(반증 F2). 지속 · PID 재사용 · 같음 판정이 이 하나를 쓴다. */
export const START_TOL_S = 2;
/** 같은 프로세스의 시작 시각인가(순수 — 둘 다 없으면 같음 · 하나만 없으면 다름 · 둘 다 있으면 ±START_TOL_S). */
export function sameProcStart(a, b) {
  const x = n(a); const y = n(b);
  if (x == null || y == null) return x === y;
  return Math.abs(x - y) <= START_TOL_S;
}
/** 같은 내용인가(순수 — 위 머리말의 기준). 프로세스는 PID 로 짝짓고 시작 시각은 sameProcStart(±2초). */
export function sameAsBase(cur, base) {
  if (!cur || !base) return false;
  for (const k of KINDS) {
    const a = cur[k] || []; const b = base[k] || [];
    if (a.length !== b.length) return false;
    const bm = new Map(b.map((x) => [n(x.pid), x]));
    for (const x of a) {
      const y = bm.get(n(x.pid));
      if (!y || !sameProcStart(x.start, y.start)) return false;
      const va = n(x.val); const vb = n(y.val);
      if (va == null || vb == null) { if (va !== vb) return false; continue; }
      if (k === 'cpu') { if (Math.abs(va - vb) > CHANGE_PP) return false; continue; }
      if (k === 'io' && va < IO_FLOOR_BPS && vb < IO_FLOOR_BPS) continue;
      if (Math.abs(va - vb) > Math.max(Math.abs(vb), 1) * CHANGE_REL) return false;
    }
  }
  return true;
}

/**
 * 한 서버 표본 → 시간 집계 증분(순수 — prev = 직전 후보의 누적 CPU 초 지도). comm 별 { cpuS, rss } · 다음 지도.
 *   CPU 초는 직전에도 후보였던 같은 (PID, 시작) 만 · 차이가 음수이거나 경과 × 4096 코어를 넘으면(시계 · 형식 이상) 버린다.
 */
export function hourlyDelta(top, prev = null, { elapsedS = null } = {}) {
  const next = new Map(); const byComm = new Map();
  const add = (comm, cpuS, rss) => { const c = comm || '?'; const e = byComm.get(c) || { cpuS: 0, rss: 0, rssKnown: false, cpuKnown: false }; if (cpuS != null) { e.cpuS += cpuS; e.cpuKnown = true; } if (rss != null) { e.rss += rss; e.rssKnown = true; } byComm.set(c, e); };
  const seenPid = new Set();
  for (const x of top?.cpu || []) {
    if (x.cpuS != null) next.set(idOf(x), x.cpuS);
    const p = prev?.get(idOf(x));
    let d = null;
    if (p != null && x.cpuS != null) { d = x.cpuS - p; if (d < 0 || (elapsedS != null && d > elapsedS * 4096)) d = null; }
    seenPid.add(x.pid);
    if (d != null && d > 0) add(x.comm, d, x.rssKb);
    else if (x.rssKb != null && (top?.mem || []).some((m) => m.pid === x.pid)) add(x.comm, null, x.rssKb);
  }
  for (const m of top?.mem || []) if (!seenPid.has(m.pid)) add(m.comm, null, m.rssKb);
  return { byComm, next };
}

function serial(fn) { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; }

/**
 * 한 주기 적재 — items: [{ key, ts, top(parseTop 값) }]. 꺼짐 · 값 없음은 적지 않는다(‘표본 없음’).
 * @returns {Promise<{ok:boolean, samples:number, full:number, procRows:number, hourlyRows:number, errors:string[]}>}
 */
export function topWriteBatch({ agent = '', items = [] } = {}) {
  return serial(() => topWriteInner(String(agent), items));
}
async function topWriteInner(agent, items) {
  const out = { ok: true, samples: 0, full: 0, procRows: 0, hourlyRows: 0, errors: [] };
  const byDay = new Map(); const byMonth = new Map();
  const pend = new Map();   // 이 묶음 안에서 앞 표본이 기준이 될 예정(같은 서버 여러 주기를 한 번에 적는 경로 — 되채움 · 시험). 확정은 적재 성공 뒤.
  for (const it of items || []) {
    const key = String(it?.key || '').slice(0, 256); const ts = Math.round(Number(it?.ts));
    const top = it?.top;
    if (!key || !Number.isFinite(ts) || !top || top.off || !Array.isArray(top.cpu)) continue;
    const day = periodKeyOf('top', ts); const mon = periodKeyOf('toph', ts);
    if (!day || !mon) continue;
    const sk = `${agent}|${key}`;
    const kinds = kindsOf(top);
    const b = pend.get(sk) || _base.get(sk);
    const same = !!b && b.day === day && ts - b.ts <= BASE_MAX_MS && ts > b.ts && sameAsBase(kinds, b.kinds);
    const baseTs = same ? b.ts : ts;
    // ⚠ 반증 F3: 기준(_base)은 여기서 바꾸지 않는다 — 날 파일 적재가 COMMIT 되고 그 머리가 실제로 들어간 뒤에만(아래).
    if (!same) pend.set(sk, { ts, day, kinds });
    const pv = _ticks.get(sk);
    const { byComm, next } = hourlyDelta(top, pv?.map || null, { elapsedS: pv ? (ts - pv.ts) / 1000 : null });
    _ticks.set(sk, { ts, map: next });
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ sk, key, ts, day, baseTs, full: !same, top, kinds });
    if (byComm.size) { if (!byMonth.has(mon)) byMonth.set(mon, []); byMonth.get(mon).push({ sk, key, hour: hourOf(ts), byComm }); }
  }
  for (const [day, list] of byDay) {
    await withPeriodFile('top', day, { create: true }, async (db) => {
      if (!db) { out.ok = false; out.errors.push(`${day}: 파일을 열지 못했습니다`); return; }
      const insS = db.prepare('INSERT OR IGNORE INTO top_sample (agent,key,ts,base_ts,src,nproc,nrun,nd,cpu_total,dt_s,up_s,cands,io_perm,io_unknown) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const insP = db.prepare('INSERT OR IGNORE INTO top_proc (agent,key,ts,kind,rank,pid,starttime,user,comm,val,rss,state,cpu_s,rd,wr,io_perm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const newBase = [];
      // 기준으로 쓸 수 있는 표본 = 이미 확정된 기준 + 이 트랜잭션에서 실제로 들어간 전체 표본. 기준이 들어가지 못했으면(같은 ts 무시) 그 ‘같음’ 은 전체로 적는다.
      const okBase = new Set(list.map((x) => { const b0 = _base.get(x.sk); return b0 ? `${x.sk}|${b0.ts}` : ''; }).filter(Boolean));
      db.exec('BEGIN');
      try {
        for (const x of list) {
          const t = x.top;
          if (!x.full && !okBase.has(`${x.sk}|${x.baseTs}`)) { x.full = true; x.baseTs = x.ts; }
          const r = insS.run(agent, x.key, x.ts, x.baseTs, t.src || null, n(t.nproc), n(t.nrun), n(t.nd), n(t.cpuTotal), n(t.dtS), n(t.uptimeS), n(t.candidates), n(t.ioPerm), n(t.ioUnknown));
          if (!Number(r.changes)) continue;   // 같은 ts 가 이미 있다(중복 적재 금지 — 그 표본은 기준이 되지 않는다)
          out.samples += 1;
          if (!x.full) continue;
          out.full += 1;
          newBase.push(x); okBase.add(`${x.sk}|${x.ts}`);
          for (const k of KINDS) {
            x.kinds[k].forEach((p, i) => {
              insP.run(agent, x.key, x.ts, k, i + 1, n(p.pid), n(p.start), p.user == null ? null : String(p.user).slice(0, 17), p.comm == null ? null : String(p.comm).slice(0, 64),
                n(p.val), n(p.rss), p.state || null, n(p.cpuS), n(p.rd), n(p.wr), p.ioPerm ? 1 : 0);
              out.procRows += 1;
            });
          }
        }
        db.exec('COMMIT');
        // 반증 F3: 적재가 성공한 전체 표본만 기준이 된다(실패 · 되돌림이면 직전 기준 — 그 행은 파일에 있다).
        for (const x of newBase) _base.set(x.sk, { ts: x.ts, day: x.day, kinds: x.kinds });
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } out.ok = false; out.errors.push(`${day}: ${String(e?.message || e).slice(0, 160)}`); }
    });
  }
  for (const [mon, list] of byMonth) {
    await withPeriodFile('toph', mon, { create: true }, async (db) => {
      if (!db) { out.ok = false; out.errors.push(`${mon}: 시간 집계 파일을 열지 못했습니다`); for (const e of list) _hourComms.delete(e.sk); return; }
      const up = db.prepare(`INSERT INTO top_proc_hourly (agent,key,hour,comm,cpu_s,rss_max,samples) VALUES (?,?,?,?,?,?,1)
        ON CONFLICT(agent,key,hour,comm) DO UPDATE SET cpu_s=cpu_s+excluded.cpu_s, rss_max=NULLIF(MAX(IFNULL(rss_max,-1e308),IFNULL(excluded.rss_max,-1e308)),-1e308), samples=samples+1`);
      const known = db.prepare('SELECT comm FROM top_proc_hourly WHERE agent=? AND key=? AND hour=?');
      // 반증 F4: 그 (서버, 시간)의 comm 집합 — 인메모리가 없으면(재시작 · 새 시간) 파일에 이미 있는 comm 으로 채운다(서버 · 시간당 1회 · PK 앞부분 범위).
      const sets = new Map();
      const rows = [];
      for (const e of list) {
        let set = sets.get(e.sk);
        if (!set || set.hour !== e.hour) {
          const hc = _hourComms.get(e.sk);
          set = hc && hc.hour === e.hour ? { hour: e.hour, set: new Set(hc.set) }
            : { hour: e.hour, set: new Set(known.all(agent, e.key, e.hour).map((r) => String(r.comm)).filter((c) => c !== OTHER_COMM)) };
          sets.set(e.sk, set);
        }
        for (const [comm0, v] of e.byComm) {
          let comm = cleanComm(comm0) || '?';
          if (!set.set.has(comm)) { if (set.set.size >= HOURLY_COMMS_MAX) comm = OTHER_COMM; else set.set.add(comm); }
          rows.push({ key: e.key, hour: e.hour, comm, cpuS: v.cpuKnown ? Math.round(v.cpuS * 100) / 100 : 0, rss: v.rssKnown ? v.rss : null });
        }
      }
      db.exec('BEGIN');
      try {
        for (const r of rows) { up.run(agent, r.key, r.hour, r.comm, r.cpuS, r.rss); out.hourlyRows += 1; }
        db.exec('COMMIT');
        for (const [sk, set] of sets) _hourComms.set(sk, set);
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } out.ok = false; out.errors.push(`${mon}: ${String(e?.message || e).slice(0, 160)}`); for (const sk of sets.keys()) _hourComms.delete(sk); }
    });
  }
  return out;
}

/* ════════════════════════ 조회 ════════════════════════ */
const procOut = (r, { boot = null } = {}) => ({
  rank: Number(r.rank), pid: n(r.pid), start: n(r.starttime), startAt: boot != null && n(r.starttime) != null ? Math.round(boot + Number(r.starttime) * 1000) : null,
  user: cleanUser(r.user), comm: cleanComm(r.comm) || null, val: n(r.val), rss: n(r.rss), state: r.state || null, cpuS: n(r.cpu_s), rd: n(r.rd), wr: n(r.wr), ioPerm: Number(r.io_perm) === 1,
  hint: procHint({ comm: r.comm, user: r.user }),
});
const headOut = (h) => h && ({ ts: Number(h.ts), baseTs: Number(h.base_ts), same: Number(h.base_ts) !== Number(h.ts), src: h.src || null, nproc: n(h.nproc), nrun: n(h.nrun), nd: n(h.nd),
  cpuTotal: n(h.cpu_total), dtS: n(h.dt_s), upS: n(h.up_s), cands: n(h.cands), ioPerm: n(h.io_perm), ioUnknown: n(h.io_unknown) });
/** 부팅 시각(ms) — 표본 시각 − uptime(10초 단위로 반올림 — 같은 부팅의 표본끼리 시작 시각을 비교할 수 있게). */
const bootOf = (h) => (h && n(h.upS) != null ? Math.round((h.ts - h.upS * 1000) / 10_000) * 10_000 : null);

async function headsIn({ agent, key, from, to, limit = 2_000 }) {
  const rows = [];
  const meta = await forEachPeriod('top', from, to, (db) => {
    for (const r of db.prepare('SELECT * FROM top_sample WHERE agent=? AND key=? AND ts>=? AND ts<=? ORDER BY ts LIMIT ?').all(String(agent), String(key), Math.round(from), Math.round(to), limit)) rows.push(r);
  });
  return { rows: rows.slice(0, limit).map(headOut), meta };
}
async function procsOf({ agent, key, ts, kinds = KINDS }) {
  const out = { cpu: [], mem: [], io: [] };
  await withPeriodFile('top', periodKeyOf('top', ts), { create: false }, async (db) => {
    if (!db) return;
    for (const r of db.prepare('SELECT * FROM top_proc WHERE agent=? AND key=? AND ts=? ORDER BY kind, rank').all(String(agent), String(key), Math.round(ts))) {
      if (kinds.includes(r.kind)) out[r.kind].push(r);
    }
  });
  return out;
}

/**
 * ‘이 시점 프로세스’ — ts 에 가장 가까운 표본(허용 오차 안) · 기준 표본의 행 · 직전 표본과 비교한 지속 · PID 재사용 · 앞뒤 표본 시각.
 * @returns {Promise<{ok:true, sample:object|null, rows:{cpu,mem,io}, prevTs, nextTs, reason?:string}>}
 */
export async function topAt({ agent = '', key, ts, toleranceMs = POINT_TOLERANCE_MIN_MS } = {}) {
  const t = Math.round(Number(ts));
  const tol = Math.max(POINT_TOLERANCE_MIN_MS, Number(toleranceMs) || 0);
  const { rows: heads } = await headsIn({ agent, key, from: t - tol - BASE_MAX_MS, to: t + tol, limit: 2_000 });
  const near = heads.filter((h) => Math.abs(h.ts - t) <= tol).sort((a, b) => Math.abs(a.ts - t) - Math.abs(b.ts - t))[0] || null;
  if (!near) return { ok: true, sample: null, rows: { cpu: [], mem: [], io: [] }, prevTs: heads.filter((h) => h.ts < t).at(-1)?.ts ?? null, nextTs: null, reason: 'no-sample' };
  const boot = bootOf(near);
  const raw = await procsOf({ agent, key, ts: near.baseTs });
  const after = await headsIn({ agent, key, from: near.ts + 1, to: near.ts + 3 * 3_600_000, limit: 1 });
  const prevH = heads.filter((h) => h.ts < near.ts).at(-1) || null;
  /*
   * 반증 F3: ‘같음’ 머리는 기준 표본의 행을 보인다 — 기준 머리가 없거나(적재 실패 · 보존 정리) 후보가 있었는데 행이 0 이면 **못 읽은 것**이다(‘상위 행이 없다’ 가 아니다).
   *   전체 저장 머리도 후보가 있었는데 행이 0 이면 같다(같은 트랜잭션이라 정상 경로에서는 생기지 않는다 — 방어).
   */
  const baseHead = near.same ? (heads.find((h) => h.ts === near.baseTs) || null) : near;
  const total = KINDS.reduce((a, k) => a + raw[k].length, 0);
  if (!baseHead || (total === 0 && (n(baseHead.cands) ?? 0) > 0)) {
    return { ok: true, sample: { ...near, boot, ...(near.same ? { baseTs: near.baseTs } : {}) }, rows: { cpu: [], mem: [], io: [] }, prevTs: prevH?.ts ?? null, nextTs: after.rows[0]?.ts ?? null, reason: 'base-missing' };
  }
  const rows = Object.fromEntries(KINDS.map((k) => [k, raw[k].map((r) => procOut(r, { boot }))]));
  // 직전 표본(같은 부팅) — 지속(같은 PID · 같은 시작) · PID 재사용(같은 PID · 다른 시작 — sameProcStart 하나)
  if (prevH && bootOf(prevH) === boot) {
    const pr = await procsOf({ agent, key, ts: prevH.baseTs });
    const prevIds = new Map(); for (const k of KINDS) for (const r of pr[k]) prevIds.set(Number(r.pid), n(r.starttime));
    for (const k of KINDS) for (const r of rows[k]) {
      if (!prevIds.has(r.pid)) { r.cont = false; continue; }
      const ps = prevIds.get(r.pid);
      if (ps != null && r.start != null && !sameProcStart(ps, r.start)) { r.cont = false; r.pidReused = true; } else r.cont = true;
    }
  }
  const baseNote = near.same ? { baseTs: near.baseTs } : {};
  return { ok: true, sample: { ...near, boot, ...baseNote }, rows, prevTs: prevH?.ts ?? null, nextTs: after.rows[0]?.ts ?? null };
}

/**
 * 시간 × 프로세스 띠 — 창 ≤ 26시간이면 5분 표본의 CPU 상위(기준 표본 행 · ‘같음’ 표본은 기준 값으로 · approx 를 센다), 넘으면 시간 집계(cpu_s → 평균 %).
 *   상위 BAND_COMMS 개 comm(창 합 기준) + ‘기타 상위’(그 밖 후보 합 — 후보 5 밖은 모른다). 같은 이름 PID 여러 개는 합산.
 */
export async function topBand({ agent = '', key, from, to } = {}) {
  const f = Math.round(Number(from)); const t = Math.round(Number(to));
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return { ok: false, reason: 'bad-window' };
  const span = Math.min(t - f, BAND_MAX_MS);
  const lo = t - span;
  const y = createYielder(15);
  const pts = [];
  let res = '5m'; let approx = 0; let baseMissing = 0;
  if (span <= BAND_RAW_MAX_MS) {
    const { rows: heads } = await headsIn({ agent, key, from: lo, to: t, limit: 2_000 });
    const cache = new Map();
    for (const h of heads) {
      if (!cache.has(h.baseTs)) cache.set(h.baseTs, (await procsOf({ agent, key, ts: h.baseTs, kinds: ['cpu'] })).cpu);
      const base = cache.get(h.baseTs) || [];
      // 반증 F3: 기준 행을 못 읽은 표본(‘같음’ 인데 기준 행 0 · 후보가 있었는데 행 0)은 0 으로 그리지 않는다 — 빼고 센다(baseMissing).
      if (!base.length && (h.same || (n(h.cands) ?? 0) > 0)) { baseMissing += 1; await y(); continue; }
      if (h.same) approx += 1;
      const by = {};
      for (const r of base) { const c = cleanComm(r.comm) || '?'; by[c] = Math.round(((by[c] || 0) + (n(r.val) || 0)) * 10) / 10; }
      pts.push({ t: h.ts, total: h.cpuTotal, by });
      await y();
    }
  } else {
    res = '1h';
    const acc = new Map();
    await forEachPeriod('toph', lo, t, (db) => {
      for (const r of db.prepare('SELECT hour, comm, cpu_s, samples FROM top_proc_hourly WHERE agent=? AND key=? AND hour>=? AND hour<=? ORDER BY hour').all(String(agent), String(key), hourOf(lo), t)) {
        const e = acc.get(Number(r.hour)) || {}; e[cleanComm(r.comm) || '?'] = Math.round(((n(r.cpu_s) || 0) / 36) * 10) / 10;   // cpu 초 ÷ 3600 × 100 = 평균 %(코어 기준)
        acc.set(Number(r.hour), e);
      }
    });
    for (const [h, by] of [...acc.entries()].sort((a, b) => a[0] - b[0])) pts.push({ t: h, total: null, by });
  }
  const sums = new Map();
  for (const p of pts) for (const [c, v] of Object.entries(p.by)) sums.set(c, (sums.get(c) || 0) + (v || 0));
  const comms = [...sums.entries()].filter(([c]) => c !== OTHER_COMM).sort((a, b) => b[1] - a[1]).slice(0, BAND_COMMS).map(([c]) => c);
  const keep = new Set(comms);
  const points = pts.map((p) => {
    const by = {}; let other = 0;
    for (const [c, v] of Object.entries(p.by)) { if (keep.has(c)) by[c] = v; else other += v || 0; }
    return { t: p.t, total: p.total, by, other: Math.round(other * 10) / 10 };
  });
  return { ok: true, res, from: lo, to: t, comms, points, approx, ...(baseMissing ? { baseMissing } : {}), ...(t - f > BAND_MAX_MS ? { clipped: true } : {}) };
}
